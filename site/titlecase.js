// Title case for photo titles. Kept identical to title_case() in scripts/build.py.
// Short words stay lowercase unless they start or end a part of the title;
// parts are split by "/", ":", "—" and "–". Words with capitals after the first
// letter (NYC, iPhone, McQueen) are left exactly as typed.
(function (root) {
  "use strict";
  const SMALL = new Set(["a", "an", "the", "and", "but", "or", "nor", "for", "so", "yet",
    "as", "at", "by", "in", "of", "off", "on", "per", "to", "up", "via", "vs"]);
  const SEP = /(\s+|\/|:|—|–)/;
  const isSep = (t) => /^(\s+|\/|:|—|–)$/.test(t);
  const isAlpha = (c) => c.toLowerCase() !== c.toUpperCase();

  function word(w, edge) {
    return w.split("-").map((part, i) => {
      const letters = [...part].filter(isAlpha);
      const core = letters.join("").toLowerCase();
      if (letters.slice(1).some((c) => c !== c.toLowerCase())) return part; // deliberate capitals
      if (SMALL.has(core) && !(edge && i === 0)) return part.toLowerCase();
      const low = part.toLowerCase();
      const j = [...low].findIndex(isAlpha);
      if (j < 0) return low;
      const chars = [...low];
      chars[j] = chars[j].toUpperCase();
      return chars.join("");
    }).join("-");
  }

  function titleCase(text) {
    const tokens = String(text).split(/\s+/).filter(Boolean).join(" ").split(SEP);
    const words = [], breaks = [];
    tokens.forEach((t, i) => {
      if (t === "/" || t === ":" || t === "—" || t === "–") breaks.push(i);
      else if (t && !isSep(t)) words.push(i);
    });
    words.forEach((i, n) => {
      const prev = n ? words[n - 1] : null, next = n + 1 < words.length ? words[n + 1] : null;
      const first = prev === null || breaks.some((b) => prev < b && b < i);
      const last = next === null || breaks.some((b) => i < b && b < next);
      tokens[i] = word(tokens[i], first || last);
    });
    return tokens.join("");
  }

  // Untrusted title -> safe display text. Kept identical to clean_title() in
  // build.py: control/invisible characters become spaces, whitespace
  // collapses, at most 200 characters, then title case.
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
  function cleanTitle(text) {
    const flat = String(text).replace(CONTROL, " ").split(/\s+/).filter(Boolean).join(" ");
    return titleCase([...flat].slice(0, 200).join("").trim());
  }

  root.titleCase = titleCase;
  root.cleanTitle = cleanTitle;
  if (typeof module !== "undefined") { module.exports = titleCase; module.exports.cleanTitle = cleanTitle; }
})(typeof window !== "undefined" ? window : globalThis);
