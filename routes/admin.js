const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

// Helper: Generate random password
const generateRandomPassword = () => {
    const length = 10;
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return password;
};

// Helper: Generate registration number
const generateRegNumber = async (supabase) => {
    const year = new Date().getFullYear();
    const { data, error } = await supabase
        .from('learners')
        .select('reg_number')
        .ilike('reg_number', `EDU-${year}-%`);
    
    const count = data?.length || 0;
    return `EDU-${year}-${String(count + 1).padStart(4, '0')}`;
};

// Middleware to check if user is admin
const isAdmin = async (req, res, next) => {
    try {
        const supabase = req.app.locals.supabase;
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }
        
        const decoded = JSON.parse(Buffer.from(token, 'base64').toString());
        
        const { data: user, error } = await supabase
            .from('users')
            .select('role')
            .eq('id', decoded.id)
            .single();
        
        if (error || !user || user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }
        
        req.user = decoded;
        next();
    } catch (error) {
        console.error('Admin middleware error:', error);
        res.status(500).json({ error: 'Authorization error' });
    }
};

// Apply auth and admin middleware
router.use(isAdmin);

// ============ TEACHER MANAGEMENT ============

// Get all teachers
router.get('/teachers', async (req, res) => {
    try {
        const supabase = req.app.locals.supabase;
        
        const { data, error } = await supabase
            .from('users')
            .select(`
                id, email, name, is_active, created_at,
                teachers:user_id (employee_id, department, qualification, specialization, joining_date, phone_number, address)
            `)
            .eq('role', 'teacher')
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        const teachers = data.map(user => ({
            id: user.id,
            email: user.email,
            full_name: user.name,
            is_active: user.is_active,
            created_at: user.created_at,
            ...(user.teachers || {})
        }));
        
        res.json(teachers);
    } catch (error) {
        console.error('Error fetching teachers:', error);
        res.status(500).json({ error: 'Failed to fetch teachers' });
    }
});

// Create teacher with credentials
router.post('/teachers', async (req, res) => {
    const {
        email,
        name,
        employee_id,
        department,
        qualification,
        specialization,
        joining_date,
        phone_number,
        address
    } = req.body;

    const supabase = req.app.locals.supabase;
    
    try {
        // Check if email exists
        const { data: existing } = await supabase
            .from('users')
            .select('id')
            .eq('email', email)
            .single();
        
        if (existing) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        // Generate random password
        const tempPassword = generateRandomPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 10);

        // Insert into users table
        const { data: user, error: userError } = await supabase
            .from('users')
            .insert([{
                email,
                password_hash: passwordHash,
                name,
                role: 'teacher',
                is_active: true
            }])
            .select()
            .single();
        
        if (userError) throw userError;

        // Insert into teachers table
        const { error: teacherError } = await supabase
            .from('teachers')
            .insert([{
                user_id: user.id,
                employee_id,
                department,
                qualification,
                specialization,
                joining_date,
                phone_number,
                address
            }]);
        
        if (teacherError) throw teacherError;

        res.status(201).json({
            success: true,
            message: 'Teacher created successfully',
            teacher: {
                id: user.id,
                email,
                name,
                employee_id
            },
            temporary_password: tempPassword
        });
    } catch (error) {
        console.error('Error creating teacher:', error);
        res.status(500).json({ error: 'Failed to create teacher' });
    }
});

// ============ LEARNER MANAGEMENT ============

// Get all learners
router.get('/learners', async (req, res) => {
    try {
        const supabase = req.app.locals.supabase;
        
        const { data, error } = await supabase
            .from('learners')
            .select(`
                id, name, reg_number, form, status, created_at,
                users:user_id (email, is_active)
            `)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        const learners = data.map(learner => ({
            id: learner.id,
            name: learner.name,
            email: learner.users?.email,
            reg_number: learner.reg_number,
            form: learner.form,
            status: learner.status,
            is_active: learner.users?.is_active,
            created_at: learner.created_at
        }));
        
        res.json(learners);
    } catch (error) {
        console.error('Error fetching learners:', error);
        res.status(500).json({ error: 'Failed to fetch learners' });
    }
});

// Create learner with credentials
router.post('/learners', async (req, res) => {
    const {
        email,
        name,
        student_id,
        enrollment_date,
        form,
        guardian_name,
        guardian_phone,
        address,
        date_of_birth
    } = req.body;

    const supabase = req.app.locals.supabase;
    
    try {
        // Check if email exists
        const { data: existing } = await supabase
            .from('users')
            .select('id')
            .eq('email', email)
            .single();
        
        if (existing) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        // Generate registration number
        const reg_number = await generateRegNumber(supabase);
        
        // Generate random password
        const tempPassword = generateRandomPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 10);

        // Insert into users table
        const { data: user, error: userError } = await supabase
            .from('users')
            .insert([{
                email,
                password_hash: passwordHash,
                name,
                role: 'learner',
                is_active: true
            }])
            .select()
            .single();
        
        if (userError) throw userError;

        // Insert into learners table
        const { error: learnerError } = await supabase
            .from('learners')
            .insert([{
                user_id: user.id,
                name,
                student_id,
                reg_number,
                enrollment_date,
                form,
                guardian_name,
                guardian_phone,
                address,
                date_of_birth,
                status: 'Active'
            }]);
        
        if (learnerError) throw learnerError;

        res.status(201).json({
            success: true,
            message: 'Learner created successfully',
            learner: {
                id: user.id,
                email,
                name,
                reg_number
            },
            temporary_password: tempPassword
        });
    } catch (error) {
        console.error('Error creating learner:', error);
        res.status(500).json({ error: 'Failed to create learner' });
    }
});

// ============ USER MANAGEMENT (Common) ============

// Reset user password
router.post('/users/:userId/reset-password', async (req, res) => {
    const { userId } = req.params;
    const supabase = req.app.locals.supabase;
    
    try {
        const newPassword = generateRandomPassword();
        const passwordHash = await bcrypt.hash(newPassword, 10);
        
        const { data, error } = await supabase
            .from('users')
            .update({ password_hash: passwordHash, updated_at: new Date().toISOString() })
            .eq('id', userId)
            .select('email, name, role')
            .single();
        
        if (error) throw error;
        
        res.json({
            success: true,
            message: 'Password reset successfully',
            temporary_password: newPassword,
            user: data
        });
    } catch (error) {
        console.error('Error resetting password:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// Update user status
router.patch('/users/:userId/status', async (req, res) => {
    const { userId } = req.params;
    const { is_active } = req.body;
    const supabase = req.app.locals.supabase;
    
    try {
        const { data, error } = await supabase
            .from('users')
            .update({ is_active, updated_at: new Date().toISOString() })
            .eq('id', userId)
            .select('email, name, role, is_active')
            .single();
        
        if (error) throw error;
        
        res.json({
            success: true,
            message: `User ${is_active ? 'activated' : 'deactivated'} successfully`,
            user: data
        });
    } catch (error) {
        console.error('Error updating user status:', error);
        res.status(500).json({ error: 'Failed to update user status' });
    }
});

// Delete user
router.delete('/users/:userId', async (req, res) => {
    const { userId } = req.params;
    const supabase = req.app.locals.supabase;
    
    try {
        // Check if user exists and is not admin
        const { data: user } = await supabase
            .from('users')
            .select('role')
            .eq('id', userId)
            .single();
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.role === 'admin') {
            return res.status(403).json({ error: 'Cannot delete admin user' });
        }
        
        const { error } = await supabase
            .from('users')
            .delete()
            .eq('id', userId);
        
        if (error) throw error;
        
        res.json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Get dashboard stats
router.get('/stats', async (req, res) => {
    try {
        const supabase = req.app.locals.supabase;
        
        const [teachersCount, learnersCount, activeUsersCount] = await Promise.all([
            supabase.from('users').select('id', { count: 'exact', head: true }).eq('role', 'teacher'),
            supabase.from('users').select('id', { count: 'exact', head: true }).eq('role', 'learner'),
            supabase.from('users').select('id', { count: 'exact', head: true }).eq('is_active', true)
        ]);
        
        res.json({
            totalTeachers: teachersCount.count || 0,
            totalLearners: learnersCount.count || 0,
            activeUsers: activeUsersCount.count || 0
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ... existing Teacher & Learner routes ...

// ============ QUIZ & QUESTION MANAGEMENT ============

// 1. POST: Add a new question to a quiz
router.post('/quizzes/:quizId/questions', async (req, res) => {
    const { quizId } = req.params;
    const supabase = req.app.locals.supabase;

    try {
        const { data, error } = await supabase
            .from('quiz_questions') // Double-check this table name in Supabase!
            .insert([{
                quiz_id: quizId,
                question_text: req.body.question_text,
                options: req.body.options,
                correct_option: req.body.correct_option,
                points: req.body.points || 1,
                explanation: req.body.explanation
            }])
            .select()
            .single();

        if (error) throw error;
        res.status(201).json({ success: true, data });
    } catch (err) {
        console.error('Insert Error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. GET: Fetch all questions for a quiz
router.get('/quizzes/:quizId/questions', async (req, res) => {
    const { quizId } = req.params;
    const supabase = req.app.locals.supabase;

    try {
        const { data, error } = await supabase
            .from('quiz_questions')
            .select('*')
            .eq('quiz_id', quizId)
            .order('created_at', { ascending: true });

        if (error) throw error;
        res.json({ success: true, questions: data || [] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. DELETE: Remove a question
router.delete('/questions/:questionId', async (req, res) => {
    const { questionId } = req.params;
    const supabase = req.app.locals.supabase;

    try {
        const { error } = await supabase
            .from('quiz_questions')
            .delete()
            .eq('id', questionId);

        if (error) throw error;
        res.json({ success: true, message: 'Question deleted' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;