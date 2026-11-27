# Alex Towbin Photography

A photography portfolio that updates itself from an iCloud shared album and is
hosted free on GitHub Pages at **https://photo.alextowbin.com/** (the owner's
domain `alextowbin.com`, bought at Cloudflare; the main address is kept free
for other projects). Old `towbinaj.github.io/AlexTowbinPhotography/` links
redirect there.

**To add or remove a photo, add it to (or remove it from) the shared album in
Apple Photos.** A GitHub Action is scheduled to rebuild the site **every
hour** (at :17), but GitHub skips many scheduled runs (it treats schedules as
best effort), so it can take several hours. To update right away, tap
**Publish now** in the editor app (or on GitHub: *Actions → Build & deploy
site → Run workflow*).

## How it works
1. A scheduled GitHub Action (`.github/workflows/deploy.yml`) runs `scripts/build.py`.
2. The script reads the shared album through iCloud's public web endpoints, the
   same ones photos.icloud.com uses. It downloads full-resolution originals, or
   your edited version if you edited a photo in Photos. Videos are skipped.
3. Each photo is:
   - **resized** to several WebP sizes (480 → 3200 px) so each screen gets a
     sharp image without downloading more than it needs,
   - **re-encoded**, which strips **all metadata, including GPS location**.
4. The static site in `site/` is deployed to Pages; the processed images go
   to the **image host** (Cloudflare R2, `img.alextowbin.com`), or to Pages
   too if R2 isn't set up. Photos are never committed to the repo.

If iCloud is unreachable or returns an empty album, the build fails and the
site keeps showing the last good version (the same if the `ICLOUD_ALBUM`
secret is ever missing on GitHub). GitHub emails you about failed runs
(with hourly builds, an iCloud outage can mean one email per hour until it's
back). Each photo's processed web images are cached between runs (about 1.7 MB a
photo, in `.cache/rendered/`), so a build only downloads and processes **new**
photos and takes about the same time however large the album grows. The
cache refreshes itself when image settings or the copyright notice change
(e.g. a new year), and a new copy is saved only when something changed.

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
| `goatcounter` | your GoatCounter site code (e.g. `alextowbin`) to count visitors; empty = off |

### Photo titles and order
Titles, order, collections, highlights, tags and locations are all set in
the **editor app** (below). Titles appear under the photo and in the
full-screen view; photos without a title show the month they were taken.

**The key the app needs (once per device):**
1. On GitHub, create a key: *Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token*
   (or open https://github.com/settings/personal-access-tokens/new).
   - **Repository access:** *Only select repositories* → **AlexTowbinPhotographyData**
     (the photo data repository, not the site's). The key can't touch the
     site's code, its build, or the album link.
   - **Permissions:** *Contents* → **Read and write**. Nothing else.
   - **Expiration:** your choice; the app warns two weeks ahead.
2. Open the editor app and paste the key (see below).

Saves reach visitors within about 5 minutes (the page reads the data live; no
rebuild). Put your strongest photo first and your second-strongest last.

Photos you add to the album later appear **first** until you give them a
position, so new work is easy to spot.

Titles are always shown in **title case** ("shine a light" → "Shine a Light"):
major words capitalized; *a, an, the, and, of, in, on, to* and similar short
words lowercase unless they start or end the title (or a part of it around
"/", ":" or "—"). Words you capitalize yourself, like "NYC" or "iPhone", are
kept as typed.
The key stays on your phone (encrypted by Face ID where supported), and
visitors never see the editor. (The site's older `#edit` mode was removed;
the app replaces it.)

Everything (also collections and highlights from the phone app) is saved to `curation.json` in the separate, public data repository
[towbinaj/AlexTowbinPhotographyData](https://github.com/towbinaj/AlexTowbinPhotographyData)
(`data_repo` in `config.json`), keyed by photo. The page reads it live from
`raw.githubusercontent.com`; each build also bakes it in (for search
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
**https://photo.alextowbin.com/edit/** (not linked from the
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
  *New collection…*), its **No. in the collection**, **highlight on the
  Home page**, and its **Work page No.** (its place among the photos shown on the
  site, as visitors see them; hidden photos have none) Also shows when it was taken and added,
  and whether the photo kept its **location** (yes/no only; coordinates are
  never published). Swipe or use the arrows for the next photo. **Save**
  commits to the data repository.
- **Tags:** add tags to a photo from your **tag library** (type to pick an
  existing one; a new name asks before it's added, so the library stays
  tidy). The **Tags** button (top) manages the library: add, rename (applies
  to every photo), rename onto an existing tag to **merge**, delete.
- **Location:** *Choose* opens a search of the built-in places list. Pick a
  **city**, a **state/region**, or just a **country**: nothing more precise
  is ever stored or shown. Places you've used are listed first. The list is
  [GeoNames](https://www.geonames.org/) (CC BY 4.0): towns of 1,000+ people
  plus inhabited islands ("Santorini Island", "Milos Island"), shown in
  English where GeoNames has it ("Heraklion", not "Irákleion"; either
  spelling finds it); for a smaller place choose its state/region. *Photo GPS* separately says whether the image file itself
  kept its location (yes/no only).
- **Search** (top of the grid) by title, place, tag or collection; filters
  include *Shown* (on the site), *Hidden*, *Untitled* and *No location*.
- **On Work page:** a checkmark on each photo. Photos added to the album from
  now on start **unchecked**: they appear in their collection (and on Home if
  you ★ them) but not in the Work page's full list until you tick **On Work
  page** (or select several and tap **On Work**). Photos that were already
  on the site stay on Work. The *On Work* filter lists what visitors see on the Work page (in its order); *Not on Work* lists the rest. *Not ★* lists photos that aren't highlights yet, for picking new ones.
- **Show on site:** photos you add to the album **appear on the site right
  away** (site-first, since 2026-11-26); untick **Show on site** or tap
  **Hide** to pull one back. Photos added from 2026-11-18 until then started
  hidden and stay hidden until you release them (the grid marks them
  *Hidden · not on the site*; the *Hidden* filter lists them). Open one and
  tick **Show on site**, or select several and tap **Show**, to release
  them; untick / **Hide** pulls a photo back. Either
  way it takes effect on the site within about 5 minutes. Hidden photos are
  left off the gallery, slideshow, collections and search-engine data, but
  they are **not private**: their image files are still on the site (that's
  what lets the editor show them and makes releasing instant), so someone
  who knows where to look could find them.
- **Order** (top bar): drag photos into order instead of typing numbers.
  From the normal grid it orders the **Work page** (only photos shown on the
  site; hidden ones keep their places); with a
  collection's filter selected it orders **that collection** (its first photo
  is the cover); with the **★** filter it orders the **highlights** (the Home
  page and its slideshow). Drag a photo by **⠿**, or nudge it with
  **‹ ›**, then **Save** (one save for the whole order). For long lists:
  **Oldest first / Newest first** sorts by date taken as a starting point;
  **tap photos** to select several, then move them together **To start**,
  **To end** or to a **No.**; **Compact** shows smaller tiles, four or more
  per row (remembered on the phone).
- **Undo:** after every save (a photo, a bulk change, a tag edit, a new
  order) a small **Saved · Undo** pill shows at the bottom for 8 seconds
  (any tap elsewhere dismisses it). Undo puts back exactly what
  was there before, unless the data changed in the meantime (then it says so
  and changes nothing). Older changes stay in the data repository's history.
- **Several photos at once:** tap **Select**, tap the photos (or *Select
  all* for the current filter/search), then use the bar at the bottom:
  - **Tags:** each tag shows ✓ (all selected have it), – (some) or empty;
    tap to add it to all, tap again to remove it from all; *Apply* saves.
  - **Collection:** pick one, create a new one, or *No collection*. Photos
    already in it keep their place; the rest go at the end in Work page order.
  - **Location:** pick a place for all of them.
  - **★ Highlight:** star all of them for the Home page (new ones go last in
    the highlights order; already starred ones keep their place); if they're
    all starred already, the button reads **★ Remove** and un-stars them.
  - **On Work / Off Work:** put all of them on the Work page; if they're all
    on it already, the button reads **Off Work** and takes them off.
  - **Show / Hide:** release or pull back all of them.
  Each is one save.
- **Face ID lock:** when you first connect, *Lock the editor with Face ID*
  is ticked: the app then asks for Face ID every time it opens and after 5
  minutes in the background. On iPhones with iOS 18 or later, Face ID also
  **encrypts** the stored key, so it can't be read from the phone without
  your face (Key settings say "On"). On older systems it only guards opening
  the app ("On (app only)"). It uses a passkey saved in your iCloud Keychain;
  turn it on or off under **Key**. If Face ID can't unlock (e.g. the passkey
  was deleted), tap *Can't unlock?* and paste the key again.
- **Publish now** (above the grid): starts a site build right away, follows
  it ("Publishing… about 5 min") and then shows new album photos (under
  *Hidden*). Needs a **second key**, set once under **Key**: a fine-grained
  key for **this site's repository only** with **Actions: Read and write**
  and nothing else. It can start builds but can't change code, photo data or
  the album secret, so "No expiration" is fine. (A GitHub key has one set of
  permissions for every repository it covers, which is why this can't be
  added to the main key without giving it write access to the site's code.)
  With the Face ID lock, both keys are stored encrypted together.
- **Key** (top right): see the expiry date, replace or forget the key, turn
  the Face ID lock on or off, and add the publish key.

Locations and collections show on the site within minutes (see below). Tags
stay private to the app (for your own sorting and search); search engines get
them as hidden keywords. Highlights become the opening slideshow. New album photos show up in the app after the next hourly build.

## The site
Four pages, built from one template (`site/index.html`, `data-pages` on each
section says where it appears):
- **Home** (`/`): your name, tagline and the highlight slideshow, then your
  highlighted photos ("Selected work"; the first few if none are marked) and
  a link to all the work.
- **Work** (`/work/`): the full gallery in even rows (see below) and the
  collection links. Old `/#photo-…` and `/#collection-…` links forward here.
- **Collections** (`/collections/`): one cover per series (its first photo,
  shown whole), each opening that series on Work. The menu link appears once
  a collection exists.
- **About** (`/about/`): your bio (`about` in `config.json`) and **Prints &
  inquiries**.

Every page ends with a small **Copyright** block (notice, terms, contact).

**Prints:** `prints_email` in `config.json` (`prints@alextowbin.com`, which
Cloudflare Email Routing forwards to your inbox). The About page links to it,
and the full-screen viewer has an **Inquire** link that opens an email with
the photo's title and link filled in.
- **Opening screen:** your name in large serif type beside a slideshow of
  recent work, each framed print shown whole (above the name on phones).
- **Home gallery:** staggered columns that drift at slightly different speeds
  as you scroll, with photos revealed as they come into view.
- **Work gallery:** justified rows: every photo in a row is the same height,
  widths follow each photo's shape (portrait, 4:3, 16:9, square), and each
  row spans the page. Nothing is cropped; the last row isn't stretched.
- **Opening slideshow:** photos you mark *Highlight* in the app, in the
  highlights' own order (★ filter → Order in the app; up to 12). With none marked, it shows the newest few photos and
  a random mix of the rest. One highlight shows as a single still image.
- **Collections:** once you make a collection in the app, links appear above
  the gallery: *All* plus each collection with its count. Choosing one shows
  just that series, in its own order, with its name as the heading. Each has
  its own link (`…/#collection-florence-at-night`) to share. With no
  collections, nothing extra shows.
- **Captions:** the full-screen viewer shows *title — place — date*
  ("Negotiating Escape — Florence, Italy — Mar 2026"), place at
  city/state/country level as plain text. Search engines also get the place
  and your tags (`contentLocation`, `keywords` in the JSON-LD).
- **Share:** the full-screen viewer has a **Share** button (the share sheet on
  phones; *Link copied* on computers). Each shown photo has its own page,
  `…/p/<photo id>/`, so a shared link previews that photo with its title (in
  iMessage, Instagram, email…). The page shows the print whole with a link
  into the gallery; it has no scripts, so link previewers see it as is. Pages
  are made by the hourly build; a photo released since then shares the
  gallery link until the next build. Hidden photos get no page.
- **Full-screen viewer:** the photo grows smoothly from its spot in the
  gallery (View Transitions). Use arrow keys or swipe to move between photos,
  swipe down to close. Each photo has its own shareable link (`#photo-…`).
- **Loading and polish:** a blurred preview shows instantly while each image
  loads, plus subtle film grain.
- **Accessibility:** motion is turned off for visitors who ask for reduced
  motion.
- **Icons:** an "AT." monogram in the site's serif type, used for the browser
  tab (`favicon.ico`, `favicon-32.png`) and the iPhone home screen
  (`apple-touch-icon.png`, titled "Alex Towbin"). `site.webmanifest` gives
  Android the same icon. They're plain image files in `site/`; replace them to
  change the icon.

## Copyright protection
- **On the page:** "© <years> <name>. All rights reserved." appears in a small
  Copyright block at the bottom of every page (with usage terms and a
  licensing contact), and on every photo in the full-screen view.
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
  AI assistants and AI search (ChatGPT-User, OAI-SearchBot, Claude-User,
  Perplexity, etc.) may read the pages but are asked not to fetch `/img/`,
  where all the photographs live. Normal search engines can still index it.
- **Sitemap:** each build writes `sitemap.xml` (the four pages plus every
  shown photo's share page) and adds a `Sitemap:` line to `robots.txt`, so
  search engines (and AI search that relies on them) find the whole site.

No website can make images impossible to copy: screenshots and browser
developer tools still work. These measures stop casual saving and make your
ownership clear wherever the files end up, which is what matters if you ever
need to file a takedown.

## Domain
`photo.alextowbin.com` is a CNAME to `towbinaj.github.io` in Cloudflare DNS
(DNS only, not proxied), set as the custom domain in the repository's
**Settings → Pages** with **Enforce HTTPS** on. `alextowbin.com` is verified
on the owner's GitHub account (TXT record), so no one else can claim it or
its subdomains. The build gets the address from GitHub Pages (`SITE_URL`), so
nothing in the code names the domain.

## Image host (Cloudflare R2)
GitHub Pages sites are limited to about 1 GB, which ~450 photos fill (each
photo has six sizes). So the images are served from a Cloudflare R2 bucket
(`alextowbin-photos`, public at **https://img.alextowbin.com**; free up to
10 GB). Set up once:
1. Cloudflare → **R2** → create the bucket; bucket **Settings → Custom
   Domains** → connect `img.alextowbin.com`.
2. R2 → **Manage API tokens** → create a token with **Object Read & Write**
   on that bucket only, TTL forever.
3. GitHub → repo **Settings → Secrets and variables → Actions**: add
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

`image_url` in `config.json` is the public address. Each build uploads only
new or changed images (16 at a time), deletes the images of photos no longer in the album
(never more than half at once, as a safety check) and puts a `robots.txt` on
the image host that turns away all AI crawlers. Before switching, each build
checks that `image_url` actually serves the bucket; if not (domain not
connected yet, wrong key), it keeps the images on Pages that time. Without
the secrets the images stay on Pages as before.

## Visitor counts (optional)
With a free [GoatCounter](https://www.goatcounter.com/) account, the site
counts visits without cookies or tracking individuals (so no consent banner).
You see daily visitors, where they came from (Instagram, Google…), screen
sizes, and which photos were opened (`photo/<id>` with its title), which
collections were viewed (`collection/<name>`) and what was shared
(`share/<id>`). Visits to share pages (`/p/<id>/`) count as pages.

- **Set up:** sign up at goatcounter.com and choose a site code (your
  dashboard becomes `https://<code>.goatcounter.com`), then put the code in
  `config.json` as `"goatcounter": "<code>"`.
- **Not counted:** browsers that send "Do Not Track", local previews, and your
  own browsers: opening the editor app marks that browser, or visit the site
  once with `#nocount` at the end of the address (e.g. Safari on your phone).
  Share pages have no scripts, so a visit to one is counted regardless.
- No third-party script is loaded: each count is a tiny image request.

## Updates reach phones right away
Each build stamps a version on the site's scripts and styles and writes
`version.json`. The editor app checks it when it opens or comes back to the
foreground and reloads itself onto a new build (never while you have unsaved
changes), instead of running an old cached copy for up to 10 minutes.

## Places list
`site/edit/places.json` (the editor's built-in places list) is generated from
[GeoNames](https://www.geonames.org/) (CC BY 4.0) by `scripts/make_places.py`
and committed; it holds names and ids only, no coordinates. Refresh it rarely
with `python scripts/make_places.py` (needs access to download.geonames.org).

## Local preview
```
pip install -r requirements.txt pytest
ICLOUD_ALBUM='<album link>' python scripts/build.py   # or: --demo 30 for placeholders
python -m http.server -d _site 8000                   # open http://localhost:8000
python -m pytest -q tests
```
