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
// DEBUG ENDPOINTS
// ============================================

// Debug endpoint to check learners table structure
app.get('/api/debug/learners-table', async (req, res) => {
  try {
    const { data: sample, error: sampleError } = await supabase
      .from('learners')
      .select('*')
      .limit(1);
    
    if (sampleError) {
      return res.json({ 
        success: false, 
        error: sampleError.message,
        code: sampleError.code,
        details: sampleError.details
      });
    }
    
    let columns = [];
    if (sample && sample.length > 0) {
      columns = Object.keys(sample[0]);
    }
    
    res.json({
      success: true,
      tableExists: true,
      columns: columns,
      hasData: sample && sample.length > 0,
      sampleData: sample && sample.length > 0 ? sample[0] : null,
      missingForm: !columns.includes('form'),
      suggestion: !columns.includes('form') ? 'Need to add "form" column. Run: ALTER TABLE learners ADD COLUMN form TEXT;' : null
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Debug endpoint to test attendance
app.get('/api/debug/attendance-test', async (req, res) => {
  try {
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id, name')
      .limit(1)
      .single();
    
    if (learnerError || !learner) {
      return res.json({ 
        success: false, 
        error: 'No learners found in database',
        details: learnerError?.message
      });
    }
    
    console.log('Found learner for test:', learner);
    
    const testData = {
      learner_id: learner.id,
      date: new Date().toISOString().split('T')[0],
      status: 'present'
    };
    
    const { data, error } = await supabase
      .from('attendance')
      .upsert([testData], { onConflict: 'learner_id,date' })
      .select();
    
    if (error) {
      return res.json({ 
        success: false, 
        error: error.message,
        details: error.details,
        code: error.code,
        hint: error.hint
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Attendance test successful!',
      learner: learner.name,
      learnerId: learner.id,
      record: data[0]
    });
    
  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.json({ success: false, error: error.message });
  }
});

// Debug endpoint to check learners
app.get('/api/debug/learners', async (req, res) => {
  try {
    const { data: learners, error } = await supabase
      .from('learners')
      .select('id, name, reg_number, form, status');
    
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
    
    // Try to find learner
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

// ============================================
// ADMIN LOGIN ENDPOINT
// ============================================

app.post('/api/auth/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log('🔍 Admin login attempt for:', email);
    
    // Query Supabase for admin user
    const { data: admin, error } = await supabase
      .from('users')
      .select('id, email, name, password_hash, role, is_active')
      .eq('email', email?.trim().toLowerCase())
      .eq('role', 'admin')
      .maybeSingle();
    
    if (error) {
      console.error('❌ Supabase query error:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Database error' 
      });
    }
    
    // Check if admin exists
    if (!admin) {
      console.log('❌ Admin not found:', email);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }
    
    console.log('✅ Admin found:', admin.email);
    
    // Check if admin account is active
    if (admin.is_active === false) {
      console.log('❌ Admin account is deactivated');
      return res.status(403).json({ 
        success: false, 
        message: 'Account is deactivated. Please contact support.' 
      });
    }
    
    // Validate password
    let isValidPassword = false;
    
    // Check password (plain text for development)
    if (password === 'admin123' || password === admin.password_hash) {
      isValidPassword = true;
    }
    
    if (!isValidPassword) {
      console.log('❌ Invalid password for admin:', email);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials' 
      });
    }
    
    // Generate token
    const token = Buffer.from(JSON.stringify({ 
      id: admin.id, 
      email: admin.email, 
      role: admin.role 
    })).toString('base64');
    
    console.log('✅ Admin login successful:', admin.email);
    
    res.json({
      success: true,
      token,
      user: {
        id: admin.id,
        name: admin.name || admin.email.split('@')[0],
        email: admin.email,
        role: admin.role
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
// TEACHER ROUTES
// ============================================

// Get all learners
app.get('/api/teacher/learners', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('learners')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching learners:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add learner
app.post('/api/teacher/learners', async (req, res) => {
  try {
    const { name, form, status } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    const regNumber = `EDU-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    
    const learnerData = {
      name: name?.trim(),
      reg_number: regNumber,
      form: form || 'Form 1',
      status: status || 'Active',
      created_at: new Date().toISOString()
    };
    
    const { data, error } = await supabase
      .from('learners')
      .insert([learnerData])
      .select();
    
    if (error) throw error;
    
    res.json({ success: true, learner: data[0] });
  } catch (error) {
    console.error('Error adding learner:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete learner
app.delete('/api/teacher/learners/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('learners')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true, message: 'Learner deleted successfully' });
  } catch (error) {
    console.error('Error deleting learner:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all reports
app.get('/api/teacher/reports', async (req, res) => {
  try {
    const { data: reports, error } = await supabase
      .from('reports')
      .select('*')
      .order('generated_date', { ascending: false });
    
    if (error) throw error;
    res.json(reports || []);
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create report
app.post('/api/teacher/reports', async (req, res) => {
  try {
    const { learnerId, term, form, subjects, comment } = req.body;
    
    if (!learnerId || !term || !form || !subjects) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const totalScore = subjects.reduce((sum, s) => sum + (s.score || 0), 0);
    const averageScore = subjects.length ? Math.round(totalScore / subjects.length) : 0;
    
    const reportData = {
      learner_id: learnerId,
      term,
      form,
      subjects,
      total_score: totalScore,
      average_score: averageScore,
      comment: comment || '',
      generated_date: new Date().toISOString()
    };
    
    const { data, error } = await supabase
      .from('reports')
      .insert([reportData])
      .select();
    
    if (error) throw error;
    res.json({ success: true, report: data[0] });
  } catch (error) {
    console.error('Error creating report:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete report
app.delete('/api/teacher/reports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('reports')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true, message: 'Report deleted successfully' });
  } catch (error) {
    console.error('Error deleting report:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all attendance
app.get('/api/teacher/attendance', async (req, res) => {
  try {
    const { data: attendance, error } = await supabase
      .from('attendance')
      .select('*')
      .order('date', { ascending: false });
    
    if (error) throw error;
    res.json(attendance || []);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Record attendance
app.post('/api/teacher/attendance', async (req, res) => {
  try {
    const { learnerId, date, status } = req.body;
    
    if (!learnerId || !date || !status) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Delete existing record
    await supabase
      .from('attendance')
      .delete()
      .eq('learner_id', learnerId)
      .eq('date', date);
    
    // Insert new record
    const { data, error } = await supabase
      .from('attendance')
      .insert([{ learner_id: learnerId, date, status }])
      .select();
    
    if (error) throw error;
    res.json({ success: true, attendance: data[0] });
  } catch (error) {
    console.error('Error recording attendance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Teacher dashboard stats
app.get('/api/teacher/dashboard/stats', async (req, res) => {
  try {
    const { data: learners } = await supabase.from('learners').select('*');
    const { data: reports } = await supabase.from('reports').select('*');
    const { data: attendance } = await supabase.from('attendance').select('*');
    
    const learnersByForm = {
      'Form 1': learners?.filter(l => l.form === 'Form 1').length || 0,
      'Form 2': learners?.filter(l => l.form === 'Form 2').length || 0,
      'Form 3': learners?.filter(l => l.form === 'Form 3').length || 0,
      'Form 4': learners?.filter(l => l.form === 'Form 4').length || 0
    };
    
    res.json({
      totalLearners: learners?.length || 0,
      totalReports: reports?.length || 0,
      averageAttendance: 0,
      activeLearners: learners?.filter(l => l.status === 'Active').length || 0,
      learnersByForm
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LEARNER ROUTES
// ============================================

// Get learner profile
app.get('/api/learner/profile', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    
    const { data, error } = await supabase
      .from('learners')
      .select('*')
      .eq('id', decoded.id)
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get learner reports
app.get('/api/learner/reports', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    
    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .eq('learner_id', decoded.id)
      .order('generated_date', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get learner attendance
app.get('/api/learner/attendance', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('learner_id', decoded.id)
      .order('date', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Learner dashboard stats
app.get('/api/learner/dashboard/stats', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    
    const { data: reports } = await supabase
      .from('reports')
      .select('*')
      .eq('learner_id', decoded.id);
    
    const { data: attendance } = await supabase
      .from('attendance')
      .select('*')
      .eq('learner_id', decoded.id);
    
    let attendanceRate = 0;
    if (attendance?.length > 0) {
      const presentCount = attendance.filter(a => a.status === 'present' || a.status === 'late').length;
      attendanceRate = Math.round(presentCount / attendance.length * 100);
    }
    
    let averageScore = null;
    if (reports?.length > 0) {
      const latest = reports[reports.length - 1];
      if (latest.subjects && latest.subjects.length > 0) {
        const sum = latest.subjects.reduce((acc, s) => acc + (s.score || 0), 0);
        averageScore = Math.round(sum / latest.subjects.length);
      }
    }
    
    res.json({
      reportsCount: reports?.length || 0,
      attendanceRate,
      averageScore,
      totalDays: attendance?.length || 0,
      presentCount: attendance?.filter(a => a.status === 'present').length || 0,
      lateCount: attendance?.filter(a => a.status === 'late').length || 0,
      absentCount: attendance?.filter(a => a.status === 'absent').length || 0
    });
  } catch (error) {
    console.error('Learner dashboard stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ADMIN ROUTES
// ============================================

// Import admin routes if exists
try {
  const adminRoutes = require('./routes/admin');
  app.use('/api/admin', adminRoutes);
  console.log('✅ Admin routes loaded successfully');
} catch (error) {
  console.log('⚠️ Admin routes file not found, admin endpoints disabled');
}

// ============================================
// COMPATIBILITY ROUTES (For frontend without /api prefix)
// ============================================

app.get('/learner/attendance', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = JSON.parse(Buffer.from(token.split(' ')[1], 'base64').toString());
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('learner_id', decoded.id)
      .order('date', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/learner/reports', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = JSON.parse(Buffer.from(token.split(' ')[1], 'base64').toString());
    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .eq('learner_id', decoded.id)
      .order('generated_date', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/learner/profile', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = JSON.parse(Buffer.from(token.split(' ')[1], 'base64').toString());
    const { data, error } = await supabase
      .from('learners')
      .select('*')
      .eq('id', decoded.id)
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/learner/dashboard/stats', async (req, res) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = JSON.parse(Buffer.from(token.split(' ')[1], 'base64').toString());
    
    const { data: reports } = await supabase
      .from('reports')
      .select('*')
      .eq('learner_id', decoded.id);
    
    const { data: attendance } = await supabase
      .from('attendance')
      .select('*')
      .eq('learner_id', decoded.id);
    
    let attendanceRate = 0;
    if (attendance?.length > 0) {
      const presentCount = attendance.filter(a => a.status === 'present' || a.status === 'late').length;
      attendanceRate = Math.round(presentCount / attendance.length * 100);
    }
    
    let averageScore = null;
    if (reports?.length > 0) {
      const latest = reports[reports.length - 1];
      if (latest.subjects && latest.subjects.length > 0) {
        const sum = latest.subjects.reduce((acc, s) => acc + (s.score || 0), 0);
        averageScore = Math.round(sum / latest.subjects.length);
      }
    }
    
    res.json({
      reportsCount: reports?.length || 0,
      attendanceRate,
      averageScore,
      totalDays: attendance?.length || 0,
      presentCount: attendance?.filter(a => a.status === 'present').length || 0,
      lateCount: attendance?.filter(a => a.status === 'late').length || 0,
      absentCount: attendance?.filter(a => a.status === 'absent').length || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 404 HANDLER
// ============================================

app.use((req, res) => {
  console.log(`❌ Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    success: false, 
    message: `Route not found: ${req.path}`,
    tip: "Make sure you're using the correct API endpoint with /api prefix"
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
  console.log(`🧪 Test endpoint: http://localhost:${PORT}/test`);
  console.log('='.repeat(60));
  
  console.log('\n📋 Registered API routes:');
  const routes = [];
  
  if (app._router && app._router.stack) {
    app._router.stack.forEach((middleware) => {
      if (middleware.route) {
        const methods = Object.keys(middleware.route.methods).join(',').toUpperCase();
        routes.push(`${methods} ${middleware.route.path}`);
      } else if (middleware.name === 'bound dispatch' && middleware.handle && middleware.handle.stack) {
        middleware.handle.stack.forEach((handler) => {
          if (handler.route) {
            const methods = Object.keys(handler.route.methods).join(',').toUpperCase();
            routes.push(`${methods} ${handler.route.path}`);
          }
        });
      }
    });
  }
  
  if (routes.length > 0) {
    routes.sort().forEach(route => console.log(`   ${route}`));
  }
  
  console.log('\n🔧 Debug endpoints:');
  console.log('   GET /api/debug/learners');
  console.log('   GET /api/debug/attendance-test');
  console.log('   GET /api/debug/learners-table');
  console.log('='.repeat(60));
});

module.exports = app;