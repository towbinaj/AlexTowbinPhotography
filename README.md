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
| `data_repo` | `owner/repo` holding `curation.json` (titles + order); the editor saves there |

### Photo titles and order
Titles and the order of the photos are set on the site itself. Titles appear
under the photo and in the full-screen view; photos without a title show the
month they were taken.

**One-time setup on each device you edit from:**
1. On GitHub, create a key: *Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token*
   (or open https://github.com/settings/personal-access-tokens/new).
   - **Repository access:** *Only select repositories* → **AlexTowbinPhotographyData**
     (the photo data repository, not the site's). The key can't touch the
     site's code, its build, or the album link.
   - **Permissions:** *Contents* → **Read and write**. Nothing else.
   - **Expiration:** your choice. When it expires, saving says so; make a new key.
2. Open the site with `#edit` at the end of the address
   (e.g. `…/AlexTowbinPhotography/#edit`) and paste the key.

**Editing:** open any photo. Type its title in the field under it, and/or
change its **No.** (its position, 1 = first) and tap **Save**. Visitors see
it within about 5 minutes (the page reads the data live; no rebuild). Clear the title and save to remove it. Put your strongest
photo first and your second-strongest last. Tap **Done** to hide the editor;
visiting with `#edit` turns it back on.

Photos you add to the album later appear **first** until you give them a
position, so new work is easy to spot.

Titles are always shown in **title case** ("shine a light" → "Shine a Light"):
major words capitalized; *a, an, the, and, of, in, on, to* and similar short
words lowercase unless they start or end the title (or a part of it around
"/", ":" or "—"). Words you capitalize yourself, like "NYC" or "iPhone", are
kept as typed.
The key is stored only in that browser (*Forget key* removes it), and visitors
never see the editor.

Everything (also collections and highlights from the phone app) is saved to `curation.json` in the separate, public data repository
[towbinaj/AlexTowbinPhotographyData](https://github.com/towbinaj/AlexTowbinPhotographyData)
(`data_repo` in `config.json`), keyed by photo. The page reads it live from
`raw.githubusercontent.com`; the nightly build also bakes it in (for search
and the JSON-LD). Both treat it as untrusted: titles are cleaned (no control
characters, at most 200 characters, title case), only known photo ids count,
and everything is shown as plain text. A Content-Security-Policy lets only
the site's own scripts run. For a local build with real titles, clone the
data repo into `data/` (git-ignored) or set `CURATION_FILE`.
Editing a photo again in Snapseed creates a new version of it, which starts
untitled and unplaced.

Captions set in the Photos app can't be used: Apple doesn't pass them, or
comments on shared-album photos, through the album's public link.

### Phone editor app (`/edit/`)
A small app for editing on your phone, at
**https://towbinaj.github.io/AlexTowbinPhotography/edit/** (not linked from the
site, and hidden from search engines). In Safari, tap *Share → Add to Home
Screen* to install it; it gets its own icon (the monogram on a light
background) and opens full screen.

- **First time:** paste the same kind of key as above (data repository only,
  Contents read and write) and enter the expiry date you picked, or tick
  *No expiration*. GitHub doesn't tell the app the date, so it asks; it then
  warns you two weeks before the key expires. A home-screen app keeps its own
  storage, separate from Safari, so it asks once even if Safari has the key.
- **Grid:** every photo on the site, with its title (or the date in grey),
  collection and number, and ★ for highlights. Filter by *Untitled*, *★*,
  *No collection* or any collection.
- **Photo:** tap one to set its **title**, **collection** (pick one or
  *New collection…*), its **No. in the collection**, **highlight on main
  page**, and its **main page No.** Also shows when it was taken and added,
  and whether the photo kept its **location** (yes/no only; coordinates are
  never published). Swipe or use the arrows for the next photo. **Save**
  commits to the data repository.
- **Key** (top right): see the expiry date, replace or forget the key.

Collections and highlights are saved now but don't change the public site yet;
that comes next. New album photos show up in the app after the nightly build.

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
- **Icons:** an "AT." monogram in the site's serif type, used for the browser
  tab (`favicon.ico`, `favicon-32.png`) and the iPhone home screen
  (`apple-touch-icon.png`, titled "Alex Towbin"). `site.webmanifest` gives
  Android the same icon. They're plain image files in `site/`; replace them to
  change the icon.

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
