# Alex Towbin Photography

A photography portfolio that updates itself from an iCloud Shared Album and is
hosted free on GitHub Pages at **https://towbinaj.github.io/AlexTowbinPhotography/**.

**To add or remove a photo, add it to (or remove it from) the shared album in
Apple Photos.** A GitHub Action rebuilds the site every night. To update it
right away, go to *Actions → Build & deploy site → Run workflow*.

## How it works
1. A scheduled GitHub Action (`.github/workflows/deploy.yml`) runs `scripts/build.py`.
2. The script reads the iCloud Shared Album (the album must have **Public Website**
   turned on) and downloads the photos. Each image is resized to a thumbnail
   (800px) and a full view (2048px) and re-encoded. Re-encoding strips **all
   metadata, including GPS location**.
3. The static site in `site/` plus the processed images are deployed to Pages.
   Photos are never committed to the repo.

If iCloud is unreachable or returns an empty album, the build fails and the
site keeps showing the last good version. GitHub emails you about failed runs.

## One-time setup
1. **Shared album:** in Photos, create a Shared Album (e.g. "Portfolio"). In
   the album's settings, turn on **Public Website** and copy the link. It looks
   like `https://www.icloud.com/sharedalbum/#B0aBcDeFgHiJkL`.
2. **Secret:** in this repo go to *Settings → Secrets and variables → Actions →
   New repository secret*. Name it `ICLOUD_ALBUM_TOKEN` and set the value to
   the part after `#` (e.g. `B0aBcDeFgHiJkL`).
3. **Pages:** go to *Settings → Pages → Build and deployment → Source* and
   choose **GitHub Actions**.
4. Run the workflow once (*Actions → Build & deploy site → Run workflow*).

## Customizing
Edit `config.json`:

| key | meaning |
|---|---|
| `title` | site name in the header and browser tab |
| `tagline` | optional one-line intro under the header |
| `instagram` | Instagram handle, used for the header and footer links |
| `about` | optional About text (line breaks are kept); the About link only shows if this is set |
| `sort` | `newest-added` (default), `oldest-added`, `newest-taken`, or `oldest-taken` |
| `max_photos` | `0` for all, or a number to cap the gallery |

Captions you add to photos in the shared album appear in the lightbox.

Notes:
- Only still photos are used. Videos in the album are skipped.
- Without the secret, the build uses any images committed to a `photos/`
  folder instead (JPEG/PNG/HEIC).
- The album is read through iCloud's public shared-album web feed. Apple
  doesn't document it, but it has been stable for many years.

## Local preview
```
pip install -r requirements.txt
python scripts/build.py --demo 30     # placeholder images (or set ICLOUD_ALBUM_TOKEN)
python -m http.server -d _site 8000   # open http://localhost:8000
python -m pytest -q tests
```
