require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

const clientId = process.env.DRIVE_CLIENT_ID || process.env.CLIENT_ID;
const clientSecret = process.env.DRIVE_CLIENT_SECRET || process.env.CLIENT_SECRET;
const redirectUri =
  process.env.GOOGLE_DRIVE_REDIRECT_URI ||
  process.env.REDIRECT_URI ||
  'https://developers.google.com/oauthplayground';

if (!clientId || !clientSecret) {
  console.error('DRIVE_CLIENT_ID dan DRIVE_CLIENT_SECRET wajib diisi.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  redirectUri,
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  include_granted_scopes: true,
  scope: ['https://www.googleapis.com/auth/drive.file'],
});

console.log('\n=============================================================');
console.log('1. Pastikan OAuth consent screen Google Cloud berstatus Production.');
console.log('2. Buka URL berikut di browser:');
console.log(authUrl);
console.log('=============================================================\n');
console.log('3. Login dengan akun Google yang dipakai menyimpan absensi.');
console.log('4. Berikan izin, lalu salin nilai parameter "code" dari URL.');
console.log('5. Paste kode tersebut di bawah ini.\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Kode OAuth: ', async (code) => {
  try {
    const { tokens } = await oauth2Client.getToken(
      decodeURIComponent(code.trim()),
    );

    if (!tokens.refresh_token) {
      throw new Error(
        'Google tidak mengirim refresh token. Cabut akses aplikasi di akun Google, lalu ulangi dengan prompt consent.',
      );
    }

    console.log('\nBERHASIL. Refresh token baru:');
    console.log('-------------------------------------------------------------');
    console.log(tokens.refresh_token);
    console.log('-------------------------------------------------------------');
    console.log('Simpan sebagai DRIVE_REFRESH_TOKEN di Vercel Production.');
  } catch (error) {
    console.error(`\nGagal mendapatkan token: ${error.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
});
