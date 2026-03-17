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
        .maybeSingle(); // Use maybeSingle instead of single to avoid error when not found

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
// LEARNER LOGIN - FIXED VERSION
// ============================================
exports.learnerLogin = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, regNumber } = req.body;
    const supabase = req.app.locals.supabase;

    console.log('🔍 Searching for learner:', { name, regNumber });

    // First, let's check if the learners table exists and has data
    const { data: allLearners, error: countError } = await supabase
      .from('learners')
      .select('count', { count: 'exact', head: true });

    if (countError) {
      console.error('❌ Error accessing learners table:', countError);
      return res.status(500).json({
        success: false,
        message: 'Database error. Please contact support.'
      });
    }

    // Try different matching strategies
    let learner = null;
    let error = null;

    // Strategy 1: Exact match with case-insensitive name
    const { data: learnerData, error: learnerError } = await supabase
      .from('learners')
      .select(`
        *,
        learner_class_enrollments!left(
          class:classes!inner(
            id,
            name,
            form_level,
            stream
          )
        )
      `)
      .ilike('name', name.trim())
      .eq('reg_number', regNumber.trim())
      .maybeSingle(); // Use maybeSingle to avoid "multiple rows returned" error

    if (learnerError) {
      console.error('❌ Query error:', learnerError);
      error = learnerError;
    } else {
      learner = learnerData;
    }

    // Strategy 2: If not found, try with different field names
    if (!learner) {
      console.log('⚠️ Not found with exact match, trying alternative fields...');
      
      const { data: altLearner } = await supabase
        .from('learners')
        .select(`
          *,
          learner_class_enrollments!left(
            class:classes!inner(
              id,
              name,
              form_level,
              stream
            )
          )
        `)
        .or(`name.ilike.%${name}%,full_name.ilike.%${name}%,student_name.ilike.%${name}%`)
        .or(`reg_number.eq.${regNumber},registration_number.eq.${regNumber},student_id.eq.${regNumber}`)
        .maybeSingle();

      if (altLearner) {
        learner = altLearner;
        console.log('✅ Found with alternative matching');
      }
    }

    if (!learner) {
      console.log('❌ Learner not found in database');
      
      // For debugging: Check what learners exist (remove in production)
      const { data: existingLearners } = await supabase
        .from('learners')
        .select('name, reg_number')
        .limit(5);
      
      console.log('📋 Sample existing learners:', existingLearners);

      return res.status(401).json({ 
        success: false,
        message: 'Invalid name or registration number',
        debug: process.env.NODE_ENV !== 'production' ? { 
          note: 'Check console for existing learners',
          sample: existingLearners 
        } : undefined
      });
    }

    // Check if learner is active
    if (learner.status && learner.status !== 'Active' && learner.status !== 'active') {
      return res.status(403).json({ 
        success: false,
        message: 'Your account is not active. Please contact the school.' 
      });
    }

    console.log('✅ Learner found:', learner.name);

    const token = jwt.sign(
      { 
        id: learner.id, 
        role: 'learner',
        regNumber: learner.reg_number || learner.regNumber,
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
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    // Get current class info
    const currentClass = learner.learner_class_enrollments?.[0]?.class || null;

    // Create user object with consistent field names
    const userObject = {
      id: learner.id,
      name: learner.name,
      regNumber: learner.reg_number || learner.regNumber,
      reg_number: learner.reg_number || learner.regNumber, // Include both for compatibility
      grade: learner.grade || learner.class_level,
      email: learner.email,
      role: 'learner',
      currentClass: currentClass
    };

    // Add optional fields if they exist
    if (learner.first_name) userObject.first_name = learner.first_name;
    if (learner.last_name) userObject.last_name = learner.last_name;
    if (learner.gender) userObject.gender = learner.gender;
    if (learner.age) userObject.age = learner.age;
    if (learner.enrollment_date) userObject.enrollment_date = learner.enrollment_date;

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
        .maybeSingle(); // Use maybeSingle

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
          // Continue with mock admin if DB fails
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
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
      });

      // Update last login
      if (admin.id) {
        await supabase
          .from('admins')
          .update({ last_login: new Date().toISOString() })
          .eq('id', admin.id);

        // Log admin login
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
        // Fallback to decoded token data
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
          regNumber: learner.reg_number || learner.regNumber,
          reg_number: learner.reg_number || learner.regNumber,
          grade: learner.grade,
          email: learner.email,
          role: 'learner',
          currentClass: currentClass
        };
        
        // Add optional fields
        if (learner.first_name) userData.first_name = learner.first_name;
        if (learner.last_name) userData.last_name = learner.last_name;
        if (learner.gender) userData.gender = learner.gender;
        if (learner.age) userData.age = learner.age;
      }
    }

    if (!userData) {
      // Return data from token as fallback
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
    
    // Generate new token with same data
    const newToken = jwt.sign(
      { 
        id: decoded.id, 
        role: decoded.role,
        ...(decoded.role === 'learner' && { regNumber: decoded.regNumber }),
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
    const token = req.cookies?.token;
    
    if (token) {
      // You could blacklist the token here if needed
      // For now, just clear the cookie
    }
    
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