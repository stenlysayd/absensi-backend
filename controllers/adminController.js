// controllers/adminController.js
const pool = require('../config/db');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const { testDriveConnection, listFilesInFolder } = require('../utils/driveService');
const {
  DEFAULT_SCHEDULE,
  normalizeTime,
  normalizeWeekdays,
  getAttendanceSchedule,
} = require('../utils/attendanceSchedule');
const { getDayContext } = require('../utils/attendanceDailyService');

const formatDateWita = (value) =>
  new Date(value).toLocaleDateString('id-ID', {
    timeZone: 'Asia/Makassar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

const formatDayWita = (value) =>
  new Date(value).toLocaleDateString('id-ID', {
    timeZone: 'Asia/Makassar',
    weekday: 'long',
  });

const formatTimeWita = (value) =>
  new Date(value).toLocaleTimeString('id-ID', {
    timeZone: 'Asia/Makassar',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });

const mapsUrl = (lat, lng) => {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return '-';
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
};

const reportStatusLabel = (status) => {
  const value = String(status || '').toLowerCase();
  if (value === 'valid' || value === 'hadir') return 'Hadir';
  if (value === 'rejected') return 'Ditolak';
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '-';
};

// 1. Get Daftar User (Guru) - Fungsi lama tetap ada
const getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const query = `
      SELECT id, name, nuptk, email, role, device_id, profile_photo_url, created_at 
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
    const dayContext = await getDayContext(today);

    const totalUsersQuery = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'guru'");
    const totalTeachers = parseInt(totalUsersQuery.rows[0].count);

    const todayAttendanceQuery = await pool.query(`
      SELECT COUNT(*) FROM attendance_daily
      WHERE attendance_date = $1
        AND (
          daily_status IN ('hadir', 'incomplete')
          OR masuk_status = 'recorded'
          OR pulang_status = 'recorded'
        )
    `, [today]);
    const totalPresent = parseInt(todayAttendanceQuery.rows[0].count);

    const izinQuery = await pool.query(
      `
      SELECT COUNT(*) FROM attendance_daily
      WHERE attendance_date = $1
        AND daily_status IN ('izin', 'sakit')
    `,
      [today],
    );
    const totalIzin = parseInt(izinQuery.rows[0].count);

    const totalTanpaKabar = dayContext.is_working_day && !dayContext.is_holiday
      ? Math.max(0, totalTeachers - totalPresent - totalIzin)
      : 0;
    const totalAbsent = dayContext.is_working_day && !dayContext.is_holiday
      ? Math.max(0, totalTeachers - totalPresent)
      : 0;

    res.json({
      success: true,
      data: {
        date: today,
        total_teachers: totalTeachers,
        total_present: totalPresent,
        total_absent: totalAbsent,
        total_izin: totalIzin,
        total_tanpa_kabar: totalTanpaKabar,
        is_holiday: dayContext.is_holiday || !dayContext.is_working_day,
        holiday_name: dayContext.holiday?.name || null,
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
      SELECT d.id,
             u.name,
             u.nuptk,
             d.attendance_date,
             d.masuk_at,
             d.pulang_at,
             d.masuk_status,
             d.pulang_status,
             d.daily_status,
             d.reason,
             d.is_holiday,
             d.correction_reason
      FROM attendance_daily d
      JOIN users u ON d.user_id = u.id
      WHERE d.attendance_date = $1
      ORDER BY u.name ASC LIMIT $2 OFFSET $3
    `;
    const { rows } = await pool.query(query, [date, limit, offset]);

    const countQuery = `SELECT COUNT(*) FROM attendance_daily WHERE attendance_date = $1`;
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
      SELECT d.id,
             u.name,
             u.nuptk,
             d.attendance_date,
             d.masuk_at,
             d.pulang_at,
             d.masuk_status,
             d.pulang_status,
             d.daily_status,
             d.reason,
             d.is_holiday,
             d.correction_reason,
             am.photo_url AS masuk_photo_url,
             ap.photo_url AS pulang_photo_url,
             am.latitude AS masuk_latitude,
             am.longitude AS masuk_longitude,
             ap.latitude AS pulang_latitude,
             ap.longitude AS pulang_longitude
      FROM attendance_daily d
      JOIN users u ON d.user_id = u.id
      LEFT JOIN attendance am ON am.id = d.masuk_attendance_id
      LEFT JOIN attendance ap ON ap.id = d.pulang_attendance_id
      WHERE d.attendance_date = $1
      ORDER BY u.name ASC
    `;
    const { rows } = await pool.query(query, [date]);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`Absensi ${date}`);

    worksheet.columns = [
      { header: 'No', key: 'no', width: 6 },
      { header: 'ID Absen', key: 'id', width: 24 },
      { header: 'Nama Guru', key: 'name', width: 25 },
      { header: 'NUPTK', key: 'nuptk', width: 20 },
      { header: 'Tanggal', key: 'date', width: 14 },
      { header: 'Status Harian', key: 'daily_status', width: 18 },
      { header: 'Status Masuk', key: 'masuk_status', width: 20 },
      { header: 'Jam Masuk', key: 'masuk_time', width: 14 },
      { header: 'Foto Masuk', key: 'masuk_photo', width: 18 },
      { header: 'Lokasi Masuk', key: 'masuk_maps', width: 18 },
      { header: 'Status Pulang', key: 'pulang_status', width: 20 },
      { header: 'Jam Pulang', key: 'pulang_time', width: 14 },
      { header: 'Foto Pulang', key: 'pulang_photo', width: 18 },
      { header: 'Lokasi Pulang', key: 'pulang_maps', width: 18 },
      { header: 'Keterangan', key: 'reason', width: 36 },
      { header: 'Hari Libur', key: 'holiday', width: 14 },
      { header: 'Koreksi Admin', key: 'correction', width: 36 },
    ];

    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF111111' },
    };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];

    rows.forEach((row, index) => {
      const masukMaps = mapsUrl(row.masuk_latitude, row.masuk_longitude);
      const pulangMaps = mapsUrl(row.pulang_latitude, row.pulang_longitude);
      worksheet.addRow({
        no: index + 1,
        id: row.id,
        name: row.name,
        nuptk: row.nuptk,
        date: row.attendance_date,
        daily_status: reportStatusLabel(row.daily_status),
        masuk_status: row.masuk_status === 'missed'
          ? 'Tidak melakukan absensi'
          : reportStatusLabel(row.masuk_status),
        masuk_time: row.masuk_at ? formatTimeWita(row.masuk_at) : '-',
        masuk_photo: row.masuk_photo_url
          ? { text: 'Buka Foto', hyperlink: row.masuk_photo_url }
          : '-',
        masuk_maps: masukMaps === '-'
          ? '-'
          : { text: 'Buka Maps', hyperlink: masukMaps },
        pulang_status: row.pulang_status === 'missed'
          ? 'Tidak melakukan absensi'
          : reportStatusLabel(row.pulang_status),
        pulang_time: row.pulang_at ? formatTimeWita(row.pulang_at) : '-',
        pulang_photo: row.pulang_photo_url
          ? { text: 'Buka Foto', hyperlink: row.pulang_photo_url }
          : '-',
        pulang_maps: pulangMaps === '-'
          ? '-'
          : { text: 'Buka Maps', hyperlink: pulangMaps },
        reason: row.reason || '-',
        holiday: row.is_holiday ? 'Ya' : 'Tidak',
        correction: row.correction_reason || '-',
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
      INSERT INTO school_config (
        id,
        school_name,
        school_lat,
        school_lng,
        radius_meter,
        start_time,
        end_time,
        masuk_start_time,
        masuk_end_time,
        pulang_start_time,
        pulang_end_time,
        allowed_weekdays
      )
      VALUES (
        1,
        'Sekolah',
        $1,
        $2,
        $3,
        $4::time,
        $5::time,
        $4::time,
        $6::time,
        $7::time,
        $5::time,
        $8::int[]
      )
      ON CONFLICT (id) DO UPDATE
      SET school_lat = EXCLUDED.school_lat,
          school_lng = EXCLUDED.school_lng,
          radius_meter = EXCLUDED.radius_meter,
          updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;
    const { rows } = await pool.query(query, [
      school_lat,
      school_lng,
      radius_meter,
      DEFAULT_SCHEDULE.masuk_start_time,
      DEFAULT_SCHEDULE.pulang_end_time,
      DEFAULT_SCHEDULE.masuk_end_time,
      DEFAULT_SCHEDULE.pulang_start_time,
      DEFAULT_SCHEDULE.allowed_weekdays,
    ]);
    
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

    const query = `UPDATE users SET device_id = NULL, token_version = COALESCE(token_version, 0) + 1 WHERE nuptk = $1 RETURNING name`;
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
    
    const query = `UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1 WHERE nuptk = $2 RETURNING name`;
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
               SELECT COUNT(*)::int
               FROM attendance_daily d
               WHERE d.attendance_date = (g.day)::date
                 AND d.daily_status IN ('hadir', 'incomplete')
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
             d.id::text AS daily_id,
             u.name AS teacher_name,
             u.email,
             u.nuptk,
             to_char(d.attendance_date, 'YYYY-MM-DD') AS attended_on,
             d.daily_status AS status,
             d.masuk_status,
             d.pulang_status,
             d.masuk_at,
             d.pulang_at,
             COALESCE(d.reason, '') AS notes,
             d.is_holiday,
             COALESCE(h.name, '') AS holiday_name,
             COALESCE(d.correction_reason, '') AS correction_reason,
             d.masuk_attendance_id::text,
             d.pulang_attendance_id::text,
             COALESCE(am.photo_url, '') AS masuk_photo_url,
             COALESCE(ap.photo_url, '') AS pulang_photo_url,
             am.latitude AS masuk_latitude,
             am.longitude AS masuk_longitude,
             am.accuracy AS masuk_accuracy,
             am.is_mocked AS masuk_is_mocked,
             ap.latitude AS pulang_latitude,
             ap.longitude AS pulang_longitude,
             ap.accuracy AS pulang_accuracy,
             ap.is_mocked AS pulang_is_mocked
      FROM attendance_daily d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN holiday_calendar h ON h.id = d.holiday_id
      LEFT JOIN attendance am ON am.id = d.masuk_attendance_id
      LEFT JOIN attendance ap ON ap.id = d.pulang_attendance_id
      WHERE d.attendance_date BETWEEN $1::date AND $2::date
      ORDER BY d.attendance_date ASC, u.name ASC
    `;
    const { rows } = await pool.query(query, [from, to]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const allowedRoles = ['admin', 'guru'];

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Role hanya boleh admin atau guru.',
      });
    }

    if (String(req.user.id) === String(id) && role !== 'admin') {
      return res.status(400).json({
        success: false,
        message: 'Admin tidak bisa menurunkan role akun sendiri.',
      });
    }

    const { rows } = await pool.query(
      'UPDATE users SET role = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2 RETURNING id, name, nuptk, email, role',
      [role, id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    }

    res.json({
      success: true,
      message: `Role ${rows[0].name} berhasil diubah menjadi ${role}.`,
      data: rows[0],
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Gagal mengubah role user.' });
  }
};

const getAttendanceScheduleAdmin = async (req, res) => {
  try {
    const schedule = await getAttendanceSchedule(pool);
    res.json({ success: true, data: schedule });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Gagal memuat jadwal absensi.' });
  }
};

const updateAttendanceSchedule = async (req, res) => {
  try {
    const masukStart = normalizeTime(req.body.masuk_start_time, DEFAULT_SCHEDULE.masuk_start_time);
    const masukEnd = normalizeTime(req.body.masuk_end_time, DEFAULT_SCHEDULE.masuk_end_time);
    const pulangStart = normalizeTime(req.body.pulang_start_time, DEFAULT_SCHEDULE.pulang_start_time);
    const pulangEnd = normalizeTime(req.body.pulang_end_time, DEFAULT_SCHEDULE.pulang_end_time);
    const weekdays = normalizeWeekdays(req.body.allowed_weekdays);

    if (weekdays.length === 0) {
      return res.status(400).json({ success: false, message: 'Minimal pilih satu hari aktif.' });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO school_config (
        id,
        school_name,
        school_lat,
        school_lng,
        radius_meter,
        start_time,
        end_time,
        masuk_start_time,
        masuk_end_time,
        pulang_start_time,
        pulang_end_time,
        allowed_weekdays
      )
      VALUES (
        1,
        'Sekolah',
        0,
        0,
        100,
        $1::time,
        $4::time,
        $1::time,
        $2::time,
        $3::time,
        $4::time,
        $5::int[]
      )
      ON CONFLICT (id) DO UPDATE
      SET masuk_start_time = EXCLUDED.masuk_start_time,
          masuk_end_time = EXCLUDED.masuk_end_time,
          pulang_start_time = EXCLUDED.pulang_start_time,
          pulang_end_time = EXCLUDED.pulang_end_time,
          allowed_weekdays = EXCLUDED.allowed_weekdays,
          start_time = EXCLUDED.masuk_start_time,
          end_time = EXCLUDED.pulang_end_time,
          updated_at = CURRENT_TIMESTAMP
      RETURNING masuk_start_time,
                masuk_end_time,
                pulang_start_time,
                pulang_end_time,
                allowed_weekdays
      `,
      [masukStart, masukEnd, pulangStart, pulangEnd, weekdays],
    );

    res.json({
      success: true,
      message: 'Jadwal absensi berhasil diperbarui.',
      data: rows[0],
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: 'Gagal memperbarui jadwal absensi.' });
  }
};

const transferAdmin = async (req, res) => {
  const client = await pool.connect();
  try {
    const { target_user_id, confirmation_text } = req.body;

    if (!target_user_id) {
      return res.status(400).json({ success: false, message: 'User pengganti admin wajib dipilih.' });
    }
    if (confirmation_text !== 'Aku Yakin') {
      return res.status(400).json({ success: false, message: 'Konfirmasi harus diketik persis: Aku Yakin' });
    }
    if (String(target_user_id) === String(req.user.id)) {
      return res.status(400).json({ success: false, message: 'Pilih akun lain sebagai admin baru.' });
    }

    await client.query('BEGIN');
    const current = await client.query(
      'SELECT id, name, role FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id],
    );
    const target = await client.query(
      'SELECT id, name, role FROM users WHERE id = $1 FOR UPDATE',
      [target_user_id],
    );

    if (current.rows.length === 0 || current.rows[0].role !== 'admin') {
      throw new Error('Akun admin saat ini tidak valid.');
    }
    if (target.rows.length === 0) {
      throw new Error('User pengganti admin tidak ditemukan.');
    }

    await client.query(
      `
      UPDATE users
      SET role = 'admin',
          token_version = COALESCE(token_version, 0) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [target_user_id],
    );
    await client.query(
      `
      UPDATE users
      SET role = 'guru',
          token_version = COALESCE(token_version, 0) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [req.user.id],
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      code: 'ADMIN_TRANSFERRED',
      message: `Admin berhasil dipindahkan ke ${target.rows[0].name}. Silakan login ulang.`,
      data: {
        previous_admin_id: req.user.id,
        new_admin_id: target_user_id,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ success: false, message: err.message || 'Gagal mengganti admin.' });
  } finally {
    client.release();
  }
};

// 10. Status koneksi Google Drive dari kredensial server.
const getDriveStatus = async (req, res) => {
  try {
    const driveStatus = await testDriveConnection();
    res.json({ success: true, data: driveStatus });
  } catch (err) {
    res.status(503).json({
      success: false,
      code: err.code || 'DRIVE_CONNECTION_FAILED',
      message: err.message || 'Google Drive belum terhubung.',
      data: {
        connected: false,
        reauth_required: Boolean(err.reauthRequired),
      },
    });
  }
};

// 11. Daftar file/folder Google Drive lewat backend agar secret tidak ada di aplikasi.
const getDriveFiles = async (req, res) => {
  try {
    const files = await listFilesInFolder(req.query.folder_id);
    res.json({ success: true, data: files });
  } catch (err) {
    res.status(503).json({
      success: false,
      message: err.message || 'Gagal membaca Google Drive.',
    });
  }
};

module.exports = {
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
};
