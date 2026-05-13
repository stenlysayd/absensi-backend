require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

// Pastikan nama variabel di bawah ini SAMA PERSIS dengan yang ada di file .env kamu
const CLIENT_ID = process.env.DRIVE_CLIENT_ID || process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET || process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_DRIVE_REDIRECT_URI || process.env.REDIRECT_URI || 'https://developers.google.com/oauthplayground';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // Memaksa Google memberikan Refresh Token baru
    scope: ['https://www.googleapis.com/auth/drive.file'], // Hak akses: Hanya kelola file buatan aplikasi ini
});

console.log('\n=============================================================');
console.log('1. BUKA URL INI DI BROWSER KAMU:');
console.log(authUrl);
console.log('=============================================================\n');
console.log('2. Login dengan akun Gmail yang akan dipakai menyimpan absen.');
console.log('3. Berikan izin (Allow).');
console.log('4. Jika error "Site can\'t be reached", ABAIKAN! Lihat saja URL di atas browser.');
console.log('5. Copy teks yang ada setelah tulisan "code=" dan sebelum tanda "&".\n');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

rl.question('Paste KODE dari URL di sini, lalu tekan Enter: ', async(code) => {
    try {
        // Decode URI component berjaga-jaga kalau ada karakter aneh di URL
        const { tokens } = await oauth2Client.getToken(decodeURIComponent(code));

        console.log('\n✅ BERHASIL! INI REFRESH TOKEN BARU KAMU:\n');
        console.log('👇 COPY TEKS DI BAWAH INI 👇');
        console.log('-------------------------------------------------------------');
        console.log(tokens.refresh_token);
        console.log('-------------------------------------------------------------\n');
        console.log('Silakan paste token tersebut ke dalam file .env kamu!');
    } catch (error) {
        console.error('\n❌ Gagal mendapatkan token! Pastikan kamu meng-copy kodenya dengan benar.', error.message);
    } finally {
        rl.close();
    }
});