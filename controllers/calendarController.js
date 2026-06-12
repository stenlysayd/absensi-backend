const pool = require('../config/db');
const {
  finalizeAttendanceDate,
  listCalendarDays,
} = require('../utils/attendanceDailyService');
const { getMakassarNow } = require('../utils/attendanceSchedule');

const validCategories = ['national', 'school', 'semester', 'special'];
const validEventTypes = ['holiday', 'workday'];
const validSlotStatuses = [
  'pending',
  'recorded',
  'missed',
  'not_required',
  'alpha',
  'holiday',
];
const validDailyStatuses = [
  'pending',
  'hadir',
  'incomplete',
  'izin',
  'sakit',
  'alpha',
  'holiday',
];

const dateOnly = (value) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

const refinalizeRange = async (startDate, endDate) => {
  const today = getMakassarNow().date;
  const boundedEnd = endDate > today ? today : endDate;
  if (startDate > boundedEnd) return;

  const cursor = new Date(`${startDate}T12:00:00+08:00`);
  const last = new Date(`${boundedEnd}T12:00:00+08:00`);
  var processed = 0;

  while (cursor <= last && processed < 400) {
    const date = cursor.toLocaleDateString('en-CA', {
      timeZone: 'Asia/Makassar',
    });
    await finalizeAttendanceDate(date);
    cursor.setDate(cursor.getDate() + 1);
    processed += 1;
  }
};

const monthBounds = (value) => {
  const raw = String(value || getMakassarNow().date).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(raw)) {
    throw new Error('Bulan harus menggunakan format YYYY-MM.');
  }
  const from = `${raw}-01`;
  const date = new Date(`${from}T00:00:00+08:00`);
  date.setMonth(date.getMonth() + 1);
  date.setDate(0);
  const to = date.toLocaleDateString('en-CA', {
    timeZone: 'Asia/Makassar',
  });
  return { month: from, from, to };
};

const normalizeHolidayPayload = (body) => {
  const name = String(body.name || '').trim();
  const startDate = String(body.start_date || '').slice(0, 10);
  const endDate = String(body.end_date || startDate).slice(0, 10);
  const category = String(body.category || 'school').toLowerCase();
  const eventType = String(body.event_type || 'holiday').toLowerCase();
  const notes = String(body.notes || '').trim() || null;

  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('Nama, tanggal mulai, dan tanggal selesai wajib diisi.');
  }
  if (endDate < startDate) {
    throw new Error('Tanggal selesai tidak boleh sebelum tanggal mulai.');
  }
  if (!validCategories.includes(category) ||
      !validEventTypes.includes(eventType)) {
    throw new Error('Kategori atau tipe kalender tidak valid.');
  }
  return { name, startDate, endDate, category, eventType, notes };
};

const getCalendarOverview = async (req, res) => {
  try {
    const { month, from, to } = monthBounds(req.query.month);
    const [events, review, days] = await Promise.all([
      pool.query(
        `
          SELECT id, name, start_date, end_date, category, event_type, notes
          FROM holiday_calendar
          WHERE start_date <= $2::date AND end_date >= $1::date
          ORDER BY start_date, name
        `,
        [from, to],
      ),
      pool.query(
        `
          SELECT confirmed_at
          FROM admin_calendar_reviews
          WHERE admin_user_id = $1 AND review_month = $2::date
          LIMIT 1
        `,
        [req.user.id, month],
      ),
      listCalendarDays({ from, to }),
    ]);

    res.json({
      success: true,
      data: {
        month,
        from,
        to,
        needs_review: review.rows.length === 0,
        confirmed_at: review.rows[0]?.confirmed_at || null,
        events: events.rows,
        days,
      },
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

const createHoliday = async (req, res) => {
  try {
    const payload = normalizeHolidayPayload(req.body);
    const { rows } = await pool.query(
      `
        INSERT INTO holiday_calendar (
          name, start_date, end_date, category, event_type, notes, created_by
        )
        VALUES ($1, $2::date, $3::date, $4, $5, $6, $7)
        RETURNING *
      `,
      [
        payload.name,
        payload.startDate,
        payload.endDate,
        payload.category,
        payload.eventType,
        payload.notes,
        req.user.id,
      ],
    );
    await refinalizeRange(payload.startDate, payload.endDate);
    res.status(201).json({
      success: true,
      message: 'Kalender berhasil ditambahkan.',
      data: rows[0],
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

const updateHoliday = async (req, res) => {
  try {
    const payload = normalizeHolidayPayload(req.body);
    const previous = await pool.query(
      'SELECT start_date, end_date FROM holiday_calendar WHERE id = $1',
      [req.params.id],
    );
    const { rows } = await pool.query(
      `
        UPDATE holiday_calendar
        SET name = $1,
            start_date = $2::date,
            end_date = $3::date,
            category = $4,
            event_type = $5,
            notes = $6,
            updated_at = now()
        WHERE id = $7
        RETURNING *
      `,
      [
        payload.name,
        payload.startDate,
        payload.endDate,
        payload.category,
        payload.eventType,
        payload.notes,
        req.params.id,
      ],
    );
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Kalender tidak ditemukan.',
      });
    }
    if (previous.rows[0]) {
      await refinalizeRange(
        dateOnly(previous.rows[0].start_date),
        dateOnly(previous.rows[0].end_date),
      );
    }
    await refinalizeRange(payload.startDate, payload.endDate);
    res.json({
      success: true,
      message: 'Kalender berhasil diperbarui.',
      data: rows[0],
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

const deleteHoliday = async (req, res) => {
  try {
    const result = await pool.query(
      `
        DELETE FROM holiday_calendar
        WHERE id = $1
        RETURNING id, start_date, end_date
      `,
      [req.params.id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Kalender tidak ditemukan.',
      });
    }
    const deleted = result.rows[0];
    await refinalizeRange(
      dateOnly(deleted.start_date),
      dateOnly(deleted.end_date),
    );
    res.json({ success: true, message: 'Kalender berhasil dihapus.' });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Kalender gagal dihapus.',
    });
  }
};

const confirmCalendarReview = async (req, res) => {
  try {
    const { month } = monthBounds(req.body.month);
    await pool.query(
      `
        INSERT INTO admin_calendar_reviews (
          admin_user_id, review_month, confirmed_at
        )
        VALUES ($1, $2::date, now())
        ON CONFLICT (admin_user_id, review_month)
        DO UPDATE SET confirmed_at = now()
      `,
      [req.user.id, month],
    );
    res.json({
      success: true,
      message: 'Kalender bulan ini sudah ditandai diperiksa.',
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

const correctDailyAttendance = async (req, res) => {
  const client = await pool.connect();
  try {
    const masukStatus = String(req.body.masuk_status || '').toLowerCase();
    const pulangStatus = String(req.body.pulang_status || '').toLowerCase();
    const dailyStatus = String(req.body.daily_status || '').toLowerCase();
    const reason = String(req.body.reason || '').trim() || null;
    const correctionReason = String(req.body.correction_reason || '').trim();
    const masukAt = req.body.masuk_at || null;
    const pulangAt = req.body.pulang_at || null;

    if (!validSlotStatuses.includes(masukStatus) ||
        !validSlotStatuses.includes(pulangStatus) ||
        !validDailyStatuses.includes(dailyStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Status koreksi tidak valid.',
      });
    }
    if (!correctionReason) {
      return res.status(400).json({
        success: false,
        message: 'Alasan koreksi wajib diisi.',
      });
    }
    if (['izin', 'sakit'].includes(dailyStatus) && !reason) {
      return res.status(400).json({
        success: false,
        message: 'Keterangan wajib diisi untuk Izin atau Sakit.',
      });
    }

    await client.query('BEGIN');
    const current = await client.query(
      'SELECT * FROM attendance_daily WHERE id = $1 FOR UPDATE',
      [req.params.id],
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        message: 'Rekap harian tidak ditemukan.',
      });
    }

    const updated = await client.query(
      `
        UPDATE attendance_daily
        SET masuk_status = $1,
            pulang_status = $2,
            daily_status = $3,
            masuk_at = $4::timestamptz,
            pulang_at = $5::timestamptz,
            reason = $6,
            corrected_by = $7,
            correction_reason = $8,
            finalized_at = COALESCE(finalized_at, now()),
            updated_at = now()
        WHERE id = $9
        RETURNING *
      `,
      [
        masukStatus,
        pulangStatus,
        dailyStatus,
        masukAt,
        pulangAt,
        reason,
        req.user.id,
        correctionReason,
        req.params.id,
      ],
    );

    await client.query(
      `
        INSERT INTO attendance_audit_logs (
          attendance_daily_id,
          actor_user_id,
          old_data,
          new_data,
          reason
        )
        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
      `,
      [
        req.params.id,
        req.user.id,
        JSON.stringify(current.rows[0]),
        JSON.stringify(updated.rows[0]),
        correctionReason,
      ],
    );
    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Rekap absensi berhasil dikoreksi.',
      data: updated.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Koreksi absensi gagal:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal menyimpan koreksi absensi.',
    });
  } finally {
    client.release();
  }
};

const finalizeDateManually = async (req, res) => {
  try {
    const date = String(req.body.date || getMakassarNow().date).slice(0, 10);
    const result = await finalizeAttendanceDate(date);
    res.json({
      success: true,
      message: `Finalisasi ${date} selesai.`,
      data: result,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getCalendarOverview,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  confirmCalendarReview,
  correctDailyAttendance,
  finalizeDateManually,
};
