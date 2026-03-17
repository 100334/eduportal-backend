const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireTeacher, requireLearner, requireAdmin } = require('../middleware/auth');

// ============================================
// ADMIN DASHBOARD
// ============================================
router.get('/admin', auth, requireAdmin, async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    
    // Get counts from all tables
    const [
      { count: teachersCount },
      { count: learnersCount },
      { count: reportsCount },
      { count: classesCount },
      { count: subjectsCount },
      { count: attendanceCount },
      { data: recentActivities }
    ] = await Promise.all([
      supabase.from('teachers').select('*', { count: 'exact', head: true }),
      supabase.from('learners').select('*', { count: 'exact', head: true }),
      supabase.from('reports').select('*', { count: 'exact', head: true }),
      supabase.from('classes').select('*', { count: 'exact', head: true }),
      supabase.from('subjects').select('*', { count: 'exact', head: true }),
      supabase.from('attendance').select('*', { count: 'exact', head: true }),
      
      // Get recent system logs/activities
      supabase
        .from('system_logs')
        .select(`
          *,
          admins (name)
        `)
        .order('created_at', { ascending: false })
        .limit(10)
    ]);

    // Get attendance rate for today
    const today = new Date().toISOString().split('T')[0];
    const { data: todayAttendance } = await supabase
      .from('attendance')
      .select('status')
      .eq('date', today);

    const attendanceStats = {
      present: todayAttendance?.filter(a => a.status === 'present').length || 0,
      absent: todayAttendance?.filter(a => a.status === 'absent').length || 0,
      late: todayAttendance?.filter(a => a.status === 'late').length || 0,
      total: todayAttendance?.length || 0
    };

    // Get distribution by form
    const { data: formDistribution } = await supabase
      .from('classes')
      .select('form_level, count')
      .group('form_level');

    // Get recent learners
    const { data: recentLearners } = await supabase
      .from('learners')
      .select('*, learner_class_enrollments!inner(classes(form_level, stream))')
      .order('created_at', { ascending: false })
      .limit(5);

    res.json({
      stats: {
        totalTeachers: teachersCount || 0,
        totalLearners: learnersCount || 0,
        totalReports: reportsCount || 0,
        totalClasses: classesCount || 0,
        totalSubjects: subjectsCount || 0,
        totalAttendance: attendanceCount || 0,
        todayAttendance: attendanceStats
      },
      formDistribution: formDistribution || [],
      recentLearners: recentLearners || [],
      recentActivities: recentActivities || [],
      systemHealth: {
        database: 'healthy',
        api: 'healthy',
        lastBackup: new Date().toISOString(),
        activeSessions: 24 // This would come from your session store
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// TEACHER DASHBOARD
// ============================================
router.get('/teacher', auth, requireTeacher, async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    const teacherId = req.user.teacher_id;

    // Get teacher's classes
    const { data: teacherClasses } = await supabase
      .from('teacher_class_subject_assignments')
      .select(`
        id,
        is_class_teacher,
        classes (
          id,
          name,
          form_level,
          stream,
          capacity
        ),
        subjects (
          id,
          name,
          code
        )
      `)
      .eq('teacher_id', teacherId)
      .eq('academic_year', '2024-2025'); // You might want to make this dynamic

    // Get counts for teacher's classes
    let totalLearners = 0;
    const classDetails = [];

    if (teacherClasses && teacherClasses.length > 0) {
      for (const tc of teacherClasses) {
        const { count } = await supabase
          .from('learner_class_enrollments')
          .select('*', { count: 'exact', head: true })
          .eq('class_id', tc.classes.id)
          .eq('status', 'Active');

        totalLearners += count || 0;
        
        classDetails.push({
          classId: tc.classes.id,
          className: tc.classes.name,
          formLevel: tc.classes.form_level,
          stream: tc.classes.stream,
          subject: tc.subjects?.name,
          isClassTeacher: tc.is_class_teacher,
          learnerCount: count || 0,
          capacity: tc.classes.capacity
        });
      }
    }

    // Get recent reports created by teacher
    const { data: recentReports } = await supabase
      .from('reports')
      .select(`
        *,
        learners (name, reg_number)
      `)
      .order('created_at', { ascending: false })
      .limit(5);

    // Get today's attendance for teacher's classes
    const today = new Date().toISOString().split('T')[0];
    const classIds = teacherClasses?.map(tc => tc.classes.id) || [];
    
    let todayAttendance = { present: 0, absent: 0, late: 0, total: 0 };
    
    if (classIds.length > 0) {
      const { data: attendance } = await supabase
        .from('attendance')
        .select('status')
        .eq('date', today)
        .in('class_id', classIds);

      todayAttendance = {
        present: attendance?.filter(a => a.status === 'present').length || 0,
        absent: attendance?.filter(a => a.status === 'absent').length || 0,
        late: attendance?.filter(a => a.status === 'late').length || 0,
        total: attendance?.length || 0
      };
    }

    res.json({
      stats: {
        totalClasses: teacherClasses?.length || 0,
        totalLearners,
        totalReports: recentReports?.length || 0,
        todayAttendance
      },
      classes: classDetails,
      recentReports: recentReports || [],
      teacherInfo: {
        id: teacherId,
        isClassTeacher: teacherClasses?.some(tc => tc.is_class_teacher) || false
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// LEARNER DASHBOARD
// ============================================
router.get('/learner', auth, requireLearner, async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    const learnerId = req.user.learner_id;

    // Get learner info with class details
    const { data: learner } = await supabase
      .from('learners')
      .select(`
        *,
        learner_class_enrollments!inner (
          classes (
            id,
            name,
            form_level,
            stream,
            teacher_class_subject_assignments (
              teachers (name),
              subjects (name)
            )
          )
        )
      `)
      .eq('id', learnerId)
      .single();

    // Get recent reports
    const { data: reports } = await supabase
      .from('reports')
      .select('*')
      .eq('learner_id', learnerId)
      .order('created_at', { ascending: false });

    // Get attendance stats with class info
    const { data: attendance } = await supabase
      .from('attendance')
      .select(`
        *,
        classes (name, form_level)
      `)
      .eq('learner_id', learnerId)
      .order('date', { ascending: false });

    // Calculate attendance stats
    const attendanceStats = {
      total: attendance?.length || 0,
      present: attendance?.filter(a => a.status === 'present').length || 0,
      absent: attendance?.filter(a => a.status === 'absent').length || 0,
      late: attendance?.filter(a => a.status === 'late').length || 0,
      byClass: {}
    };

    // Group attendance by class
    if (attendance) {
      attendance.forEach(record => {
        const className = record.classes?.name || 'Unknown';
        if (!attendanceStats.byClass[className]) {
          attendanceStats.byClass[className] = {
            total: 0,
            present: 0,
            absent: 0,
            late: 0
          };
        }
        attendanceStats.byClass[className].total++;
        attendanceStats.byClass[className][record.status]++;
      });
    }

    if (attendanceStats.total > 0) {
      attendanceStats.rate = Math.round(
        ((attendanceStats.present + attendanceStats.late) / attendanceStats.total) * 100
      );
    }

    // Calculate academic performance
    let academicStats = {
      averageScore: 0,
      totalReports: reports?.length || 0,
      bestSubject: null,
      subjects: []
    };

    if (reports && reports.length > 0) {
      const latestReport = reports[0];
      const scores = latestReport.subjects.map(s => s.score);
      academicStats.averageScore = Math.round(
        scores.reduce((a, b) => a + b, 0) / scores.length
      );
      
      // Find best subject
      const best = latestReport.subjects.reduce((max, s) => 
        s.score > max.score ? s : max
      );
      academicStats.bestSubject = best.name;
      
      academicStats.subjects = latestReport.subjects;
    }

    res.json({
      learner: {
        ...learner,
        className: learner?.learner_class_enrollments[0]?.classes?.name,
        formLevel: learner?.learner_class_enrollments[0]?.classes?.form_level,
        stream: learner?.learner_class_enrollments[0]?.classes?.stream
      },
      reports: reports || [],
      latestReport: reports?.[0] || null,
      attendance: {
        stats: attendanceStats,
        records: attendance || []
      },
      academic: academicStats,
      teachers: learner?.learner_class_enrollments[0]?.classes?.teacher_class_subject_assignments || []
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// DASHBOARD STATS FOR ADMIN (Detailed)
// ============================================
router.get('/admin/stats', auth, requireAdmin, async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    
    // Get detailed statistics
    const [
      { data: teachersByStatus },
      { data: learnersByForm },
      { data: reportsByTerm },
      { data: attendanceTrend }
    ] = await Promise.all([
      // Teachers by status
      supabase
        .from('teachers')
        .select('status, count')
        .group('status'),
      
      // Learners by form level
      supabase
        .from('classes')
        .select(`
          form_level,
          learner_class_enrollments!inner(count)
        `),
      
      // Reports by term
      supabase
        .from('reports')
        .select('term, count')
        .group('term')
        .order('term', { ascending: false })
        .limit(5),
      
      // Attendance trend (last 7 days)
      supabase
        .from('attendance')
        .select('date, status, count')
        .gte('date', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
        .group('date, status')
    ]);

    res.json({
      teachersByStatus: teachersByStatus || [],
      learnersByForm: learnersByForm || [],
      reportsByTerm: reportsByTerm || [],
      attendanceTrend: attendanceTrend || []
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;