// Tags and places: cleaning and display. Used by the site and the editor app.
// Kept identical to clean_tag() / clean_place() / place_label() in build.py
// (parity-tested). Input comes from the public data repo: untrusted.
//
// A place is city, state/region or country level only; never coordinates:
//   { level: "city",    gid: 3176959, city: "Florence", region: "Tuscany", country: "Italy", cc: "IT" }
//   { level: "region",  code: "IT.16", region: "Tuscany", country: "Italy", cc: "IT" }
//   { level: "country", country: "Italy", cc: "IT" }
(function (root) {
  "use strict";
  const MAX_TAG = 40, MAX_PLACE_NAME = 80;
  const tc = root.cleanTitle || (typeof require !== "undefined" && require("./titlecase.js").cleanTitle);
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
  const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);

  function cleanTag(text) {
    return [...tc(String(text == null ? "" : text))].slice(0, MAX_TAG).join("").trim();
  }

  // Place names are kept as GeoNames spells them (no title case).
  function cleanName(v) {
    if (typeof v !== "string") return "";
    const flat = v.replace(CONTROL, " ").split(/\s+/).filter(Boolean).join(" ");
    return [...flat].slice(0, MAX_PLACE_NAME).join("").trim();
  }

  function cleanPlace(raw) {
    if (!isObj(raw)) return null;
    const cc = typeof raw.cc === "string" && /^[A-Z]{2}$/.test(raw.cc) ? raw.cc : "";
    const country = cleanName(raw.country);
    if (!cc || !country) return null;
    if (raw.level === "country") return { level: "country", country, cc };
    const region = cleanName(raw.region);
    if (raw.level === "region") {
      const code = typeof raw.code === "string" && /^[A-Z]{2}\.[A-Za-z0-9]{1,10}$/.test(raw.code) ? raw.code : "";
      return code && region ? { level: "region", code, region, country, cc } : null;
    }
    if (raw.level === "city") {
      const city = cleanName(raw.city);
      const gid = Number.isInteger(raw.gid) && raw.gid > 0 && raw.gid < 1e10 ? raw.gid : 0;
      if (!city || !gid) return null;
      return region ? { level: "city", gid, city, region, country, cc } : { level: "city", gid, city, country, cc };
    }
    return null;
  }

  // "Florence, Italy" · "Miami, Florida, United States" · "Tuscany, Italy" · "Italy"
  // US cities include the state (many share names); elsewhere city + country.
  function placeLabel(p) {
    if (!p) return "";
    if (p.level === "country") return p.country;
    if (p.level === "region") return `${p.region}, ${p.country}`;
    return [p.city, p.cc === "US" ? p.region : "", p.country].filter(Boolean).join(", ");
  }

  // Stable key for "same place" comparisons and the places library.
  function placeKey(p) {
    if (!p) return "";
    return p.level === "city" ? "c:" + p.gid : p.level === "region" ? "r:" + p.code : "n:" + p.cc;
  }

  // Show on site? (kept identical to visibility()/is_shown() in build.py)
  //   hidden: [ids]       always hidden (pulled back)
  //   published: [ids]    always shown (released)
  //   drafts_from: ISO    photos added to the album at/after this start hidden…
  //   DRAFTS_UNTIL        …until this moment: photos added later appear at
  //                       once (owner went site-first on 2026-11-26)
  // Everything else is shown. Untrusted input: bad values are ignored.
  const DRAFTS_UNTIL = Date.parse("2026-11-26T20:45:00Z");
  const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
  function visibility(data) {
    const d = isObj(data) ? data : {};
    const ids = (v) => new Set(Array.isArray(v) ? v.slice(0, 5000).filter((x) => typeof x === "string" && x.length > 0 && x.length <= 64) : []);
    const from = typeof d.drafts_from === "string" && ISO.test(d.drafts_from) ? Date.parse(d.drafts_from) : NaN;
    return { hidden: ids(d.hidden), published: ids(d.published), from: Number.isFinite(from) ? from : null };
  }
  function isShown(id, added, vis) {
    if (vis.hidden.has(id)) return false;
    if (vis.published.has(id)) return true;
    const t = typeof added === "string" && ISO.test(added) ? Date.parse(added) : NaN;
    return !(vis.from !== null && Number.isFinite(t) && t >= vis.from && t < DRAFTS_UNTIL);
  }

  // On the Work page? (kept identical to work()/on_work() in build.py)
  //   on_work: [ids]   checked in the editor
  //   off_work: [ids]  unchecked in the editor
  // Otherwise: photos added to the album before WORK_FROM are on Work (the
  // photos there when this began); photos added later start off it.
  // A photo off Work can still be in a collection, a highlight or shared.
  const WORK_FROM = Date.parse("2026-11-26T18:30:00Z");
  function work(data) {
    const d = isObj(data) ? data : {};
    const ids = (v) => new Set(Array.isArray(v) ? v.slice(0, 5000).filter((x) => typeof x === "string" && x.length > 0 && x.length <= 64) : []);
    return { on: ids(d.on_work), off: ids(d.off_work) };
  }
  function onWork(id, added, w) {
    if (w.off.has(id)) return false;
    if (w.on.has(id)) return true;
    const t = typeof added === "string" && ISO.test(added) ? Date.parse(added) : NaN;
    return !(Number.isFinite(t) && t >= WORK_FROM);
  }

  const api = { cleanTag, cleanPlace, placeLabel, placeKey, MAX_TAG, visibility, isShown, work, onWork };
  root.PhotoMeta = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
