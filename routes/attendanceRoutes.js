// routes/attendanceRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');

const { checkEligibility, submitAttendance, getHistory } = require('../controllers/attendanceController');
const { verifyToken } = require('../middlewares/authMiddleware');

// Setup Multer (Simpan di memory sementara untuk dilempar ke Google Drive)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // Limit foto maksimal 5MB
    },
});

// Endpoint 1: Cek lokasi & waktu (Payload JSON)
router.post('/check', verifyToken, checkEligibility);

// Endpoint 2: Submit final absensi (Payload Multipart/Form-Data)
// Field name untuk gambar di aplikasi Flutter nantinya wajib bernama 'photo'
router.post('/', verifyToken, upload.single('photo'), submitAttendance);

router.get('/history', verifyToken, getHistory);

module.exports = router;