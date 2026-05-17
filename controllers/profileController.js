const bcrypt = require('bcryptjs');

const pool = require('../config/db');
const { uploadPhotoToDrive } = require('../utils/driveService');

const cleanText = (value) => String(value || '').trim();

const getProfile = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT id, name, nuptk, email, role, profile_photo_url, device_id, created_at
      FROM users
      WHERE id = $1
      `,
      [req.user.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Profil tidak ditemukan.' });
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('Error get profile:', error.message);
    res.status(500).json({ success: false, message: 'Gagal memuat profil.' });
  }
};

const updateProfile = async (req, res) => {
  try {
    const name = cleanText(req.body.name);
    const nuptk = cleanText(req.body.nuptk);
    const email = cleanText(req.body.email).toLowerCase();

    if (!name || !nuptk || !email) {
      return res.status(400).json({
        success: false,
        message: 'Nama, NUPTK, dan email wajib diisi.',
      });
    }

    const duplicate = await pool.query(
      `
      SELECT id
      FROM users
      WHERE id <> $1
        AND (nuptk = $2 OR LOWER(email) = LOWER($3))
      LIMIT 1
      `,
      [req.user.id, nuptk, email],
    );

    if (duplicate.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'NUPTK atau email sudah dipakai akun lain.',
      });
    }

    let photoUrl = req.user.profile_photo_url || null;
    if (req.file) {
      const fileName = `profile_${nuptk}_${Date.now()}.jpg`;
      photoUrl = await uploadPhotoToDrive(
        req.file.buffer,
        req.file.mimetype,
        fileName,
        'profile',
      );
    }

    const { rows } = await pool.query(
      `
      UPDATE users
      SET name = $1,
          nuptk = $2,
          email = $3,
          profile_photo_url = $4,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING id, name, nuptk, email, role, profile_photo_url
      `,
      [name, nuptk, email, photoUrl, req.user.id],
    );

    res.json({
      success: true,
      message: 'Profil berhasil diperbarui.',
      data: rows[0],
    });
  } catch (error) {
    console.error('Error update profile:', error.message);
    res.status(500).json({ success: false, message: 'Gagal memperbarui profil.' });
  }
};

const changePassword = async (req, res) => {
  try {
    const oldPassword = cleanText(req.body.old_password);
    const newPassword = cleanText(req.body.new_password);

    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Password lama dan baru wajib diisi.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter.' });
    }

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Akun tidak ditemukan.' });
    }

    const valid = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Password lama salah.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `
      UPDATE users
      SET password_hash = $1,
          token_version = COALESCE(token_version, 0) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [newHash, req.user.id],
    );

    res.json({
      success: true,
      code: 'PASSWORD_CHANGED',
      message: 'Password berhasil diubah. Silakan login kembali.',
    });
  } catch (error) {
    console.error('Error change password:', error.message);
    res.status(500).json({ success: false, message: 'Gagal mengubah password.' });
  }
};

module.exports = {
  getProfile,
  updateProfile,
  changePassword,
};
