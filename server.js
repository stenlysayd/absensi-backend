// server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');
const guruRoutes = require('./routes/guruRoutes');
const profileRoutes = require('./routes/profileRoutes');
const maintenanceRoutes = require('./routes/maintenanceRoutes');

const app = express();
const port = process.env.PORT || 3300;
const host = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/cron', maintenanceRoutes);
app.use('/api', guruRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Server Absensi API berjalan normal!' });
});

if (!process.env.VERCEL) {
  const server = app.listen(port, host, () => {
    console.log(`Server berhasil berjalan di http://${host}:${port}`);
  });

  server.on('error', (err) => {
    console.error('Server gagal berjalan:', err.message);
    process.exit(1);
  });

  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = () => {
    clearInterval(keepAlive);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
