# Handoff — Alex Towbin Photography

Status as of 2026-11-18. Read `CLAUDE.md` first for rules and preferences.

## Current state: live ✅
- **Site:** https://towbinaj.github.io/AlexTowbinPhotography/
- **First deploy:** Actions run #1 succeeded. 32 photos, ~55 MB site, ~2 min
  build. Originals (~460 MB) are cached in Actions (`.cache/originals`), so
  later runs only download new photos.
- **Repo setup done by the owner:**
  - secret `ICLOUD_ALBUM` set
  - Pages source set to **GitHub Actions**
- **Now:** 34 photos, 30 with owner titles (in `curation.json`).
- **Branches:**
  - `main` is live. All `claude/*` feature branches from 2026-11-17/18
    (hero-border-fix, tile-hover-border, opaque-header, title-editor,
    curation, title-case) are merged.
  - `claude/location-check` is **experimental and unmerged**: an opt-in
    `LOCATION_REPORT` diagnostic (field names/counts only, safe for public
    logs), album-comment/post-caption lookups that turned out not to work,
    and a **temporary** `push` trigger for that branch in `deploy.yml`.
    Don't merge it as is; salvage the diagnostic if useful, or delete it.

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
- If `ICLOUD_ALBUM` is unset, the build uses the `photos/` folder, which
  doesn't exist. In CI that would produce an empty site. Consider failing
  instead if the secret is missing (see open items).

## Front end (`site/`)
- **Hero:** large serif name (Instrument Serif) beside a slideshow of framed
  prints (`object-fit: contain`). On phones the print sits above the name.
- **Stream view:** a masonry layout with per-column parallax drift and
  clip-path reveal on scroll.
- **Index view:** a dense grid.
- **Lightbox:** View Transitions morph from the tile, keys and swipe to
  navigate, swipe down to close, deep links `#photo-<id>`.
- **Extras:** film grain, a custom cursor on fine pointers, an Instagram
  marquee in the footer.
- **Copyright section:** `#rights`, with terms and a contact via Instagram.
- **Metadata:** `index.html` placeholders (`{{TITLE}}`, `{{AUTHOR}}`,
  `{{COPYRIGHT}}`, `{{JSONLD}}`, `{{OG_IMAGE}}`) are filled by `build.py`.
  The JSON-LD is an `ImageGallery` with an `ImageObject` per photo (creator,
  copyrightNotice, creditText, license → `#rights`).
- **Fonts:** Google Fonts (Instrument Serif, Geist, Geist Mono).
- **Header:** opaque (page background + hairline), `scroll-padding-top` keeps
  anchors clear of it.
- **Photos are never cropped or overlaid:** hero zoom runs 96%→100%; tile
  hover scales the whole frame (2.5%), not the image inside; film grain sits
  behind content (`z-index: -1`).
- **Icons:** "AT." monogram (`favicon.ico`, `favicon-32.png`,
  `apple-touch-icon.png`, `icon-192/512.png`, `site.webmanifest`).
- **Editor (`#edit`):** owner-only. Asks for a fine-grained GitHub key
  (stored in that browser's localStorage), then the lightbox shows Title and
  No. (position) fields. Save writes `curation.json` (`{titles, order}`) via
  the GitHub contents API → push → deploy (~2 min). Titles are title-cased
  (`title_case()` in build.py and `site/titlecase.js`, shared test cases).
  Unplaced (new) photos sort first.

## Decisions log
| Decision | Why |
|---|---|
| GitHub Pages project site, no custom domain | Owner didn't want a new domain |
| Build via Actions artifact; photos never in git | Keeps repo small and public-safe |
| Keep white borders (`trim_white_borders: false`) | Owner: "part of the art". A trim helper exists but is off |
| Instagram link, not feed | Feed needs a 60-day Meta token, too much upkeep |
| Owner-only photo filter | Link sharing can't be view-only, so joiners could add photos |
| Sort `newest-added`, tie-break by date taken | All 32 were added at once |
| Copyright everywhere + save deterrents | Owner wants to protect the work; it deters, can't prevent |
| Film grain behind content | It sat over the photos (z-index 50); the art is never overlaid |
| Titles + order set on the site (`#edit` → `curation.json`) | Apple doesn't expose captions/comments via the public link (tested: change feed is a frozen snapshot); owner keeps using Snapseed |

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

## Next project: phone editing app (approved by the owner, in progress)

**Step 1 done on branch `claude/elegant-hypatia-rpwb2z` (not merged yet):**
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
Owner chose the **built-in city list** (GeoNames cities15000 + admin1 +
countries → `site/edit/places.json`, ~1.1 MB, lazy-loaded by the app; made
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
**Highlights (branch):** the hero slideshow shows highlighted photos in main
page order (max 12; live data, baked fallback `config.json` `highlights`,
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
See CLAUDE.md, "The build schedule belongs to the owner".

**Reliability + share pages (branch, 2026-11-19):** local .js/.css get
`?v=<hash of site/>`; `version.json`; the editor reloads onto a newer build
(once per version, never with unsaved changes). The build fails on GitHub if
`ICLOUD_ALBUM` is missing. Per shown photo: `img/<id>-og.jpg` (1200 px, rights
metadata) and `p/<id>/index.html` from `site/photo.html` (no JS; meta refresh
was avoided because link previewers may follow it); photos.json `page: true`;
lightbox **Share** button (Web Share / clipboard). The stale
`claude/location-check` branch is still there (deleting it from the session
was not permitted); the owner can delete it on GitHub's Branches page.
Still to do:
remove `#edit` once the app has fully replaced it. Not done: Face ID lock
(optional); step 5 site changes (collections as sections, highlights on the
main page/hero, build-side validation of the new fields); then remove `#edit`.
The owner wants a small editor on their phone: set a title, assign a photo to
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

## Open items / ideas
1. **Tagline** is now the owner's Instagram bio. `about` is still empty, so
   the About section is hidden.
2. **Repo rename to `towbinaj.github.io`.** This gives the shorter URL
   `https://towbinaj.github.io/`. It also makes `robots.txt` effective:
   crawlers only read it at the domain root, so the AI-crawler blocks are
   currently ignored, though the `noai` meta tags still apply. After a rename,
   update URLs in `README.md` / `CLAUDE.md`; `SITE_URL` comes from
   `configure-pages` automatically. Needs the owner's OK.
3. **Fail the CI build if `ICLOUD_ALBUM` is missing**, rather than deploying
   an empty gallery.
4. **Actions warning:** Node 20 is deprecated. Bump `actions/checkout`,
   `setup-python`, `cache`, `configure-pages`, `upload-pages-artifact`, and
   `deploy-pages` to current majors.
5. **GSD workflow.** The owner suggested https://github.com/open-gsd/gsd-core,
   installed with `npx @opengsd/gsd-core@latest` and then `/gsd-onboard` for
   an existing repo. It adds `/gsd-*` commands and keeps state in files like
   `STATE.md`. Not installed yet. Ask before committing its files.
6. **From the portfolio review (owner input needed):** About text + whether
   to show an email (About section is hidden while `about` is empty);
   collections (covered by the app project).
7. **Possible features, not requested:**
   - a print-inquiry form
   - an optional subtle watermark

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
