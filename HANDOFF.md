# Handoff — Alex Towbin Photography

Status as of 2026-11-17. Read `CLAUDE.md` first for rules and preferences.

## Current state: live ✅
- **Site:** https://towbinaj.github.io/AlexTowbinPhotography/
- **First deploy:** Actions run #1 succeeded. 32 photos, ~55 MB site, ~2 min
  build. Originals (~460 MB) are cached in Actions (`.cache/originals`), so
  later runs only download new photos.
- **Repo setup done by the owner:**
  - secret `ICLOUD_ALBUM` set
  - Pages source set to **GitHub Actions**
- **Branches:**
  - `main` is live.
  - `claude/adoring-newton-60frvi` was the development branch; it was
    fast-forwarded into `main` and has nothing unmerged.

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
6. **Possible features, not requested:**
   - albums or sections, e.g. a second shared album per series
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
- `.cache/originals` doesn't survive a fresh clone. To iterate on the front
  end without network, use `--demo 30`.
