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
      { data: teachersData },
      { data: learnersData },
      { data: recentActivities }
    ] = await Promise.all([
      supabase.from('teachers').select('*', { count: 'exact', head: true }),
      supabase.from('learners').select('*', { count: 'exact', head: true }),
      supabase.from('reports').select('*', { count: 'exact', head: true }),
      supabase.from('classes').select('*', { count: 'exact', head: true }),
      supabase.from('subjects').select('*', { count: 'exact', head: true }),
      supabase.from('attendance').select('*', { count: 'exact', head: true }),
      supabase.from('teachers').select('status'), // For status distribution
      supabase.from('learners').select('grade, status'), // For learner distribution
      // Get recent activities (if system_logs doesn't exist, use other tables)
      supabase
        .from('reports')
        .select(`
          id,
          created_at,
          learners (name)
        `)
        .order('created_at', { ascending: false })
        .limit(10)
    ]);

    // Calculate teacher status distribution
    const teachersByStatus = teachersData.reduce((acc, teacher) => {
      const status = teacher.status || 'Active';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    // Calculate learner distribution by grade
    const learnersByGrade = learnersData.reduce((acc, learner) => {
      const grade = learner.grade || 'Not Assigned';
      acc[grade] = (acc[grade] || 0) + 1;
      return acc;
    }, {});

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
      total: todayAttendance?.length || 0,
      rate: todayAttendance?.length 
        ? Math.round(((todayAttendance.filter(a => a.status !== 'absent').length) / todayAttendance.length) * 100)
        : 0
    };

    // Get form distribution (if you have classes table)
    const { data: classesData } = await supabase
      .from('classes')
      .select('form_level, stream');

    const formDistribution = classesData?.reduce((acc, cls) => {
      const form = `Form ${cls.form_level}`;
      acc[form] = (acc[form] || 0) + 1;
      return acc;
    }, {});

    // Get recent learners
    const { data: recentLearners } = await supabase
      .from('learners')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    res.json({
      success: true,
      stats: {
        totalTeachers: teachersCount || 0,
        totalLearners: learnersCount || 0,
        totalReports: reportsCount || 0,
        totalClasses: classesCount || 0,
        totalSubjects: subjectsCount || 0,
        totalAttendance: attendanceCount || 0,
        todayAttendance: attendanceStats,
        teachersByStatus,
        learnersByGrade
      },
      formDistribution,
      recentLearners: recentLearners || [],
      recentActivities: recentActivities || [],
      systemHealth: {
        database: 'healthy',
        api: 'healthy',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    next(error);
  }
});

// ============================================
// TEACHER DASHBOARD
// ============================================
router.get('/teacher', auth, requireTeacher, async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    const teacherId = req.user.teacher_id || req.user.id;

    // Get teacher's classes with subjects
    // Adjust table name based on your schema
    const { data: teacherClasses, error: classError } = await supabase
      .from('teacher_class_subjects')
      .select(`
        id,
        is_class_teacher,
        classes:class_id (
          id,
          name,
          form_level,
          stream,
          capacity
        ),
        subjects:subject_id (
          id,
          name,
          code
        )
      `)
      .eq('teacher_id', teacherId);

    if (classError) {
      console.error('Error fetching teacher classes:', classError);
    }

    // Get all learners in teacher's classes efficiently (one query)
    const classIds = teacherClasses?.map(tc => tc.classes?.id).filter(Boolean) || [];
    
    let totalLearners = 0;
    const classDetails = [];
    
    if (classIds.length > 0) {
      // Get learner counts per class
      const { data: enrollmentCounts } = await supabase
        .from('enrollments')
        .select('class_id', { count: 'exact' })
        .in('class_id', classIds)
        .eq('status', 'Active');

      const countsByClass = enrollmentCounts?.reduce((acc, e) => {
        acc[e.class_id] = (acc[e.class_id] || 0) + 1;
        return acc;
      }, {});

      // Build class details
      teacherClasses.forEach(tc => {
        const classObj = tc.classes;
        if (classObj) {
          const learnerCount = countsByClass?.[classObj.id] || 0;
          totalLearners += learnerCount;
          
          classDetails.push({
            classId: classObj.id,
            className: classObj.name,
            formLevel: classObj.form_level,
            stream: classObj.stream,
            subject: tc.subjects?.name,
            subjectCode: tc.subjects?.code,
            isClassTeacher: tc.is_class_teacher,
            learnerCount,
            capacity: classObj.capacity || 0,
            utilizationRate: classObj.capacity 
              ? Math.round((learnerCount / classObj.capacity) * 100) 
              : 0
          });
        }
      });
    }

    // Get recent reports created by teacher
    const { data: recentReports } = await supabase
      .from('reports')
      .select(`
        *,
        learners:learner_id (name, reg_number)
      `)
      .eq('created_by', teacherId)
      .order('created_at', { ascending: false })
      .limit(5);

    // Get today's attendance for teacher's classes
    const today = new Date().toISOString().split('T')[0];
    let todayAttendance = { present: 0, absent: 0, late: 0, total: 0, rate: 0 };
    
    if (classIds.length > 0) {
      const { data: attendance } = await supabase
        .from('attendance')
        .select('status')
        .eq('date', today)
        .in('class_id', classIds);

      if (attendance) {
        todayAttendance = {
          present: attendance.filter(a => a.status === 'present').length,
          absent: attendance.filter(a => a.status === 'absent').length,
          late: attendance.filter(a => a.status === 'late').length,
          total: attendance.length,
          rate: attendance.length 
            ? Math.round((attendance.filter(a => a.status !== 'absent').length / attendance.length) * 100)
            : 0
        };
      }
    }

    res.json({
      success: true,
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
    console.error('Teacher dashboard error:', error);
    next(error);
  }
});

// ============================================
// LEARNER DASHBOARD
// ============================================
router.get('/learner', auth, requireLearner, async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    const learnerId = req.user.learner_id || req.user.id;

    // Get learner info with class details
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select(`
        *,
        enrollments:enrollments!inner (
          classes:class_id (
            id,
            name,
            form_level,
            stream,
            teacher_class_subjects (
              teachers:teacher_id (name),
              subjects:subject_id (name)
            )
          )
        )
      `)
      .eq('id', learnerId)
      .single();

    if (learnerError) {
      console.error('Error fetching learner:', learnerError);
      return res.status(404).json({ 
        success: false, 
        message: 'Learner not found' 
      });
    }

    // Get recent reports
    const { data: reports } = await supabase
      .from('reports')
      .select('*')
      .eq('learner_id', learnerId)
      .order('created_at', { ascending: false });

    // Get attendance records
    const { data: attendance } = await supabase
      .from('attendance')
      .select(`
        *,
        classes:class_id (name, form_level)
      `)
      .eq('learner_id', learnerId)
      .order('date', { ascending: false });

    // Calculate attendance stats
    const attendanceStats = {
      total: attendance?.length || 0,
      present: attendance?.filter(a => a.status === 'present').length || 0,
      absent: attendance?.filter(a => a.status === 'absent').length || 0,
      late: attendance?.filter(a => a.status === 'late').length || 0,
      rate: 0,
      byClass: {}
    };

    if (attendanceStats.total > 0) {
      attendanceStats.rate = Math.round(
        ((attendanceStats.present + attendanceStats.late) / attendanceStats.total) * 100
      );
    }

    // Group attendance by class
    if (attendance) {
      attendance.forEach(record => {
        const className = record.classes?.name || 'Unknown';
        if (!attendanceStats.byClass[className]) {
          attendanceStats.byClass[className] = {
            total: 0,
            present: 0,
            absent: 0,
            late: 0,
            rate: 0
          };
        }
        attendanceStats.byClass[className].total++;
        attendanceStats.byClass[className][record.status]++;
        
        const classTotal = attendanceStats.byClass[className].total;
        const classPresent = attendanceStats.byClass[className].present;
        const classLate = attendanceStats.byClass[className].late;
        attendanceStats.byClass[className].rate = Math.round(((classPresent + classLate) / classTotal) * 100);
      });
    }

    // Calculate academic performance
    let academicStats = {
      averageScore: 0,
      totalReports: reports?.length || 0,
      bestSubject: null,
      subjects: [],
      performanceTrend: []
    };

    if (reports && reports.length > 0) {
      const latestReport = reports[0];
      if (latestReport.subjects && latestReport.subjects.length > 0) {
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
        
        // Calculate performance trend (last 3 reports)
        const lastThree = reports.slice(0, 3);
        academicStats.performanceTrend = lastThree.map(r => ({
          term: r.term,
          average: Math.round(r.subjects.reduce((sum, s) => sum + s.score, 0) / r.subjects.length)
        })).reverse();
      }
    }

    // Get current class information
    const currentClass = learner?.enrollments?.[0]?.classes;
    const teachers = currentClass?.teacher_class_subjects?.map(ts => ({
      name: ts.teachers?.name,
      subject: ts.subjects?.name
    })) || [];

    res.json({
      success: true,
      learner: {
        id: learner.id,
        name: learner.name,
        reg_number: learner.reg_number,
        grade: learner.grade,
        status: learner.status,
        className: currentClass?.name,
        formLevel: currentClass?.form_level,
        stream: currentClass?.stream
      },
      reports: reports || [],
      latestReport: reports?.[0] || null,
      attendance: {
        stats: attendanceStats,
        records: attendance || []
      },
      academic: academicStats,
      teachers
    });
  } catch (error) {
    console.error('Learner dashboard error:', error);
    next(error);
  }
});

// ============================================
// DASHBOARD STATS FOR ADMIN (Detailed)
// ============================================
router.get('/admin/stats', auth, requireAdmin, async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    
    // Get attendance trend for last 7 days
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date();
      date.setDate(date.getDate() - i);
      return date.toISOString().split('T')[0];
    });

    const { data: attendanceData } = await supabase
      .from('attendance')
      .select('date, status')
      .in('date', last7Days);

    // Process attendance trend
    const attendanceTrend = last7Days.map(date => {
      const dayRecords = attendanceData?.filter(a => a.date === date) || [];
      return {
        date,
        present: dayRecords.filter(a => a.status === 'present').length,
        absent: dayRecords.filter(a => a.status === 'absent').length,
        late: dayRecords.filter(a => a.status === 'late').length,
        total: dayRecords.length,
        rate: dayRecords.length 
          ? Math.round((dayRecords.filter(a => a.status !== 'absent').length / dayRecords.length) * 100)
          : 0
      };
    });

    // Get reports by term
    const { data: reportsData } = await supabase
      .from('reports')
      .select('term');
    
    const reportsByTerm = reportsData?.reduce((acc, report) => {
      acc[report.term] = (acc[report.term] || 0) + 1;
      return acc;
    }, {});

    // Get teacher status distribution
    const { data: teachersData } = await supabase
      .from('teachers')
      .select('status');
    
    const teachersByStatus = teachersData?.reduce((acc, teacher) => {
      const status = teacher.status || 'Active';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});

    // Get learners by grade
    const { data: learnersData } = await supabase
      .from('learners')
      .select('grade');
    
    const learnersByGrade = learnersData?.reduce((acc, learner) => {
      const grade = learner.grade || 'Not Assigned';
      acc[grade] = (acc[grade] || 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      teachersByStatus,
      learnersByGrade,
      reportsByTerm,
      attendanceTrend
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    next(error);
  }
});

module.exports = router;