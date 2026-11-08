#!/usr/bin/env python3
"""
KEDUNGSEPUR RESILIENCE - Penarik data model grid Open-Meteo (Darat & Laut).

Menghasilkan:
1. data/openmeteo_grid.json (Hujan, Suhu, Tekanan, Awan, Kelembapan, Angin u/v)
2. data/marine_grid.json (Tinggi/Arah Gelombang, Arus Laut di Laut Jawa)
"""

import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

AKAR = Path(__file__).resolve().parent.parent
FILE_BATAS = AKAR / "data" / "batas_keldes.geojson"
FILE_GRID_OUT = AKAR / "data" / "openmeteo_grid.json"
FILE_MARINE_OUT = AKAR / "data" / "marine_grid.json"

WIB = timezone(timedelta(hours=7))
USER_AGENT = "KEDUNGSEPUR-RESILIENCE/1.0 (+https://tengkuaziez.github.io/kedungsepurresilience/)"
BATCH_SIZE = 40  # Jumlah koordinat per request (aman di bawah batas URL)


def sekarang_iso():
    return datetime.now(WIB).replace(microsecond=0).isoformat()


def buat_koordinat_grid(dlat=0.05, dlon=0.05, margin=0.08):
    """Menghitung grid reguler menutupi extent Kedungsepur."""
    if FILE_BATAS.exists():
        with open(FILE_BATAS, "r", encoding="utf-8") as f:
            b = json.load(f).get("bbox", [109.92, -7.50, 111.25, -6.70])
    else:
        b = [109.92, -7.50, 111.25, -6.70]

    lon_min = round(b[0] - margin, 2)
    lat_min = round(b[1] - margin, 2)
    lon_max = round(b[2] + margin, 2)
    lat_max = round(b[3] + margin, 2)

    lats, lons = [], []
    lat = lat_max
    while lat >= lat_min - 1e-5:
        lats.append(round(lat, 4))
        lat -= dlat

    lon = lon_min
    while lon <= lon_max + 1e-5:
        lons.append(round(lon, 4))
        lon += dlon

    return {
        "lat_max": lats[0],
        "lat_min": lats[-1],
        "lon_min": lons[0],
        "lon_max": lons[-1],
        "dlat": dlat,
        "dlon": dlon,
        "ny": len(lats),
        "nx": len(lons),
        "lats": lats,
        "lons": lons,
    }


def fetch_batches(base_url, params_common, coords, batch_size=BATCH_SIZE):
    """Mengambil data Open-Meteo untuk daftar (lat, lon) secara batch."""
    results = []
    total = len(coords)
    for i in range(0, total, batch_size):
        batch = coords[i : i + batch_size]
        lat_str = ",".join(str(c[0]) for c in batch)
        lon_str = ",".join(str(c[1]) for c in batch)

        q = dict(params_common)
        q["latitude"] = lat_str
        q["longitude"] = lon_str
        url = f"{base_url}?{urllib.parse.urlencode(q)}"

        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=25) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                if isinstance(data, list):
                    results.extend(data)
                else:
                    results.append(data)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"Error fetching batch {i}-{i+len(batch)}: {e}")
                    # Isi list dummy jika gagal
                    for _ in batch:
                        results.append(None)
                time.sleep(1.5 * (attempt + 1))
        time.sleep(0.3)  # Jeda sopan antar batch
    return results


def proses_grid_cuaca(grid_def):
    print(f"Grid Cuaca: {grid_def['ny']} baris x {grid_def['nx']} kolom = {grid_def['ny'] * grid_def['nx']} titik.")
    flat_coords = []
    for r in range(grid_def["ny"]):
        lat = grid_def["lats"][r]
        for c in range(grid_def["nx"]):
            lon = grid_def["lons"][c]
            flat_coords.append((lat, lon))

    params = {
        "hourly": "temperature_2m,relative_humidity_2m,pressure_msl,cloud_cover,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        "forecast_days": 3,
        "timezone": "Asia/Jakarta",
    }
    url_base = "https://api.open-meteo.com/v1/forecast"
    print(f"Mengambil data Open-Meteo Forecast untuk {len(flat_coords)} titik...")
    res_list = fetch_batches(url_base, params, flat_coords)

    # Dapatkan master times
    master_times = []
    for r in res_list:
        if r and "hourly" in r and "time" in r["hourly"]:
            master_times = r["hourly"]["time"]
            break

    n_times = len(master_times)
    ny, nx = grid_def["ny"], grid_def["nx"]

    # Struktur 3D [waktu][baris][kolom]
    grid_precip = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_temp = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_rh = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_pres = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_cloud = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_u = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_v = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_ws = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]

    idx = 0
    for r in range(ny):
        for c in range(nx):
            item = res_list[idx] if idx < len(res_list) else None
            idx += 1
            if not item or "hourly" not in item:
                continue
            h = item["hourly"]
            for t_idx in range(min(n_times, len(h.get("time", [])))):
                pr = h["precipitation"][t_idx] if "precipitation" in h else 0
                temp = h["temperature_2m"][t_idx] if "temperature_2m" in h else None
                rh = h["relative_humidity_2m"][t_idx] if "relative_humidity_2m" in h else None
                ps = h["pressure_msl"][t_idx] if "pressure_msl" in h else None
                cc = h["cloud_cover"][t_idx] if "cloud_cover" in h else None
                ws_val = h["wind_speed_10m"][t_idx] if "wind_speed_10m" in h else 0
                wd_val = h["wind_direction_10m"][t_idx] if "wind_direction_10m" in h else 0

                grid_precip[t_idx][r][c] = round(pr, 1) if pr is not None else 0
                grid_temp[t_idx][r][c] = round(temp, 1) if temp is not None else None
                grid_rh[t_idx][r][c] = round(rh, 1) if rh is not None else None
                grid_pres[t_idx][r][c] = round(ps, 1) if ps is not None else None
                grid_cloud[t_idx][r][c] = round(cc, 1) if cc is not None else None
                grid_ws[t_idx][r][c] = round(ws_val, 1) if ws_val is not None else 0

                # u and v (m/s)
                # ws_val dalam km/h -> m/s: ws_val / 3.6
                speed_ms = (ws_val or 0) / 3.6
                rad = math.radians(wd_val or 0)
                u = -speed_ms * math.sin(rad)
                v = -speed_ms * math.cos(rad)
                grid_u[t_idx][r][c] = round(u, 2)
                grid_v[t_idx][r][c] = round(v, 2)

    out_cuaca = {
        "fetched_at": sekarang_iso(),
        "sumber": "Open-Meteo (CC BY 4.0)",
        "grid": {
            "lat_max": grid_def["lat_max"],
            "lat_min": grid_def["lat_min"],
            "lon_min": grid_def["lon_min"],
            "lon_max": grid_def["lon_max"],
            "dlat": grid_def["dlat"],
            "dlon": grid_def["dlon"],
            "ny": ny,
            "nx": nx,
        },
        "times": master_times,
        "variables": {
            "precipitation": grid_precip,
            "temperature": grid_temp,
            "relative_humidity": grid_rh,
            "pressure": grid_pres,
            "cloud_cover": grid_cloud,
            "wind_speed": grid_ws,
            "u": grid_u,
            "v": grid_v,
        },
    }

    with open(FILE_GRID_OUT, "w", encoding="utf-8") as f:
        json.dump(out_cuaca, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Tersimpan: {FILE_GRID_OUT} ({os.path.getsize(FILE_GRID_OUT):,} bytes)")


def proses_grid_laut(grid_def):
    """Mengambil data Marine API hanya untuk titik-titik perairan di utara (Laut Jawa)."""
    # Titik laut: lat >= -6.90
    laut_coords = []
    coord_map = []
    for r in range(grid_def["ny"]):
        lat = grid_def["lats"][r]
        if lat >= -6.92:  # Perairan utara
            for c in range(grid_def["nx"]):
                lon = grid_def["lons"][c]
                laut_coords.append((lat, lon))
                coord_map.append((r, c))

    print(f"\nGrid Laut (Laut Jawa): {len(laut_coords)} titik.")
    if not laut_coords:
        return

    params = {
        "hourly": "wave_height,wave_direction,wave_period,ocean_current_velocity,ocean_current_direction",
        "forecast_days": 3,
        "timezone": "Asia/Jakarta",
    }
    url_marine = "https://marine-api.open-meteo.com/v1/marine"
    res_list = fetch_batches(url_marine, params, laut_coords)

    master_times = []
    for r in res_list:
        if r and "hourly" in r and "time" in r["hourly"]:
            master_times = r["hourly"]["time"]
            break

    n_times = len(master_times)
    ny, nx = grid_def["ny"], grid_def["nx"]

    grid_wave_h = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_wave_dir = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_wave_per = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_current_v = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]
    grid_current_dir = [[[None for _ in range(nx)] for _ in range(ny)] for _ in range(n_times)]

    for idx, (r, c) in enumerate(coord_map):
        item = res_list[idx] if idx < len(res_list) else None
        if not item or "hourly" not in item:
            continue
        h = item["hourly"]
        for t_idx in range(min(n_times, len(h.get("time", [])))):
            wh = h.get("wave_height", [])[t_idx] if "wave_height" in h else None
            wd = h.get("wave_direction", [])[t_idx] if "wave_direction" in h else None
            wp = h.get("wave_period", [])[t_idx] if "wave_period" in h else None
            cv = h.get("ocean_current_velocity", [])[t_idx] if "ocean_current_velocity" in h else None
            cd = h.get("ocean_current_direction", [])[t_idx] if "ocean_current_direction" in h else None

            grid_wave_h[t_idx][r][c] = round(wh, 2) if wh is not None else None
            grid_wave_dir[t_idx][r][c] = round(wd, 1) if wd is not None else None
            grid_wave_per[t_idx][r][c] = round(wp, 1) if wp is not None else None
            grid_current_v[t_idx][r][c] = round(cv, 2) if cv is not None else None
            grid_current_dir[t_idx][r][c] = round(cd, 1) if cd is not None else None

    out_marine = {
        "fetched_at": sekarang_iso(),
        "sumber": "Open-Meteo Marine (CC BY 4.0)",
        "catatan": "Akurasi data pesisir terbatas dan resolusinya kasar.",
        "grid": {
            "lat_max": grid_def["lat_max"],
            "lat_min": grid_def["lat_min"],
            "lon_min": grid_def["lon_min"],
            "lon_max": grid_def["lon_max"],
            "dlat": grid_def["dlat"],
            "dlon": grid_def["dlon"],
            "ny": ny,
            "nx": nx,
        },
        "times": master_times,
        "variables": {
            "wave_height": grid_wave_h,
            "wave_direction": grid_wave_dir,
            "wave_period": grid_wave_per,
            "current_velocity": grid_current_v,
            "current_direction": grid_current_dir,
        },
    }

    with open(FILE_MARINE_OUT, "w", encoding="utf-8") as f:
        json.dump(out_marine, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Tersimpan: {FILE_MARINE_OUT} ({os.path.getsize(FILE_MARINE_OUT):,} bytes)")


def main():
    t0 = time.time()
    grid_def = buat_koordinat_grid(dlat=0.05, dlon=0.05, margin=0.08)
    proses_grid_cuaca(grid_def)
    proses_grid_laut(grid_def)
    print(f"Selesai seluruh proses Open-Meteo dalam {time.time() - t0:.1f} detik.")


if __name__ == "__main__":
    main()
