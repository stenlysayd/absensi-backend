const express = require('express');
const {
  runDailyMaintenance,
  runDailyAttendanceFinalization,
} = require('../controllers/maintenanceController');

const router = express.Router();

router.get('/daily-maintenance', runDailyMaintenance);
router.get('/daily-attendance-finalization', runDailyAttendanceFinalization);

module.exports = router;
