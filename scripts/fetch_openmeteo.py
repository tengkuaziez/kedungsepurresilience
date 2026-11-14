#!/usr/bin/env python3
"""
KEDUNGSEPUR RESILIENCE - Penarik Model Grid Cuaca Kompak ala Windy (Open-Meteo API).
Mencakup seluruh kawasan Kedungsepur (187 titik grid x 96 jam kontinu, ~600 KB).
Variabel: Suhu, Kelembaban, Presipitasi/Hujan, Tutupan Awan, Kecepatan Angin, Arah Angin, Vektor u, v.
"""

import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

AKAR = Path(__file__).resolve().parent.parent
FILE_OUT = AKAR / "data" / "kedungsepur_windy_grid.json"
USER_AGENT = "KEDUNGSEPUR-RESILIENCE/3.0 (+https://tengkuaziez.github.io/kedungsepurresilience/)"


def fetch_batch_with_retry(batch, batch_no, total_batches):
    """Ambil data prakiraan cuaca untuk sekelompok koordinat dengan retry cerdas & penanganan HTTP 429."""
    lat_str = ",".join(str(c[0]) for c in batch)
    lon_str = ",".join(str(c[1]) for c in batch)
    q = {
        "latitude": lat_str,
        "longitude": lon_str,
        "hourly": "temperature_2m,relative_humidity_2m,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m",
        "past_days": 1,
        "forecast_days": 3,
        "timezone": "Asia/Jakarta",
    }
    url = f"https://api.open-meteo.com/v1/forecast?{urllib.parse.urlencode(q)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=25) as res:
                data = json.loads(res.read().decode("utf-8"))
                if isinstance(data, list):
                    return data
                return [data]
        except urllib.error.HTTPError as e:
            print(f"  [Batch {batch_no}/{total_batches}] HTTP {e.code} ({e.reason}) pada percobaan {attempt + 1}/4")
            if e.code == 429:
                sleep_sec = 20 * (attempt + 1)
                print(f"  Pemberitahuan rate limit 429 dari Open-Meteo, jeda {sleep_sec} detik...")
                time.sleep(sleep_sec)
            else:
                time.sleep(4 * (attempt + 1))
        except Exception as e:
            print(f"  [Batch {batch_no}/{total_batches}] Gangguan koneksi ({e}) pada percobaan {attempt + 1}/4")
            time.sleep(3 * (attempt + 1))
    return None


def main():
    t0 = time.time()
    print("=== PENARIK MODEL GRID CUACA KEDUNGSEPUR (ALA WINDY) ===")

    # Bounding Box Kedungsepur (buffer pesisir utara dan pegunungan selatan)
    # lat: -6.70 s.d -7.50 (step 0.08 -> 11 baris)
    # lon: 110.00 s.d 111.28 (step 0.08 -> 17 kolom)
    lats = [round(-6.70 - i * 0.08, 4) for i in range(11)]
    lons = [round(110.00 + j * 0.08, 4) for j in range(17)]
    ny = len(lats)
    nx = len(lons)
    total_pts = ny * nx

    coords = [(lat, lon) for lat in lats for lon in lons]
    print(f"Menyiapkan {total_pts} titik grid ({ny} baris x {nx} kolom)...")

    # Ambil dalam 4 batch (50 titik per batch, sangat cepat ~10 detik dan stabil)
    batch_size = 50
    batches = [coords[i : i + batch_size] for i in range(0, len(coords), batch_size)]
    results = []

    for b_idx, batch in enumerate(batches, 1):
        batch_res = fetch_batch_with_retry(batch, b_idx, len(batches))
        if not batch_res:
            print(f"Batch {b_idx} gagal diambil setelah seluruh percobaan retry.")
            break
        results.extend(batch_res)
        time.sleep(1.0)  # Jeda sopan antar batch

    # Jika terjadi kendala jaringan Open-Meteo
    if len(results) != total_pts:
        found_pts = len(results)
        print(f"Peringatan: Gagal menarik data lengkap ({found_pts}/{total_pts} titik).")
        if FILE_OUT.exists():
            print(f"Mempertahankan data grid yang sudah ada ({FILE_OUT.name}) agar WebGIS tetap berjalan normal dan workflow tidak gagal.")
            sys.exit(0)
        else:
            print("File grid lokal tidak ditemukan, proses dihentikan.")
            sys.exit(1)

    times = results[0]["hourly"]["time"]
    n_hours = len(times)
    print(f"Berhasil menarik {n_hours} jam data kontinu (termasuk jam kemarin & hari ini)!")

    # Susun matriks per jam
    grid_data = {
        "grid": {
            "lat_max": lats[0],
            "lat_min": lats[-1],
            "lon_min": lons[0],
            "lon_max": lons[-1],
            "dlat": 0.08,
            "dlon": 0.08,
            "ny": ny,
            "nx": nx,
            "lats": lats,
            "lons": lons,
        },
        "times": times,
        "variables": {
            "temperature": [],
            "relative_humidity": [],
            "precipitation": [],
            "cloud_cover": [],
            "wind_speed": [],
            "u": [],
            "v": [],
        },
    }

    for t_idx in range(n_hours):
        t_mat, hu_mat, pr_mat, cl_mat, ws_mat, u_mat, v_mat = [], [], [], [], [], [], []
        idx = 0
        for r in range(ny):
            t_row, hu_row, pr_row, cl_row, ws_row, u_row, v_row = [], [], [], [], [], [], []
            for c in range(nx):
                pt = results[idx]["hourly"]
                t_val = round(pt["temperature_2m"][t_idx], 1)
                hu_val = round(pt["relative_humidity_2m"][t_idx])
                pr_val = round(pt["precipitation"][t_idx], 1)
                cl_val = round(pt["cloud_cover"][t_idx])
                ws_val = round(pt["wind_speed_10m"][t_idx], 1)
                wd_val = round(pt["wind_direction_10m"][t_idx])

                # Vektor angin u, v (m/s) untuk partikel streamlines
                ws_ms = ws_val / 3.6
                rad = math.radians(wd_val)
                u_val = round(-ws_ms * math.sin(rad), 2)
                v_val = round(-ws_ms * math.cos(rad), 2)

                t_row.append(t_val)
                hu_row.append(hu_val)
                pr_row.append(pr_val)
                cl_row.append(cl_val)
                ws_row.append(ws_val)
                u_row.append(u_val)
                v_row.append(v_val)
                idx += 1

            t_mat.append(t_row)
            hu_mat.append(hu_row)
            pr_mat.append(pr_row)
            cl_mat.append(cl_row)
            ws_mat.append(ws_row)
            u_mat.append(u_row)
            v_mat.append(v_row)

        grid_data["variables"]["temperature"].append(t_mat)
        grid_data["variables"]["relative_humidity"].append(hu_mat)
        grid_data["variables"]["precipitation"].append(pr_mat)
        grid_data["variables"]["cloud_cover"].append(cl_mat)
        grid_data["variables"]["wind_speed"].append(ws_mat)
        grid_data["variables"]["u"].append(u_mat)
        grid_data["variables"]["v"].append(v_mat)

    FILE_OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(FILE_OUT, "w", encoding="utf-8") as f:
        json.dump(grid_data, f, separators=(",", ":"))

    size_kb = round(os.path.getsize(FILE_OUT) / 1024, 1)
    durasi = round(time.time() - t0, 2)
    print(f"SUKSES! Berkas tersimpan di {FILE_OUT} ({size_kb} KB) dalam {durasi} detik.")


if __name__ == "__main__":
    main()
