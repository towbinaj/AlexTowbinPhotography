# CLAUDE.md — Alex Towbin Photography

Conventions for working in this repo. **This repo is public.** Read
`HANDOFF.md` for current status, history, and open items.

## What this is
A self-updating photography portfolio on GitHub Pages:
https://towbinaj.github.io/AlexTowbinPhotography/

A GitHub Action (`.github/workflows/deploy.yml`) runs nightly, on every push to
`main`, and on demand. It runs `scripts/build.py`, which pulls photos from the
owner's iCloud shared album, processes them, and builds a static site into
`_site/`, which is deployed to Pages. Photos are **never committed**.

## Privacy & secrets — non-negotiable
- **Never commit the album link/token.** It lives only in the repo secret
  `ICLOUD_ALBUM` (the full `https://photos.icloud.com/shared/album/<token>` URL).
  Don't put it in code, tests, docs, commit messages, or fixtures.
- **Never commit the owner's email or iCloud IDs.** The CloudKit resolve
  response contains the owner's name, email, `ownerRecordName` (`_…`), zone
  names, and short-lived access tokens. Use synthetic values in tests
  (`_owner`, `SharedCollection-TEST`, `example.org`).
- Secret-scan every diff before committing, e.g.
  `git diff --cached | grep -nE "icloud.com/shared/album/0|@hotmail|@gmail|SharedCollection-[0-9A-F]"`.
- `.cache/` (downloaded originals) and `_site/` are git-ignored; keep it that way.

## Owner preferences (decided — don't relitigate)
- **White photo borders stay.** They're part of the art.
  `trim_white_borders` is `false`; never crop, re-frame, or `object-fit: cover`
  a photo in a way that cuts the border. Show framed prints whole.
- **Copyright matters.** Keep the visible notice ("© <years> Alex Towbin. All
  rights reserved."), the rights metadata (meta tags, JSON-LD, EXIF/XMP in
  every image), and the save deterrents (no right-click, drag, or iOS
  long-press). Don't add download buttons.
- **Low maintenance.** The owner's only workflow is adding and removing photos
  in the shared album. Don't add steps that need manual upkeep (e.g. expiring
  API tokens).
- **Photo titles are typed on the site** (owner chose this; `#edit` mode, a
  fine-grained GitHub key with Contents read/write on this repo only, stored in
  the owner's browser). Saves write `titles.json` via the GitHub API, which
  triggers a deploy. Titles are optional: untitled photos show the date. Apple
  captions/comments are not reachable through the public album link (tested).
  Never put a key in the repo or the build.
- **Instagram (@towbinaj)** is linked, not embedded. A live feed needs a
  Meta token that expires every 60 days, which was rejected.
- Design: dark, editorial, modern. Not a template look.

## Layout
```
config.json                 site settings (name, tagline, about, sort, copyright…)
titles.json                 photo id → title, written by the site's title editor
scripts/build.py            iCloud fetch → image processing → _site/
site/index.html|style.css|app.js|robots.txt   static front end (no framework, no build step)
tests/test_icloud.py        offline tests (fake iCloud responses; no network)
.github/workflows/deploy.yml  test → build → deploy to Pages
```

## Dev commands
```
pip install -r requirements.txt pytest
python -m pytest -q tests                        # keep green; CI runs it before building
python scripts/build.py --demo 30                # placeholder images, no network
ICLOUD_ALBUM='<link>' python scripts/build.py    # real build (needs iCloud network access)
python -m http.server -d _site 8000
```
GUI checks: use Playwright (preinstalled in cloud sessions) for screenshots at
desktop (1440×900) and phone (`devices['iPhone 13']`) sizes. Look for page
errors, horizontal overflow, and the lightbox flow. Keep these scripts in the
scratchpad, not the repo.

## Conventions
- Engine logic gets offline tests. Never hit the network in tests.
- Front end: plain HTML/CSS/JS. Respect `prefers-reduced-motion`. It must work
  at phone width with no horizontal scroll.
- Update `README.md` when behavior or settings change.
- A push to `main` deploys the live site. Work on a branch unless the owner
  says to push to `main`.
