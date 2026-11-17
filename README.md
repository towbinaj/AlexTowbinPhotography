# Alex Towbin Photography

A photography portfolio that updates itself from an iCloud shared album and is
hosted free on GitHub Pages at **https://towbinaj.github.io/AlexTowbinPhotography/**.

**To add or remove a photo, add it to (or remove it from) the shared album in
Apple Photos.** A GitHub Action rebuilds the site every night. To update it
right away, go to *Actions → Build & deploy site → Run workflow*.

## How it works
1. A scheduled GitHub Action (`.github/workflows/deploy.yml`) runs `scripts/build.py`.
2. The script reads the shared album through iCloud's public web endpoints, the
   same ones photos.icloud.com uses. It downloads full-resolution originals, or
   your edited version if you edited a photo in Photos. Videos are skipped.
3. Each photo is:
   - **resized** to several WebP sizes (480 → 3200 px) so each screen gets a
     sharp image without downloading more than it needs,
   - **re-encoded**, which strips **all metadata, including GPS location**.
4. The static site in `site/` plus the processed images are deployed to Pages.
   Photos are never committed to the repo.

If iCloud is unreachable or returns an empty album, the build fails and the
site keeps showing the last good version. GitHub emails you about failed runs.

## One-time setup
1. **Album link:** in Photos, open the shared album → Manage Shared Album →
   **Copy Album Link** (e.g. `https://photos.icloud.com/shared/album/03e…`).
   Leave Sharing Options on "Anyone with the link can join". Anyone who joins
   through the link could add photos to the album, but **the site only
   publishes photos you added yourself**. Keep the link private anyway.
2. **Secret:** in this repo go to *Settings → Secrets and variables → Actions →
   New repository secret*. Name it `ICLOUD_ALBUM` and paste the whole link as
   the value. The link stays private this way: it is never written into the
   public repo or the site.
3. **Pages:** go to *Settings → Pages → Build and deployment → Source* and
   choose **GitHub Actions**.
4. Run the workflow once (*Actions → Build & deploy site → Run workflow*).

## Customizing
Edit `config.json`:

| key | meaning |
|---|---|
| `name` | your name, shown large on the opening screen and in the header |
| `title` | browser tab / search / link-preview title |
| `tagline` | one line under your name |
| `instagram` | Instagram handle, used for the nav link and the footer banner |
| `about` | optional About text (line breaks kept); the About section only appears if set |
| `sort` | `newest-added` (default), `oldest-added`, `newest-taken`, or `oldest-taken` |
| `max_photos` | `0` for all, or a number to cap the gallery |
| `copyright_holder` | name in the copyright notice (defaults to `name`) |
| `copyright_start_year` | first year of the notice, e.g. `2026` → "© 2026–2027 …" in later years |
| `trim_white_borders` | `false` (default) keeps photos exactly as framed; `true` crops uniform white borders |

### Photo titles
A title appears under the photo and in the full-screen view. To give a photo
one, **add it to the shared album by itself and type the title in the text box
while adding it.** If several photos are added together, their shared text is
not used, so one caption never lands on a whole batch. Only text you type
counts, not text typed by people who joined the album. If a photo has no
title, the site shows the month it was taken.

Captions set in your Photos library don't carry over into shared albums, and
comments on a photo inside the album aren't visible through the public link,
so neither one can be used for titles.

## The site
- **Opening screen:** your name in large serif type beside a slideshow of
  recent work, each framed print shown whole (above the name on phones).
- **Stream view:** staggered columns that drift at slightly different speeds
  as you scroll, with photos revealed as they come into view.
- **Index view:** a dense grid of everything.
- **Full-screen viewer:** the photo grows smoothly from its spot in the
  gallery (View Transitions). Use arrow keys or swipe to move between photos,
  swipe down to close. Each photo has its own shareable link (`#photo-…`).
- **Loading and polish:** a blurred preview shows instantly while each image
  loads, plus subtle film grain and a custom cursor on desktop.
- **Accessibility:** motion is turned off for visitors who ask for reduced
  motion.

## Copyright protection
- **On the page:** "© <years> <name>. All rights reserved." appears in the footer,
  in a Copyright section with usage terms and a licensing contact, and on every
  photo in the full-screen view.
- **In the page metadata:** `author` / `copyright` / `dcterms.rights` meta tags,
  plus schema.org structured data marking you as `creator` and `copyrightHolder`
  of every image, with `copyrightNotice` and `creditText`. Google Images shows
  these credits.
- **In every image file:** each photo carries its own copyright data, so the
  notice travels with the file even if someone saves it. The EXIF Artist and
  Copyright fields are set, and the XMP data includes `dc:creator`, `dc:rights`,
  `xmpRights:Marked`, usage terms, and the PLUS "AI data mining prohibited"
  flag. Camera, date, and GPS data are still removed.
- **Saving is discouraged:** right-click, dragging, and the iOS long-press
  "Save Image" menu are disabled on photos.
- **AI crawlers:** `robots.txt` and `noai` meta tags ask AI-training crawlers
  (GPTBot, CCBot, Google-Extended, ClaudeBot, etc.) not to collect the site.
  Normal search engines can still index it.

No website can make images impossible to copy: screenshots and browser
developer tools still work. These measures stop casual saving and make your
ownership clear wherever the files end up, which is what matters if you ever
need to file a takedown.

## Local preview
```
pip install -r requirements.txt pytest
ICLOUD_ALBUM='<album link>' python scripts/build.py   # or: --demo 30 for placeholders
python -m http.server -d _site 8000                   # open http://localhost:8000
python -m pytest -q tests
```
