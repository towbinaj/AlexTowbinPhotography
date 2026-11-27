// Data model for the photo editor app (pure functions, no DOM).
// curation.json in the data repo:
//   {
//     "titles":      { "<id>": "Title" },
//     "order":       ["<id>", …],                       // main page order
//     "collections": [{ "name": "Series", "photos": ["<id>", …] }],  // order within each
//     "highlights":  ["<id>", …],                        // home page + slideshow, in this order
//     "tags":        ["Architecture", …],                // the tag library
//     "photo_tags":  { "<id>": ["Architecture", …] },    // only names from the library
//     "locations":   { "<id>": place },                  // see site/meta.js (city/region/country)
//     "hidden":      ["<id>", …],                        // pulled back: not on the site
//     "published":   ["<id>", …],                        // released (overrides drafts_from)
//     "drafts_from": "2026-11-18T16:45:00Z",             // photos added after this start hidden
//     "on_work":     ["<id>", …],                        // checked "On Work page"
//     "off_work":    ["<id>", …],                        // unchecked (new photos start off: meta.js)
//     "no_place":    ["<id>", …]                         // location removed: no automatic GPS place either
//   }
// Everything read from the repo is untrusted and goes through normalize().
(function (root) {
  "use strict";
  const MAX_ID = 64, MAX_LIST = 5000, MAX_COLLECTIONS = 100, MAX_NAME = 60, MAX_TAGS = 300, MAX_PHOTO_TAGS = 30;
  const Meta = root.PhotoMeta || require("../meta.js");
  const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);
  const okId = (id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // Collection names: same cleaning as titles, at most 60 characters.
  function cleanName(text, cleanTitle) {
    const t = cleanTitle(String(text || ""));
    return [...t].slice(0, MAX_NAME).join("").trim();
  }

  function idList(raw, seen = new Set()) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const id of raw.slice(0, MAX_LIST)) if (okId(id) && !seen.has(id)) { seen.add(id); out.push(id); }
    return out;
  }

  function normalize(raw, cleanTitle) {
    const d = isObj(raw) ? raw : {};
    const titles = {};
    if (isObj(d.titles)) {
      for (const k of Object.keys(d.titles).slice(0, MAX_LIST)) {
        const v = d.titles[k];
        if (!okId(k) || typeof v !== "string") continue;
        const t = cleanTitle(v);
        if (t) titles[k] = t;
      }
    }
    const collections = [], names = new Set(), inSome = new Set();
    if (Array.isArray(d.collections)) {
      for (const c of d.collections.slice(0, MAX_COLLECTIONS)) {
        if (!isObj(c)) continue;
        const name = cleanName(c.name, cleanTitle);
        if (!name || names.has(name.toLowerCase())) continue;
        const photos = idList(c.photos, inSome); // a photo belongs to one collection: first wins
        if (!photos.length) continue;
        names.add(name.toLowerCase());
        collections.push({ name, photos });
      }
    }
    const tags = [], lower = new Map();
    if (Array.isArray(d.tags)) {
      for (const t of d.tags.slice(0, MAX_TAGS)) {
        const n = typeof t === "string" ? Meta.cleanTag(t) : "";
        if (n && !lower.has(n.toLowerCase())) { lower.set(n.toLowerCase(), n); tags.push(n); }
      }
    }
    const photo_tags = {};
    if (isObj(d.photo_tags)) {
      for (const k of Object.keys(d.photo_tags).slice(0, MAX_LIST)) {
        const list = d.photo_tags[k];
        if (!okId(k) || !Array.isArray(list)) continue;
        const seen = new Set(), out = [];
        for (const t of list.slice(0, MAX_PHOTO_TAGS)) {
          const n = typeof t === "string" ? lower.get(Meta.cleanTag(t).toLowerCase()) : undefined;
          if (n && !seen.has(n)) { seen.add(n); out.push(n); }
        }
        if (out.length) photo_tags[k] = out;
      }
    }
    const locations = {};
    if (isObj(d.locations)) {
      for (const k of Object.keys(d.locations).slice(0, MAX_LIST)) {
        const pl = okId(k) ? Meta.cleanPlace(d.locations[k]) : null;
        if (pl) locations[k] = pl;
      }
    }
    const vis = Meta.visibility(d);
    const out = { titles, order: idList(d.order), collections, highlights: idList(d.highlights), tags, photo_tags, locations,
      hidden: idList(d.hidden), published: idList(d.published), on_work: idList(d.on_work), off_work: idList(d.off_work), no_place: idList(d.no_place) };
    if (vis.from !== null) out.drafts_from = d.drafts_from;
    return out;
  }

  // Is this photo shown on the site? (same rule as the site and the build)
  const isShown = (doc, p) => Meta.isShown(p.id, p.added, Meta.visibility(doc));
  // Is it in the Work page's list? (the "On Work page" checkmark)
  const onWork = (doc, p) => Meta.onWork(p.id, p.added, Meta.work(doc));
  // The photo's location: chosen in the editor, else automatic from GPS.
  const placeOf = (doc, p) => Meta.placeFor(p.id, doc.locations[p.id], new Set(doc.no_place), p.auto_place);
  const isAutoPlace = (doc, p) => !doc.locations[p.id] && !!placeOf(doc, p);

  const copy = (doc) => ({
    titles: { ...doc.titles },
    order: doc.order.slice(),
    collections: doc.collections.map((c) => ({ name: c.name, photos: c.photos.slice() })),
    highlights: doc.highlights.slice(),
    tags: doc.tags.slice(),
    photo_tags: Object.fromEntries(Object.entries(doc.photo_tags).map(([k, v]) => [k, v.slice()])),
    locations: { ...doc.locations },
    hidden: doc.hidden.slice(),
    published: doc.published.slice(),
    on_work: doc.on_work.slice(),
    off_work: doc.off_work.slice(),
    no_place: doc.no_place.slice(),
    ...(doc.drafts_from ? { drafts_from: doc.drafts_from } : {}),
  });

  // ---- tag library ----
  const findTag = (doc, name) => doc.tags.find((t) => t.toLowerCase() === String(name).toLowerCase());
  function addTag(doc, name) {
    const out = copy(doc), n = Meta.cleanTag(name);
    if (n && !findTag(out, n) && out.tags.length < MAX_TAGS) out.tags.push(n);
    return out;
  }
  // Renaming onto an existing tag merges the two.
  function renameTag(doc, from, to) {
    const out = copy(doc), old = findTag(out, from), n = Meta.cleanTag(to);
    if (!old || !n) return out;
    const target = findTag(out, n);
    const name = target && target !== old ? target : n;
    out.tags = out.tags.flatMap((t) => (t === old ? (target && target !== old ? [] : [name]) : [t]));
    for (const k of Object.keys(out.photo_tags)) {
      out.photo_tags[k] = [...new Set(out.photo_tags[k].map((t) => (t === old ? name : t)))];
    }
    return out;
  }
  function deleteTag(doc, name) {
    const out = copy(doc), old = findTag(out, name);
    if (!old) return out;
    out.tags = out.tags.filter((t) => t !== old);
    for (const k of Object.keys(out.photo_tags)) {
      out.photo_tags[k] = out.photo_tags[k].filter((t) => t !== old);
      if (!out.photo_tags[k].length) delete out.photo_tags[k];
    }
    return out;
  }
  const tagCounts = (doc, ids) => {
    const n = Object.fromEntries(doc.tags.map((t) => [t, 0]));
    for (const id of ids) for (const t of doc.photo_tags[id] || []) n[t] = (n[t] || 0) + 1;
    return n;
  };
  // Places in use, most used first: the "recent places" shortcut list.
  function placesInUse(doc) {
    const m = new Map();
    for (const pl of Object.values(doc.locations)) {
      const k = Meta.placeKey(pl);
      if (!m.has(k)) m.set(k, { place: pl, n: 0 });
      m.get(k).n++;
    }
    return [...m.values()].sort((a, b) => b.n - a.n).map((x) => x.place);
  }

  // Main page order, same rule as the site: photos not placed yet come first.
  function orderPhotos(list, order) {
    const rank = new Map();
    for (const id of order) if (!rank.has(id)) rank.set(id, rank.size);
    const known = list.filter((p) => rank.has(p.id));
    if (!known.length) return list.slice();
    return list.filter((p) => !rank.has(p.id)).concat(known.sort((a, b) => rank.get(a.id) - rank.get(b.id)));
  }

  function collectionOf(doc, id) {
    for (const c of doc.collections) {
      const i = c.photos.indexOf(id);
      if (i >= 0) return { name: c.name, pos: i + 1, size: c.photos.length };
    }
    return null;
  }

  const clampPos = (pos, n) => Math.min(Math.max(1, Math.round(Number(pos)) || n), n);

  // change = { id, title?, collection? (name or "" for none), collectionPos?,
  //            highlight? (bool), mainPos?, mainIds? (ids in main page order) }
  // Returns a new doc; the input is not modified.
  function applyChange(doc, change, cleanTitle) {
    const id = change.id;
    const out = copy(doc);
    if (has(change, "title")) {
      const t = cleanTitle(change.title || "");
      if (t) out.titles[id] = t; else delete out.titles[id];
    }
    if (has(change, "collection")) {
      const name = cleanName(change.collection, cleanTitle);
      const before = collectionOf(doc, id);
      for (const c of out.collections) c.photos = c.photos.filter((x) => x !== id);
      if (name) {
        let c = out.collections.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!c) { c = { name, photos: [] }; out.collections.push(c); }
        // Default: stay where it was if the collection didn't change, else go last.
        const want = change.collectionPos != null ? change.collectionPos
          : before && before.name === c.name ? before.pos : c.photos.length + 1;
        c.photos.splice(clampPos(want, c.photos.length + 1) - 1, 0, id);
      }
      out.collections = out.collections.filter((c) => c.photos.length);
    }
    if (has(change, "highlight")) {
      // Already highlighted: keep its place. Newly highlighted: goes last.
      if (!change.highlight) out.highlights = out.highlights.filter((x) => x !== id);
      else if (!out.highlights.includes(id)) out.highlights.push(id);
    }
    if (has(change, "tags")) {
      // Only library tags; unknown names are added to the library first.
      const names = [];
      for (const t of change.tags || []) {
        const n = Meta.cleanTag(t);
        if (!n) continue;
        let lib = findTag(out, n);
        if (!lib && out.tags.length < MAX_TAGS) { out.tags.push(n); lib = n; }
        if (lib && !names.includes(lib)) names.push(lib);
      }
      if (names.length) out.photo_tags[id] = names.slice(0, MAX_PHOTO_TAGS); else delete out.photo_tags[id];
    }
    if (has(change, "place")) {
      const pl = Meta.cleanPlace(change.place);
      if (pl) out.locations[id] = pl; else delete out.locations[id];
      // Removing a location also turns off the automatic one from GPS.
      out.no_place = out.no_place.filter((x) => x !== id);
      if (!pl) out.no_place.push(id);
    }
    if (has(change, "shown")) {
      // Explicit either way, so it overrides the drafts_from rule.
      out.hidden = out.hidden.filter((x) => x !== id);
      out.published = out.published.filter((x) => x !== id);
      (change.shown ? out.published : out.hidden).push(id);
    }
    if (has(change, "work")) {
      // Explicit either way, so it overrides the new-photos-start-off rule.
      out.on_work = out.on_work.filter((x) => x !== id);
      out.off_work = out.off_work.filter((x) => x !== id);
      (change.work ? out.on_work : out.off_work).push(id);
    }
    if (change.mainPos != null && Array.isArray(change.mainIds)) {
      const ids = change.mainIds.filter((x) => x !== id);
      ids.splice(clampPos(change.mainPos, ids.length + 1) - 1, 0, id);
      out.order = ids;
    }
    return out;
  }

  // Several photos at once. op = { addTags?: [names], removeTags?: [names],
  // collection?: name or "" (none), place?: place or null (remove) }.
  // Collection: photos already in it keep their spot; the rest are added at
  // the end in the order given.
  function applyBulk(doc, ids, op, cleanTitle) {
    let out = copy(doc);
    const add = (op.addTags || []).map((t) => Meta.cleanTag(t)).filter(Boolean);
    const remove = new Set((op.removeTags || []).map((t) => findTag(out, t)).filter(Boolean));
    for (const id of ids) {
      const change = { id };
      if (add.length || remove.size) {
        const cur = (out.photo_tags[id] || []).filter((t) => !remove.has(t));
        change.tags = cur.concat(add);
      }
      if (has(op, "collection")) change.collection = op.collection || "";
      if (has(op, "place")) change.place = op.place;
      if (has(op, "shown")) change.shown = !!op.shown;
      if (has(op, "highlight")) change.highlight = !!op.highlight;
      if (has(op, "work")) change.work = !!op.work;
      out = applyChange(out, change, cleanTitle);
    }
    return out;
  }

  function describeBulk(ids, op) {
    const parts = [];
    if ((op.addTags || []).length) parts.push(`tags +${op.addTags.join(", +")}`);
    if ((op.removeTags || []).length) parts.push(`tags -${op.removeTags.join(", -")}`);
    if (has(op, "collection")) parts.push(op.collection ? `collection "${op.collection}"` : "no collection");
    if (has(op, "place")) parts.push(op.place ? `location ${Meta.placeLabel(op.place)}` : "location removed");
    if (has(op, "shown")) parts.push(op.shown ? "shown on site" : "hidden from site");
    if (has(op, "highlight")) parts.push(op.highlight ? "highlighted" : "highlight removed");
    if (has(op, "work")) parts.push(op.work ? "on Work page" : "off Work page");
    return `${ids.length} photo${ids.length === 1 ? "" : "s"}: ${parts.join("; ") || "no change"}`;
  }

  // Reorder mode. Main page: `newIds` is the new sequence of the photos that
  // were being ordered (the shown ones); they fill the same slots in the full
  // order, so hidden photos keep their places. `orderedIds` is the current
  // full main order (orderPhotos). Photos not in newIds stay where they are.
  function reorderMain(doc, orderedIds, newIds) {
    const out = copy(doc), want = new Set(newIds), queue = newIds.filter((id) => orderedIds.includes(id));
    out.order = orderedIds.map((id) => (want.has(id) && queue.length ? queue.shift() : id));
    return out;
  }
  // Collection: its photos in the new order (any it has that newIds lacks go last).
  function reorderCollection(doc, name, newIds) {
    const out = copy(doc), c = out.collections.find((x) => x.name === name);
    if (!c) return out;
    const keep = newIds.filter((id) => c.photos.includes(id));
    c.photos = keep.concat(c.photos.filter((id) => !keep.includes(id)));
    return out;
  }
  // Highlights: the home page order (any highlighted photo newIds lacks goes last).
  function reorderHighlights(doc, newIds) {
    const out = copy(doc), keep = newIds.filter((id) => out.highlights.includes(id));
    out.highlights = keep.concat(out.highlights.filter((id) => !keep.includes(id)));
    return out;
  }
  // Undo is only safe if the data is exactly what our last save wrote.
  const sameDoc = (a, b) => serialize(a) === serialize(b);

  // "Main page No." counts only photos shown on the site (what visitors see).
  // Turn shown-position n (1-based) into the 1-based position in the full
  // main order (hidden photos included) that applyChange's mainPos expects:
  // the photo goes just before the shown photo now at n, or after the last.
  function mainPosFromShown(mainIds, isShownId, id, n) {
    const ids = mainIds.filter((x) => x !== id);
    const shown = ids.filter(isShownId);
    if (!shown.length) return 1;
    const k = Math.min(Math.max(1, Math.round(Number(n)) || 1), shown.length + 1);
    const idx = k <= shown.length ? ids.indexOf(shown[k - 1]) : ids.indexOf(shown[shown.length - 1]) + 1;
    return idx + 1;
  }

  // Short commit message describing what changed for one photo.
  function describe(before, after, id) {
    const parts = [];
    const t0 = before.titles[id] || "", t1 = after.titles[id] || "";
    if (t0 !== t1) parts.push(t1 ? `title "${t1}"` : "title removed");
    const c0 = collectionOf(before, id), c1 = collectionOf(after, id);
    if ((c0 && c0.name) !== (c1 && c1.name)) parts.push(c1 ? `collection "${c1.name}"` : "no collection");
    else if (c0 && c1 && c0.pos !== c1.pos) parts.push(`#${c1.pos} in "${c1.name}"`);
    const h0 = before.highlights.includes(id), h1 = after.highlights.includes(id);
    if (h0 !== h1) parts.push(h1 ? "highlighted" : "highlight removed");
    const g0 = (before.photo_tags[id] || []).join(","), g1 = (after.photo_tags[id] || []).join(",");
    if (g0 !== g1) parts.push(g1 ? `tags ${(after.photo_tags[id] || []).join(", ")}` : "tags removed");
    const l0 = Meta.placeKey(before.locations[id]), l1 = Meta.placeKey(after.locations[id]);
    if (l0 !== l1) parts.push(l1 ? `location ${Meta.placeLabel(after.locations[id])}` : "location removed");
    else if (!l1 && !before.no_place.includes(id) && after.no_place.includes(id)) parts.push("location removed");
    const s0 = before.published.includes(id) ? 1 : before.hidden.includes(id) ? -1 : 0;
    const s1 = after.published.includes(id) ? 1 : after.hidden.includes(id) ? -1 : 0;
    if (s0 !== s1 && s1) parts.push(s1 > 0 ? "shown on site" : "hidden from site");
    const w0 = before.on_work.includes(id) ? 1 : before.off_work.includes(id) ? -1 : 0;
    const w1 = after.on_work.includes(id) ? 1 : after.off_work.includes(id) ? -1 : 0;
    if (w0 !== w1 && w1) parts.push(w1 > 0 ? "on Work page" : "off Work page");
    const o0 = before.order.indexOf(id), o1 = after.order.indexOf(id);
    if (o0 !== o1 || before.order.length !== after.order.length) parts.push(`Work page #${o1 + 1}`);
    return `Photo ${id}: ${parts.join(", ") || "no change"}`;
  }

  // Stable JSON for the repo: titles sorted by id, 2-space indent.
  function serialize(doc) {
    const titles = Object.fromEntries(Object.keys(doc.titles).sort().map((k) => [k, doc.titles[k]]));
    const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    return JSON.stringify({ titles, order: doc.order, collections: doc.collections, highlights: doc.highlights,
      tags: doc.tags, photo_tags: sortKeys(doc.photo_tags), locations: sortKeys(doc.locations),
      hidden: doc.hidden, published: doc.published, ...(doc.drafts_from ? { drafts_from: doc.drafts_from } : {}),
      ...(doc.on_work.length ? { on_work: doc.on_work } : {}), ...(doc.off_work.length ? { off_work: doc.off_work } : {}),
      ...(doc.no_place.length ? { no_place: doc.no_place } : {}) }, null, 2) + "\n";
  }

  const api = { normalize, orderPhotos, collectionOf, applyChange, describe, serialize, cleanName, MAX_NAME,
    addTag, renameTag, deleteTag, tagCounts, placesInUse, findTag, applyBulk, describeBulk, isShown, onWork, placeOf, isAutoPlace, mainPosFromShown,
    reorderMain, reorderCollection, reorderHighlights, sameDoc };
  root.EditModel = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
