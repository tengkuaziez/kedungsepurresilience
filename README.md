# KEDUNGSEPUR RESILIENCE

**Sistem Pendukung Keputusan Mitigasi Bencana Hidrometeorologi Wilayah Kedungsepur**  
Prototipe WebGIS dinamis berbasis data cuaca terbuka BMKG (1.250 kelurahan/desa se-Kedungsepur) dan data model atmosfer & laut beresolusi tinggi Open-Meteo.

- **URL Aplikasi (GitHub Pages):** [https://tengkuaziez.github.io/kedungsepurresilience/](https://tengkuaziez.github.io/kedungsepurresilience/)
- **Wilayah Studi:** Kedungsepur (Kab. Kendal, Kab. Demak, Kab. Semarang, Kota Semarang, Kota Salatiga, Kab. Grobogan) — 1.250 desa/kelurahan.
- **Atribusi Sumber Data:**
  - Data Prakiraan Cuaca Wilayah: **BMKG (Badan Meteorologi, Klimatologi, dan Geofisika)** via `api.bmkg.go.id`
  - Data Model Atmosfer & Kelautan: **Open-Meteo** (Lisensi CC BY 4.0)
  - Peta Dasar: &copy; **OpenStreetMap contributors**
  - Batas Administrasi: Kepmendagri 100.1.1-6117 Tahun 2022 (BIG / Kemendagri via `cahyadsn/wilayah`)

---

## Arsitektur Data & Keamanan ("Cara B")

```
GitHub Actions / Lokal Scheduler:
  scripts/fetch_bmkg_full.py   ──► data/bmkg_latest.json (1.250 desa)
  scripts/fetch_openmeteo.py   ──► data/openmeteo_grid.json & data/marine_grid.json
                                        │
                                        ▼ (File Statis di GitHub Pages)
  Browser Pengunjung:
  index.html + app.js (Leaflet Canvas) ◄┘ (Zero Request ke api.bmkg.go.id)
```

Browser pengunjung **tidak pernah memanggil API BMKG**. Seluruh data diproses secara terjadwal di sisi server/skrip menjadi file JSON statis yang dioptimalkan, mencegah *rate-limiting*, galat CORS, dan menjamin kecepatan akses di perangkat mobile.

---

## Fitur Utama WebGIS

1. **Layer Desa/Kelurahan (Choropleth BMKG 1.250 Desa):**
   - Menggunakan renderer Canvas `L.canvas()` berkinerja tinggi.
   - Pilihan variabel interaktif:
     - **Kelas Hujan:** Tidak hujan (Abu-abu), Hujan ringan (Biru muda), Hujan sedang (Biru tua), Hujan lebat/petir (Merah).
     - **Suhu Udara (°C)** (Skala termal 20°C s.d 36°C).
     - **Kelembapan Udara (%)** (Skala 50% s.d 100%).
     - **Tutupan Awan (%)** (Cerah, Cerah Berawan, Berawan, Berawan Tebal).
     - **Kecepatan Angin (km/jam)**.
   - Klik pada poligon desa membuka panel samping dengan rincian parameter atmosfer dan **grafik fluktuasi suhu & kelembapan per 3 jam** (Chart.js).

2. **Layer Model Grid Halus (Open-Meteo Interpolasi Bilinear):**
   - Grid reguler 600 titik (~5 km) di wilayah Kedungsepur.
   - Permukaan kontinyu halus (*smooth raster*) via interpolasi bilinear pada canvas HTML5 overlay.
   - Variabel: Curah Hujan (mm/jam), Suhu (°C), Kelembapan (%), Tutupan Awan (%), Tekanan Udara (hPa), Kecepatan Angin.
   - Dilengkapi slider opasitas/transparansi.

3. **Aliran Partikel Angin Dinamis (Wind Flow Animation):**
   - Simulasi partikel angin berbasis komponen $u$ dan $v$ (m/s) dari model atmosfer Open-Meteo.
   - Dapat diaktifkan/dinonaktifkan melalui saklar *Aliran Angin*.

4. **Layer Gelombang & Arus Laut (Laut Jawa):**
   - Informasi tinggi gelombang (m), periode, serta vektor arus laut di pesisir utara Kendal, Semarang, dan Demak.

5. **Kontrol Waktu Terintegrasi:**
   - Tab Hari 1, Hari 2, Hari 3.
   - Slider Jam interaktif (00:00 – 23:00 WIB), otomatis menyelaraskan slot waktu BMKG (interval 3 jam) dan Open-Meteo (interval 1 jam).

6. **Tabel Wilayah & Pencarian:**
   - Tabel responsif berisi 1.250 desa dengan filter Kabupaten/Kota dan pencarian instan nama desa/kecamatan.
   - Mengklik baris tabel otomatis menyorot poligon desa di peta.

---

## Struktur Berkas

```
/
├── index.html, app.js, style.css     # Antarmuka WebGIS (Leaflet + Chart.js via CDN)
├── README.md                          # Dokumentasi teknis
├── assets/
│   └── logo.png                       # Logo resmi KEDUNGSEPUR RESILIENCE
├── data/
│   ├── batas_keldes.geojson           # Batas 1.250 desa teroptimasi (1.28 MB)
│   ├── adm4_list.json                 # Metadata daftar kode adm4 1.250 desa
│   ├── bmkg_latest.json               # Data cuaca BMKG 1.250 desa
│   ├── openmeteo_grid.json            # Model grid atmosfer (600 titik)
│   ├── marine_grid.json               # Model kelautan Laut Jawa (180 titik)
│   └── gagal_bmkg.log                 # Log penanganan kode gagal
├── dataspasial/
│   └── KelDesKedungsepur.*            # Data spasial sumber asli (Master)
├── scripts/
│   ├── fetch_bmkg_full.py             # Penarik cuaca BMKG 1.250 desa
│   └── fetch_openmeteo.py             # Penarik model Open-Meteo & Marine
└── .github/workflows/
    ├── cuaca_bmkg.yml                 # Otomasi BMKG 2x sehari (06:30 & 18:30 WIB)
    └── cuaca_openmeteo.yml            # Otomasi Open-Meteo 4x sehari
```

---

## Menjalankan Secara Lokal

Membutuhkan Python 3.9+ (tanpa dependensi rumit):

```bash
# 1. Jalankan penarikan data grid Open-Meteo (~45 detik)
python scripts/fetch_openmeteo.py

# 2. Jalankan penarikan cuaca BMKG (bisa dibatasi dengan --limit N untuk uji coba cepat)
python scripts/fetch_bmkg_full.py --limit 50

# 3. Jalankan web server lokal
python -m http.server 8000
```
Buka browser di `http://localhost:8000/`.

---

## Logika Klasifikasi Kelas Hujan

Diturunkan dari kata kunci pada field `weather_desc` BMKG:
- Mengandung **"petir"** atau **"lebat"** &rarr; **Hujan lebat/petir**
- Mengandung **"sedang"** &rarr; **Hujan sedang**
- Mengandung **"hujan"** (misal *Hujan Ringan*, *Hujan Lokal*) &rarr; **Hujan ringan**
- Selain itu (misal *Cerah*, *Berawan*, *Kabut*) &rarr; **Tidak hujan**

---

## Keterbatasan Data

1. **Resolusi Model Pesisir:** Data gelombang dan arus laut Open-Meteo menggunakan model global (resolusi ~10 km); akurasi di garis pantai dangkal bersifat indikatif.
2. **Interval Slot:** BMKG memperbarui prakiraan per 3 jam, sedangkan Open-Meteo per 1 jam. Sistem menyelaraskan kedua data ke slot waktu WIB terdekat.
3. **Penyederhanaan Geometri:** Batas desa disederhanakan dari 27,5 MB menjadi 1,28 MB (~35 meter toleransi) demi kelancaran rendering di smartphone. Batas ini diperuntukkan untuk visualisasi web makro, bukan untuk survei kadastral legal.
