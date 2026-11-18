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

  async function save(change) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await readDoc();
      const mainIds = M.orderPhotos(all, cur.doc.order).map((p) => p.id);
      const next = M.applyChange(cur.doc, { ...change, mainIds }, clean);
      const body = { message: M.describe(cur.doc, next, change.id), content: b64enc(M.serialize(next)), branch: "main", ...(cur.sha ? { sha: cur.sha } : {}) };
      const w = await fetch(api("/contents/curation.json"), { method: "PUT", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (w.ok) { const j = await w.json().catch(() => ({})); doc = next; sha = j.content && j.content.sha; return; }
      if ((w.status === 409 || w.status === 422) && attempt === 0) continue; // changed underneath us: re-read once
      throw new GhError(why(w.status), w.status);
    }
  }

  // ---------------- helpers ----------------
  const fmtDate = (iso, opts) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString("en-US", opts) : "—"; };
  const monthYear = (iso) => fmtDate(iso, { month: "short", year: "numeric" });
  const longDate = (iso) => fmtDate(iso, { day: "numeric", month: "short", year: "numeric" });
  const thumb = (p, cssW) => {
    const need = cssW * Math.min(window.devicePixelRatio || 1, 3);
    return "../" + (p.src.find((s) => s.w >= need) || p.src[p.src.length - 1]).url;
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ordered = () => M.orderPhotos(all, doc.order);
  function show(id) { for (const s of ["setup", "list", "detail", "settings", "boot"]) $(s).hidden = s !== id; }

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
    const out = [["all", `All ${all.length}`], ["untitled", `Untitled ${untitled}`], ["high", `★ ${doc.highlights.filter((id) => all.some((p) => p.id === id)).length}`], ["none", `No collection ${loose}`]];
    doc.collections.forEach((c, i) => out.push(["c" + i, `${c.name} ${c.photos.filter((id) => all.some((p) => p.id === id)).length}`]));
    return out;
  }
  function photosFor(f) {
    const list = ordered();
    if (f === "untitled") return list.filter((p) => !doc.titles[p.id]);
    if (f === "high") return list.filter((p) => doc.highlights.includes(p.id));
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
      const a = el("a", "tile"); a.href = "#p/" + encodeURIComponent(p.id);
      const img = new Image(); img.loading = "lazy"; img.decoding = "async"; img.draggable = false; img.alt = "";
      img.src = thumb(p, 180); img.width = p.w; img.height = p.h;
      const frame = el("span", "frame"); frame.appendChild(img);
      const title = doc.titles[p.id];
      const cap = el("span", "cap" + (title ? "" : " untitled"), title || monthYear(p.taken));
      const c = M.collectionOf(doc, p.id);
      const star = doc.highlights.includes(p.id);
      const meta = el("span", "meta mono" + (star ? " high" : ""), (star ? "★ " : "") + (c ? `${c.name} · ${c.pos}` : star ? "" : "—"));
      a.append(frame, cap, meta);
      a.setAttribute("aria-label", (title || "Untitled photo") + (c ? `, ${c.name} number ${c.pos}` : "") + (star ? ", highlighted" : ""));
      grid.appendChild(a);
    });
    $("list-empty").hidden = shown.length > 0;
    banner();
  }

  // ---------------- detail ----------------
  const NEW = " new"; // never a real name: names are trimmed
  let base = null; // field values when the photo was opened, to detect changes
  function values() {
    const coll = $("f-coll").value === NEW ? M.cleanName($("f-newcoll").value, clean) : $("f-coll").value;
    return { title: clean($("f-title").value), collection: coll, cpos: $("f-cpos").value, high: $("f-high").checked, mpos: $("f-mpos").value };
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
    if (!shown.some((p) => p.id === id)) { filter = "all"; shown = photosFor("all"); }
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
    const list = ordered();
    $("f-mpos").value = list.findIndex((x) => x.id === p.id) + 1;
    $("f-mpos").max = list.length;
    $("f-mpos-of").textContent = `of ${list.length}`;
    $("f-taken").textContent = longDate(p.taken);
    $("f-added").textContent = longDate(p.added);
    const loc = $("f-loc");
    loc.textContent = p.located ? "✓ Kept" : "✗ None";
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
    if (String(v.mpos) !== String(base.mpos)) {
      const n = Math.round(Number(v.mpos));
      if (!Number.isFinite(n) || n < 1 || n > all.length) { status(`Main page No. must be 1–${all.length}.`, true); return; }
      change.mainPos = n;
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

  // ---------------- routing ----------------
  function route() {
    const m = location.hash.match(/^#p\/(.+)$/);
    if (m) openDetail(decodeURIComponent(m[1]));
    else { renderList(); show("list"); }
  }
  addEventListener("hashchange", () => { if (getKey() && all.length) route(); });

  // ---------------- setup & settings ----------------
  function openSetup(replacing) {
    $("setup-key").value = ""; $("setup-err").textContent = "";
    const exp = store.get(EXP) || "";
    $("setup-noexp").checked = exp === "never";
    $("setup-exp").value = exp && exp !== "never" ? exp : "";
    $("setup-exp").disabled = $("setup-noexp").checked;
    $("setup-cancel").hidden = !replacing;
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
    err.textContent = "Checking…";
    try {
      const r = await fetch(api(""), { headers: headers(k), cache: "no-store" });
      if (!r.ok) { err.textContent = r.status === 401 ? "GitHub didn't accept that key." : "That key can't see the photo data repository."; return; }
      const j = await r.json();
      if (!j.permissions || !j.permissions.push) { err.textContent = "That key can read but not save. It needs Contents: read and write."; return; }
    } catch { err.textContent = "Couldn't reach GitHub. Check your connection and try again."; return; }
    mem.key = k; mem.exp = exp; store.set(KEY, k); store.set(EXP, exp);
    await loadDoc();
  });
  $("open-settings").addEventListener("click", () => {
    $("s-repo").textContent = repo;
    $("s-exp").textContent = expiryInfo().text;
    show("settings");
  });
  $("s-close").addEventListener("click", () => route());
  $("s-replace").addEventListener("click", () => openSetup(true));
  $("s-forget").addEventListener("click", () => {
    if (!confirm("Forget the key on this device? You'll need to paste it again to edit.")) return;
    store.del(KEY); store.del(EXP); mem.key = mem.exp = "";
    openSetup(false);
  });

  // ---------------- boot ----------------
  async function loadDoc() {
    $("boot").textContent = "Loading…"; show("boot");
    try {
      ({ doc, sha } = await readDoc());
      route();
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
    all = Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && Array.isArray(p.src) && p.src.length) : [];
    $("setup-repo").textContent = repo || "the photo data repository";
    if (!repo) { $("boot").textContent = "The editor works on the published site only."; return; }
    if (!getKey()) openSetup(false); else loadDoc();
  });
})();
