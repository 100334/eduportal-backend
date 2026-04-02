const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const auth = require('../middleware/auth');
const { requireTeacher } = require('../middleware/auth');
const reportController = require('../controllers/reportController');

// Public routes (authenticated)
router.get('/learner/:learnerId', auth, reportController.getLearnerReports);

// Teacher only routes
router.use(auth);
router.use(requireTeacher);

// Get all reports
router.get('/', reportController.getAllReports);

// Get single report
router.get('/:id', reportController.getReport);

// Create report
router.post('/', [
  body('learnerId').isInt().withMessage('Valid learner ID is required'),
  body('term').notEmpty().withMessage('Term is required'),
  body('form').notEmpty().withMessage('Form is required'),
  body('subjects').isArray().withMessage('Subjects must be an array'),
  body('subjects.*.name').notEmpty(),
  body('subjects.*.score').isInt({ min: 0, max: 100 })
], reportController.createReport);

// Update report - accepts all fields sent by frontend
router.put('/:id', [
  body('learnerId').optional().isInt(),
  body('term').optional().notEmpty(),
  body('form').optional().notEmpty(),
  body('subjects').optional().isArray(),
  body('subjects.*.name').optional().notEmpty(),
  body('subjects.*.score').optional().isInt({ min: 0, max: 100 }),
  body('best_subjects').optional(),
  body('total_points').optional().isInt({ min: 0 }),
  body('english_passed').optional().isBoolean(),
  body('final_status').optional().isString(),
  body('comment').optional().trim(),
  body('assessment_type_id').optional().isInt(),
  body('academic_year').optional().isInt()
], reportController.updateReport);

// Delete report
router.delete('/:id', reportController.deleteReport);

// Get report statistics
router.get('/stats/summary', reportController.getReportStats);

module.exports = router;