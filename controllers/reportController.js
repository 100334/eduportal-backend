const { validationResult } = require('express-validator');

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
      return res.status(404).json({ message: 'Report not found' });
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

// Create report
exports.createReport = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { learnerId, term, grade, subjects, comment = '' } = req.body;
    const supabase = req.app.locals.supabase;

    // Check if learner exists
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id')
      .eq('id', learnerId)
      .single();

    if (learnerError || !learner) {
      return res.status(404).json({ message: 'Learner not found' });
    }

    // Check if report already exists for this learner and term
    const { data: existing } = await supabase
      .from('reports')
      .select('id')
      .eq('learner_id', learnerId)
      .eq('term', term)
      .single();

    if (existing) {
      return res.status(400).json({ 
        message: 'A report already exists for this learner and term' 
      });
    }

    // Calculate average for validation
    const avg = subjects.reduce((sum, s) => sum + s.score, 0) / subjects.length;

    const { data: report, error } = await supabase
      .from('reports')
      .insert([{
        learner_id: learnerId,
        term,
        grade,
        subjects,
        comment
      }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({
      ...report,
      average: Math.round(avg)
    });
  } catch (error) {
    next(error);
  }
};

// Update report
exports.updateReport = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { subjects, comment } = req.body;
    const supabase = req.app.locals.supabase;

    const updates = {};
    if (subjects) updates.subjects = subjects;
    if (comment !== undefined) updates.comment = comment;

    const { data: report, error } = await supabase
      .from('reports')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }

    res.json(report);
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

    // Get reports by term
    const { data: byTerm, error: termError } = await supabase
      .from('reports')
      .select('term, count')
      .group('term');

    if (termError) throw termError;

    // Get average scores (this is more complex - you might want to calculate in DB)
    const { data: reports } = await supabase
      .from('reports')
      .select('subjects');

    const averages = reports?.map(r => {
      const scores = r.subjects.map(s => s.score);
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    }) || [];

    const overallAvg = averages.length 
      ? Math.round(averages.reduce((a, b) => a + b, 0) / averages.length)
      : 0;

    res.json({
      total,
      byTerm: byTerm || [],
      overallAverage: overallAvg
    });
  } catch (error) {
    next(error);
  }
};