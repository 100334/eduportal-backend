const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const auth = require('../middleware/auth');
const { requireTeacher } = require('../middleware/auth');
const learnerController = require('../controllers/learnerController');

// All learner routes require authentication and teacher role
router.use(auth);
router.use(requireTeacher);

// Get all learners
router.get('/', learnerController.getLearners);

// Get single learner
router.get('/:id', learnerController.getLearner);

// Add new learner
router.post('/', [
  body('name').notEmpty().trim().withMessage('Name is required'),
  body('grade').notEmpty().withMessage('Grade is required'),
  body('status').optional().isIn(['Active', 'Inactive'])
], learnerController.addLearner);

// Update learner
router.put('/:id', [
  body('name').optional().trim(),
  body('grade').optional(),
  body('status').optional().isIn(['Active', 'Inactive'])
], learnerController.updateLearner);

// Delete learner
router.delete('/:id', learnerController.deleteLearner);

// Get learner statistics
router.get('/stats/summary', learnerController.getLearnerStats);

module.exports = router;