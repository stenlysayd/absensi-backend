// server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./config/db');

const app = express();
const port = process.env.PORT || 3300;

// Middleware
app.use(cors());
app.use(express.json()); // Parsing application/json
app.use(express.urlencoded({ extended: true })); // Parsing application/x-www-form-urlencoded

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');

const guruRoutes = require('./routes/guruRoutes');

// Daftarkan semua route
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api', guruRoutes);

// ==========================================
// ROUTE TEST: Pengecekan Server
// ==========================================
app.get('/', (req, res) => {
    res.json({ message: '🚀 Server Absensi API berjalan normal!' });
});

// Jalankan Server
app.listen(port, () => {
    console.log(`🚀 Server berhasil berjalan di port ${port}`);
});