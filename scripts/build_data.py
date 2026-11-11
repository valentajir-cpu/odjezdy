#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_data.py - prevede GTFS jizdni rad IDS JMK na kompaktni data.json
pro stranku s odjezdy (docs/index.html).

Pouziti:
    python scripts/build_data.py                 (stahne GTFS z KORDIS)
    python scripts/build_data.py cesta/gtfs.zip  (pouzije lokalni soubor)

Vystup: docs/data.json
"""
import csv
import io
import json
import re
import sys
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

# ============================================================
# 1. NASTAVENI
# ============================================================
GTFS_URL = "https://kordis-jmk.cz/gtfs/gtfs.zip"
OUT_FILE = Path(__file__).resolve().parent.parent / "docs" / "data.json"
MAX_DAYS = 120         # nejvyssi pocet dni platnosti, ktery se uklada
FORMAT_VERSION = 1


# ============================================================
# 2. NACTENI GTFS (stazeni nebo lokalni soubor)
# ============================================================
def load_zip(argv):
    if len(argv) > 1:
        print("Ctu lokalni soubor:", argv[1])
        return zipfile.ZipFile(argv[1])
    print("Stahuji:", GTFS_URL)
    req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "odjezdy-build/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read()
    print("Stazeno bajtu:", len(raw))
    return zipfile.ZipFile(io.BytesIO(raw))


def read_table(zf, name):
    with zf.open(name) as fh:
        text = io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")
        for row in csv.DictReader(text):
            yield row


# ============================================================
# 3. POMOCNE FUNKCE
# ============================================================
def to_minutes(hms):
    parts = hms.strip().split(":")
    return int(parts[0]) * 60 + int(parts[1])


def parse_date(s):
    return date(int(s[0:4]), int(s[4:6]), int(s[6:8]))


STOP_RE = re.compile(r"^U(\d+)Z(\d+)$")


# ============================================================
# 4. ZASTAVKY (uzel = vsechna nastupiste se stejnym cislem Uxxxx)
# ============================================================
def build_stops(zf):
    posts = {}          # stop_id -> (node, post_no, platform_code)
    nodes = {}          # node -> dict(name, zone, lat_sum, lon_sum, n)
    for r in read_table(zf, "stops.txt"):
        m = STOP_RE.match(r["stop_id"])
        if not m:
            continue
        node = int(m.group(1))
        post = int(m.group(2))
        posts[r["stop_id"]] = (node, post, (r.get("platform_code") or "").strip())
        nd = nodes.setdefault(node, {"name": r["stop_name"], "zone": r.get("zone_id", ""),
                                     "lat": 0.0, "lon": 0.0, "n": 0})
        nd["lat"] += float(r["stop_lat"])
        nd["lon"] += float(r["stop_lon"])
        nd["n"] += 1
    return posts, nodes


# ============================================================
# 5. KALENDAR (pro kazdou sluzbu retezec 0/1 po dnech od zakladniho data)
# ============================================================
def build_services(zf, base, n_days):
    days = [base + timedelta(days=i) for i in range(n_days)]
    wd_cols = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    active = {}
    for r in read_table(zf, "calendar.txt"):
        start = parse_date(r["start_date"])
        end = parse_date(r["end_date"])
        s = set()
        for d in days:
            if start <= d <= end and r[wd_cols[d.weekday()]] == "1":
                s.add(d)
        active[r["service_id"]] = s
    try:
        for r in read_table(zf, "calendar_dates.txt"):
            s = active.setdefault(r["service_id"], set())
            d = parse_date(r["date"])
            if r["exception_type"] == "1":
                s.add(d)
            elif r["exception_type"] == "2":
                s.discard(d)
    except KeyError:
        pass
    masks = {}
    for sid, s in active.items():
        masks[sid] = "".join("1" if d in s else "0" for d in days).rstrip("0")
    return masks


# ============================================================
# 6. HLAVNI LOGIKA - spoje -> vzory tras + casy odjezdu
# ============================================================
def main(argv):
    zf = load_zip(argv)

    # 6.1 Zakladni datum = den pred zacatkem platnosti (kvuli spojum po pulnoci).
    #     Zavisi jen na obsahu GTFS, takze stejny vstup da stejny vystup.
    cal = list(read_table(zf, "calendar.txt"))
    base = min(parse_date(r["start_date"]) for r in cal) - timedelta(days=1)
    last = max(parse_date(r["end_date"]) for r in cal)
    n_days = max(2, min(MAX_DAYS, (last - base).days + 1))
    generated = max(datetime(*zi.date_time) for zi in zf.infolist())

    posts, nodes = build_stops(zf)
    masks = build_services(zf, base, n_days)

    # 6.2 Linky
    routes = {}
    for r in read_table(zf, "routes.txt"):
        m = re.match(r"^L(\d+)D", r["route_id"])
        routes[r["route_id"]] = {
            "name": r["route_short_name"],
            "type": int(r["route_type"]),
            "color": (r.get("route_color") or "").upper(),
            "text": (r.get("route_text_color") or "").upper(),
            "line_id": int(m.group(1)) if m else 0,
        }

    # 6.3 Spoje
    trips = {}
    for r in read_table(zf, "trips.txt"):
        trips[r["trip_id"]] = (r["route_id"], r["service_id"], r.get("trip_headsign", ""))

    # 6.4 Zastaveni spoju (soubor je serazen po spojich, pro jistotu tridime)
    by_trip = {}
    for r in read_table(zf, "stop_times.txt"):
        by_trip.setdefault(r["trip_id"], []).append(
            (int(r["stop_sequence"]), r["stop_id"], to_minutes(r["arrival_time"]),
             to_minutes(r["departure_time"]), r.get("pickup_type", "0"), r.get("drop_off_type", "0")))

    # 6.5 Slouceni do vzoru
    used_nodes = set()
    patterns = {}       # key -> list of (start, service)
    skipped = 0
    for trip_id, rows in by_trip.items():
        if trip_id not in trips:
            skipped += 1
            continue
        route_id, service_id, headsign = trips[trip_id]
        mask = masks.get(service_id, "")
        if not mask or route_id not in routes:
            skipped += 1
            continue
        rows.sort()
        if any(row[1] not in posts for row in rows) or len(rows) < 2:
            skipped += 1
            continue
        start = rows[0][3]
        seq_nodes = tuple(posts[row[1]][0] for row in rows)
        seq_posts = tuple(posts[row[1]][1] for row in rows)
        dep = tuple(row[3] - start for row in rows)
        arr = tuple(row[2] - start for row in rows)
        # priznaky: 1 = nelze nastoupit, 2 = nelze vystoupit, 4 = na znameni
        flags = tuple((1 if row[4] == "1" else 0) | (2 if row[5] == "1" else 0) |
                      (4 if (row[4] == "3" or row[5] == "3") else 0) for row in rows)
        key = (route_id, headsign, seq_nodes, seq_posts, dep, arr, flags)
        patterns.setdefault(key, []).append((start, service_id))
        used_nodes.update(seq_nodes)

    # 6.6 Indexy
    node_list = sorted(used_nodes, key=lambda n: (nodes[n]["name"], n))
    node_idx = {n: i for i, n in enumerate(node_list)}
    route_list = sorted({k[0] for k in patterns}, key=lambda rid: (routes[rid]["type"], routes[rid]["name"]))
    route_idx = {rid: i for i, rid in enumerate(route_list)}
    svc_list = sorted({s for v in patterns.values() for _, s in v}, key=lambda x: (len(x), x))
    svc_idx = {s: i for i, s in enumerate(svc_list)}

    # 6.7 Platne kody nastupist (jen kde existuji)
    plat = {}
    for sid, (node, post, code) in posts.items():
        if code and node in node_idx:
            plat.setdefault(str(node_idx[node]), {})[str(post)] = code

    out_pat = []
    n_trips = 0
    for key, tlist in patterns.items():
        route_id, headsign, seq_nodes, seq_posts, dep, arr, flags = key
        tlist.sort()
        flat = []
        for start, sid in tlist:
            flat.append(start)
            flat.append(svc_idx[sid])
        n_trips += len(tlist)
        out_pat.append([
            route_idx[route_id],
            headsign,
            [node_idx[n] for n in seq_nodes],
            list(seq_posts),
            list(dep),
            list(arr) if arr != dep else 0,
            list(flags) if any(flags) else 0,
            flat,
        ])

    data = {
        "v": FORMAT_VERSION,
        "gen": generated.strftime("%Y-%m-%dT%H:%M:%S"),
        "base": base.strftime("%Y-%m-%d"),
        "stops": [[n, nodes[n]["name"], nodes[n]["zone"],
                   round(nodes[n]["lat"] / nodes[n]["n"], 5),
                   round(nodes[n]["lon"] / nodes[n]["n"], 5)] for n in node_list],
        "plat": plat,
        "routes": [[routes[r]["name"], routes[r]["type"], routes[r]["color"],
                    routes[r]["text"], routes[r]["line_id"]] for r in route_list],
        "svc": [masks[s] for s in svc_list],
        "pat": out_pat,
    }

    # ============================================================
    # 7. ZAPIS A KONTROLA
    # ============================================================
    if n_trips < 1000 or len(node_list) < 100:
        print("CHYBA: podezrele malo dat (spoju %d, zastavek %d), nezapisuji." % (n_trips, len(node_list)))
        return 1
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("Hotovo: zastavek %d, linek %d, vzoru %d, spoju %d, preskoceno %d" %
          (len(node_list), len(route_list), len(out_pat), n_trips, skipped))
    print("Zakladni datum:", data["base"], "| soubor:", OUT_FILE, "| bajtu:", OUT_FILE.stat().st_size)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except Exception as exc:  # errorhandling: at selze akce citelne
        print("CHYBA pri zpracovani GTFS:", repr(exc))
        sys.exit(1)
