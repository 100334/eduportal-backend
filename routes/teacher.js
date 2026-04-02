const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const teacherMiddleware = require('../middleware/teacher');

// ========================
// Helper functions
// ========================
const calculateAverage = (subjects) => {
  if (!subjects || subjects.length === 0) return 0;
  const sum = subjects.reduce((acc, s) => acc + (s.score || 0), 0);
  return Math.round(sum / subjects.length);
};

// ========================
// Routes
// ========================

// Get teacher's class info
router.get('/debug-setup', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const teacherId = req.user.id;

    // Get teacher's assigned class
    const { data: teacherClass, error: classError } = await supabase
      .from('teacher_classes')
      .select(`
        class_id,
        classes:class_id (id, name, form)
      `)
      .eq('teacher_id', teacherId)
      .single();

    if (classError && classError.code !== 'PGRST116') throw classError;

    res.json({
      success: true,
      current_teacher: { id: teacherId },
      assigned_class: teacherClass?.classes || null
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get learners assigned to this teacher
router.get('/my-learners', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const teacherId = req.user.id;

    // Get teacher's class
    const { data: teacherClass, error: classError } = await supabase
      .from('teacher_classes')
      .select('class_id')
      .eq('teacher_id', teacherId)
      .single();

    if (classError || !teacherClass) {
      return res.json({ learners: [] });
    }

    // Get learners in that class
    const { data: learners, error: learnersError } = await supabase
      .from('learners')
      .select('*')
      .eq('class_id', teacherClass.class_id)
      .order('name');

    if (learnersError) throw learnersError;

    res.json({ learners: learners || [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all learners (for adding to class)
router.get('/all-learners', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const teacherId = req.user.id;

    // Get teacher's class
    const { data: teacherClass, error: classError } = await supabase
      .from('teacher_classes')
      .select('class_id')
      .eq('teacher_id', teacherId)
      .single();

    if (classError || !teacherClass) {
      return res.json({ learners: [] });
    }

    // Get learners not yet in this class
    const { data: learners, error: learnersError } = await supabase
      .from('learners')
      .select('*')
      .neq('class_id', teacherClass.class_id)
      .order('name');

    if (learnersError) throw learnersError;

    res.json({ learners: learners || [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add learners to teacher's class
router.post('/add-learners', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const { learnerIds } = req.body;
    const supabase = req.app.locals.supabase;
    const teacherId = req.user.id;

    if (!learnerIds || !learnerIds.length) {
      return res.status(400).json({ success: false, message: 'No learners selected' });
    }

    // Get teacher's class
    const { data: teacherClass, error: classError } = await supabase
      .from('teacher_classes')
      .select('class_id')
      .eq('teacher_id', teacherId)
      .single();

    if (classError || !teacherClass) {
      return res.status(400).json({ success: false, message: 'You are not assigned to any class' });
    }

    // Update learners' class_id
    const { error: updateError } = await supabase
      .from('learners')
      .update({ class_id: teacherClass.class_id })
      .in('id', learnerIds);

    if (updateError) throw updateError;

    res.json({ success: true, message: `${learnerIds.length} learner(s) added successfully` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Remove learner from teacher's class
router.delete('/remove-learner/:learnerId', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const supabase = req.app.locals.supabase;
    const teacherId = req.user.id;

    // Get teacher's class
    const { data: teacherClass, error: classError } = await supabase
      .from('teacher_classes')
      .select('class_id')
      .eq('teacher_id', teacherId)
      .single();

    if (classError || !teacherClass) {
      return res.status(400).json({ success: false, message: 'No class assigned' });
    }

    // Remove learner by setting class_id to null (or a default "unassigned" class)
    const { error: updateError } = await supabase
      .from('learners')
      .update({ class_id: null })
      .eq('id', learnerId)
      .eq('class_id', teacherClass.class_id);

    if (updateError) throw updateError;

    res.json({ success: true, message: 'Learner removed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get subjects for a class
router.get('/subjects/:classId', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const { classId } = req.params;
    const supabase = req.app.locals.supabase;

    const { data: subjects, error } = await supabase
      .from('subjects')
      .select('*')
      .eq('class_id', classId)
      .order('name');

    if (error) throw error;

    res.json(subjects || []);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get assessment types
router.get('/assessment-types', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const { data: types, error } = await supabase
      .from('assessment_types')
      .select('*')
      .order('name');

    if (error) throw error;

    res.json({ success: true, assessment_types: types || [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all reports for this teacher's learners
router.get('/reports', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const teacherId = req.user.id;

    // Get teacher's class
    const { data: teacherClass, error: classError } = await supabase
      .from('teacher_classes')
      .select('class_id')
      .eq('teacher_id', teacherId)
      .single();

    if (classError || !teacherClass) {
      return res.json({ data: [] });
    }

    // Get all learners in that class
    const { data: learners, error: learnersError } = await supabase
      .from('learners')
      .select('id')
      .eq('class_id', teacherClass.class_id);

    if (learnersError) throw learnersError;

    const learnerIds = learners.map(l => l.id);
    if (learnerIds.length === 0) {
      return res.json({ data: [] });
    }

    // Get reports for those learners
    const { data: reports, error: reportsError } = await supabase
      .from('reports')
      .select('*')
      .in('learner_id', learnerIds)
      .order('created_at', { ascending: false });

    if (reportsError) throw reportsError;

    res.json({ data: reports || [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create a new report card
router.post('/reports', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const {
      learnerId, term, form, subjects, best_subjects,
      total_points, english_passed, final_status,
      comment, assessment_type_id, academic_year
    } = req.body;

    const supabase = req.app.locals.supabase;

    // Validate required fields
    if (!learnerId || !term || !form || !subjects || subjects.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Check if learner exists
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id')
      .eq('id', learnerId)
      .single();

    if (learnerError || !learner) {
      return res.status(404).json({ success: false, message: 'Learner not found' });
    }

    // Check for duplicate
    const { data: existing, error: dupError } = await supabase
      .from('reports')
      .select('id')
      .eq('learner_id', learnerId)
      .eq('term', term)
      .eq('assessment_type_id', assessment_type_id || null)
      .eq('academic_year', academic_year || null)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ success: false, message: 'Report already exists for this learner, term, and assessment' });
    }

    const insertData = {
      learner_id: learnerId,
      term,
      form,
      subjects,
      comment: comment || '',
      assessment_type_id: assessment_type_id || null,
      academic_year: academic_year || null,
      created_at: new Date(),
      updated_at: new Date()
    };

    if (best_subjects !== undefined) insertData.best_subjects = best_subjects;
    if (total_points !== undefined) insertData.total_points = total_points;
    if (english_passed !== undefined) insertData.english_passed = english_passed;
    if (final_status !== undefined) insertData.final_status = final_status;

    const { data: report, error: insertError } = await supabase
      .from('reports')
      .insert([insertData])
      .select()
      .single();

    if (insertError) throw insertError;

    const average = calculateAverage(subjects);

    res.status(201).json({
      success: true,
      message: 'Report saved successfully',
      report: { ...report, average }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// UPDATE an existing report card (EDIT)
router.put('/reports/:id', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      learnerId, term, form, subjects, best_subjects,
      total_points, english_passed, final_status,
      comment, assessment_type_id, academic_year
    } = req.body;

    const supabase = req.app.locals.supabase;

    // Verify report exists
    const { data: existing, error: fetchError } = await supabase
      .from('reports')
      .select('id, learner_id')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }

    // Optional: Verify teacher has permission (via class)
    const teacherId = req.user.id;
    const { data: teacherClass, error: classError } = await supabase
      .from('teacher_classes')
      .select('class_id')
      .eq('teacher_id', teacherId)
      .single();

    if (teacherClass) {
      const { data: learner, error: learnerError } = await supabase
        .from('learners')
        .select('class_id')
        .eq('id', existing.learner_id)
        .single();

      if (learnerError || !learner || learner.class_id !== teacherClass.class_id) {
        return res.status(403).json({ success: false, message: 'Unauthorized to edit this report' });
      }
    }

    // Build update object (only provided fields)
    const updates = {};
    if (learnerId !== undefined) updates.learner_id = learnerId;
    if (term !== undefined) updates.term = term;
    if (form !== undefined) updates.form = form;
    if (subjects !== undefined) updates.subjects = subjects;
    if (best_subjects !== undefined) updates.best_subjects = best_subjects;
    if (total_points !== undefined) updates.total_points = total_points;
    if (english_passed !== undefined) updates.english_passed = english_passed;
    if (final_status !== undefined) updates.final_status = final_status;
    if (comment !== undefined) updates.comment = comment;
    if (assessment_type_id !== undefined) updates.assessment_type_id = assessment_type_id;
    if (academic_year !== undefined) updates.academic_year = academic_year;
    updates.updated_at = new Date();

    if (Object.keys(updates).length === 1) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    const { data: updated, error: updateError } = await supabase
      .from('reports')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({
      success: true,
      message: 'Report updated successfully',
      report: updated
    });
  } catch (error) {
    console.error('Update report error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete a report card
router.delete('/reports/:id', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const supabase = req.app.locals.supabase;

    const { error } = await supabase
      .from('reports')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ success: true, message: 'Report deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get attendance records for this teacher's learners
router.get('/attendance', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const teacherId = req.user.id;

    const { data: teacherClass, error: classError } = await supabase
      .from('teacher_classes')
      .select('class_id')
      .eq('teacher_id', teacherId)
      .single();

    if (classError || !teacherClass) {
      return res.json({ data: { records: [] } });
    }

    const { data: learners, error: learnersError } = await supabase
      .from('learners')
      .select('id')
      .eq('class_id', teacherClass.class_id);

    if (learnersError) throw learnersError;

    const learnerIds = learners.map(l => l.id);
    if (learnerIds.length === 0) {
      return res.json({ data: { records: [] } });
    }

    const { data: attendance, error: attError } = await supabase
      .from('attendance')
      .select('*')
      .in('learner_id', learnerIds)
      .order('date', { ascending: false });

    if (attError) throw attError;

    res.json({ data: { records: attendance || [] } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Record attendance
router.post('/attendance', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const { learnerId, date, status } = req.body;
    const supabase = req.app.locals.supabase;

    if (!learnerId || !date || !status) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Check if attendance already exists for that learner and date
    const { data: existing, error: findError } = await supabase
      .from('attendance')
      .select('id')
      .eq('learner_id', learnerId)
      .eq('date', date)
      .maybeSingle();

    if (existing) {
      // Update existing
      const { error: updateError } = await supabase
        .from('attendance')
        .update({ status, updated_at: new Date() })
        .eq('id', existing.id);

      if (updateError) throw updateError;
      return res.json({ success: true, message: 'Attendance updated' });
    }

    // Insert new
    const { error: insertError } = await supabase
      .from('attendance')
      .insert([{ learner_id: learnerId, date, status, created_at: new Date() }]);

    if (insertError) throw insertError;

    res.json({ success: true, message: 'Attendance recorded' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Dashboard stats
router.get('/dashboard/stats', authMiddleware, teacherMiddleware, async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const teacherId = req.user.id;

    const { data: teacherClass, error: classError } = await supabase
      .from('teacher_classes')
      .select('class_id')
      .eq('teacher_id', teacherId)
      .single();

    if (classError || !teacherClass) {
      return res.json({ data: { totalLearners: 0, totalReports: 0, attendanceRate: 0 } });
    }

    // Total learners
    const { count: totalLearners, error: learnerCountError } = await supabase
      .from('learners')
      .select('*', { count: 'exact', head: true })
      .eq('class_id', teacherClass.class_id);

    // Total reports for those learners
    const { data: learners, error: learnersError } = await supabase
      .from('learners')
      .select('id')
      .eq('class_id', teacherClass.class_id);

    let totalReports = 0;
    let attendanceRate = 0;

    if (!learnersError && learners) {
      const learnerIds = learners.map(l => l.id);
      if (learnerIds.length) {
        const { count: reportsCount, error: reportsError } = await supabase
          .from('reports')
          .select('*', { count: 'exact', head: true })
          .in('learner_id', learnerIds);
        if (!reportsError) totalReports = reportsCount || 0;

        // Attendance rate for last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const { data: attendanceRecords, error: attError } = await supabase
          .from('attendance')
          .select('status')
          .in('learner_id', learnerIds)
          .gte('date', thirtyDaysAgo.toISOString().split('T')[0]);

        if (!attError && attendanceRecords && attendanceRecords.length) {
          const presentCount = attendanceRecords.filter(r => r.status === 'present').length;
          attendanceRate = Math.round((presentCount / attendanceRecords.length) * 100);
        }
      }
    }

    res.json({
      data: {
        totalLearners: totalLearners || 0,
        totalReports,
        attendanceRate
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;