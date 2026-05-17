// controllers/attendanceController.js
const pool = require('../config/db');
const { uploadPhotoToDrive } = require('../utils/driveService');
const {
    getAttendanceSchedule,
    buildAttendanceWindow,
    validateAttendanceWindow,
} = require('../utils/attendanceSchedule');

const allowedAttendanceTypes = ['masuk', 'pulang'];
const absenceStatuses = ['izin', 'sakit', 'alpha'];

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

const getTodayAttendanceFlowError = async(userId, tipeAbsen, jenisKehadiran) => {
    const { rows } = await pool.query(
        `
        SELECT tipe_absen, status
        FROM attendance
        WHERE user_id = $1
          AND DATE(created_at AT TIME ZONE 'Asia/Makassar') = (now() AT TIME ZONE 'Asia/Makassar')::date
          AND status <> 'rejected'
        ORDER BY created_at ASC
        `,
        [userId]
    );

    const hasAnyRecord = rows.length > 0;
    const hasValidMasuk = rows.some(
        (row) => row.tipe_absen === 'masuk' && ['valid', 'hadir'].includes(String(row.status).toLowerCase())
    );
    const hasPulang = rows.some((row) => row.tipe_absen === 'pulang');

    if (absenceStatuses.includes(jenisKehadiran)) {
        return hasAnyRecord ? 'Absensi hari ini sudah tercatat. Admin bisa koreksi data jika ada perubahan.' : null;
    }

    if (tipeAbsen === 'masuk' && hasAnyRecord) {
        return 'Absen masuk hari ini sudah tercatat. Gunakan absen pulang jika ingin menutup hari kerja.';
    }

    if (tipeAbsen === 'pulang' && !hasValidMasuk) {
        return 'Absen masuk dulu sebelum absen pulang.';
    }

    if (tipeAbsen === 'pulang' && hasPulang) {
        return 'Absen pulang hari ini sudah tercatat.';
    }

    return null;
};

const getTodayRecords = async(userId) => {
    const { rows } = await pool.query(
        `
        SELECT tipe_absen, status, created_at
        FROM attendance
        WHERE user_id = $1
          AND DATE(created_at AT TIME ZONE 'Asia/Makassar') = (now() AT TIME ZONE 'Asia/Makassar')::date
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

    return {
        date: masukWindow.now.date,
        now: masukWindow.now.time,
        weekday: masukWindow.now.weekday,
        schedule,
        has_masuk: hasMasuk,
        has_pulang: hasPulang,
        has_absence: hasAbsence,
        can_absen_masuk: masukWindow.open && !hasMasuk && !hasAbsence && records.length === 0,
        can_absen_pulang: pulangWindow.open && hasMasuk && !hasPulang,
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

        const schedule = await getAttendanceSchedule(pool);
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

        // Validasi Wajib Alasan untuk Izin/Sakit/Alpha
        if (absenceStatuses.includes(normalizedStatus) && (!alasan || alasan.trim() === '')) {
            return res.status(400).json({ success: false, message: 'Kolom alasan wajib diisi untuk status selain Hadir.' });
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

        const schedule = await getAttendanceSchedule(pool);
        const scheduleGate = validateAttendanceWindow(schedule, normalizedType);
        if (!scheduleGate.ok) {
            return res.status(403).json({ success: false, message: scheduleGate.message, data: scheduleGate.window });
        }

        // Validasi Ulang Alasan Izin/Sakit/Alpha di tahap akhir
        if (absenceStatuses.includes(normalizedStatus) && (!alasan || alasan.trim() === '')) {
            return res.status(400).json({ success: false, message: 'Alasan tidak boleh kosong untuk status selain Hadir.' });
        }

        const flowError = await getTodayAttendanceFlowError(user.id, normalizedType, normalizedStatus);
        if (flowError) {
            return res.status(409).json({ success: false, message: flowError });
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
      INSERT INTO attendance (user_id, latitude, longitude, accuracy, is_mocked, photo_url, status, reason, tipe_absen)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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

        const result = await pool.query(insertQuery, values);

        res.json({
            success: true,
            message: 'Absensi berhasil direkam!',
            data: result.rows[0]
        });

    } catch (error) {
        console.error('Error submit absensi:', error);
        res.status(500).json({ success: false, message: 'Gagal merekam absensi server error.' });
    }
};

// ENDPOINT 3: Mengambil Riwayat Absen (Maksimal 50 data terakhir)
const getHistory = async(req, res) => {
    try {
        const userId = req.user.id;
        const query = `
      SELECT created_at, status, reason, tipe_absen
      FROM attendance 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
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

module.exports = {
    getTodayStatus,
    checkEligibility,
    submitAttendance,
    getHistory
};
