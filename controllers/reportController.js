const { validationResult } = require('express-validator');

// Helper to calculate average score from subjects array
const calculateAverage = (subjects) => {
  if (!subjects || subjects.length === 0) return 0;
  const sum = subjects.reduce((acc, s) => acc + (s.score || 0), 0);
  return Math.round(sum / subjects.length);
};

// Get all reports
exports.getAllReports = async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;

    const { data: reports, error } = await supabase
      .from('reports')
      .select(`
        *,
        learners (
          name,
          reg_number,
          grade
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(reports);
  } catch (error) {
    next(error);
  }
};

// Get single report
exports.getReport = async (req, res, next) => {
  try {
    const { id } = req.params;
    const supabase = req.app.locals.supabase;

    const { data: report, error } = await supabase
      .from('reports')
      .select(`
        *,
        learners (
          name,
          reg_number,
          grade
        )
      `)
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!report) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }

    res.json(report);
  } catch (error) {
    next(error);
  }
};

// Get reports for a specific learner
exports.getLearnerReports = async (req, res, next) => {
  try {
    const { learnerId } = req.params;
    const supabase = req.app.locals.supabase;

    const { data: reports, error } = await supabase
      .from('reports')
      .select('*')
      .eq('learner_id', learnerId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(reports);
  } catch (error) {
    next(error);
  }
};

// Create report (supports all fields from frontend)
exports.createReport = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const {
      learnerId,
      term,
      form,               // frontend sends 'form', not 'grade'
      subjects,
      best_subjects,
      total_points,
      english_passed,
      final_status,
      comment = '',
      assessment_type_id,
      academic_year
    } = req.body;

    const supabase = req.app.locals.supabase;

    // Check if learner exists
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id')
      .eq('id', learnerId)
      .single();

    if (learnerError || !learner) {
      return res.status(404).json({ success: false, message: 'Learner not found' });
    }

    // Optional: Check for duplicate report (same learner, term, assessment type, year)
    // (You can modify this logic as needed)
    const { data: existing } = await supabase
      .from('reports')
      .select('id')
      .eq('learner_id', learnerId)
      .eq('term', term)
      .eq('assessment_type_id', assessment_type_id || null)
      .eq('academic_year', academic_year || null)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ 
        success: false,
        message: 'A report already exists for this learner, term, assessment type, and year' 
      });
    }

    // Prepare insert data
    const insertData = {
      learner_id: learnerId,
      term,
      form,                     // renamed from 'grade'
      subjects,
      comment,
      assessment_type_id: assessment_type_id || null,
      academic_year: academic_year || null,
      created_at: new Date(),
      updated_at: new Date()
    };

    // Add optional fields if provided
    if (best_subjects !== undefined) insertData.best_subjects = best_subjects;
    if (total_points !== undefined) insertData.total_points = total_points;
    if (english_passed !== undefined) insertData.english_passed = english_passed;
    if (final_status !== undefined) insertData.final_status = final_status;

    const { data: report, error } = await supabase
      .from('reports')
      .insert([insertData])
      .select()
      .single();

    if (error) throw error;

    const average = calculateAverage(subjects);

    res.status(201).json({
      success: true,
      message: 'Report created successfully',
      report: { ...report, average }
    });
  } catch (error) {
    next(error);
  }
};

// Update report (supports all fields from frontend)
exports.updateReport = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      learnerId,
      term,
      form,
      subjects,
      best_subjects,
      total_points,
      english_passed,
      final_status,
      comment,
      assessment_type_id,
      academic_year
    } = req.body;

    const supabase = req.app.locals.supabase;

    // Build update object dynamically (only include fields that are provided)
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

    // Always update the updated_at timestamp
    updates.updated_at = new Date();

    if (Object.keys(updates).length === 1) { // only updated_at
      return res.status(400).json({ 
        success: false, 
        message: 'No fields to update' 
      });
    }

    // Verify the report exists and optionally belongs to the teacher's class
    const { data: existing, error: fetchError } = await supabase
      .from('reports')
      .select('id')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ 
        success: false, 
        message: 'Report not found' 
      });
    }

    // Perform update
    const { data: updatedReport, error: updateError } = await supabase
      .from('reports')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({
      success: true,
      message: 'Report updated successfully',
      report: updatedReport
    });
  } catch (error) {
    next(error);
  }
};

// Delete report
exports.deleteReport = async (req, res, next) => {
  try {
    const { id } = req.params;
    const supabase = req.app.locals.supabase;

    const { error } = await supabase
      .from('reports')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ 
      success: true,
      message: 'Report deleted successfully' 
    });
  } catch (error) {
    next(error);
  }
};

// Get report statistics
exports.getReportStats = async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;

    // Get total reports count
    const { count: total, error: countError } = await supabase
      .from('reports')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;

    // Get reports by term (simple grouping - you may adjust)
    const { data: reports, error: reportsError } = await supabase
      .from('reports')
      .select('term, subjects');

    if (reportsError) throw reportsError;

    const termCounts = {};
    let sumAverages = 0;
    let reportCountWithAvg = 0;

    reports?.forEach(report => {
      termCounts[report.term] = (termCounts[report.term] || 0) + 1;
      if (report.subjects && report.subjects.length) {
        const avg = calculateAverage(report.subjects);
        sumAverages += avg;
        reportCountWithAvg++;
      }
    });

    const byTerm = Object.entries(termCounts).map(([term, count]) => ({ term, count }));
    const overallAvg = reportCountWithAvg ? Math.round(sumAverages / reportCountWithAvg) : 0;

    res.json({
      success: true,
      total,
      byTerm,
      overallAverage: overallAvg
    });
  } catch (error) {
    next(error);
  }
};