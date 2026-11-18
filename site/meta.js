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

  const api = { cleanTag, cleanPlace, placeLabel, placeKey, MAX_TAG };
  root.PhotoMeta = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
