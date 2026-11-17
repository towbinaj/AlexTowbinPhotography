#!/usr/bin/env python3
"""Build the photography site into _site/.

Photos come from an iCloud Shared Album that has "Public Website" turned on.
The album token (the part after '#' in the share link) is read from the
ICLOUD_ALBUM_TOKEN environment variable. Without a token, images in photos/
(if any) are used instead, so the site can also be fed by committing files.

Every image is re-encoded, which strips all EXIF metadata (including GPS);
orientation is applied to the pixels first so nothing ends up sideways.

Usage:
    python scripts/build.py              # build from iCloud or photos/
    python scripts/build.py --demo 24    # build with generated placeholder images
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import requests
from PIL import Image, ImageOps

try:  # lets photos/ contain iPhone .HEIC files
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass

ROOT = Path(__file__).resolve().parent.parent
SITE_SRC = ROOT / "site"
OUT = ROOT / "_site"
CACHE = ROOT / ".cache" / "originals"
LOCAL_PHOTOS = ROOT / "photos"

SIZES = {"thumb": 800, "full": 2048}  # long-edge pixels
JPEG_QUALITY = 84
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".tif", ".tiff"}

BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


@dataclass
class Photo:
    id: str
    source: Path
    caption: str = ""
    taken: str = ""   # ISO date the photo was taken, if known
    added: str = ""   # ISO date it was added to the album
    extra: dict = field(default_factory=dict)


# --------------------------------------------------------------------------
# iCloud Shared Album (undocumented but long-stable "sharedstreams" API)
# --------------------------------------------------------------------------

def icloud_base_url(token: str) -> str:
    """Initial server for a token; iCloud may redirect us to another one."""
    if token[0] == "A":
        partition = BASE62.index(token[1])
    else:
        partition = BASE62.index(token[1]) * 62 + BASE62.index(token[2])
    return f"https://p{partition:02d}-sharedstreams.icloud.com/{token}/sharedstreams/"


def _post(session: requests.Session, url: str, payload: dict) -> requests.Response:
    for attempt in range(4):
        try:
            r = session.post(url, json=payload, timeout=60)
            if r.status_code < 500:
                return r
        except requests.RequestException:
            if attempt == 3:
                raise
        time.sleep(2 ** attempt)
    r.raise_for_status()
    return r


def fetch_icloud_album(token: str, session: requests.Session | None = None) -> tuple[str, list[dict]]:
    """Return (album_name, [{guid, caption, taken, added, url, checksum}])."""
    session = session or requests.Session()
    session.headers.update({"Content-Type": "text/plain", "User-Agent": "photo-site-builder"})
    base = icloud_base_url(token)

    r = _post(session, base + "webstream", {"streamCtag": None})
    if r.status_code == 330:  # "wrong partition, use this host instead"
        host = r.json()["X-Apple-MMe-Host"]
        base = f"https://{host}/{token}/sharedstreams/"
        r = _post(session, base + "webstream", {"streamCtag": None})
    r.raise_for_status()
    stream = r.json()

    wanted: list[dict] = []
    for p in stream.get("photos", []):
        if p.get("mediaAssetType") == "video":
            continue  # stills only
        best = None
        for key, d in (p.get("derivatives") or {}).items():
            if not key.isdigit() or not d.get("checksum"):
                continue
            size = int(d.get("width") or 0) * int(d.get("height") or 0) or int(key)
            if best is None or size > best[0]:
                best = (size, d)
        if best is None:
            continue
        wanted.append({
            "guid": p["photoGuid"],
            "caption": (p.get("caption") or "").strip(),
            "taken": p.get("dateCreated") or "",
            "added": p.get("batchDateCreated") or p.get("dateCreated") or "",
            "checksum": best[1]["checksum"],
        })

    # Resolve download URLs (they expire, so we always download, never hotlink).
    urls: dict[str, str] = {}
    guids = [w["guid"] for w in wanted]
    for i in range(0, len(guids), 25):
        r = _post(session, base + "webasseturls", {"photoGuids": guids[i:i + 25]})
        r.raise_for_status()
        for checksum, item in (r.json().get("items") or {}).items():
            urls[checksum] = f"https://{item['url_location']}{item['url_path']}"
    for w in wanted:
        w["url"] = urls.get(w["checksum"])
    return stream.get("streamName", ""), [w for w in wanted if w["url"]]


def download_icloud(token: str) -> list[Photo]:
    album, items = fetch_icloud_album(token)
    print(f"iCloud album {album!r}: {len(items)} photos")
    CACHE.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    photos = []
    for it in items:
        safe = hashlib.sha1(it["checksum"].encode()).hexdigest()[:16]
        dest = CACHE / f"{safe}.img"
        if not dest.exists():
            r = session.get(it["url"], timeout=120)
            r.raise_for_status()
            tmp = dest.with_suffix(".part")
            tmp.write_bytes(r.content)
            tmp.replace(dest)
        photos.append(Photo(id=safe, source=dest, caption=it["caption"],
                            taken=it["taken"], added=it["added"]))
    # Drop cached originals for photos no longer in the album.
    keep = {p.source.name for p in photos}
    for f in CACHE.glob("*.img"):
        if f.name not in keep:
            f.unlink()
    return photos


# --------------------------------------------------------------------------
# Other sources
# --------------------------------------------------------------------------

def local_photos() -> list[Photo]:
    if not LOCAL_PHOTOS.is_dir():
        return []
    photos = []
    for f in sorted(LOCAL_PHOTOS.iterdir()):
        if f.suffix.lower() in IMAGE_EXTS:
            mtime = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(f.stat().st_mtime))
            pid = hashlib.sha1(f.name.encode()).hexdigest()[:16]
            photos.append(Photo(id=pid, source=f, caption="", taken=mtime, added=mtime))
    return photos


def demo_photos(n: int) -> list[Photo]:
    """Generated gradient placeholders, for previewing the layout."""
    import random
    rnd = random.Random(7)
    d = ROOT / ".cache" / "demo"
    d.mkdir(parents=True, exist_ok=True)
    photos = []
    for i in range(n):
        w, h = rnd.choice([(3000, 2000), (2000, 3000), (3000, 3000), (3600, 1800), (2400, 3000)])
        f = d / f"demo{i:02d}.jpg"
        if not f.exists():
            c1 = tuple(rnd.randint(20, 235) for _ in range(3))
            c2 = tuple(rnd.randint(20, 235) for _ in range(3))
            grad = Image.linear_gradient("L").resize((w, h))
            Image.composite(Image.new("RGB", (w, h), c1), Image.new("RGB", (w, h), c2), grad).save(f, quality=80)
        photos.append(Photo(id=f"demo{i:02d}", source=f, caption=f"Placeholder {i + 1}",
                            taken=f"2026-01-{i % 28 + 1:02d}", added=f"2026-02-{i % 28 + 1:02d}"))
    return photos


# --------------------------------------------------------------------------
# Image processing + site output
# --------------------------------------------------------------------------

def render_images(photo: Photo, out_dir: Path) -> dict | None:
    try:
        with Image.open(photo.source) as im:
            im = ImageOps.exif_transpose(im)  # bake rotation in, then drop EXIF
            im = im.convert("RGB")
            w, h = im.size
            entry = {"id": photo.id, "w": w, "h": h, "caption": photo.caption,
                     "taken": photo.taken, "added": photo.added}
            for name, edge in SIZES.items():
                scale = min(1.0, edge / max(w, h))
                size = (max(1, round(w * scale)), max(1, round(h * scale)))
                img = im if scale == 1.0 else im.resize(size, Image.LANCZOS)
                rel = f"img/{photo.id}-{name}.jpg"
                img.save(out_dir / rel, "JPEG", quality=JPEG_QUALITY, optimize=True,
                         progressive=True)  # no exif= → metadata stripped
                entry[name] = rel
                entry[f"{name}_w"], entry[f"{name}_h"] = size
            return entry
    except Exception as e:  # one bad file shouldn't sink the whole site
        print(f"  skipping {photo.source.name}: {e}", file=sys.stderr)
        return None


def sort_photos(photos: list[Photo], mode: str) -> list[Photo]:
    keys = {
        "newest-added": (lambda p: p.added, True),
        "oldest-added": (lambda p: p.added, False),
        "newest-taken": (lambda p: p.taken, True),
        "oldest-taken": (lambda p: p.taken, False),
    }
    key, reverse = keys.get(mode, keys["newest-added"])
    return sorted(photos, key=key, reverse=reverse)


def build(photos: list[Photo], config: dict) -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(SITE_SRC, OUT)
    (OUT / "img").mkdir()

    photos = sort_photos(photos, config.get("sort", "newest-added"))
    if config.get("max_photos"):
        photos = photos[: int(config["max_photos"])]

    entries = [e for p in photos if (e := render_images(p, OUT))]
    (OUT / "photos.json").write_text(json.dumps(entries, separators=(",", ":")))
    (OUT / "config.json").write_text(json.dumps(config))

    # Put title/description into the HTML too, for search engines and link previews.
    index = OUT / "index.html"
    title = html.escape(config.get("title", "Photography"))
    desc = html.escape(config.get("tagline") or config.get("title", ""))
    site_url = os.environ.get("SITE_URL", "").rstrip("/")
    og_image = f"{site_url}/{entries[0]['thumb']}" if entries else ""
    text = (index.read_text()
            .replace("{{TITLE}}", title)
            .replace("{{DESCRIPTION}}", desc)
            .replace("{{OG_IMAGE}}", og_image))
    index.write_text(text)
    (OUT / ".nojekyll").write_text("")
    print(f"Built {len(entries)} photos into {OUT}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", type=int, metavar="N", help="use N generated placeholder images")
    args = ap.parse_args()

    config = json.loads((ROOT / "config.json").read_text())
    token = os.environ.get("ICLOUD_ALBUM_TOKEN", "").strip().lstrip("#").split(";")[0]

    if args.demo:
        photos = demo_photos(args.demo)
    elif token:
        photos = download_icloud(token)
        if not photos:
            # Fail loudly rather than publish an empty site over a good one.
            print("iCloud returned no photos; refusing to deploy an empty gallery.", file=sys.stderr)
            return 1
    else:
        photos = local_photos()
        print(f"No ICLOUD_ALBUM_TOKEN set; using {len(photos)} photos from photos/")

    build(photos, config)
    return 0


if __name__ == "__main__":
    sys.exit(main())
