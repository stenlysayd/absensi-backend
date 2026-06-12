const crypto = require('crypto');
const pool = require('../config/db');
const { refreshDriveAccessToken } = require('../utils/driveService');

const secureEqual = (left, right) => {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');

  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const isAuthorizedCronRequest = (req) => {
  const cronSecret = process.env.CRON_SECRET;
  const authorization = req.get('authorization');

  if (!cronSecret || !authorization?.startsWith('Bearer ')) {
    return false;
  }

  return secureEqual(authorization.slice(7), cronSecret);
};

const toggleDatabaseKeepalive = async () => {
  const result = await pool.query(`
    UPDATE public.system_keepalive
    SET value = CASE value WHEN 0 THEN 1 ELSE 0 END
    RETURNING value
  `);

  if (result.rowCount !== 1) {
    throw new Error(
      `Heartbeat database tidak valid: seharusnya 1 baris, ditemukan ${result.rowCount}.`,
    );
  }

  return {
    ok: true,
    value: result.rows[0].value,
  };
};

const serializeFailure = (reason, fallbackCode) => ({
  ok: false,
  code: reason?.code || fallbackCode,
  message: reason?.message || 'Maintenance gagal dijalankan.',
  reauth_required: Boolean(reason?.reauthRequired),
});

const runDailyMaintenance = async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({
      success: false,
      code: 'CRON_SECRET_NOT_CONFIGURED',
      message: 'CRON_SECRET belum diatur di environment backend.',
    });
  }

  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED_CRON',
      message: 'Cron request tidak terotorisasi.',
    });
  }

  const startedAt = new Date();
  const [databaseResult, driveResult] = await Promise.allSettled([
    toggleDatabaseKeepalive(),
    refreshDriveAccessToken(),
  ]);

  const database =
    databaseResult.status === 'fulfilled'
      ? databaseResult.value
      : serializeFailure(databaseResult.reason, 'DATABASE_KEEPALIVE_FAILED');
  const drive =
    driveResult.status === 'fulfilled'
      ? { ok: true, ...driveResult.value }
      : serializeFailure(driveResult.reason, 'DRIVE_CONNECTION_FAILED');
  const success = database.ok && drive.ok;

  console.log('[daily-maintenance]', {
    success,
    database_value: database.value,
    drive_connected: Boolean(drive.connected),
    drive_code: drive.code || null,
    duration_ms: Date.now() - startedAt.getTime(),
  });

  return res.status(success ? 200 : 503).json({
    success,
    executed_at: startedAt.toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
    database,
    drive,
  });
};

module.exports = {
  runDailyMaintenance,
  toggleDatabaseKeepalive,
};
