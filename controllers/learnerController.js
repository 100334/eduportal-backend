const { validationResult } = require('express-validator');

// Get all learners
exports.getLearners = async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    
    const { data: learners, error } = await supabase
      .from('learners')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(learners);
  } catch (error) {
    next(error);
  }
};

// Get single learner
exports.getLearner = async (req, res, next) => {
  try {
    const { id } = req.params;
    const supabase = req.app.locals.supabase;

    const { data: learner, error } = await supabase
      .from('learners')
      .select('*')
      .eq('id', id)
      .single();

    if (error) throw error;
    if (!learner) {
      return res.status(404).json({ message: 'Learner not found' });
    }

    res.json(learner);
  } catch (error) {
    next(error);
  }
};

// Add new learner
exports.addLearner = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, grade, status = 'Active' } = req.body;
    const supabase = req.app.locals.supabase;

    // Generate registration number
    const year = new Date().getFullYear();
    
    // Get current count for reg number
    const { count, error: countError } = await supabase
      .from('learners')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;

    const regNumber = `EDU-${year}-${String((count || 0) + 1).padStart(4, '0')}`;

    const { data: learner, error } = await supabase
      .from('learners')
      .insert([{ 
        name, 
        reg_number: regNumber, 
        grade, 
        status 
      }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(learner);
  } catch (error) {
    next(error);
  }
};

// Update learner
exports.updateLearner = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, grade, status } = req.body;
    const supabase = req.app.locals.supabase;

    const updates = {};
    if (name) updates.name = name;
    if (grade) updates.grade = grade;
    if (status) updates.status = status;

    const { data: learner, error } = await supabase
      .from('learners')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!learner) {
      return res.status(404).json({ message: 'Learner not found' });
    }

    res.json(learner);
  } catch (error) {
    next(error);
  }
};

// Delete learner
exports.deleteLearner = async (req, res, next) => {
  try {
    const { id } = req.params;
    const supabase = req.app.locals.supabase;

    // First delete related records
    await Promise.all([
      supabase.from('reports').delete().eq('learner_id', id),
      supabase.from('attendance').delete().eq('learner_id', id)
    ]);

    // Then delete the learner
    const { error } = await supabase
      .from('learners')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ 
      success: true,
      message: 'Learner deleted successfully' 
    });
  } catch (error) {
    next(error);
  }
};

// Get learner statistics
exports.getLearnerStats = async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;

    // Get total count
    const { count: total, error: countError } = await supabase
      .from('learners')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;

    // Get active count
    const { count: active, error: activeError } = await supabase
      .from('learners')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'Active');

    if (activeError) throw activeError;

    // Get counts by grade
    const { data: byGrade, error: gradeError } = await supabase
      .from('learners')
      .select('grade, count')
      .group('grade');

    if (gradeError) throw gradeError;

    res.json({
      total,
      active,
      inactive: total - active,
      byGrade: byGrade || []
    });
  } catch (error) {
    next(error);
  }
};