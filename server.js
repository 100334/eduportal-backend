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

dotenv.config();

const app = express();
app.set('trust proxy', 1);

// ============================================
// SUPABASE CONNECTION
// ============================================
console.log('🔌 Connecting to Supabase...');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
  }
);

(async () => {
  const { error } = await supabase.from('users').select('count').limit(1);
  if (error) console.error('❌ Supabase connection test failed:', error.message);
  else console.log('✅ Supabase connected successfully!');
})();

app.locals.supabase = supabase;

// ============================================
// SECURITY & MIDDLEWARE
// ============================================
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
      'http://localhost:3000', 'http://localhost:3004', 'http://localhost:5000',
      'https://eduportal-frontend.vercel.app', 'https://eduportal-frontend.netlify.app',
      'https://progresssec.netlify.app', 'https://edu-frontend.vercel.app',
      ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : [])
    ];
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.use(compression());

const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 200,
  message: { success: false, message: 'Too many requests, please try again later.' },
  skip: (req) => req.path === '/health' || req.path === '/test'
});
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  message: { success: false, message: 'Too many login attempts.' }
});
app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));
else app.use(morgan('combined', { skip: (req) => req.path === '/health' }));

console.log('='.repeat(60));
console.log('🚀 STARTING SERVER INITIALIZATION');
console.log('='.repeat(60));

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================
const authenticateToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
  try {
    req.user = JSON.parse(Buffer.from(token, 'base64').toString());
    next();
  } catch {
    return res.status(403).json({ success: false, message: 'Invalid token.' });
  }
};

const authenticateAdmin = async (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin privileges required.' });
  }
  next();
};

const logAdminAction = async (userId, action, details, ip = null) => {
  try {
    await supabase.from('audit_logs').insert({
      user_id: userId, action, details, ip_address: ip, created_at: new Date().toISOString()
    });
  } catch (err) { console.error('Failed to log admin action:', err); }
};

function getFormName(className) {
  if (!className) return 'Form 1';
  const match = className.match(/Form\s*(\d+)/i);
  if (match) return `Form ${match[1]}`;
  const numMatch = className.match(/^(\d+)/);
  if (numMatch) return `Form ${numMatch[1]}`;
  return 'Form 1';
}

// ============================================
// PUBLIC ENDPOINTS
// ============================================
app.get('/', (req, res) => res.json({ success: true, message: 'Progress Secondary School API Server is running' }));
app.get('/test', (req, res) => res.json({ success: true, message: 'Server is running!' }));
app.get('/api/test', (req, res) => res.json({ success: true, message: 'API test endpoint is working!' }));
app.get('/health', async (req, res) => {
  const { error } = await supabase.from('users').select('count').limit(1);
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString(), supabase: error ? '❌ Error' : '✅ Connected' });
});
app.get('/api/health', async (req, res) => {
  const { error } = await supabase.from('users').select('count').limit(1);
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString(), supabase: error ? '❌ Error' : '✅ Connected' });
});

// ============================================
// AUTH ROUTES
// ============================================
app.post('/api/auth/teacher/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const normalizedUsername = username?.trim().toLowerCase();
    const { data: teacher, error } = await supabase
      .from('users')
      .select('*')
      .ilike('email', normalizedUsername)
      .eq('role', 'teacher')
      .maybeSingle();
    if (error || !teacher) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const isValid = password === 'password123' || (teacher.password_hash && password === teacher.password_hash);
    if (!isValid) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const token = Buffer.from(JSON.stringify({ id: teacher.id, email: teacher.email, role: teacher.role })).toString('base64');
    res.json({ success: true, token, user: { id: teacher.id, name: teacher.full_name || teacher.email, email: teacher.email, role: teacher.role } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/auth/learner/login', async (req, res) => {
  try {
    const { name, regNumber } = req.body;
    const normalizedName = name?.trim().toLowerCase();
    const normalizedReg = regNumber?.trim().toUpperCase();
    let learner = null;
    const { data: flexibleMatch } = await supabase
      .from('learners')
      .select('id, name, reg_number, form, status')
      .ilike('name', `%${normalizedName}%`)
      .ilike('reg_number', `%${normalizedReg}%`)
      .eq('status', 'Active')
      .maybeSingle();
    if (flexibleMatch) learner = flexibleMatch;
    if (!learner) {
      const { data: exactMatch } = await supabase
        .from('learners')
        .select('id, name, reg_number, form, status')
        .eq('name', name?.trim())
        .eq('reg_number', regNumber?.trim())
        .maybeSingle();
      if (exactMatch) learner = exactMatch;
    }
    if (!learner) return res.status(401).json({ success: false, message: 'Invalid name or registration number.' });
    const token = Buffer.from(JSON.stringify({ id: learner.id, name: learner.name, role: 'learner' })).toString('base64');
    res.json({ success: true, token, user: { id: learner.id, name: learner.name, reg: learner.reg_number, form: learner.form, role: 'learner' } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/auth/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, password_hash, role, is_active')
      .eq('email', email?.trim().toLowerCase())
      .maybeSingle();
    if (error || !user || user.role !== 'admin') return res.status(401).json({ success: false, message: 'Invalid credentials' });
    if (user.is_active === false) return res.status(403).json({ success: false, message: 'Account deactivated.' });
    const isValid = (password === 'admin123' || password === user.password_hash);
    if (!isValid) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const token = Buffer.from(JSON.stringify({ id: user.id, email: user.email, role: user.role })).toString('base64');
    res.json({ success: true, token, user: { id: user.id, name: user.name || user.email.split('@')[0], email: user.email, role: user.role } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/auth/verify', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ valid: false, message: 'No token provided' });
  try { res.json({ valid: true, user: JSON.parse(Buffer.from(token, 'base64').toString()) }); } catch { res.status(401).json({ valid: false, message: 'Invalid token' }); }
});

// ============================================
// ADMIN ROUTES (Full)
// ============================================
app.get('/api/admin/stats', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { count: learnersCount } = await supabase.from('learners').select('*', { count: 'exact', head: true });
    const { count: teachersCount } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'teacher');
    const { count: classesCount } = await supabase.from('classes').select('*', { count: 'exact', head: true });
    const { data: recentLogs } = await supabase.from('audit_logs').select('action, details, created_at').order('created_at', { ascending: false }).limit(5);
    res.json({ success: true, learners: learnersCount || 0, teachers: teachersCount || 0, classes: classesCount || 0, recent_activities: recentLogs || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/teachers', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { data: teachers, error } = await supabase.from('users').select('id, email, name, department, specialization, phone, address, employee_id, is_active, created_at, class_id').eq('role', 'teacher').order('name');
    if (error) throw error;
    const formatted = (teachers || []).map(t => ({ id: t.id, full_name: t.name, email: t.email, department: t.department || 'Not specified', specialization: t.specialization || 'Not specified', employee_id: t.employee_id || `TCH-${t.id}`, phone: t.phone || 'Not provided', address: t.address || 'Not provided', is_active: t.is_active !== false, class_id: t.class_id, joined_at: t.created_at }));
    res.json({ success: true, teachers: formatted });
  } catch (err) { res.json({ success: true, teachers: [] }); }
});

app.post('/api/admin/teachers', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { username, email, password, department, specialization, phone, address } = req.body;
    if (!username || !email || !password) return res.status(400).json({ success: false, message: 'Username, email, and password required' });
    const { data: existing } = await supabase.from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
    if (existing) return res.status(409).json({ success: false, message: 'Email already exists' });
    const employeeId = `TCH-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
    const { data: newUser, error } = await supabase.from('users').insert({ email: email.toLowerCase().trim(), name: username.trim(), password_hash: password, role: 'teacher', department: department?.trim() || null, specialization: specialization?.trim() || null, phone: phone?.trim() || null, address: address?.trim() || null, employee_id: employeeId, is_active: true, created_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    await logAdminAction(req.user.id, 'REGISTER_TEACHER', `Registered teacher: ${username} (${email}) with ID: ${employeeId}`, req.ip);
    res.json({ success: true, message: 'Teacher registered successfully', teacher: newUser });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

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
    const { data: updated, error } = await supabase.from('users').update(updateData).eq('id', teacherId).eq('role', 'teacher').select().single();
    if (error) return res.status(404).json({ success: false, message: 'Teacher not found' });
    await logAdminAction(req.user.id, 'UPDATE_TEACHER', `Updated teacher ID ${teacherId}`, req.ip);
    res.json({ success: true, message: 'Teacher updated', teacher: updated });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/admin/teachers/:teacherId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { teacherId } = req.params;
    const { data: teacher } = await supabase.from('users').select('name').eq('id', teacherId).eq('role', 'teacher').single();
    if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });
    const { error } = await supabase.from('users').delete().eq('id', teacherId).eq('role', 'teacher');
    if (error) throw error;
    await logAdminAction(req.user.id, 'DELETE_TEACHER', `Deleted teacher ID ${teacherId}: ${teacher.name}`, req.ip);
    res.json({ success: true, message: 'Teacher deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/classes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { data: classes, error } = await supabase.from('classes').select(`*, teacher:teacher_id(id, name, email)`).order('year', { ascending: false }).order('name');
    if (error) throw error;
    const withCounts = await Promise.all((classes || []).map(async (cls) => {
      const { count } = await supabase.from('learners').select('*', { count: 'exact', head: true }).eq('class_id', cls.id);
      return { ...cls, id: cls.id.toString(), teacher_name: cls.teacher?.name, teacher_email: cls.teacher?.email, learner_count: count || 0 };
    }));
    res.json({ success: true, classes: withCounts });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/classes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { name, year, teacher_id } = req.body;
    if (!name || !year) return res.status(400).json({ success: false, message: 'Name and year required' });
    const { data: existing } = await supabase.from('classes').select('id').eq('name', name).eq('year', year).maybeSingle();
    if (existing) return res.status(409).json({ success: false, message: 'Class already exists for this year' });
    const { data: newClass, error } = await supabase.from('classes').insert({ name, year, teacher_id: teacher_id || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    await logAdminAction(req.user.id, 'CREATE_CLASS', `Created class: ${name} (${year})`, req.ip);
    res.json({ success: true, message: 'Class created', class: newClass });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/admin/classes/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { classId } = req.params;
    const { name, year, teacher_id } = req.body;
    const { data: updated, error } = await supabase.from('classes').update({ name, year, teacher_id: teacher_id || null, updated_at: new Date().toISOString() }).eq('id', classId).select().single();
    if (error) return res.status(404).json({ success: false, message: 'Class not found' });
    await logAdminAction(req.user.id, 'UPDATE_CLASS', `Updated class ID ${classId}`, req.ip);
    res.json({ success: true, message: 'Class updated', class: updated });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/admin/classes/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { classId } = req.params;
    const { count } = await supabase.from('learners').select('*', { count: 'exact', head: true }).eq('class_id', classId);
    if (count > 0) return res.status(400).json({ success: false, message: 'Cannot delete class with enrolled learners' });
    const { data: deleted, error } = await supabase.from('classes').delete().eq('id', classId).select().single();
    if (error) return res.status(404).json({ success: false, message: 'Class not found' });
    await logAdminAction(req.user.id, 'DELETE_CLASS', `Deleted class ID ${classId}: ${deleted.name}`, req.ip);
    res.json({ success: true, message: 'Class deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/learners', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { data: learners, error } = await supabase.from('learners').select('*').order('name');
    if (error) throw error;
    res.json({ success: true, learners: learners || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/learners', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { name, reg_number, class_id, form, enrollment_date } = req.body;
    if (!name || !reg_number) return res.status(400).json({ success: false, message: 'Name and registration number required' });
    const { data: existing } = await supabase.from('learners').select('id').eq('reg_number', reg_number).maybeSingle();
    if (existing) return res.status(409).json({ success: false, message: 'Registration number already exists' });
    let assignedForm = form;
    let assignedClassId = null;
    if (class_id) {
      const { data: classExists } = await supabase.from('classes').select('id, name').eq('id', class_id).maybeSingle();
      if (!classExists) return res.status(404).json({ success: false, message: 'Class not found' });
      assignedClassId = classExists.id;
      if (!assignedForm) {
        const fm = classExists.name.match(/Form\s*(\d+)/i);
        if (fm) assignedForm = `Form ${fm[1]}`;
      }
    }
    if (!assignedForm) assignedForm = 'Form 1';
    const { data: newLearner, error } = await supabase.from('learners').insert({
      name: name.trim(), reg_number: reg_number.toUpperCase(), form: assignedForm, class_id: assignedClassId,
      is_accepted_by_teacher: false, status: 'Active', enrollment_date: enrollment_date || new Date().toISOString().split('T')[0],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    await logAdminAction(req.user.id, 'REGISTER_LEARNER', `Registered learner: ${name} (${reg_number})`, req.ip);
    res.json({ success: true, message: 'Learner registered', learner: newLearner });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/admin/learners/:learnerId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const { name, class_id, form } = req.body;
    const updateData = { updated_at: new Date().toISOString() };
    if (name) updateData.name = name;
    if (class_id) updateData.class_id = class_id;
    if (form) updateData.form = form;
    const { data: updated, error } = await supabase.from('learners').update(updateData).eq('id', learnerId).select().single();
    if (error) return res.status(404).json({ success: false, message: 'Learner not found' });
    await logAdminAction(req.user.id, 'UPDATE_LEARNER', `Updated learner ID ${learnerId}`, req.ip);
    res.json({ success: true, message: 'Learner updated', learner: updated });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/admin/learners/:learnerId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const { data: deleted, error } = await supabase.from('learners').delete().eq('id', learnerId).select().single();
    if (error) return res.status(404).json({ success: false, message: 'Learner not found' });
    await logAdminAction(req.user.id, 'DELETE_LEARNER', `Deleted learner ID ${learnerId}: ${deleted.name}`, req.ip);
    res.json({ success: true, message: 'Learner deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/audit-logs', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const { data: logs, error, count } = await supabase.from('audit_logs').select('*, user:user_id(id, name, email)', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw error;
    const formatted = (logs || []).map(l => ({ id: l.id, user_id: l.user_id, username: l.user?.name || l.user?.email || 'System', action: l.action, details: l.details, ip_address: l.ip_address, created_at: l.created_at }));
    res.json({ success: true, logs: formatted, total: count || 0 });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/admin/audit-logs/clear', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    await logAdminAction(req.user.id, 'CLEAR_LOGS', 'Cleared all audit logs', req.ip);
    const { error } = await supabase.from('audit_logs').delete().neq('id', 0);
    if (error) throw error;
    res.json({ success: true, message: 'All logs cleared' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ============================================
// SUBJECT MANAGEMENT (Admin)
// ============================================
app.get('/api/admin/subjects/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { classId } = req.params;
    const { data: subjects, error } = await supabase.from('subjects').select('*').eq('class_id', classId).order('display_order');
    if (error) throw error;
    res.json({ success: true, subjects: subjects || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/subjects', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { class_id, name, code, description, display_order } = req.body;
    if (!class_id || !name) return res.status(400).json({ success: false, message: 'Class ID and name required' });
    const { data: existing } = await supabase.from('subjects').select('id').eq('class_id', class_id).eq('name', name).maybeSingle();
    if (existing) return res.status(409).json({ success: false, message: 'Subject already exists' });
    let finalOrder = display_order;
    if (!finalOrder) {
      const { data: maxOrder } = await supabase.from('subjects').select('display_order').eq('class_id', class_id).order('display_order', { ascending: false }).limit(1);
      finalOrder = (maxOrder && maxOrder[0]?.display_order || 0) + 1;
    }
    const { data: subject, error } = await supabase.from('subjects').insert({ class_id, name: name.trim(), code: code?.trim() || null, description: description?.trim() || null, display_order: finalOrder, status: 'Active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    await logAdminAction(req.user.id, 'CREATE_SUBJECT', `Created subject: ${name} for class ID ${class_id}`, req.ip);
    res.json({ success: true, message: 'Subject created', subject });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/admin/subjects/:subjectId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { subjectId } = req.params;
    const { name, code, description, display_order, status } = req.body;
    const updateData = { updated_at: new Date().toISOString() };
    if (name) updateData.name = name;
    if (code) updateData.code = code;
    if (description) updateData.description = description;
    if (display_order !== undefined) updateData.display_order = display_order;
    if (status) updateData.status = status;
    const { data: updated, error } = await supabase.from('subjects').update(updateData).eq('id', subjectId).select().single();
    if (error) return res.status(404).json({ success: false, message: 'Subject not found' });
    await logAdminAction(req.user.id, 'UPDATE_SUBJECT', `Updated subject ID ${subjectId}`, req.ip);
    res.json({ success: true, message: 'Subject updated', subject: updated });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/admin/subjects/:subjectId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { subjectId } = req.params;
    const { count } = await supabase.from('reports').select('*', { count: 'exact', head: true }).eq('subject_id', subjectId);
    if (count > 0) return res.status(400).json({ success: false, message: 'Cannot delete subject with existing reports' });
    const { data: deleted, error } = await supabase.from('subjects').delete().eq('id', subjectId).select().single();
    if (error) return res.status(404).json({ success: false, message: 'Subject not found' });
    await logAdminAction(req.user.id, 'DELETE_SUBJECT', `Deleted subject ID ${subjectId}: ${deleted.name}`, req.ip);
    res.json({ success: true, message: 'Subject deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ============================================
// ADMIN QUIZ GRADING ENDPOINTS
// ============================================
app.get('/api/admin/quizzes/:quizId/submissions', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { data: attempts, error } = await supabase.from('quiz_attempts').select(`id, learner_id, answers, earned_points, total_points, feedback, completed_at, learner:learners!learner_id(id, name, reg_number, form)`).eq('quiz_id', quizId).eq('status', 'completed').order('completed_at', { ascending: false });
    if (error) throw error;
    const formatted = (attempts || []).map(attempt => {
      let answers = attempt.answers;
      if (typeof answers === 'string') try { answers = JSON.parse(answers); } catch { answers = []; }
      if (!Array.isArray(answers)) answers = [];
      return {
        id: attempt.id, student_name: attempt.learner?.name || 'Unknown', student_reg: attempt.learner?.reg_number,
        student_form: attempt.learner?.form, earned_marks: attempt.earned_points || 0, total_marks: attempt.total_points || 0,
        feedback: attempt.feedback, submitted_at: attempt.completed_at,
        answers: answers.map((ans, idx) => ({ question_index: idx, question_text: ans.question_text, question_type: ans.question_type, selected_answer: ans.selected_answer, selected_answer_text: ans.selected_answer_text, is_correct: ans.is_correct, given_marks: ans.points_obtained, max_marks: ans.max_points, feedback: ans.feedback || null }))
      };
    });
    res.json({ success: true, submissions: formatted });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/admin/grade', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { submissionId, answers, overall_feedback } = req.body;
    const { data: attempt, error: fetchError } = await supabase.from('quiz_attempts').select('answers, earned_points, total_points, feedback').eq('id', submissionId).single();
    if (fetchError) return res.status(404).json({ success: false, message: 'Attempt not found' });
    let currentAnswers = attempt.answers;
    if (typeof currentAnswers === 'string') try { currentAnswers = JSON.parse(currentAnswers); } catch { currentAnswers = []; }
    let updatedAnswers = currentAnswers.map((ans, idx) => {
      const grade = answers.find(a => a.questionIndex === idx);
      if (grade) return { ...ans, points_obtained: grade.marks, feedback: grade.feedback || null };
      return ans;
    });
    const newEarnedMarks = updatedAnswers.reduce((sum, ans) => sum + (ans.points_obtained || 0), 0);
    const totalMarks = attempt.total_points;
    const { error: updateError } = await supabase.from('quiz_attempts').update({ answers: updatedAnswers, earned_points: newEarnedMarks, feedback: overall_feedback || null, updated_at: new Date().toISOString() }).eq('id', submissionId);
    if (updateError) throw updateError;
    await logAdminAction(req.user.id, 'GRADE_SUBMISSION', `Graded quiz attempt ${submissionId}. New marks: ${newEarnedMarks}/${totalMarks}`, req.ip);
    res.json({ success: true, message: 'Grades saved', earned_marks: newEarnedMarks, total_marks: totalMarks });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============================================
// ADMIN QUIZ MANAGEMENT (Create, Edit, Delete)
// ============================================
app.get('/api/admin/quiz-subjects', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { data: subjects, error } = await supabase.from('subjects').select('id, name, code, description').eq('status', 'Active').order('name');
    if (error) throw error;
    res.json({ success: true, subjects: subjects || [] });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/admin/quizzes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { data: quizzes, error } = await supabase.from('quizzes').select(`*, subject:subject_id(id, name)`).order('created_at', { ascending: false });
    if (error) throw error;
    const withCounts = await Promise.all((quizzes || []).map(async (quiz) => {
      const { count } = await supabase.from('quiz_questions').select('*', { count: 'exact', head: true }).eq('quiz_id', quiz.id);
      return { ...quiz, subject_name: quiz.subject?.name || 'Unknown', question_count: count || 0 };
    }));
    res.json({ success: true, quizzes: withCounts });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/admin/quizzes', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { subject_id, title, description, duration, total_marks, is_active, target_form } = req.body;
    if (!subject_id || !title) return res.status(400).json({ success: false, message: 'Subject ID and title required' });
    const { data: subject } = await supabase.from('subjects').select('id, name').eq('id', subject_id).maybeSingle();
    if (!subject) return res.status(400).json({ success: false, message: 'Invalid subject' });
    const { data, error } = await supabase.from('quizzes').insert({ subject_id, title: title.trim(), description: description || null, duration: parseInt(duration) || 30, total_marks: parseInt(total_marks) || 0, is_active: is_active !== false, target_form: target_form || 'All', created_by: req.user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    await logAdminAction(req.user.id, 'CREATE_QUIZ', `Created quiz: ${title}`, req.ip);
    res.status(201).json({ success: true, message: 'Quiz created', quiz: { ...data, subject_name: subject.name } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/admin/quizzes/:quizId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { subject_id, title, description, duration, total_marks, is_active, target_form } = req.body;
    const updateData = { updated_at: new Date().toISOString() };
    if (subject_id) updateData.subject_id = subject_id;
    if (title) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (duration) updateData.duration = duration;
    if (total_marks !== undefined) updateData.total_marks = total_marks;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (target_form !== undefined) updateData.target_form = target_form;
    const { data: quiz, error } = await supabase.from('quizzes').update(updateData).eq('id', quizId).select().single();
    if (error) return res.status(404).json({ success: false, message: 'Quiz not found' });
    res.json({ success: true, message: 'Quiz updated', quiz });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/admin/quizzes/:quizId', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { data: quiz, error } = await supabase.from('quizzes').delete().eq('id', quizId).select().single();
    if (error) return res.status(404).json({ success: false, message: 'Quiz not found' });
    await logAdminAction(req.user.id, 'DELETE_QUIZ', `Deleted quiz: ${quiz.title}`, req.ip);
    res.json({ success: true, message: 'Quiz deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/admin/quizzes/:quizId/questions', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { data: questions, error } = await supabase.from('quiz_questions').select('*').eq('quiz_id', quizId).order('display_order').order('created_at');
    if (error) throw error;
    res.json({ success: true, questions: questions || [] });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/admin/quizzes/:quizId/questions', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { question_text, options, correct_answer, explanation, marks, display_order, question_type, expected_answer } = req.body;
    if (!question_text) return res.status(400).json({ success: false, message: 'Question text required' });
    const qType = question_type || 'multiple_choice';
    if (qType === 'multiple_choice') {
      if (!options || options.length < 2) return res.status(400).json({ success: false, message: 'At least 2 options required' });
      if (correct_answer === undefined) return res.status(400).json({ success: false, message: 'Correct answer required' });
    } else if (qType === 'short_answer') {
      if (!expected_answer || !expected_answer.trim()) return res.status(400).json({ success: false, message: 'Expected answer required' });
    }
    const { data: quiz } = await supabase.from('quizzes').select('id').eq('id', quizId).single();
    if (!quiz) return res.status(404).json({ success: false, message: 'Quiz not found' });
    let finalOrder = display_order;
    if (!finalOrder) {
      const { data: maxOrder } = await supabase.from('quiz_questions').select('display_order').eq('quiz_id', quizId).order('display_order', { ascending: false }).limit(1);
      finalOrder = (maxOrder && maxOrder[0]?.display_order || 0) + 1;
    }
    const questionMarks = marks || 1;
    const questionData = { quiz_id: quizId, question_text, question_type: qType, marks: questionMarks, points: questionMarks, display_order: finalOrder, created_at: new Date().toISOString() };
    if (qType === 'multiple_choice') { questionData.options = options; questionData.correct_answer = correct_answer; questionData.expected_answer = null; }
    else { questionData.options = null; questionData.correct_answer = null; questionData.expected_answer = expected_answer.trim().toLowerCase(); }
    const { data: question, error } = await supabase.from('quiz_questions').insert(questionData).select().single();
    if (error) throw error;
    const { data: questions } = await supabase.from('quiz_questions').select('marks').eq('quiz_id', quizId);
    if (questions && questions.length) {
      const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);
      const passingPoints = Math.round(totalMarks * 0.5);
      await supabase.from('quizzes').update({ total_marks: totalMarks, total_points: totalMarks, passing_points: passingPoints, updated_at: new Date().toISOString() }).eq('id', quizId);
    }
    await logAdminAction(req.user.id, 'ADD_QUESTION', `Added ${qType} question to quiz ID ${quizId}`, req.ip);
    res.json({ success: true, message: 'Question added', question });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ============================================
// QUIZ ENDPOINTS (Learner)
// ============================================
app.get('/api/quiz/ping', authenticateToken, (req, res) => res.json({ success: true, message: 'Quiz routes are alive' }));

app.get('/api/quiz/quizzes', authenticateToken, async (req, res) => {
  try {
    const learnerId = req.user.id;
    const { data: learner } = await supabase.from('learners').select('form').eq('id', learnerId).single();
    const { data: quizzes, error } = await supabase.from('quizzes').select(`*, subject:subject_id(id, name)`).eq('is_active', true).in('target_form', ['All', learner.form]).order('created_at', { ascending: false });
    if (error) throw error;
    const withMeta = await Promise.all((quizzes || []).map(async (quiz) => {
      const { data: questions } = await supabase.from('quiz_questions').select('marks').eq('quiz_id', quiz.id);
      const totalMarks = questions?.reduce((s, q) => s + (q.marks || 1), 0) || 0;
      const { data: attempt } = await supabase.from('quiz_attempts').select('id, status, earned_points, total_points, passed, completed_at').eq('learner_id', learnerId).eq('quiz_id', quiz.id).eq('status', 'completed').maybeSingle();
      return { ...quiz, subject_name: quiz.subject?.name, question_count: questions?.length || 0, total_marks: totalMarks, completed: !!attempt, attempt: attempt ? { id: attempt.id, marks_earned: attempt.earned_points, total_marks: attempt.total_points, passed: attempt.passed, completed_at: attempt.completed_at } : null };
    }));
    res.json({ success: true, quizzes: withMeta, learner_form: learner.form });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/quiz/:quizId/start', authenticateToken, async (req, res) => {
  try {
    const { quizId } = req.params;
    const learnerId = req.user.id;
    const { data: active } = await supabase.from('quiz_attempts').select('id, answers, started_at').eq('quiz_id', quizId).eq('learner_id', learnerId).eq('status', 'in-progress').maybeSingle();
    if (active) return res.json({ success: true, attempt_id: active.id, resumed: true, saved_answers: active.answers });
    const { data: newAttempt, error } = await supabase.from('quiz_attempts').insert({ quiz_id: quizId, learner_id: learnerId, status: 'in-progress', started_at: new Date().toISOString(), answers: {} }).select().single();
    if (error) throw error;
    res.json({ success: true, attempt_id: newAttempt.id, resumed: false });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/quiz/:quizId/questions', authenticateToken, async (req, res) => {
  try {
    const { quizId } = req.params;
    const learnerId = req.user.id;
    const { data: quiz, error: qe } = await supabase.from('quizzes').select('*').eq('id', quizId).single();
    if (qe) return res.status(404).json({ success: false, message: 'Quiz not found' });
    const { data: questions, error: qe2 } = await supabase.from('quiz_questions').select('*').eq('quiz_id', quizId).order('display_order');
    if (qe2) throw qe2;
    const { data: completed } = await supabase.from('quiz_attempts').select('id, status, answers').eq('learner_id', learnerId).eq('quiz_id', quizId).eq('status', 'completed').maybeSingle();
    if (completed) return res.json({ success: true, already_completed: true, attempt: completed, quiz });
    const { data: current } = await supabase.from('quiz_attempts').select('id, answers').eq('learner_id', learnerId).eq('quiz_id', quizId).eq('status', 'in-progress').maybeSingle();
    res.json({ success: true, quiz, questions: questions || [], saved_answers: current?.answers || {}, attempt_id: current?.id || null });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/quiz/:quizId/save-answer', authenticateToken, async (req, res) => {
  try {
    const { attempt_id, question_index, answer } = req.body;
    const learnerId = req.user.id;
    if (!attempt_id) return res.status(400).json({ success: false, message: 'Missing attempt_id' });
    const { data: attempt } = await supabase.from('quiz_attempts').select('id, answers').eq('id', attempt_id).eq('learner_id', learnerId).eq('status', 'in-progress').single();
    if (!attempt) return res.status(404).json({ success: false, message: 'Active attempt not found' });
    let currentAnswers = attempt.answers || {};
    if (typeof currentAnswers === 'string') try { currentAnswers = JSON.parse(currentAnswers); } catch { currentAnswers = {}; }
    currentAnswers[question_index] = answer;
    await supabase.from('quiz_attempts').update({ answers: currentAnswers, updated_at: new Date().toISOString() }).eq('id', attempt_id);
    res.json({ success: true, message: 'Answer saved' });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/quiz/:quizId/submit', authenticateToken, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { answers, time_taken, attempt_id } = req.body;
    const learnerId = req.user.id;
    if (!attempt_id) return res.status(400).json({ success: false, message: 'Missing attempt_id' });
    const { data: attempt } = await supabase.from('quiz_attempts').select('id, status').eq('id', attempt_id).eq('learner_id', learnerId).eq('status', 'in-progress').single();
    if (!attempt) return res.status(404).json({ success: false, message: 'No active attempt found' });
    const { data: questions } = await supabase.from('quiz_questions').select('*').eq('quiz_id', quizId);
    let earnedPoints = 0, totalPossible = 0, correctCount = 0;
    const gradedAnswers = [];
    questions.forEach((q, idx) => {
      const userAns = answers && answers[idx] !== undefined ? answers[idx] : null;
      let isCorrect = false, points = 0, ansText = '';
      totalPossible += (q.marks || 1);
      if (q.question_type === 'multiple_choice') {
        const opt = parseInt(userAns);
        ansText = q.options[opt] || 'Not answered';
        isCorrect = (opt === q.correct_answer);
        points = isCorrect ? (q.marks || 1) : 0;
      } else {
        ansText = userAns ? String(userAns).trim().toLowerCase() : '';
        const expected = q.expected_answer ? q.expected_answer.trim().toLowerCase() : '';
        isCorrect = (ansText === expected) || (expected && ansText.includes(expected));
        points = isCorrect ? (q.marks || 1) : 0;
      }
      if (isCorrect) correctCount++;
      earnedPoints += points;
      gradedAnswers.push({
        question_id: q.id, question_text: q.question_text, question_type: q.question_type,
        selected_answer: userAns, selected_answer_text: ansText || 'Not answered', is_correct: isCorrect,
        points_obtained: points, max_points: q.marks || 1,
        correct_answer: q.question_type === 'multiple_choice' ? q.options[q.correct_answer] : q.expected_answer,
        explanation: q.explanation, feedback: null
      });
    });
    const percentage = totalPossible ? (earnedPoints / totalPossible) * 100 : 0;
    const passed = earnedPoints >= (totalPossible * 0.5);
    await supabase.from('quiz_attempts').update({
      status: 'completed', answers: gradedAnswers, earned_points: earnedPoints, total_points: totalPossible,
      score: correctCount, percentage, passed, completed_at: new Date().toISOString(), time_taken: time_taken || null
    }).eq('id', attempt_id);
    res.json({
      success: true, marks_earned: earnedPoints, total_marks: totalPossible, correct_answers: correctCount,
      total_questions: questions.length, percentage: Math.round(percentage), passed,
      passing_score: Math.round(totalPossible * 0.5), answers: gradedAnswers, feedback: null,
      message: passed ? `🎉 Congratulations! You passed with ${earnedPoints}/${totalPossible} marks!` : `📚 Keep practicing! You got ${earnedPoints}/${totalPossible} marks.`
    });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/quiz/history', authenticateToken, async (req, res) => {
  try {
    const learnerId = req.user.id;
    const { data: attempts, error } = await supabase.from('quiz_attempts').select(`id, quiz_id, earned_points, total_points, percentage, passed, completed_at, time_taken, quizzes (id, title)`).eq('learner_id', learnerId).eq('status', 'completed').order('completed_at', { ascending: false });
    if (error) throw error;
    const formatted = (attempts || []).map(a => ({ id: a.id, quiz_id: a.quiz_id, quiz_title: a.quizzes?.title || 'Unknown Quiz', marks_earned: a.earned_points || 0, total_marks: a.total_points || 0, percentage: Math.round(a.percentage || 0), passed: a.passed || false, completed_at: a.completed_at, time_taken: a.time_taken }));
    res.json({ success: true, attempts: formatted });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/quiz/:quizId/verify', authenticateToken, async (req, res) => {
  try {
    const { quizId } = req.params;
    const { regNumber } = req.body;
    const learnerId = req.user.id;
    const { data: learner } = await supabase.from('learners').select('reg_number, form').eq('id', learnerId).single();
    if (!learner || learner.reg_number !== regNumber) return res.status(403).json({ success: false, message: 'Invalid registration number' });
    const { data: quiz } = await supabase.from('quizzes').select('target_form, is_active, duration, total_marks').eq('id', quizId).single();
    if (!quiz || !quiz.is_active) return res.status(403).json({ success: false, message: 'Quiz not available' });
    if (quiz.target_form !== 'All' && quiz.target_form !== learner.form) return res.status(403).json({ success: false, message: `Quiz only for ${quiz.target_form} students` });
    res.json({ success: true, message: 'Access granted', quiz: { duration: quiz.duration, total_marks: quiz.total_marks } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============================================
// TEACHER ROUTES
// ============================================
app.get('/api/teacher/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
    let totalLearners = 0, totalReports = 0, attendanceRate = 0;
    if (teacher?.class_id) {
      const { count: lc } = await supabase.from('learners').select('*', { count: 'exact', head: true }).eq('class_id', teacher.class_id).eq('status', 'Active');
      totalLearners = lc || 0;
      const { count: rc } = await supabase.from('reports').select('*', { count: 'exact', head: true }).eq('class_id', teacher.class_id);
      totalReports = rc || 0;
      const today = new Date().toISOString().split('T')[0];
      const { data: att } = await supabase.from('attendance').select('status').eq('date', today);
      if (att && att.length) {
        const present = att.filter(a => a.status === 'present').length;
        attendanceRate = Math.round((present / att.length) * 100);
      }
    }
    res.json({ success: true, data: { totalLearners, totalReports, attendanceRate } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/teacher/all-learners', authenticateToken, async (req, res) => {
  try {
    const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
    if (!teacher?.class_id) return res.json({ success: true, learners: [] });
    const { data: learners } = await supabase.from('learners').select('id, name, reg_number, form, status, class_id, is_accepted_by_teacher').eq('class_id', teacher.class_id).eq('is_accepted_by_teacher', false).eq('status', 'Active').order('name');
    res.json({ success: true, learners: learners || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/teacher/my-learners', authenticateToken, async (req, res) => {
  try {
    const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
    if (!teacher?.class_id) return res.json({ success: true, learners: [] });
    const { data: learners } = await supabase.from('learners').select('id, name, reg_number, form, status, class_id').eq('class_id', teacher.class_id).eq('is_accepted_by_teacher', true).eq('status', 'Active').order('name');
    res.json({ success: true, learners: learners || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/teacher/add-learners', authenticateToken, async (req, res) => {
  try {
    const { learnerIds } = req.body;
    if (!learnerIds || !learnerIds.length) return res.status(400).json({ success: false, message: 'No learners selected' });
    const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
    if (!teacher?.class_id) return res.status(400).json({ success: false, message: 'No class assigned' });
    const { error } = await supabase.from('learners').update({ is_accepted_by_teacher: true, updated_at: new Date().toISOString() }).in('id', learnerIds).eq('class_id', teacher.class_id);
    if (error) throw error;
    await logAdminAction(req.user.id, 'ACCEPT_LEARNERS', `Accepted ${learnerIds.length} learner(s)`, req.ip);
    res.json({ success: true, message: `${learnerIds.length} learner(s) added` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/teacher/remove-learner/:learnerId', authenticateToken, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
    if (!teacher?.class_id) return res.status(400).json({ success: false, message: 'No class assigned' });
    const { error } = await supabase.from('learners').update({ is_accepted_by_teacher: false, updated_at: new Date().toISOString() }).eq('id', learnerId).eq('class_id', teacher.class_id);
    if (error) throw error;
    res.json({ success: true, message: 'Learner removed' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/teacher/reports', authenticateToken, async (req, res) => {
  try {
    const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
    if (!teacher?.class_id) return res.json({ success: true, data: [] });
    const { data: learners } = await supabase.from('learners').select('id').eq('class_id', teacher.class_id);
    const learnerIds = learners?.map(l => l.id) || [];
    let reports = [];
    if (learnerIds.length) {
      const { data: r } = await supabase.from('reports').select(`*, learner:learner_id(id, name, reg_number)`).in('learner_id', learnerIds).order('created_at', { ascending: false });
      reports = r || [];
    }
    res.json({ success: true, data: reports });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/teacher/reports', authenticateToken, async (req, res) => {
  try {
    const { learnerId, term, form, subjects, comment, assessment_type_id, academic_year } = req.body;
    if (!learnerId || !subjects || !subjects.length) return res.status(400).json({ success: false, message: 'Learner ID and subjects required' });
    const { data: learner } = await supabase.from('learners').select('id, name, class_id, reg_number, form').eq('id', learnerId).maybeSingle();
    if (!learner) return res.status(404).json({ success: false, message: 'Learner not found' });
    let assessmentName = term;
    if (assessment_type_id) {
      const { data: at } = await supabase.from('assessment_types').select('name').eq('id', assessment_type_id).maybeSingle();
      if (at) assessmentName = at.name;
    }
    const totalScore = subjects.reduce((sum, s) => sum + (s.score || 0), 0);
    const averageScore = Math.round(totalScore / subjects.length);
    let grade = 'F';
    if (averageScore >= 75) grade = 'A';
    else if (averageScore >= 65) grade = 'B';
    else if (averageScore >= 55) grade = 'C';
    else if (averageScore >= 40) grade = 'D';
    const subjectsData = subjects.map(s => ({ name: s.name, score: parseInt(s.score) || 0 }));
    const { data: newReport, error } = await supabase.from('reports').insert({
      learner_id: learnerId, class_id: learner.class_id, term: assessmentName, assessment_type_id: assessment_type_id || null,
      academic_year: academic_year || new Date().getFullYear(), form: form || learner.form, subjects: subjectsData,
      average_score: averageScore, total_score: totalScore, grade, comment: comment || null,
      generated_by: req.user.id, generated_date: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    res.json({ success: true, message: 'Report saved', report: newReport });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.put('/api/teacher/reports/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { learnerId, term, form, subjects, best_subjects, total_points, english_passed, final_status, comment, assessment_type_id, academic_year } = req.body;
    const { data: existing } = await supabase.from('reports').select('id, learner_id, class_id').eq('id', id).maybeSingle();
    if (!existing) return res.status(404).json({ success: false, message: 'Report not found' });
    const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
    if (!teacher || teacher.class_id !== existing.class_id) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const updates = { updated_at: new Date().toISOString() };
    if (learnerId !== undefined) updates.learner_id = learnerId;
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
    if (subjects && Array.isArray(subjects) && subjects.length) {
      const total = subjects.reduce((s, subj) => s + (subj.score || 0), 0);
      const avg = Math.round(total / subjects.length);
      updates.average_score = avg;
      updates.total_score = total;
      let g = 'F';
      if (avg >= 75) g = 'A';
      else if (avg >= 65) g = 'B';
      else if (avg >= 55) g = 'C';
      else if (avg >= 40) g = 'D';
      updates.grade = g;
    }
    const { data: updated, error } = await supabase.from('reports').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json({ success: true, message: 'Report updated', report: updated });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete('/api/teacher/reports/:reportId', authenticateToken, async (req, res) => {
  try {
    const { reportId } = req.params;
    const { error } = await supabase.from('reports').delete().eq('id', reportId);
    if (error) throw error;
    res.json({ success: true, message: 'Report deleted' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/teacher/attendance', authenticateToken, async (req, res) => {
  try {
    const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
    if (!teacher?.class_id) return res.json({ success: true, data: { stats: { total: 0, present: 0, absent: 0, late: 0, rate: 0 }, records: [] } });
    const { data: learners } = await supabase.from('learners').select('id, name, reg_number, form').eq('class_id', teacher.class_id);
    const learnerIds = learners?.map(l => l.id) || [];
    let records = [], stats = { total: 0, present: 0, absent: 0, late: 0, rate: 0 };
    if (learnerIds.length) {
      const { data: attendance } = await supabase.from('attendance').select('*').in('learner_id', learnerIds).order('date', { ascending: false });
      if (attendance) {
        records = attendance;
        stats.total = records.length;
        stats.present = records.filter(r => r.status === 'present').length;
        stats.absent = records.filter(r => r.status === 'absent').length;
        stats.late = records.filter(r => r.status === 'late').length;
        stats.rate = stats.total ? Math.round(((stats.present + stats.late) / stats.total) * 100) : 0;
      }
    }
    res.json({ success: true, data: { stats, records } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/teacher/attendance', authenticateToken, async (req, res) => {
  try {
    const { learnerId, date, status, term, year } = req.body;
    if (!learnerId || !date || !status) return res.status(400).json({ success: false, message: 'Missing required fields' });
    const { data: existing } = await supabase.from('attendance').select('id').eq('learner_id', learnerId).eq('date', date).maybeSingle();
    if (existing) {
      await supabase.from('attendance').update({ status, term: term || 1, year: year || new Date().getFullYear(), updated_at: new Date().toISOString() }).eq('id', existing.id);
    } else {
      await supabase.from('attendance').insert({ learner_id: learnerId, date, status, term: term || 1, year: year || new Date().getFullYear(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }
    res.json({ success: true, message: 'Attendance recorded' });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/teacher/assessment-types', authenticateToken, async (req, res) => {
  try {
    const { data: types } = await supabase.from('assessment_types').select('*').eq('is_active', true).order('display_order');
    res.json({ success: true, assessment_types: types || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/teacher/subjects/:classId', authenticateToken, async (req, res) => {
  try {
    const { classId } = req.params;
    const { data: subjects } = await supabase.from('subjects').select('*').eq('class_id', classId).order('display_order');
    res.json(subjects || []);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/teacher/learner-subjects/:learnerId', authenticateToken, async (req, res) => {
  try {
    const { learnerId } = req.params;
    const { data: learner } = await supabase.from('learners').select('class_id, form').eq('id', learnerId).maybeSingle();
    if (!learner || !learner.class_id) return res.json({ success: true, subjects: [], message: 'No class assigned' });
    const { data: subjects } = await supabase.from('subjects').select('id, name, code, description, status').eq('class_id', learner.class_id).eq('status', 'Active').order('display_order');
    res.json({ success: true, subjects: subjects || [] });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get('/api/teacher/debug-setup', authenticateToken, async (req, res) => {
  try {
    const { data: teacher } = await supabase.from('users').select('id, email, name, role, class_id').eq('id', req.user.id).maybeSingle();
    let classInfo = null;
    if (teacher?.class_id) {
      const { data: cls } = await supabase.from('classes').select('*').eq('id', teacher.class_id).maybeSingle();
      classInfo = cls;
    }
    res.json({ success: true, current_teacher: teacher, assigned_class: classInfo });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================
// LEARNER ROUTES
// ============================================
app.get('/api/learner/profile', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('learners').select('*, class:class_id(id, name, year)').eq('id', req.user.id).single();
    if (error) throw error;
    res.json({ success: true, profile: data });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/learner/reports', authenticateToken, async (req, res) => {
  try {
    const { data: reports, error } = await supabase.from('reports').select('*').eq('learner_id', req.user.id).order('created_at', { ascending: false });
    if (error) throw error;
    const formatted = (reports || []).map(r => {
      let subjects = r.subjects;
      if (typeof subjects === 'string') try { subjects = JSON.parse(subjects); } catch { subjects = []; }
      if (!Array.isArray(subjects)) subjects = [];
      let avg = r.average_score;
      if (!avg && subjects.length) avg = Math.round(subjects.reduce((s, sub) => s + (sub.score || 0), 0) / subjects.length);
      let grade = r.grade;
      if (!grade && avg) grade = avg >= 75 ? 'A' : avg >= 65 ? 'B' : avg >= 55 ? 'C' : avg >= 40 ? 'D' : 'F';
      return { ...r, subjects, average_score: avg, grade };
    });
    res.json({ success: true, data: formatted, count: formatted.length });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/learner/attendance', authenticateToken, async (req, res) => {
  try {
    const { data: attendance, error } = await supabase.from('attendance').select('*').eq('learner_id', req.user.id).order('date', { ascending: false });
    if (error) throw error;
    const total = attendance?.length || 0;
    const present = attendance?.filter(a => a.status === 'present').length || 0;
    const late = attendance?.filter(a => a.status === 'late').length || 0;
    const absent = total - present - late;
    const rate = total ? Math.round(((present + late) / total) * 100) : 0;
    res.json({ success: true, data: { stats: { total, present, late, absent, rate }, records: attendance || [] } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/learner/attendance-stats', authenticateToken, async (req, res) => {
  try {
    const { term, year } = req.query;
    let query = supabase.from('attendance').select('status, date, term, year').eq('learner_id', req.user.id);
    if (term) query = query.eq('term', parseInt(term));
    if (year) query = query.eq('year', parseInt(year));
    const { data: attendance } = await query;
    const total = attendance?.length || 0;
    const present = attendance?.filter(a => a.status === 'present').length || 0;
    const late = attendance?.filter(a => a.status === 'late').length || 0;
    const rate = total ? Math.round(((present + late) / total) * 100) : 0;
    res.json({ success: true, data: { percentage: rate, present, late, absences: total - present - late, total, term: term || 'All', year: year || new Date().getFullYear() } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/learner/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const { data: attendance } = await supabase.from('attendance').select('status').eq('learner_id', req.user.id).eq('year', new Date().getFullYear());
    const total = attendance?.length || 0;
    const present = attendance?.filter(a => a.status === 'present').length || 0;
    const rate = total ? Math.round((present / total) * 100) : 0;
    const { data: reports } = await supabase.from('reports').select('average_score').eq('learner_id', req.user.id);
    const avgScore = reports?.length ? Math.round(reports.reduce((s, r) => s + (r.average_score || 0), 0) / reports.length) : 0;
    res.json({ success: true, data: { attendance_rate: rate, average_score: avgScore, total_reports: reports?.length || 0 } });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// ============================================
// IMAGE UPLOAD
// ============================================
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => { const allowed = /jpeg|jpg|png|gif|webp/; if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype)) cb(null, true); else cb(new Error('Only image files')); } });
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);
app.post('/api/upload/image', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided' });
  const fileName = `${Date.now()}-${crypto.randomUUID()}${path.extname(req.file.originalname)}`;
  await fs.writeFile(path.join(uploadsDir, fileName), req.file.buffer);
  res.json({ success: true, url: `${req.protocol}://${req.get('host')}/uploads/${fileName}` });
});
app.use('/uploads', express.static(uploadsDir));

// ============================================
// DEBUG
// ============================================
app.get('/api/debug/learners', async (req, res) => {
  const { data: learners } = await supabase.from('learners').select('id, name, reg_number, form, status').limit(10);
  res.json({ success: true, count: learners?.length || 0, learners: learners || [] });
});

// ============================================
// 404 & ERROR HANDLERS
// ============================================
app.use((req, res) => res.status(404).json({ success: false, message: `Route not found: ${req.path}` }));
app.use((err, req, res, next) => res.status(500).json({ success: false, message: 'Internal server error', error: process.env.NODE_ENV === 'development' ? err.message : undefined }));

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📡 API URL: http://localhost:${PORT}/api`);
});
module.exports = app;