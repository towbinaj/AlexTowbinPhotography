(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);
  const pad2 = (n) => String(n).padStart(2, "0");
  const monthYear = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "";
  };

  let photos = [];
  let view = "stream";

  // ---------------- images ----------------
  const srcset = (p) => p.src.map((s) => `${s.url} ${s.w}w`).join(", ");
  // Smallest rendition at least `cssWidth` CSS px wide on this screen.
  function bestSrc(p, cssWidth) {
    const need = cssWidth * Math.min(window.devicePixelRatio || 1, 2.5);
    return (p.src.find((s) => s.w >= need) || p.src[p.src.length - 1]).url;
  }
  function makeImg(p, sizes, eager) {
    const img = new Image();
    img.decoding = "async";
    img.draggable = false;
    if (!eager) img.loading = "lazy";
    img.alt = p.caption || "";
    img.width = p.w; img.height = p.h;
    img.sizes = sizes;
    img.srcset = srcset(p);
    img.src = p.src[Math.min(1, p.src.length - 1)].url;
    const done = () => img.classList.add("loaded");
    img.addEventListener("load", done, { once: true });
    if (img.complete && img.naturalWidth) done();
    return img;
  }

  // ---------------- chrome ----------------
  function applyConfig(cfg) {
    const name = cfg.name || (cfg.title || "Photography").replace(/\s+Photography$/i, "");
    $("bar-name").textContent = name;
    const r = cfg.rights || { holder: name, notice: `© ${new Date().getFullYear()} ${name}. All rights reserved.`, terms: "" };
    $("footer-notice").textContent = r.notice;
    $("rights-notice").textContent = r.notice;
    $("rights-terms").textContent = r.terms;
    $("lb-credit").textContent = `© ${r.holder}`;
    if (cfg.built) $("footer-updated").textContent = "Updated " + monthYear(cfg.built + "T12:00:00Z");

    const h1 = $("hero-name");
    h1.setAttribute("aria-label", name);
    for (const word of name.split(/\s+/)) {
      const w = document.createElement("span"); w.className = "w"; w.setAttribute("aria-hidden", "true");
      const s = document.createElement("span"); s.textContent = word;
      w.appendChild(s); h1.appendChild(w);
    }
    $("hero-tag").textContent = cfg.tagline || "";

    if (cfg.instagram) {
      const handle = cfg.instagram.replace(/^@/, "");
      const url = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
      for (const a of [$("nav-insta"), $("marquee")]) { a.href = url; a.hidden = false; }
      const contact = $("rights-contact");
      contact.append("For licensing, prints, or permission to use an image, message ");
      const link = document.createElement("a");
      link.href = url; link.target = "_blank"; link.rel = "noopener"; link.textContent = "@" + handle;
      contact.append(link, " on Instagram.");
      contact.hidden = false;
      const track = $("marquee-track");
      const item = () => {
        const d = document.createElement("div"); d.className = "marquee-item";
        d.innerHTML = `<span>Follow along</span><span class="star">✦</span><em></em><span class="star">✦</span>`;
        d.querySelector("em").textContent = "@" + handle;
        return d;
      };
      for (let i = 0; i < 4; i++) track.appendChild(item()); // two identical halves → seamless loop
    } else {
      $("marquee").hidden = true;
    }

    if (cfg.about) {
      $("about-text").textContent = cfg.about;
      $("about").hidden = false;
      $("nav-about").hidden = false;
    }
  }

  // ---------------- hero slideshow ----------------
  function hero() {
    const media = $("hero-media");
    $("hero-count").textContent = `${pad2(photos.length)} photographs`;
    // Newest few first, then a random sample of the rest.
    const rest = photos.slice(3).sort(() => Math.random() - 0.5);
    const picks = photos.slice(0, 3).concat(rest).slice(0, 6);
    const slides = picks.map((p, i) => {
      const s = document.createElement("div"); s.className = "slide";
      s.appendChild(makeImg(p, "(max-width: 860px) 100vw, 45vw", i === 0));
      s.addEventListener("click", () => openPhoto(photos.indexOf(p), s.firstChild));
      s.style.cursor = "zoom-in";
      media.insertBefore(s, $("hero-index"));
      return s;
    });
    let cur = 0;
    const show = (i) => {
      slides.forEach((s) => s.classList.remove("was"));
      slides[cur].classList.replace("on", "was");
      cur = i;
      slides[cur].classList.add("on");
      $("hero-index").textContent = `${pad2(cur + 1)} — ${pad2(slides.length)}`;
    };
    slides[0].classList.add("on");
    $("hero-index").textContent = `01 — ${pad2(slides.length)}`;
    if (slides.length > 1 && !reduceMotion) {
      setInterval(() => { if (!document.hidden && $("lightbox").hidden) show((cur + 1) % slides.length); }, 5200);
    }
  }

  // ---------------- masonry ----------------
  const masonry = $("masonry");
  const tiles = [];
  let cols = [];

  function columnCount() {
    const w = masonry.clientWidth;
    if (view === "grid") return w >= 1400 ? 6 : w >= 1000 ? 5 : w >= 640 ? 4 : 3;
    return w >= 1050 ? 3 : w >= 600 ? 2 : 1;
  }

  function buildTiles() {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -6% 0px" });
    photos.forEach((p, i) => {
      const a = document.createElement("a");
      a.className = "ph";
      a.href = `#photo-${p.id}`;
      a.setAttribute("aria-label", p.caption ? `Open: ${p.caption}` : `Open photo ${i + 1}`);
      const frame = document.createElement("div");
      frame.className = "frame";
      frame.style.backgroundImage = `url("${p.lqip}")`;
      frame.style.aspectRatio = `${p.w} / ${p.h}`;
      frame.appendChild(makeImg(p, "33vw", false));
      const meta = document.createElement("div");
      meta.className = "meta mono";
      const cap = document.createElement("span"); cap.className = "cap"; cap.textContent = p.caption || monthYear(p.taken);
      const num = document.createElement("span"); num.textContent = pad2(i + 1);
      meta.append(num, cap);
      a.append(frame, meta);
      a.addEventListener("click", (e) => { e.preventDefault(); openPhoto(i, frame.firstChild); });
      if (reduceMotion) a.classList.add("in"); else io.observe(a);
      tiles.push(a);
    });
  }

  function layout() {
    const n = columnCount();
    masonry.className = `masonry ${view}`;
    cols = Array.from({ length: n }, () => { const c = document.createElement("div"); c.className = "col"; return c; });
    const heights = new Array(n).fill(0);
    const colWidth = masonry.clientWidth / n;
    tiles.forEach((t, i) => {
      const p = photos[i];
      let k = 0;
      for (let j = 1; j < n; j++) if (heights[j] < heights[k] - 0.05) k = j;
      heights[k] += p.h / p.w + (view === "stream" ? 0.08 : 0);
      t.querySelector("img").sizes = `${Math.ceil(colWidth)}px`;
      cols[k].appendChild(t);
    });
    masonry.replaceChildren(...cols);
    parallax();
  }

  // Columns drift at slightly different speeds while scrolling (stream view).
  const speeds = [0, -0.06, -0.025];
  let ticking = false;
  function parallax() {
    ticking = false;
    const on = view === "stream" && cols.length > 1 && !reduceMotion;
    const y = -masonry.getBoundingClientRect().top;
    cols.forEach((c, i) => { c.style.transform = on ? `translate3d(0, ${Math.max(0, y) * (speeds[i] || 0)}px, 0)` : ""; });
  }
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(parallax); } }, { passive: true });

  document.querySelectorAll(".view-toggle button").forEach((b) => {
    b.addEventListener("click", () => {
      if (view === b.dataset.view) return;
      view = b.dataset.view;
      document.querySelectorAll(".view-toggle button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      const swap = () => layout();
      if (document.startViewTransition && !reduceMotion) transition(swap); else swap();
    });
  });

  // ---------------- custom cursor ----------------
  function cursor() {
    if (!finePointer || reduceMotion) return;
    const el = document.querySelector(".cursor");
    document.body.classList.add("has-cursor");
    let x = innerWidth / 2, y = innerHeight / 2, cx = x, cy = y;
    addEventListener("mousemove", (e) => {
      x = e.clientX; y = e.clientY;
      el.classList.toggle("big", !!e.target.closest(".ph, .hero-media .slide") && $("lightbox").hidden);
    }, { passive: true });
    document.addEventListener("mouseleave", () => { el.style.opacity = "0"; });
    document.addEventListener("mouseenter", () => { el.style.opacity = "1"; });
    (function loop() {
      cx += (x - cx) * 0.2; cy += (y - cy) * 0.2;
      el.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
      requestAnimationFrame(loop);
    })();
  }

  // Run `fn` as a view transition. If another one interrupts it, the DOM update
  // still happens; the rejected animation promises are expected, so swallow them.
  function transition(fn) {
    const t = document.startViewTransition(fn);
    t.ready.catch(() => {}); t.finished.catch(() => {});
    return t;
  }

  // ---------------- lightbox ----------------
  const lb = $("lightbox"), lbImg = $("lb-img");
  let current = -1, lastFocus = null;

  function lbTargetWidth(p) {
    const stage = $("lb-stage").getBoundingClientRect();
    const w = stage.width || innerWidth, h = (stage.height || innerHeight) - 76;
    return Math.min(w, h * (p.w / p.h));
  }

  function setLbImage(p, placeholderSrc) {
    lbImg.alt = p.caption || "";
    lbImg.width = p.w; lbImg.height = p.h;
    if (placeholderSrc) lbImg.src = placeholderSrc;
    const want = bestSrc(p, lbTargetWidth(p));
    if (lbImg.src.endsWith(want)) return;
    const hi = new Image();
    hi.src = want;
    const idx = current;
    hi.decode().then(() => { if (current === idx) lbImg.src = want; }).catch(() => { if (current === idx) lbImg.src = want; });
  }

  function fillBar() {
    const p = photos[current];
    $("lb-count").textContent = `${pad2(current + 1)} / ${pad2(photos.length)}`;
    $("lb-caption").textContent = [p.caption, monthYear(p.taken)].filter(Boolean).join(" — ");
    if (editor.on) editor.show(p);
    history.replaceState(null, "", `#photo-${p.id}`);
    for (const d of [1, -1]) { // warm the neighbours
      const n = photos[(current + d + photos.length) % photos.length];
      new Image().src = bestSrc(n, lbTargetWidth(n));
    }
  }

  function openPhoto(i, fromImg) {
    if (i < 0) return;
    lastFocus = document.activeElement;
    current = i;
    const cur = document.querySelector(".cursor");
    if (cur) cur.classList.remove("big");
    const p = photos[i];
    const reveal = () => {
      if (fromImg) fromImg.style.viewTransitionName = "";
      lb.hidden = false;
      document.body.style.overflow = "hidden";
      setLbImage(p, fromImg && fromImg.currentSrc ? fromImg.currentSrc : p.src[1] ? p.src[1].url : p.src[0].url);
      fillBar();
    };
    if (document.startViewTransition && fromImg && !reduceMotion) {
      fromImg.style.viewTransitionName = "active-photo";
      transition(reveal);
    } else {
      lb.classList.add("anim-in");
      reveal();
    }
    $("lb-close").focus({ preventScroll: true });
  }

  function step(d) {
    current = (current + d + photos.length) % photos.length;
    const p = photos[current];
    const go = () => { setLbImage(p, p.src[Math.min(1, p.src.length - 1)].url); fillBar(); };
    if (document.startViewTransition && !reduceMotion) transition(go); else go();
  }

  function closePhoto() {
    if (lb.hidden) return;
    const target = tiles[current] && tiles[current].querySelector("img");
    const r = target && target.getBoundingClientRect();
    const visible = r && r.bottom > 0 && r.top < innerHeight;
    const hide = () => {
      lb.hidden = true;
      lb.classList.remove("anim-in");
      document.body.style.overflow = "";
      if (visible) target.style.viewTransitionName = "active-photo";
    };
    history.replaceState(null, "", location.pathname + location.search);
    if (document.startViewTransition && visible && !reduceMotion) {
      transition(hide).finished.finally(() => { target.style.viewTransitionName = ""; }).catch(() => {});
    } else {
      hide();
      if (target) target.style.viewTransitionName = "";
    }
    if (lastFocus) lastFocus.focus({ preventScroll: true });
  }

  $("lb-close").addEventListener("click", closePhoto);
  $("lb-prev").addEventListener("click", () => step(-1));
  $("lb-next").addEventListener("click", () => step(1));
  $("lb-stage").addEventListener("click", (e) => { if (e.target === e.currentTarget) closePhoto(); });
  const typing = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
  document.addEventListener("keydown", (e) => {
    if (lb.hidden || !$("edit-setup").hidden) return;
    if (typing(e.target)) { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "Escape") closePhoto();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  });
  let tx = null, ty = null;
  lb.addEventListener("touchstart", (e) => { if (e.target.closest(".lb-edit")) { tx = null; return; } if (e.touches.length === 1) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; } }, { passive: true });
  lb.addEventListener("touchend", (e) => {
    if (tx === null) return;
    const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty;
    tx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) step(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) closePhoto(); // swipe down to close
  });
  // Discourage casual saving: no right-click menu or dragging on photos.
  const guarded = (t) => t && t.closest && (t.tagName === "IMG" || t.closest(".ph, .hero-media, .lb-stage"));
  document.addEventListener("contextmenu", (e) => { if (guarded(e.target)) e.preventDefault(); });
  document.addEventListener("dragstart", (e) => { if (guarded(e.target)) e.preventDefault(); });

  // ---------------- title editor (owner only) ----------------
  // Visiting the site with #edit asks for a GitHub key (kept in this browser
  // only). While editing is on, the lightbox shows title and position fields;
  // saving writes curation.json ({titles, order}) in the photo data repo
  // (config "data_repo"), which the page reads live. The key only needs
  // access to that repo, never to the site's code.
  const editor = (() => {
    const KEY = "at-data-key", ON = "at-title-edit";
    const store = {
      get(k) { try { return localStorage.getItem(k); } catch { return null; } },
      set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: lasts this visit */ } },
      del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
    };
    try { localStorage.removeItem("at-title-key"); } catch { /* old site-repo key: no longer used */ }
    let repo = "", memKey = null;
    const key = () => store.get(KEY) || memKey;
    const api = (file = "curation.json") => `https://api.github.com/repos/${repo}/contents/${file}`;
    const headers = () => ({ Authorization: `Bearer ${key()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
    const b64enc = (str) => { const bytes = new TextEncoder().encode(str); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
    const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
    const why = (status) =>
      status === 401 ? "GitHub didn't accept the key (it may have expired). Visit the site with #edit to set a new one." :
      status === 403 || status === 404 ? "This key can't save to the photo data repository. It needs Contents: read and write on that repository." :
      status === 409 || status === 422 ? "Someone saved at the same moment. Try again." :
      `Couldn't save (GitHub error ${status}). Try again.`;

    async function getJSON(file) {
      const r = await fetch(api(file) + "?ref=main", { headers: headers(), cache: "no-store" });
      if (r.status === 404) return { exists: false };
      if (!r.ok) { dropIfRejected(r.status); throw new Error(why(r.status)); }
      const j = await r.json();
      let data = null;
      try { data = JSON.parse(b64dec(j.content || "")); } catch { data = null; }
      return { exists: true, data, sha: j.sha };
    }
    async function readCuration() {
      const cur = await getJSON("curation.json");
      const d = cur.exists && isObj(cur.data) ? cur.data : {};
      return { raw: d, titles: isObj(d.titles) ? d.titles : {}, order: Array.isArray(d.order) ? d.order : [], sha: cur.sha };
    }

    // change = { id, title, order? }  (order: full list of photo ids, or undefined to leave as is)
    async function save(change) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const cur = await readCuration();
        const titles = { ...cur.titles };
        if (change.title) titles[change.id] = change.title; else delete titles[change.id];
        const sorted = Object.fromEntries(Object.keys(titles).sort().map((k) => [k, titles[k]]));
        // Keep fields this editor doesn't know (collections, highlights from the app).
        const doc = { ...cur.raw, titles: sorted, order: change.order || cur.order };
        const parts = [];
        if ((cur.titles[change.id] || "") !== (change.title || "")) parts.push(change.title ? `title "${change.title}"` : "title removed");
        if (change.order) parts.push(`moved to #${change.order.indexOf(change.id) + 1}`);
        const body = {
          message: `Photo ${change.id}: ${parts.join(", ") || "no change"}`,
          content: b64enc(JSON.stringify(doc, null, 2) + "\n"),
          branch: "main",
          ...(cur.sha ? { sha: cur.sha } : {}),
        };
        const w = await fetch(api(), { method: "PUT", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (w.ok) return;
        if ((w.status === 409 || w.status === 422) && attempt === 0) continue; // file changed underneath us: re-read once
        dropIfRejected(w.status);
        throw new Error(why(w.status));
      }
    }

    const form = $("lb-edit"), input = $("lb-title"), posIn = $("lb-pos"), status = $("lb-edit-status"), btn = $("lb-title-save");
    const setStatus = (msg, err) => { status.textContent = msg; status.classList.toggle("err", !!err); };

    function applyLocally(p, title) {
      p.caption = title;
      const i = photos.indexOf(p);
      const cap = tiles[i] && tiles[i].querySelector(".cap");
      if (cap) cap.textContent = title || monthYear(p.taken);
      if (tiles[i]) tiles[i].setAttribute("aria-label", title ? `Open: ${title}` : `Open photo ${i + 1}`);
      if (photos[current] === p) {
        $("lb-caption").textContent = [title, monthYear(p.taken)].filter(Boolean).join(" — ");
        lbImg.alt = title;
      }
    }

    function moveLocally(p, to) {
      const from = photos.indexOf(p);
      photos.splice(from, 1);
      photos.splice(to, 0, p);
      tiles.length = 0;
      buildTiles();
      layout();
      current = to;
      fillBar();
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const p = photos[current];
      if (!p) return;
      const title = window.cleanTitle(input.value);
      const from = photos.indexOf(p);
      const want = Math.round(Number(posIn.value));
      if (!Number.isFinite(want) || want < 1 || want > photos.length) {
        setStatus(`Position must be 1–${photos.length}.`, true); return;
      }
      const to = want - 1;
      let order;
      if (to !== from) {
        const ids = photos.map((x) => x.id).filter((id) => id !== p.id);
        ids.splice(to, 0, p.id);
        order = ids;
      }
      if (title === (p.caption || "") && order === undefined) { setStatus("Nothing to save."); return; }
      btn.disabled = true; setStatus("Saving…");
      try {
        await save({ id: p.id, title, order });
        applyLocally(p, title);
        if (order) moveLocally(p, to);
        input.value = title;
        setStatus("Saved · live in ~5 min");
      } catch (err) {
        setStatus(err.message || "Couldn't save. Try again.", true);
      } finally {
        btn.disabled = false;
      }
    });

    const setup = $("edit-setup"), keyIn = $("edit-key"), errEl = $("edit-error");
    function openSetup() {
      keyIn.value = ""; errEl.textContent = "";
      $("edit-forget").hidden = !key();
      keyIn.placeholder = key() ? "Key saved — paste a new one to replace it" : "github_pat_…";
      setup.hidden = false;
      keyIn.focus();
    }
    const closeSetup = () => { setup.hidden = true; };
    // GitHub rejected the saved key (expired or regenerated): drop it so the
    // next visit with #edit asks for the new one.
    const dropIfRejected = (status) => { if (status === 401) { store.del(KEY); memKey = null; } };

    $("edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const k = keyIn.value.trim();
      if (!k) { errEl.textContent = "Paste the key first."; return; }
      errEl.textContent = "Checking…";
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: { ...headers(), Authorization: `Bearer ${k}` }, cache: "no-store" });
        if (!r.ok) { errEl.textContent = r.status === 401 ? "GitHub didn't accept that key." : "That key can't see the photo data repository."; return; }
        const j = await r.json();
        if (j.permissions && j.permissions.push === false) { errEl.textContent = "That key can read but not save. It needs Contents: read and write."; return; }
      } catch {
        errEl.textContent = "Couldn't reach GitHub. Check your connection and try again."; return;
      }
      memKey = k; store.set(KEY, k);
      closeSetup(); turnOn();
    });
    $("edit-cancel").addEventListener("click", () => { closeSetup(); if (key()) turnOn(); });
    $("edit-forget").addEventListener("click", () => { store.del(KEY); memKey = null; turnOff(); closeSetup(); });
    $("edit-done").addEventListener("click", () => turnOff());

    const api_ = {
      on: false,
      show(p) {
        input.value = p.caption || "";
        posIn.value = photos.indexOf(p) + 1;
        posIn.max = photos.length;
        $("lb-pos-of").textContent = `of ${photos.length}`;
        setStatus("");
      },
      init(cfg) {
        repo = (cfg && cfg.data_repo) || "";
        if (location.hash === "#edit") {
          history.replaceState(null, "", location.pathname + location.search);
          if (!repo) { alert("Title editing works on the published site only."); return; }
          openSetup(); // always: lets a replaced key be pasted; Cancel keeps a saved one
        } else if (repo && key() && store.get(ON) === "1") {
          turnOn();
        }
      },
    };
    function turnOn() {
      api_.on = true; store.set(ON, "1");
      form.hidden = false; $("edit-pill").hidden = false;
      if (!lb.hidden && photos[current]) api_.show(photos[current]);
    }
    function turnOff() {
      api_.on = false; store.del(ON);
      form.hidden = true; $("edit-pill").hidden = true;
    }
    addEventListener("hashchange", () => { if (location.hash === "#edit") api_.init({ data_repo: repo }); });
    return api_;
  })();

  // ---------------- live titles & order (data repo) ----------------
  // photos.json has the titles/order baked in at the last build. The page also
  // reads curation.json from the public data repo, so edits show up within
  // minutes without a rebuild. That file is untrusted: only string titles for
  // known photo ids (cleaned like the build does), known ids in the order,
  // a size cap, and everything is rendered as text.
  const MAX_DATA = 512 * 1024;
  async function loadLive(url) {
    if (!/^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/main\/curation\.json$/.test(url || "")) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500); // slow network: keep the baked copy
    try {
      const r = await fetch(url, { cache: "no-cache", credentials: "omit", referrerPolicy: "no-referrer", signal: ctl.signal });
      if (!r.ok) return null;
      const text = await r.text();
      return text.length > MAX_DATA ? null : JSON.parse(text);
    } catch { return null; } finally { clearTimeout(timer); }
  }
  function applyLive(list, data) {
    if (!isObj(data)) return list;
    const titles = isObj(data.titles) ? data.titles : {};
    for (const p of list) {
      const raw = Object.prototype.hasOwnProperty.call(titles, p.id) ? titles[p.id] : "";
      const t = typeof raw === "string" ? window.cleanTitle(raw) : "";
      const album = "album_caption" in p ? p.album_caption : p.caption;
      if (!("album_caption" in p)) p.album_caption = p.caption || "";
      p.caption = t || album || "";
    }
    if (!Array.isArray(data.order)) return list;
    const known = new Set(list.map((p) => p.id)), rank = new Map();
    for (const id of data.order.slice(0, 5000)) if (typeof id === "string" && known.has(id) && !rank.has(id)) rank.set(id, rank.size);
    if (!rank.size) return list;
    // Same rule as the build: photos not placed yet come first.
    return list.filter((p) => !rank.has(p.id))
      .concat(list.filter((p) => rank.has(p.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id)));
  }

  // ---------------- boot ----------------
  let lastW = 0, rt;
  addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (masonry.clientWidth !== lastW) { lastW = masonry.clientWidth; layout(); } }, 150);
  });

  const cfgReady = fetch("config.json").then((r) => r.json()).catch(() => ({}));
  Promise.all([
    cfgReady,
    fetch("photos.json").then((r) => r.json()).catch(() => []),
    cfgReady.then((cfg) => loadLive(cfg.data_url)),
  ]).then(([cfg, list, live]) => {
    applyConfig(cfg);
    photos = Array.isArray(list) ? applyLive(list, live) : [];
    cursor();
    if (!photos.length) { $("empty").hidden = false; $("hero-media").hidden = true; return; }
    hero();
    buildTiles();
    lastW = masonry.clientWidth;
    layout();
    const m = location.hash.match(/^#photo-(.+)$/);
    if (m) openPhoto(photos.findIndex((p) => p.id === m[1]), null);
    editor.init(cfg);
  });
})();
