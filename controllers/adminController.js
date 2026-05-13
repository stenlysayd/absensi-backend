// controllers/adminController.js
const pool = require('../config/db');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');

// 1. Get Daftar User (Guru) - Fungsi lama tetap ada
const getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const query = `
      SELECT id, name, nuptk, role, device_id, created_at 
      FROM users 
      ORDER BY name ASC 
      LIMIT $1 OFFSET $2
    `;
    const { rows } = await pool.query(query, [limit, offset]);
    
    const totalQuery = await pool.query('SELECT COUNT(*) FROM users');
    const totalItems = parseInt(totalQuery.rows[0].count);
    const totalPages = Math.ceil(totalItems / limit);

    res.json({
      success: true,
      data: rows,
      pagination: { total_items: totalItems, total_pages: totalPages, current_page: page, items_per_page: limit }
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// 2. Get Statistik Dashboard (Total Hadir & Tidak Hadir Hari Ini)
const getDashboardStats = async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' }); // Format YYYY-MM-DD

    const totalUsersQuery = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'guru'");
    const totalTeachers = parseInt(totalUsersQuery.rows[0].count);

    const todayAttendanceQuery = await pool.query(`
      SELECT COUNT(DISTINCT user_id) FROM attendance
      WHERE DATE(check_in_time AT TIME ZONE 'Asia/Makassar') = $1 AND status = 'valid'
    `, [today]);
    const totalPresent = parseInt(todayAttendanceQuery.rows[0].count);

    const izinQuery = await pool.query(
      `
      SELECT COUNT(DISTINCT user_id) FROM attendance
      WHERE DATE(check_in_time AT TIME ZONE 'Asia/Makassar') = $1
        AND LOWER(status) IN ('izin', 'sakit', 'cuti')
    `,
      [today],
    );
    const totalIzin = parseInt(izinQuery.rows[0].count);

    const totalTanpaKabar = Math.max(0, totalTeachers - totalPresent - totalIzin);
    const totalAbsent = totalTeachers - totalPresent;

    res.json({
      success: true,
      data: {
        date: today,
        total_teachers: totalTeachers,
        total_present: totalPresent,
        total_absent: totalAbsent,
        total_izin: totalIzin,
        total_tanpa_kabar: totalTanpaKabar,
      },
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// 3. Get List Absensi Harian (Tabel Admin)
const getDailyAttendance = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });

    const query = `
      SELECT a.id, u.name, u.nuptk, a.check_in_time, a.status, a.photo_url, a.latitude, a.longitude
      FROM attendance a JOIN users u ON a.user_id = u.id
      WHERE DATE(a.check_in_time AT TIME ZONE 'Asia/Makassar') = $1
      ORDER BY a.check_in_time DESC LIMIT $2 OFFSET $3
    `;
    const { rows } = await pool.query(query, [date, limit, offset]);

    const countQuery = `SELECT COUNT(*) FROM attendance WHERE DATE(check_in_time AT TIME ZONE 'Asia/Makassar') = $1`;
    const totalQuery = await pool.query(countQuery, [date]);
    const totalItems = parseInt(totalQuery.rows[0].count);

    res.json({
      success: true,
      data: rows,
      pagination: { total_items: totalItems, total_pages: Math.ceil(totalItems / limit), current_page: page, items_per_page: limit }
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// 4. Export Absensi ke Excel
const exportAttendanceExcel = async (req, res) => {
  try {
    const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Makassar' });

    const query = `
      SELECT u.name, u.nuptk, a.check_in_time, a.status, a.photo_url, a.latitude, a.longitude
      FROM attendance a JOIN users u ON a.user_id = u.id
      WHERE DATE(a.check_in_time AT TIME ZONE 'Asia/Makassar') = $1
      ORDER BY a.check_in_time ASC
    `;
    const { rows } = await pool.query(query, [date]);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Absensi ${date}`);

    worksheet.columns = [
      { header: 'Nama Guru', key: 'name', width: 25 },
      { header: 'NUPTK', key: 'nuptk', width: 20 },
      { header: 'Waktu Absen', key: 'time', width: 20 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Koordinat', key: 'coord', width: 30 },
      { header: 'Link Foto', key: 'photo', width: 40 }
    ];

    rows.forEach(row => {
      worksheet.addRow({
        name: row.name,
        nuptk: row.nuptk,
        time: new Date(row.check_in_time).toLocaleTimeString('en-US', { timeZone: 'Asia/Makassar' }),
        status: row.status.toUpperCase(),
        coord: `${row.latitude}, ${row.longitude}`,
        photo: row.photo_url
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Rekap_Absensi_${date}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Gagal export data' });
  }
};

// 5. Update Konfigurasi Sekolah (Lokasi & Radius)
const updateSchoolConfig = async (req, res) => {
  try {
    const { school_lat, school_lng, radius_meter } = req.body;
    
    // Asumsi ID konfigurasi selalu 1 (karena cuma ada 1 sekolah)
    const query = `
      UPDATE school_config 
      SET school_lat = $1, school_lng = $2, radius_meter = $3, updated_at = CURRENT_TIMESTAMP 
      WHERE id = 1 RETURNING *
    `;
    const { rows } = await pool.query(query, [school_lat, school_lng, radius_meter]);
    
    res.json({ success: true, message: 'Konfigurasi lokasi sekolah berhasil diperbarui!', data: rows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Gagal memperbarui konfigurasi lokasi.' });
  }
};

// 6. Reset Device ID Guru (Jika HP hilang/ganti)
const resetDeviceBinding = async (req, res) => {
  try {
    const { nuptk } = req.body;
    
    if (!nuptk) {
      return res.status(400).json({ success: false, message: 'NUPTK wajib diisi.' });
    }

    const query = `UPDATE users SET device_id = NULL WHERE nuptk = $1 RETURNING name`;
    const { rows } = await pool.query(query, [nuptk]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Guru dengan NUPTK tersebut tidak ditemukan.' });
    }

    res.json({ 
      success: true, 
      message: `Device binding untuk guru ${rows[0].name} berhasil di-reset. Silakan login di HP baru.` 
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Gagal mereset device ID.' });
  }
};

// 7. Reset Password Guru oleh Admin (Bypass email)
const adminResetPassword = async (req, res) => {
  try {
    const { nuptk, new_password } = req.body;
    
    if (!nuptk || !new_password) {
      return res.status(400).json({ success: false, message: 'NUPTK dan password baru wajib diisi.' });
    }

    const newPasswordHash = await bcrypt.hash(new_password, 10); // bcrypt atau bcryptjs sesuai yang kamu pakai
    
    const query = `UPDATE users SET password_hash = $1 WHERE nuptk = $2 RETURNING name`;
    const { rows } = await pool.query(query, [newPasswordHash, nuptk]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Guru tidak ditemukan.' });
    }

    res.json({ success: true, message: `Password untuk guru ${rows[0].name} berhasil diubah secara paksa.` });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Gagal mereset password.' });
  }
};

// 8. Grafik 7 hari: jumlah guru unik (status valid) per hari (zona Asia/Makassar)
const getWeeklyStats = async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT to_char((g.day)::date, 'YYYY-MM-DD') AS date,
             (
               SELECT COUNT(DISTINCT a.user_id)::int
               FROM attendance a
               WHERE DATE(a.check_in_time AT TIME ZONE 'Asia/Makassar') = (g.day)::date
                 AND a.status = 'valid'
             ) AS count
      FROM generate_series(
        ((now() AT TIME ZONE 'Asia/Makassar')::date - 6),
        ((now() AT TIME ZONE 'Asia/Makassar')::date),
        interval '1 day'
      ) AS g(day)
      ORDER BY g.day
    `);
    res.json({
      success: true,
      data: rows.map((r) => ({ date: r.date, count: parseInt(r.count, 10) || 0 })),
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

// 9. Laporan rentang tanggal (untuk Flutter admin / export)
const getAttendanceReportRange = async (req, res) => {
  try {
    const from = req.query.from;
    const to = req.query.to;
    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: 'Query from dan to (YYYY-MM-DD) wajib diisi.',
      });
    }

    const query = `
      SELECT u.id::text AS profile_id,
             u.name AS teacher_name,
             u.nuptk,
             to_char(DATE(a.check_in_time AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD') AS attended_on,
             a.check_in_time AS check_in_at,
             a.status,
             trim(both from coalesce(a.latitude::text, '')) AS latitude,
             trim(both from coalesce(a.longitude::text, '')) AS longitude,
             COALESCE(a.reason, '') AS notes
      FROM attendance a
      JOIN users u ON u.id = a.user_id
      WHERE DATE(a.check_in_time AT TIME ZONE 'Asia/Makassar') BETWEEN $1::date AND $2::date
      ORDER BY a.check_in_time ASC
    `;
    const { rows } = await pool.query(query, [from, to]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

module.exports = {
  getUsers,
  getDashboardStats,
  getWeeklyStats,
  getDailyAttendance,
  getAttendanceReportRange,
  exportAttendanceExcel,
  updateSchoolConfig,
  resetDeviceBinding,
  adminResetPassword,
};