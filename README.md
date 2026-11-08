# KEDUNGSEPUR RESILIENCE

**Sistem pendukung keputusan mitigasi bencana hidrometeorologi** — prototipe WebGIS statis untuk menguji akses data prakiraan cuaca terbuka BMKG di wilayah Kedungsepur (Kendal, Demak, Kab. Semarang, Kota Semarang, Salatiga, Grobogan).

Bagian dari penelitian *"Pengembangan Model Risiko dan Kerugian Ekonomi Bencana Hidrometeorologi Berbasis WebGIS sebagai Sistem Pendukung Keputusan Mitigasi"*.

- Situs (GitHub Pages): https://tengkuaziez.github.io/kedungsepurresilience/
- **Sumber data cuaca: BMKG (data.bmkg.go.id)**

## Arsitektur ("cara B")

```
GitHub Actions (2x sehari)                       Browser pengunjung
  scripts/fetch_cuaca.py  ──► data/cuaca_kedungsepur.geojson ──► index.html + app.js (Leaflet)
        │ (1 request per kode, jeda 1,2 s)
        ▼
  API BMKG publik
```

Browser **tidak pernah** memanggil API BMKG. Hanya skrip Python yang memanggil API, lalu menulis file GeoJSON statis. Dengan begitu jumlah request ke BMKG tetap (±18 request per penarikan) berapa pun jumlah pengunjung.

## Struktur folder

```
/
├── index.html, app.js, style.css    # frontend statis (Leaflet + Chart.js dari CDN)
├── README.md
├── data/
│   ├── kelurahan_test.csv           # daftar kode adm4 yang ditarik (adm4,nama)
│   ├── cuaca_kedungsepur.geojson    # ditulis oleh skrip
│   ├── gagal.log                    # kode yang gagal ditarik pada penarikan terakhir
│   └── (nanti: bahaya_banjir.geojson, bahaya_longsor.geojson, risiko_desa.geojson, dll.)
├── scripts/fetch_cuaca.py           # penarik data BMKG (pustaka standar Python saja)
└── .github/workflows/cuaca.yml      # jadwal otomatis 06:30 & 18:30 WIB
```

## Menjalankan secara lokal

Butuh Python 3.9+ (tanpa paket tambahan).

```bash
python scripts/fetch_cuaca.py      # tarik data BMKG -> data/cuaca_kedungsepur.geojson
python -m http.server 8000         # lalu buka http://localhost:8000/
```

Halaman harus dibuka lewat server (bukan klik ganda `index.html`), karena browser memblokir `fetch` dari `file://`.

Opsi skrip:

- `python scripts/fetch_cuaca.py --ulang` — abaikan progres tersimpan dan tarik ulang semua kode.
- Jika skrip terputus, jalankan lagi tanpa `--ulang`: kode yang sudah berhasil (disimpan di `data/.progres_cuaca.json`, tidak di-commit) akan dilewati selama progres berumur < 3 jam.

Perilaku skrip:

- Jeda minimal 1,2 detik antar-request (termasuk retry) → di bawah batas BMKG 60 request/menit/IP.
- Timeout 30 detik; retry maksimal 3 kali dengan backoff 2, 4, 8 detik untuk galat jaringan dan HTTP 5xx.
- HTTP 429: menunggu sesuai header `Retry-After`, atau 60 detik jika header tidak ada, lalu mencoba lagi.
- HTTP 4xx lain (mis. 404 kode tidak dikenal) tidak diulang dan langsung dicatat di `data/gagal.log`.
- Jika **semua** kode gagal, GeoJSON lama tidak ditimpa dan skrip keluar dengan kode 1.

## Daftar kelurahan/desa uji (`data/kelurahan_test.csv`)

18 kode adm4 (3 per kabupaten/kota, 4 di Kota Semarang, 2 di Salatiga), dipilih dari lokasi yang relevan dengan banjir/rob/longsor.

Sumber kode: dataset [cahyadsn/wilayah](https://github.com/cahyadsn/wilayah), berkas `db/archive/wilayah_2023.sql` yang berlabel *"Data Kode Wilayah sesuai Kepmendagri No 100.1.1-6117 Tahun 2022"*. Semua kode juga dicek sama di versi arsip 2022 dan versi terbaru (Kepmendagri 300.2.2-2138 Tahun 2025), dan **sudah diverifikasi ke API BMKG**: setiap kode mengembalikan nama desa/kelurahan, kecamatan, dan kabupaten/kota yang sesuai.

| adm4 | Nama | Kecamatan | Kab/Kota |
|---|---|---|---|
| 33.74.02.1008 | Tanjung Mas | Semarang Utara | Kota Semarang |
| 33.74.03.1001 | Kemijen | Semarang Timur | Kota Semarang |
| 33.74.05.1007 | Trimulyo | Genuk | Kota Semarang |
| 33.74.11.1009 | Tinjomoyo | Banyumanik | Kota Semarang |
| 33.21.04.2012 | Bedono | Sayung | Kab. Demak |
| 33.21.09.2011 | Wonorejo | Karanganyar | Kab. Demak |
| 33.21.11.1018 | Bintoro | Demak | Kab. Demak |
| 33.24.15.1019 | Bandengan | Kendal | Kab. Kendal |
| 33.24.15.1012 | Langenharjo | Kendal | Kab. Kendal |
| 33.24.08.2015 | Mororejo | Kaliwungu | Kab. Kendal |
| 33.22.18.1008 | Ungaran | Ungaran Barat | Kab. Semarang |
| 33.22.10.1006 | Kupang | Ambarawa | Kab. Semarang |
| 33.22.20.2005 | Candi | Bandungan | Kab. Semarang |
| 33.73.01.1002 | Sidorejo Lor | Sidorejo | Kota Salatiga |
| 33.73.02.1007 | Kutowinangun Lor | Tingkir | Kota Salatiga |
| 33.15.13.1012 | Purwodadi | Purwodadi | Kab. Grobogan |
| 33.15.13.1013 | Kuripan | Purwodadi | Kab. Grobogan |
| 33.15.17.2014 | Gubug | Gubug | Kab. Grobogan |

Untuk menambah titik, cukup tambahkan baris `adm4,nama` di CSV.

## Isi GeoJSON

`FeatureCollection` berisi titik (koordinat dari `lokasi.lat/lon` respons BMKG). Properti tiap titik:

| Properti | Keterangan |
|---|---|
| `adm4`, `desa`, `kecamatan`, `kotkab`, `provinsi` | dari `lokasi` respons BMKG |
| `nama_csv` | nama dari CSV (cadangan) |
| `analysis_date` | waktu analisis model BMKG |
| `waktu_tarik` | waktu skrip menarik data (ISO 8601, WIB) |
| `harian` | list ringkasan per hari (lihat di bawah) |
| `slot` | data mentah BMKG: list per hari, tiap hari berisi slot per 3 jam |

Bagian `metadata` berisi `waktu_tarik` keseluruhan (dipakai untuk teks "Data diperbarui"), jumlah berhasil/gagal, dan sumber data.

Ringkasan `harian` dihitung dari slot hari tersebut: `tanggal`, `jumlah_slot`, `suhu_min`, `suhu_max`, `suhu_rata`, `kelembapan_rata`, `angin_maks` (km/jam), `tcc_rata` (%), `jumlah_slot_hujan` (slot yang `weather_desc`-nya mengandung kata "Hujan"), `cuaca_dominan` (modus `weather_desc`; jika seri, yang muncul lebih dulu), `kelas_hujan`.

## Aturan pemetaan kelas hujan

`kelas_hujan` diturunkan dari **`weather_desc` terburuk** dalam hari itu. Tiap `weather_desc` dicek berurutan (tanpa membedakan huruf besar/kecil):

| Jika `weather_desc` mengandung… | Kelas | Contoh `weather_desc` BMKG |
|---|---|---|
| "petir" **atau** "lebat" | **Hujan lebat/petir** | Hujan Lebat, Hujan Petir, Petir |
| "sedang" | **Hujan sedang** | Hujan Sedang |
| "hujan" | **Hujan ringan** | Hujan Ringan, Hujan Lokal |
| selain itu | **Tidak hujan** | Cerah, Cerah Berawan, Berawan, Berawan Tebal, Kabut, Udara Kabur, Asap |

Urutan keparahan: Tidak hujan < Hujan ringan < Hujan sedang < Hujan lebat/petir. Kelas hari = kelas tertinggi dari semua slot.

Keputusan sederhana yang diambil:

- "Hujan Lokal" dimasukkan ke **Hujan ringan**.
- "Petir" (tanpa kata "Hujan") dimasukkan ke **Hujan lebat/petir** karena berpotensi hujan konvektif, tetapi **tidak** dihitung di `jumlah_slot_hujan` (aturannya hanya kata "Hujan").

## Menambah layer kebencanaan

1. Simpan file GeoJSON (EPSG:4326 / WGS84) di folder `data/`, misalnya `data/bahaya_banjir.geojson`.
2. Nama file yang sudah disiapkan di `app.js` (konstanta `LAYER_TAMBAHAN`):
   - `data/bahaya_banjir.geojson` — pewarnaan dari properti `kelas` (`Rendah` / `Sedang` / `Tinggi`)
   - `data/bahaya_longsor.geojson` — pewarnaan dari properti `kelas`
   - `data/risiko_desa.geojson` — pewarnaan dari properti `kelas_risiko`
3. Layer otomatis muncul di kontrol layer (pojok kanan atas peta) dan bisa dihidupkan/dimatikan. Jika file belum ada, layer diabaikan tanpa error.
4. Untuk layer lain (mis. `kerugian_ekonomi.geojson`), tambahkan satu entri baru di `LAYER_TAMBAHAN` dengan `id`, `nama`, `file`, `propertiKelas`, `warnaKelas`, `warnaDefault`. Atur `propertiPopup` untuk membatasi kolom yang tampil di popup (kosong = 15 properti pertama), dan `tampilAwal: true` jika ingin langsung tampil.
5. Layer bahaya digambar di bawah titik cuaca. File besar sebaiknya disederhanakan dulu (mis. *simplify* di QGIS/mapshaper) agar ringan dibuka di HP.

## Pembaruan otomatis (GitHub Actions)

`.github/workflows/cuaca.yml` berjalan pukul **06:30 WIB (23:30 UTC)** dan **18:30 WIB (11:30 UTC)**, plus bisa dijalankan manual (*Actions → Perbarui cuaca BMKG → Run workflow*). Workflow meng-commit `data/cuaca_kedungsepur.geojson` (dan `data/gagal.log`) hanya jika GeoJSON berubah.

Catatan: karena `waktu_tarik` selalu berubah, praktis setiap penarikan yang berhasil akan menghasilkan commit (2 commit per hari). Jadwal GitHub Actions juga bisa tertunda beberapa menit.

## Keterbatasan data

- **Tidak ada curah hujan (mm) resmi yang dipakai.** Intensitas hujan hanya diturunkan dari teks `weather_desc`, sehingga kelas hujan bersifat kualitatif.
  - Catatan pengujian: respons API saat diuji (8 Nov 2026) ternyata memuat field `tp` yang **tidak disebut di dokumentasi** (nilai 0–5,3 pada 18 titik; kemungkinan *total precipitation* dalam mm). Field ini **tidak dipakai** dalam perhitungan sampai maknanya dikonfirmasi ke BMKG, tetapi tetap tersimpan di data mentah `slot`.
- **Hanya 3 hari ke depan**, per 3 jam. "Hari 1" adalah sisa hari ini, sehingga jumlah slotnya bisa kurang dari 8 (mis. 2 slot jika ditarik malam hari). Hari 2 dan 3 berisi 8 slot. Pengelompokan hari mengikuti pengelompokan dari BMKG (tanggal waktu lokal).
- **Titik, bukan grid/poligon.** Satu prakiraan mewakili satu titik koordinat kelurahan/desa dari BMKG, bukan luasan wilayah.
- Data BMKG diperbarui 2x sehari; data di situs bisa tertinggal hingga ±12 jam (ditambah tunda jadwal Actions dan cache GitHub Pages ±10 menit).
- Jika sebagian kode gagal ditarik, titik itu tidak muncul sampai penarikan berikutnya (lihat `data/gagal.log`).
- Ukuran GeoJSON ±150 KB untuk 18 titik (sebagian besar data mentah `slot`). Untuk ratusan/ribuan desa, pertimbangkan memisahkan data mentah ke file lain.
- Ikon cuaca BMKG (`image`) tidak ditampilkan agar browser pengunjung tidak mengakses server BMKG sama sekali.

## Lisensi & atribusi

- Data prakiraan cuaca: **BMKG (data.bmkg.go.id)** — wajib dicantumkan sebagai sumber.
- Peta dasar: © kontributor OpenStreetMap.
- Kode wilayah: Kepmendagri No. 100.1.1-6117 Tahun 2022 (melalui dataset cahyadsn/wilayah, lisensi MIT).
