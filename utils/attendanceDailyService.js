const pool = require('../config/db');
const {
  getAttendanceSchedule,
  getMakassarNow,
} = require('./attendanceSchedule');

const acceptedAttendanceStatuses = ['valid', 'hadir'];
const absenceStatuses = ['izin', 'sakit'];

const getHolidayForDate = async (date, client = pool) => {
  const { rows } = await client.query(
    `
      SELECT id, name, start_date, end_date, category, event_type, notes
      FROM holiday_calendar
      WHERE $1::date BETWEEN start_date AND end_date
      ORDER BY CASE event_type WHEN 'workday' THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
    `,
    [date],
  );
  return rows[0] || null;
};

const getDayContext = async (date, client = pool) => {
  const schedule = await getAttendanceSchedule(client);
  const holiday = await getHolidayForDate(date, client);
  const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay() || 7;
  const scheduledWeekday = schedule.allowed_weekdays.includes(weekday);
  const workingDay = holiday
    ? holiday.event_type === 'workday'
    : scheduledWeekday;

  return {
    date,
    weekday,
    schedule,
    holiday,
    is_working_day: workingDay,
    is_holiday: Boolean(holiday && holiday.event_type === 'holiday'),
  };
};

const syncDailyFromAttendance = async ({
  client,
  userId,
  attendanceDate,
  attendance,
  presenceStatus,
  type,
  reason,
}) => {
  const isAbsence = absenceStatuses.includes(presenceStatus);
  await client.query(
    `
      INSERT INTO attendance_daily (
        user_id,
        attendance_date,
        masuk_attendance_id,
        pulang_attendance_id,
        masuk_at,
        pulang_at,
        masuk_status,
        pulang_status,
        daily_status,
        reason,
        updated_at
      )
      VALUES (
        $1,
        $2::date,
        CASE WHEN $8 = 'masuk' THEN $3::uuid ELSE NULL END,
        CASE WHEN $8 = 'pulang' THEN $3::uuid ELSE NULL END,
        CASE WHEN $8 = 'masuk' THEN $4::timestamptz ELSE NULL END,
        CASE WHEN $8 = 'pulang' THEN $4::timestamptz ELSE NULL END,
        CASE WHEN $5 THEN 'not_required' WHEN $8 = 'masuk' THEN 'recorded' ELSE 'pending' END,
        CASE WHEN $5 THEN 'not_required' WHEN $8 = 'pulang' THEN 'recorded' ELSE 'pending' END,
        CASE WHEN $5 THEN $6 ELSE 'pending' END,
        $7,
        now()
      )
      ON CONFLICT (user_id, attendance_date)
      DO UPDATE SET
        masuk_attendance_id = COALESCE(EXCLUDED.masuk_attendance_id, attendance_daily.masuk_attendance_id),
        pulang_attendance_id = COALESCE(EXCLUDED.pulang_attendance_id, attendance_daily.pulang_attendance_id),
        masuk_at = COALESCE(EXCLUDED.masuk_at, attendance_daily.masuk_at),
        pulang_at = COALESCE(EXCLUDED.pulang_at, attendance_daily.pulang_at),
        masuk_status = CASE
          WHEN $5 THEN 'not_required'
          WHEN $8 = 'masuk' THEN 'recorded'
          ELSE attendance_daily.masuk_status
        END,
        pulang_status = CASE
          WHEN $5 THEN 'not_required'
          WHEN $8 = 'pulang' THEN 'recorded'
          ELSE attendance_daily.pulang_status
        END,
        daily_status = CASE
          WHEN $5 THEN $6
          WHEN ($8 = 'masuk' AND attendance_daily.pulang_status = 'recorded')
            OR ($8 = 'pulang' AND attendance_daily.masuk_status = 'recorded') THEN 'hadir'
          ELSE 'pending'
        END,
        reason = CASE WHEN $5 THEN $7 ELSE attendance_daily.reason END,
        updated_at = now()
    `,
    [
      userId,
      attendanceDate,
      attendance.id,
      attendance.created_at,
      isAbsence,
      presenceStatus,
      isAbsence ? reason : null,
      type,
    ],
  );
};

const finalizeAttendanceDate = async (
  date = getMakassarNow().date,
  client = pool,
) => {
  const context = await getDayContext(date, client);
  const result = await client.query(
    `
      INSERT INTO attendance_daily (
        user_id,
        attendance_date,
        masuk_status,
        pulang_status,
        daily_status,
        is_holiday,
        holiday_id,
        finalized_at,
        updated_at
      )
      SELECT
        u.id,
        $1::date,
        CASE
          WHEN $2::boolean THEN 'holiday'
          WHEN d.daily_status IN ('izin', 'sakit') THEN 'not_required'
          WHEN d.masuk_status = 'recorded' THEN 'recorded'
          WHEN d.pulang_status = 'recorded' THEN 'missed'
          ELSE 'alpha'
        END,
        CASE
          WHEN $2::boolean THEN 'holiday'
          WHEN d.daily_status IN ('izin', 'sakit') THEN 'not_required'
          WHEN d.pulang_status = 'recorded' THEN 'recorded'
          WHEN d.masuk_status = 'recorded' THEN 'missed'
          ELSE 'alpha'
        END,
        CASE
          WHEN $2::boolean THEN 'holiday'
          WHEN d.daily_status IN ('izin', 'sakit') THEN d.daily_status
          WHEN d.masuk_status = 'recorded' AND d.pulang_status = 'recorded' THEN 'hadir'
          WHEN d.masuk_status = 'recorded' OR d.pulang_status = 'recorded' THEN 'incomplete'
          ELSE 'alpha'
        END,
        $2::boolean,
        $3::uuid,
        now(),
        now()
      FROM users u
      LEFT JOIN attendance_daily d
        ON d.user_id = u.id
       AND d.attendance_date = $1::date
      WHERE u.role = 'guru'
      ON CONFLICT (user_id, attendance_date)
      DO UPDATE SET
        masuk_status = CASE
          WHEN $2::boolean THEN 'holiday'
          WHEN attendance_daily.daily_status IN ('izin', 'sakit') THEN 'not_required'
          WHEN attendance_daily.masuk_status = 'recorded' THEN 'recorded'
          WHEN attendance_daily.pulang_status = 'recorded' THEN 'missed'
          ELSE 'alpha'
        END,
        pulang_status = CASE
          WHEN $2::boolean THEN 'holiday'
          WHEN attendance_daily.daily_status IN ('izin', 'sakit') THEN 'not_required'
          WHEN attendance_daily.pulang_status = 'recorded' THEN 'recorded'
          WHEN attendance_daily.masuk_status = 'recorded' THEN 'missed'
          ELSE 'alpha'
        END,
        daily_status = CASE
          WHEN $2::boolean THEN 'holiday'
          WHEN attendance_daily.daily_status IN ('izin', 'sakit') THEN attendance_daily.daily_status
          WHEN attendance_daily.masuk_status = 'recorded'
            AND attendance_daily.pulang_status = 'recorded' THEN 'hadir'
          WHEN attendance_daily.masuk_status = 'recorded'
            OR attendance_daily.pulang_status = 'recorded' THEN 'incomplete'
          ELSE 'alpha'
        END,
        is_holiday = $2::boolean,
        holiday_id = $3::uuid,
        finalized_at = now(),
        updated_at = now()
      WHERE attendance_daily.corrected_by IS NULL
      RETURNING id
    `,
    [
      date,
      context.is_holiday || !context.is_working_day,
      context.holiday?.id || null,
    ],
  );

  return {
    ok: true,
    date,
    processed: result.rowCount,
    ...context,
  };
};

const listCalendarDays = async ({
  from,
  to,
  client = pool,
}) => {
  const schedule = await getAttendanceSchedule(client);
  const { rows } = await client.query(
    `
      SELECT
        to_char(g.day, 'YYYY-MM-DD') AS date,
        extract(isodow from g.day)::int AS weekday,
        h.id AS holiday_id,
        h.name AS holiday_name,
        h.category,
        h.event_type,
        h.notes
      FROM generate_series($1::date, $2::date, interval '1 day') AS g(day)
      LEFT JOIN LATERAL (
        SELECT *
        FROM holiday_calendar
        WHERE g.day::date BETWEEN start_date AND end_date
        ORDER BY CASE event_type WHEN 'workday' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 1
      ) h ON true
      ORDER BY g.day
    `,
    [from, to],
  );

  return rows.map((row) => {
    const scheduledWeekday = schedule.allowed_weekdays.includes(row.weekday);
    const workingDay = row.event_type
      ? row.event_type === 'workday'
      : scheduledWeekday;
    return {
      ...row,
      is_working_day: workingDay,
      is_holiday: !workingDay,
    };
  });
};

module.exports = {
  absenceStatuses,
  acceptedAttendanceStatuses,
  getHolidayForDate,
  getDayContext,
  syncDailyFromAttendance,
  finalizeAttendanceDate,
  listCalendarDays,
};
