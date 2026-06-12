const express = require('express');
const { runDailyMaintenance } = require('../controllers/maintenanceController');

const router = express.Router();

router.get('/daily-maintenance', runDailyMaintenance);

module.exports = router;
