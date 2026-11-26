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
import urllib.parse
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


def _ck_session(session: requests.Session | None) -> requests.Session:
    s = session or requests.Session()
    s.headers.update({"Content-Type": "text/plain", "Origin": "https://photos.icloud.com", "User-Agent": UA})
    return s


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
            if x.get("recordType") == "CPLMaster":
                masters[x["recordName"]] = x
        assets += page_assets
        if not page_assets:
            break
        rank += len(page_assets)

    items = []
    seen = set()
    not_owner = 0
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
        res = next((c["value"] for c in candidates if c and (c.get("value") or {}).get("downloadURL")), None)
        if not res:
            continue
        items.append({
            "checksum": res.get("fileChecksum") or res["downloadURL"],
            "url": res["downloadURL"].replace("${f}", "photo.jpg"),
            "caption": _decode_text(af.get("captionEnc")) or _decode_text(af.get("titleEnc")),
            "taken": iso_ms((af.get("assetDate") or {}).get("value")),
            "added": iso_ms((af.get("addedDate") or {}).get("value")),
        })
    if not_owner:
        print(f"  ignored {not_owner} photo(s) added by someone other than the album owner")
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

def download_album(token: str, skip=None) -> list[Photo]:
    """skip(pid) -> True when the photo's processed images are already cached,
    so its (large) original doesn't need downloading."""
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
        if skip and skip(pid) and not dest.exists():
            photos.append(Photo(id=pid, source=None, caption=it["caption"], taken=it["taken"], added=it["added"]))
            continue
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

    keep = {p.source.name for p in photos if p.source}
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


def has_location(im: Image.Image) -> bool:
    """Whether the original carries GPS coordinates (for the editor app's
    location check). Only this flag is published, never the coordinates."""
    try:
        gps = im.getexif().get_ifd(0x8825)
    except Exception:
        return False
    return 2 in gps and 4 in gps  # GPSLatitude and GPSLongitude


def render_images(photo: Photo, out_dir: Path, trim: bool = True,
                  meta: tuple[bytes, bytes] | None = None) -> dict | None:
    try:
        with Image.open(photo.source) as im:
            if im.format == "JPEG":
                im.draft("RGB", (SIZES[-1], SIZES[-1]))  # fast DCT downscale for huge originals
            located = has_location(im)        # yes/no only: coordinates are never published
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
                    "located": located,
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
        **({"keywords": ", ".join(e["tags"])} if e.get("tags") else {}),
        **({"contentLocation": {"@type": "Place", "name": place_label(e["place"])}} if e.get("place") else {}),
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


# Titles and order live in a separate data repo (config "data_repo"), written
# by the site's editor. CI checks it out into data/; CURATION_FILE overrides.
# The data is treated as untrusted: see load_curation().
CURATION = Path(os.environ.get("CURATION_FILE") or ROOT / "data" / "curation.json")
LEGACY_TITLES = ROOT / "titles.json"  # older editor format: {id: title}
MAX_TITLE = 200
MAX_ID = 64
MAX_ORDER = 5000
DATA_REPO_RE = re.compile(r"[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]")



# Title case (kept identical to titleCase() in site/app.js).
# Short words stay lowercase unless they start or end a part of the title;
# parts are split by "/", ":", "—" and "–". Words with capitals after the
# first letter (NYC, iPhone, McQueen) are left exactly as typed.
SMALL_WORDS = {"a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet",
               "as", "at", "by", "in", "of", "off", "on", "per", "to", "up", "via", "vs"}
_TC_SPLIT = re.compile(r"(\s+|/|:|—|–)")


def _tc_word(word: str, edge: bool) -> str:
    parts = word.split("-")
    out = []
    for i, part in enumerate(parts):
        letters = [c for c in part if c.isalpha()]
        core = "".join(letters).lower()
        if any(c.isupper() for c in letters[1:]):
            out.append(part)                       # deliberate capitals: keep
        elif core in SMALL_WORDS and not (edge and i == 0):
            out.append(part.lower())
        else:
            low = part.lower()
            j = next((k for k, c in enumerate(low) if c.isalpha()), None)
            out.append(low if j is None else low[:j] + low[j].upper() + low[j + 1:])
    return "-".join(out)


def title_case(text: str) -> str:
    tokens = _TC_SPLIT.split(" ".join(text.split()))
    words = [i for i, t in enumerate(tokens) if t and not _TC_SPLIT.fullmatch(t)]
    breaks = {i for i, t in enumerate(tokens) if t in ("/", ":", "—", "–")}
    for n, i in enumerate(words):
        prev_w = words[n - 1] if n else None
        next_w = words[n + 1] if n + 1 < len(words) else None
        first = prev_w is None or any(prev_w < b < i for b in breaks)
        last = next_w is None or any(i < b < next_w for b in breaks)
        tokens[i] = _tc_word(tokens[i], first or last)
    return "".join(tokens)


def clean_title(text: str) -> str:
    """Untrusted title -> safe display text (kept identical to cleanTitle() in app.js):
    control/invisible characters become spaces, whitespace collapses, at most
    MAX_TITLE characters, then title case."""
    return title_case(" ".join(_CONTROL.sub(" ", text).split())[:MAX_TITLE].strip())


def _clean_titles(data) -> dict[str, str]:
    out = {}
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(k, str) and 0 < len(k) <= MAX_ID and isinstance(v, str):
                v = clean_title(v)
                if v:
                    out[k] = v
    return out


def _read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def load_curation(path: Path = CURATION, legacy: Path = LEGACY_TITLES) -> tuple[dict[str, str], list[str]]:
    """(photo id -> title, photo ids in the owner's chosen order).

    A bad or missing file just means no titles / automatic order; it never
    fails the build.
    """
    data = _read_json(path)
    order: list[str] = []
    if not isinstance(data, dict):
        # Nothing saved in the current format yet: fall back to the older file.
        return _clean_titles(_read_json(legacy)), order
    titles = _clean_titles(data.get("titles"))
    seen = set()
    for pid in data.get("order") or []:
        if len(order) >= MAX_ORDER:
            break
        if isinstance(pid, str) and 0 < len(pid) <= MAX_ID and pid not in seen:
            seen.add(pid)
            order.append(pid)
    return titles, order


# ---- tags and places (kept identical to site/meta.js; parity-tested) ----
MAX_TAG = 40
MAX_PLACE_NAME = 80
MAX_PHOTO_TAGS = 30
_CC = re.compile(r"[A-Z]{2}")
_REGION_CODE = re.compile(r"[A-Z]{2}\.[A-Za-z0-9]{1,10}")


def clean_tag(text: str) -> str:
    return clean_title(text)[:MAX_TAG].strip()


def _place_name(v) -> str:
    if not isinstance(v, str):
        return ""
    return " ".join(_CONTROL.sub(" ", v).split())[:MAX_PLACE_NAME].strip()


def clean_place(raw) -> dict | None:
    """City, state/region or country only; anything else (or junk) -> None."""
    if not isinstance(raw, dict):
        return None
    cc = raw.get("cc") if isinstance(raw.get("cc"), str) and _CC.fullmatch(raw["cc"]) else ""
    country = _place_name(raw.get("country"))
    if not cc or not country:
        return None
    level = raw.get("level")
    if level == "country":
        return {"level": "country", "country": country, "cc": cc}
    region = _place_name(raw.get("region"))
    if level == "region":
        code = raw.get("code") if isinstance(raw.get("code"), str) and _REGION_CODE.fullmatch(raw["code"]) else ""
        return {"level": "region", "code": code, "region": region, "country": country, "cc": cc} if code and region else None
    if level == "city":
        city = _place_name(raw.get("city"))
        gid = raw.get("gid")
        if isinstance(gid, float) and gid.is_integer():
            gid = int(gid)
        if not (isinstance(gid, int) and not isinstance(gid, bool) and 0 < gid < 10**10) or not city:
            return None
        out = {"level": "city", "gid": gid, "city": city}
        if region:
            out["region"] = region
        return {**out, "country": country, "cc": cc}
    return None


def place_label(p: dict | None) -> str:
    """"Florence, Italy" · "Miami, Florida, United States" · "Tuscany, Italy" · "Italy"."""
    if not p:
        return ""
    if p["level"] == "country":
        return p["country"]
    if p["level"] == "region":
        return f"{p['region']}, {p['country']}"
    return ", ".join(x for x in (p["city"], p.get("region", "") if p["cc"] == "US" else "", p["country"]) if x)


def load_meta(path: Path = CURATION) -> tuple[dict[str, list[str]], dict[str, dict]]:
    """(photo id -> tags, photo id -> place) from curation.json. Only tags that
    are in the tag library count; bad entries are dropped, never fatal."""
    data = _read_json(path)
    if not isinstance(data, dict):
        return {}, {}
    library: dict[str, str] = {}
    for t in (data.get("tags") or [])[:300] if isinstance(data.get("tags"), list) else []:
        n = clean_tag(t) if isinstance(t, str) else ""
        if n and n.lower() not in library:
            library[n.lower()] = n
    tags: dict[str, list[str]] = {}
    raw_tags = data.get("photo_tags") if isinstance(data.get("photo_tags"), dict) else {}
    for pid, names in list(raw_tags.items())[:MAX_ORDER]:
        if not (isinstance(pid, str) and 0 < len(pid) <= MAX_ID and isinstance(names, list)):
            continue
        out: list[str] = []
        for t in names[:MAX_PHOTO_TAGS]:
            n = library.get(clean_tag(t).lower()) if isinstance(t, str) else None
            if n and n not in out:
                out.append(n)
        if out:
            tags[pid] = out
    places: dict[str, dict] = {}
    raw_places = data.get("locations") if isinstance(data.get("locations"), dict) else {}
    for pid, raw in list(raw_places.items())[:MAX_ORDER]:
        pl = clean_place(raw) if isinstance(pid, str) and 0 < len(pid) <= MAX_ID else None
        if pl:
            places[pid] = pl
    return tags, places


MAX_COLLECTION_NAME = 60


def load_collections(path: Path = CURATION, known: set[str] | None = None) -> list[dict]:
    """[{name, photos: [ids in order]}] from curation.json (set in the editor
    app). Same rules as the page: names cleaned like titles (max 60), no
    duplicate names, a photo in one collection at most, only known photos."""
    data = _read_json(path)
    raw = data.get("collections") if isinstance(data, dict) else None
    out, names, used = [], set(), set()
    for c in raw[:100] if isinstance(raw, list) else []:
        if not isinstance(c, dict):
            continue
        name = clean_title(str(c.get("name") or ""))[:MAX_COLLECTION_NAME].strip()
        if not name or name.lower() in names:
            continue
        ids = []
        for pid in (c.get("photos") or [])[:MAX_ORDER] if isinstance(c.get("photos"), list) else []:
            if isinstance(pid, str) and 0 < len(pid) <= MAX_ID and pid not in used and (known is None or pid in known):
                used.add(pid)
                ids.append(pid)
        if ids:
            names.add(name.lower())
            out.append({"name": name, "photos": ids})
    return out


def load_highlights(path: Path = CURATION, known: set[str] | None = None) -> list[str]:
    """Photo ids featured in the main page's opening slideshow (editor app)."""
    data = _read_json(path)
    raw = data.get("highlights") if isinstance(data, dict) else None
    out: list[str] = []
    for pid in raw[:MAX_ORDER] if isinstance(raw, list) else []:
        if isinstance(pid, str) and 0 < len(pid) <= MAX_ID and pid not in out and (known is None or pid in known):
            out.append(pid)
    return out


# ---- show on site (kept identical to visibility()/isShown() in site/meta.js) ----
_ISO = re.compile(r"\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?")


def _iso_time(v) -> float | None:
    if not isinstance(v, str) or not _ISO.fullmatch(v):
        return None
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:  # like JS Date.parse: date-only = UTC, date-time without zone = local (UTC in CI)
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def visibility(path: Path = CURATION) -> dict:
    """hidden / published id sets and the drafts_from time from curation.json."""
    data = _read_json(path)
    d = data if isinstance(data, dict) else {}

    def ids(v):
        return {x for x in (v[:MAX_ORDER] if isinstance(v, list) else []) if isinstance(x, str) and 0 < len(x) <= MAX_ID}
    return {"hidden": ids(d.get("hidden")), "published": ids(d.get("published")), "from": _iso_time(d.get("drafts_from"))}


def is_shown(pid: str, added: str, vis: dict) -> bool:
    """Pulled back -> hidden; released -> shown; added at/after drafts_from -> hidden (draft); else shown."""
    if pid in vis["hidden"]:
        return False
    if pid in vis["published"]:
        return True
    t = _iso_time(added)
    return not (vis["from"] is not None and t is not None and t >= vis["from"])


def apply_meta(entries: list[dict], tags: dict[str, list[str]], places: dict[str, dict]) -> None:
    for e in entries:
        if tags.get(e["id"]):
            e["tags"] = tags[e["id"]]
        if places.get(e["id"]):
            e["place"] = places[e["id"]]


def load_titles(path: Path = LEGACY_TITLES) -> dict[str, str]:
    """Titles from the older {id: title} file (kept for compatibility)."""
    return _clean_titles(_read_json(path))


def apply_order(photos: list, order: list[str]) -> list:
    """Put photos in the owner's chosen order.

    Photos not in the list yet (newly added to the album) come first, in the
    automatic order, so new work shows up at the top until it's placed.
    """
    if not order:
        return photos
    rank = {pid: i for i, pid in enumerate(order)}
    new = [p for p in photos if p.id not in rank]
    placed = sorted((p for p in photos if p.id in rank), key=lambda p: rank[p.id])
    return new + placed


def apply_titles(entries: list[dict], titles: dict[str, str]) -> None:
    """Titles set in the editor win over captions from the album.

    The album's own caption (often empty) is kept as `album_caption` so the
    page can fall back to it if the title is removed in the live data.
    """
    for e in entries:
        t = titles.get(e.get("id", ""))
        if t:
            e["album_caption"] = e.get("caption") or ""
            e["caption"] = t


GOATCOUNTER_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,48}")


def goatcounter_url(config: dict) -> str:
    """Count endpoint for GoatCounter (config "goatcounter": the site code you
    chose at signup, e.g. "alextowbin"), or "" when visitor counting is off."""
    code = str(config.get("goatcounter") or "").strip().lower()
    return f"https://{code}.goatcounter.com/count" if GOATCOUNTER_RE.fullmatch(code) else ""


def data_settings(config: dict) -> dict:
    """Where the page reads live titles/order from and the editor saves them."""
    repo = str(config.get("data_repo") or "")
    if not DATA_REPO_RE.fullmatch(repo):
        return {"data_repo": "", "data_url": ""}
    return {"data_repo": repo,
            "data_url": f"https://raw.githubusercontent.com/{repo}/main/curation.json"}


# ---- versioned assets + single-photo share pages ----
_SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
_LOCAL_ASSET = re.compile(r'((?:href|src)=")((?!https?:|//|#|data:)[^"?]+\.(?:css|js))(")')
OG_EDGE = 1200


def site_version(src: Path = SITE_SRC) -> str:
    """Short hash of the front-end files: changes whenever any of them does."""
    h = hashlib.sha256()
    for f in sorted(x for x in src.rglob("*") if x.is_file()):
        h.update(f.relative_to(src).as_posix().encode())
        h.update(f.read_bytes())
    return h.hexdigest()[:10]


def stamp_assets(page: str, version: str) -> str:
    """app.js -> app.js?v=<version> (local .js/.css only), so browsers never
    mix a new page with old cached scripts or styles."""
    return _LOCAL_ASSET.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={version}{m.group(3)}", page)


def _month_year(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%b %Y")
    except (ValueError, AttributeError):
        return ""


def photo_page(template: str, e: dict, config: dict, r: dict, site_url: str, og_size: tuple[int, int]) -> str:
    """HTML for p/<id>/: the photo, its title, place and date, and link-preview
    tags pointing at its own image. Everything from curation is escaped."""
    pid = e["id"]
    name = config.get("name") or config.get("title", "Photography")
    site_name = config.get("title") or name
    title = e.get("caption") or ""
    when = _month_year(e.get("taken", ""))
    place = place_label(e.get("place"))
    subline = " · ".join(x for x in (place, when) if x)
    page_title = f"{title} — {name}" if title else f"{name}{' — ' + when if when else ''}"
    base = site_url + "/" if site_url else "../../"
    page_url = f"{site_url}/p/{pid}/" if site_url else "./"
    srcs = e["src"]
    mid = srcs[min(2, len(srcs) - 1)]
    counter = goatcounter_url(config)
    pixel = (f"{counter}?p={urllib.parse.quote(f'/p/{pid}/')}&t={urllib.parse.quote(page_title)}" if counter else "")
    vals = {
        "COUNTER_PIXEL": pixel,
        "PAGE_TITLE": page_title, "DESCRIPTION": " · ".join(x for x in (subline, r["notice"]) if x),
        "AUTHOR": r["holder"], "COPYRIGHT": r["notice"], "SITE_NAME": site_name, "SITE_NAME_SHORT": name,
        "PAGE_URL": page_url, "OG_IMAGE": f"{base}img/{pid}-og.jpg", "OG_W": str(og_size[0]), "OG_H": str(og_size[1]),
        "ALT": title or f"Photograph by {r['holder']}", "HEADING": title or (when or "Untitled"),
        "SUBLINE": subline if title else place, "GALLERY_URL": f"../../work/#photo-{pid}",
        "IMG_SRC": "../../" + mid["url"], "IMG_SRCSET": ", ".join(f"../../{x['url']} {x['w']}w" for x in srcs),
        "W": str(e["w"]), "H": str(e["h"]),
    }
    out = template
    for k, v in vals.items():
        out = out.replace("{{" + k + "}}", html.escape(v, quote=True))
    if not counter:  # counting off: drop the pixel element entirely
        out = re.sub(r'\s*<img class="count"[^>]*>', "", out)
    return out


# ---- processed-image cache ----
# Each photo's finished images (all WebP sizes + its link-preview JPEG) and
# details are kept in .cache/rendered/<id>/ between builds (CI caches that
# folder), so only new photos are downloaded and processed. A key over the
# image settings and the rights metadata invalidates everything when either
# changes (e.g. a new copyright year).
RENDER_CACHE = ROOT / ".cache" / "rendered"
RENDER_VERSION = 1  # bump to force re-processing after changing render_images()


def render_key(config: dict) -> str:
    exif, xmp = rights_metadata(rights(config))
    blob = json.dumps({"v": RENDER_VERSION, "sizes": SIZES, "q": WEBP_QUALITY, "og": OG_EDGE,
                       "trim": bool(config.get("trim_white_borders", False)),
                       "exif": hashlib.sha256(exif).hexdigest(), "xmp": hashlib.sha256(xmp).hexdigest()})
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def cached_entry(pid: str, key: str, cache: Path = RENDER_CACHE) -> dict | None:
    """The cached render of a photo if it matches `key` and its files are all there."""
    if not _SAFE_ID.fullmatch(pid):
        return None
    d = cache / pid
    data = _read_json(d / "entry.json")
    if not isinstance(data, dict) or data.get("key") != key:
        return None
    files = [x["url"] for x in data.get("src", [])] + [f"img/{pid}-og.jpg"]
    if not data.get("src") or not all((d / f).is_file() for f in files):
        return None
    return data


def render_cached(photo: Photo, key: str, trim: bool, meta, out: Path, cache: Path = RENDER_CACHE) -> dict | None:
    """Photo entry for photos.json, with its images copied into out/img/. Uses
    the cache when possible; otherwise processes the original and caches it."""
    data = cached_entry(photo.id, key, cache)
    if data is None:
        if photo.source is None or not _SAFE_ID.fullmatch(photo.id):
            return None
        d = cache / photo.id
        shutil.rmtree(d, ignore_errors=True)
        (d / "img").mkdir(parents=True)
        e = render_images(photo, d, trim=trim, meta=meta)
        if not e:
            shutil.rmtree(d, ignore_errors=True)
            return None
        im = e.pop("_im")
        og = im.copy()
        og.thumbnail((OG_EDGE, OG_EDGE))
        og.save(d / "img" / f"{photo.id}-og.jpg", "JPEG", quality=82,
                **({"exif": meta[0], "xmp": meta[1]} if meta else {}))
        data = {"key": key, "w": e["w"], "h": e["h"], "lqip": e["lqip"], "src": e["src"],
                "located": e["located"], "og": list(og.size)}
        (d / "entry.json").write_text(json.dumps(data))
    for f in (cache / photo.id / "img").iterdir():
        target = out / "img" / f.name
        try:
            os.link(f, target)          # same disk: instant, no extra space
        except OSError:
            shutil.copy2(f, target)
    return {"id": photo.id, "w": data["w"], "h": data["h"], "caption": photo.caption,
            "taken": photo.taken, "added": photo.added, "lqip": data["lqip"], "src": data["src"],
            "located": data["located"], "_og": tuple(data["og"])}


PAGES = [("home", "", "Home"), ("work", "work", "Work"), ("collections", "collections", "Collections"), ("about", "about", "About")]


def build(photos: list[Photo], config: dict, use_cache: bool = True) -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(SITE_SRC, OUT)
    (OUT / "img").mkdir()

    titles, order = load_curation()
    photos = apply_order(sort_photos(photos, config.get("sort", "newest-added")), order)
    if config.get("max_photos"):
        photos = photos[: int(config["max_photos"])]

    r = rights(config)
    meta = rights_metadata(r)
    entries = []
    og_written = False
    vis = visibility()
    trim = config.get("trim_white_borders", False)
    key = render_key(config)
    cache = RENDER_CACHE if use_cache else OUT.parent / ".cache" / f"rendered-tmp-{os.getpid()}"
    for p in photos:
        e = render_cached(p, key, trim, meta, OUT, cache)
        if not e:
            print(f"  skipping {p.id}: not processed", file=sys.stderr)
            continue
        if is_shown(p.id, p.added, vis) and _SAFE_ID.fullmatch(p.id):
            # The first shown photo's link-preview image is also the site's.
            if not og_written:
                shutil.copy2(OUT / "img" / f"{p.id}-og.jpg", OUT / "img" / "og.jpg")
                og_written = True
        else:
            e.pop("_og", None)  # hidden: no share page
        entries.append(e)
    if use_cache:  # drop cached renders of photos no longer in the album
        current = {p.id for p in photos}
        for d in RENDER_CACHE.iterdir() if RENDER_CACHE.is_dir() else []:
            if d.is_dir() and d.name not in current:
                shutil.rmtree(d, ignore_errors=True)
    else:
        shutil.rmtree(cache, ignore_errors=True)

    apply_titles(entries, titles)
    apply_meta(entries, *load_meta())
    # Hidden photos stay in photos.json (the editor shows them, and releasing
    # one is instant) but are flagged, left out of the JSON-LD and never used
    # for the link preview. Not private: see README.
    for e in entries:
        if not is_shown(e["id"], e.get("added", ""), vis):
            e["draft"] = True
    shown = [e for e in entries if not e.get("draft")]
    og_sizes = {e["id"]: e.pop("_og") for e in entries if "_og" in e}
    for e in entries:
        if e["id"] in og_sizes and not e.get("draft"):
            e["page"] = True  # has a share page at p/<id>/
    (OUT / "photos.json").write_text(json.dumps(entries, separators=(",", ":")))
    now = datetime.now(timezone.utc)
    site_repo = os.environ.get("GITHUB_REPOSITORY", "")
    cfg = dict(config, built=now.strftime("%Y-%m-%d"), built_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"), rights=r,
               site_repo=site_repo if DATA_REPO_RE.fullmatch(site_repo) else "",  # for the editor's Publish now
               counter=goatcounter_url(config),
               collections=load_collections(known={e["id"] for e in entries}),
               highlights=load_highlights(known={e["id"] for e in entries}),
               **data_settings(config))
    (OUT / "config.json").write_text(json.dumps(cfg))

    site_url = os.environ.get("SITE_URL", "").rstrip("/")
    title = html.escape(config.get("title", "Photography"))
    desc = html.escape(config.get("tagline") or config.get("title", ""))
    # One template, four pages: home (/), work/, collections/, about/.
    template_page = (OUT / "index.html").read_text()
    ld = json_ld(shown, config, r, site_url)
    for page, folder, label in PAGES:
        root = "../" if folder else ""
        page_title = title if page == "home" else f"{label} — {title}"
        text = (template_page
                .replace("{{PAGE}}", page).replace("{{ROOT}}", root)
                .replace("{{TITLE}}", page_title)
                .replace("{{DESCRIPTION}}", desc)
                .replace("{{AUTHOR}}", html.escape(r["holder"]))
                .replace("{{COPYRIGHT}}", html.escape(r["notice"]))
                .replace("{{JSONLD}}", ld if page in ("home", "work") else "{}")
                .replace("{{OG_IMAGE}}", f"{site_url}/img/og.jpg" if og_written else ""))
        target = OUT / folder / "index.html" if folder else OUT / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    # Share pages for shown photos (hidden ones get none).
    template = (OUT / "photo.html").read_text()
    (OUT / "photo.html").unlink()
    for e in entries:
        if e.get("page"):
            d = OUT / "p" / e["id"]
            d.mkdir(parents=True, exist_ok=True)
            (d / "index.html").write_text(photo_page(template, e, config, r, site_url, og_sizes[e["id"]]))

    # Version-stamp local scripts/styles everywhere; the editor app compares
    # its version with version.json to pick up a new build without waiting.
    version = site_version()
    for page in [OUT / "index.html", OUT / "edit" / "index.html", *(OUT / f / "index.html" for _, f, _ in PAGES if f),
                 *OUT.glob("p/*/index.html")]:
        text = stamp_assets(page.read_text(), version)
        if page.parent.name == "edit":
            text = text.replace("</head>", f'  <meta name="app-version" content="{version}">\n</head>', 1)
        page.write_text(text)
    (OUT / "version.json").write_text(json.dumps({"v": version}))
    (OUT / ".nojekyll").write_text("")
    print(f"Built {len(entries)} photos ({len(og_sizes)} share pages) into {OUT}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", type=int, metavar="N", help="use N generated placeholder images")
    args = ap.parse_args()

    config = json.loads((ROOT / "config.json").read_text())
    album = os.environ.get("ICLOUD_ALBUM") or os.environ.get("ICLOUD_ALBUM_TOKEN") or ""
    token = parse_album(album) if album.strip() else ""

    key = render_key(config)
    if args.demo:
        photos = demo_photos(args.demo)
    elif token:
        photos = download_album(token, skip=lambda pid: cached_entry(pid, key) is not None)
        if not photos:
            # Fail loudly rather than publish an empty site over a good one.
            print("iCloud returned no photos; refusing to deploy an empty gallery.", file=sys.stderr)
            return 1
    elif os.environ.get("GITHUB_ACTIONS") == "true":
        # On GitHub a missing secret would publish an empty gallery over the
        # good one; fail instead so the last good site stays up.
        print("ICLOUD_ALBUM secret is missing or empty; refusing to deploy an empty gallery.", file=sys.stderr)
        return 1
    else:
        photos = local_photos()
        print(f"No ICLOUD_ALBUM set; using {len(photos)} photos from photos/")

    build(photos, config, use_cache=not args.demo)  # demo images are throwaway: don't cache them
    return 0


if __name__ == "__main__":
    sys.exit(main())
