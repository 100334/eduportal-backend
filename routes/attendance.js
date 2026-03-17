const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const auth = require('../middleware/auth');
const { requireTeacher } = require('../middleware/auth');
const attendanceController = require('../controllers/attendanceController');

// Public routes (authenticated)
router.get('/learner/:learnerId', auth, attendanceController.getLearnerAttendance);

// Teacher only routes
router.use(auth);
router.use(requireTeacher);

// Get all attendance records
router.get('/', attendanceController.getAllAttendance);

// Get attendance for date range
router.get('/range', attendanceController.getAttendanceByDateRange);

// Record attendance
router.post('/', [
  body('learnerId').isInt().withMessage('Valid learner ID is required'),
  body('date').isDate().withMessage('Valid date is required'),
  body('status').isIn(['present', 'absent', 'late']).withMessage('Invalid status')
], attendanceController.recordAttendance);

// Bulk record attendance
router.post('/bulk', [
  body('records').isArray().withMessage('Records must be an array'),
  body('records.*.learnerId').isInt(),
  body('records.*.status').isIn(['present', 'absent', 'late'])
], attendanceController.bulkRecordAttendance);

// Update attendance
router.put('/:id', [
  body('status').isIn(['present', 'absent', 'late'])
], attendanceController.updateAttendance);

// Delete attendance
router.delete('/:id', attendanceController.deleteAttendance);

// Get attendance statistics
router.get('/stats/summary', attendanceController.getAttendanceStats);

module.exports = router;