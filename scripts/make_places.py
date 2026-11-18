#!/usr/bin/env python3
"""Make site/edit/places.json, the built-in places list for the editor app.

Run by hand when the list should be refreshed (rarely; it's committed):

    python scripts/make_places.py            # downloads from download.geonames.org
    python scripts/make_places.py DIR        # or reads the three files from DIR

Source: GeoNames (https://www.geonames.org/), CC BY 4.0. Uses cities15000
(cities with 15,000+ people), admin1CodesASCII (states/regions) and
countryInfo (countries). Only names and ids are kept: no coordinates.

Format (compact, arrays to keep the download small):
    countries: [[cc, name], ...]                 sorted by name
    regions:   [[code, name, country_index], ...]  code like "IT.16"
    cities:    [[geonameid, name, region_index or -1, country_index, ascii?], ...]
               sorted by population, largest first (search ranks by size);
               ascii is only present when it differs from name (Zürich/Zurich)
"""
from __future__ import annotations

import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "edit" / "places.json"
BASE = "https://download.geonames.org/export/dump/"
# Parts of a city (Zürich (Kreis 3)), historical, abandoned and destroyed places.
SKIP_CODES = {"PPLX", "PPLH", "PPLQ", "PPLW"}
FILES = ["cities15000.zip", "admin1CodesASCII.txt", "countryInfo.txt"]


def read(src: Path | None, name: str) -> bytes:
    if src:
        return (src / name).read_bytes()
    with urllib.request.urlopen(BASE + name, timeout=60) as r:  # noqa: S310 (fixed https URL)
        return r.read()


def rows(text: str):
    for line in text.splitlines():
        if line and not line.startswith("#"):
            yield line.split("\t")


def make(src: Path | None = None) -> dict:
    countries = {r[0]: r[4] for r in rows(read(src, "countryInfo.txt").decode("utf-8")) if len(r) > 4}
    admin1 = {r[0]: r[1] for r in rows(read(src, "admin1CodesASCII.txt").decode("utf-8")) if len(r) > 1}
    with zipfile.ZipFile(io.BytesIO(read(src, "cities15000.zip"))) as z:
        cities_txt = z.read("cities15000.txt").decode("utf-8")

    cities = []
    for r in rows(cities_txt):
        # geonameid, name, asciiname, alternatenames, lat, lon, fclass, fcode, cc, cc2, admin1, ..., population(14)
        gid, name, ascii_name, cc, a1, pop = int(r[0]), r[1].strip(), r[2].strip(), r[8], r[10], int(r[14] or 0)
        if cc not in countries or not name or r[7] in SKIP_CODES:
            continue
        cities.append((pop, gid, name, ascii_name, cc, f"{cc}.{a1}" if f"{cc}.{a1}" in admin1 else None))
    cities.sort(key=lambda c: (-c[0], c[2]))

    used_cc = sorted({c[4] for c in cities} | set(countries), key=lambda cc: countries[cc])
    c_index = {cc: i for i, cc in enumerate(used_cc)}
    region_codes = sorted((code for code in admin1 if code.split(".")[0] in c_index),
                          key=lambda code: (countries[code.split(".")[0]], admin1[code]))
    r_index = {code: i for i, code in enumerate(region_codes)}

    out_cities = []
    for _pop, gid, name, ascii_name, cc, region in cities:
        row = [gid, name, r_index[region] if region else -1, c_index[cc]]
        if ascii_name and ascii_name != name:
            row.append(ascii_name)
        out_cities.append(row)
    return {
        "source": "GeoNames (geonames.org), CC BY 4.0. Cities of 15,000+ people.",
        "countries": [[cc, countries[cc]] for cc in used_cc],
        "regions": [[code, admin1[code], c_index[code.split(".")[0]]] for code in region_codes],
        "cities": out_cities,
    }


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    data = make(src)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"{len(data['cities'])} cities, {len(data['regions'])} regions, "
          f"{len(data['countries'])} countries -> {OUT} ({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
