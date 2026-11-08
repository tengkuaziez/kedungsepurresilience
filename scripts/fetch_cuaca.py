#!/usr/bin/env python3
"""
KEDUNGSEPUR RESILIENCE - penarik data prakiraan cuaca BMKG.

Alur ("cara B"): skrip ini yang memanggil API BMKG, lalu menulis
data/cuaca_kedungsepur.geojson. Browser pengunjung hanya membaca file itu,
sehingga jumlah request ke BMKG tidak bergantung pada jumlah pengunjung.

Pemakaian:
    python scripts/fetch_cuaca.py            # lanjutkan progres jika ada
    python scripts/fetch_cuaca.py --ulang    # abaikan progres, tarik ulang semua

Hanya memakai pustaka standar Python (tanpa dependensi tambahan).
Sumber data: BMKG (data.bmkg.go.id).
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

# --- Konfigurasi -----------------------------------------------------------
AKAR = Path(__file__).resolve().parent.parent
FILE_CSV = AKAR / "data" / "kelurahan_test.csv"
FILE_GEOJSON = AKAR / "data" / "cuaca_kedungsepur.geojson"
FILE_GAGAL = AKAR / "data" / "gagal.log"
FILE_PROGRES = AKAR / "data" / ".progres_cuaca.json"  # sementara, di-.gitignore

URL_API = "https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4={kode}"
USER_AGENT = "KEDUNGSEPUR-RESILIENCE/0.1 (prototipe penelitian; +https://github.com/tengkuaziez/kedungsepurresilience)"

JEDA_DETIK = 1.2        # jeda minimal antar-request (batas BMKG: 60 request/menit/IP)
TIMEOUT_DETIK = 30
MAKS_RETRY = 3          # 1 percobaan awal + maksimal 3 kali ulang
BACKOFF_DASAR = 2       # detik; jeda retry = 2, 4, 8 detik
JEDA_429_DEFAULT = 60   # detik, jika HTTP 429 tanpa header Retry-After
PROGRES_KEDALUWARSA_JAM = 3  # progres lebih tua dari ini dianggap basi

WIB = timezone(timedelta(hours=7))

# Urutan kelas hujan dari ringan ke berat (indeks = tingkat keparahan)
KELAS_HUJAN = ["Tidak hujan", "Hujan ringan", "Hujan sedang", "Hujan lebat/petir"]


# --- Utilitas waktu & berkas ----------------------------------------------
def sekarang_iso():
    """Waktu sekarang dalam ISO 8601 zona WIB, contoh 2026-11-08T19:55:00+07:00."""
    return datetime.now(WIB).replace(microsecond=0).isoformat()


def tulis_json_atomik(path, isi):
    """Tulis JSON ke file sementara lalu rename, agar file tidak setengah jadi."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(isi, f, ensure_ascii=False, separators=(",", ":"))  # ringkas agar cepat diunduh
        f.write("\n")
    os.replace(tmp, path)


def baca_csv():
    """Baca daftar kode adm4 dari CSV (kolom: adm4,nama)."""
    with open(FILE_CSV, encoding="utf-8-sig", newline="") as f:
        baris = [
            {"adm4": r["adm4"].strip(), "nama": (r.get("nama") or "").strip()}
            for r in csv.DictReader(f)
            if r.get("adm4") and r["adm4"].strip()
        ]
    # buang duplikat, pertahankan urutan
    unik, sudah = [], set()
    for r in baris:
        if r["adm4"] not in sudah:
            unik.append(r)
            sudah.add(r["adm4"])
    return unik


# --- Progres (agar bisa dilanjutkan jika terputus) -------------------------
def muat_progres(ulang):
    """Kembalikan progres lama jika masih segar, selain itu progres baru."""
    baru = {"mulai": sekarang_iso(), "berhasil": {}}
    if ulang or not FILE_PROGRES.exists():
        return baru
    try:
        lama = json.loads(FILE_PROGRES.read_text(encoding="utf-8"))
        umur = datetime.now(WIB) - datetime.fromisoformat(lama["mulai"])
        if umur <= timedelta(hours=PROGRES_KEDALUWARSA_JAM):
            print(f"Melanjutkan progres sebelumnya ({len(lama['berhasil'])} kode sudah berhasil).")
            return lama
        print("Progres lama sudah basi, mulai dari awal.")
    except (ValueError, KeyError, OSError) as e:
        print(f"Progres lama tidak terbaca ({e}), mulai dari awal.")
    return baru


# --- Pemanggilan API dengan jeda, timeout, retry ---------------------------
_waktu_request_terakhir = 0.0


def _tunggu_jeda():
    """Pastikan jarak antar-request >= JEDA_DETIK (termasuk saat retry)."""
    global _waktu_request_terakhir
    sisa = JEDA_DETIK - (time.monotonic() - _waktu_request_terakhir)
    if sisa > 0:
        time.sleep(sisa)
    _waktu_request_terakhir = time.monotonic()


def ambil_prakiraan(kode):
    """
    Ambil JSON prakiraan untuk satu kode adm4.
    Mengembalikan (data_json, None) jika berhasil, atau (None, alasan_gagal).
    Statistik 429 dicatat di STAT.
    """
    url = URL_API.format(kode=kode)
    alasan = "tidak diketahui"
    for percobaan in range(MAKS_RETRY + 1):
        _tunggu_jeda()
        jeda_retry = BACKOFF_DASAR * (2 ** percobaan)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=TIMEOUT_DETIK) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return data, None
        except urllib.error.HTTPError as e:
            alasan = f"HTTP {e.code}"
            if e.code == 429:
                STAT["http_429"] += 1
                retry_after = e.headers.get("Retry-After", "")
                jeda_retry = int(retry_after) if retry_after.isdigit() else JEDA_429_DEFAULT
            elif e.code < 500:
                # 4xx selain 429 (mis. 404 kode tidak dikenal): tidak perlu diulang
                return None, alasan
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            alasan = f"jaringan/timeout: {getattr(e, 'reason', e)}"
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            alasan = f"respons bukan JSON: {e}"

        if percobaan < MAKS_RETRY:
            print(f"    {alasan}; ulang ke-{percobaan + 1} dalam {jeda_retry} detik...")
            time.sleep(jeda_retry)
    return None, f"{alasan} (setelah {MAKS_RETRY} kali ulang)"


STAT = {"http_429": 0}


# --- Ringkasan harian ------------------------------------------------------
def kelas_dari_desc(desc):
    """
    Petakan weather_desc BMKG ke tingkat kelas hujan (indeks KELAS_HUJAN).
    Aturan (cek berurutan, tanpa membedakan huruf besar/kecil):
      mengandung "petir" atau "lebat"  -> 3 Hujan lebat/petir
      mengandung "sedang"              -> 2 Hujan sedang
      mengandung "hujan" (ringan/lokal/lainnya) -> 1 Hujan ringan
      selain itu                       -> 0 Tidak hujan
    """
    d = (desc or "").lower()
    if "petir" in d or "lebat" in d:
        return 3
    if "sedang" in d:
        return 2
    if "hujan" in d:
        return 1
    return 0


def _rata(nilai):
    nilai = [v for v in nilai if isinstance(v, (int, float))]
    return round(sum(nilai) / len(nilai), 1) if nilai else None


def ringkas_hari(slot_hari):
    """Hitung ringkasan satu hari dari slot-slot per 3 jam."""
    suhu = [s.get("t") for s in slot_hari if isinstance(s.get("t"), (int, float))]
    angin = [s.get("ws") for s in slot_hari if isinstance(s.get("ws"), (int, float))]
    desc = [s.get("weather_desc") or "" for s in slot_hari]
    tingkat = max((kelas_dari_desc(x) for x in desc), default=0)
    # modus; jika seri, Counter memilih yang muncul lebih dulu
    dominan = Counter(desc).most_common(1)[0][0] if desc else None
    tanggal = (slot_hari[0].get("local_datetime") or "")[:10] if slot_hari else None
    return {
        "tanggal": tanggal,
        "jumlah_slot": len(slot_hari),
        "suhu_min": min(suhu) if suhu else None,
        "suhu_max": max(suhu) if suhu else None,
        "suhu_rata": _rata(suhu),
        "kelembapan_rata": _rata([s.get("hu") for s in slot_hari]),
        "angin_maks": max(angin) if angin else None,
        "tcc_rata": _rata([s.get("tcc") for s in slot_hari]),
        "jumlah_slot_hujan": sum(1 for x in desc if "hujan" in x.lower()),
        "cuaca_dominan": dominan,
        "kelas_hujan": KELAS_HUJAN[tingkat],
    }


def buat_feature(kode, nama_csv, data, waktu_tarik):
    """Ubah respons BMKG menjadi GeoJSON Feature titik. Lempar ValueError jika tidak valid."""
    lokasi = data.get("lokasi") or {}
    try:
        lat, lon = float(lokasi["lat"]), float(lokasi["lon"])
        hari_list = data["data"][0]["cuaca"]
    except (KeyError, IndexError, TypeError, ValueError) as e:
        raise ValueError(f"struktur respons tidak sesuai: {e}")
    if not isinstance(hari_list, list) or not hari_list:
        raise ValueError("data[0].cuaca kosong")

    # Ambil maksimal 3 hari; tiap hari = satu list slot per 3 jam (sesuai pengelompokan BMKG)
    hari_list = [h for h in hari_list if isinstance(h, list) and h][:3]
    analysis = next((s.get("analysis_date") for h in hari_list for s in h if s.get("analysis_date")), None)

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        "properties": {
            "adm4": lokasi.get("adm4") or kode,
            "nama_csv": nama_csv,
            "desa": lokasi.get("desa"),
            "kecamatan": lokasi.get("kecamatan"),
            "kotkab": lokasi.get("kotkab"),
            "provinsi": lokasi.get("provinsi"),
            "analysis_date": analysis,
            "waktu_tarik": waktu_tarik,
            "harian": [ringkas_hari(h) for h in hari_list],
            "slot": hari_list,  # data mentah per hari x per 3 jam
        },
    }


# --- Program utama ---------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="KEDUNGSEPUR RESILIENCE - tarik prakiraan cuaca BMKG")
    ap.add_argument("--ulang", action="store_true", help="abaikan progres tersimpan")
    args = ap.parse_args()

    daftar = baca_csv()
    if not daftar:
        print(f"Tidak ada kode di {FILE_CSV}")
        return 1
    progres = muat_progres(args.ulang)
    gagal = []
    print(f"KEDUNGSEPUR RESILIENCE: menarik {len(daftar)} kode adm4 (jeda {JEDA_DETIK} s)...")

    for i, row in enumerate(daftar, 1):
        kode = row["adm4"]
        if kode in progres["berhasil"]:
            print(f"[{i}/{len(daftar)}] {kode} sudah ada di progres, dilewati")
            continue
        data, alasan = ambil_prakiraan(kode)
        if data is not None:
            try:
                feat = buat_feature(kode, row["nama"], data, sekarang_iso())
                progres["berhasil"][kode] = feat
                tulis_json_atomik(FILE_PROGRES, progres)  # simpan setiap kali berhasil
                p = feat["properties"]
                print(f"[{i}/{len(daftar)}] {kode} OK - {p['desa']}, {p['kecamatan']}, {p['kotkab']}")
                continue
            except ValueError as e:
                alasan = str(e)
        gagal.append((kode, row["nama"], alasan))
        print(f"[{i}/{len(daftar)}] {kode} GAGAL - {alasan}")

    # Catat kode gagal (file ditimpa setiap kali skrip dijalankan)
    with open(FILE_GAGAL, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"# KEDUNGSEPUR RESILIENCE - kode gagal ditarik, dijalankan {sekarang_iso()}\n")
        f.write("# adm4\tnama\talasan\n")
        for kode, nama, alasan in gagal:
            f.write(f"{kode}\t{nama}\t{alasan}\n")

    # Susun fitur sesuai urutan CSV
    fitur = [progres["berhasil"][r["adm4"]] for r in daftar if r["adm4"] in progres["berhasil"]]
    print(f"Selesai: {len(fitur)} berhasil, {len(gagal)} gagal, HTTP 429 terjadi {STAT['http_429']} kali.")

    if not fitur:
        # Jangan menimpa GeoJSON lama dengan data kosong
        print("Tidak ada data berhasil; GeoJSON lama dipertahankan.")
        return 1

    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "nama": "KEDUNGSEPUR RESILIENCE - prakiraan cuaca per kelurahan/desa",
            "sumber": "BMKG (data.bmkg.go.id)",
            "waktu_tarik": sekarang_iso(),
            "jumlah_berhasil": len(fitur),
            "jumlah_gagal": len(gagal),
            "kelas_hujan": KELAS_HUJAN,
        },
        "features": fitur,
    }
    tulis_json_atomik(FILE_GEOJSON, geojson)
    FILE_PROGRES.unlink(missing_ok=True)  # selesai: progres tidak diperlukan lagi
    print(f"Ditulis: {FILE_GEOJSON.relative_to(AKAR)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
