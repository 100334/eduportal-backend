const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const { requireTeacher } = require('../middleware/auth');

// ============================================
// CONTROLLER IMPLEMENTATION
// ============================================

// Mock database (replace with actual database connection)
let attendanceRecords = [
  { id: 1, learnerId: 1, date: '2024-03-11', status: 'present' },
  { id: 2, learnerId: 1, date: '2024-03-12', status: 'present' },
  { id: 3, learnerId: 2, date: '2024-03-11', status: 'late' }
];
let nextId = 4;

const attendanceController = {
  // Get attendance for a specific learner (public/authenticated)
  getLearnerAttendance: async (req, res) => {
    try {
      const { learnerId } = req.params;
      const learnerAttendance = attendanceRecords.filter(
        record => record.learnerId === parseInt(learnerId)
      );
      
      // Calculate statistics
      const total = learnerAttendance.length;
      const present = learnerAttendance.filter(r => r.status === 'present').length;
      const absent = learnerAttendance.filter(r => r.status === 'absent').length;
      const late = learnerAttendance.filter(r => r.status === 'late').length;
      const attendanceRate = total ? Math.round((present + late) / total * 100) : 0;
      
      res.json({
        success: true,
        data: learnerAttendance,
        stats: {
          total,
          present,
          absent,
          late,
          attendanceRate
        }
      });
    } catch (error) {
      console.error('Error fetching learner attendance:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error fetching attendance records' 
      });
    }
  },

  // Get all attendance records (teacher only)
  getAllAttendance: async (req, res) => {
    try {
      // Add pagination
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const start = (page - 1) * limit;
      const end = start + limit;
      
      const paginatedRecords = attendanceRecords.slice(start, end);
      
      res.json({
        success: true,
        data: paginatedRecords,
        pagination: {
          page,
          limit,
          total: attendanceRecords.length,
          totalPages: Math.ceil(attendanceRecords.length / limit)
        }
      });
    } catch (error) {
      console.error('Error fetching all attendance:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error fetching attendance records' 
      });
    }
  },

  // Get attendance by date range
  getAttendanceByDateRange: async (req, res) => {
    try {
      const { startDate, endDate, learnerId } = req.query;
      
      let filteredRecords = [...attendanceRecords];
      
      if (startDate) {
        filteredRecords = filteredRecords.filter(r => r.date >= startDate);
      }
      if (endDate) {
        filteredRecords = filteredRecords.filter(r => r.date <= endDate);
      }
      if (learnerId) {
        filteredRecords = filteredRecords.filter(r => r.learnerId === parseInt(learnerId));
      }
      
      res.json({
        success: true,
        data: filteredRecords,
        count: filteredRecords.length
      });
    } catch (error) {
      console.error('Error fetching attendance by range:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error fetching attendance records' 
      });
    }
  },

  // Record single attendance
  recordAttendance: async (req, res) => {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }
    
    try {
      const { learnerId, date, status } = req.body;
      
      // Check if attendance already exists for this learner and date
      const existingIndex = attendanceRecords.findIndex(
        record => record.learnerId === learnerId && record.date === date
      );
      
      if (existingIndex !== -1) {
        // Update existing record
        attendanceRecords[existingIndex].status = status;
        return res.json({
          success: true,
          message: 'Attendance updated successfully',
          data: attendanceRecords[existingIndex]
        });
      }
      
      // Create new record
      const newRecord = {
        id: nextId++,
        learnerId,
        date,
        status,
        recordedAt: new Date().toISOString()
      };
      
      attendanceRecords.push(newRecord);
      
      res.status(201).json({
        success: true,
        message: 'Attendance recorded successfully',
        data: newRecord
      });
    } catch (error) {
      console.error('Error recording attendance:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error recording attendance' 
      });
    }
  },

  // Bulk record attendance
  bulkRecordAttendance: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }
    
    try {
      const { records, date } = req.body;
      const results = [];
      
      for (const record of records) {
        const existingIndex = attendanceRecords.findIndex(
          r => r.learnerId === record.learnerId && r.date === (date || record.date)
        );
        
        if (existingIndex !== -1) {
          attendanceRecords[existingIndex].status = record.status;
          results.push(attendanceRecords[existingIndex]);
        } else {
          const newRecord = {
            id: nextId++,
            learnerId: record.learnerId,
            date: date || record.date,
            status: record.status,
            recordedAt: new Date().toISOString()
          };
          attendanceRecords.push(newRecord);
          results.push(newRecord);
        }
      }
      
      res.json({
        success: true,
        message: `${results.length} attendance records processed`,
        data: results
      });
    } catch (error) {
      console.error('Error bulk recording attendance:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error bulk recording attendance' 
      });
    }
  },

  // Update attendance
  updateAttendance: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }
    
    try {
      const { id } = req.params;
      const { status } = req.body;
      
      const recordIndex = attendanceRecords.findIndex(r => r.id === parseInt(id));
      
      if (recordIndex === -1) {
        return res.status(404).json({ 
          success: false, 
          message: 'Attendance record not found' 
        });
      }
      
      attendanceRecords[recordIndex].status = status;
      attendanceRecords[recordIndex].updatedAt = new Date().toISOString();
      
      res.json({
        success: true,
        message: 'Attendance updated successfully',
        data: attendanceRecords[recordIndex]
      });
    } catch (error) {
      console.error('Error updating attendance:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error updating attendance' 
      });
    }
  },

  // Delete attendance
  deleteAttendance: async (req, res) => {
    try {
      const { id } = req.params;
      const recordIndex = attendanceRecords.findIndex(r => r.id === parseInt(id));
      
      if (recordIndex === -1) {
        return res.status(404).json({ 
          success: false, 
          message: 'Attendance record not found' 
        });
      }
      
      attendanceRecords.splice(recordIndex, 1);
      
      res.json({
        success: true,
        message: 'Attendance record deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting attendance:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error deleting attendance' 
      });
    }
  },

  // Get attendance statistics
  getAttendanceStats: async (req, res) => {
    try {
      const { startDate, endDate, learnerId } = req.query;
      
      let filteredRecords = [...attendanceRecords];
      
      if (startDate) {
        filteredRecords = filteredRecords.filter(r => r.date >= startDate);
      }
      if (endDate) {
        filteredRecords = filteredRecords.filter(r => r.date <= endDate);
      }
      if (learnerId) {
        filteredRecords = filteredRecords.filter(r => r.learnerId === parseInt(learnerId));
      }
      
      const total = filteredRecords.length;
      const present = filteredRecords.filter(r => r.status === 'present').length;
      const absent = filteredRecords.filter(r => r.status === 'absent').length;
      const late = filteredRecords.filter(r => r.status === 'late').length;
      
      // Group by date
      const byDate = {};
      filteredRecords.forEach(record => {
        if (!byDate[record.date]) {
          byDate[record.date] = { present: 0, absent: 0, late: 0, total: 0 };
        }
        byDate[record.date][record.status]++;
        byDate[record.date].total++;
      });
      
      res.json({
        success: true,
        stats: {
          total,
          present,
          absent,
          late,
          attendanceRate: total ? Math.round((present + late) / total * 100) : 0,
          byDate
        }
      });
    } catch (error) {
      console.error('Error fetching attendance stats:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error fetching attendance statistics' 
      });
    }
  }
};

// ============================================
// ROUTES
// ============================================

// Public routes (authenticated)
// IMPORTANT: Place specific routes BEFORE parameter routes
router.get('/learner/:learnerId/stats', auth, attendanceController.getAttendanceStats);
router.get('/learner/:learnerId', auth, attendanceController.getLearnerAttendance);

// Teacher only routes
router.use(auth);
router.use(requireTeacher);

// Specific routes first (to avoid being caught by parameter routes)
router.get('/range', attendanceController.getAttendanceByDateRange);
router.get('/stats/summary', attendanceController.getAttendanceStats);
router.post('/bulk', [
  body('records').isArray().withMessage('Records must be an array'),
  body('records.*.learnerId').isInt().withMessage('Valid learner ID required'),
  body('records.*.status').isIn(['present', 'absent', 'late']).withMessage('Invalid status')
], attendanceController.bulkRecordAttendance);

// Generic routes after specific ones
router.get('/', attendanceController.getAllAttendance);
router.post('/', [
  body('learnerId').isInt().withMessage('Valid learner ID is required'),
  body('date').isDate().withMessage('Valid date is required'),
  body('status').isIn(['present', 'absent', 'late']).withMessage('Invalid status')
], attendanceController.recordAttendance);

router.put('/:id', [
  body('status').isIn(['present', 'absent', 'late']).withMessage('Invalid status')
], attendanceController.updateAttendance);

router.delete('/:id', attendanceController.deleteAttendance);

module.exports = router;