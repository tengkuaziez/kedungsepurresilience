/*
 * KEDUNGSEPUR RESILIENCE - logika peta WebGIS (app.js)
 *
 * Situs statis: data cuaca dibaca dari file GeoJSON yang ditulis oleh
 * scripts/fetch_cuaca.py. Browser TIDAK memanggil API BMKG secara langsung.
 * Semua path relatif (tanpa "/" di depan) agar jalan di sub-path GitHub Pages.
 */
'use strict';

// ---------------------------------------------------------------------------
// Konfigurasi
// ---------------------------------------------------------------------------
const KONFIG = {
  fileCuaca: 'data/cuaca_kedungsepur.geojson',
  pusatPeta: [-7.05, 110.5], // kira-kira tengah Kedungsepur
  zoomAwal: 9,
};

// Kelas hujan (urutan = tingkat keparahan, sama dengan skrip Python)
const KELAS_HUJAN = [
  { nama: 'Tidak hujan', warna: '#a8a29e' },
  { nama: 'Hujan ringan', warna: '#38bdf8' },
  { nama: 'Hujan sedang', warna: '#1d4ed8' },
  { nama: 'Hujan lebat/petir', warna: '#b91c1c' },
];
const WARNA_TANPA_DATA = '#ffffff';

/*
 * Placeholder layer kebencanaan. Tambahkan entri baru di sini saat file
 * GeoJSON-nya sudah diunggah ke folder data/. Jika file belum ada, layer
 * diabaikan tanpa error.
 *   file          : path relatif ke GeoJSON
 *   propertiKelas : nama properti untuk pewarnaan (opsional)
 *   warnaKelas    : peta nilai kelas -> warna
 *   propertiPopup : daftar properti yang ditampilkan di popup (kosong = semua)
 */
const LAYER_TAMBAHAN = [
  {
    id: 'bahaya_banjir',
    nama: 'Bahaya banjir',
    file: 'data/bahaya_banjir.geojson',
    propertiKelas: 'kelas',
    warnaKelas: { Rendah: '#bfdbfe', Sedang: '#60a5fa', Tinggi: '#1e3a8a' },
    warnaDefault: '#3b82f6',
    propertiPopup: [],
    tampilAwal: false,
  },
  {
    id: 'bahaya_longsor',
    nama: 'Bahaya longsor',
    file: 'data/bahaya_longsor.geojson',
    propertiKelas: 'kelas',
    warnaKelas: { Rendah: '#fde68a', Sedang: '#f59e0b', Tinggi: '#92400e' },
    warnaDefault: '#b45309',
    propertiPopup: [],
    tampilAwal: false,
  },
  {
    id: 'risiko_desa',
    nama: 'Risiko & kerugian desa',
    file: 'data/risiko_desa.geojson',
    propertiKelas: 'kelas_risiko',
    warnaKelas: { Rendah: '#bbf7d0', Sedang: '#facc15', Tinggi: '#dc2626' },
    warnaDefault: '#7c3aed',
    propertiPopup: [],
    tampilAwal: false,
  },
];

// ---------------------------------------------------------------------------
// State aplikasi
// ---------------------------------------------------------------------------
const state = {
  fitur: [],            // daftar GeoJSON Feature cuaca
  marker: new Map(),    // adm4 -> L.circleMarker
  hari: 0,              // indeks hari aktif (0..2)
  terpilih: null,       // adm4 yang sedang dibuka di panel
  urut: { kolom: 'nama', arah: 1 },
  filterKec: '',
  grafik: null,
};

// ---------------------------------------------------------------------------
// Utilitas
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

/** Hindari injeksi HTML saat menyisipkan teks dari data. */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Format angka; tampilkan "–" jika kosong. */
function fmt(v, satuan = '') {
  return (v === null || v === undefined || Number.isNaN(v)) ? '–' : `${v}${satuan}`;
}

function tingkatKelas(nama) {
  const i = KELAS_HUJAN.findIndex((k) => k.nama === nama);
  return i < 0 ? -1 : i;
}

function warnaKelas(nama) {
  const i = tingkatKelas(nama);
  return i < 0 ? WARNA_TANPA_DATA : KELAS_HUJAN[i].warna;
}

function badgeKelas(nama) {
  if (!nama) return '<span class="badge badge-kosong">Tidak ada data</span>';
  return `<span class="badge" style="--warna:${warnaKelas(nama)}">${esc(nama)}</span>`;
}

/** Format waktu ISO menjadi teks WIB, contoh "8 Nov 2026, 19.56 WIB". */
function fmtWaktu(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '–';
  return d.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }) + ' WIB';
}

/** Format tanggal "YYYY-MM-DD" menjadi "Min, 8 Nov". */
function fmtTanggal(tgl, panjang = false) {
  if (!tgl) return '';
  const d = new Date(`${tgl}T12:00:00+07:00`);
  return d.toLocaleDateString('id-ID', panjang
    ? { timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : { timeZone: 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short' });
}

const harianAktif = (f) => (f.properties.harian || [])[state.hari] || null;
const namaFitur = (f) => f.properties.desa || f.properties.nama_csv || f.properties.adm4;

// ---------------------------------------------------------------------------
// Peta
// ---------------------------------------------------------------------------
const peta = L.map('peta', { zoomControl: true }).setView(KONFIG.pusatPeta, KONFIG.zoomAwal);

const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> | Cuaca: BMKG',
}).addTo(peta);

// Pane khusus agar layer bahaya (poligon) selalu di bawah titik cuaca
peta.createPane('paneBahaya').style.zIndex = 350;

const layerCuaca = L.layerGroup().addTo(peta);
const kontrolLayer = L.control.layers(
  { OpenStreetMap: osm },
  { 'Prakiraan cuaca (BMKG)': layerCuaca },
  { collapsed: window.innerWidth < 768 },
).addTo(peta);

// Legenda kelas hujan
const legenda = L.control({ position: 'bottomright' });
legenda.onAdd = () => {
  const div = L.DomUtil.create('div', 'legenda');
  div.innerHTML = '<strong>Kelas hujan</strong>' +
    KELAS_HUJAN.map((k) => `<div><i style="background:${k.warna}"></i>${k.nama}</div>`).join('') +
    `<div><i class="tanpa-data" style="background:${WARNA_TANPA_DATA}"></i>Tidak ada data</div>`;
  return div;
};
legenda.addTo(peta);

function isiPopup(f) {
  const p = f.properties;
  const h = harianAktif(f);
  return `<div class="popup">
    <strong>${esc(namaFitur(f))}</strong><br>
    <span class="popup-wilayah">${esc(p.kecamatan)}, ${esc(p.kotkab)}</span>
    <div class="popup-baris">${badgeKelas(h && h.kelas_hujan)}</div>
    ${h ? `<div>Suhu ${fmt(h.suhu_min)}–${fmt(h.suhu_max)} °C · Slot hujan ${h.jumlah_slot_hujan}/${h.jumlah_slot}</div>
           <div>Dominan: ${esc(h.cuaca_dominan)}</div>` : ''}
  </div>`;
}

/** Buat marker untuk setiap titik cuaca. */
function buatMarker() {
  layerCuaca.clearLayers();
  state.marker.clear();
  state.fitur.forEach((f) => {
    const [lon, lat] = f.geometry.coordinates;
    const m = L.circleMarker([lat, lon], {
      radius: 9, weight: 2, color: '#1f2937', fillOpacity: 0.9,
    });
    m.bindPopup(() => isiPopup(f));
    m.on('click', () => pilih(f.properties.adm4, false));
    m.addTo(layerCuaca);
    state.marker.set(f.properties.adm4, m);
  });
  perbaruiWarnaMarker();
  if (state.fitur.length) {
    const batas = L.latLngBounds(state.fitur.map((f) => [f.geometry.coordinates[1], f.geometry.coordinates[0]]));
    peta.fitBounds(batas.pad(0.15));
  }
}

function perbaruiWarnaMarker() {
  state.fitur.forEach((f) => {
    const m = state.marker.get(f.properties.adm4);
    const h = harianAktif(f);
    const aktif = f.properties.adm4 === state.terpilih;
    m.setStyle({
      fillColor: warnaKelas(h && h.kelas_hujan),
      dashArray: h ? null : '3 3',
      radius: aktif ? 12 : 9,
      weight: aktif ? 3 : 2,
      color: aktif ? '#facc15' : '#1f2937',
    });
    if (m.isPopupOpen()) m.setPopupContent(isiPopup(f));
  });
}

// ---------------------------------------------------------------------------
// Pemilih hari
// ---------------------------------------------------------------------------
function siapkanPemilihHari() {
  const contoh = state.fitur.find((f) => (f.properties.harian || []).length) || null;
  document.querySelectorAll('#pemilih-hari button').forEach((btn) => {
    const i = Number(btn.dataset.hari);
    const h = contoh && contoh.properties.harian[i];
    btn.innerHTML = `Hari ${i + 1}${h ? `<small>${esc(fmtTanggal(h.tanggal))}</small>` : ''}`;
    btn.disabled = !h;
    btn.addEventListener('click', () => gantiHari(i));
  });
}

function gantiHari(i) {
  state.hari = i;
  document.querySelectorAll('#pemilih-hari button').forEach((btn) => {
    const aktif = Number(btn.dataset.hari) === i;
    btn.classList.toggle('aktif', aktif);
    btn.setAttribute('aria-pressed', aktif);
  });
  const contoh = state.fitur.find((f) => harianAktif(f));
  const h = contoh && harianAktif(contoh);
  $('#info-hari').textContent = h
    ? `${fmtTanggal(h.tanggal, true)} · ${h.jumlah_slot} slot per 3 jam${h.jumlah_slot < 8 ? ' (sisa hari ini)' : ''}`
    : '';
  perbaruiWarnaMarker();
  renderTabel();
  if (state.terpilih) renderDetail();
}

// ---------------------------------------------------------------------------
// Panel detail + grafik
// ---------------------------------------------------------------------------
function pilih(adm4, terbangKePeta) {
  state.terpilih = adm4;
  const f = state.fitur.find((x) => x.properties.adm4 === adm4);
  if (!f) return;
  if (terbangKePeta) {
    const m = state.marker.get(adm4);
    peta.flyTo(m.getLatLng(), Math.max(peta.getZoom(), 12), { duration: 0.6 });
    m.openPopup();
  }
  perbaruiWarnaMarker();
  renderDetail();
  renderTabel();
  // Di layar kecil, gulir ke panel agar detail terlihat
  if (window.innerWidth < 900 && terbangKePeta === false) {
    $('#panel-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function renderDetail() {
  const f = state.fitur.find((x) => x.properties.adm4 === state.terpilih);
  if (!f) return;
  const p = f.properties;
  const h = harianAktif(f);
  $('#detail-kosong').hidden = true;
  $('#detail-isi').hidden = false;
  $('#detail-nama').textContent = namaFitur(f);
  $('#detail-wilayah').textContent = `Kec. ${p.kecamatan}, ${p.kotkab}, ${p.provinsi || ''}`.replace(/, $/, '');
  $('#detail-tanggal').textContent = h ? `Hari ${state.hari + 1}: ${fmtTanggal(h.tanggal, true)}` : `Hari ${state.hari + 1}: tidak ada data`;
  $('#detail-kode').textContent = p.adm4;
  $('#detail-analisis').textContent = p.analysis_date || '–';

  $('#detail-ringkasan').innerHTML = h ? `
    <dt>Kelas hujan</dt><dd>${badgeKelas(h.kelas_hujan)}</dd>
    <dt>Cuaca dominan</dt><dd>${esc(h.cuaca_dominan)}</dd>
    <dt>Suhu min / rata / maks</dt><dd>${fmt(h.suhu_min)} / ${fmt(h.suhu_rata)} / ${fmt(h.suhu_max)} °C</dd>
    <dt>Kelembapan rata-rata</dt><dd>${fmt(h.kelembapan_rata, ' %')}</dd>
    <dt>Angin maksimum</dt><dd>${fmt(h.angin_maks, ' km/jam')}</dd>
    <dt>Tutupan awan rata-rata</dt><dd>${fmt(h.tcc_rata, ' %')}</dd>
    <dt>Slot hujan</dt><dd>${h.jumlah_slot_hujan} dari ${h.jumlah_slot} slot</dd>` : '<dt>Data</dt><dd>Tidak tersedia untuk hari ini</dd>';

  renderGrafik((p.slot || [])[state.hari] || []);
}

function renderGrafik(slot) {
  const label = slot.map((s) => (s.local_datetime || '').slice(11, 16));
  const suhu = slot.map((s) => s.t);
  const lembap = slot.map((s) => s.hu);
  const desc = slot.map((s) => s.weather_desc || '');

  if (typeof Chart === 'undefined') return; // CDN gagal dimuat: lewati grafik
  if (!state.grafik) {
    state.grafik = new Chart($('#grafik'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Suhu (°C)', data: [], borderColor: '#dc2626', backgroundColor: '#dc2626', yAxisID: 'y', tension: 0.3 },
          { label: 'Kelembapan (%)', data: [], borderColor: '#2563eb', backgroundColor: '#2563eb', yAxisID: 'y1', tension: 0.3, borderDash: [4, 3] },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: { callbacks: { footer: (items) => state.grafikDesc[items[0].dataIndex] || '' } },
        },
        scales: {
          x: { ticks: { font: { size: 10 } } },
          y: { position: 'left', title: { display: true, text: '°C' }, ticks: { font: { size: 10 } } },
          y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '%' }, ticks: { font: { size: 10 } } },
        },
      },
    });
  }
  state.grafikDesc = desc;
  state.grafik.data.labels = label;
  state.grafik.data.datasets[0].data = suhu;
  state.grafik.data.datasets[1].data = lembap;
  state.grafik.update();
}

$('#tutup-detail').addEventListener('click', () => {
  state.terpilih = null;
  $('#detail-isi').hidden = true;
  $('#detail-kosong').hidden = false;
  peta.closePopup();
  perbaruiWarnaMarker();
  renderTabel();
});

// ---------------------------------------------------------------------------
// Tabel ringkas (urut + filter kecamatan)
// ---------------------------------------------------------------------------
function kunciKec(p) { return `${p.kecamatan}|${p.kotkab}`; }

function siapkanFilter() {
  const sel = $('#filter-kecamatan');
  const unik = new Map();
  state.fitur.forEach((f) => unik.set(kunciKec(f.properties), f.properties));
  [...unik.entries()]
    .sort((a, b) => a[1].kecamatan.localeCompare(b[1].kecamatan, 'id'))
    .forEach(([kunci, p]) => {
      const opt = document.createElement('option');
      opt.value = kunci;
      opt.textContent = `${p.kecamatan} (${p.kotkab})`;
      sel.appendChild(opt);
    });
  sel.addEventListener('change', () => { state.filterKec = sel.value; renderTabel(); });
}

function barisTabel() {
  return state.fitur
    .filter((f) => !state.filterKec || kunciKec(f.properties) === state.filterKec)
    .map((f) => {
      const h = harianAktif(f) || {};
      return {
        adm4: f.properties.adm4,
        nama: namaFitur(f),
        kecamatan: f.properties.kecamatan || '',
        kotkab: f.properties.kotkab || '',
        suhu_max: h.suhu_max ?? null,
        jumlah_slot_hujan: h.jumlah_slot_hujan ?? null,
        kelas_hujan: h.kelas_hujan || null,
        kelas_tingkat: tingkatKelas(h.kelas_hujan),
      };
    });
}

function renderTabel() {
  const { kolom, arah } = state.urut;
  const baris = barisTabel().sort((a, b) => {
    const x = a[kolom], y = b[kolom];
    if (x === null || x === undefined) return 1;   // nilai kosong selalu di bawah
    if (y === null || y === undefined) return -1;
    const hasil = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'id');
    return hasil * arah || a.nama.localeCompare(b.nama, 'id');
  });

  $('#tabel tbody').innerHTML = baris.map((r) => `
    <tr data-adm4="${esc(r.adm4)}" class="${r.adm4 === state.terpilih ? 'terpilih' : ''}" tabindex="0">
      <td>${esc(r.nama)}</td>
      <td>${esc(r.kecamatan)}<span class="sel-kotkab">${esc(r.kotkab)}</span></td>
      <td class="angka">${fmt(r.suhu_max)}</td>
      <td class="angka">${fmt(r.jumlah_slot_hujan)}</td>
      <td>${badgeKelas(r.kelas_hujan)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="kosong">Tidak ada data</td></tr>';

  document.querySelectorAll('#tabel th').forEach((th) => {
    const sort = th.dataset.kolom === kolom ? (arah === 1 ? 'ascending' : 'descending') : 'none';
    th.setAttribute('aria-sort', sort);
  });
}

// Klik header = urutkan; klik lagi = balik arah
document.querySelectorAll('#tabel th').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.kolom;
    state.urut = { kolom: k, arah: state.urut.kolom === k ? -state.urut.arah : 1 };
    renderTabel();
  });
});

// Klik / Enter pada baris = buka detail dan arahkan peta
function aksiBaris(e) {
  const tr = e.target.closest('tr[data-adm4]');
  if (tr) pilih(tr.dataset.adm4, true);
}
$('#tabel tbody').addEventListener('click', aksiBaris);
$('#tabel tbody').addEventListener('keydown', (e) => { if (e.key === 'Enter') aksiBaris(e); });

// ---------------------------------------------------------------------------
// Layer kebencanaan tambahan (dimuat jika file ada)
// ---------------------------------------------------------------------------
async function muatLayerTambahan(cfg) {
  try {
    const resp = await fetch(cfg.file, { cache: 'no-cache' });
    if (!resp.ok) return; // file belum ada (404): abaikan
    const gj = await resp.json();
    const warna = (p) => (cfg.propertiKelas && cfg.warnaKelas[p[cfg.propertiKelas]]) || cfg.warnaDefault;
    const layer = L.geoJSON(gj, {
      pane: 'paneBahaya',
      style: (f) => ({ color: warna(f.properties || {}), weight: 1, fillColor: warna(f.properties || {}), fillOpacity: 0.45 }),
      pointToLayer: (f, latlng) => L.circleMarker(latlng, { pane: 'paneBahaya', radius: 6 }),
      onEachFeature: (f, lyr) => {
        const p = f.properties || {};
        const kunci = cfg.propertiPopup.length ? cfg.propertiPopup : Object.keys(p).slice(0, 15);
        lyr.bindPopup(`<div class="popup"><strong>${esc(cfg.nama)}</strong>
          <table class="tabel-popup">${kunci.map((k) => `<tr><th>${esc(k)}</th><td>${esc(p[k])}</td></tr>`).join('')}</table></div>`);
      },
    });
    kontrolLayer.addOverlay(layer, cfg.nama);
    if (cfg.tampilAwal) layer.addTo(peta);
  } catch (err) {
    // File tidak ada / bukan GeoJSON valid: abaikan tanpa mengganggu aplikasi
    console.info(`Layer "${cfg.nama}" belum tersedia (${cfg.file}).`);
  }
}

// ---------------------------------------------------------------------------
// Inisialisasi
// ---------------------------------------------------------------------------
function tampilkanPesan(teks) {
  const el = $('#pesan-status');
  el.textContent = teks;
  el.hidden = !teks;
}

async function init() {
  try {
    // no-cache: browser memvalidasi ulang agar data terbaru langsung terlihat
    const resp = await fetch(KONFIG.fileCuaca, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const gj = await resp.json();
    state.fitur = (gj.features || []).filter((f) => f.geometry && f.geometry.type === 'Point');

    const waktu = (gj.metadata && gj.metadata.waktu_tarik) ||
      state.fitur.map((f) => f.properties.waktu_tarik).sort().pop();
    $('#waktu-update').textContent = `Data diperbarui: ${waktu ? fmtWaktu(waktu) : '–'}`;

    buatMarker();
    siapkanPemilihHari();
    siapkanFilter();
    gantiHari(0);
    if (!state.fitur.length) tampilkanPesan('Belum ada titik cuaca di file data.');
  } catch (err) {
    console.error(err);
    $('#waktu-update').textContent = 'Data diperbarui: –';
    tampilkanPesan(`Gagal memuat ${KONFIG.fileCuaca} (${err.message}). Jalankan scripts/fetch_cuaca.py dan buka lewat server lokal (python -m http.server).`);
  }
  LAYER_TAMBAHAN.forEach(muatLayerTambahan);
}

init();
