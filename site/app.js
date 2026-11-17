(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const gallery = $("gallery");
  let photos = [];
  let current = -1;

  // ---------- page chrome from config.json ----------
  function applyConfig(cfg) {
    const title = cfg.title || "Photography";
    $("footer-name").textContent = title.replace(/\s+Photography$/i, "");
    $("year").textContent = new Date().getFullYear();

    if (cfg.tagline) { $("tagline").textContent = cfg.tagline; $("tagline").hidden = false; }

    if (cfg.instagram) {
      const handle = cfg.instagram.replace(/^@/, "");
      const url = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
      for (const a of [$("insta"), $("footer-insta")]) { a.href = url; a.hidden = false; }
      $("insta-handle").textContent = "@" + handle;
      $("footer-insta").textContent = "Instagram @" + handle;
    }

    if (cfg.about) {
      const btn = $("about-btn"), sec = $("about");
      $("about-text").textContent = cfg.about;
      btn.hidden = false;
      btn.setAttribute("aria-expanded", "false");
      btn.addEventListener("click", () => {
        sec.hidden = !sec.hidden;
        btn.setAttribute("aria-expanded", String(!sec.hidden));
      });
    }
  }

  // ---------- justified-row layout ----------
  function targetRowHeight(width) {
    if (width < 500) return 180;
    if (width < 900) return 240;
    if (width < 1500) return 300;
    return 360;
  }

  function layout() {
    const width = gallery.clientWidth -
      parseFloat(getComputedStyle(gallery).paddingLeft) -
      parseFloat(getComputedStyle(gallery).paddingRight);
    if (width <= 0) return;
    const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gap")) || 8;
    const target = targetRowHeight(width);
    const frag = document.createDocumentFragment();
    let row = [], ratioSum = 0;

    const flush = (last) => {
      if (!row.length) return;
      const avail = width - gap * (row.length - 1);
      let h = avail / ratioSum;
      if (last && h > target * 1.25) h = target;  // don't blow up a short final row
      const el = document.createElement("div");
      el.className = "row";
      for (const i of row) {
        const p = photos[i];
        const w = (p.w / p.h) * h;
        el.appendChild(tile(i, w, h));
      }
      frag.appendChild(el);
      row = []; ratioSum = 0;
    };

    photos.forEach((p, i) => {
      row.push(i);
      ratioSum += p.w / p.h;
      if ((width - gap * (row.length - 1)) / ratioSum <= target) flush(false);
    });
    flush(true);

    gallery.replaceChildren(frag);
  }

  const tiles = new Map(); // reuse <img> elements across re-layouts
  function tile(i, w, h) {
    let btn = tiles.get(i);
    if (!btn) {
      const p = photos[i];
      btn = document.createElement("button");
      btn.className = "tile";
      btn.type = "button";
      btn.setAttribute("aria-label", p.caption ? `Open photo: ${p.caption}` : `Open photo ${i + 1}`);
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = p.caption || "";
      img.srcset = `${p.thumb} ${p.thumb_w}w, ${p.full} ${p.full_w}w`;
      img.sizes = "(max-width: 600px) 100vw, 50vw";
      img.src = p.thumb;
      img.addEventListener("load", () => img.classList.add("loaded"));
      if (img.complete) img.classList.add("loaded");
      btn.appendChild(img);
      btn.addEventListener("click", () => open(i));
      tiles.set(i, btn);
    }
    // Pick a srcset size based on actual tile width.
    btn.firstChild.sizes = `${Math.ceil(w)}px`;
    btn.style.width = `${w}px`;
    btn.style.height = `${h}px`;
    return btn;
  }

  // ---------- lightbox ----------
  const lb = $("lightbox"), lbImg = $("lb-img"), lbCap = $("lb-caption");
  let lastFocus = null;

  function show(i) {
    current = (i + photos.length) % photos.length;
    const p = photos[current];
    lbImg.src = p.full;
    lbImg.alt = p.caption || "";
    lbCap.textContent = p.caption || "";
    // Preload neighbours for snappy navigation.
    for (const d of [1, -1]) {
      const n = photos[(current + d + photos.length) % photos.length];
      new Image().src = n.full;
    }
    history.replaceState(null, "", `#${p.id}`);
  }

  function open(i) {
    lastFocus = document.activeElement;
    lb.hidden = false;
    document.body.style.overflow = "hidden";
    show(i);
    $("lb-close").focus();
  }

  function close() {
    lb.hidden = true;
    document.body.style.overflow = "";
    lbImg.removeAttribute("src");
    history.replaceState(null, "", location.pathname + location.search);
    if (lastFocus) lastFocus.focus();
  }

  $("lb-close").addEventListener("click", close);
  $("lb-prev").addEventListener("click", () => show(current - 1));
  $("lb-next").addEventListener("click", () => show(current + 1));
  lb.addEventListener("click", (e) => { if (e.target === lb || e.target.classList.contains("lb-figure")) close(); });
  document.addEventListener("keydown", (e) => {
    if (lb.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") show(current - 1);
    else if (e.key === "ArrowRight") show(current + 1);
  });

  // Swipe on touch screens.
  let touchX = null, touchY = null;
  lb.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }
  }, { passive: true });
  lb.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    touchX = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(current + (dx < 0 ? 1 : -1));
  });

  // Discourage casual right-click saving of full-size images.
  document.addEventListener("contextmenu", (e) => { if (e.target.tagName === "IMG") e.preventDefault(); });

  // ---------- boot ----------
  let resizeTimer;
  let lastWidth = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (gallery.clientWidth !== lastWidth) { lastWidth = gallery.clientWidth; layout(); }
    }, 120);
  });

  Promise.all([
    fetch("config.json").then((r) => r.json()).catch(() => ({})),
    fetch("photos.json").then((r) => r.json()).catch(() => []),
  ]).then(([cfg, list]) => {
    applyConfig(cfg);
    photos = list;
    if (!photos.length) { $("empty").hidden = false; return; }
    lastWidth = gallery.clientWidth;
    layout();
    // Deep link: /#<photo-id> opens that photo.
    const id = location.hash.slice(1);
    const idx = id ? photos.findIndex((p) => p.id === id) : -1;
    if (idx >= 0) open(idx);
  });
})();
