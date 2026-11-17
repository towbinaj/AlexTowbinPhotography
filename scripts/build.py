#!/usr/bin/env python3
"""Build the photography site into _site/.

Photos come from an iCloud shared album. Set ICLOUD_ALBUM to the album's
public link (or just its token), e.g.
    https://photos.icloud.com/shared/album/03eXXXXXXXXXXXXXXXXXXXXXX
Both Apple formats are supported:
  * new "Shared Collections" links (photos.icloud.com/shared/album/<token>), read
    through iCloud's public CloudKit endpoints, and
  * classic shared albums with "Public Website" on (icloud.com/sharedalbum/#B0...).
Without ICLOUD_ALBUM, images committed to photos/ are used instead.

Every image is re-encoded, which strips all metadata (EXIF, GPS, camera info);
orientation is applied to the pixels first so nothing ends up sideways.

Usage:
    python scripts/build.py              # build from iCloud or photos/
    python scripts/build.py --demo 24    # build with generated placeholder images
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import io
import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import requests
from PIL import Image, ImageOps

try:  # lets photos/ contain iPhone .HEIC files (and iCloud originals in HEIC)
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

ROOT = Path(__file__).resolve().parent.parent
SITE_SRC = ROOT / "site"
OUT = ROOT / "_site"
CACHE = ROOT / ".cache" / "originals"
LOCAL_PHOTOS = ROOT / "photos"

# Long-edge sizes generated for every photo (served via srcset as WebP).
SIZES = [480, 960, 1600, 2400, 3200]
WEBP_QUALITY = 80
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"}
UA = "photo-site-builder/1.0"


@dataclass
class Photo:
    id: str
    source: Path
    caption: str = ""
    taken: str = ""   # ISO date the photo was taken, if known
    added: str = ""   # ISO date it was added to the album


def iso_ms(ms) -> str:
    try:
        return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        return ""


def parse_album(value: str) -> str:
    """Accept a full share URL or a bare token; return the token."""
    v = value.strip()
    m = re.search(r"/shared/(?:album|gallery)/([^/?#\s]+)", v)
    if m:
        return m.group(1)
    if "#" in v:
        v = v.split("#", 1)[1]
    return v.split(";")[0].strip().strip("/")


def _post(session: requests.Session, url: str, payload: dict, params: dict | None = None) -> requests.Response:
    last: Exception | None = None
    for attempt in range(4):
        try:
            r = session.post(url, params=params, data=json.dumps(payload), timeout=60)
            if r.status_code < 500:
                return r
            last = RuntimeError(f"HTTP {r.status_code} from {url}")
        except requests.RequestException as e:
            last = e
        time.sleep(2 ** attempt)
    raise RuntimeError(f"iCloud request failed: {last}")


# --------------------------------------------------------------------------
# New iCloud "Shared Collections" (photos.icloud.com/shared/album/<token>)
# --------------------------------------------------------------------------

CK_BASE = "https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production"
VIDEO_HINTS = ("movie", "mpeg", "video", "avi")


def _decode_text(field: dict | None) -> str:
    """Caption/title fields are base64; skip binary plists."""
    if not field or not field.get("value"):
        return ""
    try:
        raw = base64.b64decode(field["value"])
    except Exception:
        return ""
    if raw.startswith(b"bplist"):
        return ""
    return raw.decode("utf-8", "ignore").strip()


# --- location report (diagnostic, LOCATION_REPORT=1) ------------------------
# Answers "where could a photo's location come from?" without leaking it. The
# build log is public, so this prints field names, types and counts only:
# never coordinates, place names, or any other value.
_LOC_HINT = re.compile(r"loc|gps|lat|lon|geo|place|metadata|timezone|keyword", re.I)
_SAFE_NAME = re.compile(r"^[{A-Za-z_$][\w$.:{} -]{0,63}$")


def location_report_enabled() -> bool:
    return os.environ.get("LOCATION_REPORT", "").strip().lower() in ("1", "true", "yes")


def _plist_shape(raw: bytes) -> str:
    """Describe a binary plist by its dict keys and archived class names only."""
    import plistlib
    try:
        obj = plistlib.loads(raw)
    except Exception:
        return "binary plist (unreadable)"
    names: set[str] = set()

    def walk(o, depth=0):
        if depth > 8:
            return
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(k, str) and _SAFE_NAME.match(k):
                    names.add(k)
                if k == "$classname" and isinstance(v, str) and _SAFE_NAME.match(v):
                    names.add("class:" + v)
                walk(v, depth + 1)
        elif isinstance(o, list):
            for v in o:
                walk(v, depth + 1)

    walk(obj)
    gps = obj.get("{GPS}") if isinstance(obj, dict) else None
    has = isinstance(gps, dict) and "Latitude" in gps and "Longitude" in gps
    return ("HAS-GPS " if has else "") + "plist{" + ",".join(sorted(names)[:60]) + "}"


def _value_shape(v) -> str:
    if isinstance(v, dict):
        return "object{" + ",".join(sorted(k for k in v if isinstance(k, str) and _SAFE_NAME.match(k))) + "}"
    if isinstance(v, bool) or isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        try:
            raw = base64.b64decode(v, validate=True)
        except Exception:
            return "string"
        if raw.startswith(b"bplist"):
            return _plist_shape(raw)
        try:
            raw.decode("utf-8")
            return "base64 text"
        except UnicodeDecodeError:
            return f"base64 binary ({len(raw)} bytes)"
    return type(v).__name__


def location_report(asset_fields: list[dict], master_fields: list[dict]) -> list[str]:
    """Summarize which record fields might hold a location. Names/types/counts only."""
    from collections import Counter
    lines = []
    for label, rows in (("CPLAsset", asset_fields), ("CPLMaster", master_fields)):
        names = sorted({k for f in rows for k in f if isinstance(k, str) and _SAFE_NAME.match(k)})
        lines.append(f"{label} fields across {len(rows)} records: {', '.join(names)}")
        for n in names:
            if not _LOC_HINT.search(n):
                continue
            present = [f[n] for f in rows if isinstance(f.get(n), dict) and f[n].get("value") not in (None, "")]
            types = Counter(str(x.get("type", "?")) for x in present)
            shapes = Counter(_value_shape(x.get("value")) for x in present)
            lines.append(f"  {label}.{n}: set on {len(present)}/{len(rows)}; "
                         f"types {dict(types)}; shapes {dict(shapes)}")
    return lines


def gps_report(paths: list[Path]) -> list[str]:
    """Count downloaded files that carry EXIF GPS coordinates (yes/no only)."""
    from collections import Counter
    has, total, fmts = 0, 0, Counter()
    for p in paths:
        total += 1
        try:
            with Image.open(p) as im:
                fmts[im.format or "?"] += 1
                gps = im.getexif().get_ifd(0x8825)
                if gps.get(2) and gps.get(4):  # GPSLatitude and GPSLongitude
                    has += 1
        except Exception:
            fmts["unreadable"] += 1
    return [f"downloaded files with EXIF GPS: {has}/{total}; formats {dict(fmts)}"]


def _ck_session(session: requests.Session | None) -> requests.Session:
    s = session or requests.Session()
    s.headers.update({"Content-Type": "text/plain", "Origin": "https://photos.icloud.com", "User-Agent": UA})
    return s


def _comment_text(fields: dict) -> str:
    """Text of a CPLTextComment record (plain or base64-encoded field)."""
    v = (fields.get("commentText") or {}).get("value")
    if isinstance(v, str) and v.strip():
        return v.strip()
    return _decode_text(fields.get("commentTextEnc"))


def fetch_owner_comments(s, query_url: str, params: dict, zone: dict, owner: str,
                         asset_names: list[str], stats: dict | None = None) -> dict[str, str]:
    """Map asset recordName -> the album owner's earliest comment on it.

    Shared-album comments live in their own records, listed per photo. Only the
    owner's comments are used (anyone who joins via the link can comment). Any
    failure just means "no comment": captions are a nice-to-have, never a reason
    to fail the build.
    """
    out: dict[str, str] = {}
    stats = stats if stats is not None else {}
    for name in asset_names:
        q = {
            "query": {
                "recordType": "CPLTextCommentForAsset",
                "filterBy": [
                    {"fieldName": "startRank", "comparator": "EQUALS", "fieldValue": {"value": 0, "type": "INT64"}},
                    {"fieldName": "direction", "comparator": "EQUALS", "fieldValue": {"value": "ASCENDING", "type": "STRING"}},
                    {"fieldName": "parentId", "comparator": "EQUALS", "fieldValue": {"value": name, "type": "STRING"}},
                ],
            },
            "zoneID": zone,
            "resultsLimit": 50,
        }
        try:
            r = _post(s, query_url, q, params=params)
            if r.status_code >= 400:
                stats["errors"] = stats.get("errors", 0) + 1
                stats.setdefault("error_codes", set()).add(r.status_code)
                continue
            records = r.json().get("records") or []
        except Exception:
            stats["errors"] = stats.get("errors", 0) + 1
            continue
        comments = [x for x in records if x.get("recordType") == "CPLTextComment"]
        stats["comment_records"] = stats.get("comment_records", 0) + len(comments)
        for x in comments:
            stats.setdefault("fields", set()).update((x.get("fields") or {}).keys())
        mine = [x for x in comments if (x.get("created") or {}).get("userRecordName") == owner]
        mine.sort(key=lambda x: ((x.get("fields") or {}).get("commentTimestamp") or {}).get("value") or 0)
        for x in mine:
            text = _comment_text(x.get("fields") or {})
            if text:
                out[name] = text
                break
    stats["photos_with_owner_comment"] = len(out)
    return out


def fetch_cloudkit_album(token: str, session: requests.Session | None = None) -> tuple[str, list[dict]]:
    """Return (album_name, [{checksum, url, caption, taken, added}]) for a shared collection."""
    s = _ck_session(session)
    r = _post(s, f"{CK_BASE}/public/records/resolve", {"shortGUIDs": [{"value": token}]},
              params={"remapEnums": "true", "sharing_url_key": token})
    r.raise_for_status()
    results = r.json().get("results") or []
    if not results or "anonymousPublicAccess" not in results[0]:
        raise RuntimeError("Album link did not resolve to a public album (is link sharing on?)")
    res = results[0]
    access = res["anonymousPublicAccess"]
    zone = res["zoneID"]
    owner = zone.get("ownerRecordName")
    name = (((res.get("share") or {}).get("fields") or {}).get("cloudkit.title") or {}).get("value", "")
    partition = access["databasePartition"].rstrip("/")
    query_url = f"{partition}/database/1/com.apple.photos.cloud/production/shared/records/query"
    params = {"remapEnums": "true", "sharing_url_key": token, "publicAccessAuthToken": access["token"]}

    assets: list[dict] = []
    masters: dict[str, dict] = {}
    record_types: dict[str, int] = {}
    rank = 0
    for _ in range(1000):  # hard stop; 100 assets per page
        q = {
            "query": {
                "recordType": "CPLAssetAndMasterByAddedDate",
                "filterBy": [
                    {"fieldName": "direction", "comparator": "EQUALS",
                     "fieldValue": {"value": "ASCENDING", "type": "STRING"}},
                    {"fieldName": "startRank", "comparator": "EQUALS",
                     "fieldValue": {"value": rank, "type": "INT64"}},
                ],
            },
            "zoneID": zone,
            "resultsLimit": 200,
        }
        r = _post(s, query_url, q, params=params)
        r.raise_for_status()
        records = r.json().get("records") or []
        page_assets = [x for x in records if x.get("recordType") == "CPLAsset"]
        for x in records:
            record_types[str(x.get("recordType", "?"))] = record_types.get(str(x.get("recordType", "?")), 0) + 1
        for x in records:
            if x.get("recordType") == "CPLMaster":
                masters[x["recordName"]] = x
        assets += page_assets
        if not page_assets:
            break
        rank += len(page_assets)

    items = []
    seen = set()
    not_owner = 0
    published_af: list[dict] = []
    published_mf: list[dict] = []
    for a in assets:
        af = a.get("fields") or {}
        if a["recordName"] in seen:
            continue
        seen.add(a["recordName"])
        # Only publish photos the album owner added. Anyone who joins via the
        # link can add photos to a shared album; those never reach the site.
        if not owner or (a.get("created") or {}).get("userRecordName") != owner:
            not_owner += 1
            continue
        if any(int((af.get(k) or {}).get("value") or 0) for k in ("isHidden", "isDeleted", "trashReason")):
            continue
        mref = ((af.get("masterRef") or {}).get("value") or {}).get("recordName")
        mf = (masters.get(mref) or {}).get("fields") or {}
        item_type = ((mf.get("itemType") or {}).get("value") or "").lower()
        if any(h in item_type for h in VIDEO_HINTS):
            continue  # stills only
        orig_type = ((mf.get("resOriginalFileType") or {}).get("value") or "").lower()
        candidates = [
            af.get("resJPEGFullRes"),                     # edited version, if edited in Photos
            mf.get("resOriginalRes") if any(t in orig_type for t in ("jpeg", "heic", "png", "tiff")) else None,
            mf.get("resJPEGFullRes"),
            mf.get("resJPEGMedRes"),
        ]
        pick = next((i for i, c in enumerate(candidates) if c and (c.get("value") or {}).get("downloadURL")), None)
        if pick is None:
            continue
        res = candidates[pick]["value"]
        published_af.append(af)
        published_mf.append(mf)
        items.append({
            "checksum": res.get("fileChecksum") or res["downloadURL"],
            "url": res["downloadURL"].replace("${f}", "photo.jpg"),
            "caption": _decode_text(af.get("captionEnc")) or _decode_text(af.get("titleEnc")),
            "taken": iso_ms((af.get("assetDate") or {}).get("value")),
            "added": iso_ms((af.get("addedDate") or {}).get("value")),
            "source": ("edited", "original", "jpeg-full", "jpeg-medium")[pick],
            "_asset": a["recordName"],
        })
    if not_owner:
        print(f"  ignored {not_owner} photo(s) added by someone other than the album owner")
    # Photos captions don't travel into shared albums, but comments do: use the
    # owner's first comment on a photo as its title when there's no caption.
    comment_stats: dict = {}
    need = [i["_asset"] for i in items if not i["caption"]]
    comments = fetch_owner_comments(s, query_url, params, zone, owner, need, comment_stats) if need else {}
    for i in items:
        if not i["caption"] and comments.get(i["_asset"]):
            i["caption"] = comments[i["_asset"]]
        i.pop("_asset", None)
    if comments:
        print(f"  titles from album comments: {len(comments)}")
    if location_report_enabled():
        from collections import Counter
        print("Location report (field names, types and counts only):")
        print(f"  record types returned: {record_types}")
        for line in location_report(published_af, published_mf):
            print("  " + line)
        print(f"  image source used: {dict(Counter(i['source'] for i in items))}")
        print(f"  photos with a caption/title: {sum(1 for i in items if i['caption'])}/{len(items)}")
        print(f"  comment lookup: {comment_stats.get('comment_records', 0)} comment record(s); "
              f"{comment_stats.get('photos_with_owner_comment', 0)} photo(s) with an owner comment; "
              f"errors {comment_stats.get('errors', 0)} {sorted(comment_stats.get('error_codes', []))}; "
              f"fields {sorted(f for f in comment_stats.get('fields', []) if _SAFE_NAME.match(f))}")
    return name, items


# --------------------------------------------------------------------------
# Classic iCloud Shared Album with "Public Website" (icloud.com/sharedalbum/#B0...)
# --------------------------------------------------------------------------

BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def icloud_base_url(token: str) -> str:
    if token[0] == "A":
        partition = BASE62.index(token[1])
    else:
        partition = BASE62.index(token[1]) * 62 + BASE62.index(token[2])
    return f"https://p{partition:02d}-sharedstreams.icloud.com/{token}/sharedstreams/"


def fetch_sharedstream_album(token: str, session: requests.Session | None = None) -> tuple[str, list[dict]]:
    s = session or requests.Session()
    s.headers.update({"Content-Type": "text/plain", "User-Agent": UA})
    base = icloud_base_url(token)
    r = _post(s, base + "webstream", {"streamCtag": None})
    if r.status_code == 330:  # "wrong partition, use this host instead"
        base = f"https://{r.json()['X-Apple-MMe-Host']}/{token}/sharedstreams/"
        r = _post(s, base + "webstream", {"streamCtag": None})
    r.raise_for_status()
    stream = r.json()

    wanted = []
    for p in stream.get("photos", []):
        if p.get("mediaAssetType") == "video":
            continue
        best = None
        for key, d in (p.get("derivatives") or {}).items():
            if not key.isdigit() or not d.get("checksum"):
                continue
            size = int(d.get("width") or 0) * int(d.get("height") or 0) or int(key)
            if best is None or size > best[0]:
                best = (size, d)
        if best:
            wanted.append({"guid": p["photoGuid"], "checksum": best[1]["checksum"],
                           "caption": (p.get("caption") or "").strip(),
                           "taken": p.get("dateCreated") or "",
                           "added": p.get("batchDateCreated") or p.get("dateCreated") or ""})

    urls: dict[str, str] = {}
    guids = [w["guid"] for w in wanted]
    for i in range(0, len(guids), 25):
        r = _post(s, base + "webasseturls", {"photoGuids": guids[i:i + 25]})
        r.raise_for_status()
        body = r.json()
        locations = body.get("locations") or {}
        for checksum, item in (body.get("items") or {}).items():
            loc = locations.get(item["url_location"]) or {}
            host = (loc.get("hosts") or [item["url_location"]])[0]
            urls[checksum] = f"{loc.get('scheme', 'https')}://{host}{item['url_path']}"
    for w in wanted:
        w["url"] = urls.get(w["checksum"])
    return stream.get("streamName", ""), [w for w in wanted if w["url"]]


# --------------------------------------------------------------------------
# Download (with cache) + other sources
# --------------------------------------------------------------------------

def download_album(token: str) -> list[Photo]:
    if token[:1].isdigit():
        name, items = fetch_cloudkit_album(token)
    else:
        try:
            name, items = fetch_sharedstream_album(token)
        except Exception as legacy_err:  # maybe a newer-style token after all
            try:
                name, items = fetch_cloudkit_album(token)
            except Exception:
                raise legacy_err
    print(f"iCloud album {name!r}: {len(items)} photos")

    CACHE.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = UA
    photos = []
    for it in items:
        pid = hashlib.sha1(it["checksum"].encode()).hexdigest()[:12]
        dest = CACHE / f"{pid}.img"
        if not dest.exists():
            for attempt in range(3):
                try:
                    with session.get(it["url"], timeout=180, stream=True) as r:
                        r.raise_for_status()
                        tmp = dest.with_suffix(".part")
                        with open(tmp, "wb") as f:
                            for chunk in r.iter_content(1 << 20):
                                f.write(chunk)
                        tmp.replace(dest)
                    break
                except requests.RequestException as e:
                    if attempt == 2:
                        print(f"  could not download a photo: {e}", file=sys.stderr)
                    time.sleep(2 ** attempt)
            if not dest.exists():
                continue
        photos.append(Photo(id=pid, source=dest, caption=it["caption"], taken=it["taken"], added=it["added"]))

    if location_report_enabled():
        for line in gps_report([p.source for p in photos]):
            print("  " + line)

    keep = {p.source.name for p in photos}
    for f in CACHE.glob("*.img"):
        if f.name not in keep:
            f.unlink()
    return photos


def local_photos() -> list[Photo]:
    if not LOCAL_PHOTOS.is_dir():
        return []
    photos = []
    for f in sorted(LOCAL_PHOTOS.iterdir()):
        if f.suffix.lower() in IMAGE_EXTS:
            mtime = iso_ms(f.stat().st_mtime * 1000)
            pid = hashlib.sha1(f.name.encode()).hexdigest()[:12]
            photos.append(Photo(id=pid, source=f, taken=mtime, added=mtime))
    return photos


def demo_photos(n: int) -> list[Photo]:
    """Generated gradient placeholders, for previewing the layout."""
    import random
    rnd = random.Random(7)
    d = ROOT / ".cache" / "demo"
    d.mkdir(parents=True, exist_ok=True)
    photos = []
    for i in range(n):
        w, h = rnd.choice([(3000, 4000)] * 5 + [(4000, 3000), (3000, 3000)])
        f = d / f"demo{i:02d}-{w}x{h}.jpg"
        if not f.exists():
            c1 = tuple(rnd.randint(20, 235) for _ in range(3))
            c2 = tuple(rnd.randint(20, 235) for _ in range(3))
            grad = Image.linear_gradient("L").resize((w, h))
            Image.composite(Image.new("RGB", (w, h), c1), Image.new("RGB", (w, h), c2), grad).save(f, quality=80)
        photos.append(Photo(id=f"demo{i:02d}", source=f, caption=f"Placeholder {i + 1}",
                            taken=f"2026-0{i % 9 + 1}-01T00:00:00Z", added=f"2026-10-{i % 28 + 1:02d}T00:00:00Z"))
    return photos


# --------------------------------------------------------------------------
# Image processing + site output
# --------------------------------------------------------------------------

def trim_white_border(im: Image.Image, threshold: int = 232) -> Image.Image:
    """Crop a uniform white frame (e.g. an Instagram-style border) off a photo.

    Only trims when *every* side has a clean near-white margin of 0.4%-20% of
    the image, so photos that merely have a bright sky at one edge are left alone.
    """
    w, h = im.size
    gray = im.convert("L")
    small = gray.reduce(4) if min(w, h) > 400 else gray
    f = w / small.width
    mask = small.point(lambda v: 255 if v < threshold else 0)
    box = mask.getbbox()
    if not box:
        return im
    l, t, r, b = box[0] * f, box[1] * f, w - box[2] * f, h - box[3] * f
    lo_w, lo_h = 0.004 * w, 0.004 * h
    if not (lo_w <= l <= 0.2 * w and lo_w <= r <= 0.2 * w and lo_h <= t <= 0.2 * h and lo_h <= b <= 0.2 * h):
        return im
    inset = 2 * f  # shave the soft edge where frame meets photo
    crop = (round(l + inset), round(t + inset), round(w - r - inset), round(h - b - inset))
    return im.crop(crop)


# --------------------------------------------------------------------------
# Copyright
# --------------------------------------------------------------------------

def rights(config: dict) -> dict:
    """Copyright holder, year span and notice text, from config.json."""
    holder = config.get("copyright_holder") or config.get("name") or "the photographer"
    year = datetime.now(timezone.utc).year
    start = int(config.get("copyright_start_year") or year)
    years = f"{start}\u2013{year}" if start < year else str(year)
    notice = f"\u00a9 {years} {holder}. All rights reserved."
    terms = (f"All photographs are copyright {holder} and may not be copied, reproduced, "
             "distributed, modified, or used (including for AI training) without prior written permission.")
    return {"holder": holder, "years": years, "notice": notice, "terms": terms}


def rights_metadata(r: dict) -> tuple[bytes, bytes]:
    """EXIF + XMP blocks carrying only authorship/copyright (no camera, date or GPS data)."""
    exif = Image.Exif()
    exif[0x013B] = r["holder"]   # Artist
    # EXIF text is ASCII-only, so spell out the symbol there (XMP keeps the real ©).
    exif[0x8298] = r["notice"].replace("\u00a9", "Copyright").replace("\u2013", "-")
    esc = lambda t: html.escape(t, quote=True)
    xmp = f"""<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
 xmlns:plus="http://ns.useplus.org/ldf/xmp/1.0/" photoshop:Credit="{esc(r['holder'])}" xmpRights:Marked="True"
 plus:DataMining="http://ns.useplus.org/ldf/vocab/DMI-PROHIBITED">
<dc:creator><rdf:Seq><rdf:li>{esc(r['holder'])}</rdf:li></rdf:Seq></dc:creator>
<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">{esc(r['notice'])}</rdf:li></rdf:Alt></dc:rights>
<xmpRights:UsageTerms><rdf:Alt><rdf:li xml:lang="x-default">{esc(r['terms'])}</rdf:li></rdf:Alt></xmpRights:UsageTerms>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>"""
    return exif.tobytes(), xmp.encode("utf-8")


def render_images(photo: Photo, out_dir: Path, trim: bool = True,
                  meta: tuple[bytes, bytes] | None = None) -> dict | None:
    try:
        with Image.open(photo.source) as im:
            if im.format == "JPEG":
                im.draft("RGB", (SIZES[-1], SIZES[-1]))  # fast DCT downscale for huge originals
            im = ImageOps.exif_transpose(im)  # bake rotation in; original metadata is dropped on save
            im = im.convert("RGB")
            if trim:
                im = trim_white_border(im)
            w, h = im.size
            srcs = []
            for edge in SIZES:
                scale = min(1.0, edge / max(w, h))
                size = (max(1, round(w * scale)), max(1, round(h * scale)))
                if srcs and size[0] <= srcs[-1]["w"]:
                    break  # source is smaller than this step; don't upscale
                img = im if scale == 1.0 else im.resize(size, Image.LANCZOS)
                rel = f"img/{photo.id}-{size[0]}.webp"
                extra = {"exif": meta[0], "xmp": meta[1]} if meta else {}
                img.save(out_dir / rel, "WEBP", quality=WEBP_QUALITY, method=5, **extra)
                srcs.append({"w": size[0], "h": size[1], "url": rel})

            # Tiny blurred placeholder shown while the real image loads.
            tiny = im.copy()
            tiny.thumbnail((24, 24))
            buf = io.BytesIO()
            tiny.save(buf, "WEBP", quality=40)
            lqip = "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()

            return {"id": photo.id, "w": w, "h": h, "caption": photo.caption,
                    "taken": photo.taken, "added": photo.added, "lqip": lqip, "src": srcs,
                    "_im": im}
    except Exception as e:  # one bad file shouldn't sink the whole site
        print(f"  skipping {photo.source.name}: {e}", file=sys.stderr)
        return None


def sort_photos(photos: list[Photo], mode: str) -> list[Photo]:
    keys = {
        "newest-added": (lambda p: (p.added[:16], p.taken), True),   # minute precision, then taken date
        "oldest-added": (lambda p: (p.added[:16], p.taken), False),
        "newest-taken": (lambda p: p.taken, True),
        "oldest-taken": (lambda p: p.taken, False),
    }
    key, reverse = keys.get(mode, keys["newest-added"])
    return sorted(photos, key=key, reverse=reverse)


def json_ld(entries: list[dict], config: dict, r: dict, site_url: str) -> str:
    """schema.org structured data: who made the photos and who holds the copyright.

    Search engines (e.g. Google Images) read creator/copyrightNotice/creditText
    from ImageObject entries and show them alongside the image.
    """
    base = site_url + "/" if site_url else ""
    person = {"@type": "Person", "name": r["holder"]}
    if config.get("instagram"):
        person["sameAs"] = [f"https://www.instagram.com/{config['instagram'].lstrip('@')}/"]
    images = [{
        "@type": "ImageObject",
        "contentUrl": base + e["src"][-1]["url"],
        "thumbnailUrl": base + e["src"][0]["url"],
        "width": e["w"], "height": e["h"],
        **({"caption": e["caption"]} if e["caption"] else {}),
        "creator": person,
        "copyrightHolder": person,
        "copyrightNotice": r["notice"],
        "creditText": r["holder"],
        "license": base + "#rights",
        "acquireLicensePage": base + "#rights",
    } for e in entries]
    data = {
        "@context": "https://schema.org",
        "@type": "ImageGallery",
        "name": config.get("title", ""),
        "url": site_url or None,
        "author": person,
        "copyrightHolder": person,
        "copyrightYear": int(r["years"][-4:]),
        "copyrightNotice": r["notice"],
        "image": images,
    }
    data = {k: v for k, v in data.items() if v is not None}
    # Safe to inline in <script>: no "</" sequences survive.
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def build(photos: list[Photo], config: dict) -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(SITE_SRC, OUT)
    (OUT / "img").mkdir()

    photos = sort_photos(photos, config.get("sort", "newest-added"))
    if config.get("max_photos"):
        photos = photos[: int(config["max_photos"])]

    r = rights(config)
    meta = rights_metadata(r)
    entries = []
    og_written = False
    for p in photos:
        e = render_images(p, OUT, trim=config.get("trim_white_borders", False), meta=meta)
        if not e:
            continue
        im = e.pop("_im")
        if not og_written:  # social-preview image (JPEG for widest compatibility)
            og = im.copy()
            og.thumbnail((1200, 1200))
            og.save(OUT / "img" / "og.jpg", "JPEG", quality=82, exif=meta[0], xmp=meta[1])
            og_written = True
        entries.append(e)

    (OUT / "photos.json").write_text(json.dumps(entries, separators=(",", ":")))
    cfg = dict(config, built=datetime.now(timezone.utc).strftime("%Y-%m-%d"), rights=r)
    (OUT / "config.json").write_text(json.dumps(cfg))

    site_url = os.environ.get("SITE_URL", "").rstrip("/")
    title = html.escape(config.get("title", "Photography"))
    desc = html.escape(config.get("tagline") or config.get("title", ""))
    index = OUT / "index.html"
    index.write_text(index.read_text()
                     .replace("{{TITLE}}", title)
                     .replace("{{DESCRIPTION}}", desc)
                     .replace("{{AUTHOR}}", html.escape(r["holder"]))
                     .replace("{{COPYRIGHT}}", html.escape(r["notice"]))
                     .replace("{{JSONLD}}", json_ld(entries, config, r, site_url))
                     .replace("{{OG_IMAGE}}", f"{site_url}/img/og.jpg" if og_written else ""))
    (OUT / ".nojekyll").write_text("")
    print(f"Built {len(entries)} photos into {OUT}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", type=int, metavar="N", help="use N generated placeholder images")
    args = ap.parse_args()

    config = json.loads((ROOT / "config.json").read_text())
    album = os.environ.get("ICLOUD_ALBUM") or os.environ.get("ICLOUD_ALBUM_TOKEN") or ""
    token = parse_album(album) if album.strip() else ""

    if args.demo:
        photos = demo_photos(args.demo)
    elif token:
        photos = download_album(token)
        if not photos:
            # Fail loudly rather than publish an empty site over a good one.
            print("iCloud returned no photos; refusing to deploy an empty gallery.", file=sys.stderr)
            return 1
    else:
        photos = local_photos()
        print(f"No ICLOUD_ALBUM set; using {len(photos)} photos from photos/")

    build(photos, config)
    return 0


if __name__ == "__main__":
    sys.exit(main())
