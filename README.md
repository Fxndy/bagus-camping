# Bagus Adventure — penyewaan alat camping

HTML, CSS, JavaScript vanilla, dan Express. Harga dihitung ulang di server lalu dibekukan pada invoice.

## Deploy ke Netlify

1. Import repositori proyek di Netlify. `netlify.toml` mengatur Node 24, build `npm run build`, publish `dist`, dan Netlify Functions. Jangan unggah `dist` saja lewat drag-and-drop karena API perlu Functions.
2. Di **Project configuration → Environment variables**, isi `SESSION_SECRET` (acak, minimal 32 karakter), `ADMIN_USERNAME` (3–24 karakter), dan `ADMIN_PASSWORD` (minimal 8 karakter, maksimal 72 byte) untuk Functions. `ADMIN_FULL_NAME` opsional. Jangan pakai kredensial contoh atau memasukkan `.env` ke repositori.
3. Deploy, cek `/api/health`, lalu login di `/admin`. Admin awal dibuat saat login/registrasi pertama jika belum ada admin. Mengubah variabel admin tidak mengganti sandi akun yang sudah dibuat.

Netlify Blobs dibuat otomatis lewat `getStore` tanpa token manual: `bagus-database` (akun, katalog, stok, dan pesanan), `bagus-sessions` (sesi), dan `bagus-media` (foto dan bukti transfer). Bukti tetap privat. Database memakai pembacaan konsisten kuat dan ETag; jika dua perubahan bertabrakan, salah satunya mendapat `409` dan perlu dimuat ulang sebelum dicoba kembali.

Data lokal `data/database.json` dan unggahan lama tidak diimpor otomatis. Deploy pertama dimulai dengan katalog bawaan dan stok nol; atur stok lewat `/admin`. Deploy Preview dalam proyek yang sama dapat mengakses store yang sama; gunakan proyek Netlify terpisah untuk menguji perubahan tanpa menyentuh data produksi.

Uji lokal: `npm ci`, isi `.env` dari `.env.example`, jalankan `npm run build` lalu `npx netlify-cli dev`. Untuk build tanpa deploy: `npx netlify-cli build --offline`.

## Menjalankan

Untuk Express mandiri, gunakan Node.js 24. Jalankan `npm ci` lalu `npm start`. Server memuat `.env` bila tersedia. `SESSION_SECRET` wajib acak dan minimal 32 karakter. Jangan commit atau membagikan `.env`. Port default 3000.

Docker: siapkan `.env` privat berisi secret, lalu jalankan `docker compose up -d --build`. Buka http://localhost:3000; pemeriksaan server: `/api/health`. Pakai `COOKIE_SECURE=true` dan `TRUST_PROXY=true` hanya di belakang reverse proxy HTTPS tepercaya. Jangan biarkan port aplikasi dapat diakses langsung dari internet saat trust proxy diaktifkan.

## Administrator

Server tidak membuat admin dengan sandi bawaan saat start. Untuk membuat atau memperbarui admin, isi `ADMIN_USERNAME`, `ADMIN_FULL_NAME` (opsional), dan `ADMIN_PASSWORD` (8–72 byte) dalam lingkungan operator privat, lalu jalankan `npm run admin:init`. Pendaftaran situs selalu membuat akun pelanggan. Jangan menaruh sandi di kode atau browser.

## Pembayaran dan durasi

- Metode pembayaran: SeaBank 901144289647 dan GoPay 085777598395. Checkout wajib mengunggah bukti transfer sebelum pesanan dapat dibuat.
- Bukti gambar dibatasi 4 MB dan diproses ulang ke WebP. Bukti hanya dapat dilihat pemilik pesanan atau admin. Status awal `pending_verification`; admin tetap perlu memeriksa bukti dan dana. Tidak ada verifikasi otomatis.
- Pengaturan nomor tujuan usaha: `server/payment-config.json`.
- `DATA_DIR/uploads/products` menyimpan foto produk publik yang diunggah admin; foto kosong memakai satu gambar fallback lokal.

### Browser end-to-end test

Setelah `npm ci`, jalankan `npx playwright install chromium` sekali untuk memasang browser pengujian. Tes browser dapat dijalankan dengan `node --test tests/browser-flow.cjs`.

- Batas sewa `MAX_RENTAL_DAYS` default 30, dapat diubah ke bilangan bulat 1–3650. Server dan UI menggunakan batas yang sama.
- WhatsApp Admin Bagus Adventure: `628980033500` (08980033500).

## Alur sewa

`pending_approval → approved → waiting_pickup → active → completed`. Admin dapat menolak pesanan yang menunggu persetujuan atau membatalkan sebelum pengambilan. Pembayaran memiliki status terpisah: `unpaid`, `pending_verification`, `paid`, `rejected`. Membuka WhatsApp tidak mengubah pembayaran. Laporan pelanggan menandai menunggu verifikasi; hanya admin yang memverifikasi pembayaran.

Checkout menyimpan pesanan sebelum WhatsApp dibuka. Idempotency key membuat pengulangan permintaan dengan payload identik mengembalikan invoice yang sama. Jika popup diblokir, invoice menyediakan tautan untuk mengirim ulang tanpa membuat pesanan baru.

Timer resmi hanya dimulai ketika admin mengonfirmasi pengambilan fisik. Server menyimpan `picked_up_at` dan `rental_end_at` dalam UTC; UI menampilkan WIB. Timer mengambil sisa waktu dari tenggat yang tersimpan, tetap berjalan setelah refresh/restart, dan waktu habis tidak otomatis menyelesaikan sewa atau menghitung denda. Admin mengonfirmasi pengembalian untuk menyelesaikan order.

Akses tamu memakai token privat pada fragmen tautan invoice. Simpan dan jangan bagikan tautan tersebut. Akun pelanggan hanya melihat pesanan miliknya melalui sesi login.

## Penyimpanan JSON (khusus Express mandiri/Docker)

Seluruh data akun, hash sandi, pesanan, item pesanan, riwayat status, riwayat pembayaran, nomor invoice, kunci keamanan token tamu, dan sesi disimpan di `data/database.json` atau `$DATA_DIR/database.json`. Docker menyimpan berkas ini dalam named volume `camping_data` pada `/app/data/database.json`. Penulisan diserialisasi, ditulis ke berkas sementara, lalu di-rename untuk mencegah berkas JSON setengah tertulis.

JSON file cocok untuk satu proses aplikasi pada satu instance. Jangan menjalankan banyak replika yang menulis file yang sama; JSON tidak menyediakan locking lintas-proses. Backup salin `/app/data/database.json` dari volume, simpan dengan aman karena berisi data pribadi/hash kredensial, dan jangan gunakan `docker compose down -v` jika volume harus dipertahankan. `docker compose down` lalu `docker compose up -d --build` mempertahankan volume yang sama.

Jika tersedia `database.json` yang lebih lama di direktori data, struktur users/orders/orderItems yang ada tetap dibaca dan field baru diberi default saat pemuatan. Data asli tidak dihapus saat migrasi versi schema.

## Pengujian dan berkas situs

Jalankan `npm test`. Pengujian menggunakan direktori sementara terpisah dan membersihkannya setelah selesai. Docker harus diuji di host dengan Docker CLI/daemon terpasang.

- Kontak usaha, nomor WhatsApp, hero: `js/config.js`.
- Produk dan harga tampilan: `js/products.js`; harga otoritatif backend: `server/orders.js`. Harga pada invoice terdahulu tidak berubah.
- Markup dan tampilan: `index.html`, `css/style.css`.
- Foto: `assets/images/`.

Server hanya menyajikan HTML, CSS, JavaScript, dan aset. File data, source backend, package, dan `.env` tidak disajikan secara publik.
