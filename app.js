/*
 * KEDUNGSEPUR RESILIENCE - WebGIS Radar Cuaca & Mitigasi Bencana
 * Desain Immersive Fullscreen (Google Satellite, Open-Meteo Grid Luas, & BMKG Kedungsepur)
 */
'use strict';

const CB = '?v=2.2';
const KONFIG = {
  batasDesa: 'data/batas_keldes.geojson' + CB,
  batasKecamatan: 'data/batas_kecamatan.geojson' + CB,
  batasKabkot: 'data/batas_kabkot.geojson' + CB,
  cuacaBMKG: 'data/bmkg_latest.json' + CB,
  gridOpenMeteo: 'data/openmeteo_grid.json' + CB,
  marineGrid: 'data/marine_grid.json' + CB,
  pusatPeta: [-7.06, 110.52],
  zoomAwal: 10,
};

// Skema Warna Kelas Hujan BMKG
const KELAS_HUJAN = [
  { nama: 'Tidak hujan', warna: '#64748b' },
  { nama: 'Hujan ringan', warna: '#38bdf8' },
  { nama: 'Hujan sedang', warna: '#2563eb' },
  { nama: 'Hujan lebat/petir', warna: '#dc2626' },
];

// State Aplikasi
const state = {
  dataDesaGeo: null,
  dataKecamatanGeo: null,
  dataKabkotGeo: null,
  bmkgData: null,
  gridData: null,
  marineData: null,

  variabelAktif: 'wind', // 'wind' | 'temperature' | 'precipitation' | 'pressure' | 'relative_humidity' | 'cloud_cover'
  levelBatas: 'kabkot',    // 'kabkot' | 'kecamatan' | 'desa' | 'none'
  choroplethBMKG: true,
  animasiAngin: true,
  tampilkanLaut: true,

  hariIdx: 0,
  jamIdx: 20,
  isPlaying: false,
  playTimer: null,

  desaTerpilih: null,
  grafikChart: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------------------------------------------------------------------------
// 1. Inisialisasi Peta & Basemap Satelit
// ---------------------------------------------------------------------------
const peta = L.map('peta', {
  zoomControl: false,
  preferCanvas: true,
  attributionControl: false,
}).setView(KONFIG.pusatPeta, KONFIG.zoomAwal);

L.control.zoom({ position: 'topright' }).addTo(peta);

// Pilihan Basemap
const basemaps = {
  satellite: L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
  }),
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
  }),
  osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }),
};

let basemapAktif = basemaps.satellite.addTo(peta);

function gantiBasemap(tipe) {
  if (basemapAktif) peta.removeLayer(basemapAktif);
  basemapAktif = basemaps[tipe];
  basemapAktif.addTo(peta);
  $$('.btn-basemap').forEach((btn) => {
    btn.classList.toggle('aktif', btn.dataset.base === tipe);
  });
}

$$('.btn-basemap').forEach((b) => {
  b.addEventListener('click', () => gantiBasemap(b.dataset.base));
});

// Canvas Renderer untuk Performa Tinggi
const canvasRenderer = L.canvas({ padding: 0.5 });

let layerGridCanvas = null;
let layerBatasAktif = null;
let layerMarine = null;
let layerPartikelAngin = null;

// ---------------------------------------------------------------------------
// 2. Sinkronisasi Slot Waktu
// ---------------------------------------------------------------------------
function getWaktuTarget() {
  const d = new Date();
  d.setDate(d.getDate() + state.hariIdx);
  d.setHours(state.jamIdx, 0, 0, 0);
  return d;
}

function cariSlotBMKGTerdekat(slots) {
  if (!slots || !slots.length) return 0;
  const target = getWaktuTarget().getTime();
  let best = 0, minDiff = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const sTime = new Date(slots[i].replace(' ', 'T') + '+07:00').getTime();
    const diff = Math.abs(sTime - target);
    if (diff < minDiff) { minDiff = diff; best = i; }
  }
  return best;
}

function cariIndexOpenMeteo(times) {
  if (!times || !times.length) return 0;
  const d = getWaktuTarget();
  const pad = (n) => String(n).padStart(2, '0');
  const tStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  const idx = times.indexOf(tStr);
  return idx >= 0 ? idx : Math.min(state.hariIdx * 24 + state.jamIdx, times.length - 1);
}

function updateLabelWaktuUI() {
  const d = getWaktuTarget();
  const tglTeks = d.toLocaleDateString('id-ID', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
  });
  const jamTeks = String(state.jamIdx).padStart(2, '0') + ':00 WIB';

  $('#badge-jam-aktif').textContent = jamTeks;
  $('#label-tanggal-aktif').textContent = tglTeks;
  $('#slider-jam').value = state.jamIdx;
}

// ---------------------------------------------------------------------------
// 3. Layer Cuaca Grid Halus (Bilinear Interpolation Canvas Overlay Luas)
// ---------------------------------------------------------------------------
function renderGridHalus() {
  if (!state.gridData) return;
  const d = state.gridData;
  const grid = d.grid;
  const tIdx = cariIndexOpenMeteo(d.times);

  // Jika variabel adalah angin, grid cuaca menampilkan kecepatan angin semi-transparan
  const vKey = state.variabelAktif === 'wind' ? 'wind_speed' : state.variabelAktif;
  const matrix = d.variables[vKey] ? d.variables[vKey][tIdx] : null;
  if (!matrix) return;

  const ny = grid.ny;
  const nx = grid.nx;
  const scale = 6;
  const w = (nx - 1) * scale;
  const h = (ny - 1) * scale;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(w, h);
  const data = imgData.data;

  for (let y = 0; y < h; y++) {
    const gy = y / scale;
    const r0 = Math.floor(gy);
    const r1 = Math.min(r0 + 1, ny - 1);
    const fy = gy - r0;

    for (let x = 0; x < w; x++) {
      const gx = x / scale;
      const c0 = Math.floor(gx);
      const c1 = Math.min(c0 + 1, nx - 1);
      const fx = gx - c0;

      const v00 = matrix[r0][c0] ?? 0;
      const v01 = matrix[r0][c1] ?? 0;
      const v10 = matrix[r1][c0] ?? 0;
      const v11 = matrix[r1][c1] ?? 0;

      const val = (1 - fy) * ((1 - fx) * v00 + fx * v01) + fy * ((1 - fx) * v10 + fx * v11);
      const rgba = getWarnaRadar(val, state.variabelAktif);

      const pIdx = (y * w + x) * 4;
      data[pIdx] = rgba[0];
      data[pIdx + 1] = rgba[1];
      data[pIdx + 2] = rgba[2];
      data[pIdx + 3] = rgba[3];
    }
  }

  ctx.putImageData(imgData, 0, 0);

  const bounds = [
    [grid.lat_min, grid.lon_min],
    [grid.lat_max, grid.lon_max],
  ];

  if (!layerGridCanvas) {
    layerGridCanvas = L.imageOverlay(canvas.toDataURL(), bounds, {
      opacity: state.variabelAktif === 'wind' ? 0.45 : 0.65,
      interactive: false,
    }).addTo(peta);
  } else {
    layerGridCanvas.setBounds(bounds);
    layerGridCanvas.setUrl(canvas.toDataURL());
    layerGridCanvas.setOpacity(state.variabelAktif === 'wind' ? 0.45 : 0.65);
    if (!peta.hasLayer(layerGridCanvas)) layerGridCanvas.addTo(peta);
  }
}

// Skema Warna Radar Cuaca Modern (Kontras & Spektakuler)
function getWarnaRadar(v, varName) {
  if (varName === 'precipitation') {
    if (v <= 0.08) return [0, 0, 0, 0];
    if (v < 0.5) return [56, 189, 248, 120];
    if (v < 2.0) return [14, 165, 233, 170];
    if (v < 6.0) return [37, 99, 235, 200];
    if (v < 15.0) return [234, 88, 12, 220];
    return [220, 38, 38, 240];
  } else if (varName === 'temperature') {
    if (v < 22) return [56, 189, 248, 160];
    if (v < 26) return [45, 212, 191, 170];
    if (v < 29) return [250, 204, 21, 180];
    if (v < 32) return [251, 146, 60, 200];
    return [239, 68, 68, 220];
  } else if (varName === 'relative_humidity') {
    if (v < 60) return [254, 215, 170, 140];
    if (v < 75) return [147, 197, 253, 160];
    if (v < 85) return [59, 130, 246, 180];
    return [30, 58, 138, 210];
  } else if (varName === 'cloud_cover') {
    const a = Math.min(190, Math.floor((v / 100) * 190));
    return [148, 163, 184, a];
  } else if (varName === 'pressure') {
    const f = Math.max(0, Math.min(1, (v - 1006) / 8));
    return [Math.floor(255 * (1 - f)), Math.floor(200 * f), 240, 160];
  } else {
    // Wind
    if (v < 5) return [148, 163, 184, 60];
    if (v < 15) return [103, 232, 249, 140];
    if (v < 25) return [14, 165, 233, 170];
    return [168, 85, 247, 200];
  }
}

// ---------------------------------------------------------------------------
// 4. Animasi Aliran Angin Menyeluruh (Wind Stream Particles)
// ---------------------------------------------------------------------------
let animFrameAngin = null;
const partikelAngin = [];
const JUMLAH_PARTIKEL = 550;

function setupAnimasiAngin() {
  if (layerPartikelAngin) peta.removeLayer(layerPartikelAngin);
  if (!state.animasiAngin || !state.gridData) return;

  const canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated canvas-angin');
  const size = peta.getSize();
  canvas.width = size.x;
  canvas.height = size.y;

  const WindLayer = L.Layer.extend({
    onAdd: function (map) {
      this._map = map;
      this._canvas = canvas;
      map.getPanes().overlayPane.appendChild(canvas);
      map.on('moveend resize', this._reset, this);
      this._reset();
      startWindLoop();
    },
    onRemove: function (map) {
      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      map.off('moveend resize', this._reset, this);
      if (animFrameAngin) cancelAnimationFrame(animFrameAngin);
    },
    _reset: function () {
      const topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      const sz = this._map.getSize();
      this._canvas.width = sz.x;
      this._canvas.height = sz.y;
    },
  });

  layerPartikelAngin = new WindLayer();
  layerPartikelAngin.addTo(peta);

  partikelAngin.length = 0;
  for (let i = 0; i < JUMLAH_PARTIKEL; i++) {
    partikelAngin.push({
      x: Math.random() * size.x,
      y: Math.random() * size.y,
      age: Math.floor(Math.random() * 60),
      maxAge: 45 + Math.floor(Math.random() * 40),
    });
  }
}

function startWindLoop() {
  if (animFrameAngin) cancelAnimationFrame(animFrameAngin);
  const d = state.gridData;
  if (!d) return;
  const grid = d.grid;
  const tIdx = cariIndexOpenMeteo(d.times);
  const uG = d.variables.u[tIdx];
  const vG = d.variables.v[tIdx];
  if (!uG || !vG) return;

  const canvas = document.querySelector('.canvas-angin');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function loop() {
    if (!state.animasiAngin) return;
    const w = canvas.width;
    const h = canvas.height;

    // Fade trail tipis
    ctx.fillStyle = 'rgba(0, 0, 0, 0.92)';
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1.35;
    ctx.beginPath();

    for (let i = 0; i < partikelAngin.length; i++) {
      const p = partikelAngin[i];
      const ll = peta.containerPointToLatLng([p.x, p.y]);

      if (ll.lat > grid.lat_max || ll.lat < grid.lat_min ||
          ll.lng < grid.lon_min || ll.lng > grid.lon_max) {
        p.x = Math.random() * w;
        p.y = Math.random() * h;
        p.age = 0;
        continue;
      }

      const gy = (grid.lat_max - ll.lat) / grid.dlat;
      const gx = (ll.lng - grid.lon_min) / grid.dlon;
      const r = Math.max(0, Math.min(grid.ny - 1, Math.floor(gy)));
      const c = Math.max(0, Math.min(grid.nx - 1, Math.floor(gx)));

      const u = uG[r][c] ?? 0;
      const v = vG[r][c] ?? 0;

      const nextX = p.x + u * 0.9;
      const nextY = p.y - v * 0.9;

      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nextX, nextY);

      p.x = nextX;
      p.y = nextY;
      p.age++;

      if (p.age > p.maxAge || p.x < 0 || p.x > w || p.y < 0 || p.y > h) {
        p.x = Math.random() * w;
        p.y = Math.random() * h;
        p.age = 0;
      }
    }
    ctx.stroke();

    animFrameAngin = requestAnimationFrame(loop);
  }

  animFrameAngin = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// 5. Batas Wilayah Kedungsepur (Kab/Kota, Kecamatan, Desa) & Choropleth BMKG
// ---------------------------------------------------------------------------
function renderBatasWilayah() {
  if (layerBatasAktif) {
    peta.removeLayer(layerBatasAktif);
    layerBatasAktif = null;
  }

  if (state.levelBatas === 'none') return;

  let geojson = null;
  let isDesa = false;
  if (state.levelBatas === 'kabkot') geojson = state.dataKabkotGeo;
  else if (state.levelBatas === 'kecamatan') geojson = state.dataKecamatanGeo;
  else if (state.levelBatas === 'desa') { geojson = state.dataDesaGeo; isDesa = true; }

  if (!geojson) return;

  const sBMKG = state.bmkgData ? cariSlotBMKGTerdekat(state.bmkgData.slots) : 0;

  layerBatasAktif = L.geoJSON(geojson, {
    renderer: canvasRenderer,
    style: (feature) => {
      const p = feature.properties;
      const kode = p.kode_adm4 || p.kode;
      const isSelected = kode === state.desaTerpilih;

      let fill = 'transparent';
      let fillOp = 0;

      // Jika level desa & choropleth BMKG aktif: warnai sesuai data BMKG
      if (isDesa && state.choroplethBMKG && state.bmkgData && state.bmkgData.desa) {
        const d = state.bmkgData.desa[kode];
        if (d) {
          const kIdx = (d.kelas && d.kelas[sBMKG] !== undefined) ? d.kelas[sBMKG] : 0;
          fill = KELAS_HUJAN[kIdx]?.warna || '#64748b';
          fillOp = isSelected ? 0.75 : 0.45;
        } else {
          fill = '#475569';
          fillOp = 0.2;
        }
      }

      // Warna garis batas outline & fill wilayah futuristik
      let strokeColor = 'rgba(255, 255, 255, 0.45)';
      let weight = 0.8;

      if (state.levelBatas === 'kabkot') {
        strokeColor = '#38bdf8';
        weight = 2.6;
        fill = '#0284c7';
        fillOp = 0.15;
      } else if (state.levelBatas === 'kecamatan') {
        strokeColor = 'rgba(56, 189, 248, 0.8)';
        weight = 1.4;
        fill = '#0369a1';
        fillOp = 0.10;
      }

      if (isSelected) {
        strokeColor = '#facc15';
        weight = 3.5;
        fillOp = 0.8;
      }

      return {
        fillColor: fill,
        fillOpacity: fillOp,
        color: strokeColor,
        weight: weight,
      };
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties;
      const nama = p.desa || p.kecamatan || p.kabupaten;
      const sub = p.kecamatan ? `Kec. ${p.kecamatan}, ${p.kabupaten}` : p.kabupaten;

      // Label nama Kabupaten/Kota otomatis di peta jika level kabkot
      if (state.levelBatas === 'kabkot' && p.kabupaten) {
        layer.bindTooltip(`🏛️ ${p.kabupaten.toUpperCase()}`, {
          permanent: true,
          direction: 'center',
          className: 'label-kabkot'
        });
      }

      layer.on({
        click: () => {
          if (p.kode_adm4) {
            bukaDetailDesa(p.kode_adm4, false);
          } else {
            layer.bindPopup(`<div style="font-family:sans-serif; min-width:140px;"><strong>${nama}</strong><br><small style="color:#64748b;">${sub}</small><br><span style="display:inline-block; margin-top:6px; font-size:11px; background:#0284c7; color:#fff; padding:2px 6px; border-radius:4px;">Wilayah Kedungsepur</span></div>`).openPopup();
          }
        },
        mouseover: () => {
          layer.setStyle({ weight: 3.2, color: '#facc15', fillOpacity: 0.35 });
        },
        mouseout: () => {
          if (layerBatasAktif) layerBatasAktif.resetStyle(layer);
        },
      });
    },
  }).addTo(peta);
}

// ---------------------------------------------------------------------------
// 6. Detail Cuaca Desa & Grafik Chart.js
// ---------------------------------------------------------------------------
function bukaDetailDesa(kode, flyTo = false) {
  state.desaTerpilih = kode;
  renderBatasWilayah();

  if (!state.dataDesaGeo) return;
  const f = state.dataDesaGeo.features.find((x) => x.properties.kode_adm4 === kode);
  if (!f) return;
  const p = f.properties;
  const dBMKG = state.bmkgData && state.bmkgData.desa ? state.bmkgData.desa[kode] : null;

  const drawer = $('#drawer-detail');
  drawer.hidden = false;

  $('#drawer-nama').textContent = p.desa;
  $('#drawer-wilayah').textContent = `Kecamatan ${p.kecamatan}, ${p.kabupaten}`;
  $('#drawer-kab').textContent = p.kabupaten;
  $('#drawer-kode').textContent = kode;
  $('#drawer-analisis').textContent = (state.bmkgData && state.bmkgData.analysis_date) || '–';

  if (dBMKG) {
    const sIdx = cariSlotBMKGTerdekat(state.bmkgData.slots);
    const kIdx = dBMKG.kelas ? dBMKG.kelas[sIdx] : 0;
    const hAktif = (dBMKG.harian && dBMKG.harian[state.hariIdx]) || {};

    $('#drawer-status').textContent = dBMKG.stale ? 'Tersimpan (Stale)' : 'BMKG Terverifikasi';
    $('#drawer-temp').textContent = (dBMKG.t ? dBMKG.t[sIdx] : '–') + '°C';
    $('#drawer-kondisi').textContent = (dBMKG.cuaca && dBMKG.cuaca[sIdx]) || 'Cerah';
    $('#drawer-kelas-hujan').textContent = KELAS_HUJAN[kIdx]?.nama || 'Tidak hujan';
    $('#drawer-kelas-hujan').style.background = KELAS_HUJAN[kIdx]?.warna || '#64748b';

    $('#drawer-hu').textContent = (dBMKG.hu ? dBMKG.hu[sIdx] : '–') + '%';
    $('#drawer-ws').textContent = (dBMKG.ws ? dBMKG.ws[sIdx] : '–') + ` km/j (${dBMKG.wd ? dBMKG.wd[sIdx] : ''})`;
    $('#drawer-tcc').textContent = (dBMKG.tcc ? dBMKG.tcc[sIdx] : '–') + '%';
    $('#drawer-hujan-hari').textContent = `${hAktif.slot_hujan ?? 0} slot`;

    renderGrafikDrawer(dBMKG);
  } else {
    $('#drawer-status').textContent = 'Belum Ada Data';
    $('#drawer-temp').textContent = '–°C';
    $('#drawer-kondisi').textContent = 'Data Belum Tersedia';
  }

  if (flyTo && layerBatasAktif) {
    layerBatasAktif.eachLayer((l) => {
      if (l.feature && l.feature.properties.kode_adm4 === kode) {
        peta.flyToBounds(l.getBounds(), { maxZoom: 13, duration: 0.6 });
      }
    });
  }
}

function renderGrafikDrawer(dBMKG) {
  if (typeof Chart === 'undefined') return;
  const slots = state.bmkgData.slots || [];
  const labels = slots.map((s) => s.slice(11, 16));
  const tData = dBMKG.t || [];
  const huData = dBMKG.hu || [];

  if (!state.grafikChart) {
    const ctx = $('#grafik-drawer').getContext('2d');
    state.grafikChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'Suhu (°C)', data: tData, borderColor: '#ef4444', backgroundColor: '#ef4444', yAxisID: 'y', tension: 0.35, pointRadius: 2 },
          { label: 'Kelembapan (%)', data: huData, borderColor: '#38bdf8', backgroundColor: '#38bdf8', yAxisID: 'y1', tension: 0.35, borderDash: [3, 3], pointRadius: 2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cbd5e1', font: { size: 9 }, boxWidth: 8 } } },
        scales: {
          x: { ticks: { color: '#94a3b8', font: { size: 8.5 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
          y: { position: 'left', ticks: { color: '#ef4444', font: { size: 8.5 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
          y1: { position: 'right', min: 0, max: 100, ticks: { color: '#38bdf8', font: { size: 8.5 } }, grid: { drawOnChartArea: false } },
        },
      },
    });
  } else {
    state.grafikChart.data.labels = labels;
    state.grafikChart.data.datasets[0].data = tData;
    state.grafikChart.data.datasets[1].data = huData;
    state.grafikChart.update();
  }
}

$('#tutup-drawer').addEventListener('click', () => {
  $('#drawer-detail').hidden = true;
  state.desaTerpilih = null;
  renderBatasWilayah();
});

// ---------------------------------------------------------------------------
// 7. Legenda Dinamis Mengambang
// ---------------------------------------------------------------------------
function updateLegenda() {
  const el = $('#legenda-wadah');
  if (!el) return;

  let title = 'Kecepatan Angin (km/j)';
  let grad = 'linear-gradient(to right, #94a3b8, #67e8f9, #0284c7, #a855f7)';
  let lMin = '0', lMax = '30+';

  if (state.variabelAktif === 'temperature') {
    title = 'Suhu Permukaan (°C)';
    grad = 'linear-gradient(to right, #38bdf8, #2dd4bf, #facc15, #fb923c, #ef4444)';
    lMin = '20°C'; lMax = '35°C';
  } else if (state.variabelAktif === 'precipitation') {
    title = 'Radar Hujan (mm/jam)';
    grad = 'linear-gradient(to right, #38bdf8, #0ea5e9, #2563eb, #ea580c, #dc2626)';
    lMin = '0 mm'; lMax = '20+ mm';
  } else if (state.variabelAktif === 'relative_humidity') {
    title = 'Kelembapan Udara (%)';
    grad = 'linear-gradient(to right, #fed7aa, #93c5fd, #3b82f6, #1e3a8a)';
    lMin = '50%'; lMax = '100%';
  } else if (state.variabelAktif === 'cloud_cover') {
    title = 'Tutupan Awan (%)';
    grad = 'linear-gradient(to right, #f8fafc, #94a3b8, #475569)';
    lMin = '0%'; lMax = '100%';
  } else if (state.variabelAktif === 'pressure') {
    title = 'Tekanan Udara (hPa)';
    grad = 'linear-gradient(to right, #f43f5e, #eab308, #06b6d4)';
    lMin = '1006'; lMax = '1014';
  }

  el.innerHTML = `
    <strong>${title}</strong>
    <div class="legenda-ramping" style="background: ${grad};"></div>
    <div class="legenda-label-ramping"><span>${lMin}</span><span>${lMax}</span></div>
  `;
}

// ---------------------------------------------------------------------------
// 8. Modal Tabel Wilayah 1.250 Desa
// ---------------------------------------------------------------------------
function setupModalTabel() {
  $('#btn-toggle-tabel').addEventListener('click', () => {
    $('#modal-tabel').hidden = false;
    renderTabelModal();
  });

  $('#tutup-modal-tabel').addEventListener('click', () => {
    $('#modal-tabel').hidden = true;
  });

  $('#modal-filter-kab').addEventListener('change', renderTabelModal);
  $('#modal-cari-desa').addEventListener('input', renderTabelModal);
}

function renderTabelModal() {
  if (!state.dataDesaGeo) return;
  const kab = $('#modal-filter-kab').value;
  const q = $('#modal-cari-desa').value.toLowerCase().trim();
  const sIdx = state.bmkgData ? cariSlotBMKGTerdekat(state.bmkgData.slots) : 0;

  const baris = [];
  state.dataDesaGeo.features.forEach((f) => {
    const p = f.properties;
    if (kab && p.kabupaten !== kab) return;
    if (q && !p.desa.toLowerCase().includes(q) && !p.kecamatan.toLowerCase().includes(q)) return;

    const dBMKG = state.bmkgData && state.bmkgData.desa ? state.bmkgData.desa[p.kode_adm4] : null;
    const kIdx = dBMKG && dBMKG.kelas ? dBMKG.kelas[sIdx] : -1;

    baris.push({
      kode: p.kode_adm4,
      desa: p.desa,
      kecamatan: p.kecamatan,
      kabupaten: p.kabupaten,
      t: dBMKG && dBMKG.t ? dBMKG.t[sIdx] : '–',
      hu: dBMKG && dBMKG.hu ? dBMKG.hu[sIdx] : '–',
      ws: dBMKG && dBMKG.ws ? dBMKG.ws[sIdx] : '–',
      cuaca: dBMKG && dBMKG.cuaca ? dBMKG.cuaca[sIdx] : '–',
      kelas: kIdx >= 0 ? KELAS_HUJAN[kIdx].nama : '–',
      warna: kIdx >= 0 ? KELAS_HUJAN[kIdx].warna : '#64748b',
    });
  });

  $('#modal-info-total').textContent = `${baris.length} Desa Ditemukan`;

  const tbody = $('#tabel-desa-modal tbody');
  if (!baris.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="kosong">Tidak ada desa yang cocok.</td></tr>';
    return;
  }

  tbody.innerHTML = baris.slice(0, 100).map((r) => `
    <tr data-kode="${r.kode}">
      <td><strong>${r.desa}</strong></td>
      <td>${r.kecamatan}</td>
      <td>${r.kabupaten}</td>
      <td class="angka">${r.t}°</td>
      <td class="angka">${r.hu}%</td>
      <td class="angka">${r.ws}</td>
      <td>${r.cuaca}</td>
      <td><span style="color:${r.warna}; font-weight:700;">●</span> ${r.kelas}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr[data-kode]').forEach((tr) => {
    tr.addEventListener('click', () => {
      $('#modal-tabel').hidden = true;
      bukaDetailDesa(tr.dataset.kode, true);
    });
  });
}

// ---------------------------------------------------------------------------
// 9. Event Listeners & Kontrol UI
// ---------------------------------------------------------------------------
function setupEventHandlers() {
  // Tombol Parameter Cuaca (Angin, Suhu, Hujan, Tekanan, dsb.)
  $$('.btn-cuaca-kartu').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.btn-cuaca-kartu').forEach((b) => b.classList.remove('aktif'));
      btn.classList.add('aktif');
      state.variabelAktif = btn.dataset.var;

      const triggerLabel = $('#label-trigger-cuaca');
      const triggerIcon = $('#btn-trigger-cuaca .icon-cuaca');
      if (triggerLabel) triggerLabel.textContent = btn.querySelector('strong').textContent;
      if (triggerIcon) triggerIcon.textContent = btn.querySelector('.icon-cuaca').textContent;

      renderGridHalus();
      updateLegenda();
    });
  });

  // Tombol Minimize & Restore Menu Cuaca (GoWeatherRadar style)
  const btnTutupKartu = $('#btn-tutup-kartu-cuaca');
  const btnTriggerCuaca = $('#btn-trigger-cuaca');
  const panelKartuCuaca = $('#panel-kartu-cuaca');

  if (btnTutupKartu && btnTriggerCuaca && panelKartuCuaca) {
    btnTutupKartu.addEventListener('click', () => {
      panelKartuCuaca.classList.add('tersembunyi');
      btnTriggerCuaca.classList.remove('tersembunyi');
    });

    btnTriggerCuaca.addEventListener('click', () => {
      btnTriggerCuaca.classList.add('tersembunyi');
      panelKartuCuaca.classList.remove('tersembunyi');
    });
  }

  // Tingkat Batas Wilayah (Kab/Kota, Kecamatan, Desa, Nonaktif)
  $$('.btn-segmen').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.btn-segmen').forEach((b) => b.classList.remove('aktif'));
      btn.classList.add('aktif');
      state.levelBatas = btn.dataset.level;
      renderBatasWilayah();
    });
  });

  // Saklar Choropleth BMKG
  $('#saklar-choropleth-bmkg').addEventListener('change', (e) => {
    state.choroplethBMKG = e.target.checked;
    renderBatasWilayah();
  });

  // Saklar Animasi Angin
  $('#saklar-angin-anim').addEventListener('change', (e) => {
    state.animasiAngin = e.target.checked;
    setupAnimasiAngin();
  });

  // Saklar Gelombang Laut
  $('#saklar-laut-anim').addEventListener('change', (e) => {
    state.tampilkanLaut = e.target.checked;
    if (layerMarine) {
      if (state.tampilkanLaut) layerMarine.addTo(peta);
      else peta.removeLayer(layerMarine);
    }
  });

  // Pemilih Hari
  $$('.btn-hari').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.btn-hari').forEach((b) => b.classList.remove('aktif'));
      btn.classList.add('aktif');
      state.hariIdx = parseInt(btn.dataset.hari, 10);
      refreshWaktu();
    });
  });

  // Slider Jam
  $('#slider-jam').addEventListener('input', (e) => {
    state.jamIdx = parseInt(e.target.value, 10);
    refreshWaktu();
  });

  // Tombol Play Animasi Waktu
  $('#btn-play-waktu').addEventListener('click', togglePlayWaktu);
}

function refreshWaktu() {
  updateLabelWaktuUI();
  renderGridHalus();
  renderBatasWilayah();
  setupAnimasiAngin();
  if (state.desaTerpilih) bukaDetailDesa(state.desaTerpilih, false);
}

function togglePlayWaktu() {
  state.isPlaying = !state.isPlaying;
  const ikon = $('#ikon-play');
  if (state.isPlaying) {
    ikon.textContent = '⏸';
    state.playTimer = setInterval(() => {
      state.jamIdx = (state.jamIdx + 1) % 24;
      if (state.jamIdx === 0) state.hariIdx = (state.hariIdx + 1) % 3;
      $$('.btn-hari').forEach((b, i) => b.classList.toggle('aktif', i === state.hariIdx));
      refreshWaktu();
    }, 1200);
  } else {
    ikon.textContent = '▶';
    if (state.playTimer) clearInterval(state.playTimer);
  }
}

// ---------------------------------------------------------------------------
// 10. Inisialisasi Data
// ---------------------------------------------------------------------------
async function init() {
  setupEventHandlers();
  setupModalTabel();
  updateLabelWaktuUI();
  updateLegenda();

  // Muat Data Batas (Kab/Kota, Kecamatan, Desa) secara paralel
  try {
    const [resDesa, resKec, resKab] = await Promise.all([
      fetch(KONFIG.batasDesa),
      fetch(KONFIG.batasKecamatan),
      fetch(KONFIG.batasKabkot),
    ]);
    if (resDesa.ok) state.dataDesaGeo = await resDesa.json();
    if (resKec.ok) state.dataKecamatanGeo = await resKec.json();
    if (resKab.ok) state.dataKabkotGeo = await resKab.json();
    renderBatasWilayah();
  } catch (err) {
    console.error('Error memuat batas wilayah:', err);
  }

  // Muat Grid Open-Meteo Luas
  try {
    const resGrid = await fetch(KONFIG.gridOpenMeteo);
    if (resGrid.ok) {
      state.gridData = await resGrid.json();
      renderGridHalus();
      setupAnimasiAngin();
    }
  } catch (err) {
    console.warn('Grid Open-Meteo belum tersedia:', err);
  }

  // Muat Data BMKG 1.250 Desa
  try {
    const resBMKG = await fetch(KONFIG.cuacaBMKG);
    if (resBMKG.ok) {
      state.bmkgData = await resBMKG.json();
      $('#label-update-status').textContent = `BMKG: ${state.bmkgData.total_desa || 0} Desa Aktif`;
      renderBatasWilayah();
    }
  } catch (err) {
    console.warn('Data BMKG belum tersedia:', err);
  }
}

init();
