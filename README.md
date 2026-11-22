# Bagus Adventure

Aplikasi penyewaan alat camping. Pelanggan memilih perlengkapan, menentukan durasi sewa, lalu mengunggah bukti transfer. Admin mengelola stok, memeriksa pembayaran, dan mencatat pengambilan serta pengembalian.

![Perlengkapan camping Bagus Adventure](assets/images/hero-camping.webp)

[Deploy ke Netlify](#deploy-ke-netlify) · [Jalankan lokal](#jalankan-lokal) · [Alur sewa](#alur-sewa) · [Pengujian](#pengujian)

## Deploy ke Netlify

1. Impor repositori ini dari GitHub. [`netlify.toml`](netlify.toml) menetapkan Node.js 24, perintah `npm run build`, direktori publik `dist`, dan direktori Functions. Jangan unggah `dist` saja lewat drag-and-drop: API memerlukan Netlify Functions.
2. Buka **Project configuration → Environment variables**. Tambahkan variabel berikut dengan scope **Functions**.

   | Variabel | Nilai | Tandai secret |
   | --- | --- | --- |
   | `SESSION_SECRET` | Nilai acak minimal 32 karakter | Ya |
   | `ADMIN_USERNAME` | 3–24 karakter: huruf, angka, titik, garis bawah, atau tanda hubung | Tidak |
   | `ADMIN_PASSWORD` | Minimal 8 karakter, maksimal 72 byte | Ya |
   | `ADMIN_FULL_NAME` | Nama tampilan, opsional | Tidak |
   | `MAX_RENTAL_DAYS` | Batas durasi sewa, opsional. Default 30, rentang 1–3650 | Tidak |

3. Deploy dan buka `/api/health`. Jika responsnya `200` dengan `{"status":"ok"}`, buka `/admin`. Saat belum ada akun admin, aplikasi membuatnya pada permintaan login atau registrasi pertama. Mengubah variabel tidak mengganti sandi admin yang sudah tersimpan.
4. Isi stok di dashboard. Deploy pertama membawa katalog bawaan dengan stok nol. Database dan unggahan dari komputer lokal tidak ikut diimpor.

[`netlify/functions/api.js`](netlify/functions/api.js) menjalankan API Express dan membuka Netlify Blobs dengan `getStore`, tanpa token manual. `bagus-database` menyimpan akun, katalog, stok, dan pesanan; `bagus-sessions` menyimpan sesi; `bagus-media` menyimpan foto produk dan bukti transfer. Bukti transfer hanya disajikan lewat API yang memeriksa hak akses.

Jika perubahan data bertabrakan, API mengembalikan `409` alih-alih menimpa perubahan lain. Muat ulang sebelum mencoba lagi. Gunakan proyek Netlify terpisah untuk pengujian dengan data terisolasi: Deploy Preview dalam proyek yang sama dapat memakai penyimpanan yang sama.

## Jalankan lokal

Gunakan Node.js 24. Salin [`.env.example`](.env.example) menjadi `.env`, lalu isi `SESSION_SECRET`, `ADMIN_USERNAME`, dan `ADMIN_PASSWORD` sebelum menjalankan server. Gunakan `COOKIE_SECURE=false` dan `TRUST_PROXY=false` untuk akses HTTP langsung. Jangan commit `.env`.

```bash
npm ci
npm start
```

Buka [katalog lokal](http://localhost:3000) atau [dashboard admin](http://localhost:3000/admin). Server mandiri bisa membuat admin dengan kredensial bawaan jika variabel tidak diisi; jangan buka instance tersebut ke internet. Untuk membuat atau memperbarui akun admin lokal, isi variabel admin lalu jalankan `npm run admin:init`. Perintah itu mengubah data lokal, bukan data Netlify.

### Docker

Setelah mengisi `.env`, jalankan `docker compose up -d --build`. Konfigurasi Compose tidak meneruskan variabel kredensial admin ke container. Sebelum membuka akses publik, jalankan `node server/init-admin.js` di dalam container dengan `ADMIN_USERNAME` dan `ADMIN_PASSWORD` yang diberikan melalui lingkungan operator privat. Gunakan `TRUST_PROXY=false` untuk akses langsung, atau sesuaikan dengan jumlah proxy tepercaya saat memakai reverse proxy.

Express mandiri dan Docker menyimpan data di `data/database.json` (atau `$DATA_DIR/database.json`) serta unggahan di direktori `uploads` di sebelahnya. Gunakan satu proses penulis untuk satu direktori data. Untuk mencadangkan, salin database **dan** unggahan ke tempat privat. Di Docker, keduanya ada di volume `camping_data` pada `/app/data`; `docker compose down -v` menghapus volume itu.

## Alur sewa

1. Pelanggan masuk dan memilih perlengkapan. Keranjang dibatasi stok yang tersedia setelah dikurangi pesanan yang masih menahan stok. Saat checkout, server memeriksa stok lagi, menghitung total, dan menyimpan harga pada invoice.
2. Pelanggan memilih SeaBank atau GoPay dan mengunggah bukti transfer (JPG, PNG, atau WebP, maksimal 4 MB). Aplikasi menyimpan pesanan sebelum membuka WhatsApp. Jika popup diblokir, tautan tersedia di invoice. Mengulang permintaan checkout yang sama tidak membuat invoice baru.
3. Admin memeriksa pembayaran secara manual. Status pembayaran terpisah dari status sewa; membuka WhatsApp tidak menandai pesanan lunas.
4. Setelah menyetujui pesanan, admin menyiapkan barang dan mengonfirmasi pengambilan. Saat itulah hitung mundur sewa dimulai. Tenggat tampil dalam WIB. Waktu habis tidak otomatis menyelesaikan pesanan atau menghitung denda. Admin menutup sewa setelah barang kembali.

Nomor pembayaran disimpan di [`server/payment-config.json`](server/payment-config.json). Lihat [`server/settings.js`](server/settings.js) untuk pengaturan checkout dan [`js/config.js`](js/config.js) untuk tampilan kontak usaha.

## Pengujian

| Perintah | Kegunaan |
| --- | --- |
| `npm test` | Tes API, penyimpanan, dan alur pesanan |
| `npx playwright install chromium` | Pasang browser pengujian sekali |
| `node --test tests/browser-flow.cjs` | Uji katalog, batas stok, checkout, dan dashboard dari browser |
| `npx netlify-cli build --offline` | Uji build dan pengemasan Functions tanpa deploy |

Untuk mencoba jalur Netlify secara lokal, jalankan `npm run build`, lalu `npx netlify-cli dev`. Build lokal tidak membuktikan deploy produksi berhasil; cek `/api/health` di URL deploy setelah penerbitan.
