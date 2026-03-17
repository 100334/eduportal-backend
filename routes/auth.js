const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const authController = require('../controllers/authController');

// ============================================
// TEACHER AUTH ROUTES
// ============================================

// Teacher login
router.post('/teacher/login', [
  body('username').notEmpty().trim().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required')
], authController.teacherLogin);

// ============================================
// LEARNER AUTH ROUTES
// ============================================

// Learner login
router.post('/learner/login', [
  body('name').notEmpty().trim().withMessage('Name is required'),
  body('regNumber').notEmpty().trim().withMessage('Registration number is required')
], authController.learnerLogin);

// ============================================
// ADMIN AUTH ROUTES (NEW)
// ============================================

// Admin login
router.post('/admin/login', [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required')
], authController.adminLogin);

// ============================================
// COMMON AUTH ROUTES
// ============================================

// Refresh token
router.post('/refresh', authController.refreshToken);

// Logout
router.post('/logout', authController.logout);

// Get current user (optional - useful for frontend)
router.get('/me', authController.getCurrentUser);

module.exports = router;