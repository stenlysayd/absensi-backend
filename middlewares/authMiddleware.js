// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Akses ditolak. Token tidak ditemukan.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT id, name, nuptk, email, role, profile_photo_url, token_version FROM users WHERE id = $1',
      [decoded.id],
    );

    if (rows.length === 0) {
      return res.status(403).json({ success: false, message: 'Sesi tidak valid. Silakan login kembali.' });
    }

    const user = rows[0];
    const tokenVersion = decoded.token_version ?? 0;
    const currentVersion = user.token_version ?? 0;

    if (tokenVersion !== currentVersion || decoded.role !== user.role) {
      return res.status(403).json({
        success: false,
        code: 'SESSION_REVOKED',
        message: 'Sesi berubah. Silakan login kembali.',
      });
    }

    req.user = {
      id: user.id,
      name: user.name,
      nuptk: user.nuptk,
      email: user.email,
      role: user.role,
      profile_photo_url: user.profile_photo_url,
      token_version: currentVersion,
    };
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Sesi tidak valid atau telah kedaluwarsa.' });
  }
};

// Middleware tambahan khusus Admin
const verifyAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    return res.status(403).json({ success: false, message: 'Akses ditolak. Hanya Admin yang dapat mengakses rute ini.' });
  }
};

module.exports = { verifyToken, verifyAdmin };
