// controllers/attendanceController.js
const pool = require('../config/db');
const { uploadPhotoToDrive } = require('../utils/driveService');

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

// ENDPOINT 1: Pengecekan Kelayakan Absen (Sebelum Kamera Terbuka)
const checkEligibility = async(req, res) => {
    try {
        // Tambahkan jenis_kehadiran (default: 'hadir') dan alasan
        const { latitude, longitude, accuracy, is_mocked, jenis_kehadiran = 'hadir', alasan } = req.body;

        if (!latitude || !longitude) {
            return res.status(400).json({ success: false, message: 'Koordinat lokasi tidak lengkap.' });
        }
        if (is_mocked === 'true' || is_mocked === true) {
            return res.status(403).json({ success: false, message: 'Terdeteksi penggunaan Fake GPS / Mock Location!' });
        }
        if (accuracy > 50) {
            return res.status(400).json({ success: false, message: 'Akurasi GPS lemah (>50m). Pastikan berada di area terbuka.' });
        }

        // Validasi Wajib Alasan untuk Izin
        if (jenis_kehadiran === 'izin' && (!alasan || alasan.trim() === '')) {
            return res.status(400).json({ success: false, message: 'Kolom alasan wajib diisi untuk pengajuan Izin.' });
        }

        const configQuery = await pool.query('SELECT * FROM school_config LIMIT 1');
        if (configQuery.rows.length === 0) {
            return res.status(500).json({ success: false, message: 'Konfigurasi lokasi sekolah belum diatur.' });
        }
        const school = configQuery.rows[0];

        const distance = calculateDistance(latitude, longitude, school.school_lat, school.school_lng);
        const roundedDistance = Math.round(distance);

        // Bypass Geofencing JIKA Izin atau Sakit (Pengecekan jarak hanya untuk 'hadir')
        if (jenis_kehadiran === 'hadir' && roundedDistance > school.radius_meter) {
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
            data: { distance_meter: roundedDistance, current_time: currentTime }
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

        // 1. Validasi File Foto
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Foto selfie wajib dikirim.' });
        }

        // Validasi Ulang Alasan Izin di tahap akhir
        if (jenis_kehadiran === 'izin' && (!alasan || alasan.trim() === '')) {
            return res.status(400).json({ success: false, message: 'Alasan izin tidak boleh kosong.' });
        }

        // 2. Upload Foto ke Google Drive (Nama file disesuaikan dengan jenis kehadiran)
        const fileName = `${jenis_kehadiran}_Absen_${user.nuptk}_${Date.now()}.jpg`;
        const photoUrl = await uploadPhotoToDrive(req.file.buffer, req.file.mimetype, fileName, tipe_absen);

        // 3. Validasi Geofencing Ulang (Keamanan Ganda)
        let statusAbsen = jenis_kehadiran === 'hadir' ? 'valid' : jenis_kehadiran;
        let finalReason = jenis_kehadiran === 'izin' ? alasan : null;

        const configQuery = await pool.query('SELECT * FROM school_config LIMIT 1');
        const school = configQuery.rows[0];
        const distance = calculateDistance(latitude, longitude, school.school_lat, school.school_lng);

        // Fake GPS tetap ditolak walau izin/sakit. Jarak hanya dicek jika 'hadir'
        if (is_mocked === 'true' || is_mocked === true) {
            statusAbsen = 'rejected';
            finalReason = 'Terdeteksi Fake GPS saat submit';
        } else if (jenis_kehadiran === 'hadir' && Math.round(distance) > school.radius_meter) {
            statusAbsen = 'rejected';
            finalReason = 'Di luar radius sekolah saat submit';
        }

        // 4. Simpan Data ke Database Supabase
        const insertQuery = `
      INSERT INTO attendance (user_id, latitude, longitude, accuracy, is_mocked, photo_url, status, reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
            finalReason
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
      SELECT created_at, status, reason 
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
    checkEligibility,
    submitAttendance,
    getHistory
};