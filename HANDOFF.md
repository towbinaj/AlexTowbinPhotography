# Handoff — Alex Towbin Photography

Status as of 2026-11-28 (docs reviewed; no behavior changes since 2026-11-27). Read `CLAUDE.md` first for rules and preferences.
The dated sections below are history, newest decisions noted where they
supersede older ones.

## Current state: live ✅ (2026-11-27)
- **Site:** https://photo.alextowbin.com/ (since 2026-11-26; the old
  `towbinaj.github.io/AlexTowbinPhotography/` redirects). Four pages: Home
  (intro, slideshow, ★ highlights), Work (justified rows), Collections
  (covers), About (bio, prints). Copyright block on every page.
- **Photos:** ~633 in the album (owner added hundreds on 2026-11-26).
  Processed images are on **Cloudflare R2** (`img.alextowbin.com`); the
  Pages site is ~3 MB. The rendered cache in Actions means only new photos
  are processed; a big batch takes ~25 min the first time.
- **Owner's workflow (site-first):** add photos to the album → in the editor
  put them in collections, ★ favourites, tick *On Work page* → **Publish
  now**. New photos show at once (not on Work until ticked).
- **Repo setup done by the owner:** secrets `ICLOUD_ALBUM` and the four
  `R2_*`; Pages source **GitHub Actions**; custom domain + HTTPS; domain
  verified on GitHub; Bing Webmaster Tools and Google Search Console verified
  (files `site/BingSiteAuth.xml`, `site/google200abc424b5554f0.html`; keep
  them) with the sitemap submitted to both.
- **Branches:** `main` is live; work happens on a `claude/*` branch per
  session (earlier `claude/elegant-hypatia-rpwb2z`, now
  `claude/app-documentation-review-j6gkdn`) and is merged only on the
  owner's explicit OK. Old `claude/*` branches (and the experimental, unmerged
  `claude/location-check`) can be deleted by the owner on GitHub's Branches
  page; the session isn't allowed to delete branches.

## How the photo sync works (`scripts/build.py`)
The owner's album is a **new-style iCloud shared album ("Shared Collection")**.
The link format is `photos.icloud.com/shared/album/<token>`, and the token
starts with a digit. It is read through the same public CloudKit endpoints
that photos.icloud.com's web app uses. No login is needed:

1. **Resolve the token:** `POST https://ckdatabasews.icloud.com/database/1/com.apple.photos.cloud/production/public/records/resolve`
   with body `{"shortGUIDs":[{"value":TOKEN}]}`. The response's
   `results[0].anonymousPublicAccess` gives a `token` (20-minute lifetime) and
   a `databasePartition`, e.g. `https://p179-ckdatabasews.icloud.com:443`.
   **The partition number changes between calls.**
2. **List photos:** `POST {partition}/database/1/com.apple.photos.cloud/production/shared/records/query`
   with params `sharing_url_key=TOKEN&publicAccessAuthToken=…` and query
   `CPLAssetAndMasterByAddedDate`. Page with `startRank` until no
   `CPLAsset` records come back. Each `CPLAsset` (has `masterRef`, dates,
   `captionEnc`) pairs with a `CPLMaster` (has resources).
3. **Pick the image:** use the edited render first (`CPLAsset.resJPEGFullRes`,
   present when edited in Photos), else the original (`resOriginalRes` for
   jpeg/heic/png/tiff), else `resJPEGMedRes`. In `downloadURL`, replace
   `${f}` with a filename. Downloads are plain public files from
   `cvws*.icloud-content.com`.
4. **Owner-only filter:** a photo is skipped unless the record's
   `created.userRecordName` equals `zoneID.ownerRecordName`. The album link is
   "Anyone with the link can join", and iOS has no view-only option there, so
   joiners can add photos. This filter keeps their uploads off the site.
   **Don't remove it.**
5. **Skipped:** videos, hidden items, and trashed items.

Classic albums (`icloud.com/sharedalbum/#B0…`, "sharedstreams" API) are still
supported as a fallback, which `download_album()` picks from the token shape.

**Processing:**
- EXIF orientation is applied, then all original metadata is dropped.
- Each image becomes WebP at long edges 480/960/1600/2400/3200 px plus a
  24 px blur preview, and gets EXIF Artist/Copyright and XMP rights (including
  the PLUS "data mining prohibited" flag) added.
- `og.jpg` is generated for link previews.

**Failure behavior:**
- An empty or failed fetch makes the build exit 1, so the last good site stays up.
- If `ICLOUD_ALBUM` is unset, a local build uses the `photos/` folder; on
  GitHub the build fails instead (added 2026-11-19), so a missing secret
  can't publish an empty site.

## Front end (`site/`)
- **Hero:** large serif name (Instrument Serif) beside a slideshow of framed
  prints (`object-fit: contain`). On phones the print sits above the name.
- **Home gallery (stream):** a masonry layout with per-column parallax drift
  and clip-path reveal on scroll.
- **Work gallery (rows):** justified rows (`rowsLayout()` in app.js): equal
  height per row, widths from aspect ratio, no cropping; target row height
  by width (`rowHeight()`). The old Stream/Index toggle was removed.
- **Lightbox:** View Transitions morph from the tile, keys and swipe to
  navigate, swipe down to close, deep links `#photo-<id>`.
- **Extras:** film grain and an Instagram
  marquee in the footer.
- **Copyright section:** `#rights`, small, at the bottom of every page (above the footer), with terms and a contact (prints email + Instagram).
- **Metadata:** `index.html` placeholders (`{{TITLE}}`, `{{AUTHOR}}`,
  `{{COPYRIGHT}}`, `{{JSONLD}}`, `{{OG_IMAGE}}`) are filled by `build.py`.
  The JSON-LD is an `ImageGallery` with an `ImageObject` per photo (creator,
  copyrightNotice, creditText, license → `#rights`).
- **Fonts:** self-hosted since 2026-11-28 (`site/fonts/`: Instrument Serif,
  Geist, Geist Mono; latin + latin-ext woff2 from Google Fonts, OFL in
  `OFL.txt`). CSP is `font-src 'self'`; no requests to Google.
- **404:** `site/404.html` (no scripts), filled by `not_found_page()`; links
  are root-relative (from `SITE_URL`'s path) because Pages serves it at any depth.
- **Alt text:** title, else "Photograph by <holder>, <place>, <month>"
  (`altText()` in app.js = `alt_text()` in build.py, used on share pages).
- **Header:** opaque (page background + hairline), `scroll-padding-top` keeps
  anchors clear of it.
- **Photos are never cropped or overlaid:** hero zoom runs 96%→100%; tile
  hover scales the whole frame (2.5%), not the image inside; film grain sits
  behind content (`z-index: -1`).
- **Icons:** "AT." monogram (`favicon.ico`, `favicon-32.png`,
  `apple-touch-icon.png`, `icon-192/512.png`, `site.webmanifest`).
- **Editor:** the phone app at `site/edit/` (see "Phone editing app"
  below). The site's old `#edit` mode was removed on 2026-11-18. Titles are
  title-cased (`title_case()` in build.py and `site/titlecase.js`, shared
  test cases). Unplaced (new) photos sort first.

## Decisions log
| Decision | Why |
|---|---|
| GitHub Pages project site, no custom domain | Owner didn't want a new domain. **Superseded 2026-11-26:** moved to `photo.alextowbin.com` (owner bought `alextowbin.com`) |
| Build via Actions artifact; photos never in git | Keeps repo small and public-safe |
| Keep white borders (`trim_white_borders: false`) | Owner: "part of the art". A trim helper exists but is off |
| Instagram link, not feed | Feed needs a 60-day Meta token, too much upkeep |
| Owner-only photo filter | Link sharing can't be view-only, so joiners could add photos |
| Sort `newest-added`, tie-break by date taken | All 32 were added at once |
| Copyright everywhere + save deterrents | Owner wants to protect the work; it deters, can't prevent |
| Film grain behind content | It sat over the photos (z-index 50); the art is never overlaid |
| Titles + order set on the site (`#edit` → `curation.json`; now the editor app → data repo) | Apple doesn't expose captions/comments via the public link (tested: change feed is a frozen snapshot); owner keeps using Snapseed |

## What the album does and doesn't expose (tested 2026-11-17/18)
- **Location:** 0/34 photos carry GPS (not in files, not in Apple's
  metadata). Most photos went through Snapseed, which saved JPEG copies
  without location; the owner has since turned on keeping photo data in
  Snapseed. Untested whether a fresh Snapseed edit keeps GPS through the
  album, or whether a location added via Photos → Adjust survives.
- **Captions/titles:** Photos-library captions don't travel into shared
  albums. Comments on album photos and the text typed when adding photos are
  **not reachable** through the public link: the CloudKit zone change feed
  returns a frozen snapshot (stuck at 33 photos / 2 posts). Hence titles
  live in the repo, set via the editor.
- **Embedded description:** only the 7 Olympus photos have
  `ImageDescription`, all the camera default "OLYMPUS DIGITAL CAMERA".

## Phone editing app (built and live; history of how it got here)

**Step 1 (branch `claude/elegant-hypatia-rpwb2z`, merged 2026-11-18):**
`curation.json` moved to the public data repo
`towbinaj/AlexTowbinPhotographyData` (also on its branch of the same name).
Site reads it live from raw.githubusercontent.com (≈5 min CDN cache), bakes
it in at build (`data/` checkout in `deploy.yml`, `CURATION_FILE` override),
validates it on both sides (`clean_title()` / `cleanTitle()`, kept identical,
parity-tested), adds a CSP, and the `#edit` key now targets the data repo
(new localStorage key name, so old keys are dropped). **Merge order:** merge
the data repo branch first, re-sync `curation.json` from the site's `main` if
it was edited meanwhile, then merge the site. Then the owner makes the new
key (data repo only) and deletes the old site-repo key. **Done and merged
2026-11-18;** owner made the new key, deleted the old one, and a test save
landed in the data repo.

**Step 3 (app) built on branch `claude/elegant-hypatia-rpwb2z`:** `site/edit/`
(installable, own manifest + inverted monogram icon, noindex, same CSP).
Data model in `site/edit/model.js` (node-tested from pytest):
`collections: [{name, photos: [ids in order]}]` (one collection per photo),
`highlights: [ids]`. Location is a published **yes/no flag only**
(`located` in photos.json, from EXIF GPS before stripping) — owner chose
this; never publish coordinates. Key expiry: GitHub's expiration header isn't
CORS-exposed, so the app asks for the date at setup and warns 14 days ahead.
Site `#edit` now preserves unknown fields when saving. **Merged 2026-11-18.**

**Tags + locations + site search (branch, 2026-11-18):** owner asked for a
tag library and standardized locations at city/state/country level only.
Owner chose the **built-in city list** (GeoNames cities1000 + inhabited
islands (1,000+ people, streamed from allCountries; added 2026-11-26 for
Santorini/Milos) + English names from alternateNamesV2 (display English
when the GeoNames name has accents, e.g. Heraklion; other forms kept as
`|`-separated search aliases) + admin1 + countries → `site/edit/places.json`, ~5.6 MB
(~2.5 MB gzipped), lazy-loaded by the app; made
by `scripts/make_places.py`; `download.geonames.org` was added to the cloud
environment for this) and **showing both on the site with search**. Data:
`tags` (library), `photo_tags` {id: [names from library]}, `locations`
{id: place}; place shapes and cleaning in `site/meta.js` = `clean_place()` /
`place_label()` / `clean_tag()` in build.py. Labels: "Florence, Italy",
US cities "Miami, Florida, United States", regions "Tuscany, Italy".
Search finds English names only (no "Firenze"); small towns → pick region.

**Then (owner, after asking how artist sites do it):** tags are **private**
(app only + JSON-LD keywords; not shown on the site), place is plain caption
text ("Title — Florence, Italy — Mar 2026"; phones get it on its own line),
the site search box was **removed** (bring back if the gallery grows into the
hundreds), and **collections are the public way to browse**: a nav row above
the gallery (hidden until a collection exists), `#collection-<slug>` deep
links, heading becomes the collection name, lightbox steps within it. Built
from live data, baked fallback in `config.json` `collections`
(`load_collections()`). `#edit` forces *All* (positions are global).
**Automatic place from GPS (2026-11-27):** owner chose "apply automatically".
`read_gps()` (memory only) → `nearest_place()`: GeoNames town/island with the
smallest distance ÷ reach (reach = max(1 km, 0.02·√pop)), ≤60 km; then the
owner's suburb rule: inside a larger 100k+ city's own area → the largest such
city (boroughs → NYC, Piraeus → Athens); else within a 100k+ city's metro
radius (0.045·√pop, ≤40 km, same country) → that city; positions
in build-only `scripts/place_coords.json` (from `make_places.py`, aligned with
places.json). Stored per photo as `auto_place` (+`auto_v`) in the rendered
cache and photos.json; existing cached photos with GPS re-download their
original once (`needs_original()`). Shown place = `placeFor()`/`place_for()`:
editor choice, else auto unless in `no_place` (set by Remove). Spot checks:
Newport/Covington/Blue Ash→Cincinnati, Mason and Dayton stay, Oia→Oía,
Plaka→Milos, Knossos→Heraklion, Fiesole→Florence, Central Park/Brooklyn/Jersey
City→New York City.

**Faster big batches (2026-11-27):** new originals download 8 at a time
(`fetch_original`), new photos are processed on all CPUs (`prerender()`,
ProcessPool; output identical to one-at-a-time, 3.7× faster on 4 cores) and
R2 uploads run 16 at a time. The ~630-photo batch took ~25 min processing +
~15 min upload before this.

**Image host: Cloudflare R2 (2026-11-27):** the Pages site hit 1.45 GB at 633
photos (limit ~1 GB). Images now go to R2 bucket `alextowbin-photos` at
`https://img.alextowbin.com` (`r2_settings()`/`sync_images()` in build.py,
boto3; only new/changed uploads, deletes removed photos but never >50% at
once, robots.txt on the image host blocks all AI bots). CSP `img-src` gets the
host added at build. Needs the owner's 4 `R2_*` repo secrets; without them
images stay on Pages.

**Site-first (2026-11-26):** owner now publishes on the site before Instagram.
`DRAFTS_UNTIL` in meta.js = build.py: photos added after it are shown at
once (they still need *On Work page* for the Work list); earlier drafts stay
hidden until released.

**On Work page (opt-in, 2026-11-26):** `on_work`/`off_work` in curation.json,
`onWork()` in meta.js = `on_work()` in build.py (parity test); photos added
after `WORK_FROM` start off Work. Work's All list = shown + on Work;
collections/highlights use all shown photos; a `#photo-` link to an
off-Work photo opens its collection. Build bakes `off_work: true` as the
fallback. Editor: checkmark + note on the photo screen, *Not on Work*
filter, *On/Off Work* bulk button, Order and Work page No. count only
photos on Work.

**Highlights:** the hero slideshow and Home grid show highlighted photos in
the highlights' own order (`highlights` array; editor ★ filter → Order,
`reorderHighlights()`; newly starred go last). Was main page order until 2026-11-26 (max 12; live data, baked fallback `config.json` `highlights`,
`load_highlights()`); none → old newest+random behavior.
**Face ID lock (branch):** `site/edit/lock.js`. A platform passkey
(WebAuthn, userVerification required, no server). With the PRF extension
(iOS 18+), HKDF(PRF secret) → AES-GCM encrypts the GitHub key; only the
ciphertext is stored (`at-lock` in localStorage), the plaintext lives in
memory while unlocked. Without PRF: "gate" mode (UI lock only; key stored as
before). Locks on open and after 5 min hidden. Safari needs the WebAuthn call
right after a tap, so setup runs Face ID before the GitHub key check (undone
if the key fails). Tested with Chromium's virtual authenticator (note: after
one failed UV it refuses until recreated; a test quirk). The site's `#edit`
had no Face ID, so it was **removed** (2026-11-18); the site also clears the
old key it left in that browser (same-origin `at-data-key`; note this also
clears an unlocked app key in the same browser, never the home-screen app's).
**Later on 2026-11-18 (all merged):** tag suggestions as tap-to-add chips
(iOS datalist was unreliable); select-several in the app (bulk tags with
all/some/none state, bulk collection, bulk location; `applyBulk`); hero
slideshow fix (outgoing slide wipes out in step, next image preloaded);
hover styles only for mouse (iOS sticky hover); **builds run hourly** at :17
(owner wanted new photos sooner), originals cache saved only when the photo
set changes (`actions/cache/restore` + `save`, key = hash of file names).
**Show on site (branch):** per-photo Show toggle and bulk Show/Hide in the
app. Owner chose *new photos start hidden* and *unlisted, instant release*
(not private). Data: `hidden`, `published`, `drafts_from` (set to the time
the feature was added); rule shared by site/app/build, parity-tested.
**Schedule fix (2026-11-18):** the cron trigger had never run (all builds
were pushes): GitHub ignores schedules last edited via the Claude connection.
Owner re-saved deploy.yml on github.com; scheduled runs work since 23:24 UTC.
Later found wrong (see the correction below and CLAUDE.md, "The build
schedule is best effort").

**Reliability + share pages (branch, 2026-11-19):** local .js/.css get
`?v=<hash of site/>`; `version.json`; the editor reloads onto a newer build
(once per version, never with unsaved changes). The build fails on GitHub if
`ICLOUD_ALBUM` is missing. Per shown photo: `img/<id>-og.jpg` (1200 px, rights
metadata) and `p/<id>/index.html` from `site/photo.html` (no JS; meta refresh
was avoided because link previewers may follow it); photos.json `page: true`;
lightbox **Share** button (Web Share / clipboard). The stale
`claude/location-check` branch is still there (deleting it from the session
was not permitted); the owner can delete it on GitHub's Branches page.
**Schedule reliability (2026-11-19):** after the owner's fix, GitHub ran the
cron only twice in ~11 hourly slots (23:24, 07:28 UTC); every build that ran
succeeded. Nothing wrong on our side (workflow active, default branch, :17):
GitHub documents schedules as best effort and drops runs under load. Fix:
**Publish now** in the editor (branch): POST
`/actions/workflows/deploy.yml/dispatches` with a second fine-grained key
(site repo, Actions RW only), then polls `/runs` and reloads photos.json.
config.json gains `site_repo` (from GITHUB_REPOSITORY) and `built_at`. The
Face ID lock seals `{"k": dataKey, "p": publishKey}` (plain string = old
format, still read). The hourly cron stays as a backup.
**Actions bumped (2026-11-19):** checkout v7, setup-python v7, cache
restore/save v6, configure-pages v6, upload-pages-artifact v5, deploy-pages v5
(all Node 24; inputs we use unchanged). After merging, the owner must re-save the
cron comment on github.com (see CLAUDE.md).
**Correction (2026-11-19):** the "Claude edits disable the schedule" theory
was wrong. Scheduled run #81 fired at 17:24 UTC after a Claude edit to
deploy.yml with no owner re-save. GitHub just skips many scheduled slots.
Publish now is the dependable path; CLAUDE.md updated.
**Processed-image cache (2026-11-19, branch):** builds had grown from ~2 to
~7 min because every run re-rendered every photo. Now `.cache/rendered/<id>/`
holds each photo's WebPs, og JPEG and `entry.json` (keyed by `render_key()`:
sizes, quality, og edge, trim, rights-metadata hashes, `RENDER_VERSION`);
cached photos skip the download entirely (`download_album(skip=…)`), stale
dirs are pruned. CI caches `.cache/rendered` instead of originals (~1.7 MB vs
~14 MB a photo; the 10 GB Actions cache now fits ~5,800 photos); a one-time
bridge restores the old originals cache when no rendered cache exists.
Storage plan (superseded 2026-11-27): Pages hit 1.45 GB at 633 photos and
the images moved to Cloudflare R2 (see "Image host" above). Owner asked about Google Drive/Dropbox: not suitable
(throttled links, expiring OAuth tokens).
**Visitor counts (2026-11-21, branch):** GoatCounter, owner's choice of
"visitor numbers". config `goatcounter` (site code) -> config.json `counter`
URL (validated). app.js sends image-pixel hits (no third-party JS): page view,
`photo/<id>` events (in fillBar), `collection/<slug>`, `share/<id>`; share
pages carry a static pixel. Skipped: DNT, localhost, `at-no-count` (set by the
editor app and by visiting with `#nocount`). CSP img-src allows
`https://*.goatcounter.com`. Inactive until the owner signs up and gives the code.
**Multi-page site + prints (2026-11-26, branch):** the owner found the one
long page awkward. index.html is now a template built into `/`, `work/`,
`collections/`, `about/` (`PAGES` in build.py; `{{PAGE}}`/`{{ROOT}}`;
`data-pages` + CSS show sections per page; app.js reads body
data-page/data-root and prefixes paths). Home = hero + highlights (first 9 if
none); old hash links forward to work/. Prints: `prints_email`
(prints@alextowbin.com via Cloudflare Email Routing, set up by the owner),
About block + lightbox Inquire mailto (title + share link). Share pages link
to `work/#photo-…`. Phone header hides the Instagram link.
*(Original plan, kept for history: all five steps below are done, `#edit`
was removed and the Face ID lock was added.)*
The owner wanted a small editor on their phone: set a title, assign a photo to
a **collection** (series), set its **position within the collection**, toggle
a **main-page highlight**, and **check its location**. Agreed design:

1. **Data repo, separate from the site.** Move `curation.json` into its own
   small repo (e.g. `towbinaj/alextowbin-photo-data`, public — titles are
   public anyway). The phone key gets Contents read/write on **that repo
   only**, so a stolen key can never change site code, workflows or reach
   the `ICLOUD_ALBUM` secret. *(Today's key is scoped to the site repo and
   could change build code that runs with the album secret; closing this is
   the first step.)* The owner has to create the repo and the new key; the
   session can't create repositories. After migrating, the owner deletes the
   old key.
2. **Publishing:** the site reads the data repo's JSON at runtime (edits
   live within minutes, no rebuild); the hourly build bakes it in for JSON-LD
   / search. Build and page treat the data as untrusted: validate (lengths,
   known photo ids, title case, collection names), render as text only
   (JSON-LD already escapes `</`). Add a Content-Security-Policy so only
   same-origin scripts run (allow Google Fonts CSS and the data fetch).
3. **The app:** an installable web app at `/edit/` (own manifest and icon, not
   linked from the site). On iOS, home-screen apps get storage separate from
   Safari. Screens: photo grid with title/collection/highlight badges; photo
   detail with title, collection, position in collection, highlight, date,
   location + map link (when available). Show the key's expiry (GitHub's
   `github-authentication-token-expiration` response header) and warn ~2
   weeks ahead. Optional Face ID lock (passkey).
4. **No server.** GitHub handles auth; the owner should keep 2FA on.
5. **Site changes that follow:** collections as sections, highlights on the
   main page / hero, per-collection order. Keep the current `#edit` until the
   app replaces it, then remove it.

**Polish (2026-11-28, branch `claude/app-documentation-review-j6gkdn`):**
tests on every PR (`test.yml`, no secrets), a 404 page, alt text for
untitled photos, self-hosted fonts. Docs refreshed.

## Open items / ideas
1. ~~Google Search Console~~ Done 2026-11-27: verified as a URL-prefix
   property (`https://photo.alextowbin.com/`) with the file
   `site/google200abc424b5554f0.html` (the domain TXT route never verified);
   sitemap submitted. Bing likewise (`site/BingSiteAuth.xml`).
2. **Indexing:** Bing has the sitemap. ChatGPT couldn't open the site while
   it was unindexed ("not accessible via this tool"); retry once indexed.
3. **Old branches:** owner may delete them on GitHub (see Current state).
4. **Email:** prints@alextowbin.com forwards via Cloudflare
   Email Routing; DMARC was suggested (Email → DMARC Management), not
   confirmed done.
5. **GSD workflow.** The owner suggested https://github.com/open-gsd/gsd-core
   (`npx @opengsd/gsd-core@latest`, then `/gsd-onboard`). Not installed. Ask
   before committing its files.
6. **Possible features, not requested:** an optional subtle watermark.

Done since the older list: About text, prints inquiries (email + Inquire
link), CI fails on a missing album secret, Actions bumped to current majors,
domain move.

## Cloud environment notes
- The session that built this used a personal environment, **"Photography
  site (iCloud access)"**, allowing `photos.icloud.com`, `www.icloud.com`,
  `ckdatabasews.icloud.com`, `p179-ckdatabasews.icloud.com`,
  `cvws.icloud-content.com`, and `cvws-h2.icloud-content.com`.
- **The partition host changes** (p179, p180, …), so local real-album builds
  fail when it lands on an unlisted host. The owner may add the wildcards
  `*.icloud.com` and `*.icloud-content.com` in the environment settings; the
  environment tools can't add wildcards. **This only affects test runs inside
  a cloud session.** GitHub Actions has open network, so the live site is
  unaffected.
- That environment also lists the DCMTools repo, which is unrelated and can
  be removed in settings. **This project has nothing to do with DCMTools.**
- `www.instagram.com` was added to the environment (to read the bio); it
  was rate-limited (429) and isn't needed. It can be removed in settings.
- This environment can't reach `*.github.io`; check deploys via the GitHub
  Actions API instead.
- `.cache/originals` doesn't survive a fresh clone. To iterate on the front
  end without network, use `--demo 30`.
