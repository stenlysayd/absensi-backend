// seed.js
const pool = require('./config/db');
const bcrypt = require('bcryptjs');

const seedDatabase = async () => {
  try {
    console.log('⏳ Memulai proses seeding database...');

    // 1. Enkripsi password 'rahasia123'
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('rahasia123', salt);

    // 2. Insert Data Guru
    // Kita kosongkan device_id agar bisa dites fitur 'binding' saat login pertama kali
    const userQuery = `
      INSERT INTO users (name, nuptk, email, password_hash, role)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (nuptk) DO NOTHING
      RETURNING *;
    `;
    const userValues = [
      'Pak Budi Santoso', 
      '198203152005011002', // Contoh NUPTK
      'budi@sekolah.com', 
      hashedPassword, 
      'guru'
    ];
    
    const userResult = await pool.query(userQuery, userValues);
    if (userResult.rows.length > 0) {
      console.log('✅ Berhasil menambahkan guru:', userResult.rows[0].name);
    } else {
      console.log('⚠️ Guru dengan NUPTK tersebut sudah ada di database.');
    }

    // 3. Insert Data Konfigurasi Sekolah
    // Menggunakan estimasi koordinat area Sikumana, Kupang
    const schoolQuery = `
      INSERT INTO school_config (school_name, school_lat, school_lng, radius_meter, start_time, end_time)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const schoolValues = [
      'SMA Swasta Sta. Familia Sikumana', 
      -10.180430,  // Latitude
      123.605320,  // Longitude
      100,         // Radius 100 meter
      '06:00:00',  // Jam masuk
      '15:00:00'   // Jam pulang
    ];

    // Bersihkan tabel config lama (opsional, agar tidak dobel jika di-run berkali-kali)
    await pool.query('TRUNCATE TABLE school_config RESTART IDENTITY');
    
    const schoolResult = await pool.query(schoolQuery, schoolValues);
    console.log('✅ Berhasil mengatur lokasi:', schoolResult.rows[0].school_name);

    console.log('🎉 Seeding selesai!');
    
  } catch (error) {
    console.error('❌ Terjadi kesalahan saat seeding:', error);
  } finally {
    // Wajib tutup koneksi agar terminal tidak hang/loading terus
    pool.end(); 
  }
};

seedDatabase();