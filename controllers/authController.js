const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');

// ============================================
// TEACHER LOGIN
// ============================================
exports.teacherLogin = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, password } = req.body;
    const supabase = req.app.locals.supabase;

    // In production, check against teachers table
    // For demo, we'll use the mock check
    if (username === 'admin' && password === 'password123') {
      
      // Try to find teacher in database
      const { data: teacher, error: teacherError } = await supabase
        .from('teachers')
        .select('*')
        .ilike('email', `${username}@eduportal.com`)
        .maybeSingle();

      const token = jwt.sign(
        { 
          id: teacher?.id || 1, 
          role: 'teacher', 
          username,
          teacher_id: teacher?.id || 1
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '7d' }
      );

      // Set cookie for web clients
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
      });

      // Log teacher login
      if (teacher?.id) {
        await supabase
          .from('system_logs')
          .insert([{
            admin_id: null,
            action: 'LOGIN',
            entity_type: 'teacher',
            entity_id: teacher.id,
            details: { username, timestamp: new Date().toISOString() }
          }]);
      }

      return res.json({
        success: true,
        token,
        user: { 
          id: teacher?.id || 1, 
          username, 
          role: 'teacher',
          name: teacher?.name || 'Admin Teacher',
          email: teacher?.email || `${username}@eduportal.com`
        }
      });
    }

    return res.status(401).json({ 
      success: false,
      message: 'Invalid credentials' 
    });
  } catch (error) {
    next(error);
  }
};

// ============================================
// LEARNER LOGIN - UPDATED WITH BETTER DEBUGGING
// ============================================
exports.learnerLogin = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Accept both field name formats
    const { name, regNumber, reg_number } = req.body;
    const registrationNumber = regNumber || reg_number;
    
    const supabase = req.app.locals.supabase;

    console.log('=' .repeat(50));
    console.log('🔍 LEARNER LOGIN ATTEMPT');
    console.log('Request body:', req.body);
    console.log('Normalized - Name:', name);
    console.log('Normalized - Reg Number:', registrationNumber);
    console.log('=' .repeat(50));

    if (!name || !registrationNumber) {
      return res.status(400).json({ 
        success: false, 
        message: 'Name and registration number are required' 
      });
    }

    // First, let's check what columns exist in the learners table
    const { data: columns, error: columnError } = await supabase
      .from('learners')
      .select('*')
      .limit(1);

    if (columnError) {
      console.error('❌ Error accessing learners table:', columnError);
    } else if (columns && columns.length > 0) {
      console.log('📋 Available columns:', Object.keys(columns[0]));
    }

    // Check total count of learners
    const { count, error: countError } = await supabase
      .from('learners')
      .select('*', { count: 'exact', head: true });

    console.log(`📊 Total learners in database: ${count || 0}`);

    if (count === 0) {
      return res.status(401).json({ 
        success: false,
        message: 'No learners found in database. Please contact administrator.',
        debug: { note: 'Database is empty' }
      });
    }

    // Get all learners for debugging (limit to 10)
    const { data: allLearners, error: allError } = await supabase
      .from('learners')
      .select('id, name, reg_number, grade, status')
      .limit(10);

    if (allLearners) {
      console.log('📋 All learners in DB (first 10):');
      allLearners.forEach(l => {
        console.log(`   ID:${l.id} | Name:${l.name} | Reg:${l.reg_number} | Status:${l.status}`);
      });
    }

    // Try multiple matching strategies
    let learner = null;
    let matchStrategy = 'none';

    // Strategy 1: Exact match with provided fields
    const { data: exactMatch, error: exactError } = await supabase
      .from('learners')
      .select(`
        *,
        learner_class_enrollments(
          class:classes(
            id,
            name,
            form_level,
            stream
          )
        )
      `)
      .ilike('name', name.trim())
      .eq('reg_number', registrationNumber.trim())
      .maybeSingle();

    if (exactMatch) {
      learner = exactMatch;
      matchStrategy = 'exact';
      console.log('✅ Found with exact match');
    }

    // Strategy 2: Case-insensitive name + reg_number
    if (!learner) {
      const { data: caseInsensitive } = await supabase
        .from('learners')
        .select(`
          *,
          learner_class_enrollments(
            class:classes(
              id,
              name,
              form_level,
              stream
            )
          )
        `)
        .ilike('name', `%${name.trim()}%`)
        .ilike('reg_number', `%${registrationNumber.trim()}%`)
        .maybeSingle();

      if (caseInsensitive) {
        learner = caseInsensitive;
        matchStrategy = 'case_insensitive';
        console.log('✅ Found with case-insensitive match');
      }
    }

    // Strategy 3: Try different field combinations
    if (!learner) {
      // Try to find by name only first
      const { data: nameMatch } = await supabase
        .from('learners')
        .select('reg_number')
        .ilike('name', name.trim())
        .maybeSingle();

      if (nameMatch) {
        console.log(`ℹ️ Found name match but reg_number mismatch. DB has: ${nameMatch.reg_number}`);
      }

      // Try to find by reg_number only
      const { data: regMatch } = await supabase
        .from('learners')
        .select('name')
        .eq('reg_number', registrationNumber.trim())
        .maybeSingle();

      if (regMatch) {
        console.log(`ℹ️ Found reg_number match but name mismatch. DB has: ${regMatch.name}`);
      }
    }

    if (!learner) {
      console.log('❌ No matching learner found');
      
      return res.status(401).json({ 
        success: false,
        message: 'Invalid name or registration number',
        debug: {
          attemptedName: name,
          attemptedRegNumber: registrationNumber,
          availableLearners: allLearners?.map(l => ({
            name: l.name,
            reg_number: l.reg_number
          }))
        }
      });
    }

    // Check if learner is active
    if (learner.status && learner.status !== 'Active' && learner.status !== 'active') {
      console.log('❌ Learner account not active:', learner.status);
      return res.status(403).json({ 
        success: false,
        message: 'Your account is not active. Please contact the school.' 
      });
    }

    console.log('✅ Login successful for:', learner.name);
    console.log('Match strategy:', matchStrategy);

    const token = jwt.sign(
      { 
        id: learner.id, 
        role: 'learner',
        regNumber: learner.reg_number,
        reg_number: learner.reg_number,
        name: learner.name,
        learner_id: learner.id
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    // Set cookie for web clients
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    // Get current class info
    const currentClass = learner.learner_class_enrollments?.[0]?.class || null;

    // Create user object with consistent field names
    const userObject = {
      id: learner.id,
      name: learner.name,
      regNumber: learner.reg_number,
      reg_number: learner.reg_number,
      grade: learner.grade,
      email: learner.email,
      role: 'learner',
      status: learner.status,
      currentClass: currentClass
    };

    // Add optional fields if they exist
    if (learner.first_name) userObject.first_name = learner.first_name;
    if (learner.last_name) userObject.last_name = learner.last_name;
    if (learner.gender) userObject.gender = learner.gender;
    if (learner.age) userObject.age = learner.age;
    if (learner.enrollment_date) userObject.enrollment_date = learner.enrollment_date;

    // Log successful login
    console.log('✅ Login response prepared for:', userObject.name);
    console.log('=' .repeat(50));

    res.json({
      success: true,
      token,
      user: userObject
    });

  } catch (error) {
    console.error('❌ Learner login error:', error);
    next(error);
  }
};

// ============================================
// ADMIN LOGIN
// ============================================
exports.adminLogin = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;
    const supabase = req.app.locals.supabase;

    // Demo credentials check
    if (email === 'admin@eduportal.com' && password === 'admin123') {
      
      // Check if admin exists in database
      let { data: admin, error } = await supabase
        .from('admins')
        .select('*')
        .eq('email', email)
        .maybeSingle();

      // If admin doesn't exist, create default admin
      if (!admin) {
        const { data: newAdmin, error: createError } = await supabase
          .from('admins')
          .insert([{
            name: 'System Administrator',
            email: email,
            role: 'super_admin',
            permissions: {
              manage_teachers: true,
              manage_learners: true,
              manage_classes: true,
              manage_subjects: true,
              manage_settings: true,
              view_reports: true,
              system_config: true
            }
          }])
          .select()
          .single();

        if (createError) {
          console.error('Error creating admin:', createError);
          admin = {
            id: 1,
            name: 'System Administrator',
            email: email,
            role: 'super_admin',
            permissions: {
              manage_teachers: true,
              manage_learners: true,
              manage_classes: true,
              manage_subjects: true,
              manage_settings: true,
              view_reports: true,
              system_config: true
            }
          };
        } else {
          admin = newAdmin;
        }
      }

      const token = jwt.sign(
        { 
          id: admin.id, 
          role: 'admin', 
          email: admin.email,
          name: admin.name,
          admin_id: admin.id
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '7d' }
      );

      // Set cookie for web clients
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });

      // Update last login
      if (admin.id) {
        await supabase
          .from('admins')
          .update({ last_login: new Date().toISOString() })
          .eq('id', admin.id);

        await supabase
          .from('system_logs')
          .insert([{
            admin_id: admin.id,
            action: 'LOGIN',
            entity_type: 'admin',
            entity_id: admin.id,
            details: { email, timestamp: new Date().toISOString() }
          }]);
      }

      res.json({
        success: true,
        token,
        user: { 
          id: admin.id, 
          email: admin.email,
          name: admin.name,
          role: 'admin',
          permissions: admin.permissions
        }
      });
    } else {
      return res.status(401).json({ 
        success: false,
        message: 'Invalid admin credentials' 
      });
    }
  } catch (error) {
    next(error);
  }
};

// ============================================
// GET CURRENT USER
// ============================================
exports.getCurrentUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const supabase = req.app.locals.supabase;
    
    let userData = null;
    
    if (decoded.role === 'admin') {
      const { data: admin } = await supabase
        .from('admins')
        .select('*')
        .eq('id', decoded.id)
        .maybeSingle();
      
      if (admin) {
        userData = {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          role: 'admin',
          permissions: admin.permissions
        };
      } else {
        userData = {
          id: decoded.id,
          email: decoded.email,
          name: decoded.name || 'Administrator',
          role: 'admin',
          permissions: {
            manage_teachers: true,
            manage_learners: true,
            manage_classes: true,
            manage_subjects: true,
            manage_settings: true
          }
        };
      }
    } 
    else if (decoded.role === 'teacher') {
      const { data: teacher } = await supabase
        .from('teachers')
        .select('*')
        .eq('id', decoded.id)
        .maybeSingle();
      
      if (teacher) {
        userData = {
          id: teacher.id,
          email: teacher.email,
          name: teacher.name,
          role: 'teacher',
          specialization: teacher.specialization,
          phone: teacher.phone,
          status: teacher.status
        };
      }
    } 
    else if (decoded.role === 'learner') {
      const { data: learner } = await supabase
        .from('learners')
        .select(`
          *,
          learner_class_enrollments(
            class:classes(
              id,
              name,
              form_level,
              stream
            )
          )
        `)
        .eq('id', decoded.id)
        .maybeSingle();
      
      if (learner) {
        const currentClass = learner.learner_class_enrollments?.[0]?.class || null;
        
        userData = {
          id: learner.id,
          name: learner.name,
          regNumber: learner.reg_number,
          reg_number: learner.reg_number,
          grade: learner.grade,
          email: learner.email,
          role: 'learner',
          status: learner.status,
          currentClass: currentClass
        };
        
        if (learner.first_name) userData.first_name = learner.first_name;
        if (learner.last_name) userData.last_name = learner.last_name;
        if (learner.gender) userData.gender = learner.gender;
        if (learner.age) userData.age = learner.age;
      }
    }

    if (!userData) {
      userData = {
        id: decoded.id,
        role: decoded.role,
        name: decoded.name || decoded.username || 'User',
        ...(decoded.regNumber && { regNumber: decoded.regNumber, reg_number: decoded.regNumber })
      };
    }

    res.json({
      success: true,
      user: userData
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token' });
    }
    next(error);
  }
};

// ============================================
// REFRESH TOKEN
// ============================================
exports.refreshToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const newToken = jwt.sign(
      { 
        id: decoded.id, 
        role: decoded.role,
        ...(decoded.role === 'learner' && { 
          regNumber: decoded.regNumber,
          reg_number: decoded.regNumber 
        }),
        ...(decoded.role === 'teacher' && { username: decoded.username }),
        ...(decoded.role === 'admin' && { email: decoded.email, name: decoded.name })
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    res.json({ 
      success: true,
      token: newToken 
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }
    next(error);
  }
};

// ============================================
// LOGOUT
// ============================================
exports.logout = async (req, res) => {
  try {
    res.clearCookie('token');
    res.json({ 
      success: true,
      message: 'Logged out successfully' 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      message: 'Error during logout' 
    });
  }
};