// config/db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false // Tambahkan baris ini jika Supabase menolak koneksi
  }
});

pool.on('connect', () => {
  console.log('✅ Terhubung ke database PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ Terjadi kesalahan pada database:', err);
});

module.exports = pool;