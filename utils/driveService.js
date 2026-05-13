// utils/driveService.js
const { google } = require('googleapis');
const stream = require('stream');
require('dotenv').config();

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
    const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
    
    // Setup Penamaan Folder
    const now = new Date();
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    
    const monthName = `${months[now.getMonth()]}_${now.getFullYear()}`;
    const weekNumber = Math.ceil(now.getDate() / 7);
    const weekName = `Minggu_${weekNumber}`;
    const dayName = `${days[now.getDay()]}_${now.getDate()}`;
    const folderType = tipeAbsen === 'keluar' ? 'absen_keluar' : 'absen_masuk';

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

    return uploadedFile.data.webViewLink;

  } catch (error) {
    console.error('Gagal mengupload ke Google Drive (OAuth2):', error.message);
    throw error;
  }
};

module.exports = {
  uploadPhotoToDrive
};