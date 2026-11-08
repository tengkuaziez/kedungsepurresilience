/*
 * KEDUNGSEPUR RESILIENCE - WebGIS Cuaca & Mitigasi Bencana
 * Tata Letak Terpadu (Unified Layout) & Sinkronisasi Slot BMKG Real-Time
 */
'use strict';

const CB = '?v=4.0';
const KONFIG = {
  batasDesa: 'data/batas_keldes.geojson' + CB,
  batasKecamatan: 'data/batas_kecamatan.geojson' + CB,
  batasKabkot: 'data/batas_kabkot.geojson' + CB,
  cuacaBMKG: 'data/bmkg_latest.json' + CB,
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

  // Agregasi BMKG
  aggKabkot: {},
  aggKecamatan: {},

  // Struktur Hari & Slot BMKG Dinamis
  jadwalHari: [],    // [{ tanggal: '2026-11-08', label: 'Hari Ini (8 Nov)', slots: [{ idx: 0, jam: '22:00', waktu: '...' }] }]
  hariAktifIdx: 0,   // Index hari aktif dalam jadwalHari
  slotAktifIdx: 0,   // Index slot mutlak (0 .. 16) yang sedang aktif

  variabelAktif: 'temperature', // 'temperature' | 'precipitation' | 'wind' | 'relative_humidity' | 'cloud_cover'
  levelBatas: 'kabkot',         // 'kabkot' | 'kecamatan' | 'desa'
  choroplethBMKG: true,
  tampilkanStasiun: true,

  wilayahTerpilih: null, // { tipe: 'kabkot'|'kecamatan'|'desa', kode: string, props: object }
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
  $$('.btn-tool-base').forEach((btn) => {
    btn.classList.toggle('aktif', btn.dataset.base === tipe);
  });
}

const canvasRenderer = L.canvas({ padding: 0.5 });
let layerBatasAktif = null;
let layerStasiunBMKG = null;

// ---------------------------------------------------------------------------
// 2. Mesin Penjadwalan Slot BMKG Dinamis
// ---------------------------------------------------------------------------
function susunJadwalBMKG(slots) {
  if (!slots || !slots.length) return [];
  const hariMap = {};

  const namaHari = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const namaBulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  slots.forEach((s, idx) => {
    const parts = s.split(' ');
    const tgl = parts[0];
    const jam = parts[1].substring(0, 5);

    if (!hariMap[tgl]) {
      const dObj = new Date(tgl + 'T00:00:00');
      const hariKe = Object.keys(hariMap).length;
      let labelHari = `${dObj.getDate()} ${namaBulan[dObj.getMonth()]}`;
      if (hariKe === 0) labelHari = `Hari Ini (${labelHari})`;
      else if (hariKe === 1) labelHari = `Besok (${labelHari})`;
      else if (hariKe === 2) labelHari = `Lusa (${labelHari})`;

      hariMap[tgl] = {
        tanggal: tgl,
        label: labelHari,
        slots: [],
      };
    }
    hariMap[tgl].slots.push({ idx, jam, s });
  });

  return Object.values(hariMap);
}

function renderUIWaktuBMKG() {
  const wadahHari = $('#wadah-tombol-hari');
  const wadahJam = $('#wadah-tombol-jam');
  if (!wadahHari || !wadahJam || !state.jadwalHari.length) return;

  // Render Tombol Hari
  wadahHari.innerHTML = state.jadwalHari.map((h, hIdx) => `
    <button type="button" class="btn-hari-bmkg ${hIdx === state.hariAktifIdx ? 'aktif' : ''}" data-hidx="${hIdx}">
      ${h.label}
    </button>
  `).join('');

  wadahHari.querySelectorAll('.btn-hari-bmkg').forEach((btn) => {
    btn.addEventListener('click', () => {
      const hIdx = parseInt(btn.dataset.hidx, 10);
      state.hariAktifIdx = hIdx;
      // Default pilih slot pertama di hari tersebut
      const hariData = state.jadwalHari[hIdx];
      if (hariData && hariData.slots.length) {
        pilihSlot(hariData.slots[0].idx);
      }
    });
  });

  renderTombolJam();
}

function renderTombolJam() {
  const wadahJam = $('#wadah-tombol-jam');
  const hariData = state.jadwalHari[state.hariAktifIdx];
  if (!wadahJam || !hariData) return;

  wadahJam.innerHTML = hariData.slots.map((item) => `
    <button type="button" class="btn-jam-bmkg ${item.idx === state.slotAktifIdx ? 'aktif' : ''}" data-sidx="${item.idx}">
      ${item.jam} WIB
    </button>
  `).join('');

  wadahJam.querySelectorAll('.btn-jam-bmkg').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sIdx = parseInt(btn.dataset.sidx, 10);
      pilihSlot(sIdx);
    });
  });

  updateBadgeWaktuAktif();
}

function pilihSlot(sIdx) {
  state.slotAktifIdx = sIdx;

  // Pastikan hariAktifIdx selaras dengan slot yang dipilih
  state.jadwalHari.forEach((h, hIdx) => {
    if (h.slots.some((it) => it.idx === sIdx)) {
      state.hariAktifIdx = hIdx;
    }
  });

  // Update UI Tombol
  $$('.btn-hari-bmkg').forEach((b, i) => b.classList.toggle('aktif', i === state.hariAktifIdx));
  renderTombolJam();

  // Update Peta & Drawer Secara Seketika
  renderBatasWilayah();
  if (state.wilayahTerpilih) {
    bukaDetailWilayah(state.wilayahTerpilih.tipe, state.wilayahTerpilih.kode, state.wilayahTerpilih.props);
  }
}

function updateBadgeWaktuAktif() {
  const badge = $('#badge-waktu-aktif');
  if (!badge || !state.bmkgData || !state.bmkgData.slots) return;
  const sStr = state.bmkgData.slots[state.slotAktifIdx];
  if (!sStr) return;

  const d = new Date(sStr.replace(' ', 'T') + '+07:00');
  const teksTgl = d.toLocaleDateString('id-ID', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  });
  const jamTeks = sStr.split(' ')[1].substring(0, 5) + ' WIB';
  badge.textContent = `${teksTgl} • ${jamTeks}`;
}

// ---------------------------------------------------------------------------
// 3. Mesin Agregasi Data BMKG (Kabupaten/Kota & Kecamatan)
// ---------------------------------------------------------------------------
function bangunAgregasiBMKG(bmkg) {
  if (!bmkg || !bmkg.desa || !bmkg.slots) return;
  const slots = bmkg.slots;
  const nSlots = slots.length;
  const desaMap = bmkg.desa;

  state.aggKabkot = {};
  state.aggKecamatan = {};

  for (const [kode, val] of Object.entries(desaMap)) {
    const kabKode = kode.substring(0, 5); // 33.xx
    const kecKode = kode.substring(0, 8); // 33.xx.yy

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

// ---------------------------------------------------------------------------
// 4. Skema Warna Cuaca Berdasarkan Parameter
// ---------------------------------------------------------------------------
function getWarnaCuacaNilai(param, val, kelasHujan) {
  if (param === 'precipitation') {
    return KELAS_HUJAN[kelasHujan]?.warna || '#64748b';
  } else if (param === 'temperature') {
    if (val < 22) return '#38bdf8';
    if (val < 25) return '#34d399';
    if (val < 28) return '#facc15';
    if (val < 32) return '#fb923c';
    return '#ef4444';
  } else if (param === 'relative_humidity') {
    if (val < 65) return '#fdba74';
    if (val < 75) return '#67e8f9';
    if (val < 85) return '#38bdf8';
    return '#1d4ed8';
  } else if (param === 'wind') {
    if (val < 5) return '#94a3b8';
    if (val < 10) return '#38bdf8';
    if (val < 15) return '#0284c7';
    return '#a855f7';
  } else if (param === 'cloud_cover') {
    if (val < 30) return '#fde047';
    if (val < 60) return '#93c5fd';
    if (val < 85) return '#64748b';
    return '#334155';
  }
  return '#38bdf8';
}

// ---------------------------------------------------------------------------
// 5. Render Poligon Batas Wilayah (Kabkot, Kecamatan, Desa)
// ---------------------------------------------------------------------------
function renderBatasWilayah() {
  if (layerBatasAktif) {
    peta.removeLayer(layerBatasAktif);
    layerBatasAktif = null;
  }

  let geojson = null;
  if (state.levelBatas === 'kabkot') geojson = state.dataKabkotGeo;
  else if (state.levelBatas === 'kecamatan') geojson = state.dataKecamatanGeo;
  else if (state.levelBatas === 'desa') geojson = state.dataDesaGeo;

  if (!geojson) return;

  const sBMKG = state.slotAktifIdx;

  layerBatasAktif = L.geoJSON(geojson, {
    renderer: canvasRenderer,
    style: (feature) => {
      const p = feature.properties;
      const kode = p.kode_adm4 || p.kode;
      const isSelected = state.wilayahTerpilih && state.wilayahTerpilih.kode === kode;

      let fill = '#0284c7';
      let fillOp = 0.12;
      let strokeColor = '#38bdf8';
      let weight = 1.0;

      if (state.levelBatas === 'kabkot') {
        weight = 2.4;
        strokeColor = '#38bdf8';
        const d = state.aggKabkot[kode];
        if (d && state.choroplethBMKG) {
          const val = state.variabelAktif === 'temperature' ? d.rata_t[sBMKG] :
                      state.variabelAktif === 'relative_humidity' ? d.rata_hu[sBMKG] :
                      state.variabelAktif === 'wind' ? d.rata_ws[sBMKG] :
                      state.variabelAktif === 'cloud_cover' ? d.rata_tcc[sBMKG] : d.rata_t[sBMKG];
          fill = getWarnaCuacaNilai(state.variabelAktif, val, d.kelas[sBMKG]);
          fillOp = 0.45;
        }
      } else if (state.levelBatas === 'kecamatan') {
        weight = 1.4;
        strokeColor = 'rgba(56, 189, 248, 0.8)';
        const d = state.aggKecamatan[kode];
        if (d && state.choroplethBMKG) {
          const val = state.variabelAktif === 'temperature' ? d.rata_t[sBMKG] :
                      state.variabelAktif === 'relative_humidity' ? d.rata_hu[sBMKG] :
                      state.variabelAktif === 'wind' ? d.rata_ws[sBMKG] :
                      state.variabelAktif === 'cloud_cover' ? d.rata_tcc[sBMKG] : d.rata_t[sBMKG];
          fill = getWarnaCuacaNilai(state.variabelAktif, val, d.kelas[sBMKG]);
          fillOp = 0.48;
        }
      } else if (state.levelBatas === 'desa') {
        weight = 0.6;
        strokeColor = 'rgba(255, 255, 255, 0.35)';
        if (state.bmkgData && state.bmkgData.desa) {
          const d = state.bmkgData.desa[kode];
          if (d && state.choroplethBMKG) {
            const val = state.variabelAktif === 'temperature' ? d.t[sBMKG] :
                        state.variabelAktif === 'relative_humidity' ? d.hu[sBMKG] :
                        state.variabelAktif === 'wind' ? d.ws[sBMKG] :
                        state.variabelAktif === 'cloud_cover' ? d.tcc[sBMKG] : d.t[sBMKG];
            fill = getWarnaCuacaNilai(state.variabelAktif, val, d.kelas[sBMKG]);
            fillOp = 0.52;
          }
        }
      }

      if (isSelected) {
        strokeColor = '#facc15';
        weight = 3.6;
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
      const kode = p.kode_adm4 || p.kode;

      if (state.levelBatas === 'kabkot' && p.kabupaten) {
        const d = state.aggKabkot[kode];
        let infoNilai = '';
        if (d) {
          if (state.variabelAktif === 'temperature') infoNilai = ` • ${d.rata_t[sBMKG]}°C`;
          else if (state.variabelAktif === 'precipitation') infoNilai = ` • ${KELAS_HUJAN[d.kelas[sBMKG]]?.nama}`;
          else if (state.variabelAktif === 'wind') infoNilai = ` • ${d.rata_ws[sBMKG]} km/j`;
          else if (state.variabelAktif === 'relative_humidity') infoNilai = ` • ${d.rata_hu[sBMKG]}%`;
          else if (state.variabelAktif === 'cloud_cover') infoNilai = ` • ${d.rata_tcc[sBMKG]}%`;
        }

        layer.bindTooltip(`🏛️ ${p.kabupaten.toUpperCase()}${infoNilai}`, {
          permanent: true,
          direction: 'center',
          className: 'label-kabkot'
        });
      }

      layer.on({
        click: () => {
          bukaDetailWilayah(state.levelBatas, kode, p);
        },
        mouseover: () => {
          layer.setStyle({ weight: 3.2, color: '#facc15', fillOpacity: 0.65 });
        },
        mouseout: () => {
          if (layerBatasAktif) layerBatasAktif.resetStyle(layer);
        },
      });
    },
  }).addTo(peta);
}

// ---------------------------------------------------------------------------
// 6. Layer Titik Pos & Stasiun BMKG
// ---------------------------------------------------------------------------
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
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });

    const m = L.marker([st.lat, st.lon], { icon: icon });
    m.bindPopup(`
      <div style="font-family:sans-serif; min-width:180px;">
        <span style="font-size:10px; font-weight:700; color:#0284c7; text-transform:uppercase;">${st.jenis}</span>
        <h4 style="margin:2px 0 4px; font-size:13px; color:#0f172a;">${st.nama}</h4>
        <p style="margin:0; font-size:11px; color:#64748b;">Wilayah: ${st.kab}</p>
        <div style="margin-top:6px; padding:4px 6px; background:#f1f5f9; border-radius:4px; font-size:11px; color:#334155;">
          Pos Pemantau Resmi BMKG Kedungsepur
        </div>
      </div>
    `);
    markers.push(m);
  }

  layerStasiunBMKG = L.layerGroup(markers).addTo(peta);
}

// ---------------------------------------------------------------------------
// 7. Drawer Detail Wilayah (Kabkot, Kecamatan, atau Desa)
// ---------------------------------------------------------------------------
function bukaDetailWilayah(tipe, kode, p) {
  state.wilayahTerpilih = { tipe, kode, props: p };
  const sBMKG = state.slotAktifIdx;
  const drawer = $('#drawer-detail');

  let namaJudul = '';
  let subWilayah = '';
  let tempTeks = '--°C';
  let cuacaTeks = 'Cerah';
  let tagTeks = 'Tidak hujan';
  let huTeks = '--%';
  let wsTeks = '-- km/j';
  let tccTeks = '--%';
  let hujanTeks = '--';
  let cakupanTeks = '';
  let chartLabels = [];
  let chartTemp = [];
  let chartHu = [];

  const slots = state.bmkgData ? state.bmkgData.slots : [];
  chartLabels = slots.map((s) => s.substring(11, 16));

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
      hujanTeks = `${d.hujanCount[sBMKG]} desa hujan`;
      chartTemp = d.rata_t;
      chartHu = d.rata_hu;
    }
  } else if (tipe === 'kecamatan') {
    const d = state.aggKecamatan[kode];
    namaJudul = `Kec. ${p.kecamatan || ''}`;
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
      hujanTeks = `${d.hujanCount[sBMKG]} desa hujan`;
      chartTemp = d.rata_t;
      chartHu = d.rata_hu;
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
      hujanTeks = d.kelas[sBMKG] > 0 ? 'Potensi hujan' : 'Tidak hujan';
      chartTemp = d.t;
      chartHu = d.hu;
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
  $('#drawer-hujan-hari').textContent = hujanTeks;
  $('#drawer-cakupan').textContent = cakupanTeks;
  $('#drawer-analisis').textContent = (state.bmkgData && state.bmkgData.analysis_date) || '2026-11-08 12:00 UTC';

  drawer.hidden = false;
  renderGrafikDrawer(chartLabels, chartTemp, chartHu, sBMKG);
  renderBatasWilayah();
}

function renderGrafikDrawer(labels, suhu, hu, activeIdx) {
  const ctx = document.getElementById('grafik-drawer');
  if (!ctx) return;
  if (state.grafikChart) {
    state.grafikChart.destroy();
    state.grafikChart = null;
  }

  // Highlight point pada slot aktif
  const pointBgSuhu = suhu.map((_, i) => i === activeIdx ? '#fff' : '#ef4444');
  const pointRadiusSuhu = suhu.map((_, i) => i === activeIdx ? 5 : 2);

  state.grafikChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Suhu (°C)',
          data: suhu,
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          pointBackgroundColor: pointBgSuhu,
          pointRadius: pointRadiusSuhu,
          tension: 0.35,
          yAxisID: 'ySuhu',
        },
        {
          label: 'Kelembapan (%)',
          data: hu,
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
// 8. Legenda Parameter Cuaca (Menyatu di Kiri Bottom Bar)
// ---------------------------------------------------------------------------
function updateLegenda() {
  const wadah = $('#legenda-wadah');
  if (!wadah) return;

  if (state.variabelAktif === 'precipitation') {
    wadah.innerHTML = `
      <div class="legenda-judul-inline">Kelas Hujan BMKG</div>
      <div class="legenda-item-row">
        <span class="legenda-chip"><span style="background:#64748b"></span> Tdk hujan</span>
        <span class="legenda-chip"><span style="background:#38bdf8"></span> Ringan</span>
        <span class="legenda-chip"><span style="background:#2563eb"></span> Sedang</span>
        <span class="legenda-chip"><span style="background:#dc2626"></span> Lebat</span>
      </div>
    `;
  } else if (state.variabelAktif === 'temperature') {
    wadah.innerHTML = `
      <div class="legenda-judul-inline">Suhu Udara (°C)</div>
      <div class="legenda-item-row">
        <span class="legenda-chip"><span style="background:#38bdf8"></span> &lt;22°</span>
        <span class="legenda-chip"><span style="background:#34d399"></span> 22-25°</span>
        <span class="legenda-chip"><span style="background:#facc15"></span> 26-28°</span>
        <span class="legenda-chip"><span style="background:#fb923c"></span> 29-32°</span>
        <span class="legenda-chip"><span style="background:#ef4444"></span> &gt;32°</span>
      </div>
    `;
  } else if (state.variabelAktif === 'wind') {
    wadah.innerHTML = `
      <div class="legenda-judul-inline">Kecepatan Angin (km/j)</div>
      <div class="legenda-item-row">
        <span class="legenda-chip"><span style="background:#94a3b8"></span> &lt;5</span>
        <span class="legenda-chip"><span style="background:#38bdf8"></span> 5-10</span>
        <span class="legenda-chip"><span style="background:#0284c7"></span> 10-15</span>
        <span class="legenda-chip"><span style="background:#a855f7"></span> &gt;15</span>
      </div>
    `;
  } else if (state.variabelAktif === 'relative_humidity') {
    wadah.innerHTML = `
      <div class="legenda-judul-inline">Kelembapan Udara (%)</div>
      <div class="legenda-item-row">
        <span class="legenda-chip"><span style="background:#fdba74"></span> &lt;65%</span>
        <span class="legenda-chip"><span style="background:#67e8f9"></span> 65-75%</span>
        <span class="legenda-chip"><span style="background:#38bdf8"></span> 76-85%</span>
        <span class="legenda-chip"><span style="background:#1d4ed8"></span> &gt;85%</span>
      </div>
    `;
  } else if (state.variabelAktif === 'cloud_cover') {
    wadah.innerHTML = `
      <div class="legenda-judul-inline">Tutupan Awan (%)</div>
      <div class="legenda-item-row">
        <span class="legenda-chip"><span style="background:#fde047"></span> 0-30%</span>
        <span class="legenda-chip"><span style="background:#93c5fd"></span> 31-60%</span>
        <span class="legenda-chip"><span style="background:#64748b"></span> 61-85%</span>
        <span class="legenda-chip"><span style="background:#334155"></span> &gt;85%</span>
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// 9. Modal Tabel Pantauan 1.250 Desa
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
  const sBMKG = state.slotAktifIdx;
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
    const kelasIdx = d.kelas ? d.kelas[sBMKG] : 0;
    const kelasNama = KELAS_HUJAN[kelasIdx]?.nama || 'Tidak hujan';

    rows.push(`
      <tr data-kode="${kode}">
        <td><strong>${desa}</strong></td>
        <td>${kec}</td>
        <td>${kab}</td>
        <td class="angka">${t}°C</td>
        <td class="angka">${hu}%</td>
        <td class="angka">${ws}</td>
        <td>${cuaca}</td>
        <td><span class="tag-hujan" style="background:${KELAS_HUJAN[kelasIdx]?.warna || '#64748b'}; color:#fff; border:0;">${kelasNama}</span></td>
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
        peta.flyTo([d.lat, d.lon], 13);
        bukaDetailWilayah('desa', kode, { desa: d.desa, kecamatan: d.kec, kabupaten: d.kab });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 10. Event Listeners & Kontrol Terpadu
// ---------------------------------------------------------------------------
function setupEventHandlers() {
  // Tingkat Wilayah di Topbar (Kab/Kota, Kecamatan, Desa)
  $$('.btn-segmen-w').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.btn-segmen-w').forEach((b) => b.classList.remove('aktif'));
      btn.classList.add('aktif');
      state.levelBatas = btn.dataset.level;
      renderBatasWilayah();
    });
  });

  // Parameter Cuaca di Sidebar Kanan
  $$('.btn-tool-param').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.btn-tool-param').forEach((b) => b.classList.remove('aktif'));
      btn.classList.add('aktif');
      state.variabelAktif = btn.dataset.var;
      renderBatasWilayah();
      updateLegenda();
    });
  });

  // Basemap di Sidebar Kanan
  $$('.btn-tool-base').forEach((btn) => {
    btn.addEventListener('click', () => {
      gantiBasemap(btn.dataset.base);
    });
  });

  // Saklar Warna Cuaca
  $('#saklar-choropleth-bmkg').addEventListener('change', (e) => {
    state.choroplethBMKG = e.target.checked;
    renderBatasWilayah();
  });

  // Saklar Titik Stasiun BMKG
  $('#saklar-stasiun-bmkg').addEventListener('change', (e) => {
    state.tampilkanStasiun = e.target.checked;
    renderStasiunBMKG();
  });

  // Tutup Drawer Kiri
  $('#tutup-drawer').addEventListener('click', () => {
    $('#drawer-detail').hidden = true;
    state.wilayahTerpilih = null;
    renderBatasWilayah();
  });
}

// ---------------------------------------------------------------------------
// 11. Inisialisasi Data Cepat & Sinkron
// ---------------------------------------------------------------------------
async function init() {
  setupEventHandlers();
  setupModalTabel();
  updateLegenda();
  renderStasiunBMKG();

  // 1. Muat Data BMKG 1.250 Desa
  try {
    const resBMKG = await fetch(KONFIG.cuacaBMKG);
    if (resBMKG.ok) {
      state.bmkgData = await resBMKG.json();
      bangunAgregasiBMKG(state.bmkgData);

      // Susun Jadwal Slot Dinamis
      state.jadwalHari = susunJadwalBMKG(state.bmkgData.slots);
      state.hariAktifIdx = 0;
      state.slotAktifIdx = 0;
      renderUIWaktuBMKG();
    }
  } catch (err) {
    console.warn('Data BMKG gagal dimuat:', err);
  }

  // 2. Muat Data Batas Spasial secara Paralel
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
