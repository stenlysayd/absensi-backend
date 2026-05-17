// controllers/authController.js
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Request Register Akun Baru
const register = async (req, res) => {
  try {
    const { nuptk, name, email, password } = req.body;
    const cleanNuptk = (nuptk || '').toString().trim();
    const cleanName = (name || '').toString().trim();
    const cleanEmail = (email || '').toString().trim().toLowerCase();

    if (!cleanNuptk || !cleanName || !cleanEmail || !password) {
      return res.status(400).json({ success: false, message: 'NUPTK, nama, email, dan password wajib diisi.' });
    }

    // 1. Cek apakah NUPTK sudah terdaftar
    const userCheck = await pool.query(
      'SELECT * FROM users WHERE nuptk = $1 OR LOWER(email) = LOWER($2)',
      [cleanNuptk, cleanEmail],
    );
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'NUPTK atau email sudah terdaftar di sistem.' });
    }

    // 2. Hash Password
    const passwordHash = await bcrypt.hash(password, 10);

    // 3. Simpan ke Database (device_id dibiarkan kosong, nanti akan terisi otomatis saat login pertama kali)
    const insertQuery = `
      INSERT INTO users (nuptk, name, email, password_hash, role)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, nuptk, role;
    `;
    const values = [cleanNuptk, cleanName, cleanEmail, passwordHash, 'guru'];
    
    const newUser = await pool.query(insertQuery, values);

    res.status(201).json({ 
      success: true, 
      message: 'Registrasi berhasil!', 
      data: newUser.rows[0] 
    });

  } catch (error) {
    console.error('Error register:', error);
    res.status(500).json({ success: false, message: 'Gagal melakukan registrasi.' });
  }
};

const login = async (req, res) => {
  try {
    const { nuptk, email, password, device_id } = req.body;
    const credential = (nuptk || email || '').toString().trim();

    // 1. Validasi input kosong
    if (!credential || !password || !device_id) {
      return res.status(400).json({
        success: false,
        message: 'Email/NUPTK, password, dan device_id wajib diisi!'
      });
    }

    // 2. Cari user berdasarkan NUPTK atau email
    const userQuery = await pool.query(
      'SELECT * FROM users WHERE nuptk = $1 OR LOWER(email) = LOWER($1)',
      [credential]
    );
    
    if (userQuery.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Email/NUPTK atau password salah.'
      });
    }

    const user = userQuery.rows[0];

    // 3. Cek Password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Email/NUPTK atau password salah.'
      });
    }

    // 4. Logika Device Binding (Anti-Titip Absen)
    if (!user.device_id) {
      // Jika ini login pertama (device_id di DB masih null), ikat device ini ke akun
      await pool.query('UPDATE users SET device_id = $1 WHERE id = $2', [device_id, user.id]);
      user.device_id = device_id; // Update object user lokal untuk response
    } else if (user.device_id !== device_id) {
      // Jika sudah punya device_id tapi berbeda dengan device yang sedang dipakai login
      return res.status(403).json({
        success: false,
        message: 'Akun ini sudah terikat dengan perangkat lain. Silakan hubungi admin.'
      });
    }

    // 5. Buat JWT Token
    const payload = {
      id: user.id,
      nuptk: user.nuptk,
      role: user.role,
      token_version: user.token_version || 0,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: '7d' // Token berlaku 7 hari
    });

    // 6. Kirim Response Sukses
    res.json({
      success: true,
      message: 'Login berhasil',
      data: {
        token: token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          nuptk: user.nuptk,
          role: user.role,
          device_id: user.device_id,
          profile_photo_url: user.profile_photo_url,
        }
      }
    });

  } catch (err) {
    console.error('Error saat login:', err.message);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

const nodemailer = require('nodemailer');

// 1. Request Lupa Password (Guru)
const requestPasswordReset = async (req, res) => {
  try {
    const { email, nuptk, new_password } = req.body;

    // Cari user
    const userQuery = await pool.query('SELECT * FROM users WHERE email = $1 AND nuptk = $2', [email, nuptk]);
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Data Email dan NUPTK tidak cocok.' });
    }
    const user = userQuery.rows[0];

    // Enkripsi password baru dan masukkan ke dalam JWT Token (Expire 30 menit)
    const newPasswordHash = await bcrypt.hash(new_password, 10);
    const resetToken = jwt.sign(
      { id: user.id, newPasswordHash: newPasswordHash }, 
      process.env.JWT_SECRET, 
      { expiresIn: '30m' }
    );

    const resetLink = `http://localhost:3300/api/auth/confirm-reset?token=${resetToken}`;

    // Setup Pengirim Email (Ganti dengan email/password app Gmail milikmu nanti)
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: 'email.sekolahmu@gmail.com', pass: 'password_app_gmail' } 
    });

    const mailOptions = {
      from: 'Sistem Absensi Sekolah <no-reply@sekolah.com>',
      to: email,
      subject: 'Konfirmasi Perubahan Password',
      html: `
        <h3>Halo ${user.name},</h3>
        <p>Kami menerima permintaan untuk mengubah password akun Anda.</p>
        <p>Jika ini benar Anda, silakan klik tombol di bawah ini untuk mengonfirmasi (berlaku 30 menit):</p>
        <a href="${resetLink}" style="padding: 10px 20px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px;">Konfirmasi Password Baru</a>
        <p>Jika Anda tidak pernah meminta ini, abaikan saja email ini.</p>
      `
    };

    await transporter.sendMail(mailOptions);

    res.json({ success: true, message: 'Link konfirmasi telah dikirim ke email Anda.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Gagal memproses permintaan.' });
  }
};

// 2. Eksekusi Link Konfirmasi dari Email (Berupa Halaman Web HTML)
const confirmPasswordReset = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.send('<h1>Error: Token tidak ditemukan.</h1>');

    // Verifikasi Token (Otomatis menolak jika > 30 menit)
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Update password di database
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [decoded.newPasswordHash, decoded.id]);

    // Berikan respons berupa Halaman Web sukses
    res.send(`
      <div style="text-align: center; margin-top: 50px; font-family: sans-serif;">
        <h1 style="color: green;">✅ Password Berhasil Diubah!</h1>
        <p>Token valid dan password baru Anda telah tersimpan.</p>
        <p>Silakan tutup halaman ini dan kembali ke aplikasi absensi untuk Login.</p>
      </div>
    `);
  } catch (error) {
    res.send(`
      <div style="text-align: center; margin-top: 50px; font-family: sans-serif;">
        <h1 style="color: red;">❌ Link Kedaluwarsa atau Tidak Valid!</h1>
        <p>Pastikan Anda mengklik link terbaru dari email, atau lakukan permintaan ulang di aplikasi.</p>
      </div>
    `);
  }
};

module.exports = {
  login, requestPasswordReset, confirmPasswordReset, register
};
