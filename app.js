/*
 * KEDUNGSEPUR RESILIENCE - WebGIS Cuaca & Ketahanan Bencana
 * Arsitektur Statis (GitHub Pages): Browser hanya membaca file lokal.
 * Tidak ada panggilan API BMKG atau API luar dari browser pengunjung.
 */
'use strict';

// ---------------------------------------------------------------------------
// 1. Konfigurasi Global & File
// ---------------------------------------------------------------------------
const CB = '?v=' + Date.now();
const KONFIG = {
  fileBatas: 'data/batas_keldes.geojson' + CB,
  fileBMKG: 'data/bmkg_latest.json' + CB,
  fileOpenMeteo: 'data/openmeteo_grid.json' + CB,
  fileMarine: 'data/marine_grid.json' + CB,
  pusatPeta: [-7.06, 110.52],
  zoomAwal: 10,
};

// Skema Warna Kelas Hujan BMKG
const KELAS_HUJAN = [
  { nama: 'Tidak hujan', warna: '#94a3b8' },
  { nama: 'Hujan ringan', warna: '#38bdf8' },
  { nama: 'Hujan sedang', warna: '#2563eb' },
  { nama: 'Hujan lebat/petir', warna: '#b91c1c' },
];
const WARNA_KOSONG = '#cbd5e1';

// ---------------------------------------------------------------------------
// 2. State Aplikasi
// ---------------------------------------------------------------------------
const state = {
  batasData: null,         // GeoJSON FeatureCollection
  bmkgData: null,          // JSON data cuaca 1.250 desa
  openMeteoData: null,     // JSON model grid
  marineData: null,        // JSON model gelombang/arus laut
  
  modeLayer: 'desa',       // 'desa' | 'grid'
  varDesa: 'kelas',        // 'kelas' | 'suhu' | 'kelembapan' | 'awan' | 'angin'
  varGrid: 'precipitation',// 'precipitation' | 'temperature' | 'relative_humidity' | 'cloud_cover' | 'pressure' | 'wind_speed'
  
  hariIdx: 0,              // 0, 1, 2
  jamIdx: 20,              // 0 .. 23
  
  desaTerpilih: null,      // kode_adm4 terpilih
  filterKab: '',           // filter kab/kota
  cariTeks: '',            // teks pencarian
  urutTabel: { kolom: 'desa', arah: 1 },
  
  tampilkanAngin: true,
  tampilkanLaut: true,
  opasitasGrid: 0.65,
  grafik: null,
};

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// 3. Inisialisasi Peta Leaflet & Renderer
// ---------------------------------------------------------------------------
const peta = L.map('peta', {
  zoomControl: true,
  preferCanvas: true,
}).setView(KONFIG.pusatPeta, KONFIG.zoomAwal);

const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> | Cuaca: BMKG & Open-Meteo',
}).addTo(peta);

// Canvas Renderer khusus untuk poligon batas desa (kinerja tinggi pada 1.250 fitur)
const canvasRenderer = L.canvas({ padding: 0.5 });

// Layer Groups
let layerBatasDesa = null;
let layerGridOverlay = null;
let layerPartikelAngin = null;
let layerMarine = null;

// Legenda Kontrol
const legendaControl = L.control({ position: 'bottomright' });
legendaControl.onAdd = () => {
  const div = L.DomUtil.create('div', 'legenda');
  div.id = 'wadah-legenda';
  return div;
};
legendaControl.addTo(peta);

// ---------------------------------------------------------------------------
// 4. Utilitas Pewarnaan & Palet Meteorologi
// ---------------------------------------------------------------------------
function interpolasiWarna(hex1, hex2, faktor) {
  const f = Math.max(0, Math.min(1, faktor));
  const c1 = parseInt(hex1.replace('#', ''), 16);
  const c2 = parseInt(hex2.replace('#', ''), 16);
  const r1 = (c1 >> 16) & 255, g1 = (c1 >> 8) & 255, b1 = c1 & 255;
  const r2 = (c2 >> 16) & 255, g2 = (c2 >> 8) & 255, b2 = c2 & 255;
  const r = Math.round(r1 + f * (r2 - r1));
  const g = Math.round(g1 + f * (g2 - g1));
  const b = Math.round(b1 + f * (b2 - b1));
  return `rgb(${r},${g},${b})`;
}

// Skala Suhu: 20°C (dingin) -> 36°C (panas)
function warnaSuhu(t) {
  if (t === null || t === undefined) return WARNA_KOSONG;
  if (t <= 22) return '#60a5fa';
  if (t <= 26) return '#34d399';
  if (t <= 29) return '#facc15';
  if (t <= 32) return '#fb923c';
  return '#ef4444';
}

// Skala Kelembapan: 50% (kering) -> 100% (basah)
function warnaKelembapan(hu) {
  if (hu === null || hu === undefined) return WARNA_KOSONG;
  if (hu < 60) return '#fed7aa';
  if (hu < 75) return '#93c5fd';
  if (hu < 85) return '#3b82f6';
  return '#1e3a8a';
}

// Skala Tutupan Awan (0 - 100%)
function warnaAwan(tcc) {
  if (tcc === null || tcc === undefined) return WARNA_KOSONG;
  if (tcc < 20) return '#fef08a'; // cerah
  if (tcc < 50) return '#bae6fd'; // cerah berawan
  if (tcc < 80) return '#94a3b8'; // berawan
  return '#475569'; // berawan tebal
}

// Skala Angin (0 - 35 km/jam)
function warnaAngin(ws) {
  if (ws === null || ws === undefined) return WARNA_KOSONG;
  if (ws < 5) return '#e2e8f0';
  if (ws < 15) return '#67e8f9';
  if (ws < 25) return '#0284c7';
  return '#7c3aed';
}

// Skala Curah Hujan Grid (mm/jam)
function warnaHujan(mm) {
  if (mm <= 0.05) return 'rgba(0,0,0,0)';
  if (mm < 1.0) return 'rgba(56, 189, 248, 0.5)';
  if (mm < 5.0) return 'rgba(29, 78, 216, 0.7)';
  if (mm < 15.0) return 'rgba(234, 88, 12, 0.8)';
  return 'rgba(185, 28, 28, 0.9)';
}

// ---------------------------------------------------------------------------
// 5. Sinkronisasi Waktu (WIB) & Penentuan Slot
// ---------------------------------------------------------------------------
function hitungWaktuTerpilih() {
  const d = new Date();
  d.setDate(d.getDate() + state.hariIdx);
  d.setHours(state.jamIdx, 0, 0, 0);
  return d;
}

function cariSlotBMKGTerdekat(slots) {
  if (!slots || !slots.length) return 0;
  const targetDate = hitungWaktuTerpilih();
  const targetTime = targetDate.getTime();
  
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const sStr = slots[i].replace(' ', 'T') + '+07:00';
    const sTime = new Date(sStr).getTime();
    const diff = Math.abs(sTime - targetTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function cariIndexOpenMeteo(times) {
  if (!times || !times.length) return 0;
  const d = hitungWaktuTerpilih();
  // Format Open-Meteo: "YYYY-MM-DDTHH:00"
  const pad = (n) => String(n).padStart(2, '0');
  const tStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  
  const idx = times.indexOf(tStr);
  return idx >= 0 ? idx : Math.min(state.hariIdx * 24 + state.jamIdx, times.length - 1);
}

function perbaruiLabelWaktu() {
  const d = hitungWaktuTerpilih();
  const tglTeks = d.toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
  });
  const jamTeks = String(state.jamIdx).padStart(2, '0') + ':00 WIB';
  $('#label-waktu-aktif').textContent = `${tglTeks}, ${jamTeks}`;
  $('#angka-jam-slider').textContent = jamTeks;

  if (state.bmkgData && state.bmkgData.slots && state.bmkgData.slots.length) {
    const sIdx = cariSlotBMKGTerdekat(state.bmkgData.slots);
    const sTeks = state.bmkgData.slots[sIdx] || '';
    $('#label-slot-bmkg').textContent = `Slot BMKG: ${sTeks.slice(11, 16)} WIB`;
  }
}

// ---------------------------------------------------------------------------
// 6. Gaya & Interaksi Poligon Batas Desa (BMKG)
// ---------------------------------------------------------------------------
function getStyleDesa(feature) {
  const kode = feature.properties.kode_adm4;
  const terpilih = kode === state.desaTerpilih;
  
  if (!state.bmkgData || !state.bmkgData.desa || !state.bmkgData.desa[kode]) {
    return {
      fillColor: WARNA_KOSONG,
      fillOpacity: terpilih ? 0.9 : 0.6,
      color: terpilih ? '#facc15' : '#94a3b8',
      weight: terpilih ? 2.5 : 0.6,
    };
  }

  const d = state.bmkgData.desa[kode];
  const sIdx = cariSlotBMKGTerdekat(state.bmkgData.slots);
  
  let fill = WARNA_KOSONG;
  if (state.varDesa === 'kelas') {
    const kIdx = (d.kelas && d.kelas[sIdx] !== undefined) ? d.kelas[sIdx] : -1;
    fill = (kIdx >= 0 && kIdx < KELAS_HUJAN.length) ? KELAS_HUJAN[kIdx].warna : WARNA_KOSONG;
  } else if (state.varDesa === 'suhu') {
    fill = warnaSuhu(d.t ? d.t[sIdx] : null);
  } else if (state.varDesa === 'kelembapan') {
    fill = warnaKelembapan(d.hu ? d.hu[sIdx] : null);
  } else if (state.varDesa === 'awan') {
    fill = warnaAwan(d.tcc ? d.tcc[sIdx] : null);
  } else if (state.varDesa === 'angin') {
    fill = warnaAngin(d.ws ? d.ws[sIdx] : null);
  }

  return {
    fillColor: fill,
    fillOpacity: terpilih ? 0.95 : 0.72,
    color: terpilih ? '#000000' : '#475569',
    weight: terpilih ? 3 : 0.65,
  };
}

function perbaruiGayaDesa() {
  if (layerBatasDesa) {
    layerBatasDesa.setStyle(getStyleDesa);
  }
}

function bukaDetailDesa(kode, terbangKeLokasi = false) {
  state.desaTerpilih = kode;
  perbaruiGayaDesa();
  
  const f = state.batasData.features.find((x) => x.properties.kode_adm4 === kode);
  if (!f) return;
  const p = f.properties;
  const dBMKG = state.bmkgData && state.bmkgData.desa ? state.bmkgData.desa[kode] : null;

  $('#detail-kosong').hidden = true;
  $('#detail-isi').hidden = false;
  $('#detail-nama').textContent = p.desa;
  $('#detail-wilayah').textContent = `Kecamatan ${p.kecamatan}, ${p.kabupaten}`;
  $('#detail-kab').textContent = p.kabupaten;
  $('#detail-kode').textContent = kode;
  $('#detail-analisis').textContent = (state.bmkgData && state.bmkgData.analysis_date) || '–';

  if (dBMKG) {
    $('#detail-status-data').textContent = dBMKG.stale ? 'Data Tersimpan (Stale)' : 'Terbaru (BMKG)';
    $('#detail-status-data').className = 'badge-status ' + (dBMKG.stale ? 'status-stale' : 'aktif-live');
    
    const sIdx = cariSlotBMKGTerdekat(state.bmkgData.slots);
    const kIdx = dBMKG.kelas ? dBMKG.kelas[sIdx] : 0;
    const cuacaDesc = (dBMKG.cuaca && dBMKG.cuaca[sIdx]) || '–';
    const suhuVal = dBMKG.t ? dBMKG.t[sIdx] : '–';
    const huVal = dBMKG.hu ? dBMKG.hu[sIdx] : '–';
    const wsVal = dBMKG.ws ? dBMKG.ws[sIdx] : '–';
    const tccVal = dBMKG.tcc ? dBMKG.tcc[sIdx] : '–';
    const harianAktif = (dBMKG.harian && dBMKG.harian[state.hariIdx]) || {};

    $('#detail-tanggal').textContent = `Hari ${state.hariIdx + 1} (${harianAktif.tanggal || '–'})`;
    $('#detail-ringkasan').innerHTML = `
      <dt>Kelas Hujan</dt><dd><span class="badge" style="--warna:${KELAS_HUJAN[kIdx]?.warna}">${KELAS_HUJAN[kIdx]?.nama}</span></dd>
      <dt>Kondisi Cuaca</dt><dd>${cuacaDesc}</dd>
      <dt>Suhu Saat Ini</dt><dd><strong>${suhuVal} °C</strong> (Maks: ${harianAktif.suhu_max ?? '–'} °C)</dd>
      <dt>Kelembapan</dt><dd>${huVal} %</dd>
      <dt>Kecepatan Angin</dt><dd>${wsVal} km/jam (${dBMKG.wd ? dBMKG.wd[sIdx] : ''})</dd>
      <dt>Tutupan Awan</dt><dd>${tccVal} %</dd>
      <dt>Ringkasan Hari</dt><dd>${harianAktif.slot_hujan ?? 0} slot hujan, dominan: ${harianAktif.cuaca_dominan ?? '–'}</dd>
    `;

    // Grafik Suhu & Kelembapan per 3 jam
    renderGrafik(dBMKG);
  } else {
    $('#detail-status-data').textContent = 'Belum Ada Data BMKG';
    $('#detail-status-data').className = 'badge-status';
    $('#detail-ringkasan').innerHTML = `<dt>Status</dt><dd>Data prakiraan belum tersedia untuk titik ini.</dd>`;
  }

  if (terbangKeLokasi && layerBatasDesa) {
    layerBatasDesa.eachLayer((layer) => {
      if (layer.feature && layer.feature.properties.kode_adm4 === kode) {
        peta.flyToBounds(layer.getBounds(), { maxZoom: 13, duration: 0.6 });
      }
    });
  }

  renderTabel();
}

function renderGrafik(dBMKG) {
  if (typeof Chart === 'undefined') return;
  const slots = state.bmkgData.slots || [];
  const labels = slots.map((s) => s.slice(11, 16));
  const tData = dBMKG.t || [];
  const huData = dBMKG.hu || [];

  if (!state.grafik) {
    const ctx = $('#grafik').getContext('2d');
    state.grafik = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Suhu (°C)', data: tData, borderColor: '#ef4444', backgroundColor: '#ef4444', yAxisID: 'y', tension: 0.35, pointRadius: 2.5 },
          { label: 'Kelembapan (%)', data: huData, borderColor: '#0284c7', backgroundColor: '#0284c7', yAxisID: 'y1', tension: 0.35, borderDash: [4, 4], pointRadius: 2.5 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { boxWidth: 10, font: { size: 10 } } },
        },
        scales: {
          x: { ticks: { font: { size: 9.5 } } },
          y: { position: 'left', title: { display: true, text: '°C' }, ticks: { font: { size: 9.5 } } },
          y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: '%' }, ticks: { font: { size: 9.5 } } },
        },
      },
    });
  } else {
    state.grafik.data.labels = labels;
    state.grafik.data.datasets[0].data = tData;
    state.grafik.data.datasets[1].data = huData;
    state.grafik.update();
  }
}

$('#tutup-detail').addEventListener('click', () => {
  state.desaTerpilih = null;
  $('#detail-isi').hidden = true;
  $('#detail-kosong').hidden = false;
  perbaruiGayaDesa();
  renderTabel();
});

// ---------------------------------------------------------------------------
// 7. Layer Model Grid Halus (Bilinear Interpolation Canvas Overlay)
// ---------------------------------------------------------------------------
function renderGridHalusCanvas() {
  if (!state.openMeteoData || state.modeLayer !== 'grid') {
    if (layerGridOverlay) peta.removeLayer(layerGridOverlay);
    return;
  }

  const d = state.openMeteoData;
  const grid = d.grid;
  const tIdx = cariIndexOpenMeteo(d.times);
  const dataVar = d.variables[state.varGrid] ? d.variables[state.varGrid][tIdx] : null;
  if (!dataVar) return;

  const ny = grid.ny;
  const nx = grid.nx;
  const scale = 8; // Interpolasi 8x per sel grid untuk hasil halus
  const width = (nx - 1) * scale;
  const height = (ny - 1) * scale;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;

  // Bilinear interpolation
  for (let y = 0; y < height; y++) {
    const gy = y / scale;
    const r0 = Math.floor(gy);
    const r1 = Math.min(r0 + 1, ny - 1);
    const fy = gy - r0;

    for (let x = 0; x < width; x++) {
      const gx = x / scale;
      const c0 = Math.floor(gx);
      const c1 = Math.min(c0 + 1, nx - 1);
      const fx = gx - c0;

      const v00 = dataVar[r0][c0] ?? 0;
      const v01 = dataVar[r0][c1] ?? 0;
      const v10 = dataVar[r1][c0] ?? 0;
      const v11 = dataVar[r1][c1] ?? 0;

      const val = (1 - fy) * ((1 - fx) * v00 + fx * v01) + fy * ((1 - fx) * v10 + fx * v11);
      const color = warnaDariNilaiGrid(val, state.varGrid);

      const pIdx = (y * width + x) * 4;
      data[pIdx] = color[0];
      data[pIdx + 1] = color[1];
      data[pIdx + 2] = color[2];
      data[pIdx + 3] = color[3];
    }
  }

  ctx.putImageData(imgData, 0, 0);

  const bounds = [
    [grid.lat_min, grid.lon_min],
    [grid.lat_max, grid.lon_max],
  ];

  if (!layerGridOverlay) {
    layerGridOverlay = L.imageOverlay(canvas.toDataURL(), bounds, {
      opacity: state.opasitasGrid,
      interactive: false,
    }).addTo(peta);
  } else {
    layerGridOverlay.setBounds(bounds);
    layerGridOverlay.setUrl(canvas.toDataURL());
    layerGridOverlay.setOpacity(state.opasitasGrid);
    if (!peta.hasLayer(layerGridOverlay)) layerGridOverlay.addTo(peta);
  }
}

function warnaDariNilaiGrid(val, varNama) {
  if (varNama === 'precipitation') {
    if (val <= 0.05) return [0, 0, 0, 0];
    if (val < 1.0) return [56, 189, 248, 140];
    if (val < 5.0) return [37, 99, 235, 190];
    if (val < 15.0) return [234, 88, 12, 220];
    return [185, 28, 28, 240];
  } else if (varNama === 'temperature') {
    if (val < 22) return [96, 165, 250, 180];
    if (val < 26) return [52, 211, 153, 180];
    if (val < 30) return [250, 204, 21, 190];
    if (val < 33) return [251, 146, 60, 200];
    return [239, 68, 68, 220];
  } else if (varNama === 'relative_humidity') {
    if (val < 60) return [254, 215, 170, 160];
    if (val < 75) return [147, 197, 253, 180];
    if (val < 85) return [59, 130, 246, 200];
    return [30, 58, 138, 220];
  } else if (varNama === 'cloud_cover') {
    const alpha = Math.min(200, Math.floor((val / 100) * 200));
    return [100, 116, 139, alpha];
  } else if (varNama === 'pressure') {
    // 1005 - 1015 hPa
    const f = Math.max(0, Math.min(1, (val - 1005) / 10));
    return [Math.floor(255 * (1 - f)), Math.floor(180 * f), 220, 170];
  } else {
    // wind speed
    if (val < 5) return [226, 232, 240, 90];
    if (val < 15) return [103, 232, 249, 170];
    if (val < 25) return [2, 132, 199, 190];
    return [124, 58, 237, 210];
  }
}

// ---------------------------------------------------------------------------
// 8. Partikel Aliran Angin Beranimasi
// ---------------------------------------------------------------------------
let animasiAnginId = null;
const partikelList = [];
const JUMLAH_PARTIKEL = 450;

function siapkanPartikelAngin() {
  if (layerPartikelAngin) peta.removeLayer(layerPartikelAngin);
  if (!state.tampilkanAngin || !state.openMeteoData) return;

  const canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated canvas-angin');
  const size = peta.getSize();
  canvas.width = size.x;
  canvas.height = size.y;

  const CanvasOverlay = L.Layer.extend({
    onAdd: function (map) {
      this._map = map;
      this._canvas = canvas;
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on('moveend resize', this._reset, this);
      this._reset();
      mulaiAnimasiAngin();
    },
    onRemove: function (map) {
      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      map.off('moveend resize', this._reset, this);
      if (animasiAnginId) cancelAnimationFrame(animasiAnginId);
    },
    _reset: function () {
      const topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      const sz = this._map.getSize();
      this._canvas.width = sz.x;
      this._canvas.height = sz.y;
    },
  });

  layerPartikelAngin = new CanvasOverlay();
  layerPartikelAngin.addTo(peta);

  // Inisialisasi partikel acak
  partikelList.length = 0;
  for (let i = 0; i < JUMLAH_PARTIKEL; i++) {
    partikelList.push({
      x: Math.random() * size.x,
      y: Math.random() * size.y,
      umur: Math.floor(Math.random() * 50),
      maxUmur: 40 + Math.floor(Math.random() * 40),
    });
  }
}

function mulaiAnimasiAngin() {
  if (animasiAnginId) cancelAnimationFrame(animasiAnginId);
  const d = state.openMeteoData;
  if (!d) return;
  const grid = d.grid;
  const tIdx = cariIndexOpenMeteo(d.times);
  const uGrid = d.variables.u[tIdx];
  const vGrid = d.variables.v[tIdx];
  if (!uGrid || !vGrid) return;

  const canvas = document.querySelector('.canvas-angin');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function loop() {
    if (!state.tampilkanAngin) return;
    const w = canvas.width;
    const h = canvas.height;

    // Fade trail
    ctx.fillStyle = 'rgba(255, 255, 255, 0.90)';
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    ctx.strokeStyle = 'rgba(15, 23, 42, 0.65)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();

    for (let i = 0; i < partikelList.length; i++) {
      const p = partikelList[i];
      const latlng = peta.containerPointToLatLng([p.x, p.y]);

      // Periksa apakah di dalam grid
      if (latlng.lat > grid.lat_max || latlng.lat < grid.lat_min ||
          latlng.lng < grid.lon_min || latlng.lng > grid.lon_max) {
        p.x = Math.random() * w;
        p.y = Math.random() * h;
        p.umur = 0;
        continue;
      }

      const gy = (grid.lat_max - latlng.lat) / grid.dlat;
      const gx = (latlng.lng - grid.lon_min) / grid.dlon;
      const r0 = Math.max(0, Math.min(grid.ny - 1, Math.floor(gy)));
      const c0 = Math.max(0, Math.min(grid.nx - 1, Math.floor(gx)));

      const u = uGrid[r0][c0] ?? 0;
      const v = vGrid[r0][c0] ?? 0;

      const nextX = p.x + u * 0.8;
      const nextY = p.y - v * 0.8;

      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nextX, nextY);

      p.x = nextX;
      p.y = nextY;
      p.umur++;

      if (p.umur > p.maxUmur || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
        p.x = Math.random() * w;
        p.y = Math.random() * h;
        p.umur = 0;
      }
    }
    ctx.stroke();

    animasiAnginId = requestAnimationFrame(loop);
  }

  animasiAnginId = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// 9. Layer Laut (Marine Open-Meteo)
// ---------------------------------------------------------------------------
function renderLayerLaut() {
  if (layerMarine) {
    peta.removeLayer(layerMarine);
    layerMarine = null;
  }
  if (!state.tampilkanLaut || !state.marineData) return;

  const m = state.marineData;
  const grid = m.grid;
  const tIdx = cariIndexOpenMeteo(m.times);
  const waveH = m.variables.wave_height[tIdx];
  const waveDir = m.variables.wave_direction[tIdx];
  const curV = m.variables.current_velocity[tIdx];
  const curDir = m.variables.current_direction[tIdx];

  layerMarine = L.layerGroup();
  for (let r = 0; r < grid.ny; r++) {
    const lat = grid.lat_max - r * grid.dlat;
    if (lat < -6.92) continue; // hanya perairan utara

    for (let c = 0; c < grid.nx; c += 2) {
      const lon = grid.lon_min + c * grid.dlon;
      const wh = waveH[r][c];
      if (wh === null || wh === undefined) continue;

      const marker = L.circleMarker([lat, lon], {
        radius: Math.max(3, Math.min(8, wh * 8)),
        fillColor: wh > 0.5 ? '#0284c7' : '#38bdf8',
        fillOpacity: 0.65,
        color: '#0369a1',
        weight: 1,
      });

      marker.bindPopup(`
        <div class="popup">
          <strong>Perairan Laut Jawa</strong><br>
          <span class="popup-wilayah">Koordinat: ${lat.toFixed(2)}, ${lon.toFixed(2)}</span>
          <hr style="margin:4px 0; border:0; border-top:1px solid #e2e8f0;">
          <div>Tinggi Gelombang: <strong>${wh} m</strong></div>
          <div>Arah Gelombang: ${waveDir[r][c] ?? '–'}°</div>
          <div>Kecepatan Arus: ${curV ? curV[r][c] : '–'} m/s (${curDir ? curDir[r][c] : ''}°)</div>
          <small class="catatan-kecil" style="display:block;margin-top:4px;">Akurasi data pesisir terbatas dan resolusinya kasar.</small>
        </div>
      `);
      layerMarine.addLayer(marker);
    }
  }

  layerMarine.addTo(peta);
}

// ---------------------------------------------------------------------------
// 10. Legenda Dinamis
// ---------------------------------------------------------------------------
function perbaruiLegenda() {
  const el = $('#wadah-legenda');
  if (!el) return;

  if (state.modeLayer === 'desa') {
    if (state.varDesa === 'kelas') {
      el.innerHTML = `<strong>Kelas Hujan (BMKG)</strong>` +
        KELAS_HUJAN.map((k) => `<div><i style="background:${k.warna}"></i>${k.nama}</div>`).join('') +
        `<div><i style="background:${WARNA_KOSONG}"></i>Tidak ada data</div>`;
    } else if (state.varDesa === 'suhu') {
      el.innerHTML = `<strong>Suhu Udara (BMKG)</strong>
        <div class="legenda-ramping" style="background: linear-gradient(to right, #60a5fa, #34d399, #facc15, #fb923c, #ef4444);"></div>
        <div class="legenda-label-ramping"><span>&le; 22°C</span><span>28°C</span><span>&ge; 33°C</span></div>`;
    } else if (state.varDesa === 'kelembapan') {
      el.innerHTML = `<strong>Kelembapan Udara (BMKG)</strong>
        <div class="legenda-ramping" style="background: linear-gradient(to right, #fed7aa, #93c5fd, #3b82f6, #1e3a8a);"></div>
        <div class="legenda-label-ramping"><span>50%</span><span>75%</span><span>100%</span></div>`;
    } else if (state.varDesa === 'awan') {
      el.innerHTML = `<strong>Tutupan Awan (BMKG)</strong>
        <div><i style="background:#fef08a"></i>Cerah (&lt;20%)</div>
        <div><i style="background:#bae6fd"></i>Cerah Berawan (20–50%)</div>
        <div><i style="background:#94a3b8"></i>Berawan (50–80%)</div>
        <div><i style="background:#475569"></i>Berawan Tebal (&gt;80%)</div>`;
    } else {
      el.innerHTML = `<strong>Kecepatan Angin (BMKG)</strong>
        <div class="legenda-ramping" style="background: linear-gradient(to right, #e2e8f0, #67e8f9, #0284c7, #7c3aed);"></div>
        <div class="legenda-label-ramping"><span>Tenang</span><span>15 km/j</span><span>&ge; 30 km/j</span></div>`;
    }
  } else {
    // Mode Grid Open-Meteo
    let judul = 'Model Grid Open-Meteo';
    let grad = 'linear-gradient(to right, #38bdf8, #1d4ed8, #ea580c, #b91c1c)';
    let lKiri = '0 mm', lKanan = '20+ mm/jam';

    if (state.varGrid === 'precipitation') {
      judul = 'Curah Hujan (mm/jam)';
    } else if (state.varGrid === 'temperature') {
      judul = 'Suhu Permukaan (°C)';
      grad = 'linear-gradient(to right, #60a5fa, #34d399, #facc15, #fb923c, #ef4444)';
      lKiri = '20°C'; lKanan = '35°C';
    } else if (state.varGrid === 'relative_humidity') {
      judul = 'Kelembapan Udara (%)';
      grad = 'linear-gradient(to right, #fed7aa, #93c5fd, #3b82f6, #1e3a8a)';
      lKiri = '50%'; lKanan = '100%';
    }

    el.innerHTML = `<strong>${judul}</strong>
      <div class="legenda-ramping" style="background: ${grad};"></div>
      <div class="legenda-label-ramping"><span>${lKiri}</span><span>${lKanan}</span></div>
      <div class="legenda-catatan">Permukaan halus dari model grid, bukan hasil pengukuran langsung.</div>`;
  }
}

// ---------------------------------------------------------------------------
// 11. Tabel Ringkas Interaktif & Filter
// ---------------------------------------------------------------------------
function renderTabel() {
  if (!state.batasData || !state.batasData.features) return;
  const sIdx = state.bmkgData ? cariSlotBMKGTerdekat(state.bmkgData.slots) : 0;
  const kataKunci = state.cariTeks.toLowerCase();

  const baris = [];
  state.batasData.features.forEach((f) => {
    const p = f.properties;
    if (state.filterKab && p.kabupaten !== state.filterKab) return;
    if (kataKunci && !p.desa.toLowerCase().includes(kataKunci) && !p.kecamatan.toLowerCase().includes(kataKunci)) {
      return;
    }

    const dBMKG = state.bmkgData && state.bmkgData.desa ? state.bmkgData.desa[p.kode_adm4] : null;
    const tVal = dBMKG && dBMKG.t ? dBMKG.t[sIdx] : null;
    const huVal = dBMKG && dBMKG.hu ? dBMKG.hu[sIdx] : null;
    const wsVal = dBMKG && dBMKG.ws ? dBMKG.ws[sIdx] : null;
    const cuacaVal = dBMKG && dBMKG.cuaca ? dBMKG.cuaca[sIdx] : '–';
    const kelasIdx = dBMKG && dBMKG.kelas ? dBMKG.kelas[sIdx] : -1;
    const kelasNama = (kelasIdx >= 0 && kelasIdx < KELAS_HUJAN.length) ? KELAS_HUJAN[kelasIdx].nama : '–';

    baris.push({
      kode: p.kode_adm4,
      desa: p.desa,
      kecamatan: p.kecamatan,
      kabupaten: p.kabupaten,
      t: tVal,
      hu: huVal,
      ws: wsVal,
      cuaca: cuacaVal,
      kelas: kelasNama,
      kelasIdx: kelasIdx,
    });
  });

  // Pengurutan
  const { kolom, arah } = state.urutTabel;
  baris.sort((a, b) => {
    let x = a[kolom], y = b[kolom];
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === 'number') return (x - y) * arah;
    return String(x).localeCompare(String(y), 'id') * arah;
  });

  $('#info-tabel-total').textContent = `Menampilkan ${baris.length} dari ${state.batasData.features.length} desa`;

  const tbody = $('#tabel tbody');
  if (!baris.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="kosong">Tidak ada desa yang cocok dengan filter pencarian.</td></tr>';
    return;
  }

  tbody.innerHTML = baris.slice(0, 150).map((r) => `
    <tr data-kode="${r.kode}" class="${r.kode === state.desaTerpilih ? 'terpilih' : ''}" tabindex="0">
      <td><strong>${r.desa}</strong></td>
      <td>${r.kecamatan}</td>
      <td>${r.kabupaten}</td>
      <td class="angka">${r.t !== null ? r.t + '°' : '–'}</td>
      <td class="angka">${r.hu !== null ? r.hu + '%' : '–'}</td>
      <td class="angka">${r.ws !== null ? r.ws : '–'}</td>
      <td>${r.cuaca}</td>
      <td>${r.kelasIdx >= 0 ? `<span class="badge" style="--warna:${KELAS_HUJAN[r.kelasIdx].warna}">${r.kelas}</span>` : '–'}</td>
    </tr>
  `).join('');
}

// Event Klik Baris Tabel
$('#tabel tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-kode]');
  if (tr) bukaDetailDesa(tr.dataset.kode, true);
});

// Sorting Header Tabel
document.querySelectorAll('#tabel th').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.kolom;
    state.urutTabel = {
      kolom: k,
      arah: state.urutTabel.kolom === k ? -state.urutTabel.arah : 1,
    };
    document.querySelectorAll('#tabel th').forEach((t) => t.setAttribute('aria-sort', 'none'));
    th.setAttribute('aria-sort', state.urutTabel.arah === 1 ? 'ascending' : 'descending');
    renderTabel();
  });
});

$('#filter-kabupaten').addEventListener('change', (e) => {
  state.filterKab = e.target.value;
  renderTabel();
});

$('#cari-desa').addEventListener('input', (e) => {
  state.cariTeks = e.target.value.trim();
  renderTabel();
});

// ---------------------------------------------------------------------------
// 12. Penanganan Kontrol UI (Waktu, Variabel, Mode)
// ---------------------------------------------------------------------------
function setupEventKontrol() {
  // Pemilih Hari
  document.querySelectorAll('#pemilih-hari button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#pemilih-hari button').forEach((b) => b.classList.remove('aktif'));
      btn.classList.add('aktif');
      state.hariIdx = parseInt(btn.dataset.hari, 10);
      perbaruiSemuaTampilan();
    });
  });

  // Slider Jam
  $('#slider-jam').addEventListener('input', (e) => {
    state.jamIdx = parseInt(e.target.value, 10);
    perbaruiSemuaTampilan();
  });

  // Pemilih Mode Layer (Desa vs Grid)
  $('#pilih-layer-mode').addEventListener('change', (e) => {
    state.modeLayer = e.target.value;
    const isGrid = state.modeLayer === 'grid';
    $('#wadah-var-desa').hidden = isGrid;
    $('#wadah-var-grid').hidden = !isGrid;
    $('#wadah-transparansi').hidden = !isGrid;

    if (isGrid) {
      if (layerBatasDesa) layerBatasDesa.setStyle({ fillOpacity: 0.15, weight: 0.5 });
    } else {
      if (layerGridOverlay) peta.removeLayer(layerGridOverlay);
      perbaruiGayaDesa();
    }
    perbaruiSemuaTampilan();
  });

  // Variabel Desa
  $('#var-desa').addEventListener('change', (e) => {
    state.varDesa = e.target.value;
    perbaruiGayaDesa();
    perbaruiLegenda();
  });

  // Variabel Grid
  $('#var-grid').addEventListener('change', (e) => {
    state.varGrid = e.target.value;
    renderGridHalusCanvas();
    perbaruiLegenda();
  });

  // Saklar Aliran Angin
  $('#saklar-angin').addEventListener('change', (e) => {
    state.tampilkanAngin = e.target.checked;
    siapkanPartikelAngin();
  });

  // Saklar Gelombang Laut
  $('#saklar-laut').addEventListener('change', (e) => {
    state.tampilkanLaut = e.target.checked;
    renderLayerLaut();
  });

  // Slider Transparansi Grid
  $('#slider-transparansi').addEventListener('input', (e) => {
    state.opasitasGrid = parseFloat(e.target.value);
    if (layerGridOverlay) layerGridOverlay.setOpacity(state.opasitasGrid);
  });
}

function perbaruiSemuaTampilan() {
  perbaruiLabelWaktu();
  if (state.modeLayer === 'desa') {
    perbaruiGayaDesa();
  } else {
    renderGridHalusCanvas();
  }
  siapkanPartikelAngin();
  renderLayerLaut();
  perbaruiLegenda();
  renderTabel();
  if (state.desaTerpilih) bukaDetailDesa(state.desaTerpilih, false);
}

// ---------------------------------------------------------------------------
// 13. Muat Data & Inisialisasi
// ---------------------------------------------------------------------------
async function init() {
  setupEventKontrol();
  perbaruiLabelWaktu();

  try {
    // 1. Muat Batas Desa (GeoJSON Ringan)
    const respBatas = await fetch(KONFIG.fileBatas);
    if (!respBatas.ok) throw new Error('Gagal memuat batas desa');
    state.batasData = await respBatas.json();

    layerBatasDesa = L.geoJSON(state.batasData, {
      renderer: canvasRenderer,
      style: getStyleDesa,
      onEachFeature: (f, layer) => {
        layer.on({
          click: () => bukaDetailDesa(f.properties.kode_adm4, false),
          mouseover: () => {
            if (f.properties.kode_adm4 !== state.desaTerpilih) {
              layer.setStyle({ weight: 1.8, color: '#0f172a' });
            }
          },
          mouseout: () => {
            if (f.properties.kode_adm4 !== state.desaTerpilih) {
              layer.setStyle(getStyleDesa(f));
            }
          },
        });
      },
    }).addTo(peta);

    // Zoom ke batas Kedungsepur
    peta.fitBounds(layerBatasDesa.getBounds(), { padding: [15, 15] });
  } catch (err) {
    console.error('Error memuat batas wilayah:', err);
  }

  // 2. Muat Data Cuaca BMKG
  try {
    const respBMKG = await fetch(KONFIG.fileBMKG);
    if (respBMKG.ok) {
      state.bmkgData = await respBMKG.json();
      const wUpdate = state.bmkgData.fetched_at || state.bmkgData.analysis_date || '';
      $('#waktu-update').textContent = `Data diperbarui: ${wUpdate.slice(0, 16).replace('T', ' ')} WIB (${state.bmkgData.total_desa || 0} desa)`;
    }
  } catch (err) {
    console.warn('Data BMKG belum siap:', err);
  }

  // 3. Muat Data Model Open-Meteo Grid & Marine
  try {
    const [respOM, respMar] = await Promise.all([
      fetch(KONFIG.fileOpenMeteo),
      fetch(KONFIG.fileMarine),
    ]);
    if (respOM.ok) state.openMeteoData = await respOM.json();
    if (respMar.ok) state.marineData = await respMar.json();
  } catch (err) {
    console.warn('Data Open-Meteo belum siap:', err);
  }

  // Render Perdana
  perbaruiSemuaTampilan();
}

// Mulai Aplikasi
init();
