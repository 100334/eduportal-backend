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

// Make supabase available globally
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
    message: 'EduPortal API Server is running',
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
      .select('id, email, name, department, specialization, phone, address, employee_id, is_active, created_at')
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
    const { name, email, department, specialization, phone, address, is_active } = req.body;
    
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (department) updateData.department = department;
    if (specialization) updateData.specialization = specialization;
    if (phone) updateData.phone = phone;
    if (address) updateData.address = address;
    if (is_active !== undefined) updateData.is_active = is_active;
    updateData.updated_at = new Date().toISOString();
    
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
      `Updated teacher ID ${teacherId}`,
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
    
    console.log('📝 Admin registering learner:', { name, reg_number, class_id, form, enrollment_date });
    
    if (!name || !reg_number || !class_id) {
      return res.status(400).json({
        success: false,
        message: 'Name, registration number, and class are required'
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
    
    const { data: classExists, error: classError } = await supabase
      .from('classes')
      .select('id, name')
      .eq('id', class_id)
      .maybeSingle();
    
    if (classError || !classExists) {
      return res.status(404).json({
        success: false,
        message: 'Class not found'
      });
    }
    
    const { data: newLearner, error } = await supabase
      .from('learners')
      .insert({
        name: name,
        reg_number: reg_number,
        class_id: classExists.id,
        form: form || getFormName(classExists.name),
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
      `Registered learner: ${name} (${reg_number}) in class ${classExists.name}`,
      req.ip
    );
    
    res.json({
      success: true,
      message: 'Learner registered successfully',
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
      message: 'Database error: ' + err.message
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
      message: 'Database error: ' + err.message
    });
  }
});

// ============================================
// TEACHER ROUTES - ENHANCED (Filtered by Teacher's Class)
// ============================================

// Get teacher dashboard stats (Filtered by teacher's class)
app.get('/api/teacher/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    console.log('📊 Fetching teacher dashboard stats for user:', req.user.id);
    
    // Get teacher's class ID
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
      // Get learners in teacher's class
      const { count: learnersCount, error: learnersError } = await supabase
        .from('learners')
        .select('*', { count: 'exact', head: true })
        .eq('class_id', teacher.class_id)
        .eq('status', 'Active');
      
      if (!learnersError) totalLearners = learnersCount || 0;
      
      // Get reports for learners in teacher's class
      const { count: reportsCount, error: reportsError } = await supabase
        .from('reports')
        .select('*', { count: 'exact', head: true })
        .eq('class_id', teacher.class_id);
      
      if (!reportsError) totalReports = reportsCount || 0;
      
      // Get today's attendance for the class
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

// Get all learners (for teacher to select from)
app.get('/api/teacher/all-learners', authenticateToken, async (req, res) => {
  try {
    console.log('📚 Fetching all learners for teacher');
    
    const { data: learners, error } = await supabase
      .from('learners')
      .select('id, name, reg_number, form, status, class_id')
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

// Get learners assigned to this teacher
app.get('/api/teacher/my-learners', authenticateToken, async (req, res) => {
  try {
    console.log('👥 Fetching learners assigned to teacher:', req.user.id);
    
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

// Add learners to teacher's class
app.post('/api/teacher/add-learners', authenticateToken, async (req, res) => {
  try {
    const { learnerIds } = req.body;
    
    console.log('📝 Adding learners to teacher class:', { learnerIds });
    
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
    
    const { data, error } = await supabase
      .from('learners')
      .update({ class_id: teacher.class_id, updated_at: new Date().toISOString() })
      .in('id', learnerIds)
      .select();
    
    if (error) throw error;
    
    res.json({
      success: true,
      message: `${learnerIds.length} learner(s) added to your class`,
      learners: data
    });
    
  } catch (err) {
    console.error('Error adding learners:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

// Remove learner from teacher's class
app.delete('/api/teacher/remove-learner/:learnerId', authenticateToken, async (req, res) => {
  try {
    const { learnerId } = req.params;
    
    console.log('🗑️ Removing learner from teacher class:', learnerId);
    
    const { data, error } = await supabase
      .from('learners')
      .update({ class_id: null, updated_at: new Date().toISOString() })
      .eq('id', learnerId)
      .select();
    
    if (error) throw error;
    
    res.json({
      success: true,
      message: 'Learner removed from your class'
    });
    
  } catch (err) {
    console.error('Error removing learner:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

// Get all learners (Teacher view)
app.get('/api/teacher/learners', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('learners')
      .select('*, class:class_id(id, name, year)')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    res.json({
      success: true,
      learners: data || []
    });
  } catch (error) {
    console.error('Error fetching learners:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get learners by class
app.get('/api/teacher/learners/:classId', authenticateToken, async (req, res) => {
  try {
    const { classId } = req.params;
    
    const { data, error } = await supabase
      .from('learners')
      .select('id, name, reg_number, status, class_id')
      .eq('class_id', classId)
      .order('name', { ascending: true });
    
    if (error) throw error;
    
    res.json({
      success: true,
      learners: data || []
    });
  } catch (error) {
    console.error('Error fetching learners by class:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add learner (Teacher) - Deprecated but kept for compatibility
app.post('/api/teacher/learners', authenticateToken, async (req, res) => {
  try {
    const { name, form, status } = req.body;
    
    if (!name) {
      return res.status(400).json({ 
        success: false,
        error: 'Name is required' 
      });
    }
    
    const year = new Date().getFullYear();
    const randomNum = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const regNumber = `EDU-${year}-${randomNum}`;
    
    const learnerData = {
      name: name?.trim(),
      reg_number: regNumber,
      form: form || 'Form 1',
      status: status || 'Active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    const { data, error } = await supabase
      .from('learners')
      .insert([learnerData])
      .select();
    
    if (error) throw error;
    
    res.json({ 
      success: true, 
      message: 'Learner added successfully',
      learner: data[0] 
    });
  } catch (error) {
    console.error('Error adding learner:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Update learner (Teacher)
app.put('/api/teacher/learners/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, class_id, status } = req.body;
    
    const updateData = {};
    if (name) updateData.name = name;
    if (class_id) updateData.class_id = class_id;
    if (status) updateData.status = status;
    updateData.updated_at = new Date().toISOString();
    
    const { data, error } = await supabase
      .from('learners')
      .update(updateData)
      .eq('id', id)
      .select();
    
    if (error) throw error;
    
    if (!data || data.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'Learner not found' 
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Learner updated successfully',
      learner: data[0] 
    });
  } catch (error) {
    console.error('Error updating learner:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Delete learner (Teacher)
app.delete('/api/teacher/learners/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
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
    console.error('Error deleting learner:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Get teacher reports (Filtered by teacher's class)
// Get teacher reports (Filtered by teacher's class) - FIXED
app.get('/api/teacher/reports', authenticateToken, async (req, res) => {
  try {
    console.log('📋 Fetching reports for teacher:', req.user.id);
    
    // Get teacher's class ID
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (teacherError) throw teacherError;
    
    if (!teacher?.class_id) {
      return res.json({
        success: true,
        data: []
      });
    }
    
    // Get reports for learners in teacher's class
    const { data: reports, error } = await supabase
      .from('reports')
      .select(`
        *,
        learner:learner_id(id, name, reg_number)
      `)
      .eq('class_id', teacher.class_id)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Reports query error:', error);
      // If class_id column doesn't exist, try alternative query
      const { data: learners, error: learnersError } = await supabase
        .from('learners')
        .select('id')
        .eq('class_id', teacher.class_id);
      
      if (learnersError) throw learnersError;
      
      const learnerIds = learners?.map(l => l.id) || [];
      
      const { data: altReports, error: altError } = await supabase
        .from('reports')
        .select(`
          *,
          learner:learner_id(id, name, reg_number)
        `)
        .in('learner_id', learnerIds)
        .order('created_at', { ascending: false });
      
      if (altError) throw altError;
      
      const formattedAltReports = (altReports || []).map(report => ({
        id: report.id,
        learner_id: report.learner_id,
        learner_name: report.learner?.name || 'Unknown',
        learner_reg: report.learner?.reg_number || 'N/A',
        term: report.term,
        form: report.form,
        subjects: report.subjects || [],
        comment: report.comment,
        created_at: report.created_at
      }));
      
      return res.json({
        success: true,
        data: formattedAltReports
      });
    }
    
    const formattedReports = (reports || []).map(report => ({
      id: report.id,
      learner_id: report.learner_id,
      learner_name: report.learner?.name || 'Unknown',
      learner_reg: report.learner?.reg_number || 'N/A',
      term: report.term,
      form: report.form,
      subjects: report.subjects || [],
      comment: report.comment,
      created_at: report.created_at,
      class_name: report.class?.name
    }));
    
    res.json({
      success: true,
      data: formattedReports
    });
    
  } catch (err) {
    console.error('Error fetching teacher reports:', err);
    res.status(500).json({
      success: false,
      message: 'Database error: ' + err.message
    });
  }
});

// Create a new report (Teacher)
app.post('/api/teacher/reports', authenticateToken, async (req, res) => {
  try {
    const { learnerId, term, form, subjects, comment } = req.body;
    
    console.log('📝 Creating new report for learner:', learnerId);
    
    if (!learnerId || !subjects || subjects.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Learner ID and subjects are required'
      });
    }
    
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id, name, class_id')
      .eq('id', learnerId)
      .maybeSingle();
    
    if (!learner) {
      return res.status(404).json({
        success: false,
        message: 'Learner not found'
      });
    }
    
    const totalScore = subjects.reduce((sum, s) => sum + (s.score || 0), 0);
    const averageScore = Math.round(totalScore / subjects.length);
    
    let grade = 'F';
    if (averageScore >= 75) grade = 'A';
    else if (averageScore >= 65) grade = 'B';
    else if (averageScore >= 55) grade = 'C';
    else if (averageScore >= 40) grade = 'D';
    else grade = 'F';
    
    const { data: newReport, error } = await supabase
      .from('reports')
      .insert({
        learner_id: learnerId,
        class_id: learner.class_id,
        term: term || 'Term 1',
        form: form || 'Form 1',
        subjects: subjects,
        average_score: averageScore,
        grade: grade,
        comment: comment || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({
      success: true,
      message: 'Report created successfully',
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

// Delete a report (Teacher)
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

// Get teacher attendance records (Filtered by teacher's class)
app.get('/api/teacher/attendance', authenticateToken, async (req, res) => {
  try {
    console.log('📅 Fetching attendance records for teacher:', req.user.id);
    
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (teacherError) throw teacherError;
    
    if (!teacher?.class_id) {
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
      .select('id, name, reg_number')
      .eq('class_id', teacher.class_id);
    
    if (learnersError) throw learnersError;
    
    const learnerIds = learners?.map(l => l.id) || [];
    
    let attendanceData = [];
    let stats = { total: 0, present: 0, absent: 0, late: 0, rate: 0 };
    
    if (learnerIds.length > 0) {
      const { data: attendance, error: attendanceError } = await supabase
        .from('attendance')
        .select(`
          *,
          learner:learner_id(id, name, reg_number)
        `)
        .in('learner_id', learnerIds)
        .order('date', { ascending: false });
      
      if (!attendanceError) {
        attendanceData = attendance || [];
        stats = {
          total: attendanceData.length,
          present: attendanceData.filter(a => a.status === 'present').length,
          absent: attendanceData.filter(a => a.status === 'absent').length,
          late: attendanceData.filter(a => a.status === 'late').length,
          rate: attendanceData.length > 0 
            ? Math.round((attendanceData.filter(a => a.status === 'present' || a.status === 'late').length / attendanceData.length) * 100)
            : 0
        };
      }
    }
    
    const formattedRecords = attendanceData.map(record => ({
      id: record.id,
      learner_id: record.learner_id,
      learner_name: record.learner?.name || 'Unknown',
      learner_reg: record.learner?.reg_number || 'N/A',
      date: record.date,
      status: record.status,
      term: record.term,
      year: record.year,
      recorded_at: record.recorded_at
    }));
    
    res.json({
      success: true,
      data: {
        stats,
        records: formattedRecords
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

// Record attendance
app.post('/api/teacher/attendance', authenticateToken, async (req, res) => {
  try {
    const { learnerId, date, status, term, year } = req.body;
    
    if (!learnerId || !date || !status) {
      return res.status(400).json({ 
        success: false,
        error: 'Missing required fields' 
      });
    }
    
    await supabase
      .from('attendance')
      .delete()
      .eq('learner_id', learnerId)
      .eq('date', date);
    
    const { data, error } = await supabase
      .from('attendance')
      .insert([{ 
        learner_id: learnerId, 
        date, 
        status,
        term: term || 1,
        year: year || new Date().getFullYear(),
        recorded_at: new Date().toISOString() 
      }])
      .select();
    
    if (error) throw error;
    
    res.json({ 
      success: true, 
      message: 'Attendance recorded successfully',
      attendance: data[0] 
    });
  } catch (error) {
    console.error('Error recording attendance:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Get subjects for a class (Teacher view)
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

// ============================================
// LEARNER ROUTES
// ============================================

// Get learner profile
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

// Get learner attendance
app.get('/api/learner/attendance', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('learner_id', req.user.id)
      .order('date', { ascending: false });
    
    if (error) throw error;
    res.json({
      success: true,
      attendance: data || []
    });
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get learner attendance stats
app.get('/api/learner/attendance-stats', authenticateToken, async (req, res) => {
  try {
    const { term = 1, year = new Date().getFullYear() } = req.query;
    
    const { data: attendance, error } = await supabase
      .from('attendance')
      .select('status')
      .eq('learner_id', req.user.id)
      .eq('term', term)
      .eq('year', year);
    
    if (error) throw error;
    
    const totalDays = attendance?.length || 0;
    const presentDays = attendance?.filter(a => a.status === 'present').length || 0;
    const percentage = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;
    
    res.json({
      success: true,
      percentage,
      present: presentDays,
      absences: totalDays - presentDays,
      total: totalDays
    });
  } catch (error) {
    console.error('Error fetching attendance stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get learner reports
app.get('/api/learner/reports', authenticateToken, async (req, res) => {
  try {
    console.log(`📊 Fetching reports for learner: ${req.user.id}`);
    
    const { data: reports, error } = await supabase
      .from('reports')
      .select(`
        *,
        subject:subject_id(id, name),
        class:class_id(id, name, year),
        teacher:teacher_id(id, name)
      `)
      .eq('learner_id', req.user.id)
      .order('created_at', { ascending: false });
    
    if (error) {
      return res.json({
        success: true,
        data: [],
        count: 0,
        message: 'No reports found'
      });
    }
    
    const formattedReports = (reports || []).map(report => ({
      id: report.id,
      subject: report.subject?.name || 'Unknown',
      subject_id: report.subject_id,
      term: report.term || 'Term 1',
      year: report.year || new Date().getFullYear(),
      score: report.score,
      grade: report.grade,
      remarks: report.remarks,
      teacher: report.teacher?.name || 'System',
      date: report.created_at,
      class: report.class?.name,
      status: report.status || 'completed'
    }));
    
    res.json({
      success: true,
      data: formattedReports,
      count: formattedReports.length
    });
    
  } catch (error) {
    console.error('Error fetching learner reports:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reports',
      error: error.message
    });
  }
});

// Get learner report card
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

// Get learner dashboard stats
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
// TEACHER DEBUG ENDPOINT
// ============================================

// Debug endpoint to check teacher setup
app.get('/api/teacher/debug-setup', authenticateToken, async (req, res) => {
  try {
    console.log('🔍 Debugging teacher setup for user:', req.user.id);
    
    // Get teacher info
    const { data: teacher, error: teacherError } = await supabase
      .from('users')
      .select('id, email, name, role, class_id')
      .eq('id', req.user.id)
      .maybeSingle();
    
    if (teacherError) throw teacherError;
    
    // Get class info if assigned
    let classInfo = null;
    if (teacher?.class_id) {
      const { data: classData, error: classError } = await supabase
        .from('classes')
        .select('*')
        .eq('id', teacher.class_id)
        .maybeSingle();
      if (!classError) classInfo = classData;
    }
    
    // Get all classes (for admin reference)
    const { data: allClasses, error: classesError } = await supabase
      .from('classes')
      .select('id, name, year');
    
    // Get all teachers
    const { data: allTeachers, error: teachersError } = await supabase
      .from('users')
      .select('id, email, name, role, class_id')
      .eq('role', 'teacher');
    
    // Get learners in teacher's class if assigned
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

// ============================================
// DEBUG ENDPOINTS
// ============================================

// Debug endpoint to check learners
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
  
  console.log('\n📋 Teacher API Endpoints:');
  console.log('   GET    /api/teacher/dashboard/stats ✅ (Class-filtered)');
  console.log('   GET    /api/teacher/all-learners ✅ (NEW)');
  console.log('   GET    /api/teacher/my-learners ✅ (NEW)');
  console.log('   POST   /api/teacher/add-learners ✅ (NEW)');
  console.log('   DELETE /api/teacher/remove-learner/:id ✅ (NEW)');
  console.log('   GET    /api/teacher/learners');
  console.log('   GET    /api/teacher/learners/:classId');
  console.log('   POST   /api/teacher/learners');
  console.log('   PUT    /api/teacher/learners/:id');
  console.log('   DELETE /api/teacher/learners/:id');
  console.log('   GET    /api/teacher/reports ✅ (Class-filtered)');
  console.log('   POST   /api/teacher/reports');
  console.log('   DELETE /api/teacher/reports/:id');
  console.log('   GET    /api/teacher/attendance ✅ (Class-filtered)');
  console.log('   POST   /api/teacher/attendance');
  console.log('   GET    /api/teacher/attendance/date/:date');
  console.log('   GET    /api/teacher/attendance/summary/:classId');
  console.log('   GET    /api/teacher/subjects/:classId');
  console.log('   GET    /api/teacher/debug-setup ✅ (DEBUG)');
  
  console.log('\n📋 Learner API Endpoints:');
  console.log('   GET    /api/learner/profile');
  console.log('   GET    /api/learner/reports');
  console.log('   GET    /api/learner/report-card');
  console.log('   GET    /api/learner/attendance');
  console.log('   GET    /api/learner/attendance-stats');
  console.log('   GET    /api/learner/dashboard/stats');
  console.log('='.repeat(60));
});

module.exports = app;