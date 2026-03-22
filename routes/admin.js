const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');

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
const generateRegNumber = async () => {
    const year = new Date().getFullYear();
    const result = await db.query(
        "SELECT COUNT(*) FROM learners WHERE reg_number LIKE $1",
        [`EDU-${year}-%`]
    );
    const count = parseInt(result.rows[0].count) + 1;
    return `EDU-${year}-${String(count).padStart(4, '0')}`;
};

// Middleware to check if user is admin
const isAdmin = async (req, res, next) => {
    try {
        const result = await db.query(
            'SELECT role FROM users WHERE id = $1',
            [req.user.userId]
        );
        
        if (result.rows[0]?.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied. Admin only.' });
        }
        next();
    } catch (error) {
        res.status(500).json({ error: 'Authorization error' });
    }
};

// Apply auth and admin middleware
router.use(authMiddleware);
router.use(isAdmin);

// ============ TEACHER MANAGEMENT ============

// Get all teachers
router.get('/teachers', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.email, u.full_name, u.is_active, u.created_at,
                   t.employee_id, t.department, t.qualification, t.specialization,
                   t.joining_date, t.phone_number, t.address
            FROM users u
            LEFT JOIN teachers t ON u.id = t.user_id
            WHERE u.role = 'teacher'
            ORDER BY u.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching teachers:', error);
        res.status(500).json({ error: 'Failed to fetch teachers' });
    }
});

// Create teacher with credentials
router.post('/teachers', async (req, res) => {
    const {
        email,
        full_name,
        employee_id,
        department,
        qualification,
        specialization,
        joining_date,
        phone_number,
        address
    } = req.body;

    const client = await db.connect();
    
    try {
        await client.query('BEGIN');

        // Check if email exists
        const emailCheck = await client.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );
        if (emailCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        // Generate random password
        const tempPassword = generateRandomPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 10);

        // Insert into users table
        const userResult = await client.query(`
            INSERT INTO users (email, password_hash, full_name, role, is_active)
            VALUES ($1, $2, $3, 'teacher', true)
            RETURNING id, email, full_name
        `, [email, passwordHash, full_name]);

        const userId = userResult.rows[0].id;

        // Insert into teachers table
        await client.query(`
            INSERT INTO teachers (user_id, employee_id, department, qualification, 
                                 specialization, joining_date, phone_number, address)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [userId, employee_id, department, qualification, 
            specialization, joining_date, phone_number, address]);

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'Teacher created successfully',
            teacher: {
                id: userId,
                email,
                full_name,
                employee_id
            },
            temporary_password: tempPassword
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating teacher:', error);
        res.status(500).json({ error: 'Failed to create teacher' });
    } finally {
        client.release();
    }
});

// ============ LEARNER MANAGEMENT ============

// Get all learners
router.get('/learners', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.email, u.full_name, u.is_active, u.created_at,
                   l.student_id, l.reg_number, l.enrollment_date, l.form,
                   l.guardian_name, l.guardian_phone, l.address, l.date_of_birth
            FROM users u
            LEFT JOIN learners l ON u.id = l.user_id
            WHERE u.role = 'learner'
            ORDER BY u.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching learners:', error);
        res.status(500).json({ error: 'Failed to fetch learners' });
    }
});

// Create learner with credentials
router.post('/learners', async (req, res) => {
    const {
        email,
        full_name,
        student_id,
        enrollment_date,
        form,
        guardian_name,
        guardian_phone,
        address,
        date_of_birth
    } = req.body;

    const client = await db.connect();
    
    try {
        await client.query('BEGIN');

        // Check if email exists
        const emailCheck = await client.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );
        if (emailCheck.rows.length > 0) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        // Generate registration number
        const reg_number = await generateRegNumber();
        
        // Generate random password
        const tempPassword = generateRandomPassword();
        const passwordHash = await bcrypt.hash(tempPassword, 10);

        // Insert into users table
        const userResult = await client.query(`
            INSERT INTO users (email, password_hash, full_name, role, is_active)
            VALUES ($1, $2, $3, 'learner', true)
            RETURNING id, email, full_name
        `, [email, passwordHash, full_name]);

        const userId = userResult.rows[0].id;

        // Insert into learners table
        await client.query(`
            INSERT INTO learners (user_id, student_id, reg_number, enrollment_date, form,
                                 guardian_name, guardian_phone, address, date_of_birth)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [userId, student_id, reg_number, enrollment_date, form,
            guardian_name, guardian_phone, address, date_of_birth]);

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'Learner created successfully',
            learner: {
                id: userId,
                email,
                full_name,
                reg_number
            },
            temporary_password: tempPassword
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating learner:', error);
        res.status(500).json({ error: 'Failed to create learner' });
    } finally {
        client.release();
    }
});

// ============ USER MANAGEMENT (Common) ============

// Reset user password
router.post('/users/:userId/reset-password', async (req, res) => {
    const { userId } = req.params;
    
    try {
        const newPassword = generateRandomPassword();
        const passwordHash = await bcrypt.hash(newPassword, 10);
        
        const result = await db.query(`
            UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING email, full_name, role
        `, [passwordHash, userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            success: true,
            message: 'Password reset successfully',
            temporary_password: newPassword,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Error resetting password:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// Update user status (activate/deactivate)
router.patch('/users/:userId/status', async (req, res) => {
    const { userId } = req.params;
    const { is_active } = req.body;
    
    try {
        const result = await db.query(`
            UPDATE users SET is_active = $1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
            RETURNING email, full_name, role, is_active
        `, [is_active, userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            success: true,
            message: `User ${is_active ? 'activated' : 'deactivated'} successfully`,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating user status:', error);
        res.status(500).json({ error: 'Failed to update user status' });
    }
});

// Delete user
router.delete('/users/:userId', async (req, res) => {
    const { userId } = req.params;
    
    try {
        // Check if user exists and is not admin
        const userCheck = await db.query(
            'SELECT role FROM users WHERE id = $1',
            [userId]
        );
        
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (userCheck.rows[0].role === 'admin') {
            return res.status(403).json({ error: 'Cannot delete admin user' });
        }
        
        await db.query('DELETE FROM users WHERE id = $1', [userId]);
        
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
        const [teachersCount, learnersCount, activeUsersCount] = await Promise.all([
            db.query("SELECT COUNT(*) FROM users WHERE role = 'teacher'"),
            db.query("SELECT COUNT(*) FROM users WHERE role = 'learner'"),
            db.query("SELECT COUNT(*) FROM users WHERE is_active = true")
        ]);
        
        res.json({
            totalTeachers: parseInt(teachersCount.rows[0].count),
            totalLearners: parseInt(learnersCount.rows[0].count),
            activeUsers: parseInt(activeUsersCount.rows[0].count)
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

module.exports = router;