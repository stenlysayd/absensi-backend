// utils/driveService.js
const { google } = require('googleapis');
const stream = require('stream');
const { notifyDriveHealth } = require('./emailAlertService');
require('dotenv').config();

const GOOGLE_API_TIMEOUT_MS = Number(process.env.GOOGLE_API_TIMEOUT_MS || 15000);

google.options({
  timeout: GOOGLE_API_TIMEOUT_MS,
  retry: false,
});

// Konfigurasi OAuth 2.0 Client
const oauth2Client = new google.auth.OAuth2(
  process.env.DRIVE_CLIENT_ID,
  process.env.DRIVE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground' // Redirect URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.DRIVE_REFRESH_TOKEN,
});

const drive = google.drive({ version: 'v3', auth: oauth2Client });

const assertDriveConfigured = () => {
  if (!process.env.DRIVE_CLIENT_ID ||
      !process.env.DRIVE_CLIENT_SECRET ||
      !process.env.DRIVE_REFRESH_TOKEN) {
    throw new Error('Konfigurasi Google Drive belum lengkap di environment server.');
  }
};

const normalizeDriveError = (error) => {
  if (
    error?.code === 'DRIVE_REAUTH_REQUIRED' ||
    error?.code === 'DRIVE_CONNECTION_FAILED'
  ) {
    return error;
  }

  const responseData = error?.response?.data;
  const providerCode = responseData?.error || error?.code;
  const providerDescription =
    responseData?.error_description ||
    responseData?.error?.message ||
    error?.message ||
    'Google Drive tidak dapat dihubungi.';
  const searchableError = `${providerCode || ''} ${providerDescription}`.toLowerCase();
  const reauthRequired =
    searchableError.includes('invalid_grant') ||
    searchableError.includes('invalid_client') ||
    searchableError.includes('unauthorized_client');

  const normalizedError = new Error(
    reauthRequired
      ? 'Refresh token Google Drive tidak valid atau telah kedaluwarsa. Lakukan OAuth ulang dan pastikan OAuth consent screen berstatus Production.'
      : providerDescription,
  );

  normalizedError.code = reauthRequired
    ? 'DRIVE_REAUTH_REQUIRED'
    : 'DRIVE_CONNECTION_FAILED';
  normalizedError.reauthRequired = reauthRequired;
  normalizedError.providerCode = providerCode || null;
  normalizedError.status = error?.response?.status || error?.status || 503;

  return normalizedError;
};

const reportDriveFailure = async (error) => {
  try {
    await notifyDriveHealth({
      ok: false,
      connected: false,
      code: error.code || 'DRIVE_CONNECTION_FAILED',
      message: error.message,
      reauth_required: Boolean(error.reauthRequired),
    });
  } catch (alertError) {
    console.error('Gagal mengirim alert Google Drive:', alertError.message);
  }
};

const requestFreshAccessToken = async () => {
  assertDriveConfigured();

  try {
    const requestBody = new URLSearchParams({
      client_id: process.env.DRIVE_CLIENT_ID,
      client_secret: process.env.DRIVE_CLIENT_SECRET,
      refresh_token: process.env.DRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GOOGLE_API_TIMEOUT_MS);
    let response;

    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: requestBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const responseData = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerError = new Error(
        responseData.error_description || responseData.error || 'Gagal memperbarui access token Google.',
      );
      providerError.response = {
        status: response.status,
        data: responseData,
      };
      throw providerError;
    }

    if (!responseData.access_token) {
      throw new Error('Google tidak mengembalikan access token.');
    }

    const expiresAt = Date.now() + Number(responseData.expires_in || 3600) * 1000;
    oauth2Client.setCredentials({
      refresh_token: process.env.DRIVE_REFRESH_TOKEN,
      access_token: responseData.access_token,
      token_type: responseData.token_type || 'Bearer',
      expiry_date: expiresAt,
    });

    return {
      expires_at: expiresAt,
    };
  } catch (error) {
    throw normalizeDriveError(error);
  }
};

const refreshDriveAccessToken = async () => {
  try {
    const tokenStatus = await requestFreshAccessToken();
    const response = await drive.about.get({
      fields: 'user(displayName)',
    });

    return {
      connected: true,
      access_token_refreshed: true,
      expires_at: tokenStatus.expires_at,
      account_name: response.data.user?.displayName || null,
    };
  } catch (error) {
    const normalizedError = normalizeDriveError(error);
    await reportDriveFailure(normalizedError);
    throw normalizedError;
  }
};

// Fungsi Helper untuk mencari atau membuat folder
const getOrCreateFolder = async (folderName, parentFolderId) => {
  try {
    const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentFolderId}' in parents and trashed=false`;
    const response = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive',
    });

    if (response.data.files.length > 0) {
      return response.data.files[0].id;
    } else {
      const fileMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId],
      };
      const folder = await drive.files.create({
        resource: fileMetadata,
        fields: 'id',
      });
      return folder.data.id;
    }
  } catch (error) {
    console.error(`Error saat mencari/membuat folder ${folderName}:`, error.message);
    throw error;
  }
};

// Fungsi Utama Upload Foto
const uploadPhotoToDrive = async (fileBuffer, mimeType, fileName, tipeAbsen) => {
  try {
    assertDriveConfigured();
    await requestFreshAccessToken();
    const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) {
      throw new Error('DRIVE_ROOT_FOLDER_ID belum diatur.');
    }
    
    // Setup Penamaan Folder
    const now = new Date();
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    
    const monthName = `${months[now.getMonth()]}_${now.getFullYear()}`;
    const weekNumber = Math.ceil(now.getDate() / 7);
    const weekName = `Minggu_${weekNumber}`;
    const dayName = `${days[now.getDay()]}_${now.getDate()}`;
    const folderType = tipeAbsen === 'pulang' || tipeAbsen === 'keluar'
      ? 'absen_pulang'
      : tipeAbsen === 'profile'
        ? 'foto_profil'
        : 'absen_masuk';

    // Eksekusi Pembuatan/Pencarian Folder
    const monthFolderId = await getOrCreateFolder(monthName, rootFolderId);
    const weekFolderId = await getOrCreateFolder(weekName, monthFolderId);
    const dayFolderId = await getOrCreateFolder(dayName, weekFolderId);
    const targetFolderId = await getOrCreateFolder(folderType, dayFolderId);

    // Konversi Buffer ke Stream
    const bufferStream = new stream.PassThrough();
    bufferStream.end(fileBuffer);

    // Upload
    const media = {
      mimeType: mimeType,
      body: bufferStream,
    };
    const fileMetadata = {
      name: fileName,
      parents: [targetFolderId],
    };

    const uploadedFile = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink',
    });

    const fileId = uploadedFile.data.id;

    // Set Permission Publik
    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    if (tipeAbsen === 'profile') {
      return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;
    }

    return uploadedFile.data.webViewLink;

  } catch (error) {
    const normalizedError = normalizeDriveError(error);
    console.error(
      'Gagal mengupload ke Google Drive (OAuth2):',
      normalizedError.message,
    );
    await reportDriveFailure(normalizedError);
    throw normalizedError;
  }
};

const testDriveConnection = async () => {
  return refreshDriveAccessToken();
};

const listFilesInFolder = async (folderId = process.env.DRIVE_ROOT_FOLDER_ID) => {
  try {
    assertDriveConfigured();
    await requestFreshAccessToken();
    if (!folderId) {
      throw new Error('Folder Google Drive belum diatur.');
    }

    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,webViewLink,createdTime)',
      orderBy: 'createdTime desc',
      spaces: 'drive',
    });

    return response.data.files || [];
  } catch (error) {
    const normalizedError = normalizeDriveError(error);
    await reportDriveFailure(normalizedError);
    throw normalizedError;
  }
};

module.exports = {
  uploadPhotoToDrive,
  testDriveConnection,
  refreshDriveAccessToken,
  listFilesInFolder,
};
