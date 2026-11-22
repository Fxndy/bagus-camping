# Gambar lokal

Seluruh foto eksternal yang sebelumnya dipakai katalog dan hero sudah diunduh dari URL aslinya, lalu disimpan sebagai WebP. Aplikasi tidak perlu menghubungi Unsplash untuk menampilkan gambar.

- `hero-camping.webp`: foto hero, lebar 2000 piksel.
- Dua belas berkas produk mengikuti nama yang sudah dipakai katalog.
- `product-default.webp`: satu gambar pengganti bersama untuk produk tanpa foto atau gambar yang gagal dimuat; bersumber dari foto tenda yang sebelumnya dipakai sebagai fallback bawaan.
- `sources.json`: URL sumber, waktu unduh, dimensi, ukuran, dan SHA-256 hasil unduhan/konversi. URL ini hanya catatan sumber, bukan URL yang dimuat UI.

Foto ini mempertahankan pilihan ilustrasi lama, bukan dokumentasi barang milik usaha. Beberapa produk memang memakai foto sumber yang sama. Admin dapat menggantinya dengan satu foto produk milik usaha/berlisensi; unggahan disimpan terpisah pada `DATA_DIR/uploads/products` dan disajikan melalui `/assets/uploads/products/`.
