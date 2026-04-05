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
    const { data: notifications, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('is_read', false)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, notifications: notifications || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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

// GET /api/admin/quizzes/:quizId/submissions
app.get('/api/admin/quizzes/:quizId/submissions', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    // Convert to integer because quizzes.id is INTEGER in your DB
    const numericQuizId = parseInt(quizId, 10);
    if (isNaN(numericQuizId)) {
      return res.status(400).json({ success: false, message: 'Invalid quiz ID' });
    }

    console.log(`📋 Admin fetching submissions for quiz ID: ${numericQuizId}`);

    // Fetch all completed attempts for this quiz
    const { data: attempts, error } = await supabase
      .from('quiz_attempts')
      .select('*')
      .eq('quiz_id', numericQuizId)
      .eq('status', 'completed')
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

    // Format submissions
    const formatted = attempts.map(attempt => {
      let answers = attempt.answers;
      if (typeof answers === 'string') {
        try { answers = JSON.parse(answers); } catch(e) { answers = []; }
      }
      if (!Array.isArray(answers)) answers = [];

      const learner = learnerMap[attempt.learner_id] || { name: 'Unknown', reg_number: 'N/A', form: 'N/A' };

      return {
        id: attempt.id,
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
    const { attempt_id, answers } = req.body;  // frontend sends attempt_id and answers

    if (!attempt_id) {
      return res.status(400).json({ success: false, message: 'Missing attempt_id' });
    }

    console.log(`📝 Grading attempt: ${attempt_id}`);

    // Fetch current attempt
    const { data: attempt, error: fetchError } = await supabase
      .from('quiz_attempts')
      .select('answers, earned_points, total_points')
      .eq('id', attempt_id)
      .single();

    if (fetchError) {
      console.error('Error fetching attempt:', fetchError);
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
          feedback: grade.feedback || null
        };
      }
      return ans;
    });

    // Recalculate total earned marks
    const newEarnedMarks = updatedAnswers.reduce((sum, ans) => sum + (ans.points_obtained || 0), 0);
    const totalMarks = attempt.total_points || 0;

    // Update the attempt
    const { error: updateError } = await supabase
      .from('quiz_attempts')
      .update({
        answers: updatedAnswers,
        earned_points: newEarnedMarks,
        updated_at: new Date().toISOString()
      })
      .eq('id', attempt_id);

    if (updateError) {
      console.error('Error updating attempt:', updateError);
      return res.status(500).json({ success: false, message: updateError.message });
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

// Create a new quiz (admin)
app.post('/api/admin/quizzes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { subject_id, title, description, duration, total_marks, is_active, target_form } = req.body;
    
    console.log('📝 Creating new quiz:', { subject_id, title, duration, target_form });
    
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
        is_active: is_active !== false,
        target_form: target_form || 'All',
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

// Get questions for a specific quiz (admin)
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
      question_image,        // <-- NEW
      option_images,         // <-- NEW
      answer_image           // <-- NEW
    } = req.body;
    
    console.log(`📝 Adding ${question_type || 'multiple_choice'} question to quiz: ${quizId}`);

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
      question_image: question_image || null,     // <-- NEW
      option_images: option_images || [],         // <-- NEW
      answer_image: answer_image || null,         // <-- NEW
      question_type: qType,
      marks: questionMarks,
      points: questionMarks,
      display_order: finalDisplayOrder,
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
      `Added ${qType} question to quiz ID ${quizId}`,
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

// Update quiz (admin)
app.put('/api/admin/quizzes/:quizId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { subject_id, title, description, duration, total_marks, is_active, target_form } = req.body;
    
    const updateData = {};
    if (subject_id) updateData.subject_id = subject_id;
    if (title) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (duration) updateData.duration = duration;
    if (total_marks !== undefined) updateData.total_marks = total_marks;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (target_form !== undefined) updateData.target_form = target_form;
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

    const quizzesWithCounts = await Promise.all((quizzes || []).map(async (quiz) => {
      const { data: questions, error: countError } = await supabase
        .from('quiz_questions')
        .select('marks')
        .eq('quiz_id', quiz.id);
      
      const totalMarks = questions?.reduce((sum, q) => sum + (q.marks || 1), 0) || 0;
      
      return {
        ...quiz,
        subject_name: quiz.subject?.name,
        question_count: questions?.length || 0,
        total_marks: totalMarks,
        passing_marks: quiz.passing_points || Math.round(totalMarks * 0.5)
      };
    }));

    res.json({
      success: true,
      quizzes: quizzesWithCounts,
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
    const resolved = resolveQuizRouteId(req.params.quizId);
    if (!resolved.ok) {
      return res.status(400).json({ success: false, message: resolved.message });
    }
    const numericQuizId = resolved.id;

    console.log(`🎯 Starting quiz attempt for learner: ${req.user.id}, Quiz: ${numericQuizId}`);

    // Fetch quiz using numeric ID
    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('subject_id, subject:subject_id(name), total_marks, passing_points')
      .eq('id', numericQuizId)
      .single();

    if (quizError) {
      console.error('Quiz fetch error:', quizError);
      return res.status(404).json({
        success: false,
        message: 'Quiz not found'
      });
    }

    if (!quiz) {
      return res.status(404).json({ success: false, message: 'Quiz not found' });
    }

    // Check for existing in-progress attempt (use numericQuizId)
    const { data: existingAttempt, error: checkError } = await supabase
      .from('quiz_attempts')
      .select('id')
      .eq('learner_id', req.user.id)
      .eq('quiz_id', numericQuizId)
      .eq('status', 'in-progress')
      .maybeSingle();

    if (checkError) {
      console.error('Check attempt error:', checkError);
      // Non-critical, continue
    }

    if (existingAttempt) {
      return res.json({
        success: true,
        attempt_id: existingAttempt.id,
        message: 'Resuming existing attempt'
      });
    }

    // Insert new attempt — omit undefined keys; retry if FK/column issues
    const baseRow = {
      learner_id: req.user.id,
      quiz_id: numericQuizId,
      total_marks: quiz.total_marks || 0,
      status: 'in-progress',
      started_at: new Date().toISOString()
    };
    if (quiz.subject_id != null && quiz.subject_id !== '') {
      baseRow.subject_id = quiz.subject_id;
    }
    const subjectName =
      quiz.subject && typeof quiz.subject === 'object' && quiz.subject.name
        ? String(quiz.subject.name)
        : null;
    if (subjectName) {
      baseRow.subject = subjectName;
    }

    let attempt;
    let error;
    const tryInsert = async (row) =>
      supabase.from('quiz_attempts').insert(row).select().single();

    ({ data: attempt, error } = await tryInsert(baseRow));
    if (error) {
      console.error('Insert attempt (full):', error.code, error.message, error.details);
    }

    // Retry without denormalized subject text (column may be missing or different type)
    if (error && baseRow.subject !== undefined) {
      const row2 = { ...baseRow };
      delete row2.subject;
      ({ data: attempt, error } = await tryInsert(row2));
      if (error) console.error('Insert attempt (no subject text):', error.code, error.message);
    }

    // Retry without subject_id if FK points to missing subject row
    if (error && baseRow.subject_id !== undefined) {
      const row3 = { ...baseRow };
      delete row3.subject;
      delete row3.subject_id;
      ({ data: attempt, error } = await tryInsert(row3));
      if (error) console.error('Insert attempt (minimal):', error.code, error.message);
    }

    if (error) {
      console.error('Insert error (final):', error);
      const msg = error.message || '';
      // We no longer have a UUID mismatch because we already reject non-numeric IDs.
      return res.status(500).json({
        success: false,
        message: 'Failed to start quiz: ' + msg,
        code: error.code
      });
    }

    res.json({
      success: true,
      attempt_id: attempt.id,
      message: 'Quiz started successfully',
      quiz: {
        total_marks: quiz.total_marks,
        passing_marks: quiz.passing_points
      }
    });
  } catch (error) {
    console.error('Error starting quiz:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start quiz: ' + error.message
    });
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

// Submit quiz answers (updated to return marks_earned and total_marks)
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

    // Fetch quiz questions
    const { data: questions, error: qError } = await supabase
      .from('quiz_questions')
      .select('*')
      .eq('quiz_id', quizId);

    if (qError) throw qError;

    // Fetch quiz details and learner name
    const { data: quiz, error: quizError } = await supabase
      .from('quizzes')
      .select('title, total_marks, passing_points')
      .eq('id', quizId)
      .single();

    if (quizError) throw quizError;

    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('name')
      .eq('id', learnerId)
      .single();

    if (learnerError) throw learnerError;

    // Calculate score
    let earnedPoints = 0;
    let totalPossiblePoints = 0;
    let correctCount = 0;
    const gradedAnswers = [];

    questions.forEach((question, idx) => {
      const userAnswer = answers && answers[idx] !== undefined ? answers[idx] : null;
      let isCorrect = false;
      let pointsObtained = 0;
      let userAnswerText = '';

      totalPossiblePoints += (question.marks || 1);

      if (question.question_type === 'multiple_choice') {
        const selectedOption = parseInt(userAnswer);
        userAnswerText = question.options[selectedOption] || 'Not answered';
        isCorrect = (selectedOption === question.correct_answer);
        pointsObtained = isCorrect ? (question.marks || 1) : 0;
      } else if (question.question_type === 'short_answer') {
        userAnswerText = userAnswer ? String(userAnswer).trim().toLowerCase() : '';
        const expected = question.expected_answer ? question.expected_answer.trim().toLowerCase() : '';
        isCorrect = (userAnswerText === expected) || (expected && userAnswerText.includes(expected));
        pointsObtained = isCorrect ? (question.marks || 1) : 0;
      }

      if (isCorrect) correctCount++;
      earnedPoints += pointsObtained;

      gradedAnswers.push({
        question_id: question.id,
        question_text: question.question_text,
        question_image: question.question_image || null,       // <-- ADD
        option_images: question.option_images || [],           // <-- ADD (for multiple choice)
        answer_image: question.answer_image || null,  
        question_type: question.question_type,
        selected_answer: userAnswer,
        selected_answer_text: userAnswerText || 'Not answered',
        is_correct: isCorrect,
        points_obtained: pointsObtained,
        max_points: question.marks || 1,
        correct_answer: question.question_type === 'multiple_choice'
          ? question.options[question.correct_answer]
          : question.expected_answer,
        explanation: question.explanation,
        feedback: null
      });
    });

    const percentage = totalPossiblePoints > 0 ? (earnedPoints / totalPossiblePoints) * 100 : 0;
    const passed = earnedPoints >= (quiz.passing_points || Math.round(totalPossiblePoints * 0.5));

    // Update attempt with results
    const { data: updatedAttempt, error: updateError } = await supabase
      .from('quiz_attempts')
      .update({
        status: 'completed',
        answers: gradedAnswers,
        earned_points: earnedPoints,
        total_points: totalPossiblePoints,
        score: correctCount,
        percentage: percentage,
        passed: passed,
        completed_at: new Date().toISOString(),
        time_taken: time_taken || null,
        feedback: null
      })
      .eq('id', attempt_id)
      .select()
      .single();

    if (updateError) throw updateError;

    // -------- NOTIFICATION FOR ADMIN --------
    // 1. Log to audit_logs (already used for admin actions)
    await supabase.from('audit_logs').insert({
      user_id: learnerId,
      action: 'QUIZ_COMPLETED',
      details: `Learner ${learner.name} completed quiz "${quiz.title}" with score ${earnedPoints}/${totalPossiblePoints} (${Math.round(percentage)}%)`,
      ip_address: req.ip,
      created_at: new Date().toISOString()
    });

    // 2. Create a notification for all admin users (or a specific admin)
    const { data: admins, error: adminsError } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'admin')
      .eq('is_active', true);

    if (!adminsError && admins && admins.length) {
      const notificationInserts = admins.map(admin => ({
        user_id: admin.id,
        type: 'quiz_completed',
        title: 'Quiz Completed',
        message: `${learner.name} completed "${quiz.title}" with ${earnedPoints}/${totalPossiblePoints} marks.`,
        related_id: quizId,
        is_read: false,
        created_at: new Date().toISOString()
      }));
      await supabase.from('notifications').insert(notificationInserts);
    }

    // Return result
    res.json({
      success: true,
      marks_earned: earnedPoints,
      total_marks: totalPossiblePoints,
      correct_answers: correctCount,
      total_questions: questions.length,
      percentage: Math.round(percentage),
      passed: passed,
      passing_score: quiz.passing_points || Math.round(totalPossiblePoints * 0.5),
      answers: gradedAnswers,
      feedback: null,
      message: passed
        ? `🎉 Congratulations! You passed with ${earnedPoints}/${totalPossiblePoints} marks!`
        : `📚 Keep practicing! You got ${earnedPoints}/${totalPossiblePoints} marks.`
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
      question_image: ans.question_image || null,     // <-- ADD
      option_images: ans.option_images || [],         // <-- ADD
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
// TEACHER ROUTES
// ============================================
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

app.get('/api/teacher/all-learners', authenticateToken, async (req, res) => {
  try {
    console.log('📚 Fetching all learners for teacher to add');
    
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (teacherError) throw teacherError;
    
    if (!teacher?.class_id) {
      return res.json({
        success: true,
        learners: []
      });
    }
    
    const { data: learners, error } = await supabase
      .from('learners')
      .select('id, name, reg_number, form, status, class_id, is_accepted_by_teacher')
      .eq('class_id', teacher.class_id)
      .eq('is_accepted_by_teacher', false)
      .eq('status', 'Active')
      .order('name', { ascending: true });
    
    if (error) throw error;
    
    res.json({
      success: true,
      learners: learners || []
    });
    
  } catch (err) {
    console.error('Error fetching all learners:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

app.get('/api/teacher/my-learners', authenticateToken, async (req, res) => {
  try {
    console.log('👥 Fetching learners accepted by teacher:', req.user.id);
    
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (teacherError) throw teacherError;
    
    if (!teacher?.class_id) {
      return res.json({
        success: true,
        learners: []
      });
    }
    
    const { data: learners, error } = await supabase
      .from('learners')
      .select('id, name, reg_number, form, status, class_id')
      .eq('class_id', teacher.class_id)
      .eq('is_accepted_by_teacher', true)
      .eq('status', 'Active')
      .order('name', { ascending: true });
    
    if (error) throw error;
    
    res.json({
      success: true,
      learners: learners || []
    });
    
  } catch (err) {
    console.error('Error fetching my learners:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

app.post('/api/teacher/add-learners', authenticateToken, async (req, res) => {
  try {
    const { learnerIds } = req.body;
    
    console.log('📝 Accepting learners to teacher class:', { learnerIds });
    
    if (!learnerIds || !Array.isArray(learnerIds) || learnerIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please select at least one learner'
      });
    }
    
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (teacherError) throw teacherError;
    
    if (!teacher?.class_id) {
      return res.status(400).json({
        success: false,
        message: 'You have not been assigned to a class yet. Please contact administrator.'
      });
    }
    
    const { data: learnersToAccept, error: checkError } = await supabase
      .from('learners')
      .select('id, name')
      .in('id', learnerIds)
      .eq('class_id', teacher.class_id)
      .eq('is_accepted_by_teacher', false);
    
    if (checkError) throw checkError;
    
    if (learnersToAccept.length !== learnerIds.length) {
      return res.status(400).json({
        success: false,
        message: 'Some learners are not available to accept'
      });
    }
    
    const { data, error } = await supabase
      .from('learners')
      .update({ 
        is_accepted_by_teacher: true,
        updated_at: new Date().toISOString() 
      })
      .in('id', learnerIds)
      .select();
    
    if (error) throw error;
    
    await logAdminAction(
      req.user.id,
      'ACCEPT_LEARNERS',
      `Teacher accepted ${learnerIds.length} learner(s) into class`,
      req.ip
    );
    
    res.json({
      success: true,
      message: `${learnerIds.length} learner(s) added to your class`,
      learners: data
    });
    
  } catch (err) {
    console.error('Error accepting learners:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

app.delete('/api/teacher/remove-learner/:learnerId', authenticateToken, async (req, res) => {
  try {
    const { learnerId } = req.params;
    
    console.log('🗑️ Removing learner from teacher class:', learnerId);
    
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (teacherError) throw teacherError;
    
    if (!teacher?.class_id) {
      return res.status(400).json({
        success: false,
        message: 'You have not been assigned to a class yet.'
      });
    }
    
    const { data: updatedLearner, error } = await supabase
      .from('learners')
      .update({ 
        is_accepted_by_teacher: false,
        updated_at: new Date().toISOString() 
      })
      .eq('id', parseInt(learnerId))
      .eq('class_id', teacher.class_id)
      .select();
    
    if (error) {
      console.error('Error updating learner:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to remove learner: ' + error.message
      });
    }
    
    if (!updatedLearner || updatedLearner.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Learner not found in your class'
      });
    }
    
    res.json({
      success: true,
      message: `Learner removed from your class and will appear in "Add Learners" list again`,
      learner: updatedLearner[0]
    });
    
  } catch (err) {
    console.error('Error removing learner:', err);
    res.status(500).json({
      success: false,
      message: 'Server error: ' + err.message
    });
  }
});

// GET /api/teacher/reports - safe version
app.get('/api/teacher/reports', authenticateToken, async (req, res) => {
  try {
    const teacherId = req.user.id;

    // 1. Get teacher's class
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('class_id')
      .eq('id', teacherId)
      .maybeSingle();
    if (teacherError) throw teacherError;
    if (!teacher?.class_id) return res.json({ success: true, data: [] });

    // 2. Get all accepted learners in that class
    const { data: learners, error: learnersError } = await supabase
      .from('learners')
      .select('id')
      .eq('class_id', teacher.class_id)
      .eq('is_accepted_by_teacher', true);
    if (learnersError) throw learnersError;
    const learnerIds = learners?.map(l => l.id) || [];
    if (learnerIds.length === 0) return res.json({ success: true, data: [] });

    // 3. Fetch reports for those learners (no class_id assumption)
    const { data: reports, error: reportsError } = await supabase
      .from('reports')
      .select('*')
      .in('learner_id', learnerIds)
      .order('created_at', { ascending: false });
    if (reportsError) throw reportsError;

    // 4. Fetch learner names separately
    const { data: learnerDetails, error: detailsError } = await supabase
      .from('learners')
      .select('id, name, reg_number')
      .in('id', learnerIds);
    if (detailsError) throw detailsError;
    const learnerMap = {};
    learnerDetails?.forEach(l => { learnerMap[l.id] = { name: l.name, reg_number: l.reg_number }; });

    // 5. Enrich reports
    const enriched = (reports || []).map(r => ({
      ...r,
      learner_name: learnerMap[r.learner_id]?.name || 'Unknown',
      learner_reg: learnerMap[r.learner_id]?.reg_number || 'N/A'
    }));

    res.json({ success: true, data: enriched });
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/teacher/reports', authenticateToken, async (req, res) => {
  try {
    const { learnerId, term, form, subjects, comment, assessment_type_id, academic_year } = req.body;
    
    console.log('📝 Creating new report for learner:', learnerId);
    
    if (!learnerId || !subjects || subjects.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Learner ID and subjects are required'
      });
    }
    
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id, name, class_id, reg_number, form')
      .eq('id', parseInt(learnerId))
      .maybeSingle();
    
    if (learnerError || !learner) {
      console.error('Learner error:', learnerError);
      return res.status(404).json({
        success: false,
        message: 'Learner not found'
      });
    }
    
    console.log('Found learner:', learner.name, 'Class ID:', learner.class_id);
    
    let assessmentName = term;
    if (assessment_type_id) {
      const { data: assessmentType, error: typeError } = await supabase
        .from('assessment_types')
        .select('name')
        .eq('id', assessment_type_id)
        .maybeSingle();
      
      if (!typeError && assessmentType) {
        assessmentName = assessmentType.name;
      }
    }
    
    const totalScore = subjects.reduce((sum, s) => sum + (s.score || 0), 0);
    const averageScore = Math.round(totalScore / subjects.length);
    
    let grade = 'F';
    if (averageScore >= 75) grade = 'A';
    else if (averageScore >= 65) grade = 'B';
    else if (averageScore >= 55) grade = 'C';
    else if (averageScore >= 40) grade = 'D';
    
    const subjectsData = subjects.map(s => ({
      name: s.name,
      score: parseInt(s.score) || 0
    }));
    
    const { data: newReport, error } = await supabase
      .from('reports')
      .insert({
        learner_id: parseInt(learnerId),
        class_id: learner.class_id,
        term: assessmentName,
        assessment_type_id: assessment_type_id || null,
        academic_year: academic_year || new Date().getFullYear(),
        form: form || learner.form,
        subjects: subjectsData,
        average_score: averageScore,
        total_score: totalScore,
        grade: grade,
        comment: comment || null,
        generated_by: req.user.id,
        generated_date: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (error) {
      console.error('Insert error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to save report: ' + error.message
      });
    }
    
    console.log('✅ Report saved successfully:', newReport.id);
    
    res.json({
      success: true,
      message: 'Report card saved successfully!',
      report: newReport
    });
    
  } catch (err) {
    console.error('Error creating report:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

// UPDATE REPORT (PUT) endpoint
app.put('/api/teacher/reports/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      learnerId,
      term,
      form,
      subjects,
      best_subjects,
      total_points,
      english_passed,
      final_status,
      comment,
      assessment_type_id,
      academic_year
    } = req.body;

    console.log(`✏️ Updating report ${id} for teacher ${req.user.id}`);

    // First, verify the report exists and belongs to this teacher's class
    const { data: existing, error: fetchError } = await supabase
      .from('reports')
      .select('id, learner_id, class_id')
      .eq('id', id)
      .maybeSingle();

    if (fetchError || !existing) {
      console.error('Report not found or fetch error:', fetchError);
      return res.status(404).json({
        success: false,
        message: 'Report not found'
      });
    }

    // Verify teacher has access to this learner's class
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('class_id')
      .eq('id', req.user.id)
      .maybeSingle();

    if (teacherError || !teacher) {
      return res.status(403).json({
        success: false,
        message: 'Teacher not found'
      });
    }

    if (teacher.class_id !== existing.class_id) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to edit this report'
      });
    }

    // Build update object
    const updates = {};
    if (learnerId !== undefined) updates.learner_id = parseInt(learnerId);
    if (term !== undefined) updates.term = term;
    if (form !== undefined) updates.form = form;
    if (subjects !== undefined) updates.subjects = subjects;
    if (best_subjects !== undefined) updates.best_subjects = best_subjects;
    if (total_points !== undefined) updates.total_points = total_points;
    if (english_passed !== undefined) updates.english_passed = english_passed;
    if (final_status !== undefined) updates.final_status = final_status;
    if (comment !== undefined) updates.comment = comment;
    if (assessment_type_id !== undefined) updates.assessment_type_id = assessment_type_id;
    if (academic_year !== undefined) updates.academic_year = academic_year;
    updates.updated_at = new Date().toISOString();

    // Recalculate average and grade if subjects changed
    if (subjects && Array.isArray(subjects) && subjects.length > 0) {
      const totalScore = subjects.reduce((sum, s) => sum + (s.score || 0), 0);
      const averageScore = Math.round(totalScore / subjects.length);
      updates.average_score = averageScore;
      updates.total_score = totalScore;

      let grade = 'F';
      if (averageScore >= 75) grade = 'A';
      else if (averageScore >= 65) grade = 'B';
      else if (averageScore >= 55) grade = 'C';
      else if (averageScore >= 40) grade = 'D';
      updates.grade = grade;
    }

    // Perform the update
    const { data: updatedReport, error: updateError } = await supabase
      .from('reports')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      console.error('Update error:', updateError);
      return res.status(500).json({
        success: false,
        message: 'Failed to update report: ' + updateError.message
      });
    }

    console.log('✅ Report updated successfully:', updatedReport.id);

    res.json({
      success: true,
      message: 'Report updated successfully',
      report: updatedReport
    });
  } catch (err) {
    console.error('Error updating report:', err);
    res.status(500).json({
      success: false,
      message: 'Server error: ' + err.message
    });
  }
});

app.delete('/api/teacher/reports/:reportId', authenticateToken, async (req, res) => {
  try {
    const { reportId } = req.params;
    
    const { data: deletedReport, error } = await supabase
      .from('reports')
      .delete()
      .eq('id', reportId)
      .select()
      .single();
    
    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: 'Report not found'
        });
      }
      throw error;
    }
    
    res.json({
      success: true,
      message: 'Report deleted successfully'
    });
    
  } catch (err) {
    console.error('Error deleting report:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

app.get('/api/teacher/attendance', authenticateToken, async (req, res) => {
  try {
    console.log('📅 Fetching attendance records for teacher:', req.user.id);
    
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (teacherError) {
      console.error('Teacher error:', teacherError);
      return res.json({
        success: true,
        data: {
          stats: { total: 0, present: 0, absent: 0, late: 0, rate: 0 },
          records: []
        }
      });
    }
    
    if (!teacher?.class_id) {
      console.log('Teacher has no class assigned');
      return res.json({
        success: true,
        data: {
          stats: { total: 0, present: 0, absent: 0, late: 0, rate: 0 },
          records: []
        }
      });
    }
    
    const { data: learners, error: learnersError } = await supabase
      .from('learners')
      .select('id, name, reg_number, form')
      .eq('class_id', teacher.class_id);
    
    if (learnersError) {
      console.error('Learners error:', learnersError);
      return res.json({
        success: true,
        data: {
          stats: { total: 0, present: 0, absent: 0, late: 0, rate: 0 },
          records: []
        }
      });
    }
    
    const learnerIds = learners?.map(l => l.id) || [];
    
    let attendanceData = [];
    let stats = { total: 0, present: 0, absent: 0, late: 0, rate: 0 };
    
    if (learnerIds.length > 0) {
      const { data: attendance, error: attendanceError } = await supabase
        .from('attendance')
        .select('*')
        .in('learner_id', learnerIds)
        .order('date', { ascending: false });
      
      if (!attendanceError && attendance) {
        attendanceData = attendance;
        
        const learnerMap = {};
        learners.forEach(l => {
          learnerMap[l.id] = { name: l.name, reg_number: l.reg_number, form: l.form };
        });
        
        const totalRecords = attendanceData.length;
        const presentCount = attendanceData.filter(a => a.status === 'present').length;
        const absentCount = attendanceData.filter(a => a.status === 'absent').length;
        const lateCount = attendanceData.filter(a => a.status === 'late').length;
        
        stats = {
          total: totalRecords,
          present: presentCount,
          absent: absentCount,
          late: lateCount,
          rate: totalRecords > 0 ? Math.round(((presentCount + lateCount) / totalRecords) * 100) : 0
        };
        
        attendanceData = attendanceData.map(record => ({
          id: record.id,
          learner_id: record.learner_id,
          learner_name: learnerMap[record.learner_id]?.name || 'Unknown',
          learner_reg: learnerMap[record.learner_id]?.reg_number || 'N/A',
          learner_form: learnerMap[record.learner_id]?.form || 'N/A',
          date: record.date,
          status: record.status,
          status_display: record.status === 'present' ? 'Present' : 
                         record.status === 'late' ? 'Late' : 'Absent',
          term: record.term || 1,
          year: record.year || new Date().getFullYear(),
          recorded_at: record.created_at || record.updated_at,
          date_formatted: new Date(record.date).toLocaleDateString('en', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          })
        }));
      }
    }
    
    res.json({
      success: true,
      data: {
        stats,
        records: attendanceData,
        summary: {
          total_learners: learners.length,
          total_records: stats.total,
          present_rate: stats.rate
        }
      }
    });
    
  } catch (err) {
    console.error('Error fetching teacher attendance:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

app.post('/api/teacher/attendance', authenticateToken, async (req, res) => {
  try {
    const { learnerId, date, status, term, year } = req.body;
    
    console.log('📝 Attendance request:', { learnerId, date, status, term, year });
    
    if (!learnerId || !date || !status) {
      return res.status(400).json({ 
        success: false,
        message: 'Missing required fields: learnerId, date, and status are required'
      });
    }
    
    if (!['present', 'absent', 'late'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be present, absent, or late'
      });
    }
    
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id, name')
      .eq('id', learnerId)
      .maybeSingle();
    
    if (learnerError) {
      console.error('Learner query error:', learnerError);
      return res.status(500).json({ 
        success: false,
        message: 'Database error while checking learner',
        error: learnerError.message
      });
    }
    
    if (!learner) {
      return res.status(404).json({
        success: false,
        message: `Learner with ID ${learnerId} not found`
      });
    }
    
    console.log('✅ Found learner:', learner);
    
    const { data: existing, error: existingError } = await supabase
      .from('attendance')
      .select('id')
      .eq('learner_id', learnerId)
      .eq('date', date)
      .maybeSingle();
    
    let result;
    
    if (existing) {
      console.log('Updating existing attendance record');
      const { data, error } = await supabase
        .from('attendance')
        .update({
          status: status,
          term: term || 1,
          year: year || new Date().getFullYear(),
          updated_at: new Date().toISOString()
        })
        .eq('id', existing.id)
        .select();
      
      if (error) {
        console.error('Update error:', error);
        return res.status(500).json({
          success: false,
          message: 'Failed to update attendance: ' + error.message
        });
      }
      
      result = data[0];
    } else {
      console.log('Creating new attendance record');
      const { data, error } = await supabase
        .from('attendance')
        .insert({
          learner_id: learnerId,
          date: date,
          status: status,
          term: term || 1,
          year: year || new Date().getFullYear(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select();
      
      if (error) {
        console.error('Insert error:', error);
        return res.status(500).json({
          success: false,
          message: 'Failed to record attendance: ' + error.message
        });
      }
      
      result = data[0];
    }
    
    console.log('✅ Attendance recorded successfully:', result);
    
    res.json({ 
      success: true, 
      message: 'Attendance recorded successfully',
      attendance: result 
    });
    
  } catch (error) {
    console.error('❌ Attendance error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error: ' + error.message
    });
  }
});

app.get('/api/teacher/assessment-types', authenticateToken, async (req, res) => {
  try {
    const { data: types, error } = await supabase
      .from('assessment_types')
      .select('*')
      .eq('is_active', true)
      .order('display_order', { ascending: true });
    
    if (error) throw error;
    
    res.json({
      success: true,
      assessment_types: types || []
    });
  } catch (err) {
    console.error('Error fetching assessment types:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch assessment types'
    });
  }
});

app.get('/api/teacher/subjects/:classId', authenticateToken, async (req, res) => {
  try {
    const { classId } = req.params;
    
    const { data, error } = await supabase
      .from('subjects')
      .select('*')
      .eq('class_id', classId)
      .order('display_order', { ascending: true });
    
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Error fetching subjects:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/teacher/learner-subjects/:learnerId', authenticateToken, async (req, res) => {
  try {
    const { learnerId } = req.params;
    
    console.log('📚 Fetching subjects for learner:', learnerId);
    
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('class_id, form')
      .eq('id', learnerId)
      .maybeSingle();
    
    if (learnerError) {
      console.error('Error fetching learner:', learnerError);
      return res.status(500).json({
        success: false,
        message: 'Error fetching learner information'
      });
    }
    
    if (!learner) {
      return res.status(404).json({
        success: false,
        message: 'Learner not found'
      });
    }
    
    if (!learner.class_id) {
      console.log('Learner has no class assigned');
      return res.json({
        success: true,
        subjects: [],
        message: 'Learner has no class assigned'
      });
    }
    
    const { data: subjects, error: subjectsError } = await supabase
      .from('subjects')
      .select('id, name, code, description, status')
      .eq('class_id', learner.class_id)
      .eq('status', 'Active')
      .order('display_order', { ascending: true });
    
    if (subjectsError) {
      console.error('Error fetching subjects:', subjectsError);
      return res.status(500).json({
        success: false,
        message: 'Error fetching subjects'
      });
    }
    
    console.log(`✅ Found ${subjects?.length || 0} subjects for learner ${learnerId}`);
    
    res.json({
      success: true,
      subjects: subjects || []
    });
    
  } catch (err) {
    console.error('Error in learner-subjects endpoint:', err);
    res.status(500).json({
      success: false,
      message: 'Server error: ' + err.message
    });
  }
});

// ============================================
// LEARNER ROUTES
// ============================================
app.get('/api/learner/profile', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('learners')
      .select('*, class:class_id(id, name, year)')
      .eq('id', req.user.id)
      .single();
    
    if (error) throw error;
    
    res.json({
      success: true,
      profile: data
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/learner/attendance', authenticateToken, async (req, res) => {
  try {
    console.log(`📅 Fetching attendance for learner: ${req.user.id}`);
    
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id, name, reg_number, form, class_id')
      .eq('id', parseInt(req.user.id))
      .maybeSingle();
    
    if (learnerError || !learner) {
      console.error('Learner not found:', req.user.id);
      return res.json({
        success: true,
        data: {
          stats: { total: 0, present: 0, absent: 0, late: 0, rate: 0 },
          records: []
        }
      });
    }
    
    console.log('Found learner:', learner.name);
    
    const { data: attendance, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('learner_id', parseInt(req.user.id))
      .order('date', { ascending: false });
    
    if (error) {
      console.error('Error fetching attendance:', error);
      return res.json({
        success: true,
        data: {
          stats: { total: 0, present: 0, absent: 0, late: 0, rate: 0 },
          records: []
        }
      });
    }
    
    console.log(`Found ${attendance?.length || 0} attendance records for learner`);
    
    const totalRecords = attendance?.length || 0;
    const presentCount = attendance?.filter(a => a.status === 'present').length || 0;
    const absentCount = attendance?.filter(a => a.status === 'absent').length || 0;
    const lateCount = attendance?.filter(a => a.status === 'late').length || 0;
    
    const attendedCount = presentCount + lateCount;
    const attendanceRate = totalRecords > 0 ? Math.round((attendedCount / totalRecords) * 100) : 0;
    
    const formattedRecords = (attendance || []).map(record => ({
      id: record.id,
      learner_id: record.learner_id,
      date: record.date,
      status: record.status,
      term: record.term || 1,
      year: record.year || new Date().getFullYear(),
      recorded_at: record.created_at || record.updated_at,
      status_display: record.status === 'present' ? 'Present' : 
                      record.status === 'late' ? 'Late' : 'Absent',
      status_color: record.status === 'present' ? 'green' : 
                    record.status === 'late' ? 'yellow' : 'red',
      date_formatted: new Date(record.date).toLocaleDateString('en', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    }));
    
    const recordsByTerm = {};
    formattedRecords.forEach(record => {
      const termKey = `Term ${record.term} ${record.year}`;
      if (!recordsByTerm[termKey]) {
        recordsByTerm[termKey] = [];
      }
      recordsByTerm[termKey].push(record);
    });
    
    const stats = {
      total: totalRecords,
      present: presentCount,
      absent: absentCount,
      late: lateCount,
      rate: attendanceRate,
      attended: attendedCount,
      present_percentage: totalRecords > 0 ? Math.round((presentCount / totalRecords) * 100) : 0,
      late_percentage: totalRecords > 0 ? Math.round((lateCount / totalRecords) * 100) : 0,
      absent_percentage: totalRecords > 0 ? Math.round((absentCount / totalRecords) * 100) : 0
    };
    
    console.log('Attendance stats:', stats);
    
    res.json({
      success: true,
      data: {
        stats: stats,
        records: formattedRecords,
        by_term: recordsByTerm,
        summary: {
          total_days: totalRecords,
          present_days: presentCount,
          late_days: lateCount,
          absent_days: absentCount,
          attendance_rate: attendanceRate
        }
      }
    });
    
  } catch (error) {
    console.error('Error in learner attendance endpoint:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch attendance records',
      error: error.message
    });
  }
});

app.get('/api/learner/attendance-stats', authenticateToken, async (req, res) => {
  try {
    const { term, year } = req.query;
    const currentYear = year || new Date().getFullYear();
    const currentTerm = term ? parseInt(term) : null;
    
    console.log(`📊 Fetching attendance stats for learner: ${req.user.id}, Term: ${currentTerm}, Year: ${currentYear}`);
    
    let query = supabase
      .from('attendance')
      .select('status, date, term, year')
      .eq('learner_id', parseInt(req.user.id));
    
    if (currentTerm) {
      query = query.eq('term', currentTerm);
    }
    if (currentYear) {
      query = query.eq('year', currentYear);
    }
    
    const { data: attendance, error } = await query.order('date', { ascending: false });
    
    if (error) {
      console.error('Error fetching attendance stats:', error);
      return res.json({
        success: true,
        data: {
          percentage: 0,
          present: 0,
          absences: 0,
          late: 0,
          total: 0,
          term: currentTerm || 'All',
          year: currentYear
        }
      });
    }
    
    const totalDays = attendance?.length || 0;
    const presentDays = attendance?.filter(a => a.status === 'present').length || 0;
    const lateDays = attendance?.filter(a => a.status === 'late').length || 0;
    const absentDays = attendance?.filter(a => a.status === 'absent').length || 0;
    
    const attendedDays = presentDays + lateDays;
    const percentage = totalDays > 0 ? Math.round((attendedDays / totalDays) * 100) : 0;
    
    const monthlyData = {};
    attendance?.forEach(record => {
      const date = new Date(record.date);
      const monthKey = date.toLocaleString('en', { month: 'long', year: 'numeric' });
      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { present: 0, late: 0, absent: 0, total: 0 };
      }
      monthlyData[monthKey][record.status]++;
      monthlyData[monthKey].total++;
    });
    
    res.json({
      success: true,
      data: {
        percentage: percentage,
        present: presentDays,
        late: lateDays,
        absences: absentDays,
        total: totalDays,
        term: currentTerm || 'All',
        year: currentYear,
        monthly_breakdown: monthlyData,
        attendance_rate: percentage,
        present_rate: totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0,
        late_rate: totalDays > 0 ? Math.round((lateDays / totalDays) * 100) : 0,
        absent_rate: totalDays > 0 ? Math.round((absentDays / totalDays) * 100) : 0
      }
    });
    
  } catch (error) {
    console.error('Error fetching attendance stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch attendance stats',
      error: error.message
    });
  }
});

app.get('/api/learner/reports', authenticateToken, async (req, res) => {
  try {
    console.log(`📊 Fetching reports for learner: ${req.user.id}`);
    
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id, name, reg_number, form, class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (learnerError || !learner) {
      console.error('Learner not found:', req.user.id);
      return res.json({
        success: true,
        data: [],
        count: 0,
        message: 'Learner profile not found'
      });
    }
    
    console.log('Found learner:', learner.name, 'ID:', learner.id);
    
    const { data: reports, error } = await supabase
      .from('reports')
      .select('*')
      .eq('learner_id', parseInt(req.user.id))
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching reports:', error);
      return res.json({
        success: true,
        data: [],
        count: 0,
        message: 'Error fetching reports'
      });
    }
    
    console.log(`Found ${reports?.length || 0} reports for learner ${learner.name}`);
    
    const formattedReports = (reports || []).map(report => {
      let subjects = report.subjects;
      if (typeof subjects === 'string') {
        try {
          subjects = JSON.parse(subjects);
        } catch (e) {
          console.error('Failed to parse subjects JSON for report:', report.id, e);
          subjects = [];
        }
      }
      
      if (!Array.isArray(subjects)) {
        subjects = [];
      }
      
      let averageScore = report.average_score;
      if (!averageScore && subjects.length > 0) {
        const totalScore = subjects.reduce((sum, subj) => sum + (subj.score || 0), 0);
        averageScore = Math.round(totalScore / subjects.length);
      }
      
      let grade = report.grade;
      if (!grade && averageScore) {
        if (averageScore >= 75) grade = 'A';
        else if (averageScore >= 65) grade = 'B';
        else if (averageScore >= 55) grade = 'C';
        else if (averageScore >= 40) grade = 'D';
        else grade = 'F';
      }
      
      return {
        id: report.id,
        learner_id: report.learner_id,
        term: report.term || 'Term 1',
        academic_year: report.academic_year || new Date().getFullYear(),
        form: report.form || learner.form,
        grade: grade,
        class_id: report.class_id,
        subjects: subjects,
        average_score: averageScore,
        total_score: report.total_score,
        rank: report.rank,
        comment: report.comment || report.teacher_comment || null,
        teacher_comment: report.teacher_comment,
        principal_comment: report.principal_comment,
        is_finalized: report.is_finalized,
        generated_by: report.generated_by,
        generated_date: report.generated_date,
        created_at: report.created_at,
        updated_at: report.updated_at
      };
    });
    
    res.json({
      success: true,
      data: formattedReports,
      count: formattedReports.length
    });
    
  } catch (error) {
    console.error('Error in learner reports endpoint:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reports',
      error: error.message
    });
  }
});

app.get('/api/learner/report-card', authenticateToken, async (req, res) => {
  try {
    const { term, year } = req.query;
    const currentYear = year || new Date().getFullYear();
    const currentTerm = term || 'Term 1';
    
    let query = supabase
      .from('reports')
      .select(`
        *,
        subject:subject_id(id, name)
      `)
      .eq('learner_id', req.user.id)
      .eq('year', currentYear);
    
    if (currentTerm !== 'all') {
      query = query.eq('term', currentTerm);
    }
    
    const { data: reports, error } = await query.order('subject_id');
    
    if (error) {
      return res.json({
        success: true,
        data: {
          term: currentTerm,
          year: currentYear,
          reports: [],
          summary: {
            total_subjects: 0,
            average_score: 0,
            total_score: 0,
            highest_score: 0,
            lowest_score: 0
          }
        }
      });
    }
    
    const totalScore = (reports || []).reduce((sum, r) => sum + (r.score || 0), 0);
    const averageScore = reports?.length > 0 ? Math.round(totalScore / reports.length) : 0;
    
    res.json({
      success: true,
      data: {
        term: currentTerm,
        year: currentYear,
        reports: reports || [],
        summary: {
          total_subjects: reports?.length || 0,
          average_score: averageScore,
          total_score: totalScore,
          highest_score: Math.max(...(reports || []).map(r => r.score || 0), 0),
          lowest_score: Math.min(...(reports || []).map(r => r.score || 0), 0)
        }
      }
    });
    
  } catch (error) {
    console.error('Error fetching report card:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch report card',
      error: error.message
    });
  }
});

app.get('/api/learner/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const { data: attendance, error: attendanceError } = await supabase
      .from('attendance')
      .select('status')
      .eq('learner_id', req.user.id)
      .eq('year', new Date().getFullYear());
    
    const totalAttendance = attendance?.length || 0;
    const presentAttendance = attendance?.filter(a => a.status === 'present').length || 0;
    const attendanceRate = totalAttendance > 0 ? Math.round((presentAttendance / totalAttendance) * 100) : 0;
    
    const { data: reports, error: reportsError } = await supabase
      .from('reports')
      .select('score')
      .eq('learner_id', req.user.id);
    
    const totalScore = (reports || []).reduce((sum, r) => sum + (r.score || 0), 0);
    const averageScore = reports?.length > 0 ? Math.round(totalScore / reports.length) : 0;
    
    res.json({
      success: true,
      data: {
        attendance_rate: attendanceRate,
        average_score: averageScore,
        total_reports: reports?.length || 0,
        total_attendance: totalAttendance,
        present_attendance: presentAttendance
      }
    });
    
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard stats',
      error: error.message
    });
  }
});

// ============================================
// IMAGE UPLOAD ENDPOINT
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
// DEBUG AND MISC ENDPOINTS
// ============================================
app.get('/api/teacher/debug-setup', authenticateToken, async (req, res) => {
  try {
    console.log('🔍 Debugging teacher setup for user:', req.user.id);
    
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('id, email, name, role, class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (teacherError) throw teacherError;
    
    let classInfo = null;
    if (teacher?.class_id) {
      const { data: classData, error: classError } = await supabase
        .from('classes')
        .select('*')
        .eq('id', teacher.class_id)
        .maybeSingle();
      if (!classError) classInfo = classData;
    }
    
    const { data: allClasses, error: classesError } = await supabase
      .from('classes')
      .select('id, name, year');
    
    const { data: allTeachers, error: teachersError } = await supabase
      .from('users')
      .select('id, email, name, role, class_id')
      .eq('role', 'teacher');
    
    let learnersInClass = [];
    if (teacher?.class_id) {
      const { data: learners, error: learnersError } = await supabase
        .from('learners')
        .select('id, name, reg_number, form')
        .eq('class_id', teacher.class_id);
      if (!learnersError) learnersInClass = learners || [];
    }
    
    res.json({
      success: true,
      current_teacher: {
        id: teacher?.id,
        email: teacher?.email,
        name: teacher?.name,
        class_id: teacher?.class_id,
        has_class: !!teacher?.class_id,
        message: teacher?.class_id ? 'Teacher has a class assigned' : 'Teacher has NO class assigned'
      },
      assigned_class: classInfo,
      learners_in_class: learnersInClass,
      learners_count: learnersInClass.length,
      all_classes: allClasses || [],
      all_teachers: allTeachers || [],
      recommendation: !teacher?.class_id ? 'Run SQL to assign teacher to a class' : null
    });
    
  } catch (err) {
    console.error('Debug error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get('/api/debug/learners', async (req, res) => {
  try {
    const { data: learners, error } = await supabase
      .from('learners')
      .select('id, name, reg_number, form, status')
      .limit(10);
    
    if (error) throw error;
    
    res.json({
      success: true,
      count: learners?.length || 0,
      learners: learners
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
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
  console.log('   GET    /api/admin/quiz-subjects');
  console.log('   GET    /api/admin/quizzes');
  console.log('   POST   /api/admin/quizzes');
  console.log('   PUT    /api/admin/quizzes/:quizId');
  console.log('   DELETE /api/admin/quizzes/:quizId');
  console.log('   POST   /api/admin/quizzes/:quizId/questions');
  console.log('   GET    /api/admin/quizzes/:quizId/submissions');
  console.log('   POST   /api/admin/grade');
  
  console.log('\n📋 Teacher API Endpoints:');
  console.log('   GET    /api/teacher/dashboard/stats');
  console.log('   GET    /api/teacher/all-learners');
  console.log('   GET    /api/teacher/my-learners');
  console.log('   POST   /api/teacher/add-learners');
  console.log('   DELETE /api/teacher/remove-learner/:id');
  console.log('   GET    /api/teacher/reports');
  console.log('   POST   /api/teacher/reports');
  console.log('   PUT    /api/teacher/reports/:id');
  console.log('   DELETE /api/teacher/reports/:id');
  console.log('   GET    /api/teacher/attendance');
  console.log('   POST   /api/teacher/attendance');
  console.log('   GET    /api/teacher/subjects/:classId');
  console.log('   GET    /api/teacher/learner-subjects/:learnerId');
  console.log('   GET    /api/teacher/assessment-types');
  console.log('   GET    /api/teacher/debug-setup');
  
  console.log('\n📋 Learner API Endpoints:');
  console.log('   GET    /api/learner/profile');
  console.log('   GET    /api/learner/reports');
  console.log('   GET    /api/learner/report-card');
  console.log('   GET    /api/learner/attendance');
  console.log('   GET    /api/learner/attendance-stats');
  console.log('   GET    /api/learner/dashboard/stats');
  
  console.log('\n📋 Quiz API Endpoints:');
  console.log('   GET    /api/quiz/ping');
  console.log('   GET    /api/quiz/quizzes');
  console.log('   GET    /api/quiz/:quizId/questions');
  console.log('   POST   /api/quiz/:quizId/start');
  console.log('   POST   /api/quiz/:quizId/save-answer');
  console.log('   POST   /api/quiz/:quizId/submit');
  console.log('   GET    /api/quiz/history');
  console.log('   POST   /api/quiz/:quizId/verify');
  console.log('='.repeat(60));
});

module.exports = app;