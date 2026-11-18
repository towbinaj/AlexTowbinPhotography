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

  let photos = [];      // what the gallery shows (all, or one collection)
  let allPhotos = [];
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
  // Highlighted photos (set in the editor app) are the slideshow, in main page
  // order. With none, it shows the newest few, then a random sample.
  const MAX_SLIDES = 12;
  function highlightsFrom(raw) {
    const ids = new Set(Array.isArray(raw) ? raw.slice(0, 5000).filter((id) => typeof id === "string") : []);
    return allPhotos.filter((p) => ids.has(p.id)).slice(0, MAX_SLIDES);
  }
  function hero(highlights) {
    const media = $("hero-media");
    $("hero-count").textContent = `${pad2(allPhotos.length)} photographs`;
    const rest = allPhotos.slice(3).sort(() => Math.random() - 0.5);
    const picks = highlights.length ? highlights : allPhotos.slice(0, 3).concat(rest).slice(0, 6);
    const slides = picks.map((p, i) => {
      const s = document.createElement("div"); s.className = "slide";
      s.appendChild(makeImg(p, "(max-width: 860px) 100vw, 45vw", i === 0));
      s.addEventListener("click", () => { if (!photos.includes(p)) groups.select(null); openPhoto(photos.indexOf(p), s.firstChild); });
      s.style.cursor = "zoom-in";
      media.insertBefore(s, $("hero-index"));
      return s;
    });
    let cur = 0;
    // Load the next print while this one shows, and only switch once it has
    // loaded, so the wipe never reveals an empty frame.
    const img = (i) => slides[i].querySelector("img");
    const warm = (i) => { if (slides.length > 1) img(i).loading = "eager"; };
    const ready = (i) => img(i).complete && img(i).naturalWidth > 0;
    const show = (i) => {
      slides.forEach((s) => s.classList.remove("was"));
      slides[cur].classList.replace("on", "was");
      cur = i;
      slides[cur].classList.add("on");
      $("hero-index").textContent = `${pad2(cur + 1)} — ${pad2(slides.length)}`;
      warm((cur + 1) % slides.length);
    };
    slides[0].classList.add("on");
    $("hero-index").textContent = `01 — ${pad2(slides.length)}`;
    warm(1 % slides.length);
    if (slides.length > 1 && !reduceMotion) {
      setInterval(() => {
        const next = (cur + 1) % slides.length;
        if (!document.hidden && $("lightbox").hidden && ready(next)) show(next);
      }, 5200);
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
    // Museum-label style: title — place — date. Places are plain text (city/state/country).
    const label = [p.caption, window.PhotoMeta.placeLabel(p.place), monthYear(p.taken)].filter(Boolean).join(" — ");
    $("lb-caption").textContent = label;
    $("lb-info").textContent = label; // phones: own line (the bar is too narrow)
    $("lb-info").hidden = !label;
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
    history.replaceState(null, "", location.pathname + location.search + groups.hash());
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
    if (lb.hidden) return;
    if (typing(e.target)) { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "Escape") closePhoto();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  });
  let tx = null, ty = null;
  lb.addEventListener("touchstart", (e) => { if (e.touches.length === 1) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; } }, { passive: true });
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

  // Editing lives in the editor app (/edit/). The old #edit mode is gone; drop
  // what it left in this browser (its GitHub key and on/off flag).
  try { for (const k of ["at-data-key", "at-title-key", "at-title-edit"]) localStorage.removeItem(k); } catch { /* ignore */ }

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
    // Tags (only names in the tag library) and city/region/country places.
    const M = window.PhotoMeta, lib = new Map();
    for (const t of Array.isArray(data.tags) ? data.tags.slice(0, 300) : []) {
      const n = typeof t === "string" ? M.cleanTag(t) : "";
      if (n && !lib.has(n.toLowerCase())) lib.set(n.toLowerCase(), n);
    }
    const ptags = isObj(data.photo_tags) ? data.photo_tags : {}, locs = isObj(data.locations) ? data.locations : {};
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    for (const p of list) {
      const names = own(ptags, p.id) && Array.isArray(ptags[p.id]) ? ptags[p.id].slice(0, 30) : [];
      const tags = [];
      for (const t of names) { const n = typeof t === "string" ? lib.get(M.cleanTag(t).toLowerCase()) : undefined; if (n && !tags.includes(n)) tags.push(n); }
      if (tags.length) p.tags = tags; else delete p.tags;
      const pl = own(locs, p.id) ? M.cleanPlace(locs[p.id]) : null;
      if (pl) p.place = pl; else delete p.place;
    }
    if (!Array.isArray(data.order)) return list;
    const known = new Set(list.map((p) => p.id)), rank = new Map();
    for (const id of data.order.slice(0, 5000)) if (typeof id === "string" && known.has(id) && !rank.has(id)) rank.set(id, rank.size);
    if (!rank.size) return list;
    // Same rule as the build: photos not placed yet come first.
    return list.filter((p) => !rank.has(p.id))
      .concat(list.filter((p) => rank.has(p.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id)));
  }

  // ---------------- collections ----------------
  // Named series from the data repo (set in the editor app). When there are
  // any, a row of links above the gallery switches between "All" and each
  // collection (shown in its own order); #collection-<name> links to one.
  // Hidden while there are none. The data is untrusted: names cleaned like
  // titles, only known photo ids, a photo in one collection at most.
  const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const groups = (() => {
    const nav = $("collections"), title = $("work-title");
    const allTitle = Array.from(title.childNodes, (n) => n.cloneNode(true));
    let list = [], active = null;

    function clean(raw) {
      const known = new Map(allPhotos.map((p) => [p.id, p])), used = new Set(), names = new Set(), slugs = new Set(), out = [];
      for (const c of Array.isArray(raw) ? raw.slice(0, 100) : []) {
        if (!isObj(c)) continue;
        const name = [...window.cleanTitle(String(c.name || ""))].slice(0, 60).join("").trim();
        if (!name || names.has(name.toLowerCase())) continue;
        const items = [];
        for (const id of Array.isArray(c.photos) ? c.photos.slice(0, 5000) : []) {
          if (typeof id === "string" && known.has(id) && !used.has(id)) { used.add(id); items.push(known.get(id)); }
        }
        if (!items.length) continue;
        names.add(name.toLowerCase());
        let slug = fold(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "series";
        for (let n = 2; slugs.has(slug); n++) slug = slug.replace(/-\d+$/, "") + "-" + n;
        slugs.add(slug);
        out.push({ name, slug, items });
      }
      return out;
    }
    function render() {
      nav.textContent = "";
      nav.hidden = !list.length;
      if (!list.length) return;
      const add = (label, slug, n) => {
        const b = document.createElement("button");
        b.type = "button"; b.setAttribute("aria-pressed", String(active === slug));
        b.append(label);
        const c = document.createElement("span"); c.className = "n"; c.textContent = n; b.appendChild(c);
        b.addEventListener("click", () => api.select(slug, true));
        nav.appendChild(b);
      };
      add("All", null, allPhotos.length);
      for (const c of list) add(c.name, c.slug, c.items.length);
    }
    const api = {
      init(raw) {
        list = clean(raw);
        const m = location.hash.match(/^#collection-(.+)$/);
        active = m && list.some((c) => c.slug === m[1]) ? m[1] : null;
        if (active) api.select(active, true); else render();
      },
      select(slug, scroll) {
        const c = list.find((x) => x.slug === slug) || null;
        if ((c ? c.slug : null) === active && photos === (c ? c.items : allPhotos)) return;
        active = c ? c.slug : null;
        photos = c ? c.items : allPhotos;
        title.replaceChildren(...(c ? [document.createTextNode(c.name)] : allTitle.map((n) => n.cloneNode(true))));
        tiles.length = 0;
        buildTiles();
        layout();
        render();
        if (!/^#photo-/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search + api.hash());
        if (scroll) $("work").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
      },
      hash: () => (active ? "#collection-" + active : ""),
    };
    addEventListener("hashchange", () => {
      const m = location.hash.match(/^#collection-(.+)$/);
      if (m) api.select(m[1], true);
    });
    return api;
  })();

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
    // Live collections when the data repo answered, else the copy baked in at build.
    const rawCollections = isObj(live) ? live.collections : cfg.collections;
    const rawHighlights = isObj(live) ? live.highlights : cfg.highlights;
    applyConfig(cfg);
    allPhotos = photos = Array.isArray(list) ? applyLive(list, live) : [];
    cursor();
    if (!photos.length) { $("empty").hidden = false; $("hero-media").hidden = true; return; }
    hero(highlightsFrom(rawHighlights));
    buildTiles();
    lastW = masonry.clientWidth;
    layout();
    groups.init(rawCollections);
    const m = location.hash.match(/^#photo-(.+)$/);
    if (m) openPhoto(photos.findIndex((p) => p.id === m[1]), null);
  });
})();
