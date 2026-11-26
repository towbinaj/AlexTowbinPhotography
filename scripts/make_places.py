#!/usr/bin/env python3
"""Make site/edit/places.json, the built-in places list for the editor app.

Run by hand when the list should be refreshed (rarely; it's committed):

    python scripts/make_places.py            # downloads from download.geonames.org
    python scripts/make_places.py DIR        # or reads the files in FILES from DIR

Source: GeoNames (https://www.geonames.org/), CC BY 4.0. Uses cities1000
(towns with 1,000+ people, plus admin seats like Mílos), inhabited islands
(1,000+ people, e.g. Santorini Island) streamed from allCountries, English
names from alternateNamesV2 (Irákleion is shown as Heraklion; both search),
admin1CodesASCII (states/regions) and countryInfo (countries). Only names and
ids are kept: no coordinates.

Format (compact, arrays to keep the download small):
    countries: [[cc, name], ...]                 sorted by name
    regions:   [[code, name, country_index], ...]  code like "IT.16"
    cities:    [[geonameid, name, region_index or -1, country_index, aliases?], ...]
               sorted by population, largest first (search ranks by size);
               aliases: other searchable forms, "|"-separated (local name,
               ASCII spelling, English names); only present when there are any
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
CITIES = "cities1000.zip"
FILES = [CITIES, "admin1CodesASCII.txt", "countryInfo.txt", "islands.txt", "english.txt"]
ISLAND_CODES = {"ISL", "ISLS", "ATOL"}  # island, islands, atoll
MIN_ISLAND_POP = 1000


def read(src: Path | None, name: str) -> bytes:
    if src:
        return (src / name).read_bytes()
    with urllib.request.urlopen(BASE + name, timeout=60) as r:  # noqa: S310 (fixed https URL)
        return r.read()


def stream_zip_lines(url: str, member: str, keep) -> list[str]:
    """Lines of one member of a big remote zip for which keep(fields) is true,
    streamed and filtered so the whole file is never held in memory. Walks the
    zip's local entries in order (deflate or stored)."""
    import struct
    import zlib
    out: list[str] = []
    with urllib.request.urlopen(url, timeout=120) as r:  # noqa: S310 (fixed https URL)
        pending = b""

        def take(n: int) -> bytes:
            nonlocal pending
            while len(pending) < n:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                pending += chunk
            got, pending = pending[:n], pending[n:]
            return got

        while True:
            head = take(30)
            if len(head) < 30 or head[:4] != b"PK\x03\x04":
                break  # central directory: no more entries
            method, = struct.unpack("<H", head[8:10])
            name_len, extra_len = struct.unpack("<HH", head[26:30])
            name = take(name_len).decode("utf-8", "replace")
            take(extra_len)
            want = name == member
            dec, buf = zlib.decompressobj(-15) if method == 8 else None, b""
            while True:
                data = pending or r.read(1 << 20)
                pending = b""
                if not data:
                    break
                text = dec.decompress(data)
                if want:
                    buf += text
                    *lines, buf = buf.split(b"\n")
                    for line in lines:
                        f = line.decode("utf-8", "replace").split("\t")
                        if keep(f):
                            out.append("\t".join(f))
                if dec.eof:
                    pending = dec.unused_data
                    break
            if want:
                return out
            # skip a data descriptor if present (bit 3): optional signature + 12 bytes
            if struct.unpack("<H", head[6:8])[0] & 8:
                d = take(4)
                take(12 if d == b"PK\x07\x08" else 8)
    return out


def stream_islands() -> str:
    """Populated islands from allCountries.zip (~400 MB)."""
    keep = lambda f: len(f) > 14 and f[7] in ISLAND_CODES and int(f[14] or 0) >= MIN_ISLAND_POP
    return "\n".join(stream_zip_lines(BASE + "allCountries.zip", "allCountries.txt", keep)) + "\n"


def stream_english() -> str:
    """English names (alternateNamesV2: id, geonameid, lang, name, preferred,
    short, colloquial, historic, …), e.g. Heraklion for Irákleion. Not
    historic or colloquial names, not abbreviations."""
    keep = lambda f: len(f) > 7 and f[2] == "en" and f[6] != "1" and f[7] != "1" and not f[3].isupper() and 0 < len(f[3]) <= 60
    return "\n".join(stream_zip_lines(BASE + "alternateNamesV2.zip", "alternateNamesV2.txt", keep)) + "\n"


def read_english(src: Path | None) -> str:
    if src:
        f = src / "english.txt"
        return f.read_text(encoding="utf-8") if f.exists() else ""
    return stream_english()


def english_names(text: str, wanted: set[int]) -> dict[int, list[str]]:
    out: dict[int, list[str]] = {}
    for f in rows(text):
        if len(f) > 3 and f[1].isdigit() and int(f[1]) in wanted:
            names = out.setdefault(int(f[1]), [])
            if f[3].strip() not in names:
                names.append(f[3].strip())
    return out


def display_and_aliases(name: str, ascii_name: str, english: list[str]) -> tuple[str, list[str]]:
    """GeoNames' own name is often the local form (Irákleion, Pátra). When it
    has accents and an English name exists, show the shortest plain-ASCII
    English name (Heraklion, Patras); every other form stays searchable."""
    shown = name
    if not name.isascii():
        plain = sorted((n for n in english if n.isascii()), key=lambda n: (len(n), n))
        if plain:
            shown = plain[0]
    aliases = []
    for n in [name, ascii_name, *english]:
        if n and n != shown and n not in aliases:
            aliases.append(n)
    return shown, aliases


def read_islands(src: Path | None) -> str:
    if src:
        f = src / "islands.txt"
        return f.read_text(encoding="utf-8") if f.exists() else ""
    return stream_islands()


def rows(text: str):
    for line in text.splitlines():
        if line and not line.startswith("#"):
            yield line.split("\t")


def make(src: Path | None = None) -> dict:
    countries = {r[0]: r[4] for r in rows(read(src, "countryInfo.txt").decode("utf-8")) if len(r) > 4}
    admin1 = {r[0]: r[1] for r in rows(read(src, "admin1CodesASCII.txt").decode("utf-8")) if len(r) > 1}
    with zipfile.ZipFile(io.BytesIO(read(src, CITIES))) as z:
        cities_txt = z.read(CITIES.replace(".zip", ".txt")).decode("utf-8")
    islands_txt = read_islands(src)

    city_rows = list(rows(cities_txt))
    # An island named exactly like a town in the same country (Mykonos) would
    # just be a duplicate in the picker: keep the town.
    town_names = {(r[8], r[1].strip().lower()) for r in city_rows if len(r) > 14}
    island_rows = [r for r in rows(islands_txt) if len(r) > 14 and (r[8], r[1].strip().lower()) not in town_names]
    cities, seen = [], set()
    for r in [*city_rows, *island_rows]:
        # geonameid, name, asciiname, alternatenames, lat, lon, fclass, fcode, cc, cc2, admin1, ..., population(14)
        gid, name, ascii_name, cc, a1, pop = int(r[0]), r[1].strip(), r[2].strip(), r[8], r[10], int(r[14] or 0)
        if cc not in countries or not name or r[7] in SKIP_CODES or gid in seen:
            continue
        seen.add(gid)
        cities.append((pop, gid, name, ascii_name, cc, f"{cc}.{a1}" if f"{cc}.{a1}" in admin1 else None))
    cities.sort(key=lambda c: (-c[0], c[2]))

    used_cc = sorted({c[4] for c in cities} | set(countries), key=lambda cc: countries[cc])
    c_index = {cc: i for i, cc in enumerate(used_cc)}
    region_codes = sorted((code for code in admin1 if code.split(".")[0] in c_index),
                          key=lambda code: (countries[code.split(".")[0]], admin1[code]))
    r_index = {code: i for i, code in enumerate(region_codes)}

    english = english_names(read_english(src), {c[1] for c in cities})
    out_cities = []
    for _pop, gid, name, ascii_name, cc, region in cities:
        shown, aliases = display_and_aliases(name, ascii_name, english.get(gid, []))
        row = [gid, shown, r_index[region] if region else -1, c_index[cc]]
        if aliases:
            row.append("|".join(aliases))
        out_cities.append(row)
    return {
        "source": "GeoNames (geonames.org), CC BY 4.0. Towns of 1,000+ people and inhabited islands.",
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
