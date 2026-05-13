// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const {
  getUsers,
  getDashboardStats,
  getWeeklyStats,
  getDailyAttendance,
  getAttendanceReportRange,
  exportAttendanceExcel,
  updateSchoolConfig,
  resetDeviceBinding,
  adminResetPassword,
} = require('../controllers/adminController');
const { verifyToken, verifyAdmin } = require('../middlewares/authMiddleware');

// Semua rute di bawah ini wajib pakai Token JWT dan wajib ber-role 'admin'
router.use(verifyToken, verifyAdmin);

router.get('/users', getUsers);
router.get('/stats', getDashboardStats);
router.get('/stats/weekly', getWeeklyStats);
router.get('/attendance', getDailyAttendance);
router.get('/attendance-report', getAttendanceReportRange);
router.get('/export/excel', exportAttendanceExcel);

router.put('/config', updateSchoolConfig);
router.post('/reset-device', resetDeviceBinding);
router.post('/force-reset-password', adminResetPassword);

module.exports = router;