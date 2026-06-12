const nodemailer = require('nodemailer');
const pool = require('../config/db');

const DRIVE_ALERT_KEY = 'google_drive_oauth';
const DEFAULT_RECIPIENTS = [
  'stenlysayd@gmail.com',
  'eryl2004@gmail.com',
];

const parseRecipients = () => {
  const configured = process.env.ALERT_EMAIL_RECIPIENTS
    ?.split(',')
    .map((email) => email.trim())
    .filter(Boolean);

  return configured?.length ? configured : DEFAULT_RECIPIENTS;
};

const smtpConfigured = () =>
  Boolean(
    process.env.SMTP_USER &&
      process.env.SMTP_PASS,
  );

const createTransporter = () =>
  nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

const getAlertState = async () => {
  const result = await pool.query(
    `
      SELECT status, last_notified_at, details
      FROM public.system_alert_state
      WHERE alert_key = $1
      LIMIT 1
    `,
    [DRIVE_ALERT_KEY],
  );

  return result.rows[0] || null;
};

const saveAlertState = async ({
  status,
  lastNotifiedAt = null,
  details = {},
}) => {
  await pool.query(
    `
      INSERT INTO public.system_alert_state (
        alert_key,
        status,
        last_notified_at,
        details,
        updated_at
      )
      VALUES ($1, $2, $3, $4::jsonb, NOW())
      ON CONFLICT (alert_key)
      DO UPDATE SET
        status = EXCLUDED.status,
        last_notified_at = EXCLUDED.last_notified_at,
        details = EXCLUDED.details,
        updated_at = NOW()
    `,
    [
      DRIVE_ALERT_KEY,
      status,
      lastNotifiedAt,
      JSON.stringify(details),
    ],
  );
};

const buildFailureMessage = (drive) => {
  const reauthText = drive.reauth_required
    ? 'Refresh token perlu dibuat ulang melalui OAuth Google.'
    : 'Periksa koneksi server dan konfigurasi Google Drive.';
  const checkedAt = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Makassar',
  });

  return {
    subject: '[Absensi Familia] Google Drive token bermasalah',
    text: [
      'Sistem absensi gagal mengakses Google Drive.',
      `Waktu pemeriksaan: ${checkedAt} WITA`,
      `Kode: ${drive.code || 'DRIVE_CONNECTION_FAILED'}`,
      `Pesan: ${drive.message || 'Google Drive tidak dapat dihubungi.'}`,
      reauthText,
    ].join('\n'),
    html: `
      <h2>Google Drive tidak dapat diakses</h2>
      <p>Sistem absensi gagal memperbarui atau menggunakan token Google Drive.</p>
      <table>
        <tr><td><strong>Waktu</strong></td><td>${checkedAt} WITA</td></tr>
        <tr><td><strong>Kode</strong></td><td>${drive.code || 'DRIVE_CONNECTION_FAILED'}</td></tr>
        <tr><td><strong>Pesan</strong></td><td>${drive.message || 'Google Drive tidak dapat dihubungi.'}</td></tr>
      </table>
      <p><strong>Tindakan:</strong> ${reauthText}</p>
    `,
  };
};

const buildRecoveryMessage = () => {
  const checkedAt = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Makassar',
  });

  return {
    subject: '[Absensi Familia] Google Drive kembali normal',
    text: `Koneksi dan pembaruan access token Google Drive kembali berhasil pada ${checkedAt} WITA.`,
    html: `
      <h2>Google Drive kembali normal</h2>
      <p>Koneksi dan pembaruan access token berhasil pada ${checkedAt} WITA.</p>
    `,
  };
};

const sendAlertEmail = async (message) => {
  const recipients = parseRecipients();
  const transporter = createTransporter();

  await transporter.sendMail({
    from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER,
    to: recipients.join(', '),
    subject: message.subject,
    text: message.text,
    html: message.html,
  });

  return recipients;
};

const notifyDriveHealth = async (drive) => {
  const state = await getAlertState();
  const healthy = drive.ok === true && drive.connected === true;
  const now = new Date();
  const cooldownHours = Math.max(
    1,
    Number(process.env.ALERT_COOLDOWN_HOURS || 24),
  );
  const lastNotifiedAt = state?.last_notified_at
    ? new Date(state.last_notified_at)
    : null;
  const cooldownElapsed =
    !lastNotifiedAt ||
    now.getTime() - lastNotifiedAt.getTime() >= cooldownHours * 60 * 60 * 1000;
  const details = {
    code: drive.code || null,
    message: drive.message || null,
    reauth_required: Boolean(drive.reauth_required),
    checked_at: now.toISOString(),
  };

  if (healthy) {
    const recovered = state?.status === 'failed';
    if (!recovered) {
      await saveAlertState({
        status: 'healthy',
        lastNotifiedAt: state?.last_notified_at || null,
        details,
      });
      return { configured: smtpConfigured(), sent: false, status: 'healthy' };
    }

    if (!smtpConfigured()) {
      await saveAlertState({ status: 'healthy', details });
      return {
        configured: false,
        sent: false,
        status: 'healthy',
        reason: 'SMTP_NOT_CONFIGURED',
      };
    }

    const recipients = await sendAlertEmail(buildRecoveryMessage());
    await saveAlertState({
      status: 'healthy',
      lastNotifiedAt: now,
      details,
    });
    return { configured: true, sent: true, status: 'healthy', recipients };
  }

  const shouldNotify = state?.status !== 'failed' || cooldownElapsed;
  if (!shouldNotify) {
    await saveAlertState({
      status: 'failed',
      lastNotifiedAt: state.last_notified_at,
      details,
    });
    return { configured: smtpConfigured(), sent: false, status: 'failed' };
  }

  if (!smtpConfigured()) {
    await saveAlertState({
      status: 'failed',
      lastNotifiedAt: state?.last_notified_at || null,
      details,
    });
    return {
      configured: false,
      sent: false,
      status: 'failed',
      reason: 'SMTP_NOT_CONFIGURED',
    };
  }

  const recipients = await sendAlertEmail(buildFailureMessage(drive));
  await saveAlertState({
    status: 'failed',
    lastNotifiedAt: now,
    details,
  });
  return { configured: true, sent: true, status: 'failed', recipients };
};

module.exports = {
  notifyDriveHealth,
};
