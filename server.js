const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();

// Trust proxy - Required for Render (and other reverse proxies)
app.set('trust proxy', 1);

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Make supabase available globally
app.locals.supabase = supabase;

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration - Fixed for Render
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) {
      return callback(null, true);
    }
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5000',
      'https://eduportal-frontend.vercel.app',
      'https://eduportal-backend-vctg.onrender.com',
      ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : [])
    ];
    
    // In development, allow all origins
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('❌ Blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Add a simple CORS test endpoint
app.options('/api/test-cors', cors(corsOptions));
app.get('/api/test-cors', (req, res) => {
  res.json({ 
    message: 'CORS is working!',
    origin: req.headers.origin,
    allowed: true
  });
});

// Compression middleware
app.use(compression());

// Rate limiting - Adjusted for production
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting for health checks in production
  skip: (req) => req.path === '/health' || req.path === '/api/test'
});
app.use('/api', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware - Simplified for production
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', {
    skip: (req) => req.path === '/health' // Don't log health checks
  }));
}

console.log('='.repeat(60));
console.log('🚀 STARTING SERVER INITIALIZATION');
console.log('='.repeat(60));

// Debug: Check if route files exist before importing
console.log('\n📁 Checking route files...');

// Import routes with error handling - FIXED: auth import now matches your actual filename
let authRoutes, 
    learnerRoutes, 
    reportRoutes, 
    attendanceRoutes, 
    dashboardRoutes,
    adminRoutes,
    classRoutes,
    subjectRoutes,
    streamRoutes,
    assignmentRoutes,
    adminStatsRoutes;

// Auth routes - IMPORTANT: Your file is named 'auth.js', not 'authRoutes.js'
try {
  authRoutes = require('./routes/auth');  // Changed from 'authRoutes' to 'auth'
  console.log('✅ Auth routes loaded: ./routes/auth.js');
  console.log(`   📍 Available auth endpoints:`);
  // Log the actual routes if available
  if (authRoutes.stack) {
    authRoutes.stack.forEach(layer => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
        console.log(`      ${methods} /api/auth${layer.route.path}`);
      }
    });
  }
} catch (error) {
  console.error('❌ Failed to load auth routes:', error.message);
  console.error('   💡 Make sure the file exists at: ./routes/auth.js');
  authRoutes = express.Router();
  // Add a test endpoint to verify the fallback is working
  authRoutes.post('/test', (req, res) => {
    res.json({ message: 'Auth fallback route working', received: req.body });
  });
}

// Learner routes
try {
  learnerRoutes = require('./routes/learnerRoutes');
  console.log('✅ Learners routes loaded: ./routes/learnerRoutes.js');
} catch (error) {
  console.error('❌ Failed to load learners routes:', error.message);
  learnerRoutes = express.Router();
}

// Report routes
try {
  reportRoutes = require('./routes/reportRoutes');
  console.log('✅ Reports routes loaded: ./routes/reportRoutes.js');
} catch (error) {
  console.error('❌ Failed to load reports routes:', error.message);
  reportRoutes = express.Router();
}

// Attendance routes
try {
  attendanceRoutes = require('./routes/attendanceRoutes');
  console.log('✅ Attendance routes loaded: ./routes/attendanceRoutes.js');
} catch (error) {
  console.error('❌ Failed to load attendance routes:', error.message);
  attendanceRoutes = express.Router();
}

// Dashboard routes
try {
  dashboardRoutes = require('./routes/dashboardRoutes');
  console.log('✅ Dashboard routes loaded: ./routes/dashboardRoutes.js');
} catch (error) {
  console.error('❌ Failed to load dashboard routes:', error.message);
  dashboardRoutes = express.Router();
}

// Admin management routes
try {
  adminRoutes = require('./routes/adminRoutes');
  console.log('✅ Admin routes loaded: ./routes/adminRoutes.js');
} catch (error) {
  console.error('❌ Failed to load admin routes:', error.message);
  adminRoutes = express.Router();
}

// Class management routes (Forms 1-4)
try {
  classRoutes = require('./routes/classRoutes');
  console.log('✅ Class routes loaded: ./routes/classRoutes.js');
} catch (error) {
  console.error('❌ Failed to load class routes:', error.message);
  classRoutes = express.Router();
}

// Subject management routes
try {
  subjectRoutes = require('./routes/subjectRoutes');
  console.log('✅ Subject routes loaded: ./routes/subjectRoutes.js');
} catch (error) {
  console.error('❌ Failed to load subject routes:', error.message);
  subjectRoutes = express.Router();
}

// Stream management routes
try {
  streamRoutes = require('./routes/streamRoutes');
  console.log('✅ Stream routes loaded: ./routes/streamRoutes.js');
} catch (error) {
  console.error('❌ Failed to load stream routes:', error.message);
  streamRoutes = express.Router();
}

// Assignment routes (teacher-class-subject assignments)
try {
  assignmentRoutes = require('./routes/assignmentRoutes');
  console.log('✅ Assignment routes loaded: ./routes/assignmentRoutes.js');
} catch (error) {
  console.error('❌ Failed to load assignment routes:', error.message);
  assignmentRoutes = express.Router();
}

// Admin statistics routes
try {
  adminStatsRoutes = require('./routes/adminStatsRoutes');
  console.log('✅ Admin stats routes loaded: ./routes/adminStatsRoutes.js');
} catch (error) {
  console.error('❌ Failed to load admin stats routes:', error.message);
  adminStatsRoutes = express.Router();
}

console.log('='.repeat(60));
console.log('\n📝 REGISTERING ROUTES...');
console.log('='.repeat(60));

// ============================================
// REGISTER ROUTES
// ============================================

// Public test routes (ALWAYS available)
app.get('/test', (req, res) => {
  res.json({ 
    message: 'Server is running!', 
    time: new Date().toISOString(),
    env: process.env.NODE_ENV 
  });
});

app.post('/api/auth/test', (req, res) => {
  console.log('Test auth endpoint hit:', req.body);
  res.json({ 
    success: true, 
    message: 'Auth test endpoint working',
    received: req.body,
    timestamp: new Date().toISOString()
  });
});

// Public routes - AUTH IS NOW CORRECTLY IMPORTED
app.use('/api/auth', authRoutes);
console.log('   ✅ /api/auth ->', authRoutes.stack ? `${authRoutes.stack.length} routes` : 'Router mounted');

// Simple test endpoint
app.use('/api/test', (req, res) => res.json({ 
  message: 'API test endpoint is working!',
  path: req.path,
  method: req.method
}));
console.log('   ✅ /api/test registered');

// Teacher/Learner routes
app.use('/api/learners', learnerRoutes);
console.log('   ✅ /api/learners ->', learnerRoutes.stack ? `${learnerRoutes.stack.length} routes` : 'Router mounted');

app.use('/api/reports', reportRoutes);
console.log('   ✅ /api/reports ->', reportRoutes.stack ? `${reportRoutes.stack.length} routes` : 'Router mounted');

app.use('/api/attendance', attendanceRoutes);
console.log('   ✅ /api/attendance ->', attendanceRoutes.stack ? `${attendanceRoutes.stack.length} routes` : 'Router mounted');

app.use('/api/dashboard', dashboardRoutes);
console.log('   ✅ /api/dashboard ->', dashboardRoutes.stack ? `${dashboardRoutes.stack.length} routes` : 'Router mounted');

// ADMIN ROUTES
app.use('/api/admin', adminRoutes);
console.log('   ✅ /api/admin ->', adminRoutes.stack ? `${adminRoutes.stack.length} routes` : 'Router mounted');

app.use('/api/admin/classes', classRoutes);
console.log('   ✅ /api/admin/classes ->', classRoutes.stack ? `${classRoutes.stack.length} routes` : 'Router mounted');

app.use('/api/admin/subjects', subjectRoutes);
console.log('   ✅ /api/admin/subjects ->', subjectRoutes.stack ? `${subjectRoutes.stack.length} routes` : 'Router mounted');

app.use('/api/admin/streams', streamRoutes);
console.log('   ✅ /api/admin/streams ->', streamRoutes.stack ? `${streamRoutes.stack.length} routes` : 'Router mounted');

app.use('/api/admin/assignments', assignmentRoutes);
console.log('   ✅ /api/admin/assignments ->', assignmentRoutes.stack ? `${assignmentRoutes.stack.length} routes` : 'Router mounted');

app.use('/api/admin/stats', adminStatsRoutes);
console.log('   ✅ /api/admin/stats ->', adminStatsRoutes.stack ? `${adminStatsRoutes.stack.length} routes` : 'Router mounted');

console.log('='.repeat(60));

// ============================================
// SAFE ROUTE DEBUGGING
// ============================================
console.log('\n📋 Registered Routes Summary:');
try {
  let routeCount = 0;
  if (app._router && app._router.stack) {
    console.log('\n   🔍 All registered paths:');
    app._router.stack.forEach((layer) => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
        console.log(`      ${methods} ${layer.route.path}`);
        routeCount++;
      } else if (layer.name === 'router' && layer.regexp) {
        // This is a router middleware - show its base path
        const path = layer.regexp.toString()
          .replace('/\\^?(?:\\/(?:\\(\\?([^\\/)]+)\\))?)?(?:\\/?\\(\\?=\\/?\\|\\/\\))?/g', '')
          .replace(/\\\//g, '/')
          .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, '*');
        console.log(`      📁 Router: ${path}`);
      }
    });
    console.log(`\n   Total routes: ${routeCount}`);
  } else {
    console.log('   Router not yet fully initialized');
  }
} catch (err) {
  console.log('   Could not list routes:', err.message);
}
console.log('='.repeat(60));

// Health check endpoint - Important for Render
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    supabase: process.env.SUPABASE_URL ? '✅ Configured' : '❌ Missing',
    routes: {
      auth: !!authRoutes,
      learners: !!learnerRoutes,
      reports: !!reportRoutes,
      attendance: !!attendanceRoutes,
      dashboard: !!dashboardRoutes,
      admin: !!adminRoutes,
      classes: !!classRoutes,
      subjects: !!subjectRoutes,
      streams: !!streamRoutes,
      assignments: !!assignmentRoutes,
      adminStats: !!adminStatsRoutes
    }
  });
});

// API info endpoint
app.get('/api', (req, res) => {
  res.json({
    name: 'EduPortal API',
    version: '1.0.0',
    description: 'School Management System API',
    environment: process.env.NODE_ENV,
    baseUrl: `${req.protocol}://${req.get('host')}`,
    endpoints: {
      auth: '/api/auth',
      learners: '/api/learners',
      reports: '/api/reports',
      attendance: '/api/attendance',
      dashboard: '/api/dashboard',
      admin: '/api/admin',
      health: '/health',
      test: '/test'
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.redirect('/api');
});

// 404 handler
app.use((req, res) => {
  console.log(`404 - ${req.method} ${req.path} - Not found`);
  res.status(404).json({ 
    success: false,
    message: 'Route not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('🔥 Error:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : '🔒 Hidden in production',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });

  // Handle specific error types
  if (err.name === 'ValidationError') {
    return res.status(400).json({ 
      success: false,
      message: 'Validation error', 
      errors: err.errors 
    });
  }

  if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
    return res.status(401).json({ 
      success: false,
      message: 'Invalid or expired token' 
    });
  }

  if (err.code === 'PGRST116') {
    return res.status(404).json({ 
      success: false,
      message: 'Resource not found in database' 
    });
  }

  if (err.code === '23505') { // Unique violation
    return res.status(409).json({ 
      success: false,
      message: 'Duplicate entry. This record already exists.' 
    });
  }

  if (err.code === '23503') { // Foreign key violation
    return res.status(400).json({ 
      success: false,
      message: 'Referenced record does not exist.' 
    });
  }

  // Database connection error
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return res.status(503).json({ 
      success: false,
      message: 'Database connection failed. Please try again later.' 
    });
  }

  // Default error
  const status = err.status || 500;
  const message = err.message || 'Internal server error';
  
  res.status(status).json({ 
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { 
      stack: err.stack,
      details: err.details 
    })
  });
});

// Start server - Bind to 0.0.0.0 for Render
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 SERVER STARTED SUCCESSFULLY`);
  console.log('='.repeat(60));
  console.log(`\n📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`📡 Supabase: ${process.env.SUPABASE_URL ? '✅ Connected' : '❌ Not configured'}`);
  console.log(`\n📍 Available endpoints:`);
  console.log(`   - Health:    ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/health`);
  console.log(`   - API Info:  ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/api`);
  console.log(`   - Test:      ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/test`);
  console.log(`   - Auth Test: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/api/auth/test`);
  console.log(`   - Learner Login: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/api/auth/learner/login`);
  console.log(`\n📊 Server ready to accept connections`);
  console.log(`🌍 Public URL: ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT}`);
  console.log('='.repeat(60));
});

// Graceful shutdown
const gracefulShutdown = () => {
  console.log('\n🛑 Received shutdown signal, closing server...');
  server.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    console.error('❌ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit in production, just log
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  // Don't exit in production, just log
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

module.exports = app;