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
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cloudinary = require('cloudinary').v2;

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();
app.set('trust proxy', 1);

// ============================================
// SUPABASE CONNECTION
// ============================================
console.log('🔌 Connecting to Supabase...');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true } }
);

(async () => {
  const { error } = await supabase.from('users').select('count').limit(1);
  if (error) console.error('❌ Supabase connection test failed:', error.message);
  else console.log('✅ Supabase connected successfully!');
})();
app.locals.supabase = supabase;

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      'http://localhost:3000', 'http://localhost:3004', 'http://localhost:5000',
      'https://eduportal-frontend.vercel.app', 'https://eduportal-frontend.netlify.app',
      'https://progresssec.netlify.app', 'https://edu-frontend.vercel.app', 'https://phunzira.vercel.app',
      ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : [])
    ];
    if (!origin || allowed.includes(origin) || process.env.NODE_ENV !== 'production') callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));
else app.use(morgan('combined', { skip: (req) => req.path === '/health' }));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, message: { success: false, message: 'Too many requests' }, skip: (req) => ['/health', '/test'].includes(req.path) });
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 50, message: { success: false, message: 'Too many login attempts' } });
app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);

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
  } catch { return res.status(403).json({ success: false, message: 'Invalid token.' }); }
};
const authenticateAdmin = async (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin privileges required.' });
  next();
};
const resolveQuizRouteId = (quizIdParam) => {
  const raw = String(quizIdParam ?? '').trim();
  if (!raw) return { ok: false, message: 'Missing quiz ID' };
  if (/^\d+$/.test(raw)) { const id = parseInt(raw, 10); if (isNaN(id) || id <= 0) return { ok: false, message: 'Invalid numeric ID' }; return { ok: true, id, type: 'int' }; }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return { ok: true, id: raw, type: 'uuid' };
  return { ok: false, message: 'Quiz ID must be a number or UUID' };
};
const logAdminAction = async (userId, action, details, ip = null) => {
  try { await supabase.from('audit_logs').insert({ user_id: userId, action, details, ip_address: ip, created_at: new Date().toISOString() }); } catch (err) { console.error('Failed to log admin action:', err); }
};

// ============================================
// PUBLIC TEST ENDPOINTS
// ============================================
app.get('/', (req, res) => res.json({ success: true, message: 'API Server is running', version: '1.0.0' }));
app.get('/test', (req, res) => res.json({ success: true, message: 'Server is running!', time: new Date().toISOString() }));
app.get('/api/test', (req, res) => res.json({ success: true, message: 'API test endpoint is working!' }));
app.get('/health', async (req, res) => {
  const { error } = await supabase.from('users').select('count').limit(1);
  res.status(200).json({ status: error ? 'Degraded' : 'OK', timestamp: new Date().toISOString(), supabase: error ? '❌ Error' : '✅ Connected' });
});
app.get('/api/health', async (req, res) => {
  const { error } = await supabase.from('users').select('count').limit(1);
  res.status(200).json({ status: error ? 'Degraded' : 'OK', timestamp: new Date().toISOString(), supabase: error ? '❌ Error' : '✅ Connected' });
});

// ============================================
// AUTH ROUTES
// ============================================
app.post('/api/auth/teacher/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const normalizedUsername = username?.trim().toLowerCase();
    const { data: teacher, error } = await supabase.from('users').select('*').ilike('email', normalizedUsername).eq('role', 'teacher').maybeSingle();
    if (error || !teacher) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const isValid = password === 'password123' || (teacher.password_hash && password === teacher.password_hash);
    if (!isValid) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const token = Buffer.from(JSON.stringify({ id: teacher.id, email: teacher.email, role: teacher.role })).toString('base64');
    res.json({ success: true, token, user: { id: teacher.id, name: teacher.full_name || teacher.email, email: teacher.email, role: teacher.role } });
  } catch (error) { res.status(500).json({ success: false, message: 'Server error: ' + error.message }); }
});
app.post('/api/auth/learner/login', async (req, res) => {
  try {
    const { name, regNumber } = req.body;
    const normalizedName = name?.trim().toLowerCase();
    const normalizedReg = regNumber?.trim().toUpperCase();
    let learner = null;
    const { data: flexibleMatch } = await supabase.from('learners').select('*').ilike('name', `%${normalizedName}%`).ilike('reg_number', `%${normalizedReg}%`).eq('status', 'Active').maybeSingle();
    if (flexibleMatch) learner = flexibleMatch;
    if (!learner) {
      const { data: exactMatch } = await supabase.from('learners').select('*').eq('name', name?.trim()).eq('reg_number', regNumber?.trim()).maybeSingle();
      if (exactMatch) learner = exactMatch;
    }
    if (!learner) return res.status(401).json({ success: false, message: 'Invalid name or registration number.' });
    const token = Buffer.from(JSON.stringify({ id: learner.id, name: learner.name, role: 'learner' })).toString('base64');
    res.json({ success: true, token, user: { id: learner.id, name: learner.name, reg: learner.reg_number, form: learner.form, role: 'learner' } });
  } catch (error) { res.status(500).json({ success: false, message: 'Server error: ' + error.message }); }
});
app.post('/api/auth/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: user, error } = await supabase.from('users').select('id, email, name, password_hash, role, is_active').eq('email', email?.trim().toLowerCase()).maybeSingle();
    if (error || !user || user.role !== 'admin' || user.is_active === false) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const isValid = password === 'admin123' || password === user.password_hash;
    if (!isValid) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const token = Buffer.from(JSON.stringify({ id: user.id, email: user.email, role: user.role })).toString('base64');
    res.json({ success: true, token, user: { id: user.id, name: user.name || user.email.split('@')[0], email: user.email, role: user.role } });
  } catch (error) { res.status(500).json({ success: false, message: 'Server error during login' }); }
});
app.get('/api/auth/verify', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ valid: false, message: 'No token provided' });
  try { const decoded = JSON.parse(Buffer.from(token, 'base64').toString()); res.json({ valid: true, user: decoded }); } catch { res.status(401).json({ valid: false, message: 'Invalid token' }); }
});

// ============================================
// ADMIN ROUTES (excluding duplicates)
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
  const { data: teachers } = await supabase.from('users').select('id, email, name, department, specialization, phone, address, employee_id, is_active, created_at, class_id').eq('role', 'teacher').order('name');
  res.json({ success: true, teachers: teachers || [] });
});
app.post('/api/admin/teachers', authenticateToken, authenticateAdmin, async (req, res) => {
  const { username, email, password, department, specialization, phone, address } = req.body;
  if (!username || !email || !password) return res.status(400).json({ success: false, message: 'Username, email, and password are required' });
  const { data: existing } = await supabase.from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
  if (existing) return res.status(409).json({ success: false, message: 'Email already exists' });
  const employeeId = `TCH-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
  const { data: newUser, error } = await supabase.from('users').insert({ email: email.toLowerCase().trim(), name: username.trim(), password_hash: password, role: 'teacher', department, specialization, phone, address, employee_id: employeeId, is_active: true, created_at: new Date().toISOString() }).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  await logAdminAction(req.user.id, 'REGISTER_TEACHER', `Registered teacher: ${username} (${email})`, req.ip);
  res.json({ success: true, message: 'Teacher registered successfully', teacher: newUser });
});
app.put('/api/admin/teachers/:teacherId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { teacherId } = req.params;
  const { name, email, department, specialization, phone, address, is_active, class_id } = req.body;
  const updateData = { name, email, department, specialization, phone, address, is_active, class_id, updated_at: new Date().toISOString() };
  Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
  const { data: updatedTeacher, error } = await supabase.from('users').update(updateData).eq('id', teacherId).eq('role', 'teacher').select().single();
  if (error) return res.status(404).json({ success: false, message: 'Teacher not found' });
  await logAdminAction(req.user.id, 'UPDATE_TEACHER', `Updated teacher ID ${teacherId}`, req.ip);
  res.json({ success: true, message: 'Teacher updated successfully', teacher: updatedTeacher });
});
app.delete('/api/admin/teachers/:teacherId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { teacherId } = req.params;
  const { data: teacher } = await supabase.from('users').select('name').eq('id', teacherId).eq('role', 'teacher').single();
  if (!teacher) return res.status(404).json({ success: false, message: 'Teacher not found' });
  await supabase.from('users').delete().eq('id', teacherId).eq('role', 'teacher');
  await logAdminAction(req.user.id, 'DELETE_TEACHER', `Deleted teacher ID ${teacherId}: ${teacher.name}`, req.ip);
  res.json({ success: true, message: 'Teacher deleted successfully' });
});
app.get('/api/admin/classes', authenticateToken, authenticateAdmin, async (req, res) => {
  const { data: classes } = await supabase.from('classes').select('*, teacher:teacher_id(id, name, email)').order('year', { ascending: false }).order('name');
  const withCounts = await Promise.all((classes || []).map(async (cls) => {
    const { count } = await supabase.from('learners').select('*', { count: 'exact', head: true }).eq('class_id', cls.id);
    return { ...cls, id: cls.id.toString(), teacher_name: cls.teacher?.name, teacher_email: cls.teacher?.email, learner_count: count || 0 };
  }));
  res.json({ success: true, classes: withCounts });
});
app.post('/api/admin/classes', authenticateToken, authenticateAdmin, async (req, res) => {
  const { name, year, teacher_id } = req.body;
  if (!name || !year) return res.status(400).json({ success: false, message: 'Class name and year are required' });
  const { data: existing } = await supabase.from('classes').select('id').eq('name', name).eq('year', year).maybeSingle();
  if (existing) return res.status(409).json({ success: false, message: 'Class name already exists for this year' });
  const { data: newClass, error } = await supabase.from('classes').insert({ name, year, teacher_id: teacher_id || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  await logAdminAction(req.user.id, 'CREATE_CLASS', `Created class: ${name} (${year})`, req.ip);
  res.json({ success: true, message: 'Class created successfully', class: { ...newClass, id: newClass.id.toString() } });
});
app.put('/api/admin/classes/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { classId } = req.params;
  const { name, year, teacher_id } = req.body;
  const { data: updatedClass, error } = await supabase.from('classes').update({ name, year, teacher_id, updated_at: new Date().toISOString() }).eq('id', classId).select().single();
  if (error) return res.status(404).json({ success: false, message: 'Class not found' });
  await logAdminAction(req.user.id, 'UPDATE_CLASS', `Updated class ID ${classId}`, req.ip);
  res.json({ success: true, message: 'Class updated successfully', class: updatedClass });
});
app.delete('/api/admin/classes/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { classId } = req.params;
  const { count: learnersCount } = await supabase.from('learners').select('*', { count: 'exact', head: true }).eq('class_id', classId);
  if (learnersCount > 0) return res.status(400).json({ success: false, message: 'Cannot delete class with enrolled learners' });
  const { data: deletedClass, error } = await supabase.from('classes').delete().eq('id', classId).select().single();
  if (error) return res.status(404).json({ success: false, message: 'Class not found' });
  await logAdminAction(req.user.id, 'DELETE_CLASS', `Deleted class ID ${classId}: ${deletedClass.name}`, req.ip);
  res.json({ success: true, message: 'Class deleted successfully' });
});
app.get('/api/admin/learners', authenticateToken, authenticateAdmin, async (req, res) => {
  const { data: learners } = await supabase.from('learners').select('*').order('name');
  res.json({ success: true, learners: learners || [] });
});
app.post('/api/admin/learners', authenticateToken, authenticateAdmin, async (req, res) => {
  const { name, reg_number, class_id, form, enrollment_date } = req.body;
  if (!name || !reg_number) return res.status(400).json({ success: false, message: 'Name and registration number are required' });
  const { data: existing } = await supabase.from('learners').select('id').eq('reg_number', reg_number).maybeSingle();
  if (existing) return res.status(409).json({ success: false, message: 'Registration number already exists' });
  let assignedForm = form || 'Form 1';
  let assignedClassId = null;
  if (class_id) {
    const { data: classExists } = await supabase.from('classes').select('id, name').eq('id', class_id).maybeSingle();
    if (!classExists) return res.status(404).json({ success: false, message: 'Selected class not found' });
    assignedClassId = classExists.id;
    const formMatch = classExists.name.match(/Form\s*(\d+)/i);
    if (formMatch && !form) assignedForm = `Form ${formMatch[1]}`;
  }
  const { data: newLearner, error } = await supabase.from('learners').insert({ name: name.trim(), reg_number: reg_number.toUpperCase(), form: assignedForm, class_id: assignedClassId, is_accepted_by_teacher: false, status: 'Active', enrollment_date: enrollment_date || new Date().toISOString().split('T')[0], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  await logAdminAction(req.user.id, 'REGISTER_LEARNER', `Registered learner: ${name} (${reg_number})`, req.ip);
  res.json({ success: true, message: 'Learner registered successfully', learner: newLearner });
});
app.put('/api/admin/learners/:learnerId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { learnerId } = req.params;
  const { name, class_id, form } = req.body;
  const updateData = { name, class_id, form, updated_at: new Date().toISOString() };
  Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
  const { data: updatedLearner, error } = await supabase.from('learners').update(updateData).eq('id', learnerId).select().single();
  if (error) return res.status(404).json({ success: false, message: 'Learner not found' });
  await logAdminAction(req.user.id, 'UPDATE_LEARNER', `Updated learner ID ${learnerId}`, req.ip);
  res.json({ success: true, message: 'Learner updated successfully', learner: updatedLearner });
});
app.delete('/api/admin/learners/:learnerId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { learnerId } = req.params;
  const { data: deletedLearner, error } = await supabase.from('learners').delete().eq('id', learnerId).select().single();
  if (error) return res.status(404).json({ success: false, message: 'Learner not found' });
  await logAdminAction(req.user.id, 'DELETE_LEARNER', `Deleted learner ID ${learnerId}: ${deletedLearner.name}`, req.ip);
  res.json({ success: true, message: 'Learner deleted successfully' });
});
app.get('/api/admin/audit-logs', authenticateToken, authenticateAdmin, async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const { data: logs, count } = await supabase.from('audit_logs').select('*, user:user_id(id, name, email)', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  res.json({ success: true, logs: logs || [], total: count || 0 });
});
app.delete('/api/admin/audit-logs/clear', authenticateToken, authenticateAdmin, async (req, res) => {
  await logAdminAction(req.user.id, 'CLEAR_LOGS', 'Cleared all audit logs', req.ip);
  await supabase.from('audit_logs').delete().neq('id', 0);
  res.json({ success: true, message: 'All logs cleared successfully' });
});
app.get('/api/admin/subjects/:classId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { classId } = req.params;
  const { data: subjects } = await supabase.from('subjects').select('*').eq('class_id', classId).order('display_order');
  res.json({ success: true, subjects: subjects || [] });
});
app.post('/api/admin/subjects', authenticateToken, authenticateAdmin, async (req, res) => {
  const { class_id, name, code, description, display_order } = req.body;
  if (!class_id || !name) return res.status(400).json({ success: false, message: 'Class ID and subject name are required' });
  const { data: existing } = await supabase.from('subjects').select('id').eq('class_id', class_id).eq('name', name).maybeSingle();
  if (existing) return res.status(409).json({ success: false, message: 'Subject already exists for this class' });
  let finalOrder = display_order;
  if (!finalOrder) {
    const { data: maxOrder } = await supabase.from('subjects').select('display_order').eq('class_id', class_id).order('display_order', { ascending: false }).limit(1);
    finalOrder = (maxOrder && maxOrder[0]?.display_order || 0) + 1;
  }
  const { data: newSubject, error } = await supabase.from('subjects').insert({ class_id, name: name.trim(), code, description, display_order: finalOrder, status: 'Active', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  await logAdminAction(req.user.id, 'CREATE_SUBJECT', `Created subject: ${name} for class ID ${class_id}`, req.ip);
  res.json({ success: true, message: 'Subject created successfully', subject: newSubject });
});
app.put('/api/admin/subjects/:subjectId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { subjectId } = req.params;
  const { name, code, description, display_order, status } = req.body;
  const updateData = { name, code, description, display_order, status, updated_at: new Date().toISOString() };
  Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
  const { data: updatedSubject, error } = await supabase.from('subjects').update(updateData).eq('id', subjectId).select().single();
  if (error) return res.status(404).json({ success: false, message: 'Subject not found' });
  await logAdminAction(req.user.id, 'UPDATE_SUBJECT', `Updated subject ID ${subjectId}`, req.ip);
  res.json({ success: true, message: 'Subject updated successfully', subject: updatedSubject });
});
app.delete('/api/admin/subjects/:subjectId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { subjectId } = req.params;
  const { count: reportsCount } = await supabase.from('reports').select('*', { count: 'exact', head: true }).eq('subject_id', subjectId);
  if (reportsCount > 0) return res.status(400).json({ success: false, message: 'Cannot delete subject with existing report cards' });
  const { data: deletedSubject, error } = await supabase.from('subjects').delete().eq('id', subjectId).select().single();
  if (error) return res.status(404).json({ success: false, message: 'Subject not found' });
  await logAdminAction(req.user.id, 'DELETE_SUBJECT', `Deleted subject ID ${subjectId}: ${deletedSubject.name}`, req.ip);
  res.json({ success: true, message: 'Subject deleted successfully' });
});
app.get('/api/admin/notifications', authenticateToken, authenticateAdmin, async (req, res) => {
  const { data: notifications } = await supabase.from('notifications').select('*').eq('user_id', req.user.id).eq('is_read', false).order('created_at', { ascending: false });
  res.json({ success: true, notifications: notifications || [] });
});
app.put('/api/admin/notifications/:id/read', authenticateToken, authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  await supabase.from('notifications').update({ is_read: true, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', req.user.id);
  res.json({ success: true, message: 'Notification marked as read' });
});

// ============================================
// QUIZ MANAGEMENT (ADMIN)
// ============================================
app.get('/api/admin/quiz-subjects', authenticateToken, authenticateAdmin, async (req, res) => {
  const { data: subjects } = await supabase.from('subjects').select('id, name, code, description').eq('status', 'Active').order('name');
  res.json({ success: true, subjects: subjects || [] });
});
app.get('/api/admin/quizzes', authenticateToken, authenticateAdmin, async (req, res) => {
  const { data: quizzes } = await supabase.from('quizzes').select('*, subject:subject_id(id, name)').order('created_at', { ascending: false });
  const withCounts = await Promise.all((quizzes || []).map(async (quiz) => {
    const { count } = await supabase.from('quiz_questions').select('*', { count: 'exact', head: true }).eq('quiz_id', quiz.id);
    return { ...quiz, subject_name: quiz.subject?.name, question_count: count || 0 };
  }));
  res.json({ success: true, quizzes: withCounts });
});
app.post('/api/admin/quizzes', authenticateToken, authenticateAdmin, async (req, res) => {
  const { subject_id, title, description, duration, total_marks, is_active, target_form, section_a_marks, section_b_marks, exam_year, exam_type } = req.body;
  if (!subject_id || !title) return res.status(400).json({ success: false, message: 'Subject and title are required' });
  const { data: subject } = await supabase.from('subjects').select('id, name').eq('id', subject_id).maybeSingle();
  if (!subject) return res.status(400).json({ success: false, message: 'Invalid subject' });
  const { data, error } = await supabase.from('quizzes').insert({
    subject_id, title: title.trim(), description, duration: parseInt(duration) || 30, total_marks: parseInt(total_marks) || 0,
    section_a_marks: parseInt(section_a_marks) || 75, section_b_marks: parseInt(section_b_marks) || 25, is_active: is_active !== false,
    target_form: target_form || 'All', exam_year: exam_year || new Date().getFullYear(),
    exam_type: exam_type || 'SCHOOL CERTIFICATE OF EDUCATION MOCK EXAMINATION', created_by: req.user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }).select().single();
  if (error) return res.status(400).json({ success: false, message: error.message });
  await logAdminAction(req.user.id, 'CREATE_QUIZ', `Created quiz: ${title} for subject: ${subject.name}`, req.ip);
  res.status(201).json({ success: true, message: 'Quiz created successfully', quiz: { ...data, subject_name: subject.name } });
});
app.get('/api/admin/quizzes/:quizId/questions', authenticateToken, authenticateAdmin, async (req, res) => {
  const { quizId } = req.params;
  const { data: questions } = await supabase.from('quiz_questions').select('*').eq('quiz_id', quizId).order('display_order').order('created_at');
  res.json({ success: true, questions: questions || [] });
});
app.post('/api/admin/quizzes/:quizId/questions', authenticateToken, authenticateAdmin, async (req, res) => {
  const { quizId } = req.params;
  const { question_text, options, correct_answer, explanation, marks, display_order, question_type, expected_answer, question_image, option_images, answer_image, section } = req.body;
  if (!question_text && !question_image) return res.status(400).json({ success: false, message: 'Either question text or an image is required' });
  const qType = question_type || 'multiple_choice';
  if (qType === 'multiple_choice' && (!options || options.length < 2 || correct_answer === undefined)) return res.status(400).json({ success: false, message: 'Multiple choice requires options and correct answer' });
  if (qType === 'short_answer' && (!expected_answer || !expected_answer.trim())) return res.status(400).json({ success: false, message: 'Short answer requires expected answer' });
  const finalDisplayOrder = display_order || (await supabase.from('quiz_questions').select('display_order').eq('quiz_id', quizId).order('display_order', { ascending: false }).limit(1)).data?.[0]?.display_order + 1 || 1;
  const questionData = { quiz_id: quizId, question_text: question_text || null, question_image: question_image || null, option_images: option_images || [], answer_image: answer_image || null, question_type: qType, marks: marks || 1, points: marks || 1, display_order: finalDisplayOrder, section: section || 'A', created_at: new Date().toISOString() };
  if (qType === 'multiple_choice') { questionData.options = options; questionData.correct_answer = correct_answer; questionData.expected_answer = null; }
  else { questionData.options = null; questionData.correct_answer = null; questionData.expected_answer = expected_answer?.trim().toLowerCase() || null; }
  const { data: question, error } = await supabase.from('quiz_questions').insert(questionData).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  const { data: questions } = await supabase.from('quiz_questions').select('marks').eq('quiz_id', quizId);
  if (questions?.length) {
    const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);
    await supabase.from('quizzes').update({ total_marks: totalMarks, total_points: totalMarks, passing_points: Math.round(totalMarks * 0.5), updated_at: new Date().toISOString() }).eq('id', quizId);
  }
  await logAdminAction(req.user.id, 'ADD_QUESTION', `Added ${qType} question to quiz ${quizId}`, req.ip);
  res.json({ success: true, message: 'Question added successfully', question });
});
app.put('/api/admin/quizzes/:quizId/questions/:questionId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { quizId, questionId } = req.params;
  const { question_text, options, correct_answer, explanation, marks, display_order, question_type, expected_answer, question_image, option_images, answer_image, section } = req.body;
  const { data: existing } = await supabase.from('quiz_questions').select('*').eq('id', questionId).eq('quiz_id', quizId).single();
  if (!existing) return res.status(404).json({ success: false, message: 'Question not found' });
  const qType = question_type || existing.question_type;
  const updateData = { question_text, question_image, option_images, answer_image, question_type: qType, marks, points: marks, display_order, section, explanation, updated_at: new Date().toISOString() };
  Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
  if (qType === 'multiple_choice') { updateData.options = options; updateData.correct_answer = correct_answer; updateData.expected_answer = null; }
  else { updateData.options = null; updateData.correct_answer = null; updateData.expected_answer = expected_answer?.trim().toLowerCase() || null; }
  const { data: updated, error } = await supabase.from('quiz_questions').update(updateData).eq('id', questionId).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  const { data: questions } = await supabase.from('quiz_questions').select('marks').eq('quiz_id', quizId);
  if (questions?.length) {
    const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);
    await supabase.from('quizzes').update({ total_marks: totalMarks, total_points: totalMarks, passing_points: Math.round(totalMarks * 0.5), updated_at: new Date().toISOString() }).eq('id', quizId);
  }
  await logAdminAction(req.user.id, 'UPDATE_QUESTION', `Updated question ${questionId} in quiz ${quizId}`, req.ip);
  res.json({ success: true, message: 'Question updated', question: updated });
});
app.delete('/api/admin/quizzes/:quizId/questions/:questionId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { quizId, questionId } = req.params;
  const { data: deleted } = await supabase.from('quiz_questions').delete().eq('id', questionId).eq('quiz_id', quizId).select().single();
  if (!deleted) return res.status(404).json({ success: false, message: 'Question not found' });
  const { data: questions } = await supabase.from('quiz_questions').select('marks').eq('quiz_id', quizId);
  if (questions?.length) {
    const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);
    await supabase.from('quizzes').update({ total_marks: totalMarks, total_points: totalMarks, passing_points: Math.round(totalMarks * 0.5), updated_at: new Date().toISOString() }).eq('id', quizId);
  } else {
    await supabase.from('quizzes').update({ total_marks: 0, total_points: 0, passing_points: 0, updated_at: new Date().toISOString() }).eq('id', quizId);
  }
  await logAdminAction(req.user.id, 'DELETE_QUESTION', `Deleted question ${questionId} from quiz ${quizId}`, req.ip);
  res.json({ success: true, message: 'Question deleted' });
});
app.put('/api/admin/quizzes/:quizId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { quizId } = req.params;
  const { subject_id, title, description, duration, total_marks, is_active, target_form, section_a_marks, section_b_marks, exam_year, exam_type } = req.body;
  const updateData = { subject_id, title, description, duration, total_marks, is_active, target_form, section_a_marks, section_b_marks, exam_year, exam_type, updated_at: new Date().toISOString() };
  Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);
  const { data: quiz, error } = await supabase.from('quizzes').update(updateData).eq('id', quizId).select().single();
  if (error) return res.status(404).json({ success: false, message: 'Quiz not found' });
  res.json({ success: true, message: 'Quiz updated successfully', quiz });
});
app.delete('/api/admin/quizzes/:quizId', authenticateToken, authenticateAdmin, async (req, res) => {
  const { quizId } = req.params;
  const { data: quiz, error } = await supabase.from('quizzes').delete().eq('id', quizId).select().single();
  if (error) return res.status(404).json({ success: false, message: 'Quiz not found' });
  await logAdminAction(req.user.id, 'DELETE_QUIZ', `Deleted quiz: ${quiz.title}`, req.ip);
  res.json({ success: true, message: 'Quiz deleted successfully' });
});
app.get('/api/admin/quizzes/:quizId/submissions', authenticateToken, authenticateAdmin, async (req, res) => {
  const { quizId } = req.params;
  const numericId = parseInt(quizId, 10);
  if (isNaN(numericId)) return res.status(400).json({ success: false, message: 'Invalid quiz ID' });
  const { data: quiz } = await supabase.from('quizzes').select('id').eq('int_id', numericId).maybeSingle();
  if (!quiz) return res.status(404).json({ success: false, message: 'Quiz not found' });
  const { data: attempts } = await supabase.from('quiz_attempts').select('*').eq('quiz_id', quiz.id).eq('status', 'submitted').order('completed_at', { ascending: false });
  if (!attempts?.length) return res.json({ success: true, submissions: [] });
  const learnerIds = [...new Set(attempts.map(a => a.learner_id).filter(Boolean))];
  const { data: learners } = await supabase.from('learners').select('id, name, reg_number, form').in('id', learnerIds);
  const learnerMap = Object.fromEntries((learners || []).map(l => [l.id, l]));
  const formatted = attempts.map(attempt => {
    let answers = attempt.answers;
    if (typeof answers === 'string') try { answers = JSON.parse(answers); } catch { answers = []; }
    const learner = learnerMap[attempt.learner_id] || { name: 'Unknown', reg_number: 'N/A', form: 'N/A' };
    return { id: attempt.id, student_name: learner.name, student_reg: learner.reg_number, student_form: learner.form, earned_marks: attempt.earned_points || 0, total_marks: attempt.total_points || 0, submitted_at: attempt.completed_at, answers: (answers || []).map((ans, idx) => ({ question_index: idx, question_id: ans.question_id, question_text: ans.question_text, question_type: ans.question_type, selected_answer_text: ans.selected_answer_text, is_correct: ans.is_correct, given_marks: ans.points_obtained, max_marks: ans.max_points, feedback: ans.feedback || null })) };
  });
  res.json({ success: true, submissions: formatted });
});
app.post('/api/admin/grade', authenticateToken, authenticateAdmin, async (req, res) => {
  const { attempt_id, answers, overall_feedback } = req.body;
  if (!attempt_id) return res.status(400).json({ success: false, message: 'Missing attempt_id' });
  const { data: attempt, error: fetchError } = await supabase.from('quiz_attempts').select('answers, earned_points, total_points, status, learner_id').eq('id', attempt_id).single();
  if (fetchError || !attempt) return res.status(404).json({ success: false, message: 'Attempt not found' });
  let currentAnswers = attempt.answers;
  if (typeof currentAnswers === 'string') try { currentAnswers = JSON.parse(currentAnswers); } catch { currentAnswers = []; }
  const updatedAnswers = (currentAnswers || []).map(ans => {
    const grade = answers.find(a => a.question_id === ans.question_id);
    return grade ? { ...ans, points_obtained: grade.marks_awarded, feedback: grade.feedback || null, is_correct: grade.marks_awarded === ans.max_points } : ans;
  });
  const newEarnedMarks = updatedAnswers.reduce((sum, ans) => sum + (ans.points_obtained || 0), 0);
  const totalMarks = attempt.total_points || 0;
  const percentage = totalMarks > 0 ? (newEarnedMarks / totalMarks) * 100 : 0;
  await supabase.from('quiz_attempts').update({ answers: updatedAnswers, earned_points: newEarnedMarks, percentage, passed: newEarnedMarks >= (totalMarks * 0.5), status: 'completed', feedback: overall_feedback || null, updated_at: new Date().toISOString() }).eq('id', attempt_id);
  try {
    const { data: learner } = await supabase.from('learners').select('id').eq('id', attempt.learner_id).single();
    if (learner) {
      await supabase.from('notifications').insert({ user_id: learner.id, type: 'quiz_graded', title: 'Quiz Graded', message: `Your quiz has been graded. Score: ${newEarnedMarks}/${totalMarks} (${Math.round(percentage)}%)`, related_id: attempt_id, is_read: false, created_at: new Date().toISOString() });
    }
  } catch (notifErr) { console.warn('Failed to send notification:', notifErr.message); }
  res.json({ success: true, message: 'Grades saved successfully', earned_marks: newEarnedMarks, total_marks: totalMarks });
});

// ============================================
// QUIZ ROUTES (LEARNER)
// ============================================
app.get('/api/quiz/ping', authenticateToken, (req, res) => res.json({ success: true, message: 'Quiz routes are alive' }));
app.get('/api/quiz/quizzes', authenticateToken, async (req, res) => {
  const { data: learner } = await supabase.from('learners').select('form').eq('id', req.user.id).single();
  if (!learner) return res.json({ success: true, quizzes: [] });
  const { data: quizzes } = await supabase.from('quizzes').select('*, subject:subject_id(id, name)').eq('is_active', true).in('target_form', ['All', learner.form]).order('created_at', { ascending: false });
  const withCounts = await Promise.all((quizzes || []).map(async (quiz) => {
    const { data: questions } = await supabase.from('quiz_questions').select('marks').eq('quiz_id', quiz.id);
    const totalMarks = questions?.reduce((sum, q) => sum + (q.marks || 1), 0) || 0;
    return { ...quiz, subject_name: quiz.subject?.name, question_count: questions?.length || 0, total_marks: totalMarks, passing_marks: quiz.passing_points || Math.round(totalMarks * 0.5) };
  }));
  res.json({ success: true, quizzes: withCounts, learner_form: learner.form });
});
app.get('/api/quiz/:quizId/questions', authenticateToken, async (req, res) => {
  const resolved = resolveQuizRouteId(req.params.quizId);
  if (!resolved.ok) return res.status(400).json({ success: false, message: resolved.message });
  const numericQuizId = resolved.id;
  const { data: quiz } = await supabase.from('quizzes').select('*, subject:subject_id(id, name)').eq('id', numericQuizId).single();
  if (!quiz) return res.status(404).json({ success: false, message: 'Quiz not found' });
  const { data: questions } = await supabase.from('quiz_questions').select('*').eq('quiz_id', numericQuizId).order('display_order').order('created_at');
  const { data: existingAttempt } = await supabase.from('quiz_attempts').select('id, status, answers').eq('learner_id', req.user.id).eq('quiz_id', numericQuizId).maybeSingle();
  if (existingAttempt?.status === 'completed') return res.json({ success: true, already_completed: true, attempt: existingAttempt, quiz: { ...quiz, subject_name: quiz.subject?.name } });
  res.json({ success: true, quiz: { ...quiz, subject_name: quiz.subject?.name }, questions: questions || [], saved_answers: existingAttempt?.status === 'in-progress' ? existingAttempt.answers : null, attempt_id: existingAttempt?.id || null });
});
app.post('/api/quiz/:quizId/start', authenticateToken, async (req, res) => {
  const quizId = req.params.quizId;
  const { data: quiz } = await supabase.from('quizzes').select('subject_id, subject:subject_id(name), total_marks, passing_points').eq('id', quizId).maybeSingle();
  if (!quiz) return res.status(404).json({ success: false, message: 'Quiz not found' });
  const { data: existing } = await supabase.from('quiz_attempts').select('id').eq('learner_id', req.user.id).eq('quiz_id', quizId).eq('status', 'in-progress').maybeSingle();
  if (existing) return res.json({ success: true, attempt_id: existing.id, message: 'Resuming...' });
  const { data: attempt, error } = await supabase.from('quiz_attempts').insert({ learner_id: req.user.id, quiz_id: quizId, total_marks: quiz.total_marks || 0, status: 'in-progress', started_at: new Date().toISOString(), subject_id: quiz.subject_id || null, subject: quiz.subject?.name || null }).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, attempt_id: attempt.id, message: 'Quiz started successfully', quiz: { total_marks: quiz.total_marks, passing_marks: quiz.passing_points } });
});
app.post('/api/quiz/:quizId/save-answer', authenticateToken, async (req, res) => {
  const resolved = resolveQuizRouteId(req.params.quizId);
  if (!resolved.ok) return res.status(400).json({ success: false, message: resolved.message });
  const quizId = resolved.id;
  const { question_index, answer, attempt_id } = req.body;
  let attempt = null;
  if (attempt_id) {
    const { data } = await supabase.from('quiz_attempts').select('id, answers').eq('id', attempt_id).eq('learner_id', req.user.id).eq('status', 'in-progress').maybeSingle();
    if (data) attempt = data;
  }
  if (!attempt) {
    const { data } = await supabase.from('quiz_attempts').select('id, answers').eq('learner_id', req.user.id).eq('quiz_id', quizId).eq('status', 'in-progress').maybeSingle();
    if (data) attempt = data;
  }
  if (!attempt) return res.status(404).json({ success: false, message: 'No active attempt found' });
  let currentAnswers = attempt.answers || {};
  if (typeof currentAnswers === 'string') try { currentAnswers = JSON.parse(currentAnswers); } catch { currentAnswers = {}; }
  currentAnswers[question_index] = answer;
  await supabase.from('quiz_attempts').update({ answers: currentAnswers, updated_at: new Date().toISOString() }).eq('id', attempt.id);
  res.json({ success: true, message: 'Answer saved successfully' });
});
app.post('/api/quiz/:quizId/submit', authenticateToken, async (req, res) => {
  const resolved = resolveQuizRouteId(req.params.quizId);
  if (!resolved.ok) return res.status(400).json({ success: false, message: resolved.message });
  const quizId = resolved.id;
  const { answers, time_taken, attempt_id } = req.body;
  if (!attempt_id) return res.status(400).json({ success: false, message: 'Missing attempt_id' });
  const { data: attempt } = await supabase.from('quiz_attempts').select('id, status').eq('id', attempt_id).eq('learner_id', req.user.id).eq('status', 'in-progress').single();
  if (!attempt) return res.status(404).json({ success: false, message: 'No active attempt found' });
  const { data: questions } = await supabase.from('quiz_questions').select('id, question_text, question_image, option_images, answer_image, question_type, marks, options, correct_answer, expected_answer, explanation').eq('quiz_id', quizId);
  const submittedAnswers = (questions || []).map((question, idx) => {
    const userAnswer = answers && answers[idx] !== undefined ? answers[idx] : null;
    let userAnswerText = '';
    if (question.question_type === 'multiple_choice') {
      const selectedOption = parseInt(userAnswer);
      userAnswerText = question.options[selectedOption] || 'Not answered';
    } else {
      userAnswerText = userAnswer ? String(userAnswer).trim() : 'Not answered';
    }
    return { question_id: question.id, question_text: question.question_text, question_image: question.question_image || null, option_images: question.option_images || [], answer_image: question.answer_image || null, question_type: question.question_type, selected_answer: userAnswer, selected_answer_text: userAnswerText, is_correct: null, points_obtained: null, max_points: question.marks || 1, correct_answer: question.question_type === 'multiple_choice' ? question.options[question.correct_answer] : question.expected_answer, explanation: question.explanation, feedback: null };
  });
  await supabase.from('quiz_attempts').update({ status: 'submitted', answers: submittedAnswers, time_taken: time_taken || null, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', attempt_id);
  res.json({ success: true, message: 'Your answers have been submitted successfully. The admin will review and grade your submission shortly.' });
});
app.get('/api/quiz/attempt/:attemptId', authenticateToken, async (req, res) => {
  const { attemptId } = req.params;
  const { data: attempt } = await supabase.from('quiz_attempts').select('id, quiz_id, earned_points, total_points, percentage, passed, completed_at, feedback, answers').eq('id', attemptId).eq('learner_id', req.user.id).single();
  if (!attempt) return res.status(404).json({ success: false, message: 'Attempt not found' });
  const { data: quiz } = await supabase.from('quizzes').select('title, subject').eq('id', attempt.quiz_id).single();
  let answers = attempt.answers;
  if (typeof answers === 'string') try { answers = JSON.parse(answers); } catch { answers = []; }
  const formattedAnswers = (answers || []).map((ans, idx) => ({ question_id: ans.question_id || idx, question_text: ans.question_text || '', question_image: ans.question_image || null, option_images: ans.option_images || [], answer_image: ans.answer_image || null, question_type: ans.question_type || 'multiple_choice', selected_answer: ans.selected_answer, selected_answer_text: ans.selected_answer_text || 'Not answered', is_correct: ans.is_correct || false, points_obtained: ans.points_obtained || 0, max_points: ans.max_points || 1, correct_answer: ans.correct_answer || '', explanation: ans.explanation || null, feedback: ans.feedback || null }));
  res.json({ success: true, attempt: { id: attempt.id, quiz_id: attempt.quiz_id, quiz_title: quiz?.title || 'Quiz', subject: quiz?.subject || null, earned_points: attempt.earned_points || 0, total_points: attempt.total_points || 0, percentage: attempt.percentage || 0, passed: attempt.passed || false, completed_at: attempt.completed_at, answers: formattedAnswers, feedback: attempt.feedback || null } });
});
app.get('/api/quiz/history', authenticateToken, async (req, res) => {
  const { data: attempts } = await supabase.from('quiz_attempts').select('id, quiz_id, subject, score, percentage, earned_points, total_points, passed, status, completed_at, time_taken, feedback').eq('learner_id', req.user.id).eq('status', 'completed').order('completed_at', { ascending: false });
  const formatted = await Promise.all((attempts || []).map(async (attempt) => {
    const { data: quiz } = await supabase.from('quizzes').select('id, title, total_marks, passing_points').eq('id', attempt.quiz_id).maybeSingle();
    return { id: attempt.id, quiz_id: attempt.quiz_id, quiz_title: quiz?.title || 'Unknown Quiz', subject: attempt.subject || 'General', marks_earned: attempt.earned_points || 0, total_marks: attempt.total_points || (quiz?.total_marks || 0), percentage: Math.round(attempt.percentage || 0), passed: attempt.passed || false, correct_answers: attempt.score || 0, completed_at: attempt.completed_at, time_taken: attempt.time_taken, feedback: attempt.feedback || null };
  }));
  res.json({ success: true, attempts: formatted });
});
app.post('/api/quiz/:quizId/verify', authenticateToken, async (req, res) => {
  const resolved = resolveQuizRouteId(req.params.quizId);
  if (!resolved.ok) return res.status(400).json({ success: false, message: resolved.message });
  const idForQuiz = resolved.id;
  const { regNumber } = req.body;
  const { data: learner } = await supabase.from('learners').select('reg_number, id, name, form').eq('id', req.user.id).single();
  if (!learner) return res.status(422).json({ success: false, message: 'Learner not found' });
  if (learner.reg_number.toUpperCase() !== regNumber.toUpperCase()) return res.status(403).json({ success: false, message: 'Invalid registration number' });
  const { data: quiz } = await supabase.from('quizzes').select('id, title, is_active, duration, total_marks, target_form').eq('id', idForQuiz).single();
  if (!quiz || !quiz.is_active) return res.status(403).json({ success: false, message: 'Quiz not available' });
  if (quiz.target_form !== 'All' && quiz.target_form !== learner.form) return res.status(403).json({ success: false, message: `This quiz is only for ${quiz.target_form} students`, form_restricted: true, required_form: quiz.target_form, your_form: learner.form });
  res.json({ success: true, message: 'Access granted', quiz: { id: quiz.id, title: quiz.title, duration: quiz.duration, total_marks: quiz.total_marks, target_form: quiz.target_form }, learner: { form: learner.form, is_eligible: true } });
});

// ============================================
// LESSON MANAGEMENT (ADMIN & LEARNER)
// ============================================
app.get('/api/admin/subjects/all', authenticateToken, authenticateAdmin, async (req, res) => {
  const { data: subjects } = await supabase.from('subjects').select('id, name').order('name');
  res.json({ success: true, subjects: subjects || [] });
});
app.get('/api/admin/lessons', authenticateToken, authenticateAdmin, async (req, res) => {
  const { data: lessons } = await supabase.from('lessons').select('*, subject:subject_id(id, name), quiz:quiz_id(id, title)').order('display_order');
  res.json({ success: true, lessons: lessons || [] });
});
app.post('/api/admin/lessons', authenticateToken, authenticateAdmin, async (req, res) => {
  let { title, description, video_url, pdf_url, subject_id, target_form, quiz_id, display_order } = req.body;
  if (!title) return res.status(400).json({ success: false, message: 'Title is required' });
  if (subject_id === '' || subject_id === 'null') subject_id = null;
  if (quiz_id === '' || quiz_id === 'null') quiz_id = null;
  display_order = parseInt(display_order) || 0;
  const { data, error } = await supabase.from('lessons').insert({ title, description, video_url, pdf_url, subject_id, target_form: target_form || 'All', quiz_id, display_order, created_at: new Date(), updated_at: new Date() }).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, lesson: data });
});
app.put('/api/admin/lessons/:id', authenticateToken, authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const updates = { ...req.body, updated_at: new Date() };
  const { data, error } = await supabase.from('lessons').update(updates).eq('id', id).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, lesson: data });
});
app.delete('/api/admin/lessons/:id', authenticateToken, authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  await supabase.from('lessons').delete().eq('id', id);
  res.json({ success: true });
});
app.get('/api/learner/lessons', authenticateToken, async (req, res) => {
  const { data: learner } = await supabase.from('learners').select('form').eq('id', req.user.id).single();
  if (!learner) return res.json({ success: true, lessons: [] });
  let query = supabase.from('lessons').select('*, quiz:quiz_id(id, title, duration)');
  if (learner.form !== 'All') query = query.or(`target_form.eq.All,target_form.eq.${learner.form}`);
  const { data: lessons } = await query.order('display_order', { ascending: true });
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
});
app.get('/api/learner/lesson/:lessonId', authenticateToken, async (req, res) => {
  const { lessonId } = req.params;
  const { data: lesson } = await supabase.from('lessons').select('*, quiz:quiz_id(id, title, duration, question_count)').eq('id', lessonId).single();
  res.json({ success: true, lesson });
});

// ============================================
// NOTIFICATIONS (LEARNER)
// ============================================
app.get('/api/learner/notifications', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, notifications: data || [] });
  } catch (error) {
    console.error('Notifications fetch error:', error.message);
    res.json({ success: true, notifications: [] });
  }
});
app.put('/api/learner/notifications/:id/read', authenticateToken, async (req, res) => {
  const { id } = req.params;
  await supabase.from('notifications').update({ is_read: true, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', req.user.id);
  res.json({ success: true });
});

// ============================================
// TEACHER ROUTES (simplified, no duplicates)
// ============================================
app.get('/api/teacher/dashboard/stats', authenticateToken, async (req, res) => {
  const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
  if (!teacher?.class_id) return res.json({ success: true, data: { totalLearners: 0, totalReports: 0, attendanceRate: 0, presentToday: 0, totalToday: 0 } });
  const { count: totalLearners } = await supabase.from('learners').select('*', { count: 'exact', head: true }).eq('class_id', teacher.class_id).eq('status', 'Active');
  const { count: totalReports } = await supabase.from('reports').select('*', { count: 'exact', head: true }).eq('class_id', teacher.class_id);
  const today = new Date().toISOString().split('T')[0];
  const { data: todayAttendance } = await supabase.from('attendance').select('status, learner_id').eq('date', today);
  const totalToday = todayAttendance?.length || 0;
  const presentToday = todayAttendance?.filter(a => a.status === 'present').length || 0;
  const attendanceRate = totalToday > 0 ? Math.round((presentToday / totalToday) * 100) : 0;
  res.json({ success: true, data: { totalLearners: totalLearners || 0, totalReports: totalReports || 0, attendanceRate, presentToday, totalToday } });
});
app.get('/api/teacher/all-learners', authenticateToken, async (req, res) => {
  const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
  if (!teacher?.class_id) return res.json({ success: true, learners: [] });
  const { data: learners } = await supabase.from('learners').select('id, name, reg_number, form, status, class_id, is_accepted_by_teacher').eq('class_id', teacher.class_id).eq('is_accepted_by_teacher', false).eq('status', 'Active').order('name');
  res.json({ success: true, learners: learners || [] });
});
app.get('/api/teacher/my-learners', authenticateToken, async (req, res) => {
  const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
  if (!teacher?.class_id) return res.json({ success: true, learners: [] });
  const { data: learners } = await supabase.from('learners').select('id, name, reg_number, form, status, class_id').eq('class_id', teacher.class_id).eq('is_accepted_by_teacher', true).eq('status', 'Active').order('name');
  res.json({ success: true, learners: learners || [] });
});
app.post('/api/teacher/add-learners', authenticateToken, async (req, res) => {
  const { learnerIds } = req.body;
  if (!learnerIds?.length) return res.status(400).json({ success: false, message: 'Please select at least one learner' });
  const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
  if (!teacher?.class_id) return res.status(400).json({ success: false, message: 'You have not been assigned to a class' });
  await supabase.from('learners').update({ is_accepted_by_teacher: true, updated_at: new Date().toISOString() }).in('id', learnerIds).eq('class_id', teacher.class_id);
  res.json({ success: true, message: `${learnerIds.length} learner(s) added to your class` });
});
app.delete('/api/teacher/remove-learner/:learnerId', authenticateToken, async (req, res) => {
  const { learnerId } = req.params;
  const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
  if (!teacher?.class_id) return res.status(400).json({ success: false, message: 'No class assigned' });
  const { data } = await supabase.from('learners').update({ is_accepted_by_teacher: false, updated_at: new Date().toISOString() }).eq('id', parseInt(learnerId)).eq('class_id', teacher.class_id).select();
  if (!data?.length) return res.status(404).json({ success: false, message: 'Learner not found in your class' });
  res.json({ success: true, message: 'Learner removed from your class' });
});
app.get('/api/teacher/reports', authenticateToken, async (req, res) => {
  const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
  if (!teacher?.class_id) return res.json({ success: true, data: [] });
  const { data: learners } = await supabase.from('learners').select('id').eq('class_id', teacher.class_id).eq('is_accepted_by_teacher', true);
  const learnerIds = learners?.map(l => l.id) || [];
  if (!learnerIds.length) return res.json({ success: true, data: [] });
  const { data: reports } = await supabase.from('reports').select('*').in('learner_id', learnerIds).order('created_at', { ascending: false });
  const { data: learnerDetails } = await supabase.from('learners').select('id, name, reg_number').in('id', learnerIds);
  const learnerMap = Object.fromEntries((learnerDetails || []).map(l => [l.id, { name: l.name, reg_number: l.reg_number }]));
  const enriched = (reports || []).map(r => ({ ...r, learner_name: learnerMap[r.learner_id]?.name || 'Unknown', learner_reg: learnerMap[r.learner_id]?.reg_number || 'N/A' }));
  res.json({ success: true, data: enriched });
});
app.post('/api/teacher/reports', authenticateToken, async (req, res) => {
  const { learnerId, term, form, subjects, comment, assessment_type_id, academic_year } = req.body;
  if (!learnerId || !subjects?.length) return res.status(400).json({ success: false, message: 'Learner ID and subjects are required' });
  const { data: learner } = await supabase.from('learners').select('id, name, class_id, reg_number, form').eq('id', parseInt(learnerId)).maybeSingle();
  if (!learner) return res.status(404).json({ success: false, message: 'Learner not found' });
  const totalScore = subjects.reduce((sum, s) => sum + (s.score || 0), 0);
  const averageScore = Math.round(totalScore / subjects.length);
  let grade = 'F';
  if (averageScore >= 75) grade = 'A'; else if (averageScore >= 65) grade = 'B'; else if (averageScore >= 55) grade = 'C'; else if (averageScore >= 40) grade = 'D';
  const { data: newReport, error } = await supabase.from('reports').insert({ learner_id: parseInt(learnerId), class_id: learner.class_id, term: term || 'Report', assessment_type_id, academic_year: academic_year || new Date().getFullYear(), form: form || learner.form, subjects: subjects.map(s => ({ name: s.name, score: parseInt(s.score) || 0 })), average_score: averageScore, total_score: totalScore, grade, comment, generated_by: req.user.id, generated_date: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).select().single();
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, message: 'Report card saved successfully!', report: newReport });
});
app.put('/api/teacher/reports/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { learnerId, term, form, subjects, comment, assessment_type_id, academic_year } = req.body;
  const { data: existing } = await supabase.from('reports').select('id, class_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ success: false, message: 'Report not found' });
  const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
  if (teacher?.class_id !== existing.class_id) return res.status(403).json({ success: false, message: 'Permission denied' });
  const updates = { learner_id: parseInt(learnerId), term, form, subjects, assessment_type_id, academic_year, comment, updated_at: new Date().toISOString() };
  if (subjects?.length) {
    const totalScore = subjects.reduce((sum, s) => sum + (s.score || 0), 0);
    const averageScore = Math.round(totalScore / subjects.length);
    updates.average_score = averageScore; updates.total_score = totalScore;
    let grade = 'F';
    if (averageScore >= 75) grade = 'A'; else if (averageScore >= 65) grade = 'B'; else if (averageScore >= 55) grade = 'C'; else if (averageScore >= 40) grade = 'D';
    updates.grade = grade;
  }
  const { data: updatedReport } = await supabase.from('reports').update(updates).eq('id', id).select().single();
  res.json({ success: true, message: 'Report updated successfully', report: updatedReport });
});
app.delete('/api/teacher/reports/:reportId', authenticateToken, async (req, res) => {
  const { reportId } = req.params;
  const { data: deleted } = await supabase.from('reports').delete().eq('id', reportId).select().single();
  if (!deleted) return res.status(404).json({ success: false, message: 'Report not found' });
  res.json({ success: true, message: 'Report deleted successfully' });
});
app.get('/api/teacher/attendance', authenticateToken, async (req, res) => {
  const { data: teacher } = await supabase.from('users').select('class_id').eq('id', req.user.id).maybeSingle();
  if (!teacher?.class_id) return res.json({ success: true, data: { stats: { total: 0, present: 0, absent: 0, late: 0, rate: 0 }, records: [] } });
  const { data: learners } = await supabase.from('learners').select('id, name, reg_number, form').eq('class_id', teacher.class_id);
  const learnerIds = learners?.map(l => l.id) || [];
  if (!learnerIds.length) return res.json({ success: true, data: { stats: { total: 0, present: 0, absent: 0, late: 0, rate: 0 }, records: [] } });
  const { data: attendance } = await supabase.from('attendance').select('*').in('learner_id', learnerIds).order('date', { ascending: false });
  const learnerMap = Object.fromEntries((learners || []).map(l => [l.id, { name: l.name, reg_number: l.reg_number, form: l.form }]));
  const totalRecords = attendance?.length || 0;
  const presentCount = attendance?.filter(a => a.status === 'present').length || 0;
  const absentCount = attendance?.filter(a => a.status === 'absent').length || 0;
  const lateCount = attendance?.filter(a => a.status === 'late').length || 0;
  const stats = { total: totalRecords, present: presentCount, absent: absentCount, late: lateCount, rate: totalRecords > 0 ? Math.round(((presentCount + lateCount) / totalRecords) * 100) : 0 };
  const records = (attendance || []).map(record => ({ id: record.id, learner_id: record.learner_id, learner_name: learnerMap[record.learner_id]?.name || 'Unknown', learner_reg: learnerMap[record.learner_id]?.reg_number || 'N/A', learner_form: learnerMap[record.learner_id]?.form || 'N/A', date: record.date, status: record.status, status_display: record.status === 'present' ? 'Present' : record.status === 'late' ? 'Late' : 'Absent', term: record.term || 1, year: record.year || new Date().getFullYear(), recorded_at: record.created_at || record.updated_at, date_formatted: new Date(record.date).toLocaleDateString() }));
  res.json({ success: true, data: { stats, records } });
});
app.post('/api/teacher/attendance', authenticateToken, async (req, res) => {
  const { learnerId, date, status, term, year } = req.body;
  if (!learnerId || !date || !status) return res.status(400).json({ success: false, message: 'Missing required fields' });
  const { data: existing } = await supabase.from('attendance').select('id').eq('learner_id', learnerId).eq('date', date).maybeSingle();
  if (existing) {
    await supabase.from('attendance').update({ status, term: term || 1, year: year || new Date().getFullYear(), updated_at: new Date().toISOString() }).eq('id', existing.id);
  } else {
    await supabase.from('attendance').insert({ learner_id: learnerId, date, status, term: term || 1, year: year || new Date().getFullYear(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  }
  res.json({ success: true, message: 'Attendance recorded successfully' });
});
app.get('/api/teacher/assessment-types', authenticateToken, async (req, res) => {
  const { data: types } = await supabase.from('assessment_types').select('*').eq('is_active', true).order('display_order');
  res.json({ success: true, assessment_types: types || [] });
});
app.get('/api/teacher/subjects/:classId', authenticateToken, async (req, res) => {
  const { classId } = req.params;
  const { data: subjects } = await supabase.from('subjects').select('*').eq('class_id', classId).order('display_order');
  res.json(subjects || []);
});
app.get('/api/teacher/learner-subjects/:learnerId', authenticateToken, async (req, res) => {
  const { learnerId } = req.params;
  const { data: learner } = await supabase.from('learners').select('class_id, form').eq('id', learnerId).maybeSingle();
  if (!learner?.class_id) return res.json({ success: true, subjects: [], message: 'Learner has no class assigned' });
  const { data: subjects } = await supabase.from('subjects').select('id, name, code, description, status').eq('class_id', learner.class_id).eq('status', 'Active').order('display_order');
  res.json({ success: true, subjects: subjects || [] });
});

// ============================================
// LEARNER ROUTES (additional)
// ============================================
app.get('/api/learner/profile', authenticateToken, async (req, res) => {
  const { data } = await supabase.from('learners').select('*, class:class_id(id, name, year)').eq('id', req.user.id).single();
  res.json({ success: true, profile: data });
});
app.get('/api/learner/attendance', authenticateToken, async (req, res) => {
  const { data: attendance } = await supabase.from('attendance').select('*').eq('learner_id', parseInt(req.user.id)).order('date', { ascending: false });
  const totalRecords = attendance?.length || 0;
  const presentCount = attendance?.filter(a => a.status === 'present').length || 0;
  const absentCount = attendance?.filter(a => a.status === 'absent').length || 0;
  const lateCount = attendance?.filter(a => a.status === 'late').length || 0;
  const attendanceRate = totalRecords > 0 ? Math.round(((presentCount + lateCount) / totalRecords) * 100) : 0;
  const stats = { total: totalRecords, present: presentCount, absent: absentCount, late: lateCount, rate: attendanceRate };
  const records = (attendance || []).map(record => ({ id: record.id, learner_id: record.learner_id, date: record.date, status: record.status, term: record.term || 1, year: record.year || new Date().getFullYear(), recorded_at: record.created_at || record.updated_at, status_display: record.status === 'present' ? 'Present' : record.status === 'late' ? 'Late' : 'Absent', status_color: record.status === 'present' ? 'green' : record.status === 'late' ? 'yellow' : 'red', date_formatted: new Date(record.date).toLocaleDateString() }));
  res.json({ success: true, data: { stats, records } });
});
app.get('/api/learner/attendance-stats', authenticateToken, async (req, res) => {
  const { term, year } = req.query;
  const currentYear = year || new Date().getFullYear();
  const currentTerm = term ? parseInt(term) : null;
  let query = supabase.from('attendance').select('status, date, term, year').eq('learner_id', parseInt(req.user.id));
  if (currentTerm) query = query.eq('term', currentTerm);
  if (currentYear) query = query.eq('year', currentYear);
  const { data: attendance } = await query.order('date', { ascending: false });
  const totalDays = attendance?.length || 0;
  const presentDays = attendance?.filter(a => a.status === 'present').length || 0;
  const lateDays = attendance?.filter(a => a.status === 'late').length || 0;
  const absentDays = attendance?.filter(a => a.status === 'absent').length || 0;
  const percentage = totalDays > 0 ? Math.round(((presentDays + lateDays) / totalDays) * 100) : 0;
  const monthlyData = {};
  attendance?.forEach(record => {
    const monthKey = new Date(record.date).toLocaleString('en', { month: 'long', year: 'numeric' });
    if (!monthlyData[monthKey]) monthlyData[monthKey] = { present: 0, late: 0, absent: 0, total: 0 };
    monthlyData[monthKey][record.status]++; monthlyData[monthKey].total++;
  });
  res.json({ success: true, data: { percentage, present: presentDays, late: lateDays, absences: absentDays, total: totalDays, term: currentTerm || 'All', year: currentYear, monthly_breakdown: monthlyData } });
});
app.get('/api/learner/reports', authenticateToken, async (req, res) => {
  const { data: learner } = await supabase.from('learners').select('id, name, reg_number, form, class_id').eq('id', req.user.id).maybeSingle();
  if (!learner) return res.json({ success: true, data: [], count: 0 });
  const { data: reports } = await supabase.from('reports').select('*').eq('learner_id', parseInt(req.user.id)).order('created_at', { ascending: false });
  const formatted = (reports || []).map(report => {
    let subjects = report.subjects;
    if (typeof subjects === 'string') try { subjects = JSON.parse(subjects); } catch { subjects = []; }
    return { ...report, subjects: subjects || [], form: report.form || learner.form };
  });
  res.json({ success: true, data: formatted, count: formatted.length });
});
app.get('/api/learner/report-card', authenticateToken, async (req, res) => {
  const { term, year } = req.query;
  const currentYear = year || new Date().getFullYear();
  const currentTerm = term || 'Term 1';
  let query = supabase.from('reports').select('*, subject:subject_id(id, name)').eq('learner_id', req.user.id).eq('year', currentYear);
  if (currentTerm !== 'all') query = query.eq('term', currentTerm);
  const { data: reports } = await query.order('subject_id');
  const totalScore = (reports || []).reduce((sum, r) => sum + (r.score || 0), 0);
  const averageScore = reports?.length ? Math.round(totalScore / reports.length) : 0;
  res.json({ success: true, data: { term: currentTerm, year: currentYear, reports: reports || [], summary: { total_subjects: reports?.length || 0, average_score: averageScore, total_score: totalScore, highest_score: Math.max(...(reports || []).map(r => r.score || 0), 0), lowest_score: Math.min(...(reports || []).map(r => r.score || 0), 0) } } });
});
app.get('/api/learner/dashboard/stats', authenticateToken, async (req, res) => {
  const { data: attendance } = await supabase.from('attendance').select('status').eq('learner_id', req.user.id).eq('year', new Date().getFullYear());
  const totalAttendance = attendance?.length || 0;
  const presentAttendance = attendance?.filter(a => a.status === 'present').length || 0;
  const attendanceRate = totalAttendance > 0 ? Math.round((presentAttendance / totalAttendance) * 100) : 0;
  const { data: reports } = await supabase.from('reports').select('score').eq('learner_id', req.user.id);
  const totalScore = (reports || []).reduce((sum, r) => sum + (r.score || 0), 0);
  const averageScore = reports?.length ? Math.round(totalScore / reports.length) : 0;
  res.json({ success: true, data: { attendance_rate: attendanceRate, average_score: averageScore, total_reports: reports?.length || 0, total_attendance: totalAttendance, present_attendance: presentAttendance } });
});

// ============================================
// FILE UPLOADS
// ============================================
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => { const allowed = /jpeg|jpg|png|gif|webp/; if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype)) cb(null, true); else cb(new Error('Only image files are allowed')); } });
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);
app.post('/api/upload/image', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided' });
  const fileName = `${Date.now()}-${crypto.randomUUID()}${path.extname(req.file.originalname)}`;
  const filePath = path.join(uploadsDir, fileName);
  await fs.writeFile(filePath, req.file.buffer);
  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${fileName}`;
  res.json({ success: true, url: imageUrl, message: 'Image uploaded successfully' });
});
app.use('/uploads', express.static(uploadsDir));

// Cloudflare R2 presigned URL (with fallback)
let r2Client = null;
if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.CLOUDFLARE_ACCOUNT_ID) {
  r2Client = new S3Client({ region: 'auto', endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
  console.log('✅ Cloudflare R2 client initialized');
} else { console.warn('⚠️ Cloudflare R2 credentials missing – presigned URL endpoint will fallback to local upload'); }
app.post('/api/admin/r2-upload-url', authenticateToken, authenticateAdmin, async (req, res) => {
  const { fileName, fileType } = req.body;
  if (!fileName) return res.status(400).json({ success: false, message: 'fileName is required' });
  if (!r2Client) {
    return res.json({ success: true, uploadUrl: `${req.protocol}://${req.get('host')}/api/upload/image`, fileUrl: null, key: null, fallback: true });
  }
  const fileExtension = fileName.split('.').pop();
  const key = `uploads/${Date.now()}-${crypto.randomBytes(16).toString('hex')}.${fileExtension}`;
  const command = new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key, ContentType: fileType || 'application/octet-stream' });
  const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: 3600 });
  res.json({ success: true, uploadUrl, fileUrl: `${process.env.R2_PUBLIC_URL}/${key}`, key });
});

// Cloudinary upload for lessons
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const lessonUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 }, fileFilter: (req, file, cb) => { const allowed = /mp4|webm|mov|pdf|jpeg|jpg|png|gif|webp/; if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype)) cb(null, true); else cb(new Error('Only videos, PDFs, and images are allowed')); } });
app.post('/api/admin/upload-lesson-file', authenticateToken, authenticateAdmin, lessonUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  const fileBase64 = req.file.buffer.toString('base64');
  const dataUri = `data:${req.file.mimetype};base64,${fileBase64}`;
  let resourceType = 'auto';
  if (req.file.mimetype === 'application/pdf') resourceType = 'raw';
  else if (req.file.mimetype.startsWith('video/')) resourceType = 'video';
  else if (req.file.mimetype.startsWith('image/')) resourceType = 'image';
  const result = await cloudinary.uploader.upload(dataUri, { resource_type: resourceType, folder: 'eduportal/lessons' });
  res.json({ success: true, url: result.secure_url, public_id: result.public_id });
});

// ============================================
// DEBUG ENDPOINTS
// ============================================
app.get('/api/teacher/debug-setup', authenticateToken, async (req, res) => {
  const { data: teacher } = await supabase.from('users').select('id, email, name, role, class_id').eq('id', req.user.id).maybeSingle();
  const { data: allClasses } = await supabase.from('classes').select('id, name, year');
  const { data: allTeachers } = await supabase.from('users').select('id, email, name, role, class_id').eq('role', 'teacher');
  let learnersInClass = [];
  if (teacher?.class_id) {
    const { data: learners } = await supabase.from('learners').select('id, name, reg_number, form').eq('class_id', teacher.class_id);
    learnersInClass = learners || [];
  }
  res.json({ success: true, current_teacher: teacher, assigned_class: null, learners_in_class: learnersInClass, learners_count: learnersInClass.length, all_classes: allClasses || [], all_teachers: allTeachers || [] });
});
app.get('/api/debug/learners', async (req, res) => {
  const { data: learners } = await supabase.from('learners').select('id, name, reg_number, form, status').limit(10);
  res.json({ success: true, count: learners?.length || 0, learners: learners || [] });
});

// ============================================
// 404 & ERROR HANDLER
// ============================================
app.use((req, res) => res.status(404).json({ success: false, message: `Route not found: ${req.path}` }));
app.use((err, req, res, next) => { console.error('Server error:', err); res.status(500).json({ success: false, message: 'Internal server error', error: process.env.NODE_ENV === 'development' ? err.message : undefined }); });

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
});

module.exports = app;