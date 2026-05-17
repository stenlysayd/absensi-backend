// controllers/guruController.js
const pool = require('../config/db');
const { getAttendanceSchedule } = require('../utils/attendanceSchedule');

// ENDPOINT: Mengambil rekap absen bulan ini + Nama Guru
const getDashboard = async(req, res) => {
    try {
        const userId = req.user.id;

        // 1. Ambil nama guru dari tabel users
        const userQuery = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
        const userName = userQuery.rows[0] ? userQuery.rows[0].name : 'Guru';

        // 2. Hitung rekap absensi HANYA untuk bulan & tahun ini (Sintaks PostgreSQL)
        const statQuery = `
      SELECT status, COUNT(*) as total
      FROM attendance
      WHERE user_id = $1
        AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE)
      GROUP BY status
    `;
        const stats = await pool.query(statQuery, [userId]);

        // 3. Kelompokkan hasilnya
        let hadir = 0,
            izin = 0,
            sakit = 0,
            alpha = 0;
        stats.rows.forEach(row => {
            const s = row.status.toLowerCase();
            if (s === 'valid' || s === 'hadir') hadir = parseInt(row.total);
            else if (s === 'izin') izin = parseInt(row.total);
            else if (s === 'sakit') sakit = parseInt(row.total);
            else if (s === 'rejected' || s === 'alpha') alpha = parseInt(row.total);
        });

        res.json({
            success: true,
            data: { name: userName, hadir, izin, sakit, alpha }
        });
    } catch (error) {
        console.error('Error get dashboard:', error);
        res.status(500).json({ success: false, message: 'Server error saat load dashboard' });
    }
};

// ENDPOINT: Mengambil radius & koordinat sekolah untuk Peta Flutter
const getSchoolConfig = async(req, res) => {
    try {
        const configQuery = await pool.query('SELECT school_lat, school_lng, radius_meter FROM school_config LIMIT 1');

        if (configQuery.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Konfigurasi sekolah belum diatur admin.' });
        }

        const schedule = await getAttendanceSchedule(pool);

        res.json({
            success: true,
            data: { ...configQuery.rows[0], ...schedule }
        });
    } catch (error) {
        console.error('Error get config:', error);
        res.status(500).json({ success: false, message: 'Server error saat load config' });
    }
};

module.exports = { getDashboard, getSchoolConfig };
