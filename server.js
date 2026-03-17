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
      'https://eduportal-frontend.vercel.app',
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
app.use(cors(corsOptions)); // 👈 Only use this ONCE (removed duplicate)

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
  skip: (req) => req.path === '/health'
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

// Debug: Check if route files exist before importing
console.log('📁 Checking route files...');
console.log('='.repeat(50));

// Import routes with error handling
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

// Auth routes
try {
  authRoutes = require('./routes/auth');
  console.log('✅ Auth routes loaded');
} catch (error) {
  console.error('❌ Failed to load auth routes:', error.message);
  authRoutes = express.Router();
}

// Learner routes
try {
  learnerRoutes = require('./routes/learners');
  console.log('✅ Learners routes loaded');
} catch (error) {
  console.error('❌ Failed to load learners routes:', error.message);
  learnerRoutes = express.Router();
}

// Report routes
try {
  reportRoutes = require('./routes/reports');
  console.log('✅ Reports routes loaded');
} catch (error) {
  console.error('❌ Failed to load reports routes:', error.message);
  reportRoutes = express.Router();
}

// Attendance routes
try {
  attendanceRoutes = require('./routes/attendance');
  console.log('✅ Attendance routes loaded');
} catch (error) {
  console.error('❌ Failed to load attendance routes:', error.message);
  attendanceRoutes = express.Router();
}

// Dashboard routes
try {
  dashboardRoutes = require('./routes/dashboard');
  console.log('✅ Dashboard routes loaded');
} catch (error) {
  console.error('❌ Failed to load dashboard routes:', error.message);
  dashboardRoutes = express.Router();
}

// Admin management routes
try {
  adminRoutes = require('./routes/admin');
  console.log('✅ Admin routes loaded');
} catch (error) {
  console.error('❌ Failed to load admin routes:', error.message);
  adminRoutes = express.Router();
}

// Class management routes (Forms 1-4)
try {
  classRoutes = require('./routes/classes');
  console.log('✅ Class routes loaded');
} catch (error) {
  console.error('❌ Failed to load class routes:', error.message);
  classRoutes = express.Router();
}

// Subject management routes
try {
  subjectRoutes = require('./routes/subjects');
  console.log('✅ Subject routes loaded');
} catch (error) {
  console.error('❌ Failed to load subject routes:', error.message);
  subjectRoutes = express.Router();
}

// Stream management routes
try {
  streamRoutes = require('./routes/streams');
  console.log('✅ Stream routes loaded');
} catch (error) {
  console.error('❌ Failed to load stream routes:', error.message);
  streamRoutes = express.Router();
}

// Assignment routes (teacher-class-subject assignments)
try {
  assignmentRoutes = require('./routes/assignments');
  console.log('✅ Assignment routes loaded');
} catch (error) {
  console.error('❌ Failed to load assignment routes:', error.message);
  assignmentRoutes = express.Router();
}

// Admin statistics routes
try {
  adminStatsRoutes = require('./routes/adminStats');
  console.log('✅ Admin stats routes loaded');
} catch (error) {
  console.error('❌ Failed to load admin stats routes:', error.message);
  adminStatsRoutes = express.Router();
}

console.log('='.repeat(50));

// ============================================
// REGISTER ROUTES
// ============================================

// Public routes
app.use('/api/auth', authRoutes);
app.use('/api/test', (req, res) => res.json({ message: 'API is working!' }));

// Teacher/Learner routes
app.use('/api/learners', learnerRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/dashboard', dashboardRoutes);

// ADMIN ROUTES
app.use('/api/admin', adminRoutes);
app.use('/api/admin/classes', classRoutes);
app.use('/api/admin/subjects', subjectRoutes);
app.use('/api/admin/streams', streamRoutes);
app.use('/api/admin/assignments', assignmentRoutes);
app.use('/api/admin/stats', adminStatsRoutes);

// ============================================
// ROUTE DEBUGGING - Add this to see all registered routes
// ============================================
console.log('\n📋 Registered Routes:');
const listRoutes = (stack, basePath = '') => {
  stack.forEach((layer) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
      console.log(`   ${methods} ${basePath}${layer.route.path}`);
    } else if (layer.name === 'router' && layer.handle.stack) {
      // This is a router middleware - recursively list its routes
      const routerPath = layer.regexp.source
        .replace('\\/?(?=\\/|$)', '')
        .replace(/\\\//g, '/')
        .replace(/\^/g, '')
        .replace(/\?/g, '')
        .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ':param');
      listRoutes(layer.handle.stack, basePath + routerPath);
    }
  });
};
listRoutes(app._router.stack);
console.log('='.repeat(50));

// Health check endpoint - Important for Render
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
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
      health: '/health'
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.redirect('/api');
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
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
      message: 'Validation error', 
      errors: err.errors 
    });
  }

  if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  if (err.code === 'PGRST116') {
    return res.status(404).json({ message: 'Resource not found in database' });
  }

  if (err.code === '23505') { // Unique violation
    return res.status(409).json({ 
      message: 'Duplicate entry. This record already exists.' 
    });
  }

  if (err.code === '23503') { // Foreign key violation
    return res.status(400).json({ 
      message: 'Referenced record does not exist.' 
    });
  }

  // Database connection error
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return res.status(503).json({ 
      message: 'Database connection failed. Please try again later.' 
    });
  }

  // Default error
  const status = err.status || 500;
  const message = err.message || 'Internal server error';
  
  res.status(status).json({ 
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
  console.log(`\n🚀 Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
  console.log(`📡 Supabase URL: ${process.env.SUPABASE_URL ? '✅ Configured' : '❌ Missing'}`);
  console.log(`\n📍 Available endpoints:`);
  console.log(`   - Health:    ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/health`);
  console.log(`   - API Info:  ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}/api`);
  console.log(`\n📊 Server ready to accept connections`);
  console.log(`🌍 Public URL: ${process.env.RENDER_EXTERNAL_URL || 'Not deployed yet'}`);
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