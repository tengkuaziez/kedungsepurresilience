/*
 * KEDUNGSEPUR RESILIENCE - WebGIS Cuaca & Mitigasi Bencana
 * Engine Replika Windy: Kanvas Cuaca Halus, Partikel Angin Streamlines, & Timeline 96 Jam Kontinu
 */
'use strict';

const CB = '?v=5.0';
const KONFIG = {
  batasDesa: 'data/batas_keldes.geojson' + CB,
  batasKecamatan: 'data/batas_kecamatan.geojson' + CB,
  batasKabkot: 'data/batas_kabkot.geojson' + CB,
  cuacaBMKG: 'data/bmkg_latest.json' + CB,
  gridWindy: 'data/kedungsepur_windy_grid.json' + CB,
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

// Stasiun & Pos Pengamatan BMKG Resmi
const STASIUN_BMKG = [
  { nama: 'Stasiun Meteorologi Ahmad Yani', kab: 'Kota Semarang', lat: -6.974, lon: 110.375, jenis: 'Stasiun Meteorologi Bandara' },
  { nama: 'Stasiun Meteorologi Maritim Tanjung Emas', kab: 'Kota Semarang', lat: -6.954, lon: 110.422, jenis: 'Stasiun Meteorologi Maritim' },
  { nama: 'Stasiun Klimatologi Jawa Tengah', kab: 'Kota Semarang', lat: -7.009, lon: 110.354, jenis: 'Stasiun Klimatologi' },
  { nama: 'Pos Meteorologi Pertanian Salatiga', kab: 'Kota Salatiga', lat: -7.330, lon: 110.508, jenis: 'Pos Cuaca Pertanian' },
  { nama: 'Pos Pengamatan Cuaca Kendal', kab: 'Kendal', lat: -6.920, lon: 110.205, jenis: 'Pos Pengamatan Cuaca' },
  { nama: 'Pos Pengamatan Cuaca Demak', kab: 'Demak', lat: -6.894, lon: 110.639, jenis: 'Pos Pengamatan Cuaca' },
  { nama: 'Pos Pengamatan Cuaca Purwodadi', kab: 'Grobogan', lat: -7.086, lon: 110.916, jenis: 'Pos Pengamatan Cuaca' },
  { nama: 'Pos Meteorologi Ungaran', kab: 'Semarang', lat: -7.138, lon: 110.403, jenis: 'Pos Pengamatan Cuaca' },
];

// State Aplikasi
const state = {
  dataDesaGeo: null,
  dataKecamatanGeo: null,
  dataKabkotGeo: null,
  bmkgData: null,
  gridData: null,

  // Agregasi BMKG
  aggKabkot: {},
  aggKecamatan: {},

  // Parameter Aktif (Windy Model Variables)
  variabelAktif: 'temperature', // 'temperature' | 'wind_speed' | 'precipitation' | 'cloud_cover' | 'relative_humidity'
  levelBatas: 'kabkot',         // 'kabkot' | 'kecamatan' | 'desa' | 'none'
  tampilkanBatas: true,
  tampilkanPartikel: true,
  tampilkanStasiun: true,

  // Timeline Waktu Kontinu (96 jam)
  jamAktifIdx: 0,
  isPlaying: false,
  playTimer: null,

  // Wilayah Terpilih & Layer
  wilayahTerpilih: null, // { tipe: 'kabkot'|'kecamatan'|'desa', kode: string, layer: object }
  grafikChart: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------------------------------------------------------------------------
// 1. Inisialisasi Peta & Basemap Bebas Watermark
// ---------------------------------------------------------------------------
const peta = L.map('peta', {
  zoomControl: false,
  preferCanvas: true,
  attributionControl: false,
}).setView(KONFIG.pusatPeta, KONFIG.zoomAwal);

L.control.zoom({ position: 'topleft' }).addTo(peta);

const basemaps = {
  satellite: L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
  }),
  dark: L.layerGroup([
    L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16,
    }),
    L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16,
    }),
  ]),
  osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }),
};

let basemapAktif = basemaps.satellite.addTo(peta);

function gantiBasemap(tipe) {
  if (basemapAktif) peta.removeLayer(basemapAktif);
  basemapAktif = basemaps[tipe];
  basemapAktif.addTo(peta);
  $$('.btn-windy-base').forEach((btn) => {
    btn.classList.toggle('aktif', btn.dataset.base === tipe);
  });
}

const canvasRenderer = L.canvas({ padding: 0.5 });
let layerWindyOverlay = null;
let layerBatasAktif = null;
let layerStasiunBMKG = null;

// ---------------------------------------------------------------------------
// 2. Kanvas Permukaan Cuaca Halus ala Windy (Bilinear Interpolation)
// ---------------------------------------------------------------------------
function renderWindyCanvas() {
  if (!state.gridData) return;
  const d = state.gridData;
  const grid = d.grid;
  const tIdx = state.jamAktifIdx;

  const vKey = state.variabelAktif;
  const matrix = d.variables[vKey] ? d.variables[vKey][tIdx] : null;
  if (!matrix) return;

  const ny = grid.ny;
  const nx = grid.nx;
  const scale = 16; // Resolusi interpolasi canvas
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
      const rgba = getWarnaWindy(val, vKey);

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

  let opasitas = 0.70;
  if (vKey === 'cloud_cover') opasitas = 0.85;
  else if (vKey === 'precipitation') opasitas = 0.75;

  if (!layerWindyOverlay) {
    layerWindyOverlay = L.imageOverlay(canvas.toDataURL(), bounds, {
      opacity: opasitas,
      interactive: false,
    }).addTo(peta);
  } else {
    layerWindyOverlay.setBounds(bounds);
    layerWindyOverlay.setUrl(canvas.toDataURL());
    layerWindyOverlay.setOpacity(opasitas);
    if (!peta.hasLayer(layerWindyOverlay)) layerWindyOverlay.addTo(peta);
  }
}

// Skala Warna Asli ala Windy
function getWarnaWindy(v, varName) {
  if (varName === 'temperature') {
    // Skala Suhu Windy (°C)
    if (v < 18) return [30, 64, 175, 180];
    if (v < 22) return [6, 182, 212, 180];
    if (v < 25) return [16, 185, 129, 190];
    if (v < 28) return [234, 179, 8, 195];
    if (v < 31) return [249, 115, 22, 205];
    if (v < 34) return [239, 68, 68, 220];
    return [168, 85, 247, 230];
  } else if (varName === 'wind_speed') {
    // Skala Angin Windy (km/j)
    if (v < 4) return [148, 163, 184, 80];
    if (v < 10) return [56, 189, 248, 160];
    if (v < 18) return [45, 212, 191, 180];
    if (v < 26) return [250, 204, 21, 200];
    if (v < 35) return [249, 115, 22, 220];
    return [217, 70, 239, 230];
  } else if (varName === 'precipitation') {
    // Skala Hujan Radar Windy (mm)
    if (v < 0.1) return [0, 0, 0, 0];
    if (v < 1.0) return [56, 189, 248, 160];
    if (v < 3.0) return [37, 99, 235, 190];
    if (v < 8.0) return [34, 197, 94, 210];
    if (v < 16.0) return [234, 179, 8, 230];
    return [220, 38, 38, 245];
  } else if (varName === 'cloud_cover') {
    // Skala Tutupan Awan Satelit Windy (%)
    if (v < 15) return [0, 0, 0, 0];
    if (v < 40) return [255, 255, 255, 60];
    if (v < 70) return [241, 245, 249, 130];
    return [148, 163, 184, 195];
  } else if (varName === 'relative_humidity') {
    // Skala Kelembaban Udara Windy (%)
    if (v < 55) return [217, 119, 6, 160];
    if (v < 70) return [132, 204, 22, 170];
    if (v < 85) return [14, 165, 233, 190];
    return [30, 58, 138, 210];
  }
  return [56, 189, 248, 160];
}

// ---------------------------------------------------------------------------
// 3. Animasi Partikel Aliran Angin Meliuk-liuk (Wind Streamlines ala Windy)
// ---------------------------------------------------------------------------
let animPartikelFrame = null;
const partikelList = [];
const N_PARTIKEL = 220;

function setupPartikelCanvas() {
  const c = $('#canvas-partikel-angin');
  if (!c) return;
  c.width = window.innerWidth;
  c.height = window.innerHeight;

  partikelList.length = 0;
  for (let i = 0; i < N_PARTIKEL; i++) {
    partikelList.push({
      x: Math.random() * c.width,
      y: Math.random() * c.height,
      age: Math.random() * 80,
      maxAge: 40 + Math.random() * 50,
    });
  }

  if (animPartikelFrame) cancelAnimationFrame(animPartikelFrame);
  if (state.tampilkanPartikel) loopPartikel();
}

function loopPartikel() {
  const c = $('#canvas-partikel-angin');
  if (!c || !state.tampilkanPartikel || !state.gridData) {
    if (c) {
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
    }
    return;
  }

  const ctx = c.getContext('2d');
  // Fade trail khas Windy
  ctx.fillStyle = 'rgba(0, 0, 0, 0.92)';
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'source-over';

  const d = state.gridData;
  const grid = d.grid;
  const tIdx = state.jamAktifIdx;
  const uMat = d.variables.u[tIdx];
  const vMat = d.variables.v[tIdx];

  ctx.lineWidth = 1.4;
  ctx.strokeStyle = state.variabelAktif === 'wind_speed' ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.65)';
  ctx.beginPath();

  for (let i = 0; i < partikelList.length; i++) {
    const p = partikelList[i];
    const latlng = peta.containerPointToLatLng([p.x, p.y]);

    // Cari koordinat grid
    const gy = (grid.lat_max - latlng.lat) / grid.dlat;
    const gx = (latlng.lng - grid.lon_min) / grid.dlon;

    if (gy >= 0 && gy < grid.ny - 1 && gx >= 0 && gx < grid.nx - 1) {
      const r0 = Math.floor(gy);
      const c0 = Math.floor(gx);
      const u = uMat[r0] ? uMat[r0][c0] || 0 : 0;
      const v = vMat[r0] ? vMat[r0][c0] || 0 : 0;

      // Geser titik layar sesuai vektor angin
      const dx = u * 1.2;
      const dy = -v * 1.2;

      ctx.moveTo(p.x, p.y);
      p.x += dx;
      p.y += dy;
      ctx.lineTo(p.x, p.y);
    }

    p.age++;
    if (p.age > p.maxAge || p.x < 0 || p.x > c.width || p.y < 0 || p.y > c.height) {
      p.x = Math.random() * c.width;
      p.y = Math.random() * c.height;
      p.age = 0;
    }
  }

  ctx.stroke();
  animPartikelFrame = requestAnimationFrame(loopPartikel);
}

// ---------------------------------------------------------------------------
// 4. Batas Wilayah Kedungsepur (Kab/Kota, Kecamatan, Desa) & Zoom to Layer
// ---------------------------------------------------------------------------
function renderBatasWilayah() {
  if (layerBatasAktif) {
    peta.removeLayer(layerBatasAktif);
    layerBatasAktif = null;
  }

  if (state.levelBatas === 'none' || !state.tampilkanBatas) return;

  let geojson = null;
  if (state.levelBatas === 'kabkot') geojson = state.dataKabkotGeo;
  else if (state.levelBatas === 'kecamatan') geojson = state.dataKecamatanGeo;
  else if (state.levelBatas === 'desa') geojson = state.dataDesaGeo;

  if (!geojson) return;

  const sBMKG = cariIndexBMKG();

  layerBatasAktif = L.geoJSON(geojson, {
    renderer: canvasRenderer,
    style: (feature) => {
      const p = feature.properties;
      const kode = p.kode_adm4 || p.kode;
      const isSelected = state.wilayahTerpilih && state.wilayahTerpilih.kode === kode;

      let strokeColor = '#38bdf8';
      let weight = 1.0;
      let fill = 'transparent';
      let fillOp = 0;

      if (state.levelBatas === 'kabkot') {
        strokeColor = '#38bdf8';
        weight = 2.4;
        fill = '#0284c7';
        fillOp = 0.08;
      } else if (state.levelBatas === 'kecamatan') {
        strokeColor = 'rgba(56, 189, 248, 0.7)';
        weight = 1.2;
      } else if (state.levelBatas === 'desa') {
        strokeColor = 'rgba(255, 255, 255, 0.3)';
        weight = 0.6;
      }

      if (isSelected) {
        strokeColor = '#facc15';
        weight = 3.6;
        fill = '#facc15';
        fillOp = 0.25;
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
      const kode = p.kode_adm4 || p.kode;

      // Label Nama Kabupaten/Kota di Peta
      if (state.levelBatas === 'kabkot' && p.kabupaten) {
        const d = state.aggKabkot[kode];
        const valStr = d && d.rata_t[sBMKG] !== undefined ? ` • ${d.rata_t[sBMKG]}°C` : '';
        layer.bindTooltip(`🏛️ ${p.kabupaten.toUpperCase()}${valStr}`, {
          permanent: true,
          direction: 'center',
          className: 'label-kabkot'
        });
      }

      layer.on({
        click: () => {
          pilihDanZoomWilayah(state.levelBatas, kode, p, layer);
        },
        mouseover: () => {
          layer.setStyle({ weight: 3.2, color: '#facc15' });
        },
        mouseout: () => {
          if (layerBatasAktif) layerBatasAktif.resetStyle(layer);
        },
      });
    },
  }).addTo(peta);
}

// Fitur Zoom to Layer
function pilihDanZoomWilayah(tipe, kode, p, layer) {
  state.wilayahTerpilih = { tipe, kode, props: p, layer };

  // Terbang halus ke batas poligon (Zoom to Layer)
  if (layer && typeof layer.getBounds === 'function') {
    const pad = tipe === 'desa' ? [60, 60] : [40, 40];
    const maxZ = tipe === 'desa' ? 15 : tipe === 'kecamatan' ? 13 : 11;
    peta.flyToBounds(layer.getBounds(), { padding: pad, maxZoom: maxZ, duration: 0.8 });
  }

  bukaDetailWilayah(tipe, kode, p);
  renderBatasWilayah();
}

// ---------------------------------------------------------------------------
// 5. Drawer Detail Wilayah & Grafik Chart.js
// ---------------------------------------------------------------------------
function bukaDetailWilayah(tipe, kode, p) {
  const drawer = $('#drawer-detail');
  const sBMKG = cariIndexBMKG();
  const tIdx = state.jamAktifIdx;

  let namaJudul = '';
  let subWilayah = '';
  let tempTeks = '--°C';
  let cuacaTeks = 'Cerah Berawan';
  let tagTeks = 'Tidak hujan';
  let huTeks = '--%';
  let wsTeks = '-- km/j';
  let tccTeks = '--%';
  let curahTeks = '0.0 mm';
  let cakupanTeks = '';

  let chartLabels = [];
  let chartTemp = [];
  let chartHu = [];

  // Ambil data per jam dari Grid Windy jika tersedia
  if (state.gridData) {
    const times = state.gridData.times;
    chartLabels = times.map((t) => t.substring(11, 16));

    // Sample titik tengah wilayah
    if (tipe === 'kabkot') {
      const d = state.aggKabkot[kode];
      namaJudul = p.kabupaten || 'Kabupaten/Kota';
      subWilayah = 'Kawasan Kedungsepur, Jawa Tengah';
      $('#drawer-tingkat').textContent = 'KABUPATEN/KOTA';
      cakupanTeks = `Cakupan: ${d ? d.count : 0} Desa Teragregasi`;

      if (d) {
        tempTeks = `${d.rata_t[sBMKG]}°C`;
        cuacaTeks = d.cuaca_dominan[sBMKG] || 'Cerah';
        tagTeks = KELAS_HUJAN[d.kelas[sBMKG]]?.nama || 'Rata-rata';
        huTeks = `${d.rata_hu[sBMKG]}%`;
        wsTeks = `${d.rata_ws[sBMKG]} km/j`;
        tccTeks = `${d.rata_tcc[sBMKG]}%`;
        curahTeks = d.hujanCount[sBMKG] > 0 ? `${d.hujanCount[sBMKG]} desa hujan` : '0 mm';
        chartTemp = times.map((_, i) => d.rata_t[Math.min(i % 17, d.rata_t.length - 1)]);
        chartHu = times.map((_, i) => d.rata_hu[Math.min(i % 17, d.rata_hu.length - 1)]);
      }
    } else if (tipe === 'kecamatan') {
      const d = state.aggKecamatan[kode];
      namaJudul = `Kecamatan ${p.kecamatan || ''}`;
      subWilayah = `Kabupaten/Kota: ${p.kabupaten || ''}`;
      $('#drawer-tingkat').textContent = 'KECAMATAN';
      cakupanTeks = `Cakupan: ${d ? d.count : 0} Desa Teragregasi`;

      if (d) {
        tempTeks = `${d.rata_t[sBMKG]}°C`;
        cuacaTeks = d.cuaca_dominan[sBMKG] || 'Cerah';
        tagTeks = KELAS_HUJAN[d.kelas[sBMKG]]?.nama || 'Rata-rata';
        huTeks = `${d.rata_hu[sBMKG]}%`;
        wsTeks = `${d.rata_ws[sBMKG]} km/j`;
        tccTeks = `${d.rata_tcc[sBMKG]}%`;
        curahTeks = d.hujanCount[sBMKG] > 0 ? `${d.hujanCount[sBMKG]} desa hujan` : '0 mm';
        chartTemp = times.map((_, i) => d.rata_t[Math.min(i % 17, d.rata_t.length - 1)]);
        chartHu = times.map((_, i) => d.rata_hu[Math.min(i % 17, d.rata_hu.length - 1)]);
      }
    } else {
      // Desa
      const d = state.bmkgData && state.bmkgData.desa ? state.bmkgData.desa[kode] : null;
      namaJudul = p.desa || 'Desa/Kelurahan';
      subWilayah = `Kec. ${p.kecamatan || ''}, ${p.kabupaten || ''}`;
      $('#drawer-tingkat').textContent = 'DESA / KELURAHAN';
      cakupanTeks = `Kode Adm4: ${kode}`;

      if (d) {
        tempTeks = `${d.t[sBMKG]}°C`;
        cuacaTeks = d.cuaca[sBMKG] || 'Cerah';
        tagTeks = KELAS_HUJAN[d.kelas[sBMKG]]?.nama || 'Tidak hujan';
        huTeks = `${d.hu[sBMKG]}%`;
        wsTeks = `${d.ws[sBMKG]} km/j (${d.wd ? d.wd[sBMKG] : ''})`;
        tccTeks = `${d.tcc ? d.tcc[sBMKG] : 0}%`;
        curahTeks = d.kelas[sBMKG] > 0 ? 'Potensi hujan' : '0.0 mm';
        chartTemp = times.map((_, i) => d.t[Math.min(i % 17, d.t.length - 1)]);
        chartHu = times.map((_, i) => d.hu[Math.min(i % 17, d.hu.length - 1)]);
      }
    }
  }

  $('#drawer-nama').textContent = namaJudul;
  $('#drawer-wilayah').textContent = subWilayah;
  $('#drawer-temp').textContent = tempTeks;
  $('#drawer-kondisi').textContent = cuacaTeks;
  $('#drawer-kelas-hujan').textContent = tagTeks;
  $('#drawer-hu').textContent = huTeks;
  $('#drawer-ws').textContent = wsTeks;
  $('#drawer-tcc').textContent = tccTeks;
  $('#drawer-curah-hujan').textContent = curahTeks;
  $('#drawer-cakupan').textContent = cakupanTeks;

  drawer.hidden = false;
  renderGrafikDrawer(chartLabels, chartTemp, chartHu, tIdx);
}

function renderGrafikDrawer(labels, suhu, hu, activeHourIdx) {
  const ctx = document.getElementById('grafik-drawer');
  if (!ctx) return;
  if (state.grafikChart) {
    state.grafikChart.destroy();
    state.grafikChart = null;
  }

  // Tampilkan hanya subset 24 jam sekitar waktu aktif agar grafik tidak terlalu padat
  const start = Math.max(0, activeHourIdx - 12);
  const end = Math.min(labels.length, start + 24);
  const subLabels = labels.slice(start, end);
  const subSuhu = suhu.slice(start, end);
  const subHu = hu.slice(start, end);
  const localActive = activeHourIdx - start;

  const pointBgSuhu = subSuhu.map((_, i) => i === localActive ? '#fff' : '#ef4444');
  const pointRadSuhu = subSuhu.map((_, i) => i === localActive ? 5 : 2);

  state.grafikChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: subLabels,
      datasets: [
        {
          label: 'Suhu (°C)',
          data: subSuhu,
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          pointBackgroundColor: pointBgSuhu,
          pointRadius: pointRadSuhu,
          tension: 0.35,
          yAxisID: 'ySuhu',
        },
        {
          label: 'Kelembapan (%)',
          data: subHu,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56, 189, 248, 0.1)',
          pointRadius: 2,
          tension: 0.35,
          yAxisID: 'yHu',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { size: 9 } } },
      },
      scales: {
        x: { ticks: { color: '#64748b', font: { size: 8 } } },
        ySuhu: {
          type: 'linear',
          position: 'left',
          ticks: { color: '#ef4444', font: { size: 8 } },
        },
        yHu: {
          type: 'linear',
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#38bdf8', font: { size: 8 } },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 6. Timeline Bar ala Windy (96 Jam Kontinu, Play/Pause, & Skala Warna)
// ---------------------------------------------------------------------------
function setupWindyTimeline() {
  if (!state.gridData || !state.gridData.times) return;
  const times = state.gridData.times;
  const nHours = times.length;

  const slider = $('#windy-time-slider');
  slider.min = 0;
  slider.max = nHours - 1;

  // Render Header Hari (Min, Sen, Sel, Rab)
  const headerWadah = $('#windy-days-header');
  const daysMap = {};
  times.forEach((tStr, idx) => {
    const tgl = tStr.split('T')[0];
    if (!daysMap[tgl]) {
      const d = new Date(tStr + '+07:00');
      const namaHari = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'][d.getDay()];
      daysMap[tgl] = { tgl, label: `${namaHari} ${d.getDate()}`, startIdx: idx };
    }
  });

  const nowIso = new Date().toISOString().substring(0, 10);
  headerWadah.innerHTML = Object.values(daysMap).map((d) => `
    <div class="windy-day-pill ${d.tgl === nowIso ? 'hari-ini' : ''}">${d.label}</div>
  `).join('');

  // Render Ticks Jam (tiap 6 jam)
  const ticksWadah = $('#windy-hours-ticks');
  ticksWadah.innerHTML = times.filter((_, i) => i % 6 === 0).map((tStr) => `
    <span>${tStr.substring(11, 16)}</span>
  `).join('');

  // Cari jam saat ini untuk default slider
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const curStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
  let bestIdx = times.indexOf(curStr);
  if (bestIdx < 0) bestIdx = 24; // Hari ini jam awal jika tidak cocok

  slider.value = bestIdx;
  state.jamAktifIdx = bestIdx;

  slider.addEventListener('input', (e) => {
    state.jamAktifIdx = parseInt(e.target.value, 10);
    updateWaktuUI();
  });

  // Tombol Play / Pause Otomatis
  $('#btn-play-windy').addEventListener('click', togglePlayWindy);

  updateWaktuUI();
  updateSkalaWarnaWindy();
}

function updateWaktuUI() {
  if (!state.gridData || !state.gridData.times) return;
  const tStr = state.gridData.times[state.jamAktifIdx];
  const d = new Date(tStr + '+07:00');

  const teksTgl = d.toLocaleDateString('id-ID', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  });
  const jamTeks = tStr.substring(11, 16) + ' WIB';

  $('#windy-waktu-display').textContent = `${teksTgl} • ${jamTeks}`;
  $('#windy-time-slider').value = state.jamAktifIdx;

  renderWindyCanvas();
  renderBatasWilayah();

  if (state.wilayahTerpilih) {
    bukaDetailWilayah(state.wilayahTerpilih.tipe, state.wilayahTerpilih.kode, state.wilayahTerpilih.props);
  }
}

function togglePlayWindy() {
  state.isPlaying = !state.isPlaying;
  const ikon = $('#ikon-play');
  if (state.isPlaying) {
    ikon.textContent = '⏸';
    state.playTimer = setInterval(() => {
      const max = state.gridData.times.length - 1;
      state.jamAktifIdx = (state.jamAktifIdx + 1) % (max + 1);
      updateWaktuUI();
    }, 1200);
  } else {
    ikon.textContent = '▶';
    if (state.playTimer) clearInterval(state.playTimer);
  }
}

function cariIndexBMKG() {
  if (!state.gridData || !state.bmkgData || !state.bmkgData.slots) return 0;
  const curTimeStr = state.gridData.times[state.jamAktifIdx];
  const targetTime = new Date(curTimeStr + '+07:00').getTime();

  let best = 0, minDiff = Infinity;
  for (let i = 0; i < state.bmkgData.slots.length; i++) {
    const sTime = new Date(state.bmkgData.slots[i].replace(' ', 'T') + '+07:00').getTime();
    const diff = Math.abs(sTime - targetTime);
    if (diff < minDiff) { minDiff = diff; best = i; }
  }
  return best;
}

// Skala Warna Gradien Asli ala Windy
function updateSkalaWarnaWindy() {
  const strip = $('#windy-gradient-strip');
  const labels = $('#windy-gradient-labels');
  if (!strip || !labels) return;

  const vKey = state.variabelAktif;
  if (vKey === 'temperature') {
    strip.style.background = 'linear-gradient(to right, #1e40af, #06b6d4, #10b981, #eab308, #f97316, #ef4444, #a855f7)';
    labels.innerHTML = '<span>15°</span><span>20°</span><span>25°</span><span>30°</span><span>35°</span><span>40°C</span>';
  } else if (vKey === 'wind_speed') {
    strip.style.background = 'linear-gradient(to right, #94a3b8, #38bdf8, #2dd4bf, #facc15, #f97316, #d946ef)';
    labels.innerHTML = '<span>0</span><span>10</span><span>20</span><span>30</span><span>40 km/j</span>';
  } else if (vKey === 'precipitation') {
    strip.style.background = 'linear-gradient(to right, rgba(255,255,255,0.1), #38bdf8, #2563eb, #22c55e, #eab308, #dc2626)';
    labels.innerHTML = '<span>0</span><span>1</span><span>4</span><span>10</span><span>25 mm</span>';
  } else if (vKey === 'cloud_cover') {
    strip.style.background = 'linear-gradient(to right, rgba(255,255,255,0.05), #ffffff, #cbd5e1, #64748b)';
    labels.innerHTML = '<span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>';
  } else if (vKey === 'relative_humidity') {
    strip.style.background = 'linear-gradient(to right, #d97706, #84cc16, #0ea5e9, #1e3a8a)';
    labels.innerHTML = '<span>40%</span><span>60%</span><span>80%</span><span>100%</span>';
  }
}

// ---------------------------------------------------------------------------
// 7. Agregasi BMKG & Stasiun Pengamatan
// ---------------------------------------------------------------------------
function bangunAgregasiBMKG(bmkg) {
  if (!bmkg || !bmkg.desa || !bmkg.slots) return;
  const slots = bmkg.slots;
  const nSlots = slots.length;
  const desaMap = bmkg.desa;

  state.aggKabkot = {};
  state.aggKecamatan = {};

  for (const [kode, val] of Object.entries(desaMap)) {
    const kabKode = kode.substring(0, 5);
    const kecKode = kode.substring(0, 8);

    if (!state.aggKabkot[kabKode]) {
      state.aggKabkot[kabKode] = {
        kode: kabKode,
        kab: val.kab || 'Kabupaten',
        count: 0,
        t: new Array(nSlots).fill(0),
        hu: new Array(nSlots).fill(0),
        ws: new Array(nSlots).fill(0),
        tcc: new Array(nSlots).fill(0),
        hujanCount: new Array(nSlots).fill(0),
        cuacaDist: Array.from({ length: nSlots }, () => ({})),
      };
    }
    const kab = state.aggKabkot[kabKode];
    kab.count++;

    if (!state.aggKecamatan[kecKode]) {
      state.aggKecamatan[kecKode] = {
        kode: kecKode,
        kec: val.kec || 'Kecamatan',
        kab: val.kab || '',
        count: 0,
        t: new Array(nSlots).fill(0),
        hu: new Array(nSlots).fill(0),
        ws: new Array(nSlots).fill(0),
        tcc: new Array(nSlots).fill(0),
        hujanCount: new Array(nSlots).fill(0),
        cuacaDist: Array.from({ length: nSlots }, () => ({})),
      };
    }
    const kec = state.aggKecamatan[kecKode];
    kec.count++;

    for (let s = 0; s < nSlots; s++) {
      const tVal = val.t ? val.t[s] : 28;
      const huVal = val.hu ? val.hu[s] : 75;
      const wsVal = val.ws ? val.ws[s] : 8;
      const tccVal = val.tcc ? val.tcc[s] : 40;
      const cDesc = (val.cuaca && val.cuaca[s]) || 'Berawan';
      const isHujan = val.kelas && val.kelas[s] > 0;

      kab.t[s] += tVal;
      kab.hu[s] += huVal;
      kab.ws[s] += wsVal;
      kab.tcc[s] += tccVal;
      if (isHujan) kab.hujanCount[s]++;
      kab.cuacaDist[s][cDesc] = (kab.cuacaDist[s][cDesc] || 0) + 1;

      kec.t[s] += tVal;
      kec.hu[s] += huVal;
      kec.ws[s] += wsVal;
      kec.tcc[s] += tccVal;
      if (isHujan) kec.hujanCount[s]++;
      kec.cuacaDist[s][cDesc] = (kec.cuacaDist[s][cDesc] || 0) + 1;
    }
  }

  function selesaikan(aggObj) {
    for (const item of Object.values(aggObj)) {
      const c = item.count || 1;
      item.rata_t = item.t.map((v) => Math.round((v / c) * 10) / 10);
      item.rata_hu = item.hu.map((v) => Math.round(v / c));
      item.rata_ws = item.ws.map((v) => Math.round((v / c) * 10) / 10);
      item.rata_tcc = item.tcc.map((v) => Math.round(v / c));
      item.cuaca_dominan = item.cuacaDist.map((dist) => {
        let maxK = 'Cerah Berawan', maxV = -1;
        for (const [k, v] of Object.entries(dist)) {
          if (v > maxV) { maxV = v; maxK = k; }
        }
        return maxK;
      });
      item.kelas = item.hujanCount.map((hc) => {
        if (hc === 0) return 0;
        const rasio = hc / c;
        if (rasio < 0.2) return 1;
        if (rasio < 0.5) return 2;
        return 3;
      });
    }
  }

  selesaikan(state.aggKabkot);
  selesaikan(state.aggKecamatan);
}

function renderStasiunBMKG() {
  if (layerStasiunBMKG) {
    peta.removeLayer(layerStasiunBMKG);
    layerStasiunBMKG = null;
  }

  if (!state.tampilkanStasiun) return;

  const markers = [];
  for (const st of STASIUN_BMKG) {
    const icon = L.divIcon({
      className: 'custom-div-icon',
      html: `<div class="marker-pos-bmkg" title="${st.nama}">📡</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    const m = L.marker([st.lat, st.lon], { icon: icon });
    m.bindPopup(`
      <div style="font-family:sans-serif; min-width:180px;">
        <span style="font-size:10px; font-weight:700; color:#0284c7; text-transform:uppercase;">${st.jenis}</span>
        <h4 style="margin:2px 0 4px; font-size:13px; color:#0f172a;">${st.nama}</h4>
        <p style="margin:0; font-size:11px; color:#64748b;">Wilayah: ${st.kab}</p>
        <div style="margin-top:6px; padding:4px 6px; background:#f1f5f9; border-radius:4px; font-size:11px; color:#334155;">
          Stasiun Cuaca Aktif BMKG Kedungsepur
        </div>
      </div>
    `);
    markers.push(m);
  }

  layerStasiunBMKG = L.layerGroup(markers).addTo(peta);
}

// ---------------------------------------------------------------------------
// 8. Modal Tabel Pantauan 1.250 Desa & Zoom To Layer
// ---------------------------------------------------------------------------
function setupModalTabel() {
  $('#btn-toggle-tabel').addEventListener('click', () => {
    $('#modal-tabel').hidden = false;
    renderTabelDesa();
  });

  $('#tutup-modal-tabel').addEventListener('click', () => {
    $('#modal-tabel').hidden = true;
  });

  $('#modal-filter-kab').addEventListener('change', renderTabelDesa);
  $('#modal-cari-desa').addEventListener('input', renderTabelDesa);
}

function renderTabelDesa() {
  if (!state.bmkgData || !state.bmkgData.desa) return;
  const sBMKG = cariIndexBMKG();
  const fKab = $('#modal-filter-kab').value.toLowerCase();
  const fCari = $('#modal-cari-desa').value.toLowerCase();
  const tbody = $('#tabel-desa-modal tbody');

  const rows = [];
  for (const [kode, d] of Object.entries(state.bmkgData.desa)) {
    const desa = d.desa || '';
    const kec = d.kec || '';
    const kab = d.kab || '';

    if (fKab && !kab.toLowerCase().includes(fKab)) continue;
    if (fCari && !desa.toLowerCase().includes(fCari) && !kec.toLowerCase().includes(fCari)) continue;

    const t = d.t ? d.t[sBMKG] : '--';
    const hu = d.hu ? d.hu[sBMKG] : '--';
    const ws = d.ws ? d.ws[sBMKG] : '--';
    const cuaca = d.cuaca ? d.cuaca[sBMKG] : '--';

    rows.push(`
      <tr data-kode="${kode}">
        <td><strong>${desa}</strong></td>
        <td>${kec}</td>
        <td>${kab}</td>
        <td class="angka">${t}°C</td>
        <td class="angka">${hu}%</td>
        <td class="angka">${ws}</td>
        <td>${cuaca}</td>
        <td><button type="button" class="btn-zoom-layer" data-kode="${kode}">🔍 Zoom</button></td>
      </tr>
    `);
  }

  tbody.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="8" class="kosong">Tidak ada desa yang cocok.</td></tr>';
  $('#modal-info-total').textContent = `${rows.length} Desa Terfilter`;

  tbody.querySelectorAll('tr[data-kode]').forEach((tr) => {
    tr.addEventListener('click', () => {
      $('#modal-tabel').hidden = true;
      const kode = tr.dataset.kode;
      const d = state.bmkgData.desa[kode];
      if (d && d.lat && d.lon) {
        peta.flyTo([d.lat, d.lon], 14, { duration: 0.8 });
        bukaDetailWilayah('desa', kode, { desa: d.desa, kecamatan: d.kec, kabupaten: d.kab });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 9. Event Listeners & Kontrol Cepat
// ---------------------------------------------------------------------------
function setupEventHandlers() {
  // Tingkat Wilayah (Topbar)
  $$('.btn-segmen-w').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.btn-segmen-w').forEach((b) => b.classList.remove('aktif'));
      btn.classList.add('aktif');
      state.levelBatas = btn.dataset.level;
      renderBatasWilayah();
    });
  });

  // Parameter Cuaca (Sidebar Kanan ala Windy)
  $$('.btn-windy-layer').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.btn-windy-layer').forEach((b) => b.classList.remove('aktif'));
      btn.classList.add('aktif');
      state.variabelAktif = btn.dataset.var;

      renderWindyCanvas();
      updateSkalaWarnaWindy();
      if (state.wilayahTerpilih) {
        bukaDetailWilayah(state.wilayahTerpilih.tipe, state.wilayahTerpilih.kode, state.wilayahTerpilih.props);
      }
    });
  });

  // Basemap (Sidebar Kanan)
  $$('.btn-windy-base').forEach((btn) => {
    btn.addEventListener('click', () => {
      gantiBasemap(btn.dataset.base);
    });
  });

  // Saklar-saklar Topbar
  $('#saklar-batas').addEventListener('change', (e) => {
    state.tampilkanBatas = e.target.checked;
    renderBatasWilayah();
  });

  $('#saklar-partikel-angin').addEventListener('change', (e) => {
    state.tampilkanPartikel = e.target.checked;
    if (state.tampilkanPartikel) loopPartikel();
  });

  $('#saklar-stasiun-bmkg').addEventListener('change', (e) => {
    state.tampilkanStasiun = e.target.checked;
    renderStasiunBMKG();
  });

  // Tombol Zoom to Layer di Drawer
  $('#btn-zoom-drawer').addEventListener('click', () => {
    if (state.wilayahTerpilih && state.wilayahTerpilih.layer) {
      peta.flyToBounds(state.wilayahTerpilih.layer.getBounds(), { padding: [50, 50], maxZoom: 14, duration: 0.8 });
    }
  });

  // Tutup Drawer
  $('#tutup-drawer').addEventListener('click', () => {
    $('#drawer-detail').hidden = true;
    state.wilayahTerpilih = null;
    renderBatasWilayah();
  });

  // Resize window
  window.addEventListener('resize', () => {
    setupPartikelCanvas();
  });
}

// ---------------------------------------------------------------------------
// 10. Inisialisasi Data Paralel
// ---------------------------------------------------------------------------
async function init() {
  setupEventHandlers();
  setupModalTabel();
  renderStasiunBMKG();

  // 1. Muat Grid Numerik Windy (539 KB)
  try {
    const resGrid = await fetch(KONFIG.gridWindy);
    if (resGrid.ok) {
      state.gridData = await resGrid.json();
      setupWindyTimeline();
      setupPartikelCanvas();
      renderWindyCanvas();
    }
  } catch (err) {
    console.error('Error memuat model grid Windy:', err);
  }

  // 2. Muat Data BMKG 1.250 Desa
  try {
    const resBMKG = await fetch(KONFIG.cuacaBMKG);
    if (resBMKG.ok) {
      state.bmkgData = await resBMKG.json();
      bangunAgregasiBMKG(state.bmkgData);
    }
  } catch (err) {
    console.warn('Data BMKG gagal dimuat:', err);
  }

  // 3. Muat Batas Wilayah Spasial
  try {
    const [resKab, resKec, resDesa] = await Promise.all([
      fetch(KONFIG.batasKabkot),
      fetch(KONFIG.batasKecamatan),
      fetch(KONFIG.batasDesa),
    ]);
    if (resKab.ok) state.dataKabkotGeo = await resKab.json();
    if (resKec.ok) state.dataKecamatanGeo = await resKec.json();
    if (resDesa.ok) state.dataDesaGeo = await resDesa.json();

    renderBatasWilayah();
  } catch (err) {
    console.error('Error memuat batas wilayah:', err);
  }
}

init();
