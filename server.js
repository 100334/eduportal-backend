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

// Debug endpoint to test attendance with integer IDs
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
    
    console.log('Test data:', testData);
    
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

// Debug endpoint to check learners - UPDATED to show form
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
    
    console.log('==================================================');
    console.log('🔍 TEACHER LOGIN ATTEMPT');
    console.log('Username:', username);
    console.log('==================================================');
    
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
      refreshToken: token,
      teacher: {
        id: teacher.id,
        name: teacher.name || teacher.email,
        email: teacher.email
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

// Learner login - UPDATED to use form
app.post('/api/auth/learner/login', async (req, res) => {
  try {
    const { name, regNumber } = req.body;
    
    console.log('==================================================');
    console.log('🔍 LEARNER LOGIN ATTEMPT');
    console.log('Request body:', { name, regNumber });
    
    const normalizedName = name?.trim().toLowerCase();
    const normalizedReg = regNumber?.trim().toUpperCase();
    
    console.log('Normalized - Name:', normalizedName);
    console.log('Normalized - Reg Number:', normalizedReg);
    console.log('==================================================');
    
    const { data: allLearners, error: listError } = await supabase
      .from('learners')
      .select('*');
    
    if (listError) {
      console.error('Error listing learners:', listError);
    } else {
      console.log(`📊 Total learners in database: ${allLearners?.length || 0}`);
      if (allLearners && allLearners.length > 0) {
        console.log('📋 All learners in DB (first 10):');
        allLearners.slice(0, 10).forEach(learner => {
          console.log(`   ID:${learner.id} | Name:${learner.name} | Reg:${learner.reg_number} | Form:${learner.form} | Status:${learner.status}`);
        });
      }
    }
    
    let learner = null;
    
    // Method 1: Try ILIKE for case-insensitive partial matching
    const { data: flexibleMatch, error: flexibleError } = await supabase
      .from('learners')
      .select('*')
      .ilike('name', `%${normalizedName}%`)
      .ilike('reg_number', `%${normalizedReg}%`)
      .eq('status', 'Active')
      .maybeSingle();
    
    if (flexibleError) {
      console.error('Flexible match query error:', flexibleError);
    } else if (flexibleMatch) {
      learner = flexibleMatch;
      console.log('✅ Found learner with flexible matching:', learner.name);
    }
    
    // Method 2: Try exact match with trim
    if (!learner) {
      const { data: exactMatch, error: exactError } = await supabase
        .from('learners')
        .select('*')
        .eq('name', name?.trim())
        .eq('reg_number', regNumber?.trim())
        .maybeSingle();
      
      if (exactError) {
        console.error('Exact match query error:', exactError);
      } else if (exactMatch) {
        learner = exactMatch;
        console.log('✅ Found learner with exact match:', learner.name);
      }
    }
    
    // Method 3: Try case-insensitive exact match
    if (!learner) {
      const { data: caseInsensitiveMatch, error: ciError } = await supabase
        .from('learners')
        .select('*')
        .ilike('name', normalizedName)
        .ilike('reg_number', normalizedReg)
        .maybeSingle();
      
      if (ciError) {
        console.error('Case-insensitive match query error:', ciError);
      } else if (caseInsensitiveMatch) {
        learner = caseInsensitiveMatch;
        console.log('✅ Found learner with case-insensitive match:', learner.name);
      }
    }
    
    if (!learner) {
      console.log('❌ No matching learner found');
      console.log('💡 Debug info:');
      console.log(`   Tried to match: Name="${normalizedName}", Reg="${normalizedReg}"`);
      if (allLearners && allLearners.length > 0) {
        console.log(`   Database entries: ${allLearners.map(l => `"${l.name}" (${l.reg_number})`).join(', ')}`);
      } else {
        console.log('   Database has no learners. Please add a learner first.');
      }
      
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid name or registration number. Please check and try again.' 
      });
    }
    
    console.log('✅ Learner found:', {
      id: learner.id,
      name: learner.name,
      reg: learner.reg_number,
      form: learner.form
    });
    
    const token = Buffer.from(JSON.stringify({ 
      id: learner.id, 
      name: learner.name, 
      role: 'learner' 
    })).toString('base64');
    
    res.json({
      success: true,
      token,
      learner: {
        id: learner.id,
        name: learner.name,
        reg: learner.reg_number,
        form: learner.form,
        status: learner.status
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
// TEACHER ROUTES - UPDATED TO USE FORM
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

// Add learner - UPDATED to use form
app.post('/api/teacher/learners', async (req, res) => {
  try {
    const { name, form, status } = req.body;
    
    const regNumber = `EDU-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    
    const { data, error } = await supabase
      .from('learners')
      .insert([{ name: name?.trim(), reg_number: regNumber, form, status }])
      .select();
    
    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: error.message });
    }
    
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

// ============================================
// REPORTS ROUTES - UPDATED TO USE FORM
// ============================================

// Get all reports - FIXED without foreign key join
app.get('/api/teacher/reports', async (req, res) => {
  try {
    // Fetch all reports without join
    const { data: reports, error } = await supabase
      .from('reports')
      .select('*')
      .order('generated_date', { ascending: false });
    
    if (error) {
      console.error('Error fetching reports:', error);
      return res.status(500).json({ error: error.message });
    }
    
    // If we have reports, get learner names separately
    if (reports && reports.length > 0) {
      const learnerIds = [...new Set(reports.map(r => r.learner_id).filter(Boolean))];
      
      if (learnerIds.length > 0) {
        const { data: learners, error: learnersError } = await supabase
          .from('learners')
          .select('id, name, reg_number, form')
          .in('id', learnerIds);
        
        if (!learnersError && learners) {
          const learnerMap = {};
          learners.forEach(learner => {
            learnerMap[learner.id] = learner;
          });
          
          const reportsWithLearners = reports.map(report => ({
            ...report,
            learners: learnerMap[report.learner_id] || null
          }));
          
          return res.json(reportsWithLearners);
        }
      }
    }
    
    res.json(reports || []);
  } catch (error) {
    console.error('Unexpected error in reports endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create report - UPDATED to use form
app.post('/api/teacher/reports', async (req, res) => {
  try {
    const { 
      learnerId, 
      term, 
      form, 
      subjects, 
      comment 
    } = req.body;
    
    console.log('📝 Creating report with data:', { 
      learnerId, 
      term, 
      form, 
      subjectsCount: subjects?.length
    });
    
    // Validate required fields
    if (!learnerId) {
      return res.status(400).json({ error: 'learnerId is required' });
    }
    if (!term) {
      return res.status(400).json({ error: 'term is required' });
    }
    if (!form) {
      return res.status(400).json({ error: 'form is required' });
    }
    if (!subjects || !Array.isArray(subjects)) {
      return res.status(400).json({ error: 'subjects must be an array' });
    }
    
    // Check if learner exists
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id, name')
      .eq('id', learnerId)
      .single();
    
    if (learnerError || !learner) {
      console.error('Learner not found:', learnerId);
      return res.status(404).json({ error: 'Learner not found' });
    }
    
    // Calculate scores
    const totalScore = subjects.reduce((sum, s) => sum + (s.score || 0), 0);
    const averageScore = subjects.length ? Math.round(totalScore / subjects.length) : 0;
    
    const reportData = {
      learner_id: learnerId,
      term: term,
      form: form,
      subjects: subjects,
      total_score: totalScore,
      average_score: averageScore,
      comment: comment || '',
      generated_date: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    console.log('📤 Inserting report:', reportData);
    
    const { data, error } = await supabase
      .from('reports')
      .insert([reportData])
      .select();
    
    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: error.message, details: error.details });
    }
    
    console.log('✅ Report created successfully:', data[0]?.id);
    res.json({ success: true, report: data[0] });
  } catch (error) {
    console.error('Error creating report:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single report by ID - UPDATED to include form
app.get('/api/teacher/reports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: report, error } = await supabase
      .from('reports')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) {
      console.error('Error fetching report:', error);
      return res.status(404).json({ error: 'Report not found' });
    }
    
    // Get learner info separately
    if (report && report.learner_id) {
      const { data: learner } = await supabase
        .from('learners')
        .select('id, name, reg_number, form')
        .eq('id', report.learner_id)
        .single();
      
      return res.json({ ...report, learners: learner });
    }
    
    res.json(report);
  } catch (error) {
    console.error('Error fetching report:', error);
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

// ============================================
// ATTENDANCE ROUTES
// ============================================

// Get all attendance - FIXED without foreign key join
app.get('/api/teacher/attendance', async (req, res) => {
  try {
    // Fetch all attendance without join
    const { data: attendance, error } = await supabase
      .from('attendance')
      .select('*')
      .order('date', { ascending: false });
    
    if (error) {
      console.error('Error fetching attendance:', error);
      return res.status(500).json({ error: error.message });
    }
    
    // Get learner names separately
    if (attendance && attendance.length > 0) {
      const learnerIds = [...new Set(attendance.map(a => a.learner_id).filter(Boolean))];
      
      if (learnerIds.length > 0) {
        const { data: learners, error: learnersError } = await supabase
          .from('learners')
          .select('id, name, reg_number, form')
          .in('id', learnerIds);
        
        if (!learnersError && learners) {
          const learnerMap = {};
          learners.forEach(learner => {
            learnerMap[learner.id] = learner;
          });
          
          const attendanceWithLearners = attendance.map(record => ({
            ...record,
            learners: learnerMap[record.learner_id] || null
          }));
          
          return res.json(attendanceWithLearners);
        }
      }
    }
    
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
    
    console.log('📝 Recording attendance:', { learnerId, date, status });
    
    // Validate required fields
    if (!learnerId) {
      return res.status(400).json({ error: 'learnerId is required' });
    }
    if (!date) {
      return res.status(400).json({ error: 'date is required' });
    }
    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }
    
    // Validate status
    const validStatuses = ['present', 'absent', 'late'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be present, absent, or late' });
    }
    
    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    
    // Check if learner exists
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id, name')
      .eq('id', learnerId)
      .single();
    
    if (learnerError || !learner) {
      console.error('Learner not found:', learnerId);
      return res.status(404).json({ error: 'Learner not found' });
    }
    
    console.log('✅ Learner found:', learner.name);
    
    const attendanceData = {
      learner_id: learnerId,
      date: date,
      status: status
    };
    
    console.log('📤 Upserting attendance:', attendanceData);
    
    // Delete existing record first (simpler approach)
    await supabase
      .from('attendance')
      .delete()
      .eq('learner_id', learnerId)
      .eq('date', date);
    
    // Insert new record
    const { data, error } = await supabase
      .from('attendance')
      .insert([attendanceData])
      .select();
    
    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ 
        error: error.message,
        details: error.details
      });
    }
    
    console.log('✅ Attendance recorded successfully:', data[0]);
    res.json({ success: true, attendance: data[0] });
    
  } catch (error) {
    console.error('Error recording attendance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Teacher dashboard stats - UPDATED to use form
app.get('/api/teacher/dashboard/stats', async (req, res) => {
  try {
    const { data: learners, error: learnersError } = await supabase
      .from('learners')
      .select('*');
    
    if (learnersError) throw learnersError;
    
    const { data: reports, error: reportsError } = await supabase
      .from('reports')
      .select('*');
    
    if (reportsError) throw reportsError;
    
    const { data: attendance, error: attendanceError } = await supabase
      .from('attendance')
      .select('*');
    
    if (attendanceError) throw attendanceError;
    
    let totalAtt = 0;
    let presentCount = 0;
    
    learners.forEach(learner => {
      const records = attendance.filter(a => a.learner_id === learner.id);
      if (records.length) {
        const present = records.filter(a => a.status === 'present' || a.status === 'late').length;
        totalAtt += records.length;
        presentCount += present;
      }
    });
    
    const avgAttendance = totalAtt ? Math.round(presentCount / totalAtt * 100) : 0;
    
    // Count learners by form
    const learnersByForm = {
      'Form 1': learners.filter(l => l.form === 'Form 1').length,
      'Form 2': learners.filter(l => l.form === 'Form 2').length,
      'Form 3': learners.filter(l => l.form === 'Form 3').length,
      'Form 4': learners.filter(l => l.form === 'Form 4').length
    };
    
    res.json({
      totalLearners: learners.length,
      totalReports: reports.length,
      averageAttendance: avgAttendance,
      activeLearners: learners.filter(l => l.status === 'Active').length,
      pendingReports: reports.filter(r => !r.is_finalized).length,
      learnersByForm
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LEARNER ROUTES - UPDATED TO USE FORM
// ============================================

// Get learner profile
app.get('/api/learner/profile', async (req, res) => {
  const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
  
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
  const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
  
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
  const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
  
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

// Learner dashboard stats - UPDATED to use form
app.get('/api/learner/dashboard/stats', async (req, res) => {
  const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
    
    const { data: reports, error: reportsError } = await supabase
      .from('reports')
      .select('*')
      .eq('learner_id', decoded.id);
    
    if (reportsError) throw reportsError;
    
    const { data: attendance, error: attendanceError } = await supabase
      .from('attendance')
      .select('*')
      .eq('learner_id', decoded.id);
    
    if (attendanceError) throw attendanceError;
    
    let attendanceRate = 0;
    if (attendance.length > 0) {
      const presentCount = attendance.filter(a => a.status === 'present' || a.status === 'late').length;
      attendanceRate = Math.round(presentCount / attendance.length * 100);
    }
    
    let averageScore = null;
    if (reports.length > 0) {
      const latest = reports[reports.length - 1];
      if (latest.subjects && latest.subjects.length > 0) {
        const sum = latest.subjects.reduce((acc, s) => acc + (s.score || 0), 0);
        averageScore = Math.round(sum / latest.subjects.length);
      }
    }
    
    res.json({
      reportsCount: reports.length,
      attendanceRate: attendanceRate,
      averageScore: averageScore,
      totalDays: attendance.length,
      presentCount: attendance.filter(a => a.status === 'present').length,
      lateCount: attendance.filter(a => a.status === 'late').length,
      absentCount: attendance.filter(a => a.status === 'absent').length
    });
  } catch (error) {
    console.error('Learner dashboard stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// COMPATIBILITY ROUTES (For frontend without /api prefix)
// ============================================

app.get('/learner/attendance', async (req, res) => {
  console.log('🔄 Redirecting: /learner/attendance -> /api/learner/attendance');
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
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
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/learner/reports', async (req, res) => {
  console.log('🔄 Redirecting: /learner/reports -> /api/learner/reports');
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
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
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/learners/reports', async (req, res) => {
  console.log('🔄 Redirecting: /learners/reports -> /api/learner/reports');
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
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
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/learner/profile', async (req, res) => {
  console.log('🔄 Redirecting: /learner/profile -> /api/learner/profile');
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
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
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/learner/dashboard/stats', async (req, res) => {
  console.log('🔄 Redirecting: /learner/dashboard/stats -> /api/learner/dashboard/stats');
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const decoded = JSON.parse(Buffer.from(token.split(' ')[1], 'base64').toString());
    
    const { data: reports, error: reportsError } = await supabase
      .from('reports')
      .select('*')
      .eq('learner_id', decoded.id);
    
    if (reportsError) throw reportsError;
    
    const { data: attendance, error: attendanceError } = await supabase
      .from('attendance')
      .select('*')
      .eq('learner_id', decoded.id);
    
    if (attendanceError) throw attendanceError;
    
    let attendanceRate = 0;
    if (attendance.length > 0) {
      const presentCount = attendance.filter(a => a.status === 'present' || a.status === 'late').length;
      attendanceRate = Math.round(presentCount / attendance.length * 100);
    }
    
    let averageScore = null;
    if (reports.length > 0) {
      const latest = reports[reports.length - 1];
      if (latest.subjects && latest.subjects.length > 0) {
        const sum = latest.subjects.reduce((acc, s) => acc + (s.score || 0), 0);
        averageScore = Math.round(sum / latest.subjects.length);
      }
    }
    
    res.json({
      reportsCount: reports.length,
      attendanceRate: attendanceRate,
      averageScore: averageScore,
      totalDays: attendance.length,
      presentCount: attendance.filter(a => a.status === 'present').length,
      lateCount: attendance.filter(a => a.status === 'late').length,
      absentCount: attendance.filter(a => a.status === 'absent').length
    });
  } catch (error) {
    console.error('Learner dashboard stats error:', error);
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
  
  console.log('\n🔄 Compatibility routes enabled:');
  console.log('   GET /learner/attendance');
  console.log('   GET /learner/reports');
  console.log('   GET /learners/reports');
  console.log('   GET /learner/profile');
  console.log('   GET /learner/dashboard/stats');
  console.log('\n🔧 Debug endpoints:');
  console.log('   GET /api/debug/learners');
  console.log('   GET /api/debug/attendance-test');
  console.log('='.repeat(60));
});

module.exports = app;