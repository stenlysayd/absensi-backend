const DEFAULT_SCHEDULE = {
  masuk_start_time: '06:00',
  masuk_end_time: '11:59',
  pulang_start_time: '12:00',
  pulang_end_time: '17:59',
  allowed_weekdays: [1, 2, 3, 4],
};

const weekdayMap = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const normalizeTime = (value, fallback) => {
  const raw = String(value || fallback || '').trim();
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) return fallback;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
};

const timeToMinutes = (value) => {
  const [hour, minute] = normalizeTime(value, '00:00').split(':').map(Number);
  return hour * 60 + minute;
};

const getMakassarNow = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Makassar',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = weekdayMap[get('weekday')] || 1;
  const hour = Number(get('hour') || 0);
  const minute = Number(get('minute') || 0);
  const second = Number(get('second') || 0);
  const y = get('year');
  const m = get('month');
  const d = get('day');

  return {
    weekday,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`,
    minutes: hour * 60 + minute,
    date: `${y}-${m}-${d}`,
  };
};

const normalizeWeekdays = (value) => {
  if (Array.isArray(value)) {
    const days = value.map((v) => Number(v)).filter((v) => v >= 1 && v <= 7);
    return [...new Set(days)].sort((a, b) => a - b);
  }
  if (typeof value === 'string') {
    return normalizeWeekdays(value.split(','));
  }
  return DEFAULT_SCHEDULE.allowed_weekdays;
};

const getAttendanceSchedule = async (pool) => {
  const { rows } = await pool.query(
    `
    SELECT masuk_start_time,
           masuk_end_time,
           pulang_start_time,
           pulang_end_time,
           allowed_weekdays
    FROM school_config
    ORDER BY id ASC
    LIMIT 1
    `,
  );

  const row = rows[0] || {};
  return {
    masuk_start_time: normalizeTime(row.masuk_start_time, DEFAULT_SCHEDULE.masuk_start_time),
    masuk_end_time: normalizeTime(row.masuk_end_time, DEFAULT_SCHEDULE.masuk_end_time),
    pulang_start_time: normalizeTime(row.pulang_start_time, DEFAULT_SCHEDULE.pulang_start_time),
    pulang_end_time: normalizeTime(row.pulang_end_time, DEFAULT_SCHEDULE.pulang_end_time),
    allowed_weekdays: normalizeWeekdays(row.allowed_weekdays),
  };
};

const buildAttendanceWindow = (schedule, tipeAbsen, date = new Date()) => {
  const now = getMakassarNow(date);
  const type = tipeAbsen === 'pulang' ? 'pulang' : 'masuk';
  const start = timeToMinutes(type === 'pulang' ? schedule.pulang_start_time : schedule.masuk_start_time);
  const end = timeToMinutes(type === 'pulang' ? schedule.pulang_end_time : schedule.masuk_end_time);
  const allowedDay = schedule.allowed_weekdays.includes(now.weekday);
  const inTime = now.minutes >= start && now.minutes <= end;

  return {
    type,
    now,
    start_minutes: start,
    end_minutes: end,
    minutes_until_close: end - now.minutes,
    allowed_day: allowedDay,
    in_time: inTime,
    open: allowedDay && inTime,
  };
};

const validateAttendanceWindow = (schedule, tipeAbsen) => {
  const window = buildAttendanceWindow(schedule, tipeAbsen);
  if (!window.allowed_day) {
    return {
      ok: false,
      window,
      message: 'Absensi hanya dibuka Senin sampai Kamis.',
    };
  }
  if (!window.in_time) {
    const start = tipeAbsen === 'pulang' ? schedule.pulang_start_time : schedule.masuk_start_time;
    const end = tipeAbsen === 'pulang' ? schedule.pulang_end_time : schedule.masuk_end_time;
    return {
      ok: false,
      window,
      message: `Absen ${tipeAbsen} hanya tersedia pukul ${start}-${end} WITA.`,
    };
  }
  return { ok: true, window, message: 'Jadwal absensi aktif.' };
};

module.exports = {
  DEFAULT_SCHEDULE,
  normalizeTime,
  normalizeWeekdays,
  getAttendanceSchedule,
  buildAttendanceWindow,
  validateAttendanceWindow,
};
