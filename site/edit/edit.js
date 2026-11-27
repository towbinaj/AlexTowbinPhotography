// Photo editor app (owner only, not linked from the site).
// Reads ../photos.json (what the site shows) and curation.json from the data
// repo through the GitHub API with the owner's key; saves back the same way.
// Everything from the repo is untrusted: normalized by model.js, shown as text.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const M = window.EditModel, clean = window.cleanTitle;
  const KEY = "at-data-key", EXP = "at-data-key-exp", WARN_DAYS = 14;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: lasts this visit */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const mem = {};
  const getKey = () => store.get(KEY) || mem.key || "";
  store.set("at-no-count", "1"); // the owner's browser: don't count its visits to the site
  // Second key, only for "Publish now" (site repo, Actions: read and write).
  // With the Face ID lock (prf) both keys are sealed together as one bundle.
  const PUB = "at-pub-key";
  const getPub = () => store.get(PUB) || mem.pub || "";
  const bundle = (k = getKey(), p = getPub()) => (p ? JSON.stringify({ k, p }) : k);
  function applyBundle(sealed) {
    if (!sealed) return;
    let o = null;
    if (sealed[0] === "{") { try { o = JSON.parse(sealed); } catch { o = null; } }
    if (o && typeof o.k === "string") { mem.key = o.k; mem.pub = typeof o.p === "string" ? o.p : ""; } else mem.key = sealed;
  }

  let repo = "", all = [], doc = M.normalize({}, clean), sha;
  let filter = "all", shown = [], current = -1;

  // ---------------- GitHub ----------------
  const api = (path) => `https://api.github.com/repos/${repo}${path}`;
  const headers = (k = getKey()) => ({ Authorization: `Bearer ${k}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
  const b64enc = (s) => { let bin = ""; for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
  const b64dec = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
  class GhError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
  const why = (status) =>
    status === 401 ? "GitHub didn't accept the key. It may have expired: tap Key to replace it." :
    status === 403 || status === 404 ? "This key can't use the photo data repository. It needs Contents: read and write on it." :
    status === 409 || status === 422 ? "The data changed at the same moment. Try again." :
    `GitHub error ${status}. Try again.`;

  async function readDoc() {
    const r = await fetch(api("/contents/curation.json?ref=main"), { headers: headers(), cache: "no-store" });
    if (r.status === 404) return { doc: M.normalize({}, clean), sha: undefined };
    if (!r.ok) throw new GhError(why(r.status), r.status);
    const j = await r.json();
    let raw = null;
    try { raw = JSON.parse(b64dec(j.content || "")); } catch { raw = null; }
    return { doc: M.normalize(raw, clean), sha: j.sha };
  }

  // Re-reads the latest file, applies `edit` to it and commits. `edit(doc)`
  // returns { next, message }. Retries once if someone saved in between.
  // lastChange: what the most recent save replaced, for Undo.
  let lastChange = null;
  async function commit(edit, isUndo) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await readDoc();
      const { next, message } = edit(cur.doc);
      const body = { message, content: b64enc(M.serialize(next)), branch: "main", ...(cur.sha ? { sha: cur.sha } : {}) };
      const w = await fetch(api("/contents/curation.json"), { method: "PUT", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (w.ok) {
        const j = await w.json().catch(() => ({})); doc = next; sha = j.content && j.content.sha;
        if (isUndo) lastChange = null; else { lastChange = { before: cur.doc, after: next, message }; offerUndo(message); }
        return;
      }
      if ((w.status === 409 || w.status === 422) && attempt === 0) continue; // changed underneath us: re-read once
      throw new GhError(why(w.status), w.status);
    }
  }
  const save = (change) => commit((d) => {
    const mainIds = M.orderPhotos(all, d.order).map((p) => p.id);
    const c = { ...change, mainIds };
    if (c.shownPos != null) {
      // Work page No. is among the photos visitors see on Work (shown and
      // checked "On Work page"); convert using the latest data and this
      // change's own Show on site / On Work page, if it has them.
      const byId = new Map(all.map((p) => [p.id, p]));
      const isShownId = (x) => {
        const p = byId.get(x);
        if (!p) return false;
        const sh = x === change.id && "shown" in change ? change.shown : M.isShown(d, p);
        const wk = x === change.id && "work" in change ? change.work : M.onWork(d, p);
        return sh && wk;
      };
      c.mainPos = M.mainPosFromShown(mainIds, isShownId, change.id, c.shownPos);
      delete c.shownPos;
    }
    const next = M.applyChange(d, c, clean);
    return { next, message: M.describe(d, next, change.id) };
  });

  // ---------------- helpers ----------------
  const fmtDate = (iso, opts) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString("en-US", opts) : "—"; };
  const monthYear = (iso) => fmtDate(iso, { month: "short", year: "numeric" });
  const longDate = (iso) => fmtDate(iso, { day: "numeric", month: "short", year: "numeric" });
  const thumb = (p, cssW) => {
    const need = cssW * Math.min(window.devicePixelRatio || 1, 3);
    const u = (p.src.find((s) => s.w >= need) || p.src[p.src.length - 1]).url;
    return /^https:\/\//.test(u) ? u : "../" + u; // image host (R2) or the site
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ordered = () => M.orderPhotos(all, doc.order);
  function show(id) {
    for (const s of ["setup", "list", "detail", "settings", "boot", "picker", "tagscreen", "lock", "bulktags", "bulkcoll", "reorder"]) $(s).hidden = s !== id;
    syncTop();
  }
  // The pinned top bar's height (it changes with screen and text size).
  function syncTop() {
    const t = document.querySelector(".screen:not([hidden]) > .pinned, .screen:not([hidden]) > .top");
    if (t && t.offsetHeight) document.documentElement.style.setProperty("--top-h", t.offsetHeight + "px");
  }
  addEventListener("resize", syncTop);
  if (window.ResizeObserver) { const ro = new ResizeObserver(syncTop); document.querySelectorAll(".top, .pinned").forEach((t) => ro.observe(t)); }
  const Meta = window.PhotoMeta;
  const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  // ---------------- key expiry ----------------
  function expiryInfo() {
    const v = store.get(EXP) || mem.exp || "";
    if (!v) return { text: "Not set", days: null };
    if (v === "never") return { text: "Never", days: null };
    const d = new Date(v + "T12:00:00");
    if (isNaN(d)) return { text: "Not set", days: null };
    const today = new Date(); today.setHours(12, 0, 0, 0);
    return { text: longDate(d.toISOString()), days: Math.round((d - today) / 86400000) }; // calendar days
  }
  function banner() {
    const b = $("banner"), { days, text } = expiryInfo();
    b.hidden = true; b.classList.remove("bad");
    if (days == null) return;
    if (days < 0) { b.textContent = `Your key expired on ${text}. Make a new one on GitHub, then tap Key → Replace key.`; b.classList.add("bad"); b.hidden = false; }
    else if (days <= WARN_DAYS) { b.textContent = `Your key expires in ${days} day${days === 1 ? "" : "s"} (${text}). Make a new one on GitHub, then tap Key → Replace key.`; b.hidden = false; }
  }

  // ---------------- grid ----------------
  function filters() {
    const untitled = all.filter((p) => !doc.titles[p.id]).length;
    const loose = all.filter((p) => !M.collectionOf(doc, p.id)).length;
    const noPlace = all.filter((p) => !doc.locations[p.id]).length;
    const hiddenN = all.filter((p) => !M.isShown(doc, p)).length;
    const offWork = all.filter((p) => !M.onWork(doc, p)).length;
    const onWorkN = all.filter((p) => M.isShown(doc, p) && M.onWork(doc, p)).length;
    const out = [["all", `All ${all.length}`], ["shown", `Shown ${all.length - hiddenN}`], ["hidden", `Hidden ${hiddenN}`], ["untitled", `Untitled ${untitled}`], ["noplace", `No location ${noPlace}`], ["onwork", `On Work ${onWorkN}`], ["offwork", `Not on Work ${offWork}`], ["high", `★ ${doc.highlights.filter((id) => all.some((p) => p.id === id)).length}`], ["nohigh", `Not ★ ${all.length - doc.highlights.filter((id) => all.some((p) => p.id === id)).length}`], ["none", `No collection ${loose}`]];
    doc.collections.forEach((c, i) => out.push(["c" + i, `${c.name} ${c.photos.filter((id) => all.some((p) => p.id === id)).length}`]));
    return out;
  }
  let query = "";
  function matches(p) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const pl = doc.locations[p.id] || {};
    const h = fold([doc.titles[p.id], monthYear(p.taken), Meta.placeLabel(doc.locations[p.id]), pl.region, pl.country,
      ...(doc.photo_tags[p.id] || []), (M.collectionOf(doc, p.id) || {}).name].filter(Boolean).join(" | "));
    return words.every((w) => h.includes(w));
  }
  function photosFor(f) {
    return photosForFilter(f).filter(matches);
  }
  function photosForFilter(f) {
    const list = ordered();
    if (f === "untitled") return list.filter((p) => !doc.titles[p.id]);
    if (f === "noplace") return list.filter((p) => !doc.locations[p.id]);
    if (f === "hidden") return list.filter((p) => !M.isShown(doc, p));
    if (f === "shown") return list.filter((p) => M.isShown(doc, p));
    if (f === "offwork") return list.filter((p) => !M.onWork(doc, p));
    // What visitors see on the Work page: shown and checked, in Work order.
    if (f === "onwork") return list.filter((p) => M.isShown(doc, p) && M.onWork(doc, p));
    if (f === "nohigh") return list.filter((p) => !doc.highlights.includes(p.id));
    if (f === "high") { const byId = new Map(list.map((p) => [p.id, p])); return doc.highlights.map((id) => byId.get(id)).filter(Boolean); }
    if (f === "none") return list.filter((p) => !M.collectionOf(doc, p.id));
    if (f[0] === "c") {
      const c = doc.collections[Number(f.slice(1))];
      if (!c) return list;
      const byId = new Map(all.map((p) => [p.id, p]));
      return c.photos.map((id) => byId.get(id)).filter(Boolean);
    }
    return list;
  }
  function renderList() {
    const fs = filters();
    if (!fs.some(([k]) => k === filter)) filter = "all";
    const chips = $("chips"); chips.textContent = "";
    for (const [k, label] of fs) {
      const b = el("button", "chip", label); b.type = "button";
      b.setAttribute("aria-pressed", String(k === filter));
      b.addEventListener("click", () => { filter = k; renderList(); });
      chips.appendChild(b);
    }
    shown = photosFor(filter);
    $("list-count").textContent = `${all.length} photos`;
    const grid = $("grid"); grid.textContent = "";
    shown.forEach((p) => {
      const a = el("a", "tile" + (selected.has(p.id) ? " sel" : "")); a.href = "#p/" + encodeURIComponent(p.id);
      a.addEventListener("click", (e) => {
        if (!selecting) return;
        e.preventDefault();
        if (selected.has(p.id)) selected.delete(p.id); else selected.add(p.id);
        a.classList.toggle("sel", selected.has(p.id));
        a.setAttribute("aria-pressed", String(selected.has(p.id)));
        selUpdate();
      });
      if (selecting) a.setAttribute("aria-pressed", String(selected.has(p.id)));
      const img = new Image(); img.loading = "lazy"; img.decoding = "async"; img.draggable = false; img.alt = "";
      img.src = thumb(p, 180); img.width = p.w; img.height = p.h;
      const frame = el("span", "frame"); frame.appendChild(img);
      const hiddenNow = !M.isShown(doc, p);
      if (hiddenNow) a.classList.add("hidden");
      const title = doc.titles[p.id];
      const cap = el("span", "cap" + (title ? "" : " untitled"), title || monthYear(p.taken));
      const c = M.collectionOf(doc, p.id);
      const star = doc.highlights.includes(p.id);
      const meta = el("span", "meta mono" + (star ? " high" : ""), (star ? "★ " : "") + (c ? `${c.name} · ${c.pos}` : star ? "" : "—"));
      const pl = doc.locations[p.id], tg = doc.photo_tags[p.id] || [];
      const meta2 = el("span", "meta mono", [pl ? Meta.placeLabel(pl) : "", tg.length ? `${tg.length} tag${tg.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ") || "No location");
      a.append(frame, cap, meta, meta2);
      if (hiddenNow) a.appendChild(el("span", "meta mono hid", "Hidden · not on the site"));
      else if (!M.onWork(doc, p)) a.appendChild(el("span", "meta mono hid", "Not on Work page"));
      a.setAttribute("aria-label", (title || "Untitled photo") + (c ? `, ${c.name} number ${c.pos}` : "") + (star ? ", highlighted" : ""));
      grid.appendChild(a);
    });
    if (selecting) selUpdate();
    $("list-empty").hidden = shown.length > 0;
    $("list-empty").textContent = query ? "No photos match that search." : "Nothing here.";
    banner();
  }

  // ---------------- detail ----------------
  const NEW = " new"; // never a real name: names are trimmed
  let base = null; // field values when the photo was opened, to detect changes
  let pendingTags = [], pendingPlace = null;
  function values() {
    const coll = $("f-coll").value === NEW ? M.cleanName($("f-newcoll").value, clean) : $("f-coll").value;
    return { title: clean($("f-title").value), collection: coll, cpos: $("f-cpos").value, high: $("f-high").checked, mpos: $("f-mpos").value, shown: $("f-shown").checked, work: $("f-work").checked,
      tags: pendingTags.join("\n"), place: Meta.placeKey(pendingPlace) };
  }
  function dirty() { const v = values(); return !!base && Object.keys(v).some((k) => String(v[k]) !== String(base[k])); }
  function refreshSave() { $("f-save").disabled = !dirty(); }

  function fillCollPos() {
    const sel = $("f-coll").value, p = shown[current];
    const isNew = sel === NEW;
    $("f-newcoll-wrap").hidden = !isNew;
    const c = M.collectionOf(doc, p.id);
    const target = doc.collections.find((x) => x.name === sel);
    const size = isNew ? 1 : target ? target.photos.length + (c && c.name === sel ? 0 : 1) : 0;
    $("f-cpos").disabled = !sel;
    $("f-cpos").max = size || 1;
    $("f-cpos-of").textContent = sel ? `of ${size}` : "";
    if (!sel) $("f-cpos").value = "";
    else if (c && c.name === sel) $("f-cpos").value = c.pos;
    else $("f-cpos").value = size;
  }

  function openDetail(id) {
    if (!shown.some((p) => p.id === id)) { filter = "all"; query = ""; $("list-search").value = ""; shown = photosFor("all"); }
    current = shown.findIndex((p) => p.id === id);
    if (current < 0) { location.hash = ""; return; }
    const p = shown[current];
    const img = $("detail-img");
    img.src = thumb(p, Math.min(innerWidth, 900)); img.width = p.w; img.height = p.h;
    img.alt = doc.titles[p.id] || "";
    $("detail-count").textContent = `${current + 1} / ${shown.length}`;
    $("f-title").value = doc.titles[p.id] || "";
    const sel = $("f-coll"); sel.textContent = "";
    sel.append(new Option("None", ""));
    for (const c of doc.collections) sel.append(new Option(c.name, c.name));
    sel.append(new Option("New collection…", NEW));
    const c = M.collectionOf(doc, p.id);
    sel.value = c ? c.name : "";
    $("f-newcoll").value = "";
    fillCollPos();
    $("f-high").checked = doc.highlights.includes(p.id);
    $("f-shown").checked = M.isShown(doc, p);
    $("f-work").checked = M.onWork(doc, p);
    shownNote();
    pendingTags = (doc.photo_tags[p.id] || []).slice();
    pendingPlace = doc.locations[p.id] || null;
    $("f-tag-in").value = "";
    renderTags(); renderPlace();
    fillMainPos(p, M.isShown(doc, p), M.onWork(doc, p));
    $("f-taken").textContent = longDate(p.taken);
    $("f-added").textContent = longDate(p.added);
    const loc = $("f-loc");
    loc.textContent = p.located ? "✓ In the file" : "✗ Not in the file";
    loc.className = p.located ? "ok" : "no";
    status("");
    base = values();
    refreshSave();
    show("detail");
    scrollTo(0, 0);
  }

  function status(msg, err) { const s = $("f-status"); s.textContent = msg; s.classList.toggle("err", !!err); }

  function step(d) {
    if (current < 0 || !shown.length) return;
    if (dirty() && !confirm("Discard unsaved changes?")) return;
    const p = shown[(current + d + shown.length) % shown.length];
    history.replaceState(null, "", "#p/" + encodeURIComponent(p.id));
    openDetail(p.id);
  }

  $("detail-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = shown[current];
    if (!p || !dirty()) return;
    const v = values();
    if ($("f-coll").value === NEW && !v.collection) { status("Name the new collection.", true); $("f-newcoll").focus(); return; }
    const change = { id: p.id };
    if (v.title !== base.title) change.title = v.title;
    if (v.collection !== base.collection || String(v.cpos) !== String(base.cpos)) {
      change.collection = v.collection;
      if (v.collection) change.collectionPos = Number(v.cpos) || null;
    }
    if (v.high !== base.high) change.highlight = v.high;
    if (v.shown !== base.shown) change.shown = v.shown;
    if (v.work !== base.work) change.work = v.work;
    if (v.tags !== base.tags) change.tags = pendingTags.slice();
    if (v.place !== base.place) change.place = pendingPlace;
    if (String(v.mpos) !== String(base.mpos) && v.mpos !== "") {
      const max = Number($("f-mpos").max) || 1;
      const n = Math.round(Number(v.mpos));
      if (!Number.isFinite(n) || n < 1 || n > max) { status(`Work page No. must be 1–${max}.`, true); return; }
      change.shownPos = n;
    }
    $("f-save").disabled = true; status("Saving…");
    try {
      await save(change);
      status("Saved · on the site in ~5 min");
      const id = p.id;
      shown = photosFor(filter);
      if (!shown.some((x) => x.id === id)) { filter = "all"; shown = photosFor("all"); }
      const keep = $("f-status").textContent;
      openDetail(id);
      status(keep);
    } catch (err) {
      status(err.message || "Couldn't save. Try again.", true);
      refreshSave();
      if (err.status === 401) banner();
    }
  });
  for (const id of ["f-title", "f-cpos", "f-high", "f-mpos", "f-newcoll"]) $(id).addEventListener("input", refreshSave);
  $("f-high").addEventListener("change", refreshSave);
  function shownNote() {
    const on = $("f-shown").checked, p = shown[current];
    const draftByDate = p && !doc.hidden.includes(p.id) && !doc.published.includes(p.id) && !M.isShown(doc, p);
    $("f-shown-note").textContent = on ? "On the site" : draftByDate ? "New · hidden until released" : "Hidden: not on the site";
    $("f-shown").closest(".showrow").classList.toggle("off", !on);
  }
  $("f-shown").addEventListener("change", () => {
    shownNote();
    const p = shown[current];
    if (p) fillMainPos(p, $("f-shown").checked, $("f-work").checked, true);
    refreshSave();
  });
  $("f-work").addEventListener("change", () => {
    const p = shown[current];
    if (p) fillMainPos(p, $("f-shown").checked, $("f-work").checked, true);
    refreshSave();
  });
  // Work page No.: position among the photos visitors see on Work (shown on
  // the site and checked "On Work page"), not among all photos.
  function fillMainPos(p, willShow, onWorkNow, keepTyped) {
    const list = ordered();
    const vis = (x) => M.isShown(doc, x) && M.onWork(doc, x);
    const shownList = list.filter((x) => x.id !== p.id && vis(x));
    const inp = $("f-mpos");
    const c = M.collectionOf(doc, p.id);
    $("f-work-note").hidden = onWorkNow;
    $("f-work-note").textContent = onWorkNow ? "" : c ? `Visitors see it in “${c.name}”.` : "Not in a collection, so visitors only see it as a highlight or by its link.";
    if (!willShow || !onWorkNow) {
      inp.disabled = true; inp.value = ""; inp.max = 1;
      $("f-mpos-of").textContent = willShow ? "off" : "hidden";
      return;
    }
    const before = list.slice(0, list.findIndex((x) => x.id === p.id)).filter(vis).length;
    inp.disabled = false;
    inp.max = shownList.length + 1;
    if (!keepTyped || !inp.value) inp.value = before + 1;
    $("f-mpos-of").textContent = `of ${shownList.length + 1}`;
  }
  $("f-coll").addEventListener("change", () => { fillCollPos(); refreshSave(); if ($("f-coll").value === NEW) $("f-newcoll").focus(); });
  $("back").addEventListener("click", () => { if (dirty() && !confirm("Discard unsaved changes?")) return; location.hash = ""; });
  $("prev").addEventListener("click", () => step(-1));
  $("next").addEventListener("click", () => step(1));
  let tx = null, ty = null;
  $("detail-img").addEventListener("touchstart", (e) => { if (e.touches.length === 1) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; } }, { passive: true });
  $("detail-img").addEventListener("touchend", (e) => {
    if (tx === null) return;
    const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty; tx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) step(dx < 0 ? 1 : -1);
  });
  // Same save deterrents as the site.
  document.addEventListener("contextmenu", (e) => { if (e.target.tagName === "IMG") e.preventDefault(); });
  document.addEventListener("dragstart", (e) => { if (e.target.tagName === "IMG") e.preventDefault(); });

  // ---------------- tags on a photo ----------------
  function renderTags() {
    const box = $("f-tags"); box.textContent = "";
    for (const t of pendingTags) {
      const chip = el("span", "tagchip", t);
      const x = el("button", "", "×"); x.type = "button"; x.setAttribute("aria-label", `Remove tag ${t}`);
      x.addEventListener("click", () => { pendingTags = pendingTags.filter((n) => n !== t); renderTags(); refreshSave(); });
      chip.appendChild(x); box.appendChild(chip);
    }
    renderSuggestions();
  }
  // Library tags not on this photo, as tap-to-add chips (always shown; iOS
  // Safari's <datalist> often shows nothing). Typing narrows the list; most
  // used tags first.
  function renderSuggestions() {
    const box = $("f-tag-suggest"); box.textContent = "";
    const q = fold($("f-tag-in").value.trim());
    const counts = M.tagCounts(doc, all.map((p) => p.id));
    const list = doc.tags.filter((t) => !pendingTags.includes(t) && (!q || fold(t).includes(q)))
      .sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
    for (const t of list.slice(0, 40)) {
      const b = el("button", "suggest", "+ " + t); b.type = "button";
      b.setAttribute("aria-label", `Add tag ${t}`);
      b.addEventListener("click", () => { if (!pendingTags.includes(t)) pendingTags.push(t); $("f-tag-in").value = ""; renderTags(); refreshSave(); });
      box.appendChild(b);
    }
    if (!list.length && q && !M.findTag(doc, $("f-tag-in").value)) box.appendChild(el("span", "hint mono", "New tag: tap Add"));
    box.hidden = !box.childElementCount;
  }
  function addTagFromInput() {
    const n = Meta.cleanTag($("f-tag-in").value);
    if (!n) return;
    const lib = M.findTag(doc, n);
    if (!lib && !confirm(`“${n}” isn't in your tag library yet. Add it as a new tag?`)) return;
    const name = lib || n;
    if (!pendingTags.includes(name)) pendingTags.push(name);
    $("f-tag-in").value = "";
    renderTags(); refreshSave();
  }
  $("f-tag-add").addEventListener("click", addTagFromInput);
  $("f-tag-in").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTagFromInput(); } });
  $("f-tag-in").addEventListener("input", renderSuggestions);

  // ---------------- location on a photo ----------------
  function renderPlace() {
    const pl = $("f-place");
    pl.textContent = pendingPlace ? Meta.placeLabel(pendingPlace) : "Not set";
    pl.classList.toggle("none", !pendingPlace);
    $("f-place-clear").hidden = !pendingPlace;
    $("f-place-pick").textContent = pendingPlace ? "Change" : "Choose";
  }
  $("f-place-clear").addEventListener("click", () => { pendingPlace = null; renderPlace(); refreshSave(); });
  $("f-place-pick").addEventListener("click", () => picker.open((pl) => { pendingPlace = pl; renderPlace(); refreshSave(); }));

  // Built-in places list (site/edit/places.json, from GeoNames), loaded on first use.
  const picker = (() => {
    let data = null, loading = null, idx = null;
    const load = () => loading || (loading = fetch("places.json").then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((d) => {
      data = d;
      const C = d.countries, R = d.regions;
      idx = {
        countries: C.map(([cc, name]) => ({ place: { level: "country", country: name, cc }, name: fold(name), extra: fold(cc) })),
        regions: R.map(([code, name, ci]) => ({ place: { level: "region", code, region: name, country: C[ci][1], cc: C[ci][0] }, name: fold(name), extra: fold(C[ci][1]) })),
        cities: d.cities.map(([gid, name, ri, ci, aliases]) => ({ gid, name: fold(name), alts: aliases ? aliases.split("|").map(fold) : [], raw: name, ri, ci, extra: fold((ri >= 0 ? R[ri][1] : "") + " " + C[ci][1] + " " + C[ci][0]) })),
      };
    }));
    const cityPlace = (c) => {
      const C = data.countries, R = data.regions;
      const pl = { level: "city", gid: c.gid, city: c.raw, country: C[c.ci][1], cc: C[c.ci][0] };
      if (c.ri >= 0) pl.region = R[c.ri][1];
      return Meta.cleanPlace(pl);
    };
    // The first word must start the place's name (or a word in it); any other
    // words can match its state/region or country. Exact names rank first.
    // Other spellings (Irákleion for Heraklion, Zürich for Zurich) match too.
    function score(name, alts, first) {
      const all = [name, ...alts];
      if (all.some((n) => n === first)) return 0;
      if (all.some((n) => n.startsWith(first))) return 1;
      if (all.some((n) => (" " + n).includes(" " + first))) return 2;
      return -1;
    }
    function find(q) {
      const parts = fold(q).replace(/,/g, " ").split(/\s+/).filter(Boolean);
      if (!parts.length || !idx) return [];
      // Try the longest leading run of words as the name ("new york", "san jose costa rica").
      const out = [];
      const seen = new Set();
      for (let k = parts.length; k >= 1; k--) {
        const first = parts.slice(0, k).join(" "), rest = parts.slice(k);
        const ok = (e) => rest.every((w) => e.extra.includes(w));
        const pools = [["country", idx.countries], ["region", idx.regions], ["city", idx.cities]];
        for (const [lvl, pool] of pools) {
          for (const e of pool) {
            const s = score(e.name, e.alts || [], first);
            if (s < 0 || !ok(e)) continue;
            const pl = lvl === "city" ? null : e.place;
            const key = lvl === "city" ? "c:" + e.gid : Meta.placeKey(pl);  // no duplicates
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ s, lvl, e });
            if (out.length > 400) break;
          }
        }
        if (out.length) break;
      }
      const rank = { country: 0, region: 1, city: 2 };
      out.sort((a, b) => a.s - b.s || (a.s === 0 ? rank[a.lvl] - rank[b.lvl] : 0)); // stable: cities stay by population
      return out.slice(0, 40).map((r) => (r.lvl === "city" ? cityPlace(r.e) : r.e.place)).filter(Boolean);
    }
    function item(pl, onPick) {
      const li = el("li"), b = el("button");
      b.type = "button";
      b.append(el("span", "", Meta.placeLabel(pl)),
        el("span", "sub mono", pl.level === "city" ? ["Town / island", pl.region, pl.country].filter(Boolean).join(" · ") : pl.level === "region" ? `State / region · ${pl.country}` : "Country"));
      b.addEventListener("click", () => onPick(pl));
      li.appendChild(b);
      return li;
    }
    function render() {
      const ul = $("picker-results"), q = $("picker-q").value.trim();
      ul.textContent = "";
      const pick = (pl) => { const fn = onPick; close(); fn(pl); };
      if (!q) {
        const used = M.placesInUse(doc);
        if (used.length) { ul.appendChild(el("li", "head mono", "Your places")); for (const pl of used) ul.appendChild(item(pl, pick)); }
        return;
      }
      if (!idx) { ul.appendChild(el("li", "head mono", "Loading places…")); return; }
      const res = find(q);
      if (!res.length) { ul.appendChild(el("li", "head mono", "No match. Try the state/region or country.")); return; }
      for (const pl of res) ul.appendChild(item(pl, pick));
    }
    let timer;
    $("picker-q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 150); });
    $("picker-cancel").addEventListener("click", () => close());
    let onPick = null, back = "detail";
    function close() { show(back); if (back === "detail") $("f-place-pick").focus(); }
    return {
      // pick(place) is called with the chosen place; returns to `from`.
      open(pickFn, from = "detail", title = "Location") {
        onPick = pickFn; back = from;
        $("picker-h").textContent = title;
        $("picker-q").value = "";
        show("picker"); render(); $("picker-q").focus();
        load().then(render).catch(() => { $("picker-results").textContent = ""; $("picker-results").appendChild(el("li", "head mono", "Couldn't load the places list. Check your connection.")); });
      },
      find, load, // for tests
    };
  })();
  window.__picker = picker;

  // ---------------- publish now ----------------
  // Starts the site build (GitHub Actions workflow_dispatch) with the publish
  // key, then follows it until it's done and reloads the photo list, so new
  // album photos show up without waiting for GitHub's (unreliable) schedule.
  let siteRepo = "", builtAt = "", pubTimer = 0, pubBusy = false, dispatchedAt = 0;
  const ghPub = (path, opts = {}, k = getPub()) => fetch(`https://api.github.com/repos/${siteRepo}${path}`, {
    ...opts, cache: "no-store",
    headers: { Authorization: `Bearer ${k}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
  });
  function ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  }
  function pubSay(msg, err) { $("pub-status").textContent = msg; $("pubbar").classList.toggle("err", !!err); }
  function pubIdle() { pubSay(builtAt ? `Site updated ${ago(builtAt)}` : ""); $("pub-now").disabled = false; }
  async function refreshPhotos() {
    try {
      const [cfg, list] = await Promise.all([
        fetch("../config.json", { cache: "no-store" }).then((r) => r.json()),
        fetch("../photos.json", { cache: "no-store" }).then((r) => r.json()),
      ]);
      const before = all.length;
      all = Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && Array.isArray(p.src) && p.src.length) : all;
      builtAt = typeof cfg.built_at === "string" ? cfg.built_at : builtAt;
      if (!$("list").hidden) renderList();
      const n = all.length - before;
      pubSay(n > 0 ? `Published · ${n} new photo${n === 1 ? "" : "s"} (see Hidden)` : "Published · site is up to date");
    } catch { pubSay("Published. Reopen the app to see new photos."); }
  }
  async function pubPoll() {
    clearTimeout(pubTimer);
    if (!siteRepo || !getPub()) { pubIdle(); return; }
    try {
      const r = await ghPub("/actions/workflows/deploy.yml/runs?per_page=1");
      if (!r.ok) throw new Error(String(r.status));
      const run = ((await r.json()).workflow_runs || [])[0];
      const isOld = run && dispatchedAt && Date.parse(run.created_at) < dispatchedAt - 15000;
      if (run && run.status !== "completed") {
        pubBusy = true; $("pub-now").disabled = true;
        pubSay(`Publishing… started ${ago(run.run_started_at || run.created_at)} (about 5 min)`);
        pubTimer = setTimeout(pubPoll, 15000);
      } else if (pubBusy && isOld && Date.now() - dispatchedAt < 120000) {
        pubTimer = setTimeout(pubPoll, 8000); // our run hasn't appeared yet
      } else if (pubBusy) {
        pubBusy = false; dispatchedAt = 0; $("pub-now").disabled = false;
        if (run && run.conclusion === "success") await refreshPhotos();
        else pubSay(`Publishing didn't finish (${(run && run.conclusion) || "unknown"}). Try again, or look at Actions on GitHub.`, true);
      } else pubIdle();
    } catch { pubBusy = false; pubIdle(); }
  }
  $("pub-now").addEventListener("click", async () => {
    if (!getPub()) {
      $("open-settings").click();
      fillPubSettings("Add a publish key first (below).", true);
      $("s-pub-in").focus();
      return;
    }
    $("pub-now").disabled = true; pubSay("Starting…");
    try {
      const r = await ghPub("/actions/workflows/deploy.yml/dispatches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: "main" }) });
      if (r.status === 204) { pubBusy = true; dispatchedAt = Date.now(); pubSay("Publishing… about 5 min"); pubTimer = setTimeout(pubPoll, 8000); return; }
      pubSay(r.status === 401 ? "GitHub didn't accept the publish key. Replace it under Key." :
        r.status === 403 || r.status === 404 ? "The publish key can't start builds. It needs Actions: read and write on the site repository." :
        `GitHub error ${r.status}. Try again.`, true);
    } catch { pubSay("Couldn't reach GitHub. Check your connection.", true); }
    $("pub-now").disabled = false;
  });

  // ---------------- select several: bulk tags / collection / location ----------------
  let selecting = false;
  const selected = new Set();
  function selUpdate() {
    const n = selected.size;
    $("sel-count").textContent = n ? `${n} selected` : "Tap photos";
    for (const id of ["bulk-tags", "bulk-coll", "bulk-place", "bulk-high", "bulk-work", "bulk-show", "bulk-hide"]) $(id).disabled = !n;
    const byId = new Map(all.map((p) => [p.id, p]));
    $("bulk-work").textContent = n && [...selected].every((id) => byId.get(id) && M.onWork(doc, byId.get(id))) ? "Off Work" : "On Work";
    $("bulk-high").textContent = n && [...selected].every((id) => doc.highlights.includes(id)) ? "★ Remove" : "★ Highlight";
    $("sel-all").textContent = shown.length && shown.every((p) => selected.has(p.id)) ? "Select none" : "Select all";
  }
  function setSelecting(on) {
    selecting = on;
    if (!on) selected.clear();
    $("list").classList.toggle("selecting", on);
    $("list-top").hidden = on; $("sel-top").hidden = !on; $("bulkbar").hidden = !on;
    renderList();
  }
  function listStatus(msg, err) {
    const t = $("list-status");
    t.textContent = msg; t.classList.toggle("err", !!err); t.hidden = !msg;
    clearTimeout(listStatus.t);
    if (msg && !err) listStatus.t = setTimeout(() => { t.hidden = true; }, 6000);
  }
  // Selected ids in main page order (the order used when adding to a collection).
  const selIds = () => ordered().map((p) => p.id).filter((id) => selected.has(id));
  async function bulkSave(op, from) {
    const ids = selIds();
    try {
      await commit((d) => ({ next: M.applyBulk(d, ids, op, clean), message: M.describeBulk(ids, op) }));
      setSelecting(false); show("list");
      listStatus(`Saved for ${ids.length} photo${ids.length === 1 ? "" : "s"} · on the site in ~5 min`);
      return true;
    } catch (err) {
      if (from) show(from); else show("list");
      listStatus(err.message || "Couldn't save. Try again.", true);
      return false;
    }
  }
  $("sel-start").addEventListener("click", () => { listStatus(""); setSelecting(true); });
  $("sel-cancel").addEventListener("click", () => setSelecting(false));
  $("sel-all").addEventListener("click", () => {
    const allOn = shown.every((p) => selected.has(p.id));
    for (const p of shown) { if (allOn) selected.delete(p.id); else selected.add(p.id); }
    renderList();
  });

  // Tags: each library tag shows whether all, some or none of the selected
  // photos have it; tapping sets it on all of them, or (if all have it) removes it.
  let btWant = new Map(); // tag -> "add" | "remove"
  function btState(t) {
    const w = btWant.get(t);
    if (w) return w === "add" ? "all" : "none";
    const ids = selIds(), n = ids.filter((id) => (doc.photo_tags[id] || []).includes(t)).length;
    return n === 0 ? "none" : n === ids.length ? "all" : "some";
  }
  function renderBulkTags() {
    const ids = selIds(), ul = $("bt-rows"); ul.textContent = "";
    $("bt-h").textContent = `Tags · ${ids.length} photo${ids.length === 1 ? "" : "s"}`;
    $("bt-hint").textContent = "Tap a tag to add it to all selected photos; tap again to remove it from all.";
    const names = doc.tags.concat([...btWant.keys()].filter((t) => !doc.tags.includes(t)));
    if (!names.length) ul.appendChild(el("li", "head mono", "No tags yet. Add one above."));
    for (const t of names.sort((a, b) => a.localeCompare(b))) {
      const st = btState(t), li = el("li", "staterow"), b = el("button");
      b.type = "button";
      b.setAttribute("aria-pressed", st === "all" ? "true" : st === "some" ? "mixed" : "false");
      const n = ids.filter((id) => (doc.photo_tags[id] || []).includes(t)).length;
      b.append(el("span", "state " + st, st === "all" ? "✓" : st === "some" ? "–" : ""), el("span", "", t),
        el("span", "sub mono", btWant.has(t) ? (btWant.get(t) === "add" ? "will add" : "will remove") : n ? `${n} of ${ids.length}` : ""));
      b.addEventListener("click", () => {
        const now = btState(t);
        const orig = n === 0 ? "none" : n === ids.length ? "all" : "some";
        const next = now === "all" ? "none" : "all";
        if (next === orig && orig !== "some") btWant.delete(t); else btWant.set(t, next === "all" ? "add" : "remove");
        renderBulkTags();
      });
      li.appendChild(b); ul.appendChild(li);
    }
    $("bt-apply").disabled = !btWant.size;
    $("bt-status").textContent = btWant.size ? `${btWant.size} change${btWant.size === 1 ? "" : "s"}` : "";
  }
  $("bulk-tags").addEventListener("click", () => { btWant = new Map(); $("bt-new").value = ""; renderBulkTags(); show("bulktags"); });
  $("bt-cancel").addEventListener("click", () => show("list"));
  $("bt-new-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const n = Meta.cleanTag($("bt-new").value);
    if (!n) return;
    btWant.set(M.findTag(doc, n) || n, "add");
    $("bt-new").value = "";
    renderBulkTags();
  });
  $("bt-apply").addEventListener("click", async () => {
    const addTags = [...btWant].filter(([, w]) => w === "add").map(([t]) => t);
    const removeTags = [...btWant].filter(([, w]) => w === "remove").map(([t]) => t);
    $("bt-apply").disabled = true; $("bt-status").textContent = "Saving…";
    if (!await bulkSave({ addTags, removeTags }, "bulktags")) { $("bt-apply").disabled = false; $("bt-status").textContent = ""; }
  });

  // Collection: move all selected photos into one (or out of any).
  function renderBulkColl() {
    const ids = selIds(), ul = $("bc-rows"); ul.textContent = "";
    $("bc-h").textContent = `Collection · ${ids.length} photo${ids.length === 1 ? "" : "s"}`;
    $("bc-hint").textContent = "Photos already in the collection keep their place; the others are added at the end, in Work page order. A photo can be in one collection.";
    $("bc-status").textContent = "";
    const row = (label, sub, name) => {
      const li = el("li"), b = el("button"); b.type = "button";
      b.append(el("span", "", label), el("span", "sub mono", sub));
      b.addEventListener("click", () => { $("bc-status").textContent = "Saving…"; bulkSave({ collection: name }, "bulkcoll"); });
      li.appendChild(b); ul.appendChild(li);
    };
    for (const c of doc.collections) {
      const inIt = ids.filter((id) => c.photos.includes(id)).length;
      row(c.name, `${c.photos.length} photo${c.photos.length === 1 ? "" : "s"}` + (inIt ? ` · ${inIt} selected already in it` : ""), c.name);
    }
    row("No collection", "Take the selected photos out of their collections", "");
  }
  $("bulk-coll").addEventListener("click", () => { $("bc-new").value = ""; renderBulkColl(); show("bulkcoll"); });
  $("bc-cancel").addEventListener("click", () => show("list"));
  $("bc-new-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const n = M.cleanName($("bc-new").value, clean);
    if (!n) { $("bc-status").textContent = "Name the new collection."; return; }
    $("bc-status").textContent = "Saving…";
    bulkSave({ collection: n }, "bulkcoll");
  });

  // Location: the same place picker, applied to all selected photos.
  // Star all selected; if they're all starred already, un-star them.
  $("bulk-high").addEventListener("click", () => {
    const on = ![...selected].every((id) => doc.highlights.includes(id));
    listStatus("Saving…"); bulkSave({ highlight: on }, "list");
  });
  // Put all selected on the Work page; if they're all on it already, take them off.
  $("bulk-work").addEventListener("click", () => {
    const byId = new Map(all.map((p) => [p.id, p]));
    const on = ![...selected].every((id) => byId.get(id) && M.onWork(doc, byId.get(id)));
    listStatus("Saving…"); bulkSave({ work: on }, "list");
  });
  $("bulk-show").addEventListener("click", () => { listStatus("Saving…"); bulkSave({ shown: true }, "list"); });
  $("bulk-hide").addEventListener("click", () => { listStatus("Saving…"); bulkSave({ shown: false }, "list"); });
  $("bulk-place").addEventListener("click", () => {
    const n = selected.size;
    picker.open((pl) => bulkSave({ place: pl }, "list"), "list", `Location · ${n} photo${n === 1 ? "" : "s"}`);
  });

  // ---------------- undo ----------------
  // After each save, an Undo bar for 20 s. Undo writes back exactly what the
  // save replaced, but only if the data is still what that save wrote.
  let undoTimer = 0;
  function undoBar(msg, withButton, err) {
    clearTimeout(undoTimer);
    $("undo-msg").textContent = msg;
    $("undo-btn").hidden = !withButton;
    $("undo").classList.toggle("err", !!err);
    $("undo").hidden = false;
    undoTimer = setTimeout(() => { $("undo").hidden = true; }, err ? 8000 : withButton ? 8000 : 3000);
  }
  function offerUndo(message) {
    $("undo").title = message;  // the full change, for a long press / hover
    undoBar("Saved ·", true);
  }
  // Any tap outside the pill dismisses it (the change stays saved).
  document.addEventListener("pointerdown", (e) => {
    if (!$("undo").hidden && !$("undo").contains(e.target) && !$("undo").classList.contains("err")) {
      clearTimeout(undoTimer); $("undo").hidden = true;
    }
  }, true);
  function refreshScreen() {
    if (!$("detail").hidden && shown[current]) openDetail(shown[current].id);
    else if (!$("tagscreen").hidden) renderTagScreen();
    else if (!$("list").hidden) renderList();
  }
  $("undo-btn").addEventListener("click", async () => {
    const ch = lastChange;
    if (!ch) return;
    $("undo-btn").disabled = true; $("undo-msg").textContent = "Undoing…";
    try {
      await commit((d) => {
        if (!M.sameDoc(d, ch.after)) throw new GhError("The data changed since that save, so nothing was undone.", 0);
        return { next: ch.before, message: `Undo: ${ch.message}` };
      }, true);
      undoBar("Undone", false);
      refreshScreen();
    } catch (err) { undoBar(err.message || "Couldn't undo. Try again.", false, true); }
    finally { $("undo-btn").disabled = false; }
  });

  // ---------------- reorder ----------------
  // Main page: the photos shown on the site, in their order (hidden ones keep
  // their places). With a collection's filter on: that collection's order.
  // With the ★ filter on: the highlights' order (home page and slideshow).
  let roMode = null; // { kind: "main" } | { kind: "coll", name } | { kind: "high" }
  function roNumber() {
    const tiles = [...$("ro-grid").children];
    tiles.forEach((t, i) => {
      t.querySelector(".num").textContent = String(i + 1);
      t.querySelector(".prev").disabled = i === 0;
      t.querySelector(".next").disabled = i === tiles.length - 1;
      t.classList.toggle("moved", t.dataset.start !== String(i));
    });
    $("ro-save").disabled = !tiles.some((t, i) => t.dataset.start !== String(i));
  }
  function roOpen() {
    const c = filter[0] === "c" ? doc.collections[Number(filter.slice(1))] : null;
    const high = filter === "high";
    roMode = c ? { kind: "coll", name: c.name } : high ? { kind: "high" } : { kind: "main" };
    const byId = new Map(all.map((p) => [p.id, p]));
    const list = c ? c.photos.map((id) => byId.get(id)).filter(Boolean)
      : high ? doc.highlights.map((id) => byId.get(id)).filter(Boolean)
      : ordered().filter((p) => M.isShown(doc, p) && M.onWork(doc, p));
    $("ro-h").textContent = c ? c.name : high ? "★ Highlights" : "Work page";
    $("ro-hint").textContent = (c ? `Order of this collection (${list.length}). `
      : high ? `Order of the ${list.length} highlights on the Home page and in its slideshow. `
      : `Order on the Work page: the ${list.length} photos on it. Hidden photos and ones not on Work keep their places. `)
      + "Drag a photo by ⠿, or nudge it with ‹ ›. Tap photos to select several and move them together. Then Save.";
    roSel.clear(); roSelUpdate();
    const grid = $("ro-grid"); grid.textContent = "";
    list.forEach((p, i) => {
      const li = el("li", "rtile"); li.dataset.id = p.id; li.dataset.start = String(i);
      const img = new Image(); img.loading = "lazy"; img.decoding = "async"; img.draggable = false; img.alt = doc.titles[p.id] || "";
      img.src = thumb(p, 180);
      const frame = el("span", "frame"); frame.appendChild(img);
      frame.addEventListener("click", () => { if (roSel.has(li)) roSel.delete(li); else roSel.add(li); roSelUpdate(); });
      li.dataset.taken = p.taken || ""; li.dataset.added = p.added || "";
      const ctl = el("div", "rctl");
      const prev = el("button", "prev", "‹"), next = el("button", "next", "›"), handle = el("button", "handle", "⠿");
      prev.type = next.type = handle.type = "button";
      prev.setAttribute("aria-label", "Move earlier"); next.setAttribute("aria-label", "Move later"); handle.setAttribute("aria-label", "Drag to move");
      prev.addEventListener("click", () => { if (li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling); roNumber(); });
      next.addEventListener("click", () => { if (li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li); roNumber(); });
      handle.addEventListener("pointerdown", (e) => roDrag(e, li));
      ctl.append(el("span", "num mono", ""), prev, handle, next);
      li.append(frame, el("span", "cap" + (doc.titles[p.id] ? "" : " untitled"), doc.titles[p.id] || monthYear(p.taken)), ctl);
      grid.appendChild(li);
    });
    roNumber();
    show("reorder"); scrollTo(0, 0);
  }
  // Long lists: sort by date taken, select several and move them together,
  // and a compact view with many more tiles per screen.
  const roSel = new Set();
  function roSelUpdate() {
    for (const t of $("ro-grid").children) t.classList.toggle("sel", roSel.has(t));
    $("ro-sel").hidden = !roSel.size;
    $("ro-sel-count").textContent = `${roSel.size} selected`;
    $("ro-pos").max = $("ro-grid").children.length;
  }
  // Put the selected tiles (in their current order) at 0-based index `at`
  // among the others.
  function roMoveSelected(at) {
    const grid = $("ro-grid"), all = [...grid.children];
    const picked = all.filter((t) => roSel.has(t)), rest = all.filter((t) => !roSel.has(t));
    const i = Math.max(0, Math.min(at, rest.length));
    grid.append(...rest.slice(0, i), ...picked, ...rest.slice(i));
    roNumber();
    picked[0] && picked[0].scrollIntoView({ block: "center", behavior: "smooth" });
  }
  function roSort(newest) {
    const grid = $("ro-grid");
    const key = (t) => t.dataset.taken || t.dataset.added || "";
    const tiles = [...grid.children].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (newest ? -1 : 1));
    grid.append(...tiles);
    roNumber();
  }
  $("ro-oldest").addEventListener("click", () => roSort(false));
  $("ro-newest").addEventListener("click", () => roSort(true));
  $("ro-compact").addEventListener("click", () => {
    const on = !$("ro-grid").classList.contains("compact");
    $("ro-grid").classList.toggle("compact", on);
    $("ro-compact").setAttribute("aria-pressed", String(on));
    try { localStorage.setItem("at-ro-compact", on ? "1" : ""); } catch { /* ignore */ }
  });
  try { if (localStorage.getItem("at-ro-compact") === "1") { $("ro-grid").classList.add("compact"); $("ro-compact").setAttribute("aria-pressed", "true"); } } catch { /* ignore */ }
  $("ro-to-start").addEventListener("click", () => roMoveSelected(0));
  $("ro-to-end").addEventListener("click", () => roMoveSelected(Infinity));
  $("ro-to-pos").addEventListener("click", () => {
    const n = Math.round(Number($("ro-pos").value));
    if (!Number.isFinite(n) || n < 1) { $("ro-pos").focus(); return; }
    roMoveSelected(n - 1);
    $("ro-pos").value = "";
  });
  $("ro-sel-clear").addEventListener("click", () => { roSel.clear(); roSelUpdate(); });

  // Drag: the tile jumps into place as the finger passes over other tiles;
  // the page scrolls when the finger nears the top or bottom.
  function roDrag(e, li) {
    e.preventDefault();
    const grid = $("ro-grid");
    li.classList.add("dragging");
    let y = e.clientY, x = e.clientX, raf = 0;
    const scroll = () => {
      const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top-h")) || 70) + 40;
      if (y < top) scrollBy(0, -12); else if (y > innerHeight - 50) scrollBy(0, 12);
      raf = requestAnimationFrame(scroll);
    };
    raf = requestAnimationFrame(scroll);
    const move = (ev) => {
      x = ev.clientX; y = ev.clientY;
      const over = document.elementFromPoint(x, y);
      const t = over && over.closest(".rtile");
      if (!t || t === li || t.parentNode !== grid) return;
      const tiles = [...grid.children];
      if (tiles.indexOf(t) > tiles.indexOf(li)) grid.insertBefore(li, t.nextElementSibling); else grid.insertBefore(li, t);
      roNumber();
    };
    const up = () => {
      cancelAnimationFrame(raf);
      li.classList.remove("dragging");
      removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up);
      roNumber();
    };
    addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  }
  $("ro-start").addEventListener("click", () => { listStatus(""); roOpen(); });
  $("ro-cancel").addEventListener("click", () => {
    if (!$("ro-save").disabled && !confirm("Discard the new order?")) return;
    show("list"); renderList();
  });
  $("ro-save").addEventListener("click", async () => {
    const ids = [...$("ro-grid").children].map((t) => t.dataset.id);
    const mode = roMode;
    $("ro-save").disabled = true; $("ro-save").textContent = "Saving…";
    try {
      await commit((d) => {
        if (mode.kind === "coll") return { next: M.reorderCollection(d, mode.name, ids), message: `Reorder collection "${mode.name}"` };
        if (mode.kind === "high") return { next: M.reorderHighlights(d, ids), message: `Reorder highlights (${ids.length} photos)` };
        const orderedIds = M.orderPhotos(all, d.order).map((p) => p.id);
        return { next: M.reorderMain(d, orderedIds, ids), message: `Reorder Work page (${ids.length} photos)` };
      });
      show("list"); renderList();
      listStatus("New order saved · on the site in ~5 min");
    } catch (err) { $("ro-save").disabled = false; alert(err.message || "Couldn't save. Try again."); }
    finally { $("ro-save").textContent = "Save"; }
  });

  // ---------------- tag library ----------------
  function tagStatus(msg, err) { const s = $("tags-status"); s.textContent = msg; s.classList.toggle("err", !!err); }
  async function libraryEdit(fn, message) {
    tagStatus("Saving…");
    try {
      await commit((d) => ({ next: fn(d), message }));
      tagStatus("Saved");
    } catch (err) { tagStatus(err.message || "Couldn't save. Try again.", true); }
    renderTagScreen();
  }
  function renderTagScreen() {
    const ul = $("tag-rows"); ul.textContent = "";
    const counts = M.tagCounts(doc, all.map((p) => p.id));
    if (!doc.tags.length) ul.appendChild(el("li", "head mono", "No tags yet. Add one above, or from a photo."));
    for (const t of [...doc.tags].sort((a, b) => a.localeCompare(b))) {
      const li = el("li", "tagrow");
      const rename = el("button", "btn ghost small", "Rename"), del = el("button", "btn ghost small", "Delete");
      rename.type = del.type = "button";
      rename.addEventListener("click", () => {
        const to = prompt(`Rename “${t}” to:`, t);
        if (to == null) return;
        const n = Meta.cleanTag(to);
        if (!n || n === t) return;
        const target = M.findTag(doc, n);
        if (target && target !== t && !confirm(`“${target}” already exists. Merge “${t}” into it?`)) return;
        libraryEdit((d) => M.renameTag(d, t, n), target && target !== t ? `Tags: merge "${t}" into "${target}"` : `Tags: rename "${t}" to "${n}"`);
      });
      del.addEventListener("click", () => {
        if (!confirm(`Delete “${t}”? It's removed from ${counts[t] || 0} photo${counts[t] === 1 ? "" : "s"}.`)) return;
        libraryEdit((d) => M.deleteTag(d, t), `Tags: delete "${t}"`);
      });
      li.append(el("span", "name", t), el("span", "n mono", String(counts[t] || 0)), rename, del);
      ul.appendChild(li);
    }
  }
  $("tag-new-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const n = Meta.cleanTag($("tag-new").value);
    if (!n) return;
    if (M.findTag(doc, n)) { tagStatus(`“${M.findTag(doc, n)}” already exists.`, true); return; }
    $("tag-new").value = "";
    libraryEdit((d) => M.addTag(d, n), `Tags: add "${n}"`);
  });
  $("open-tags").addEventListener("click", () => { location.hash = "#tags"; });
  $("tags-back").addEventListener("click", () => { location.hash = ""; });
  let qt;
  $("list-search").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(() => { query = $("list-search").value.trim(); renderList(); }, 120); });

  // ---------------- routing ----------------
  function route() {
    const m = location.hash.match(/^#p\/(.+)$/);
    if (m) openDetail(decodeURIComponent(m[1]));
    else if (location.hash === "#tags") { tagStatus(""); renderTagScreen(); show("tagscreen"); }
    else { renderList(); show("list"); }
    if (m && selecting) setSelecting(false);
  }
  addEventListener("hashchange", () => { if (!locked && getKey() && all.length) route(); });

  // ---------------- setup & settings ----------------
  function openSetup(replacing) {
    $("setup-key").value = ""; $("setup-err").textContent = "";
    const exp = store.get(EXP) || "";
    $("setup-noexp").checked = exp === "never";
    $("setup-exp").value = exp && exp !== "never" ? exp : "";
    $("setup-exp").disabled = $("setup-noexp").checked;
    $("setup-cancel").hidden = !replacing;
    $("setup-faceid-wrap").hidden = !lockAvailable || L.enabled();
    show("setup");
    $("setup-key").focus();
  }
  $("setup-noexp").addEventListener("change", () => { $("setup-exp").disabled = $("setup-noexp").checked; });
  $("setup-cancel").addEventListener("click", () => route());
  $("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const k = $("setup-key").value.trim(), err = $("setup-err");
    const exp = $("setup-noexp").checked ? "never" : $("setup-exp").value;
    if (!k) { err.textContent = "Paste the key first."; return; }
    if (!exp) { err.textContent = "Enter the expiry date, or tick “No expiration”."; return; }
    // Face ID first: Safari only shows its prompt right after a tap.
    const wasLocked = L.enabled(), oldLock = wasLocked ? localStorage.getItem("at-lock") : null;
    const newLock = !wasLocked && lockAvailable && $("setup-faceid").checked;
    try {
      if (wasLocked && L.mode() === "prf") { err.textContent = "Confirm with Face ID…"; await L.rekey(bundle(k)); }
      else if (newLock) { err.textContent = "Set up Face ID…"; await L.enable(bundle(k)); }
    } catch (e2) {
      err.textContent = `Face ID didn't finish (${e2.name === "NotAllowedError" ? "cancelled" : e2.message || e2.name}). Try again${newLock ? ", or untick “Lock the editor with Face ID”" : ""}.`;
      return;
    }
    const undo = () => { if (newLock) L.disable(); else if (oldLock) localStorage.setItem("at-lock", oldLock); };
    err.textContent = "Checking…";
    try {
      const r = await fetch(api(""), { headers: headers(k), cache: "no-store" });
      if (!r.ok) { undo(); err.textContent = r.status === 401 ? "GitHub didn't accept that key." : "That key can't see the photo data repository."; return; }
      const j = await r.json();
      if (!j.permissions || !j.permissions.push) { undo(); err.textContent = "That key can read but not save. It needs Contents: read and write."; return; }
    } catch { undo(); err.textContent = "Couldn't reach GitHub. Check your connection and try again."; return; }
    mem.exp = exp; store.set(EXP, exp);
    if (L.mode() === "prf") { store.del(KEY); store.del(PUB); } else store.set(KEY, k); // prf: only the encrypted copy stays on the device
    mem.key = k;
    await loadDoc();
  });
  function fillLockSettings() {
    const mode = L.mode();
    $("s-lock").textContent = mode === "prf" ? "On" : mode === "gate" ? "On (app only)" : lockAvailable ? "Off" : "Not available";
    $("s-lock-note").textContent = mode === "prf" ? "Face ID opens the editor, and your key is stored encrypted: it can't be read from this device without Face ID."
      : mode === "gate" ? "Face ID opens the editor. This device can't use Face ID to encrypt the key, so it's stored as before."
      : lockAvailable ? "Turn on to require Face ID whenever the editor opens (and after 5 minutes away)." : "This device or browser doesn't offer Face ID / passkeys to websites.";
    $("s-lock-btn").textContent = mode ? "Turn off Face ID" : "Turn on Face ID";
    $("s-lock-btn").hidden = !mode && !lockAvailable;
    $("s-err").textContent = "";
  }
  function fillPubSettings(msg, isErr) {
    const has = !!getPub();
    $("s-pub").textContent = !siteRepo ? "Published site only" : has ? "Set" : "Not set";
    $("s-site-repo").textContent = siteRepo || "the site repository";
    $("s-pub-form").hidden = !siteRepo;
    $("s-pub-in").placeholder = has ? "Paste a new publish key to replace it" : "github_pat_… (publish key)";
    $("s-pub-del").hidden = !has;
    if (msg !== undefined) { $("s-err").textContent = msg; $("s-err").classList.toggle("ok", !isErr); }
  }
  $("s-pub-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = $("s-pub-in").value.trim();
    if (!p) { fillPubSettings("Paste the publish key first.", true); return; }
    // Face ID first (Safari needs it right after the tap); undone if the key fails.
    const oldLock = L.enabled() ? localStorage.getItem("at-lock") : null;
    try { if (L.mode() === "prf") { fillPubSettings("Confirm with Face ID…"); await L.rekey(bundle(getKey(), p)); } }
    catch (e2) { fillPubSettings(`Face ID didn't finish (${e2.name === "NotAllowedError" ? "cancelled" : e2.message || e2.name}).`, true); return; }
    const undo = () => { if (oldLock) localStorage.setItem("at-lock", oldLock); };
    fillPubSettings("Checking…");
    try {
      const r = await ghPub("/actions/workflows/deploy.yml", {}, p);
      if (!r.ok) { undo(); fillPubSettings(r.status === 401 ? "GitHub didn't accept that key." : "That key can't see the site's builds. It needs Actions: read and write on " + siteRepo + ".", true); return; }
    } catch { undo(); fillPubSettings("Couldn't reach GitHub. Check your connection and try again.", true); return; }
    mem.pub = p;
    if (L.mode() !== "prf") store.set(PUB, p);
    $("s-pub-in").value = "";
    fillPubSettings("Publish key saved.");
    pubPoll();
  });
  $("s-pub-del").addEventListener("click", async () => {
    if (!confirm("Remove the publish key from this device?")) return;
    if (L.mode() === "prf") {
      try { await L.rekey(bundle(getKey(), "")); } catch (e2) { fillPubSettings(`Face ID didn't finish (${e2.message || e2.name}).`, true); return; }
    }
    store.del(PUB); mem.pub = "";
    fillPubSettings("Publish key removed.");
  });
  $("open-settings").addEventListener("click", () => {
    $("s-repo").textContent = repo;
    $("s-exp").textContent = expiryInfo().text;
    fillLockSettings();
    fillPubSettings("");
    show("settings");
  });
  $("s-lock-btn").addEventListener("click", async () => {
    const k = getKey();
    if (!k) return;
    if (L.enabled()) {
      if (!confirm("Turn off the Face ID lock? Your key stays on this device, unencrypted.")) return;
      store.set(KEY, k); if (getPub()) store.set(PUB, getPub()); L.disable();
    } else {
      try {
        $("s-err").textContent = "Set up Face ID…";
        if (await L.enable(bundle()) === "prf") { store.del(KEY); store.del(PUB); }
      } catch (e) { fillLockSettings(); $("s-err").textContent = `Face ID wasn't set up (${e.message || e.name}).`; return; }
    }
    fillLockSettings();
  });
  $("s-close").addEventListener("click", () => route());
  $("s-replace").addEventListener("click", () => openSetup(true));
  $("s-forget").addEventListener("click", () => {
    if (!confirm("Forget the key on this device? You'll need to paste it again to edit.")) return;
    store.del(KEY); store.del(EXP); store.del(PUB); mem.key = mem.exp = mem.pub = ""; L.disable();
    openSetup(false);
  });

  // ---------------- Face ID lock ----------------
  // See lock.js. Locks on open and after 5 minutes in the background.
  const L = window.EditLock, RELOCK_MS = 5 * 60 * 1000;
  let lockAvailable = false, locked = false, hiddenAt = 0;
  function showLock() {
    locked = true;
    if (L.mode() === "prf") mem.key = mem.pub = ""; // decrypted keys only live in memory while unlocked
    $("lock-err").textContent = "";
    show("lock");
    $("lock-open").focus();
  }
  $("lock-open").addEventListener("click", async () => {
    $("lock-err").textContent = "";
    $("lock-open").disabled = true;
    try {
      applyBundle(await L.unlock());
      if (!getKey()) throw new Error("No key on this device. Use the link below to connect again.");
      locked = false;
      if (doc && sha !== undefined && all.length) route(); else await loadDoc();
    } catch (err) {
      $("lock-err").textContent = err.name === "NotAllowedError" ? "Face ID was cancelled or didn't match. Try again." : (err.message || "Couldn't unlock.");
    } finally { $("lock-open").disabled = false; }
  });
  $("lock-reset").addEventListener("click", () => {
    if (!confirm("Forget the key and the Face ID lock on this device? You'll paste the key again to edit.")) return;
    L.disable(); store.del(KEY); store.del(PUB); mem.key = mem.pub = ""; locked = false;
    openSetup(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (!L.enabled()) return;
    if (document.hidden) hiddenAt = Date.now();
    else if (!locked && hiddenAt && Date.now() - hiddenAt > RELOCK_MS) showLock();
  });

  // ---------------- updates ----------------
  // Each build stamps its version into this page and version.json. If a newer
  // build is live, reload (only when nothing unsaved is open), so the app
  // doesn't run an old copy for up to 10 minutes after a change.
  const myVersion = (document.querySelector('meta[name="app-version"]') || {}).content || "";
  let newVersion = "";
  async function checkUpdate() {
    if (!myVersion) return;
    try {
      const j = await (await fetch("../version.json", { cache: "no-store" })).json();
      if (typeof j.v === "string" && j.v && j.v !== myVersion) { newVersion = j.v; maybeReload(); }
    } catch { /* offline: try again later */ }
  }
  function maybeReload() {
    if (!newVersion) return;
    let tried = null;
    try { tried = sessionStorage.getItem("at-reloaded-for"); } catch { /* ignore */ }
    if (tried === newVersion) return; // reloaded once for it already: don't loop
    const busy = (!$("detail").hidden && dirty()) || ["setup", "bulktags", "bulkcoll", "picker", "settings"].some((id) => !$(id).hidden);
    if (busy) return;
    try { sessionStorage.setItem("at-reloaded-for", newVersion); } catch { /* ignore */ }
    location.reload();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });
  addEventListener("hashchange", maybeReload);
  checkUpdate();

  // ---------------- boot ----------------
  async function loadDoc() {
    $("boot").textContent = "Loading…"; show("boot");
    try {
      ({ doc, sha } = await readDoc());
      route();
      pubPoll(); // show "Site updated …" or a build in progress
    } catch (err) {
      if (err.status === 401 || err.status === 403 || err.status === 404) { openSetup(false); $("setup-err").textContent = err.message; }
      else { $("boot").textContent = (err.message || "Couldn't reach GitHub.") + " Tap to retry."; $("boot").onclick = () => { $("boot").onclick = null; loadDoc(); }; }
    }
  }

  Promise.all([
    fetch("../config.json", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
    fetch("../photos.json", { cache: "no-store" }).then((r) => r.json()).catch(() => []),
  ]).then(([cfg, list]) => {
    repo = typeof cfg.data_repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(cfg.data_repo) ? cfg.data_repo : "";
    siteRepo = typeof cfg.site_repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(cfg.site_repo) ? cfg.site_repo : "";
    builtAt = typeof cfg.built_at === "string" ? cfg.built_at : "";
    $("pubbar").hidden = $("pub-now").hidden = !siteRepo;
    all = Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && Array.isArray(p.src) && p.src.length) : [];
    $("setup-repo").textContent = repo || "the photo data repository";
    if (!repo) { $("boot").textContent = "The editor works on the published site only."; return; }
    L.available().then((ok) => {
      lockAvailable = ok;
      if (L.enabled()) showLock();
      else if (!getKey()) openSetup(false);
      else loadDoc();
    });
  });
})();
