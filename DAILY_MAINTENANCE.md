# Daily Maintenance

Vercel memanggil `GET /api/cron/daily-maintenance` setiap hari pada
`16:01 UTC`, yaitu `00:01 WITA/Singapura`.

Endpoint melakukan dua pekerjaan:

1. Membalik nilai `public.system_keepalive` antara `0` dan `1`.
2. Meminta access token Google baru melalui refresh token, lalu mengetes
   koneksi Google Drive.

## Environment Vercel

Tambahkan `CRON_SECRET` dengan nilai acak yang panjang pada environment
Production. Vercel otomatis mengirim header berikut ke endpoint cron:

```text
Authorization: Bearer <CRON_SECRET>
```

Nilai secret dapat dibuat di PowerShell:

```powershell
[Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
).ToLower()
```

Simpan hasilnya di Vercel:

1. Buka project `absensi-backend`.
2. Buka **Settings > Environment Variables**.
3. Tambahkan `CRON_SECRET` untuk environment **Production**.

Semua environment Google Drive berikut juga harus tersedia di Production:

```text
DRIVE_CLIENT_ID
DRIVE_CLIENT_SECRET
DRIVE_REFRESH_TOKEN
DRIVE_ROOT_FOLDER_ID
```

Timeout koneksi dapat disesuaikan jika diperlukan:

```text
DB_CONNECTION_TIMEOUT_MS=10000
DB_IDLE_TIMEOUT_MS=30000
DB_POOL_MAX=5
GOOGLE_API_TIMEOUT_MS=15000
```

## Refresh Token Google

Access token memang berumur pendek dan sekarang diperbarui otomatis oleh
backend. Refresh token tidak perlu dirotasi setiap hari.

Jika respons memuat `DRIVE_REAUTH_REQUIRED`, jalankan:

```powershell
npm run drive:reauthorize
```

Lalu ganti `DRIVE_REFRESH_TOKEN` di Vercel dan redeploy Production. Pastikan
OAuth consent screen Google Cloud tidak lagi berstatus `Testing`; refresh
token aplikasi External dalam status Testing dapat kedaluwarsa setelah 7 hari.

Setelah environment selesai diubah, push perubahan backend ke branch `main`.
Deployment Production baru akan mengaktifkan jadwal pada `vercel.json`.
