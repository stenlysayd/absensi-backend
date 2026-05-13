// makeAdmin.js
const bcrypt = require('bcryptjs'); // Ganti jadi 'bcryptjs' kalau kamu pakainya itu
const pool = require('./config/db');

const createAdmin = async () => {
  try {
    // Generate hash asli untuk 'rahasia123'
    const passwordHash = await bcrypt.hash('rahasia123', 10);
    
    await pool.query(`
      INSERT INTO users (name, nuptk, email, password_hash, role)
      VALUES ('Admin Pusat', '0000000000', 'admin@sekolah.com', $1, 'admin')
    `, [passwordHash]);

    console.log("✅ Akun Admin berhasil dibuat dengan password yang valid!");
    process.exit();
  } catch (error) {
    console.error("Gagal:", error);
    process.exit(1);
  }
};

createAdmin();