// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const {
  getUsers,
  updateUserRole,
  getDashboardStats,
  getWeeklyStats,
  getDailyAttendance,
  getAttendanceReportRange,
  exportAttendanceExcel,
  updateSchoolConfig,
  resetDeviceBinding,
  adminResetPassword,
  getDriveStatus,
  getDriveFiles,
  getAttendanceScheduleAdmin,
  updateAttendanceSchedule,
  transferAdmin,
} = require('../controllers/adminController');
const { verifyToken, verifyAdmin } = require('../middlewares/authMiddleware');
const {
  getCalendarOverview,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  confirmCalendarReview,
  correctDailyAttendance,
  finalizeDateManually,
} = require('../controllers/calendarController');

// Semua rute di bawah ini wajib pakai Token JWT dan wajib ber-role 'admin'
router.use(verifyToken, verifyAdmin);

router.get('/users', getUsers);
router.patch('/users/:id/role', updateUserRole);
router.get('/stats', getDashboardStats);
router.get('/stats/weekly', getWeeklyStats);
router.get('/attendance', getDailyAttendance);
router.get('/attendance-report', getAttendanceReportRange);
router.get('/export/excel', exportAttendanceExcel);
router.get('/drive/status', getDriveStatus);
router.get('/drive/files', getDriveFiles);
router.get('/attendance-schedule', getAttendanceScheduleAdmin);
router.get('/calendar', getCalendarOverview);

router.put('/config', updateSchoolConfig);
router.put('/attendance-schedule', updateAttendanceSchedule);
router.post('/calendar', createHoliday);
router.put('/calendar/:id', updateHoliday);
router.delete('/calendar/:id', deleteHoliday);
router.post('/calendar/confirm-review', confirmCalendarReview);
router.patch('/daily-attendance/:id/correct', correctDailyAttendance);
router.post('/daily-attendance/finalize', finalizeDateManually);
router.post('/transfer-admin', transferAdmin);
router.post('/reset-device', resetDeviceBinding);
router.post('/force-reset-password', adminResetPassword);

module.exports = router;
