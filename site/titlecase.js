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

  root.titleCase = titleCase;
  if (typeof module !== "undefined") module.exports = titleCase;
})(typeof window !== "undefined" ? window : globalThis);
