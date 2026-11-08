#!/usr/bin/env python3
"""
KEDUNGSEPUR RESILIENCE - Penarik data lengkap cuaca BMKG se-Kedungsepur (1.250 desa).

Menyimpan keluaran ke data/bmkg_latest.json dengan skema kompak:
{
  "analysis_date": "...",
  "fetched_at": "...",
  "slots": ["2026-11-08 20:00:00", ...],
  "desa": {
    "<adm4>": {
      "t": [...],
      "hu": [...],
      "ws": [...],
      "wd": [...],
      "tcc": [...],
      "cuaca": [...],
      "kelas": [...],
      "harian": [...]
    }
  }
}
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

AKAR = Path(__file__).resolve().parent.parent
FILE_LIST = AKAR / "data" / "adm4_list.json"
FILE_OUTPUT = AKAR / "data" / "bmkg_latest.json"
FILE_GAGAL = AKAR / "data" / "gagal_bmkg.log"
FILE_PROGRES = AKAR / "data" / ".progres_bmkg.json"

URL_API = "https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4={kode}"
USER_AGENT = "KEDUNGSEPUR-RESILIENCE/1.0 (+https://tengkuaziez.github.io/kedungsepurresilience/)"

JEDA_DETIK = 1.3        # ~46 req/menit (batas aman BMKG: <60 req/menit)
TIMEOUT_DETIK = 25
MAKS_RETRY = 3
BACKOFF_DASAR = 2

WIB = timezone(timedelta(hours=7))
KELAS_HUJAN = ["Tidak hujan", "Hujan ringan", "Hujan sedang", "Hujan lebat/petir"]


def sekarang_iso():
    return datetime.now(WIB).replace(microsecond=0).isoformat()


def kelas_dari_desc(desc):
    d = (desc or "").lower()
    if "petir" in d or "lebat" in d:
        return 3
    if "sedang" in d:
        return 2
    if "hujan" in d:
        return 1
    return 0


def _rata(nilai):
    v = [x for x in nilai if isinstance(x, (int, float))]
    return round(sum(v) / len(v), 1) if v else None


def ringkas_hari(slot_hari):
    suhu = [s.get("t") for s in slot_hari if isinstance(s.get("t"), (int, float))]
    angin = [s.get("ws") for s in slot_hari if isinstance(s.get("ws"), (int, float))]
    desc = [s.get("weather_desc") or "" for s in slot_hari]
    tingkat = max((kelas_dari_desc(x) for x in desc), default=0)
    dominan = Counter(desc).most_common(1)[0][0] if desc else None
    tanggal = (slot_hari[0].get("local_datetime") or "")[:10] if slot_hari else None
    return {
        "tanggal": tanggal,
        "suhu_min": min(suhu) if suhu else None,
        "suhu_max": max(suhu) if suhu else None,
        "suhu_rata": _rata(suhu),
        "kelembapan_rata": _rata([s.get("hu") for s in slot_hari]),
        "angin_maks": max(angin) if angin else None,
        "tcc_rata": _rata([s.get("tcc") for s in slot_hari]),
        "slot_hujan": sum(1 for x in desc if "hujan" in x.lower()),
        "cuaca_dominan": dominan,
        "kelas_hujan": KELAS_HUJAN[tingkat],
        "kelas_tingkat": tingkat,
    }


def parse_raw_cuaca(data_raw):
    """Mengekstrak array datar sejajar untuk tiap variabel dan ringkasan harian."""
    cuaca_grup = data_raw.get("data", [{}])[0].get("cuaca", [])
    if not cuaca_grup or not isinstance(cuaca_grup, list):
        raise ValueError("data[0].cuaca kosong")

    slots, t, hu, ws, wd, tcc, cuaca, kelas = [], [], [], [], [], [], [], []
    harian = []
    analysis = None

    for grup_hari in cuaca_grup:
        if not isinstance(grup_hari, list) or not grup_hari:
            continue
        harian.append(ringkas_hari(grup_hari))
        for s in grup_hari:
            if not analysis and s.get("analysis_date"):
                analysis = s.get("analysis_date")
            dt = s.get("local_datetime") or s.get("datetime") or ""
            slots.append(dt)
            t.append(s.get("t"))
            hu.append(s.get("hu"))
            ws.append(s.get("ws"))
            wd.append(s.get("wd") or "")
            tcc.append(s.get("tcc"))
            w_desc = s.get("weather_desc") or ""
            cuaca.append(w_desc)
            kelas.append(kelas_dari_desc(w_desc))

    return {
        "analysis_date": analysis,
        "slots": slots,
        "data_desa": {
            "t": t,
            "hu": hu,
            "ws": ws,
            "wd": wd,
            "tcc": tcc,
            "cuaca": cuaca,
            "kelas": kelas,
            "harian": harian
        }
    }


_waktu_request_terakhir = 0.0


def _tunggu_jeda():
    global _waktu_request_terakhir
    sisa = JEDA_DETIK - (time.monotonic() - _waktu_request_terakhir)
    if sisa > 0:
        time.sleep(sisa)
    _waktu_request_terakhir = time.monotonic()


def ambil_prakiraan(kode):
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
                retry_after = e.headers.get("Retry-After", "")
                jeda_retry = int(retry_after) if retry_after.isdigit() else 60
                time.sleep(jeda_retry)
                continue
            elif e.code < 500:
                return None, alasan
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            alasan = f"jaringan/timeout: {getattr(e, 'reason', e)}"
        except Exception as e:
            alasan = f"error: {e}"

        if percobaan < MAKS_RETRY:
            time.sleep(jeda_retry)
    return None, f"{alasan} (setelah {MAKS_RETRY}x retry)"


def main():
    parser = argparse.ArgumentParser(description="Tarik cuaca BMKG 1.250 desa se-Kedungsepur")
    parser.add_argument("--limit", type=int, default=0, help="Batasi jumlah desa (untuk testing)")
    parser.add_argument("--ulang", action="store_true", help="Abaikan progres sebelumnya")
    args = parser.parse_args()

    t_mulai = time.time()
    with open(FILE_LIST, "r", encoding="utf-8") as f:
        daftar = json.load(f)

    if args.limit > 0:
        daftar = daftar[:args.limit]

    total = len(daftar)
    print(f"KEDUNGSEPUR RESILIENCE: Memulai penarikan BMKG untuk {total} desa (jeda {JEDA_DETIK}s)...")

    # Muat data lama untuk fallback data yang gagal
    data_lama = {}
    if FILE_OUTPUT.exists():
        try:
            with open(FILE_OUTPUT, "r", encoding="utf-8") as f:
                d_old = json.load(f)
                data_lama = d_old.get("desa", {})
        except Exception:
            pass

    # Muat progres
    progres = {}
    if not args.ulang and FILE_PROGRES.exists():
        try:
            with open(FILE_PROGRES, "r", encoding="utf-8") as f:
                progres = json.load(f)
                print(f"Melanjutkan progres ({len(progres)} desa sudah tersimpan).")
        except Exception:
            progres = {}

    berhasil = 0
    gagal = []
    analysis_date = None
    master_slots = []

    for i, item in enumerate(daftar, 1):
        kode = item["kode_adm4"]
        nama = item["desa"]

        if kode in progres:
            berhasil += 1
            if not master_slots and "slots" in progres[kode]:
                master_slots = progres[kode].pop("slots")
            continue

        raw_data, err = ambil_prakiraan(kode)
        if raw_data:
            try:
                parsed = parse_raw_cuaca(raw_data)
                if not analysis_date and parsed["analysis_date"]:
                    analysis_date = parsed["analysis_date"]
                if not master_slots:
                    master_slots = parsed["slots"]

                desa_entry = parsed["data_desa"]
                desa_entry["desa"] = nama
                desa_entry["kec"] = item["kecamatan"]
                desa_entry["kab"] = item["kabupaten"]
                desa_entry["lat"] = raw_data.get("lokasi", {}).get("lat")
                desa_entry["lon"] = raw_data.get("lokasi", {}).get("lon")

                progres[kode] = desa_entry
                berhasil += 1
                if i % 10 == 0 or i == total:
                    print(f"[{i}/{total}] {kode} {nama} OK (Berhasil: {berhasil}, Gagal: {len(gagal)})")
                    # Simpan progres periodik
                    with open(FILE_PROGRES, "w", encoding="utf-8") as pf:
                        json.dump(progres, pf, ensure_ascii=False)
                continue
            except Exception as e:
                err = f"parsing error: {e}"

        # Jika gagal, cek apakah ada data lama
        if kode in data_lama:
            entry_old = data_lama[kode]
            entry_old["stale"] = True
            progres[kode] = entry_old
            print(f"[{i}/{total}] {kode} {nama} GAGAL ({err}), menggunakan data lama (stale)")
        else:
            print(f"[{i}/{total}] {kode} {nama} GAGAL: {err}")
        gagal.append((kode, nama, err))

    durasi = round(time.time() - t_mulai, 1)

    # Catat log gagal
    with open(FILE_GAGAL, "w", encoding="utf-8") as f:
        f.write(f"# Log Gagal BMKG - {sekarang_iso()}\n")
        f.write(f"# Total: {total}, Berhasil: {berhasil}, Gagal: {len(gagal)}, Durasi: {durasi}s\n")
        for k, n, r in gagal:
            f.write(f"{k}\t{n}\t{r}\n")

    # Susun output final
    output = {
        "analysis_date": analysis_date or "–",
        "fetched_at": sekarang_iso(),
        "total_desa": len(progres),
        "berhasil": berhasil,
        "gagal": len(gagal),
        "durasi_detik": durasi,
        "slots": master_slots,
        "desa": progres
    }

    # Tulis atomik
    tmp_out = FILE_OUTPUT.with_suffix(".tmp")
    with open(tmp_out, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_out, FILE_OUTPUT)

    print(f"\n--- Selesai Penarikan BMKG ---")
    print(f"Total: {total} | Berhasil: {berhasil} | Gagal: {len(gagal)} | Durasi: {durasi/60:.2f} menit")
    print(f"File tersimpan di {FILE_OUTPUT} ({os.path.getsize(FILE_OUTPUT):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
