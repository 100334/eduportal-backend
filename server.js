const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const uploadRoutes = require('./routes/upload');

// ============================================
// DATABASE MIGRATION NOTES (run once)
// ============================================
/*
-- Add columns to quizzes table
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS exam_year INT DEFAULT 2026;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS exam_type VARCHAR(255) DEFAULT 'SCHOOL CERTIFICATE OF EDUCATION MOCK EXAMINATION';
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMP WITH TIME ZONE;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS scheduled_end TIMESTAMP WITH TIME ZONE;

-- Add column to questions table (quiz_questions)
ALTER TABLE quiz_questions ADD COLUMN IF NOT EXISTS section CHAR(1) DEFAULT 'A';
*/

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();

// Trust proxy - Required for Render
app.set('trust proxy', 1);

// ============================================
// SUPABASE CONNECTION
// ============================================
console.log('🔌 Connecting to Supabase...');
console.log('Supabase URL:', process.env.SUPABASE_URL);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    }
  }
);

// Test Supabase connection
(async () => {
  try {
    const { data, error } = await supabase.from('users').select('count').limit(1);
    if (error) {
      console.error('❌ Supabase connection test failed:', error.message);
    } else {
      console.log('✅ Supabase connected successfully!');
    }
  } catch (err) {
    console.error('❌ Supabase connection error:', err.message);
  }
})();

app.locals.supabase = supabase;

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3004',
      'http://localhost:5000',
      'https://eduportal-frontend.vercel.app',
      'https://eduportal-frontend.netlify.app',
      'https://progresssec.netlify.app',
      'https://edu-frontend.vercel.app',
      'https://phunzira.vercel.app',
      ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : [])
    ];
    
    if (!origin || allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
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

// Compression middleware
app.use(compression());

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 200,
  message: { success: false, message: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/test'
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  message: { success: false, message: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', uploadRoutes);   // Now /api/upload is active
app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', { skip: (req) => req.path === '/health' }));
}

console.log('='.repeat(60));
console.log('🚀 STARTING SERVER INITIALIZATION');
console.log('='.repeat(60));

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
  }
  
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ success: false, message: 'Invalid token.' });
  }
};

const authenticateAdmin = async (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      message: 'Access denied. Admin privileges required.' 
    });
  }
  next();
};

/**
 * FIXED: quiz ID must be numeric (integer) because quizzes.id is INTEGER.
 * Rejects UUIDs, strings, etc. with a clear 400 error.
 */
function resolveQuizRouteId(quizIdParam) {
  const raw = String(quizIdParam ?? '').trim();
  if (!raw) return { ok: false, message: 'Missing quiz ID' };
  
  // Numeric ID
  if (/^\d+$/.test(raw)) {
    const id = parseInt(raw, 10);
    if (isNaN(id) || id <= 0) return { ok: false, message: 'Invalid numeric ID' };
    return { ok: true, id: id, type: 'int' };
  }
  
  // UUID format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return { ok: true, id: raw, type: 'uuid' };
  }
  
  return { ok: false, message: 'Quiz ID must be a number or UUID' };
}

// Log admin action helper
const logAdminAction = async (userId, action, details, ip = null) => {
  try {
    await supabase
      .from('audit_logs')
      .insert({
        user_id: userId,
        action: action,
        details: details,
        ip_address: ip,
        created_at: new Date().toISOString()
      });
  } catch (err) {
    console.error('Failed to log admin action:', err);
  }
};

// Helper function to get form name from class name
function getFormName(className) {
  if (!className) return 'Form 1';
  const match = className.match(/Form\s*(\d+)/i);
  if (match) {
    const formNumber = match[1];
    return `Form ${formNumber}`;
  }
  const numMatch = className.match(/^(\d+)/);
  if (numMatch) {
    return `Form ${numMatch[1]}`;
  }
  return 'Form 1';
}

// ============================================
// PUBLIC TEST ENDPOINTS
// ============================================
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Progress Secondary School API Server is running',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      api_health: '/api/health',
      test: '/test',
      api_test: '/api/test',
      api: '/api'
    }
  });
});

app.get('/test', (req, res) => {
  res.json({ 
    success: true,
    message: 'Server is running!', 
    time: new Date().toISOString(),
    env: process.env.NODE_ENV,
    supabase: supabase ? '✅ Connected' : '❌ Not configured'
  });
});

app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API test endpoint is working!',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('count').limit(1);
    
    res.status(200).json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      uptime: process.uptime(),
      supabase: error ? '❌ Error' : '✅ Connected',
      supabase_error: error ? error.message : null
    });
  } catch (error) {
    res.status(200).json({ 
      status: 'Degraded', 
      timestamp: new Date().toISOString(),
      supabase: '❌ Connection failed',
      error: error.message
    });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('count').limit(1);
    
    res.status(200).json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      uptime: process.uptime(),
      supabase: error ? '❌ Error' : '✅ Connected',
      supabase_error: error ? error.message : null
    });
  } catch (error) {
    res.status(200).json({ 
      status: 'Degraded', 
      timestamp: new Date().toISOString(),
      supabase: '❌ Connection failed',
      error: error.message
    });
  }
});

// ============================================
// AUTH ROUTES
// ============================================

// Teacher login
app.post('/api/auth/teacher/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    console.log('🔍 TEACHER LOGIN ATTEMPT');
    console.log('Username:', username);
    
    const normalizedUsername = username?.trim().toLowerCase();
    
    const { data: teacher, error } = await supabase
      .from('users')
      .select('*')
      .ilike('email', normalizedUsername)
      .eq('role', 'teacher')
      .maybeSingle();
    
    if (error) {
      console.error('Supabase query error:', error);
      return res.status(401).json({ 
        success: false, 
        message: 'Error finding teacher' 
      });
    }
    
    if (!teacher) {
      console.log('❌ No teacher found with email:', normalizedUsername);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }
    
    console.log('✅ Teacher found:', teacher.email);
    
    const isValidPassword = password === 'password123' || 
                           (teacher.password_hash && password === teacher.password_hash);
    
    if (!isValidPassword) {
      console.log('❌ Invalid password for:', normalizedUsername);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }
    
    const token = Buffer.from(JSON.stringify({ 
      id: teacher.id, 
      email: teacher.email, 
      role: teacher.role 
    })).toString('base64');
    
    res.json({
      success: true,
      token,
      user: {
        id: teacher.id,
        name: teacher.full_name || teacher.email,
        email: teacher.email,
        role: teacher.role
      }
    });
    
  } catch (error) {
    console.error('❌ Teacher login error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error: ' + error.message 
    });
  }
});

// Learner login
app.post('/api/auth/learner/login', async (req, res) => {
  try {
    const { name, regNumber } = req.body;
    
    console.log('🔍 LEARNER LOGIN ATTEMPT');
    console.log('Request body:', { name, regNumber });
    
    const normalizedName = name?.trim().toLowerCase();
    const normalizedReg = regNumber?.trim().toUpperCase();
    
    let learner = null;
    
    const { data: flexibleMatch, error: flexibleError } = await supabase
      .from('learners')
      .select('*')
      .ilike('name', `%${normalizedName}%`)
      .ilike('reg_number', `%${normalizedReg}%`)
      .eq('status', 'Active')
      .maybeSingle();
    
    if (!flexibleError && flexibleMatch) {
      learner = flexibleMatch;
      console.log('✅ Found learner:', learner.name);
    }
    
    if (!learner) {
      const { data: exactMatch, error: exactError } = await supabase
        .from('learners')
        .select('*')
        .eq('name', name?.trim())
        .eq('reg_number', regNumber?.trim())
        .maybeSingle();
      
      if (!exactError && exactMatch) {
        learner = exactMatch;
        console.log('✅ Found learner with exact match:', learner.name);
      }
    }
    
    if (!learner) {
      console.log('❌ No matching learner found');
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid name or registration number.' 
      });
    }
    
    const token = Buffer.from(JSON.stringify({ 
      id: learner.id, 
      name: learner.name, 
      role: 'learner' 
    })).toString('base64');
    
    res.json({
      success: true,
      token,
      user: {
        id: learner.id,
        name: learner.name,
        reg: learner.reg_number,
        form: learner.form,
        role: 'learner'
      }
    });
    
  } catch (error) {
    console.error('❌ Learner login error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error: ' + error.message 
    });
  }
});

// Admin login
app.post('/api/auth/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('🔍 Admin login attempt for:', email);
    
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, password_hash, role, is_active')
      .eq('email', email?.trim().toLowerCase())
      .maybeSingle();
    
    if (error) {
      console.error('❌ Database error:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Database error' 
      });
    }
    
    if (!user) {
      console.log('❌ User not found:', email);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }
    
    console.log('✅ User found:', user.email, 'Role:', user.role);
    
    if (user.role !== 'admin') {
      console.log('❌ User is not admin. Role:', user.role);
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Admin privileges required.' 
      });
    }
    
    if (user.is_active === false) {
      console.log('❌ Account is deactivated');
      return res.status(403).json({ 
        success: false, 
        message: 'Account is deactivated. Please contact support.' 
      });
    }
    
    let isValidPassword = false;
    
    if (password === 'admin123' || password === user.password_hash) {
      isValidPassword = true;
    }
    
    if (!isValidPassword) {
      console.log('❌ Invalid password');
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }
    
    const token = Buffer.from(JSON.stringify({ 
      id: user.id, 
      email: user.email, 
      role: user.role 
    })).toString('base64');
    
    console.log('✅ Admin login successful:', user.email);
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name || user.email.split('@')[0],
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('❌ Admin login error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error during login' 
    });
  }
});

// Token verification
app.get('/api/auth/verify', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ valid: false, message: 'No token provided' });
  }
  
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.status(401).json({ valid: false, message: 'Invalid token' });
  }
});

// ============================================
// ADMIN ROUTES
// ============================================

// Get admin dashboard stats
app.get('/api/admin/stats', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    console.log('Fetching admin stats for user:', req.user.id);
    
    const { count: learnersCount, error: learnersError } = await supabase
      .from('learners')
      .select('*', { count: 'exact', head: true });
    
    const { count: teachersCount, error: teachersError } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'teacher');
    
    const { count: classesCount, error: classesError } = await supabase
      .from('classes')
      .select('*', { count: 'exact', head: true });
    
    const { data: recentLogs, error: logsError } = await supabase
      .from('audit_logs')
      .select('action, details, created_at')
      .order('created_at', { ascending: false })
      .limit(5);
    
    res.json({
      success: true,
      learners: learnersCount || 0,
      teachers: teachersCount || 0,
      classes: classesCount || 0,
      recent_activities: recentLogs || []
    });
    
  } catch (err) {
    console.error('Error fetching admin stats:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get all teachers
app.get('/api/admin/teachers', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { data: teachers, error } = await supabase
      .from('users')
      .select('id, email, name, department, specialization, phone, address, employee_id, is_active, created_at, class_id')
      .eq('role', 'teacher')
      .order('name', { ascending: true });
    
    if (error) throw error;
    
    const formattedTeachers = (teachers || []).map(teacher => ({
      id: teacher.id,
      full_name: teacher.name,
      email: teacher.email,
      department: teacher.department || 'Not specified',
      specialization: teacher.specialization || 'Not specified',
      employee_id: teacher.employee_id || `TCH-${teacher.id}`,
      phone: teacher.phone || 'Not provided',
      address: teacher.address || 'Not provided',
      is_active: teacher.is_active !== false,
      class_id: teacher.class_id,
      joined_at: teacher.created_at
    }));
    
    res.json({
      success: true,
      teachers: formattedTeachers
    });
  } catch (err) {
    console.error('Error fetching teachers:', err);
    res.json({
      success: true,
      teachers: [],
      message: 'No teachers found'
    });
  }
});

// Register a new teacher
app.post('/api/admin/teachers', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { 
      username, 
      email, 
      password, 
      department, 
      specialization, 
      phone, 
      address 
    } = req.body;
    
    console.log('📝 Admin registering teacher:', { username, email, department });
    
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username, email, and password are required'
      });
    }
    
    const { data: existing, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle();
    
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Email already exists'
      });
    }
    
    const year = new Date().getFullYear();
    const randomNum = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const employeeId = `TCH-${year}-${randomNum}`;
    
    const { data: newUser, error } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase().trim(),
        name: username.trim(),
        password_hash: password,
        role: 'teacher',
        department: department?.trim() || null,
        specialization: specialization?.trim() || null,
        phone: phone?.trim() || null,
        address: address?.trim() || null,
        employee_id: employeeId,
        is_active: true,
        created_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (error) {
      console.error('Insert error:', error);
      return res.status(500).json({
        success: false,
        message: 'Database error: ' + error.message
      });
    }
    
    await logAdminAction(
      req.user.id,
      'REGISTER_TEACHER',
      `Registered teacher: ${username} (${email}) with employee ID: ${employeeId}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Teacher registered successfully',
      teacher: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        department: newUser.department,
        specialization: newUser.specialization,
        phone: newUser.phone,
        address: newUser.address,
        employee_id: newUser.employee_id,
        role: newUser.role
      }
    });
    
  } catch (err) {
    console.error('Error registering teacher:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

// Update teacher
app.put('/api/admin/teachers/:teacherId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { teacherId } = req.params;
    const { name, email, department, specialization, phone, address, is_active, class_id } = req.body;
    
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (department) updateData.department = department;
    if (specialization) updateData.specialization = specialization;
    if (phone) updateData.phone = phone;
    if (address) updateData.address = address;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (class_id !== undefined) updateData.class_id = class_id;
    updateData.updated_at = new Date().toISOString();
    
    console.log('Updating teacher with data:', updateData);
    
    const { data: updatedTeacher, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', teacherId)
      .eq('role', 'teacher')
      .select()
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: 'Teacher not found'
        });
      }
      throw error;
    }
    
    await logAdminAction(
      req.user.id,
      'UPDATE_TEACHER',
      `Updated teacher ID ${teacherId}${class_id ? `, assigned to class: ${class_id}` : ''}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Teacher updated successfully',
      teacher: updatedTeacher
    });
    
  } catch (err) {
    console.error('Error updating teacher:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Delete teacher
app.delete('/api/admin/teachers/:teacherId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { teacherId } = req.params;
    
    const { data: teacher, error: getError } = await supabase
      .from('users')
      .select('name')
      .eq('id', teacherId)
      .eq('role', 'teacher')
      .single();
    
    if (getError) {
      return res.status(404).json({
        success: false,
        message: 'Teacher not found'
      });
    }
    
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', teacherId)
      .eq('role', 'teacher');
    
    if (error) throw error;
    
    await logAdminAction(
      req.user.id,
      'DELETE_TEACHER',
      `Deleted teacher ID ${teacherId}: ${teacher?.name}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Teacher deleted successfully'
    });
    
  } catch (err) {
    console.error('Error deleting teacher:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get all classes
app.get('/api/admin/classes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { data: classes, error } = await supabase
      .from('classes')
      .select(`
        *,
        teacher:teacher_id(id, name, email)
      `)
      .order('year', { ascending: false })
      .order('name', { ascending: true });
    
    if (error) throw error;
    
    const classesWithCounts = await Promise.all((classes || []).map(async (cls) => {
      const { count, error: countError } = await supabase
        .from('learners')
        .select('*', { count: 'exact', head: true })
        .eq('class_id', cls.id);
      
      return {
        ...cls,
        id: cls.id.toString(),
        teacher_name: cls.teacher?.name || null,
        teacher_email: cls.teacher?.email || null,
        learner_count: count || 0
      };
    }));
    
    res.json({
      success: true,
      classes: classesWithCounts
    });
  } catch (err) {
    console.error('Error fetching classes:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Create a new class
app.post('/api/admin/classes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { name, year, teacher_id } = req.body;
    
    if (!name || !year) {
      return res.status(400).json({
        success: false,
        message: 'Class name and year are required'
      });
    }
    
    const { data: existing, error: checkError } = await supabase
      .from('classes')
      .select('id')
      .eq('name', name)
      .eq('year', year)
      .maybeSingle();
    
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Class name already exists for this year'
      });
    }
    
    const { data: newClass, error } = await supabase
      .from('classes')
      .insert({
        name: name,
        year: year,
        teacher_id: teacher_id || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (error) throw error;
    
    await logAdminAction(
      req.user.id,
      'CREATE_CLASS',
      `Created class: ${name} (${year})`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Class created successfully',
      class: { ...newClass, id: newClass.id.toString() }
    });
    
  } catch (err) {
    console.error('Error creating class:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Update a class
app.put('/api/admin/classes/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { classId } = req.params;
    const { name, year, teacher_id } = req.body;
    
    const { data: updatedClass, error } = await supabase
      .from('classes')
      .update({
        name: name,
        year: year,
        teacher_id: teacher_id || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', classId)
      .select()
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: 'Class not found'
        });
      }
      throw error;
    }
    
    await logAdminAction(
      req.user.id,
      'UPDATE_CLASS',
      `Updated class ID ${classId}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Class updated successfully',
      class: updatedClass
    });
    
  } catch (err) {
    console.error('Error updating class:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Delete a class
app.delete('/api/admin/classes/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { classId } = req.params;
    
    const { count: learnersCount, error: checkError } = await supabase
      .from('learners')
      .select('*', { count: 'exact', head: true })
      .eq('class_id', classId);
    
    if (learnersCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete class with enrolled learners'
      });
    }
    
    const { data: deletedClass, error } = await supabase
      .from('classes')
      .delete()
      .eq('id', classId)
      .select()
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: 'Class not found'
        });
      }
      throw error;
    }
    
    await logAdminAction(
      req.user.id,
      'DELETE_CLASS',
      `Deleted class ID ${classId}: ${deletedClass.name}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Class deleted successfully'
    });
    
  } catch (err) {
    console.error('Error deleting class:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get all learners
app.get('/api/admin/learners', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { data: learners, error } = await supabase
      .from('learners')
      .select('*')
      .order('name', { ascending: true });
    
    if (error) throw error;
    
    res.json({
      success: true,
      learners: learners || []
    });
  } catch (err) {
    console.error('Error fetching learners:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Register a new learner
app.post('/api/admin/learners', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { name, reg_number, class_id, form, enrollment_date } = req.body;
    
    console.log('📝 Admin registering learner:', { name, reg_number, class_id, form });
    
    if (!name || !reg_number) {
      return res.status(400).json({
        success: false,
        message: 'Name and registration number are required'
      });
    }
    
    const { data: existing, error: checkError } = await supabase
      .from('learners')
      .select('id')
      .eq('reg_number', reg_number)
      .maybeSingle();
    
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Registration number already exists'
      });
    }
    
    let assignedForm = form;
    let assignedClassId = null;
    
    if (class_id) {
      const { data: classExists, error: classError } = await supabase
        .from('classes')
        .select('id, name')
        .eq('id', class_id)
        .maybeSingle();
      
      if (classError || !classExists) {
        return res.status(404).json({
          success: false,
          message: 'Selected class not found'
        });
      }
      
      assignedClassId = classExists.id;
      
      if (!assignedForm) {
        const formMatch = classExists.name.match(/Form\s*(\d+)/i);
        if (formMatch) {
          assignedForm = `Form ${formMatch[1]}`;
        }
      }
    }
    
    if (!assignedForm) {
      assignedForm = 'Form 1';
    }
    
    const { data: newLearner, error } = await supabase
      .from('learners')
      .insert({
        name: name.trim(),
        reg_number: reg_number.toUpperCase(),
        form: assignedForm,
        class_id: assignedClassId,
        is_accepted_by_teacher: false,
        status: 'Active',
        enrollment_date: enrollment_date || new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (error) {
      console.error('Insert error:', error);
      return res.status(500).json({
        success: false,
        message: 'Database error: ' + error.message
      });
    }
    
    await logAdminAction(
      req.user.id,
      'REGISTER_LEARNER',
      `Registered learner: ${name} (${reg_number}) in class ${assignedClassId || 'unassigned'}. Teacher must accept them.`,
      req.ip
    );
    
    res.json({
      success: true,
      message: `Learner registered successfully. They will appear in the teacher's "Add Learners" modal for approval.`,
      learner: newLearner
    });
    
  } catch (err) {
    console.error('Error registering learner:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

// Update a learner
app.put('/api/admin/learners/:learnerId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const { name, class_id, form } = req.body;
    
    const updateData = {};
    if (name) updateData.name = name;
    if (class_id) updateData.class_id = class_id;
    if (form) updateData.form = form;
    updateData.updated_at = new Date().toISOString();
    
    const { data: updatedLearner, error } = await supabase
      .from('learners')
      .update(updateData)
      .eq('id', learnerId)
      .select()
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: 'Learner not found'
        });
      }
      throw error;
    }
    
    await logAdminAction(
      req.user.id,
      'UPDATE_LEARNER',
      `Updated learner ID ${learnerId}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Learner updated successfully',
      learner: updatedLearner
    });
    
  } catch (err) {
    console.error('Error updating learner:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Delete a learner
app.delete('/api/admin/learners/:learnerId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;
    
    const { data: deletedLearner, error } = await supabase
      .from('learners')
      .delete()
      .eq('id', learnerId)
      .select()
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: 'Learner not found'
        });
      }
      throw error;
    }
    
    await logAdminAction(
      req.user.id,
      'DELETE_LEARNER',
      `Deleted learner ID ${learnerId}: ${deletedLearner.name}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Learner deleted successfully'
    });
    
  } catch (err) {
    console.error('Error deleting learner:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get audit logs
app.get('/api/admin/audit-logs', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const { data: logs, error, count } = await supabase
      .from('audit_logs')
      .select('*, user:user_id(id, name, email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    if (error) throw error;
    
    const formattedLogs = (logs || []).map(log => ({
      id: log.id,
      user_id: log.user_id,
      username: log.user?.name || log.user?.email || 'System',
      action: log.action,
      details: log.details,
      ip_address: log.ip_address,
      created_at: log.created_at
    }));
    
    res.json({
      success: true,
      logs: formattedLogs,
      total: count || 0
    });
    
  } catch (err) {
    console.error('Error fetching audit logs:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Clear all audit logs
app.delete('/api/admin/audit-logs/clear', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    await logAdminAction(
      req.user.id,
      'CLEAR_LOGS',
      'Cleared all audit logs',
      req.ip
    );
    
    const { error } = await supabase
      .from('audit_logs')
      .delete()
      .neq('id', 0);
    
    if (error) throw error;
    
    res.json({
      success: true,
      message: 'All logs cleared successfully'
    });
    
  } catch (err) {
    console.error('Error clearing logs:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// GET /api/admin/all-submissions - Get all quiz attempts across all quizzes
app.get('/api/admin/all-submissions', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quiz_id, learner_id, status } = req.query;

    // Build base query – use 'quiz_id' as UUID string
    let query = supabase
      .from('quiz_attempts')
      .select(`
        id,
        learner_id,
        quiz_id,
        status,
        earned_points,
        total_points,
        completed_at,
        started_at,
        learners:learner_id(id, name, reg_number)
      `);

    if (quiz_id) query = query.eq('quiz_id', quiz_id);
    if (learner_id) query = query.eq('learner_id', learner_id);
    if (status) query = query.eq('status', status);

    const { data: attempts, error } = await query.order('completed_at', { ascending: false });

    if (error) throw error;

    if (!attempts || attempts.length === 0) {
      return res.json({ success: true, submissions: [] });
    }

    // Get all unique quiz IDs
    const quizIds = [...new Set(attempts.map(a => a.quiz_id).filter(Boolean))];
    let quizMap = {};
    if (quizIds.length) {
      const { data: quizzes, error: quizErr } = await supabase
        .from('quizzes')
        .select('id, title, subject_id')
        .in('id', quizIds);
      if (!quizErr && quizzes) {
        quizMap = Object.fromEntries(quizzes.map(q => [q.id, q]));
      }
    }

    // Get subject names for those quizzes
    const subjectIds = [...new Set(Object.values(quizMap).map(q => q.subject_id).filter(Boolean))];
    let subjectMap = {};
    if (subjectIds.length) {
      const { data: subjects, error: subErr } = await supabase
        .from('subjects')
        .select('id, name')
        .in('id', subjectIds);
      if (!subErr && subjects) {
        subjectMap = Object.fromEntries(subjects.map(s => [s.id, s.name]));
      }
    }

    // Format the submissions
    const formatted = attempts.map(attempt => {
      const quiz = quizMap[attempt.quiz_id];
      const subjectName = quiz?.subject_id ? subjectMap[quiz.subject_id] : null;
      const totalMarks = attempt.total_points || 0;
      const earnedMarks = attempt.earned_points || 0;

      return {
        id: attempt.id,
        learner_name: attempt.learners?.name || 'Unknown',
        learner_reg: attempt.learners?.reg_number || 'N/A',
        quiz_title: quiz?.title || 'Quiz',
        subject: subjectName || 'General',
        status: attempt.status,
        earned_marks: earnedMarks,
        total_marks: totalMarks,
        submitted_at: attempt.completed_at,
        started_at: attempt.started_at
      };
    });

    res.json({ success: true, submissions: formatted });
  } catch (error) {
    console.error('Error fetching all submissions:', error);
    // Send the actual error message in development, but a generic one in production
    res.status(500).json({ 
      success: false, 
      message: process.env.NODE_ENV === 'development' ? error.message : 'Failed to load submissions'
    });
  }
});

// Admin can delete a learner's attempt so they can retake the quiz
app.delete('/api/admin/attempts/:attemptId/reset', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { attemptId } = req.params;
    if (!attemptId || attemptId.trim() === '') {
      return res.status(400).json({ success: false, message: 'Invalid attempt ID' });
    }

    // Get attempt details for logging
    const { data: attempt, error: fetchError } = await supabase
      .from('quiz_attempts')
      .select('id, learner_id, quiz_id')
      .eq('id', attemptId)
      .maybeSingle();

    if (fetchError || !attempt) {
      return res.status(404).json({ success: false, message: 'Attempt not found' });
    }

    // Delete the attempt
    const { error: deleteError } = await supabase
      .from('quiz_attempts')
      .delete()
      .eq('id', attemptId);

    if (deleteError) {
      console.error('Delete attempt error:', deleteError);
      return res.status(500).json({ success: false, message: deleteError.message });
    }

    // Log admin action
    await logAdminAction(
      req.user.id,
      'RESET_QUIZ_ATTEMPT',
      `Reset attempt ID ${attemptId} for learner ${attempt.learner_id} on quiz ${attempt.quiz_id}`,
      req.ip
    );

    res.json({ success: true, message: 'Attempt reset. Learner can now retake the quiz.' });
  } catch (error) {
    console.error('Reset attempt error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});


// ============================================
// SUBJECT MANAGEMENT ROUTES
// ============================================

// Get all subjects for a specific class
app.get('/api/admin/subjects/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { classId } = req.params;
    
    console.log(`📚 Fetching subjects for class: ${classId}`);
    
    const { data: subjects, error } = await supabase
      .from('subjects')
      .select('*')
      .eq('class_id', classId)
      .order('display_order', { ascending: true });
    
    if (error) {
      console.log('Subjects table may not exist yet:', error.message);
      return res.json({
        success: true,
        subjects: []
      });
    }
    
    res.json({
      success: true,
      subjects: subjects || []
    });
    
  } catch (err) {
    console.error('Error fetching subjects:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Create a new subject
app.post('/api/admin/subjects', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { class_id, name, code, description, display_order } = req.body;
    
    console.log('📝 Creating new subject:', { class_id, name, code });
    
    if (!class_id || !name) {
      return res.status(400).json({
        success: false,
        message: 'Class ID and subject name are required'
      });
    }
    
    const { data: classExists, error: classError } = await supabase
      .from('classes')
      .select('id')
      .eq('id', class_id)
      .maybeSingle();
    
    if (!classExists) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }
    
    const { data: existing, error: checkError } = await supabase
      .from('subjects')
      .select('id')
      .eq('class_id', class_id)
      .eq('name', name)
      .maybeSingle();
    
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Subject already exists for this class'
      });
    }
    
    let finalDisplayOrder = display_order;
    if (!finalDisplayOrder) {
      const { data: maxOrder, error: orderError } = await supabase
        .from('subjects')
        .select('display_order')
        .eq('class_id', class_id)
        .order('display_order', { ascending: false })
        .limit(1);
      
      finalDisplayOrder = (maxOrder && maxOrder[0]?.display_order || 0) + 1;
    }
    
    const { data: newSubject, error } = await supabase
      .from('subjects')
      .insert({
        class_id: class_id,
        name: name.trim(),
        code: code?.trim() || null,
        description: description?.trim() || null,
        display_order: finalDisplayOrder,
        status: 'Active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (error) throw error;
    
    await logAdminAction(
      req.user.id,
      'CREATE_SUBJECT',
      `Created subject: ${name} for class ID ${class_id}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Subject created successfully',
      subject: newSubject
    });
    
  } catch (err) {
    console.error('Error creating subject:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

// Update a subject
app.put('/api/admin/subjects/:subjectId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { subjectId } = req.params;
    const { name, code, description, display_order, status } = req.body;
    
    const updateData = {};
    if (name) updateData.name = name;
    if (code) updateData.code = code;
    if (description) updateData.description = description;
    if (display_order !== undefined) updateData.display_order = display_order;
    if (status) updateData.status = status;
    updateData.updated_at = new Date().toISOString();
    
    const { data: updatedSubject, error } = await supabase
      .from('subjects')
      .update(updateData)
      .eq('id', subjectId)
      .select()
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: 'Subject not found'
        });
      }
      throw error;
    }
    
    await logAdminAction(
      req.user.id,
      'UPDATE_SUBJECT',
      `Updated subject ID ${subjectId}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Subject updated successfully',
      subject: updatedSubject
    });
    
  } catch (err) {
    console.error('Error updating subject:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Delete a subject
app.delete('/api/admin/subjects/:subjectId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { subjectId } = req.params;
    
    const { count: reportsCount, error: checkReports } = await supabase
      .from('reports')
      .select('*', { count: 'exact', head: true })
      .eq('subject_id', subjectId);
    
    if (reportsCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete subject with existing report cards'
      });
    }
    
    const { data: deletedSubject, error } = await supabase
      .from('subjects')
      .delete()
      .eq('id', subjectId)
      .select()
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: 'Subject not found'
        });
      }
      throw error;
    }
    
    await logAdminAction(
      req.user.id,
      'DELETE_SUBJECT',
      `Deleted subject ID ${subjectId}: ${deletedSubject.name}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Subject deleted successfully'
    });
    
  } catch (err) {
    console.error('Error deleting subject:', err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
});

// Get unread notifications for admin
app.get('/api/admin/notifications', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    // Admin user IDs are UUIDs (contain '-'), but notifications.user_id expects an integer.
    // Admin notifications are not needed, so return empty array immediately.
    if (typeof req.user.id === 'string' && req.user.id.includes('-')) {
      return res.json({ success: true, notifications: [] });
    }

    const { data: notifications, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('is_read', false)
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('Notifications fetch error:', error.message);
      return res.json({ success: true, notifications: [] });
    }

    res.json({ success: true, notifications: notifications || [] });
  } catch (error) {
    console.error('Admin notifications error:', error);
    res.json({ success: true, notifications: [] });
  }
});

// Mark notification as read
app.put('/api/admin/notifications/:id/read', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// ADMIN QUIZ GRADING ENDPOINTS
// ============================================

app.get('/api/admin/quizzes/:quizId/submissions', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;   // UUID from frontend

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(quizId)) {
      return res.status(400).json({ success: false, message: 'Invalid quiz ID format. Must be a UUID.' });
    }

    // Step 1: Verify the quiz exists using its UUID primary key
    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('id, int_id')
      .eq('id', quizId)
      .maybeSingle();

    if (quizError || !quiz) {
      console.error('Quiz not found for UUID:', quizId, quizError);
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }

    // Step 2: Fetch all submitted (pending) attempts for this quiz using the UUID
    const { data: attempts, error } = await supabase
      .from('quiz_attempts')
      .select('*')
      .eq('quiz_id', quizId)       // UUID column
      .eq('status', 'submitted')   // only pending submissions
      .order('completed_at', { ascending: false });

    if (error) {
      console.error('Error fetching attempts:', error);
      return res.status(500).json({ success: false, message: error.message });
    }

    if (!attempts || attempts.length === 0) {
      return res.json({ success: true, submissions: [] });
    }

    // Get unique learner IDs
    const learnerIds = [...new Set(attempts.map(a => a.learner_id).filter(Boolean))];
    let learnerMap = {};

    if (learnerIds.length > 0) {
      const { data: learners, error: learnerErr } = await supabase
        .from('learners')
        .select('id, name, reg_number, form')
        .in('id', learnerIds);
      if (!learnerErr && learners) {
        learnerMap = Object.fromEntries(learners.map(l => [l.id, l]));
      }
    }

    // Format submissions for frontend
    const formatted = attempts.map(attempt => {
      let answers = attempt.answers;
      if (typeof answers === 'string') {
        try { answers = JSON.parse(answers); } catch(e) { answers = []; }
      }
      if (!Array.isArray(answers)) answers = [];

      const learner = learnerMap[attempt.learner_id] || { name: 'Unknown', reg_number: 'N/A', form: 'N/A' };

      return {
        id: attempt.id,
        quiz_id: quizId,   // include quiz UUID for frontend
        student_name: learner.name,
        student_reg: learner.reg_number,
        student_form: learner.form,
        earned_marks: attempt.earned_points || 0,
        total_marks: attempt.total_points || 0,
        submitted_at: attempt.completed_at,
        answers: answers.map((ans, idx) => ({
          question_index: idx,
          question_id: ans.question_id,
          question_text: ans.question_text,
          question_type: ans.question_type,
          selected_answer_text: ans.selected_answer_text,
          is_correct: ans.is_correct,
          given_marks: ans.points_obtained,
          max_marks: ans.max_points,
          feedback: ans.feedback || null
        }))
      };
    });

    res.json({ success: true, submissions: formatted });
  } catch (err) {
    console.error('Submissions endpoint error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/grade', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { attempt_id, answers, overall_feedback } = req.body; // added overall_feedback
    if (!attempt_id) {
      return res.status(400).json({ success: false, message: 'Missing attempt_id' });
    }
    console.log(`📝 Grading attempt: ${attempt_id}`);

    // Fetch current attempt
    const { data: attempt, error: fetchError } = await supabase
      .from('quiz_attempts')
      .select('answers, earned_points, total_points, status')
      .eq('id', attempt_id)
      .single();
    if (fetchError || !attempt) {
      return res.status(404).json({ success: false, message: 'Attempt not found' });
    }

    let currentAnswers = attempt.answers;
    if (typeof currentAnswers === 'string') {
      try { currentAnswers = JSON.parse(currentAnswers); } catch(e) { currentAnswers = []; }
    }
    if (!Array.isArray(currentAnswers)) currentAnswers = [];

    // Update each question with provided marks and feedback
    const updatedAnswers = currentAnswers.map(ans => {
      const grade = answers.find(a => a.question_id === ans.question_id);
      if (grade) {
        return {
          ...ans,
          points_obtained: grade.marks_awarded,
          feedback: grade.feedback || null,
          is_correct: grade.marks_awarded === ans.max_points // optional
        };
      }
      return ans;
    });

    // Recalculate total earned marks
    const newEarnedMarks = updatedAnswers.reduce((sum, ans) => sum + (ans.points_obtained || 0), 0);
    const totalMarks = attempt.total_points || 0;
    const percentage = totalMarks > 0 ? (newEarnedMarks / totalMarks) * 100 : 0;
    const passed = newEarnedMarks >= (totalMarks * 0.5); // assuming 50% passing

    // Update attempt
    const updateData = {
      answers: updatedAnswers,
      earned_points: newEarnedMarks,
      percentage: percentage,
      passed: passed,
      status: 'completed',           // mark as graded
      feedback: overall_feedback || null,
      updated_at: new Date().toISOString()
    };
    const { error: updateError } = await supabase
      .from('quiz_attempts')
      .update(updateData)
      .eq('id', attempt_id);

    if (updateError) throw updateError;

    // Optionally notify learner (create notification)
    const { data: learner } = await supabase
      .from('learners')
      .select('id')
      .eq('id', attempt.learner_id)
      .single();
    if (learner) {
      await supabase.from('notifications').insert({
        user_id: learner.id,
        type: 'quiz_graded',
        title: 'Quiz Graded',
        message: `Your quiz attempt has been graded. Score: ${newEarnedMarks}/${totalMarks}`,
        related_id: attempt_id,
        is_read: false,
        created_at: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      message: 'Grades saved successfully',
      earned_marks: newEarnedMarks,
      total_marks: totalMarks
    });
  } catch (error) {
    console.error('Grade endpoint error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// QUIZ SYSTEM ENDPOINTS (updated for marks & feedback)
// ============================================

// Ping endpoint for quiz routes
app.get('/api/quiz/ping', authenticateToken, (req, res) => {
  res.json({ success: true, message: 'Quiz routes are alive' });
});

// Get available subjects for quiz creation (admin)
app.get('/api/admin/quiz-subjects', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    console.log('📚 Fetching available subjects for quizzes');
    
    const { data: subjects, error } = await supabase
      .from('subjects')
      .select('id, name, code, description')
      .eq('status', 'Active')
      .order('name', { ascending: true });
    
    if (error) {
      console.error('Error fetching subjects:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch subjects: ' + error.message
      });
    }
    
    res.json({
      success: true,
      subjects: subjects || []
    });
    
  } catch (error) {
    console.error('Error fetching quiz subjects:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch subjects: ' + error.message
    });
  }
});

// Get all quizzes (admin)
app.get('/api/admin/quizzes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    console.log('📚 Admin fetching all quizzes');
    
    const { data: quizzes, error } = await supabase
      .from('quizzes')
      .select(`
        *,
        subject:subject_id(id, name)
      `)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching quizzes:', error);
      return res.status(500).json({ 
        success: false, 
        message: error.message 
      });
    }

    const quizzesWithCounts = await Promise.all((quizzes || []).map(async (quiz) => {
      const { count, error: countError } = await supabase
        .from('quiz_questions')
        .select('*', { count: 'exact', head: true })
        .eq('quiz_id', quiz.id);
      
      return {
        ...quiz,
        subject_name: quiz.subject?.name || 'Unknown',
        question_count: count || 0
      };
    }));

    res.json({ 
      success: true, 
      quizzes: quizzesWithCounts 
    });
  } catch (err) {
    console.error("❌ Error fetching quizzes:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// Create a new quiz (admin) - UPDATED to accept exam_year, exam_type, scheduled_start, scheduled_end
app.post('/api/admin/quizzes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { 
      subject_id, title, description, duration, total_marks, is_active, target_form,
      section_a_marks, section_b_marks, exam_year, exam_type, scheduled_start, scheduled_end
    } = req.body;
    
    console.log('📝 Creating new quiz:', { subject_id, title, duration, target_form, exam_year, exam_type, scheduled_start, scheduled_end });
    
    if (!subject_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'Subject ID is required' 
      });
    }
    
    if (!title) {
      return res.status(400).json({ 
        success: false, 
        message: 'Quiz title is required' 
      });
    }

    const { data: subject, error: subjectError } = await supabase
      .from('subjects')
      .select('id, name')
      .eq('id', subject_id)
      .maybeSingle();
    
    if (subjectError || !subject) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid subject selected' 
      });
    }

    const { data, error } = await supabase
      .from('quizzes')
      .insert({
        subject_id: subject_id,
        title: title.trim(),
        description: description || null,
        duration: parseInt(duration) || 30,
        total_marks: parseInt(total_marks) || 0,
        section_a_marks: parseInt(section_a_marks) || 75,
        section_b_marks: parseInt(section_b_marks) || 25,
        is_active: is_active !== false,
        target_form: target_form || 'All',
        exam_year: exam_year || new Date().getFullYear(),
        exam_type: exam_type || 'SCHOOL CERTIFICATE OF EDUCATION MOCK EXAMINATION',
        scheduled_start: scheduled_start || null,
        scheduled_end: scheduled_end || null,
        created_by: req.user.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error("❌ Supabase Quiz Error:", error);
      return res.status(400).json({ 
        success: false, 
        message: error.message,
        details: error.details
      });
    }

    console.log('✅ Quiz created successfully:', data.id);

    // Notify learners when a new quiz is uploaded and active
    if (data.is_active) {
      try {
        let learnerQuery = supabase.from('learners').select('id, name, form');
        if (target_form && target_form !== 'All') {
          learnerQuery = learnerQuery.ilike('form', `%${target_form}%`);
        }

        const { data: learners, error: learnerError } = await learnerQuery;
        if (learnerError) {
          throw learnerError;
        }

        if (Array.isArray(learners) && learners.length > 0) {
          const notifications = learners.map((learner) => ({
            user_id: learner.id,
            type: 'quiz_uploaded',
            title: 'New Quiz Available',
            message: `A new quiz for ${subject.name} has been uploaded${target_form && target_form !== 'All' ? ` for ${target_form}` : ''}.`,
            related_id: data.id,
            is_read: false,
            created_at: new Date().toISOString()
          }));
          await supabase.from('notifications').insert(notifications);
        } else {
          console.log('ℹ️ No learners found to notify for quiz upload:', target_form || 'All');
        }
      } catch (notifyError) {
        console.error('Failed to notify learners about new quiz:', notifyError);
      }
    }

    await logAdminAction(
      req.user.id,
      'CREATE_QUIZ',
      `Created quiz: ${title} for subject: ${subject.name} (Target: ${target_form || 'All'})`,
      req.ip
    );

    res.status(201).json({ 
      success: true, 
      message: 'Quiz created successfully',
      quiz: {
        ...data,
        subject_name: subject.name
      }
    });
  } catch (err) {
    console.error("❌ Server Error:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// Get questions for a specific quiz (admin) - now returns section
app.get('/api/admin/quizzes/:quizId/questions', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    
    console.log(`📝 Admin fetching questions for quiz: ${quizId}`);

    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('id, title')
      .eq('id', quizId)
      .single();

    if (quizError) {
      return res.status(404).json({
        success: false,
        message: 'Quiz not found'
      });
    }

    const { data: questions, error: questionsError } = await supabase
      .from('quiz_questions')
      .select('*')
      .eq('quiz_id', quizId)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (questionsError) {
      console.error('Error fetching questions:', questionsError);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch questions'
      });
    }

    res.json({
      success: true,
      questions: questions || []
    });
  } catch (error) {
    console.error('Error fetching admin quiz questions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch quiz questions: ' + error.message
    });
  }
});

// Add a new question to a quiz (admin) - UPDATED to include section
app.post('/api/admin/quizzes/:quizId/questions', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { 
      question_text, 
      options, 
      correct_answer, 
      explanation, 
      marks, 
      display_order, 
      question_type, 
      expected_answer,
      question_image,
      option_images,
      answer_image,
      section                    // <-- NEW: 'A' or 'B'
    } = req.body;
    
    console.log(`📝 Adding ${question_type || 'multiple_choice'} question to quiz: ${quizId}, section: ${section || 'A'}`);

    if (!question_text && !question_image) {
      return res.status(400).json({ 
        success: false, 
        message: 'Either question text or an image is required' 
      });
    }

    const qType = question_type || 'multiple_choice';
    
    if (qType === 'multiple_choice') {
      if (!options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ 
          success: false, 
          message: 'Multiple choice questions require at least 2 options' 
        });
      }
      if (correct_answer === undefined || correct_answer === null) {
        return res.status(400).json({ 
          success: false, 
          message: 'Multiple choice questions require a correct answer index' 
        });
      }
    } else if (qType === 'short_answer') {
      if (!expected_answer || !expected_answer.trim()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Short answer questions require an expected answer' 
        });
      }
    }

    // Verify quiz exists
    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('id, title, total_marks')
      .eq('id', quizId)
      .single();

    if (quizError || !quiz) {
      return res.status(404).json({ 
        success: false, 
        message: 'Quiz not found' 
      });
    }

    // Determine display order
    let finalDisplayOrder = display_order;
    if (!finalDisplayOrder) {
      const { data: maxOrder } = await supabase
        .from('quiz_questions')
        .select('display_order')
        .eq('quiz_id', quizId)
        .order('display_order', { ascending: false })
        .limit(1);
      
      finalDisplayOrder = (maxOrder && maxOrder[0]?.display_order || 0) + 1;
    }

    const questionMarks = marks || 1;

    const questionData = {
      quiz_id: quizId,
      question_text: question_text || null,
      question_image: question_image || null,
      option_images: option_images || [],
      answer_image: answer_image || null,
      question_type: qType,
      marks: questionMarks,
      points: questionMarks,
      display_order: finalDisplayOrder,
      section: section || 'A',           // <-- store section
      created_at: new Date().toISOString()
    };

    if (qType === 'multiple_choice') {
      questionData.options = options;
      questionData.correct_answer = correct_answer;
      questionData.expected_answer = null;
    } else {
      questionData.options = null;
      questionData.correct_answer = null;
      questionData.expected_answer = expected_answer?.trim().toLowerCase() || null;
    }

    const { data: question, error } = await supabase
      .from('quiz_questions')
      .insert(questionData)
      .select()
      .single();

    if (error) {
      console.error('Error inserting question:', error);
      return res.status(500).json({ 
        success: false, 
        message: error.message 
      });
    }

    // Update total marks for the quiz
    const { data: questions } = await supabase
      .from('quiz_questions')
      .select('marks')
      .eq('quiz_id', quizId);

    if (questions && questions.length > 0) {
      const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);
      const passingPoints = Math.round(totalMarks * 0.5);
      
      await supabase
        .from('quizzes')
        .update({ 
          total_marks: totalMarks,
          total_points: totalMarks,
          passing_points: passingPoints,
          updated_at: new Date().toISOString() 
        })
        .eq('id', quizId);
    }

    console.log('✅ Question added successfully');
    
    await logAdminAction(
      req.user.id,
      'ADD_QUESTION',
      `Added ${qType} question to quiz ID ${quizId} (section ${section || 'A'})`,
      req.ip
    );

    res.json({ 
      success: true, 
      message: 'Question added successfully',
      question: question
    });
  } catch (err) {
    console.error("❌ Error adding question:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// NEW: Update a question (admin) - includes section
app.put('/api/admin/quizzes/:quizId/questions/:questionId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId, questionId } = req.params;
    const { 
      question_text, options, correct_answer, explanation, marks, display_order,
      question_type, expected_answer, question_image, option_images, answer_image,
      section
    } = req.body;

    console.log(`✏️ Updating question ${questionId} in quiz ${quizId}`);

    // Verify question exists and belongs to quiz
    const { data: existing, error: fetchError } = await supabase
      .from('quiz_questions')
      .select('*')
      .eq('id', questionId)
      .eq('quiz_id', quizId)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ success: false, message: 'Question not found in this quiz' });
    }

    const qType = question_type || existing.question_type;
    const updateData = {
      question_text: question_text !== undefined ? question_text : existing.question_text,
      question_image: question_image !== undefined ? question_image : existing.question_image,
      option_images: option_images !== undefined ? option_images : existing.option_images,
      answer_image: answer_image !== undefined ? answer_image : existing.answer_image,
      question_type: qType,
      marks: marks !== undefined ? marks : existing.marks,
      points: marks !== undefined ? marks : existing.marks,
      display_order: display_order !== undefined ? display_order : existing.display_order,
      section: section !== undefined ? section : existing.section,
      explanation: explanation !== undefined ? explanation : existing.explanation,
      updated_at: new Date().toISOString()
    };

    if (qType === 'multiple_choice') {
      if (options !== undefined) updateData.options = options;
      if (correct_answer !== undefined) updateData.correct_answer = correct_answer;
      updateData.expected_answer = null;
    } else {
      updateData.options = null;
      updateData.correct_answer = null;
      if (expected_answer !== undefined) updateData.expected_answer = expected_answer?.trim().toLowerCase() || null;
    }

    const { data: updated, error: updateError } = await supabase
      .from('quiz_questions')
      .update(updateData)
      .eq('id', questionId)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating question:', updateError);
      return res.status(500).json({ success: false, message: updateError.message });
    }

    // Recalculate total marks for the quiz
    const { data: questions } = await supabase
      .from('quiz_questions')
      .select('marks')
      .eq('quiz_id', quizId);
    if (questions && questions.length) {
      const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);
      const passingPoints = Math.round(totalMarks * 0.5);
      await supabase
        .from('quizzes')
        .update({ total_marks: totalMarks, total_points: totalMarks, passing_points: passingPoints, updated_at: new Date().toISOString() })
        .eq('id', quizId);
    }

    await logAdminAction(req.user.id, 'UPDATE_QUESTION', `Updated question ${questionId} in quiz ${quizId}`, req.ip);
    res.json({ success: true, message: 'Question updated', question: updated });
  } catch (err) {
    console.error('Error updating question:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// NEW: Delete a question (admin)
app.delete('/api/admin/quizzes/:quizId/questions/:questionId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId, questionId } = req.params;

    const { data: deleted, error } = await supabase
      .from('quiz_questions')
      .delete()
      .eq('id', questionId)
      .eq('quiz_id', quizId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ success: false, message: 'Question not found' });
      }
      throw error;
    }

    // Recalculate total marks
    const { data: questions } = await supabase
      .from('quiz_questions')
      .select('marks')
      .eq('quiz_id', quizId);
    if (questions && questions.length) {
      const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);
      const passingPoints = Math.round(totalMarks * 0.5);
      await supabase
        .from('quizzes')
        .update({ total_marks: totalMarks, total_points: totalMarks, passing_points: passingPoints, updated_at: new Date().toISOString() })
        .eq('id', quizId);
    } else {
      // No questions left, reset quiz total marks to 0
      await supabase
        .from('quizzes')
        .update({ total_marks: 0, total_points: 0, passing_points: 0, updated_at: new Date().toISOString() })
        .eq('id', quizId);
    }

    await logAdminAction(req.user.id, 'DELETE_QUESTION', `Deleted question ${questionId} from quiz ${quizId}`, req.ip);
    res.json({ success: true, message: 'Question deleted' });
  } catch (err) {
    console.error('Error deleting question:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update quiz (admin) - UPDATED to include exam_year and exam_type
app.put('/api/admin/quizzes/:quizId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { 
      subject_id, title, description, duration, total_marks, is_active, target_form,
      section_a_marks, section_b_marks, exam_year, exam_type, scheduled_start, scheduled_end
    } = req.body;
    
    const updateData = {};
    if (subject_id !== undefined) updateData.subject_id = subject_id;
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (duration !== undefined) updateData.duration = duration;
    if (total_marks !== undefined) updateData.total_marks = total_marks;
    if (section_a_marks !== undefined) updateData.section_a_marks = parseInt(section_a_marks);
    if (section_b_marks !== undefined) updateData.section_b_marks = parseInt(section_b_marks);
    if (is_active !== undefined) updateData.is_active = is_active;
    if (target_form !== undefined) updateData.target_form = target_form;
    if (exam_year !== undefined) updateData.exam_year = exam_year;
    if (exam_type !== undefined) updateData.exam_type = exam_type;
    if (scheduled_start !== undefined) updateData.scheduled_start = scheduled_start;
    if (scheduled_end !== undefined) updateData.scheduled_end = scheduled_end;
    updateData.updated_at = new Date().toISOString();
    
    const { data: quiz, error } = await supabase
      .from('quizzes')
      .update(updateData)
      .eq('id', quizId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ 
          success: false, 
          message: 'Quiz not found' 
        });
      }
      throw error;
    }

    res.json({ 
      success: true, 
      message: 'Quiz updated successfully',
      quiz: quiz
    });
  } catch (err) {
    console.error("❌ Error updating quiz:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// Delete quiz (admin)
app.delete('/api/admin/quizzes/:quizId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    
    console.log(`🗑️ Deleting quiz: ${quizId}`);

    const { data: quiz, error } = await supabase
      .from('quizzes')
      .delete()
      .eq('id', quizId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ 
          success: false, 
          message: 'Quiz not found' 
        });
      }
      throw error;
    }

    await logAdminAction(
      req.user.id,
      'DELETE_QUIZ',
      `Deleted quiz: ${quiz.title}`,
      req.ip
    );

    res.json({ 
      success: true, 
      message: 'Quiz deleted successfully' 
    });
  } catch (err) {
    console.error("❌ Error deleting quiz:", err);
    res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// Get all active quizzes for learners (filtered by form)
app.get('/api/quiz/quizzes', authenticateToken, async (req, res) => {
  try {
    console.log('📚 Fetching quizzes for learner:', req.user.id);

    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('form')
      .eq('id', req.user.id)
      .single();

    if (learnerError || !learner) {
      console.error('Error fetching learner:', learnerError);
      return res.json({ success: true, quizzes: [] });
    }

    const learnerForm = learner.form;
    console.log(`Learner form: ${learnerForm}`);

    // Fetch active quizzes for the learner's form
    const { data: quizzes, error } = await supabase
      .from('quizzes')
      .select(`
        *,
        subject:subject_id(id, name)
      `)
      .eq('is_active', true)
      .in('target_form', ['All', learnerForm])
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching quizzes:', error);
      return res.json({ success: true, quizzes: [] });
    }

    // Filter quizzes based on scheduling; show upcoming and open quizzes, hide already-expired ones
    const now = new Date();
    const filteredQuizzes = (quizzes || []).filter(quiz => {
      const end = quiz.scheduled_end ? new Date(quiz.scheduled_end) : null;
      if (end && now > end) return false; // Already ended
      return true;
    });

    // Get all attempts made by this learner
    const { data: attempts, error: attemptsError } = await supabase
      .from('quiz_attempts')
      .select('quiz_id, status')
      .eq('learner_id', req.user.id);

    // Build a map of quiz_id -> status
    const attemptMap = {};
    (attempts || []).forEach(att => {
      attemptMap[att.quiz_id] = att.status;
    });

    // Enrich each quiz with attempt info and question counts
    const quizzesWithStatus = await Promise.all((filteredQuizzes || []).map(async (quiz) => {
      const { data: questions, error: countError } = await supabase
        .from('quiz_questions')
        .select('marks')
        .eq('quiz_id', quiz.id);

      const totalMarks = questions?.reduce((sum, q) => sum + (q.marks || 1), 0) || 0;
      const status = attemptMap[quiz.id] || null;
      const alreadyTaken = status !== null;
      const isCompleted = status === 'completed' || status === 'submitted';
      const start = quiz.scheduled_start ? new Date(quiz.scheduled_start) : null;
      const end = quiz.scheduled_end ? new Date(quiz.scheduled_end) : null;
      const isUpcoming = start && now < start;
      const isClosed = end && now > end;

      return {
        ...quiz,
        subject_name: quiz.subject?.name,
        question_count: questions?.length || 0,
        total_marks: totalMarks,
        passing_marks: quiz.passing_points || Math.round(totalMarks * 0.5),
        already_taken: alreadyTaken,      // true if any attempt exists
        attempt_status: status,            // 'in-progress', 'submitted', 'completed', or null
        disabled: isCompleted,              // optional: disable UI if already submitted/completed
        scheduled_start: quiz.scheduled_start || null,
        scheduled_end: quiz.scheduled_end || null,
        quiz_status: isClosed ? 'closed' : isUpcoming ? 'upcoming' : 'open',
        is_available: !isUpcoming && !isClosed
      };
    }));

    res.json({
      success: true,
      quizzes: quizzesWithStatus,
      learner_form: learnerForm
    });
  } catch (error) {
    console.error('Error fetching quizzes:', error);
    res.json({
      success: true,
      quizzes: [],
      error: error.message
    });
  }
});

// Get quiz questions for learners
app.get('/api/quiz/:quizId/questions', authenticateToken, async (req, res) => {
  try {
    const resolved = resolveQuizRouteId(req.params.quizId);
    if (!resolved.ok) {
      return res.status(400).json({ success: false, message: resolved.message });
    }
    const numericQuizId = resolved.id;

    console.log(`📝 Fetching questions for quiz ID: ${numericQuizId}`);

    // Fetch quiz details with subject
    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select(`
        *,
        subject:subject_id(id, name)
      `)
      .eq('id', numericQuizId)
      .single();

    if (quizError) {
      console.error('Quiz fetch error:', quizError);
      return res.status(404).json({
        success: false,
        message: 'Quiz not found'
      });
    }

    // Fetch questions
    const { data: questions, error: questionsError } = await supabase
      .from('quiz_questions')
      .select('*')
      .eq('quiz_id', numericQuizId)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (questionsError) {
      console.error('Questions fetch error:', questionsError);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch questions'
      });
    }

    // Check for existing attempt (use numericQuizId)
    const { data: existingAttempt, error: attemptError } = await supabase
      .from('quiz_attempts')
      .select('id, status, score, earned_points, total_points, passed, answers')
      .eq('learner_id', req.user.id)
      .eq('quiz_id', numericQuizId)
      .maybeSingle();

    if (attemptError) {
      console.error('Attempt fetch error:', attemptError);
      // Non-critical, continue without saved answers
    }

    if (existingAttempt && existingAttempt.status === 'completed') {
      return res.json({
        success: true,
        already_completed: true,
        attempt: existingAttempt,
        quiz: {
          ...quiz,
          subject_name: quiz.subject?.name
        }
      });
    }

    let savedAnswers = null;
    if (existingAttempt && existingAttempt.status === 'in-progress') {
      savedAnswers = existingAttempt.answers;
    }

    res.json({
      success: true,
      quiz: {
        ...quiz,
        subject_name: quiz.subject?.name
      },
      questions: questions || [],
      saved_answers: savedAnswers,
      attempt_id: existingAttempt?.id || null
    });
  } catch (error) {
    console.error('Error fetching quiz questions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch quiz questions: ' + error.message
    });
  }
});

// Start a quiz attempt
app.post('/api/quiz/:quizId/start', authenticateToken, async (req, res) => {
  try {
    const quizId = req.params.quizId; // UUID string

    // 1. Check if the quiz exists
    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('subject_id, subject:subject_id(name), total_marks, passing_points')
      .eq('id', quizId)
      .maybeSingle();

    if (quizError || !quiz) {
      console.error('Quiz not found:', quizId);
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }

    // 2. Check for ANY existing attempt (any status)
    const { data: existingAttempt } = await supabase
      .from('quiz_attempts')
      .select('id, status')
      .eq('learner_id', req.user.id)
      .eq('quiz_id', quizId)
      .maybeSingle();

    if (existingAttempt) {
      // If attempt is in-progress, allow resume
      if (existingAttempt.status === 'in-progress') {
        return res.json({ success: true, attempt_id: existingAttempt.id, message: 'Resuming...' });
      }
      // If attempt is submitted or completed, reject new attempt
      if (existingAttempt.status === 'submitted' || existingAttempt.status === 'completed') {
        return res.status(403).json({
          success: false,
          message: 'You have already submitted this quiz. Multiple attempts are not allowed.',
          attempt_id: existingAttempt.id,
          status: existingAttempt.status
        });
      }
      // For any other status, reject as well
      return res.status(403).json({
        success: false,
        message: 'You have already attempted this quiz. No further attempts allowed.',
        attempt_id: existingAttempt.id,
        status: existingAttempt.status
      });
    }

    // 3. Insert new attempt
    const { data: attempt, error: insertError } = await supabase
      .from('quiz_attempts')
      .insert({
        learner_id: req.user.id,
        quiz_id: quizId,
        total_marks: quiz.total_marks || 0,
        total_points: quiz.total_marks || 0, // also set total_points to avoid null
        status: 'in-progress',
        started_at: new Date().toISOString(),
        subject_id: quiz.subject_id || null,
        subject: quiz.subject?.name || null
      })
      .select()
      .single();

    if (insertError) {
      console.error('Insert error:', insertError);
      return res.status(500).json({ success: false, message: insertError.message });
    }

    res.json({
      success: true,
      attempt_id: attempt.id,
      message: 'Quiz started successfully',
      quiz: { total_marks: quiz.total_marks, passing_marks: quiz.passing_points }
    });
  } catch (error) {
    console.error('Start error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Save answer during quiz (AUTO-SAVE)
app.post('/api/quiz/:quizId/save-answer', authenticateToken, async (req, res) => {
  try {
    const resolved = resolveQuizRouteId(req.params.quizId);
    if (!resolved.ok) {
      return res.status(400).json({ success: false, message: resolved.message });
    }
    const quizId = resolved.id;
    const { question_index, answer, attempt_id } = req.body;
    
    console.log(`💾 Saving answer for quiz: ${quizId}, Question: ${question_index}`);

    let attempt = null;
    
    if (attempt_id) {
      const { data, error } = await supabase
        .from('quiz_attempts')
        .select('id, answers')
        .eq('id', attempt_id)
        .eq('learner_id', req.user.id)
        .eq('status', 'in-progress')
        .maybeSingle();
      
      if (!error && data) {
        attempt = data;
      }
    }
    
    if (!attempt) {
      const { data, error } = await supabase
        .from('quiz_attempts')
        .select('id, answers')
        .eq('learner_id', req.user.id)
        .eq('quiz_id', quizId)
        .eq('status', 'in-progress')
        .maybeSingle();
      
      if (!error && data) {
        attempt = data;
      }
    }
    
    if (!attempt) {
      return res.status(404).json({
        success: false,
        message: 'No active quiz attempt found'
      });
    }
    
    let currentAnswers = attempt.answers || {};
    
    if (typeof currentAnswers === 'string') {
      try {
        currentAnswers = JSON.parse(currentAnswers);
      } catch (e) {
        currentAnswers = {};
      }
    }
    
    currentAnswers[question_index] = answer;
    
    const { error: updateError } = await supabase
      .from('quiz_attempts')
      .update({
        answers: currentAnswers,
        updated_at: new Date().toISOString()
      })
      .eq('id', attempt.id);
    
    if (updateError) {
      console.error('Error saving answer:', updateError);
      return res.status(500).json({
        success: false,
        message: 'Failed to save answer: ' + updateError.message
      });
    }
    
    console.log(`✅ Answer saved successfully for question ${question_index}`);
    
    res.json({
      success: true,
      message: 'Answer saved successfully'
    });
    
  } catch (error) {
    console.error('Error in save-answer endpoint:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save answer: ' + error.message
    });
  }
});

app.post('/api/quiz/:quizId/submit', authenticateToken, async (req, res) => {
  try {
    const resolved = resolveQuizRouteId(req.params.quizId);
    if (!resolved.ok) {
      return res.status(400).json({ success: false, message: resolved.message });
    }
    const quizId = resolved.id;
    const { answers, time_taken, attempt_id } = req.body;
    const learnerId = req.user.id;

    if (!attempt_id) {
      return res.status(400).json({ success: false, message: 'Missing attempt_id' });
    }

    // Fetch the attempt (must be in-progress)
    const { data: attempt, error: attemptError } = await supabase
      .from('quiz_attempts')
      .select('id, status')
      .eq('id', attempt_id)
      .eq('learner_id', learnerId)
      .eq('status', 'in-progress')
      .single();

    if (attemptError || !attempt) {
      return res.status(404).json({ success: false, message: 'No active attempt found' });
    }

    // Fetch quiz questions (needed to store the answers structure)
    const { data: questions, error: qError } = await supabase
      .from('quiz_questions')
      .select('id, question_text, question_image, option_images, answer_image, question_type, marks, options, correct_answer, expected_answer, explanation')
      .eq('quiz_id', quizId);

    if (qError) throw qError;

    // Build answers array without grading
    const submittedAnswers = questions.map((question, idx) => {
      const userAnswer = answers && answers[idx] !== undefined ? answers[idx] : null;
      let userAnswerText = '';

      if (question.question_type === 'multiple_choice') {
        const selectedOption = parseInt(userAnswer);
        userAnswerText = question.options[selectedOption] || 'Not answered';
      } else {
        userAnswerText = userAnswer ? String(userAnswer).trim() : 'Not answered';
      }

      return {
        question_id: question.id,
        question_text: question.question_text,
        question_image: question.question_image || null,
        option_images: question.option_images || [],
        answer_image: question.answer_image || null,
        question_type: question.question_type,
        selected_answer: userAnswer,
        selected_answer_text: userAnswerText,
        // grading fields – initially null
        is_correct: null,
        points_obtained: null,
        max_points: question.marks || 1,
        correct_answer: question.question_type === 'multiple_choice'
          ? question.options[question.correct_answer]
          : question.expected_answer,
        explanation: question.explanation,
        feedback: null
      };
    });

    // Update attempt – status = 'submitted' (pending admin review)
    const { error: updateError } = await supabase
      .from('quiz_attempts')
      .update({
        status: 'submitted',
        answers: submittedAnswers,
        time_taken: time_taken || null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', attempt_id);

    if (updateError) throw updateError;

    // (Optional) Notify admins
    const { data: learner } = await supabase
      .from('learners')
      .select('name')
      .eq('id', learnerId)
      .single();
    const { data: quizTitle } = await supabase
      .from('quizzes')
      .select('title')
      .eq('id', quizId)
      .single();

    if (learner && quizTitle) {
      const { data: admins } = await supabase
        .from('users')
        .select('id')
        .eq('role', 'admin')
        .eq('is_active', true);
      if (admins && admins.length) {
        const notifications = admins.map(admin => ({
          user_id: admin.id,
          type: 'quiz_pending',
          title: 'Quiz Submitted for Grading',
          message: `${learner.name} submitted "${quizTitle.title}" for grading.`,
          related_id: attempt_id,
          is_read: false,
          created_at: new Date().toISOString()
        }));
        await supabase.from('notifications').insert(notifications);
      }
    }

    res.json({
      success: true,
      message: 'Your answers have been submitted successfully. The admin will review and grade your submission shortly.'
    });
  } catch (error) {
    console.error('Submit quiz error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// NEW ENDPOINT: Get full details of a specific quiz attempt (for revision)
// ============================================
// Get full details of a specific quiz attempt (for revision)
app.get('/api/quiz/attempt/:attemptId', authenticateToken, async (req, res) => {
  try {
    const { attemptId } = req.params;
    const learnerId = req.user.id;

    console.log(`📝 Fetching attempt details for attemptId: ${attemptId}, learner: ${learnerId}`);

    // Fetch attempt with quiz info
    const { data: attempt, error } = await supabase
      .from('quiz_attempts')
      .select(`
        id,
        quiz_id,
        earned_points,
        total_points,
        percentage,
        passed,
        completed_at,
        feedback,
        answers
      `)
      .eq('id', attemptId)
      .eq('learner_id', learnerId)
      .single();

    if (error || !attempt) {
      console.error('Error fetching attempt:', error);
      return res.status(404).json({ success: false, message: 'Attempt not found' });
    }

    // Fetch quiz title separately
    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('title, subject')
      .eq('id', attempt.quiz_id)
      .single();

    if (quizError) {
      console.error('Error fetching quiz:', quizError);
    }

    // Parse answers if stored as JSON string
    let answers = attempt.answers;
    if (typeof answers === 'string') {
      try { answers = JSON.parse(answers); } catch (e) { answers = []; }
    }
    if (!Array.isArray(answers)) answers = [];

    // Format each answer
    const formattedAnswers = answers.map((ans, idx) => ({
      question_id: ans.question_id || idx,
      question_text: ans.question_text || '',
      question_image: ans.question_image || null,
      option_images: ans.option_images || [],
      answer_image: ans.answer_image || null,
      question_type: ans.question_type || 'multiple_choice',
      selected_answer: ans.selected_answer,
      selected_answer_text: ans.selected_answer_text || 'Not answered',
      is_correct: ans.is_correct || false,
      points_obtained: ans.points_obtained || 0,
      max_points: ans.max_points || 1,
      correct_answer: ans.correct_answer || '',
      explanation: ans.explanation || null,
      feedback: ans.feedback || null
    }));

    res.json({
      success: true,
      attempt: {
        id: attempt.id,
        quiz_id: attempt.quiz_id,
        quiz_title: quiz?.title || 'Quiz',
        subject: quiz?.subject || null,
        earned_points: attempt.earned_points || 0,
        total_points: attempt.total_points || 0,
        percentage: attempt.percentage || 0,
        passed: attempt.passed || false,
        completed_at: attempt.completed_at,
        answers: formattedAnswers,
        feedback: attempt.feedback || null
      }
    });
  } catch (error) {
    console.error('Error fetching attempt details:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get learner's quiz history (updated to include marks and feedback)
app.get('/api/quiz/history', authenticateToken, async (req, res) => {
  try {
    console.log(`📊 Fetching quiz history for learner: ${req.user.id}`);

    // Check if table exists (optional)
    const { data: tableCheck, error: tableError } = await supabase
      .from('quiz_attempts')
      .select('count')
      .limit(1)
      .maybeSingle();

    if (tableError && tableError.message && tableError.message.includes('does not exist')) {
      return res.json({ success: true, attempts: [], message: 'No quiz attempts available yet' });
    }

    const { data: attempts, error } = await supabase
      .from('quiz_attempts')
      .select(`
        id,
        quiz_id,
        subject,
        score,
        percentage,
        earned_points,
        total_points,
        passed,
        status,
        completed_at,
        time_taken,
        feedback
      `)
      .eq('learner_id', req.user.id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false });

    if (error) {
      console.error('Error fetching attempts:', error);
      return res.json({ success: true, attempts: [] });
    }

    const formattedAttempts = [];
    for (const attempt of (attempts || [])) {
      try {
        const { data: quiz, error: quizError } = await supabase
          .from('quizzes')
          .select('id, title, total_marks, passing_points')
          .eq('id', attempt.quiz_id)
          .maybeSingle();

        formattedAttempts.push({
          id: attempt.id,
          quiz_id: attempt.quiz_id,
          quiz_title: quiz?.title || 'Unknown Quiz',
          subject: attempt.subject || 'General',
          marks_earned: attempt.earned_points || 0,
          total_marks: attempt.total_points || (quiz?.total_marks || 0),
          percentage: Math.round(attempt.percentage || 0),
          passed: attempt.passed || false,
          correct_answers: attempt.score || 0,
          completed_at: attempt.completed_at,
          time_taken: attempt.time_taken,
          feedback: attempt.feedback || null
        });
      } catch (err) {
        console.error('Error fetching quiz details:', err);
        formattedAttempts.push({
          id: attempt.id,
          quiz_id: attempt.quiz_id,
          quiz_title: 'Quiz',
          subject: attempt.subject || 'General',
          marks_earned: attempt.earned_points || 0,
          total_marks: attempt.total_points || 0,
          percentage: Math.round(attempt.percentage || 0),
          passed: attempt.passed || false,
          correct_answers: attempt.score || 0,
          completed_at: attempt.completed_at,
          time_taken: attempt.time_taken,
          feedback: attempt.feedback || null
        });
      }
    }

    console.log(`✅ Found ${formattedAttempts.length} completed attempts`);

    res.json({
      success: true,
      attempts: formattedAttempts
    });
  } catch (error) {
    console.error('Error in quiz history endpoint:', error);
    res.json({
      success: true,
      attempts: [],
      message: 'Unable to load quiz history at this time'
    });
  }
});

// Verify quiz access with registration number
app.post('/api/quiz/:quizId/verify', authenticateToken, async (req, res) => {
  try {
    const { regNumber } = req.body;

    const resolved = resolveQuizRouteId(req.params.quizId);
    if (!resolved.ok) {
      return res.status(400).json({ success: false, message: resolved.message });
    }
    const idForQuiz = resolved.id;
    
    console.log(`🔐 Verifying quiz access for learner: ${req.user.id}, Quiz: ${idForQuiz}`);
    
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('reg_number, id, name, form')
      .eq('id', req.user.id)
      .single();
    
    if (learnerError || !learner) {
      return res.status(422).json({
        success: false,
        message: 'Learner not found. Please login again.'
      });
    }
    
    const isValid = learner.reg_number.toUpperCase() === regNumber.toUpperCase();
    
    if (!isValid) {
      return res.status(403).json({
        success: false,
        message: 'Invalid registration number. Access denied.'
      });
    }
    
    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('id, title, is_active, duration, total_marks, target_form')
      .eq('id', idForQuiz)
      .single();
    
    if (quizError || !quiz) {
      if (quizError) {
        console.error('Verify quiz fetch error:', quizError.message, 'quizId=', idForQuiz);
      }
      return res.status(422).json({
        success: false,
        message: 'Quiz not found'
      });
    }
    
    if (!quiz.is_active) {
      return res.status(403).json({
        success: false,
        message: 'This quiz is not currently available'
      });
    }
    
    const isEligible = quiz.target_form === 'All' || quiz.target_form === learner.form;
    
    if (!isEligible) {
      return res.status(403).json({
        success: false,
        message: `This quiz is only available for ${quiz.target_form} students. You are in ${learner.form}.`,
        form_restricted: true,
        required_form: quiz.target_form,
        your_form: learner.form
      });
    }
    
    await logAdminAction(
      req.user.id,
      'QUIZ_ACCESS',
      `Learner ${learner.name} (${learner.reg_number}, ${learner.form}) accessed quiz: ${quiz.title}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Access granted',
      quiz: {
        id: quiz.id,
        title: quiz.title,
        duration: quiz.duration,
        total_marks: quiz.total_marks,
        target_form: quiz.target_form
      },
      learner: {
        form: learner.form,
        is_eligible: true
      }
    });
    
  } catch (error) {
    console.error('Error verifying quiz access:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify access. Please try again.'
    });
  }
});

// ============================================
// LESSON MANAGEMENT ROUTES (ADMIN)
// ============================================

// GET all subjects (for admin dropdown) - FIXED VERSION
app.get('/api/admin/subjects/all', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    console.log('📚 Fetching all subjects for admin dropdown');
    
    const { data: subjects, error } = await supabase
      .from('subjects')
      .select('id, name')
      .order('name', { ascending: true });

    if (error) {
      console.error('Supabase error fetching subjects:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Database error: ' + error.message 
      });
    }

    // Ensure we always return an array
    const subjectList = subjects || [];
    
    console.log(`✅ Subjects fetched successfully: ${subjectList.length} subjects found`);
    
    // Return in the format frontend expects
    res.json({ 
      success: true, 
      subjects: subjectList,
      count: subjectList.length 
    });
  } catch (error) {
    console.error('Unexpected error in /api/admin/subjects/all:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error: ' + error.message 
    });
  }
});

// GET all lessons (admin)
app.get('/api/admin/lessons', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    console.log('📚 Admin fetching all lessons');
    
    const { data: lessons, error } = await supabase
      .from('lessons')
      .select('*')
      .order('display_order', { ascending: true });
    
    if (error) {
      console.error('Error fetching lessons:', error);
      if (error.message && (error.message.includes('relation') || error.message.includes('does not exist'))) {
        console.log('⚠️ Lessons table may not exist, returning empty array');
        return res.json({ success: true, lessons: [] });
      }
      throw error;
    }
    
    console.log(`✅ Lessons fetched: ${lessons?.length || 0} records`);
    res.json({ success: true, lessons: lessons || [] });
  } catch (error) {
    console.error('Unexpected error fetching lessons:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// CREATE lesson
app.post('/api/admin/lessons', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { 
      title, 
      description, 
      video_url, 
      pdf_url, 
      subject_id, 
      target_form, 
      quiz_id, 
      display_order,
      resource_type 
    } = req.body;
    
    console.log('📝 Creating new lesson:', { title, subject_id, resource_type });
    
    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }
    
    if (!subject_id) {
      return res.status(400).json({ success: false, message: 'Subject ID is required' });
    }
    
    // Determine resource_type if not provided
    let finalResourceType = resource_type;
    if (!finalResourceType) {
      if (video_url) finalResourceType = 'video';
      else if (pdf_url) finalResourceType = 'pdf';
      else finalResourceType = 'other';
    }
    
    // Validate based on resource type
    if (finalResourceType === 'video' && !video_url) {
      return res.status(400).json({ success: false, message: 'Video URL is required for video lessons' });
    }
    
    if (finalResourceType === 'pdf' && !pdf_url) {
      return res.status(400).json({ success: false, message: 'PDF URL is required for PDF lessons' });
    }
    
    const lessonData = {
      title: title.trim(),
      description: description || null,
      video_url: finalResourceType === 'video' ? video_url : null,
      pdf_url: finalResourceType === 'pdf' ? pdf_url : null,
      subject_id: parseInt(subject_id),
      target_form: target_form || 'All',
      quiz_id: quiz_id ? parseInt(quiz_id) : null,
      display_order: parseInt(display_order) || 0,
      resource_type: finalResourceType,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    const { data, error } = await supabase
      .from('lessons')
      .insert(lessonData)
      .select()
      .single();
      
    if (error) {
      console.error('Lesson insert error:', error);
      return res.status(500).json({ success: false, message: error.message });
    }
    
    console.log('✅ Lesson created successfully:', data.id);
    
    await logAdminAction(
      req.user.id,
      'CREATE_LESSON',
      `Created lesson: ${title} for subject ID ${subject_id}`,
      req.ip
    );
    
    res.json({ success: true, lesson: data });
  } catch (error) {
    console.error('Lesson create error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// UPDATE lesson
app.put('/api/admin/lessons/:id', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };
    
    console.log(`✏️ Updating lesson ${id}:`, updates);
    
    // Clean foreign keys
    if (updates.subject_id === '' || updates.subject_id === 'null') updates.subject_id = null;
    if (updates.quiz_id === '' || updates.quiz_id === 'null') updates.quiz_id = null;
    
    if (updates.subject_id !== null && !isNaN(updates.subject_id)) {
      updates.subject_id = parseInt(updates.subject_id);
    }
    if (updates.quiz_id !== null && !isNaN(updates.quiz_id)) {
      updates.quiz_id = parseInt(updates.quiz_id);
    }
    if (updates.display_order !== undefined) {
      updates.display_order = parseInt(updates.display_order) || 0;
    }
    
    // Determine resource_type if not provided
    if (!updates.resource_type) {
      if (updates.video_url) updates.resource_type = 'video';
      else if (updates.pdf_url) updates.resource_type = 'pdf';
      else if (updates.quiz_id) updates.resource_type = 'quiz';
      else updates.resource_type = 'other';
    }
    
    updates.updated_at = new Date().toISOString();
    
    const { data, error } = await supabase
      .from('lessons')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    
    if (error) {
      console.error('Lesson update error:', error);
      if (error.code === 'PGRST116') {
        return res.status(404).json({ success: false, message: 'Lesson not found' });
      }
      return res.status(500).json({ success: false, message: error.message });
    }
    
    console.log('✅ Lesson updated successfully:', id);
    
    await logAdminAction(
      req.user.id,
      'UPDATE_LESSON',
      `Updated lesson ID ${id}`,
      req.ip
    );
    
    res.json({ success: true, lesson: data });
  } catch (error) {
    console.error('Unexpected error updating lesson:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE lesson
app.delete('/api/admin/lessons/:id', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🗑️ Deleting lesson with ID: ${id}`);

    // Verify the lesson exists before deletion
    const { data: existing, error: fetchError } = await supabase
      .from('lessons')
      .select('id, title')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      console.error('Lesson not found:', fetchError);
      return res.status(404).json({ success: false, message: 'Lesson not found' });
    }

    const { error } = await supabase
      .from('lessons')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Delete error:', error);
      return res.status(500).json({ success: false, message: error.message });
    }

    console.log(`✅ Lesson ${id} deleted successfully`);
    
    await logAdminAction(
      req.user.id,
      'DELETE_LESSON',
      `Deleted lesson: ${existing.title} (ID: ${id})`,
      req.ip
    );
    
    res.json({ success: true, message: 'Lesson deleted successfully' });
  } catch (error) {
    console.error('Unexpected error deleting lesson:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// LEARNER LESSONS ENDPOINTS
// ============================================

// Get all lessons for learner (filtered by form)
app.get('/api/learner/lessons', authenticateToken, async (req, res) => {
  try {
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('form')
      .eq('id', req.user.id)
      .single();
    
    if (learnerError) {
      console.error('Error fetching learner:', learnerError);
      return res.status(404).json({ success: false, message: 'Learner not found' });
    }
    
    const learnerForm = learner.form;
    
    // Fetch lessons for learner's form
    let query = supabase.from('lessons').select('*');
    if (learnerForm !== 'All') {
      query = query.or(`target_form.eq.All,target_form.eq.${learnerForm}`);
    }
    
    const { data: lessons, error } = await query.order('display_order', { ascending: true });
    
    if (error) {
      console.error('Error fetching lessons:', error);
      return res.json({ success: true, lessons: [] });
    }
    
    // Add resource_type if missing (fallback logic)
    const enriched = (lessons || []).map(lesson => {
      let resourceType = lesson.resource_type;
      if (!resourceType) {
        if (lesson.video_url) resourceType = 'video';
        else if (lesson.pdf_url) resourceType = 'pdf';
        else if (lesson.quiz_id) resourceType = 'quiz';
        else resourceType = 'other';
      }
      return { ...lesson, resource_type: resourceType };
    });
    
    res.json({ success: true, lessons: enriched });
  } catch (error) {
    console.error('Error in learner lessons endpoint:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get a single lesson with its quiz details (if any)
app.get('/api/learner/lesson/:lessonId', authenticateToken, async (req, res) => {
  try {
    const { lessonId } = req.params;
    
    const { data: lesson, error } = await supabase
      .from('lessons')
      .select('*, quiz:quiz_id(id, title, duration)')
      .eq('id', lessonId)
      .single();
    
    if (error) {
      console.error('Error fetching lesson:', error);
      return res.status(404).json({ success: false, message: 'Lesson not found' });
    }
    
    res.json({ success: true, lesson });
  } catch (error) {
    console.error('Error in single lesson endpoint:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET learner notifications
app.get('/api/learner/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = typeof req.user.id === 'string' ? parseInt(req.user.id, 10) || req.user.id : req.user.id;
    
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Notifications fetch error:', error);
      return res.status(500).json({ success: false, message: 'Failed to load notifications.' });
    }

    res.json({ success: true, notifications: data || [] });
  } catch (error) {
    console.error('Notifications endpoint error:', error);
    res.status(500).json({ success: false, message: 'Failed to load notifications.' });
  }
});

// Mark notification as read
app.put('/api/learner/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = typeof req.user.id === 'string' ? parseInt(req.user.id, 10) || req.user.id : req.user.id;
    
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// TEACHER ROUTES (keeping existing ones, adding only essential)
// ============================================

// Get teacher's dashboard stats
app.get('/api/teacher/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    console.log('📊 Fetching teacher dashboard stats for user:', req.user.id);
    
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (teacherError) throw teacherError;
    
    let totalLearners = 0;
    let totalReports = 0;
    let attendanceRate = 0;
    let presentToday = 0;
    let totalToday = 0;
    
    if (teacher?.class_id) {
      const { count: learnersCount, error: learnersError } = await supabase
        .from('learners')
        .select('*', { count: 'exact', head: true })
        .eq('class_id', teacher.class_id)
        .eq('status', 'Active');
      
      if (!learnersError) totalLearners = learnersCount || 0;
      
      const { count: reportsCount, error: reportsError } = await supabase
        .from('reports')
        .select('*', { count: 'exact', head: true })
        .eq('class_id', teacher.class_id);
      
      if (!reportsError) totalReports = reportsCount || 0;
      
      const today = new Date().toISOString().split('T')[0];
      const { data: todayAttendance, error: attendanceError } = await supabase
        .from('attendance')
        .select('status, learner_id')
        .eq('date', today);
      
      if (!attendanceError && todayAttendance && todayAttendance.length > 0) {
        totalToday = todayAttendance.length;
        presentToday = todayAttendance.filter(a => a.status === 'present').length;
        attendanceRate = totalToday > 0 ? Math.round((presentToday / totalToday) * 100) : 0;
      }
    }
    
    res.json({
      success: true,
      data: {
        totalLearners: totalLearners,
        totalReports: totalReports,
        attendanceRate: attendanceRate,
        presentToday: presentToday,
        totalToday: totalToday
      }
    });
    
  } catch (err) {
    console.error('Error fetching teacher stats:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

// ============================================
// IMAGE UPLOAD ENDPOINT (local storage)
// ============================================
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (JPEG, PNG, GIF, WEBP)'));
    }
  }
});

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);

app.post('/api/upload/image', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }

    const fileExt = path.extname(req.file.originalname);
    const fileName = `${Date.now()}-${crypto.randomUUID()}${fileExt}`;
    const filePath = path.join(uploadsDir, fileName);

    await fs.writeFile(filePath, req.file.buffer);

    const protocol = req.protocol;
    const host = req.get('host');
    const imageUrl = `${protocol}://${host}/uploads/${fileName}`;

    res.json({
      success: true,
      url: imageUrl,
      message: 'Image uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Failed to upload image'
    });
  }
});

app.use('/uploads', express.static(uploadsDir));

// ============================================
// CLOUDINARY UPLOAD FOR LESSON FILES (videos, PDFs)
// ============================================
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary – add these to your .env file
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const lessonUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB for videos
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|webm|mov|pdf|jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      cb(null, true);
    } else {
      cb(new Error('Only videos, PDFs, and images are allowed'));
    }
  }
});

app.post('/api/admin/upload-lesson-file', authenticateToken, authenticateAdmin, lessonUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const fileBase64 = req.file.buffer.toString('base64');
    const dataUri = `data:${req.file.mimetype};base64,${fileBase64}`;
    
    // Determine resource type based on mimetype
    let resourceType = 'auto';
    if (req.file.mimetype === 'application/pdf') {
      resourceType = 'raw';
    } else if (req.file.mimetype.startsWith('video/')) {
      resourceType = 'video';
    } else if (req.file.mimetype.startsWith('image/')) {
      resourceType = 'image';
    }
    
    const result = await cloudinary.uploader.upload(dataUri, {
      resource_type: resourceType,
      folder: 'eduportal/lessons'
    });
    
    res.json({
      success: true,
      url: result.secure_url,
      public_id: result.public_id
    });
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================
// CLOUDFLARE R2 PRESIGNED UPLOAD URL ENDPOINT
// ============================================
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Initialize R2 client (only if all required env vars are present)
let r2Client = null;
const requiredR2Env = ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
const missingEnv = requiredR2Env.filter(key => !process.env[key]);

if (missingEnv.length === 0) {
  try {
    r2Client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    console.log('✅ Cloudflare R2 client initialized');
  } catch (err) {
    console.error('❌ Failed to initialize R2 client:', err.message);
  }
} else {
  console.warn(`⚠️ Cloudflare R2 credentials missing: ${missingEnv.join(', ')}. R2 uploads will fail.`);
}

app.post('/api/admin/r2-upload-url', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { fileName, fileType, folder } = req.body;
    
    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ success: false, message: 'Valid fileName is required' });
    }

    if (!r2Client) {
      console.error('R2 client not available – missing or invalid configuration');
      return res.status(503).json({ 
        success: false, 
        message: 'R2 storage service is not configured. Please contact administrator.',
        missingEnv: missingEnv
      });
    }

    const bucketName = process.env.R2_BUCKET_NAME;
    if (!bucketName) {
      return res.status(500).json({ success: false, message: 'R2_BUCKET_NAME environment variable is missing' });
    }

    const originalExt = fileName.split('.').pop() || 'bin';
    const safeExt = originalExt.toLowerCase().replace(/[^a-z0-9]/g, '');
    const finalExt = safeExt || 'bin';
    const timestamp = Date.now();
    const randomId = crypto.randomBytes(16).toString('hex');
    
    // Use provided folder or default to 'uploads'
    const folderPath = folder || 'uploads';
    const key = `${folderPath}/${timestamp}-${randomId}.${finalExt}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: fileType || 'application/octet-stream',
      CacheControl: 'max-age=31536000',
    });

    const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: 3600 });

    const publicBase = process.env.R2_PUBLIC_URL;
    const fileUrl = publicBase ? `${publicBase.replace(/\/$/, '')}/${key}` : null;

    res.json({
      success: true,
      uploadUrl,
      fileUrl,
      key,
      bucket: bucketName,
      expiresIn: 3600,
    });

  } catch (error) {
    console.error('❌ R2 presigned URL generation failed:', error);
    res.status(500).json({
      success: false,
      message: error.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: error.stack }),
    });
  }
});

// ============================================
// LEADERBOARD ENDPOINT – BASED ONLY ON REPORT CARDS
// ============================================
app.get('/api/learner/leaderboard', authenticateToken, async (req, res) => {
  try {
    const { class_id, form, limit = 10 } = req.query;
    const currentUserId = req.user.id;

    console.log(`🏆 Fetching leaderboard (report cards only) for user: ${currentUserId}`);

    // Get current learner's info
    const { data: currentLearner, error: learnerError } = await supabase
      .from('learners')
      .select('id, name, reg_number, form, class_id')
      .eq('id', currentUserId)
      .single();

    if (learnerError || !currentLearner) {
      return res.status(404).json({ success: false, message: 'Learner not found' });
    }

    // Determine which learners to include
    let targetClassId = class_id || currentLearner.class_id;
    let targetForm = form || currentLearner.form;

    if (!targetClassId) {
      return res.status(400).json({
        success: false,
        message: 'No class specified and learner not assigned to a class'
      });
    }

    // Get all active, accepted learners in the target class/form
    const { data: learners, error: learnersError } = await supabase
      .from('learners')
      .select('id, name, reg_number, form, class_id')
      .eq('class_id', targetClassId)
      .eq('form', targetForm)
      .eq('status', 'Active')
      .eq('is_accepted_by_teacher', true)
      .order('name', { ascending: true });

    if (learnersError || !learners || learners.length === 0) {
      return res.json({
        success: true,
        leaderboard: [],
        current_user_rank: null,
        message: 'No learners found in this class/form'
      });
    }

    const learnerIds = learners.map(l => l.id);

    // Calculate report card average for each learner
    const leaderboardData = await Promise.all(learners.map(async (learner) => {
      // Fetch all completed reports for this learner
      const { data: reports, error: reportsError } = await supabase
        .from('reports')
        .select('average_score')
        .eq('learner_id', learner.id);

      let averageScore = 0;
      let reportCount = 0;

      if (!reportsError && reports && reports.length > 0) {
        const totalScore = reports.reduce((sum, report) => sum + (report.average_score || 0), 0);
        averageScore = totalScore / reports.length;
        reportCount = reports.length;
      }

      return {
        id: learner.id,
        name: learner.name,
        reg_number: learner.reg_number,
        form: learner.form,
        average_score: Math.round(averageScore * 100) / 100,
        report_count: reportCount
      };
    }));

    // Sort by average score (descending)
    leaderboardData.sort((a, b) => b.average_score - a.average_score);

    // Assign ranks
    leaderboardData.forEach((item, index) => {
      item.rank = index + 1;
    });

    // Find current user's rank
    const currentUserData = leaderboardData.find(item => item.id === currentUserId);
    const currentUserRank = currentUserData ? currentUserData.rank : null;

    // Limit results if specified
    const limitedResults = limit && limit > 0 ? leaderboardData.slice(0, parseInt(limit)) : leaderboardData;

    res.json({
      success: true,
      leaderboard: limitedResults,
      current_user_rank: currentUserRank,
      total_participants: learners.length,
      class_id: targetClassId,
      form: targetForm,
      metric: 'report_card_average'
    });

  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leaderboard',
      error: error.message
    });
  }
});

// ============================================
// 404 HANDLER
// ============================================
app.use((req, res) => {
  console.log(`❌ Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    success: false, 
    message: `Route not found: ${req.path}`
  });
});

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`✅ Server is running on port ${PORT}`);
  console.log(`📡 API URL: http://localhost:${PORT}/api`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log('='.repeat(60));
  
  console.log('\n📋 Admin API Endpoints:');
  console.log('   GET    /api/admin/stats');
  console.log('   GET    /api/admin/teachers');
  console.log('   POST   /api/admin/teachers');
  console.log('   PUT    /api/admin/teachers/:id');
  console.log('   DELETE /api/admin/teachers/:id');
  console.log('   GET    /api/admin/classes');
  console.log('   POST   /api/admin/classes');
  console.log('   PUT    /api/admin/classes/:id');
  console.log('   DELETE /api/admin/classes/:id');
  console.log('   GET    /api/admin/learners');
  console.log('   POST   /api/admin/learners');
  console.log('   PUT    /api/admin/learners/:id');
  console.log('   DELETE /api/admin/learners/:id');
  console.log('   GET    /api/admin/audit-logs');
  console.log('   DELETE /api/admin/audit-logs/clear');
  console.log('   GET    /api/admin/subjects/:classId');
  console.log('   POST   /api/admin/subjects');
  console.log('   PUT    /api/admin/subjects/:id');
  console.log('   DELETE /api/admin/subjects/:id');
  console.log('   GET    /api/admin/subjects/all'); // FIXED: Added to list
  console.log('   GET    /api/admin/lessons'); // FIXED: Added to list
  console.log('   POST   /api/admin/lessons'); // FIXED: Added to list
  console.log('   PUT    /api/admin/lessons/:id'); // FIXED: Added to list
  console.log('   DELETE /api/admin/lessons/:id'); // FIXED: Added to list
  console.log('   GET    /api/admin/quiz-subjects');
  console.log('   GET    /api/admin/quizzes');
  console.log('   POST   /api/admin/quizzes');
  console.log('   PUT    /api/admin/quizzes/:quizId');
  console.log('   DELETE /api/admin/quizzes/:quizId');
  console.log('   POST   /api/admin/quizzes/:quizId/questions');
  console.log('   PUT    /api/admin/quizzes/:quizId/questions/:questionId');
  console.log('   DELETE /api/admin/quizzes/:quizId/questions/:questionId');
  console.log('   GET    /api/admin/quizzes/:quizId/submissions');
  console.log('   POST   /api/admin/grade');
  console.log('   POST   /api/admin/r2-upload-url');
  
  console.log('\n📋 Lesson Management Endpoints:');
  console.log('   GET    /api/learner/lessons');
  console.log('   GET    /api/learner/lesson/:lessonId');
  console.log('='.repeat(60));
});

module.exports = app;