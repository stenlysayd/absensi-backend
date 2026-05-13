// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const { login, requestPasswordReset, confirmPasswordReset, register } = require('../controllers/authController');

router.post('/forgot-password', requestPasswordReset); // Dipanggil dari app Flutter
router.get('/confirm-reset', confirmPasswordReset); // Diklik dari Email (Browser)

// Endpoint: POST /api/auth/login
router.post('/login', login);
router.post('/register', register);

module.exports = router;