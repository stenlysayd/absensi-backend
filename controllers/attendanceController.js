// controllers/attendanceController.js
const pool = require('../config/db');
const { uploadPhotoToDrive } = require('../utils/driveService');
const {
    getAttendanceSchedule,
    buildAttendanceWindow,
    validateAttendanceWindow,
    getMakassarNow,
} = require('../utils/attendanceSchedule');
const {
    absenceStatuses,
    getDayContext,
    syncDailyFromAttendance,
    listCalendarDays,
} = require('../utils/attendanceDailyService');

const allowedAttendanceTypes = ['masuk', 'pulang'];
const allowedPresenceStatuses = ['hadir', ...absenceStatuses];

// Fungsi Geofencing: Haversine Formula
const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

const normalizeAttendanceType = (value) => {
    const normalized = String(value || 'masuk').trim().toLowerCase();
    return allowedAttendanceTypes.includes(normalized) ? normalized : null;
};

const normalizePresenceStatus = (value) => {
    return String(value || 'hadir').trim().toLowerCase();
};

const getTodayAttendanceFlowError = async(
    userId,
    tipeAbsen,
    jenisKehadiran,
    client = pool,
    attendanceDate = getMakassarNow().date,
) => {
    const { rows } = await client.query(
        `
        SELECT tipe_absen, status
        FROM attendance
        WHERE user_id = $1
          AND attendance_date = $2::date
          AND status <> 'rejected'
        ORDER BY created_at ASC
        `,
        [userId, attendanceDate]
    );

    const hasAnyRecord = rows.length > 0;
    const hasSelectedType = rows.some((row) => row.tipe_absen === tipeAbsen);

    if (absenceStatuses.includes(jenisKehadiran)) {
        return hasAnyRecord ? 'Absensi hari ini sudah tercatat. Admin bisa koreksi data jika ada perubahan.' : null;
    }

    if (hasSelectedType) {
        return `Absen ${tipeAbsen} hari ini sudah tercatat.`;
    }

    return null;
};

const getTodayRecords = async(userId) => {
    const { rows } = await pool.query(
        `
        SELECT tipe_absen, status, created_at
        FROM attendance
        WHERE user_id = $1
          AND attendance_date = (now() AT TIME ZONE 'Asia/Makassar')::date
          AND status <> 'rejected'
        ORDER BY created_at ASC
        `,
        [userId]
    );
    return rows;
};

const buildTodayStatus = async(userId) => {
    const schedule = await getAttendanceSchedule(pool);
    const records = await getTodayRecords(userId);
    const hasMasuk = records.some(
        (row) => row.tipe_absen === 'masuk' && ['valid', 'hadir'].includes(String(row.status).toLowerCase())
    );
    const hasPulang = records.some((row) => row.tipe_absen === 'pulang');
    const hasAbsence = records.some((row) => absenceStatuses.includes(String(row.status).toLowerCase()));
    const masukWindow = buildAttendanceWindow(schedule, 'masuk');
    const pulangWindow = buildAttendanceWindow(schedule, 'pulang');
    const dayContext = await getDayContext(masukWindow.now.date);
    const dailyResult = await pool.query(
        `
          SELECT masuk_status, pulang_status, daily_status, reason, finalized_at
          FROM attendance_daily
          WHERE user_id = $1 AND attendance_date = $2::date
          LIMIT 1
        `,
        [userId, masukWindow.now.date],
    );
    const daily = dailyResult.rows[0] || null;
    const attendanceOpen = dayContext.is_working_day && !dayContext.is_holiday;

    return {
        date: masukWindow.now.date,
        now: masukWindow.now.time,
        weekday: masukWindow.now.weekday,
        schedule,
        has_masuk: hasMasuk,
        has_pulang: hasPulang,
        has_absence: hasAbsence,
        masuk_status: daily?.masuk_status || (hasMasuk ? 'recorded' : 'pending'),
        pulang_status: daily?.pulang_status || (hasPulang ? 'recorded' : 'pending'),
        daily_status: daily?.daily_status || 'pending',
        reason: daily?.reason || null,
        is_holiday: dayContext.is_holiday || !dayContext.is_working_day,
        holiday: dayContext.holiday,
        can_absen_masuk: attendanceOpen && masukWindow.open && !hasMasuk && !hasAbsence,
        can_absen_pulang: attendanceOpen && pulangWindow.open && !hasPulang && !hasAbsence,
        masuk_window: masukWindow,
        pulang_window: pulangWindow,
    };
};

const getTodayStatus = async(req, res) => {
    try {
        const status = await buildTodayStatus(req.user.id);
        res.json({
            success: true,
            data: status,
        });
    } catch (error) {
        console.error('Error status absensi:', error);
        res.status(500).json({ success: false, message: 'Gagal memuat status absensi.' });
    }
};

// ENDPOINT 1: Pengecekan Kelayakan Absen (Sebelum Kamera Terbuka)
const checkEligibility = async(req, res) => {
    try {
        // Tambahkan jenis_kehadiran (default: 'hadir') dan alasan
        const { latitude, longitude, accuracy, is_mocked, tipe_absen, jenis_kehadiran = 'hadir', alasan } = req.body;
        const normalizedStatus = normalizePresenceStatus(jenis_kehadiran);
        const normalizedType = absenceStatuses.includes(normalizedStatus)
            ? 'masuk'
            : normalizeAttendanceType(tipe_absen);

        if (!latitude || !longitude) {
            return res.status(400).json({ success: false, message: 'Koordinat lokasi tidak lengkap.' });
        }
        if (!normalizedType) {
            return res.status(400).json({ success: false, message: 'Jenis absen hanya boleh masuk atau pulang.' });
        }
        if (!allowedPresenceStatuses.includes(normalizedStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Status kehadiran hanya boleh Hadir, Izin, atau Sakit.',
            });
        }

        const schedule = await getAttendanceSchedule(pool);
        const dayContext = await getDayContext(getMakassarNow().date);
        if (!dayContext.is_working_day || dayContext.is_holiday) {
            return res.status(403).json({
                success: false,
                code: 'HOLIDAY',
                message: dayContext.holiday?.name
                    ? `Absensi ditutup: ${dayContext.holiday.name}.`
                    : 'Hari ini bukan hari kerja.',
                data: dayContext,
            });
        }
        const scheduleGate = validateAttendanceWindow(schedule, normalizedType);
        if (!scheduleGate.ok) {
            return res.status(403).json({ success: false, message: scheduleGate.message, data: scheduleGate.window });
        }

        if (is_mocked === 'true' || is_mocked === true) {
            return res.status(403).json({ success: false, message: 'Terdeteksi penggunaan Fake GPS / Mock Location!' });
        }
        if (accuracy > 50) {
            return res.status(400).json({ success: false, message: 'Akurasi GPS lemah (>50m). Pastikan berada di area terbuka.' });
        }

        // Validasi wajib alasan hanya untuk Izin/Sakit.
        if (absenceStatuses.includes(normalizedStatus) && (!alasan || alasan.trim() === '')) {
            return res.status(400).json({ success: false, message: 'Kolom keterangan wajib diisi untuk Izin atau Sakit.' });
        }

        const flowError = await getTodayAttendanceFlowError(req.user.id, normalizedType, normalizedStatus);
        if (flowError) {
            return res.status(409).json({ success: false, message: flowError });
        }

        const configQuery = await pool.query('SELECT * FROM school_config LIMIT 1');
        if (configQuery.rows.length === 0) {
            return res.status(500).json({ success: false, message: 'Konfigurasi lokasi sekolah belum diatur.' });
        }
        const school = configQuery.rows[0];

        const distance = calculateDistance(latitude, longitude, school.school_lat, school.school_lng);
        const roundedDistance = Math.round(distance);

        // Bypass Geofencing JIKA Izin atau Sakit (Pengecekan jarak hanya untuk 'hadir')
        if (normalizedStatus === 'hadir' && roundedDistance > school.radius_meter) {
            return res.status(403).json({
                success: false,
                message: `Gagal. Anda berada ${roundedDistance} meter dari titik sekolah. Maksimal radius adalah ${school.radius_meter} meter.`
            });
        }

        const now = new Date();
        const timeOptions = { timeZone: 'Asia/Makassar', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
        const currentTime = now.toLocaleTimeString('en-US', timeOptions);

        res.json({
            success: true,
            message: 'Lokasi dan waktu valid. Silakan lanjutkan ambil foto selfie.',
            data: { distance_meter: roundedDistance, current_time: currentTime, tipe_absen: normalizedType }
        });

    } catch (error) {
        console.error('Error pengecekan absensi:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
    }
};

// ENDPOINT 2: Submit Absensi Final (Upload Foto + Insert Supabase)
const submitAttendance = async(req, res) => {
    const client = await pool.connect();
    try {
        const user = req.user; // Dari token JWT
        // Tambahkan jenis_kehadiran dan alasan
        const { latitude, longitude, accuracy, is_mocked, tipe_absen, jenis_kehadiran = 'hadir', alasan } = req.body;
        const normalizedStatus = normalizePresenceStatus(jenis_kehadiran);
        const normalizedType = absenceStatuses.includes(normalizedStatus)
            ? 'masuk'
            : normalizeAttendanceType(tipe_absen);

        // 1. Validasi File Foto
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Foto selfie wajib dikirim.' });
        }
        if (!normalizedType) {
            return res.status(400).json({ success: false, message: 'Jenis absen hanya boleh masuk atau pulang.' });
        }
        if (!allowedPresenceStatuses.includes(normalizedStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Status kehadiran hanya boleh Hadir, Izin, atau Sakit.',
            });
        }

        const schedule = await getAttendanceSchedule(pool);
        const attendanceDate = getMakassarNow().date;
        const dayContext = await getDayContext(attendanceDate);
        if (!dayContext.is_working_day || dayContext.is_holiday) {
            return res.status(403).json({
                success: false,
                code: 'HOLIDAY',
                message: dayContext.holiday?.name
                    ? `Absensi ditutup: ${dayContext.holiday.name}.`
                    : 'Hari ini bukan hari kerja.',
            });
        }
        const scheduleGate = validateAttendanceWindow(schedule, normalizedType);
        if (!scheduleGate.ok) {
            return res.status(403).json({ success: false, message: scheduleGate.message, data: scheduleGate.window });
        }

        // Validasi ulang alasan Izin/Sakit di tahap akhir.
        if (absenceStatuses.includes(normalizedStatus) && (!alasan || alasan.trim() === '')) {
            return res.status(400).json({ success: false, message: 'Keterangan wajib diisi untuk Izin atau Sakit.' });
        }

        // 2. Upload Foto ke Google Drive (Nama file disesuaikan dengan jenis kehadiran)
        const fileName = `${normalizedType}_${normalizedStatus}_Absen_${user.nuptk}_${Date.now()}.jpg`;
        const photoUrl = await uploadPhotoToDrive(req.file.buffer, req.file.mimetype, fileName, normalizedType);

        // 3. Validasi Geofencing Ulang (Keamanan Ganda)
        let statusAbsen = normalizedStatus === 'hadir' ? 'valid' : normalizedStatus;
        let finalReason = absenceStatuses.includes(normalizedStatus) ? alasan : null;

        const configQuery = await pool.query('SELECT * FROM school_config LIMIT 1');
        const school = configQuery.rows[0];
        const distance = calculateDistance(latitude, longitude, school.school_lat, school.school_lng);

        // Fake GPS tetap ditolak walau izin/sakit. Jarak hanya dicek jika 'hadir'
        if (is_mocked === 'true' || is_mocked === true) {
            statusAbsen = 'rejected';
            finalReason = 'Terdeteksi Fake GPS saat submit';
        } else if (normalizedStatus === 'hadir' && Math.round(distance) > school.radius_meter) {
            statusAbsen = 'rejected';
            finalReason = 'Di luar radius sekolah saat submit';
        }

        // 4. Simpan Data ke Database Supabase
        const insertQuery = `
      INSERT INTO attendance (
        user_id,
        latitude,
        longitude,
        accuracy,
        is_mocked,
        photo_url,
        status,
        reason,
        tipe_absen,
        attendance_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date)
      RETURNING *;
    `;
        const values = [
            user.id,
            latitude,
            longitude,
            accuracy,
            is_mocked === 'true' || is_mocked === true,
            photoUrl,
            statusAbsen,
            finalReason,
            normalizedType
        ];

        await client.query('BEGIN');
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            [`${user.id}:${attendanceDate}`],
        );
        const flowError = await getTodayAttendanceFlowError(
            user.id,
            normalizedType,
            normalizedStatus,
            client,
            attendanceDate,
        );
        if (flowError) {
            await client.query('ROLLBACK');
            return res.status(409).json({ success: false, message: flowError });
        }

        const result = await client.query(insertQuery, [
            ...values,
            attendanceDate,
        ]);
        if (statusAbsen !== 'rejected') {
            await syncDailyFromAttendance({
                client,
                userId: user.id,
                attendanceDate,
                attendance: result.rows[0],
                presenceStatus: normalizedStatus,
                type: normalizedType,
                reason: finalReason,
            });
        }
        await client.query('COMMIT');

        if (statusAbsen === 'rejected') {
            return res.status(403).json({
                success: false,
                message: finalReason,
            });
        }

        res.json({
            success: true,
            message: 'Absensi berhasil direkam!',
            data: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error submit absensi:', error);
        res.status(500).json({ success: false, message: 'Gagal merekam absensi server error.' });
    } finally {
        client.release();
    }
};

// ENDPOINT 3: Mengambil Riwayat Absen (Maksimal 50 data terakhir)
const getHistory = async(req, res) => {
    try {
        const userId = req.user.id;
        const query = `
      SELECT
        d.id,
        d.attendance_date,
        d.masuk_at,
        d.pulang_at,
        d.masuk_status,
        d.pulang_status,
        d.daily_status,
        d.reason,
        d.is_holiday,
        h.name AS holiday_name,
        d.correction_reason
      FROM attendance_daily d
      LEFT JOIN holiday_calendar h ON h.id = d.holiday_id
      WHERE d.user_id = $1
      ORDER BY d.attendance_date DESC
      LIMIT 50
    `;
        const result = await pool.query(query, [userId]);

        res.json({
            success: true,
            message: 'Riwayat berhasil ditarik',
            data: result.rows
        });
    } catch (error) {
        console.error('Error get history:', error);
        res.status(500).json({ success: false, message: 'Gagal menarik riwayat server.' });
    }
};

const getReminderCalendar = async (req, res) => {
    try {
        const requestedDays = Number(req.query.days || 60);
        const days = Math.min(90, Math.max(7, requestedDays));
        const from = getMakassarNow().date;
        const toDate = new Date(`${from}T00:00:00+08:00`);
        toDate.setDate(toDate.getDate() + days);
        const to = toDate.toLocaleDateString('en-CA', {
            timeZone: 'Asia/Makassar',
        });
        const schedule = await getAttendanceSchedule(pool);
        const calendar = await listCalendarDays({ from, to });

        res.json({
            success: true,
            data: { from, to, schedule, days: calendar },
        });
    } catch (error) {
        console.error('Error reminder calendar:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal memuat kalender pengingat.',
        });
    }
};

module.exports = {
    getTodayStatus,
    getReminderCalendar,
    checkEligibility,
    submitAttendance,
    getHistory
};
