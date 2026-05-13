// routes/guruRoutes.js
const express = require('express');
const router = express.Router();
const { getDashboard, getSchoolConfig } = require('../controllers/guruController');
const { verifyToken } = require('../middlewares/authMiddleware');

// Endpoint: GET /api/dashboard
router.get('/dashboard', verifyToken, getDashboard);

// Endpoint: GET /api/school-config
router.get('/school-config', verifyToken, getSchoolConfig);

module.exports = router;