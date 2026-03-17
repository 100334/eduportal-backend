const jwt = require('jsonwebtoken');

/**
 * Main authentication middleware
 * Verifies JWT token and attaches user info to request
 */
const auth = (req, res, next) => {
  try {
    // Get token from Authorization header or cookie
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    
    if (!token) {
      return res.status(401).json({ 
        success: false,
        message: 'Authentication required. Please log in.' 
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Attach user info to request
    req.user = decoded;
    
    // Optional: Add user role to response locals for views
    res.locals.userRole = decoded.role;
    
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false,
        message: 'Session expired. Please log in again.' 
      });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false,
        message: 'Invalid token. Please log in again.' 
      });
    }
    
    console.error('Auth middleware error:', error);
    res.status(401).json({ 
      success: false,
      message: 'Authentication failed' 
    });
  }
};

/**
 * Role-based middleware - Admin only
 */
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false,
      message: 'Authentication required' 
    });
  }
  
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false,
      message: 'Admin access required. You do not have permission to access this resource.' 
    });
  }
  next();
};

/**
 * Role-based middleware - Teacher only
 */
const requireTeacher = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false,
      message: 'Authentication required' 
    });
  }
  
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ 
      success: false,
      message: 'Teacher access required. You do not have permission to access this resource.' 
    });
  }
  next();
};

/**
 * Role-based middleware - Learner only
 */
const requireLearner = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false,
      message: 'Authentication required' 
    });
  }
  
  if (req.user.role !== 'learner') {
    return res.status(403).json({ 
      success: false,
      message: 'Learner access required. You do not have permission to access this resource.' 
    });
  }
  next();
};

/**
 * Role-based middleware - Allow multiple roles
 * @param {Array} allowedRoles - Array of allowed roles (e.g., ['admin', 'teacher'])
 */
const requireAnyRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: 'Authentication required' 
      });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false,
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}` 
      });
    }
    next();
  };
};

/**
 * Optional authentication - doesn't require token, but attaches user if present
 */
const optionalAuth = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.token;
    
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      res.locals.userRole = decoded.role;
    }
    
    next();
  } catch (error) {
    // Token invalid but we don't block the request
    next();
  }
};

/**
 * Get user from token helper (for websockets or other contexts)
 */
const getUserFromToken = (token) => {
  try {
    if (!token) return null;
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
};

module.exports = auth;
module.exports.requireAdmin = requireAdmin;
module.exports.requireTeacher = requireTeacher;
module.exports.requireLearner = requireLearner;
module.exports.requireAnyRole = requireAnyRole;
module.exports.optionalAuth = optionalAuth;
module.exports.getUserFromToken = getUserFromToken;