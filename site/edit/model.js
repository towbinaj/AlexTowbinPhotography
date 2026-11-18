// Data model for the photo editor app (pure functions, no DOM).
// curation.json in the data repo:
//   {
//     "titles":      { "<id>": "Title" },
//     "order":       ["<id>", …],                       // main page order
//     "collections": [{ "name": "Series", "photos": ["<id>", …] }],  // order within each
//     "highlights":  ["<id>", …],                        // shown on the main page / hero
//     "tags":        ["Architecture", …],                // the tag library
//     "photo_tags":  { "<id>": ["Architecture", …] },    // only names from the library
//     "locations":   { "<id>": place }                   // see site/meta.js (city/region/country)
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
    return { titles, order: idList(d.order), collections, highlights: idList(d.highlights), tags, photo_tags, locations };
  }

  const copy = (doc) => ({
    titles: { ...doc.titles },
    order: doc.order.slice(),
    collections: doc.collections.map((c) => ({ name: c.name, photos: c.photos.slice() })),
    highlights: doc.highlights.slice(),
    tags: doc.tags.slice(),
    photo_tags: Object.fromEntries(Object.entries(doc.photo_tags).map(([k, v]) => [k, v.slice()])),
    locations: { ...doc.locations },
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
      out.highlights = out.highlights.filter((x) => x !== id);
      if (change.highlight) out.highlights.push(id);
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
    }
    if (change.mainPos != null && Array.isArray(change.mainIds)) {
      const ids = change.mainIds.filter((x) => x !== id);
      ids.splice(clampPos(change.mainPos, ids.length + 1) - 1, 0, id);
      out.order = ids;
    }
    return out;
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
    const o0 = before.order.indexOf(id), o1 = after.order.indexOf(id);
    if (o0 !== o1 || before.order.length !== after.order.length) parts.push(`main page #${o1 + 1}`);
    return `Photo ${id}: ${parts.join(", ") || "no change"}`;
  }

  // Stable JSON for the repo: titles sorted by id, 2-space indent.
  function serialize(doc) {
    const titles = Object.fromEntries(Object.keys(doc.titles).sort().map((k) => [k, doc.titles[k]]));
    const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    return JSON.stringify({ titles, order: doc.order, collections: doc.collections, highlights: doc.highlights,
      tags: doc.tags, photo_tags: sortKeys(doc.photo_tags), locations: sortKeys(doc.locations) }, null, 2) + "\n";
  }

  const api = { normalize, orderPhotos, collectionOf, applyChange, describe, serialize, cleanName, MAX_NAME,
    addTag, renameTag, deleteTag, tagCounts, placesInUse, findTag };
  root.EditModel = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
