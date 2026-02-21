// ==UserScript==
// @name         AO3 Bunker
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  AO3 reading list (OLED, thumb-optimized, swipe to read/delete on mobile, action buttons on desktop)
// @match        https://archiveofourown.org/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// ==/UserScript==

// big thanks to lizzie

(function () {
  'use strict';

  const TITLE = "the bunker 😇";
  const STORAGE_KEY = "ao3_bunker";
  const PREFS_KEY = "ao3_bunker_prefs";

  const isWorkPage = /^\/works\/\d+/.test(location.pathname);
  const isHomePage = location.pathname === "/" || location.pathname === "/index";
  const isBunkerHash = location.hash === "#bunker";
  const shouldHaveButton = isHomePage || isWorkPage;
  if (!shouldHaveButton) return;

  const UNDO_MS = 5000;

  // ----------------------------
  // URL normalization (#2, #3)
  // ----------------------------
  // Extract a stable work ID from the path so that
  // /works/12345, /works/12345?view_adult=true, /works/12345/chapters/6789
  // all resolve to the same canonical URL and workId.
  function extractWorkId(url) {
    try {
      const u = new URL(url, location.origin);
      const m = u.pathname.match(/^\/works\/(\d+)/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  function canonicalWorkUrl(url) {
    const id = extractWorkId(url);
    return id ? `${location.origin}/works/${id}` : url;
  }

  const isFullWorkView = new URLSearchParams(location.search).get("view_full_work") === "true";

  // Build a clean chapter URL (strip query params / fragments)
  // Exception: preserve ?view_full_work=true since it's a distinct view mode
  function cleanChapterUrl() {
    const m = location.pathname.match(/^(\/works\/\d+(?:\/chapters\/\d+)?)/);
    const base = m ? `${location.origin}${m[1]}` : canonicalWorkUrl(location.href);
    if (isFullWorkView) return `${base}?view_full_work=true`;
    return base;
  }

  // ----------------------------
  // Chapter detection
  // ----------------------------
  // AO3 multi-chapter works have a <select id="selected_id"> dropdown.
  // The selected <option> tells us the current chapter number (by position)
  // and the total count. Single-chapter works lack this element.
  // Full-work view shows all chapters on one page — no chapter to track.
  function extractChapter() {
    if (isFullWorkView) return null;

    const sel = document.querySelector("select#selected_id");
    if (!sel) return null; // single-chapter work

    const opts = Array.from(sel.options);
    const idx = sel.selectedIndex;
    if (idx < 0 || !opts.length) return null;

    const current = idx + 1;
    const total = opts.length;
    return { current, total, label: `Ch. ${current}/${total}` };
  }

  // ----------------------------
  // Storage
  // ----------------------------
  function getBookmarks() {
    const raw = GM_getValue(STORAGE_KEY, []);
    // Guard against corrupted storage (#4)
    return Array.isArray(raw) ? raw : [];
  }
  function saveBookmarks(b) { GM_setValue(STORAGE_KEY, b); }

  function getPrefs() { return GM_getValue(PREFS_KEY, { hideRead: true }); }
  function savePrefs(p) { GM_setValue(PREFS_KEY, p); }

  function normalizeBookmarks() {
    const b = getBookmarks();
    let changed = false;
    const seenIds = new Set();
    const deduped = [];

    for (const item of b) {
      if (typeof item.savedAt !== "number" || !Number.isFinite(item.savedAt)) { item.savedAt = Date.now(); changed = true; }
      if (typeof item.readAt !== "number" && item.readAt !== null) { item.readAt = null; changed = true; }
      if (typeof item.title !== "string") { item.title = String(item.title || item.url || ""); changed = true; }
      if (typeof item.author !== "string") { item.author = String(item.author || ""); changed = true; }
      if (typeof item.dateText !== "string") { item.dateText = String(item.dateText || ""); changed = true; }
      if (typeof item.url !== "string") { item.url = String(item.url || ""); changed = true; }

      // Backfill workId and normalize URL for existing entries (#2, #3)
      const wid = extractWorkId(item.url);
      if (wid && !item.workId) { item.workId = wid; changed = true; }
      const canon = canonicalWorkUrl(item.url);
      if (canon !== item.url) { item.url = canon; changed = true; }

      // Deduplicate by workId (#3)
      const key = item.workId || item.url;
      if (seenIds.has(key)) { changed = true; continue; }
      seenIds.add(key);
      deduped.push(item);
    }

    if (changed) saveBookmarks(deduped);
  }

  // ----------------------------
  // Utilities
  // ----------------------------
  function vibe(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch { }
  }

  function timeAgo(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n)) return "";
    const s = Math.floor((Date.now() - n) / 1000);
    if (!Number.isFinite(s) || s < 0) return "";
    if (s < 60) return s === 1 ? "1 sec ago" : `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return m === 1 ? "1 min ago" : `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return h === 1 ? "1 hr ago" : `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 14) return d === 1 ? "1 day ago" : `${d}d ago`;
    const w = Math.floor(d / 7);
    return w === 1 ? "1 wk ago" : `${w}w ago`;
  }

  function extractMeta() {
    const titleEl = document.querySelector("h2.title");
    const title = titleEl ? titleEl.textContent.trim().replace(/\s+/g, " ") : document.title;

    const authorEls = Array.from(document.querySelectorAll("h3.byline a[rel='author']"));
    const author = authorEls.map(a => a.textContent.trim()).filter(Boolean).join(", ");

    // Fandom tags: dd.fandom.tags contains one or more <a> tags
    const fandomEls = Array.from(document.querySelectorAll("dd.fandom.tags a.tag"));
    const fandom = fandomEls.map(a => a.textContent.trim()).filter(Boolean).join(", ");

    const stats = document.querySelector("dl.stats");
    let dateText = "";
    if (stats) {
      const dts = Array.from(stats.querySelectorAll("dt"));
      const find = (label) => {
        const dt = dts.find(d => d.textContent.trim().toLowerCase().startsWith(label));
        if (!dt) return "";
        const dd = dt.nextElementSibling;
        return dd ? dd.textContent.trim().replace(/\s+/g, " ") : "";
      };
      dateText = find("updated") || find("published") || "";
    }
    return { title, author, fandom, dateText };
  }

  // ----------------------------
  // Work identity helpers
  // ----------------------------
  const currentWorkId = extractWorkId(location.href);
  const currentCanonical = canonicalWorkUrl(location.href);
  const currentChapterUrl = cleanChapterUrl();

  function findBookmark(bookmarks, url) {
    const wid = extractWorkId(url);
    if (wid) return bookmarks.find(b => b.workId === wid);
    return bookmarks.find(b => b.url === url);
  }

  // ----------------------------
  // Pending delete state (in-memory)
  // ----------------------------
  // workId|url -> { expiresAt, timeoutId, finalizing }
  const pendingDeletes = new Map();

  function deleteKey(bookmark) {
    return bookmark.workId || bookmark.url;
  }

  function isPendingDelete(bookmark) {
    return pendingDeletes.has(deleteKey(bookmark));
  }

  function requestDelete(bookmark) {
    const key = deleteKey(bookmark);
    if (pendingDeletes.has(key)) return;

    const expiresAt = Date.now() + UNDO_MS;

    const timeoutId = setTimeout(() => {
      const p = pendingDeletes.get(key);
      if (!p) return;
      p.finalizing = true;
      render();

      setTimeout(() => {
        finalizeDelete(bookmark);
      }, 220);
    }, UNDO_MS);

    pendingDeletes.set(key, { expiresAt, timeoutId, finalizing: false });
    vibe(18);
    render();
  }

  function undoDelete(bookmark) {
    const key = deleteKey(bookmark);
    const p = pendingDeletes.get(key);
    if (!p) return;
    clearTimeout(p.timeoutId);
    pendingDeletes.delete(key);
    vibe(10);
    render();
  }

  function finalizeDelete(bookmark) {
    const key = deleteKey(bookmark);
    const p = pendingDeletes.get(key);
    if (p) {
      clearTimeout(p.timeoutId);
      pendingDeletes.delete(key);
    }
    const b = getBookmarks();
    const i = b.findIndex(x => (x.workId || x.url) === key);
    if (i !== -1) {
      b.splice(i, 1);
      saveBookmarks(b);
    }
    render();
  }

  // ----------------------------
  // Bookmark operations
  // ----------------------------
  function isCurrentWorkSaved(bookmarks) {
    if (!isWorkPage || !currentWorkId) return false;
    return !!bookmarks.find(b => b.workId === currentWorkId);
  }

  function isCurrentWorkPendingDelete() {
    if (!currentWorkId) return false;
    return pendingDeletes.has(currentWorkId);
  }

  function addCurrentWork() {
    if (!isWorkPage) return { ok: false };

    const bookmarks = getBookmarks();
    if (isCurrentWorkSaved(bookmarks) || isCurrentWorkPendingDelete()) return { ok: false };

    const meta = extractMeta();
    const chapter = extractChapter();
    bookmarks.push({
      url: currentCanonical,
      workId: currentWorkId,
      title: meta.title,
      author: meta.author,
      fandom: meta.fandom,
      dateText: meta.dateText,
      chapterUrl: currentChapterUrl,
      chapterLabel: chapter ? chapter.label : null,
      readAt: null,
      savedAt: Date.now()
    });
    saveBookmarks(bookmarks);
    vibe(10);
    return { ok: true };
  }

  function toggleRead(bookmark) {
    const b = getBookmarks();
    const item = b.find(x => (x.workId || x.url) === deleteKey(bookmark));
    if (!item) return;
    item.readAt = item.readAt ? null : Date.now();
    saveBookmarks(b);
    vibe(8);
  }

  function refreshIfCurrentWorkIsSaved() {
    if (!isWorkPage) return;
    const b = getBookmarks();
    const item = findBookmark(b, location.href);
    if (!item) return;

    const meta = extractMeta();
    const chapter = extractChapter();
    let changed = false;

    if (meta.title && meta.title !== item.title) { item.title = meta.title; changed = true; }
    if (meta.author && meta.author !== item.author) { item.author = meta.author; changed = true; }
    if (meta.fandom && meta.fandom !== item.fandom) { item.fandom = meta.fandom; changed = true; }
    if (meta.dateText && meta.dateText !== item.dateText) { item.dateText = meta.dateText; changed = true; }

    // Silently update chapter to wherever the user is now
    if (currentChapterUrl !== item.chapterUrl) { item.chapterUrl = currentChapterUrl; changed = true; }
    const newLabel = chapter ? chapter.label : null;
    if (newLabel !== item.chapterLabel) { item.chapterLabel = newLabel; changed = true; }

    if (changed) saveBookmarks(b);
  }

  // ----------------------------
  // UI
  // ----------------------------
  let panelOpen = false;
  let btn;

  function createButton() {
    btn = document.createElement("button");
    btn.id = "bunker-btn";
    btn.textContent = "📦";
    btn.type = "button";
    btn.setAttribute("aria-label", "Toggle bunker");
    btn.addEventListener("click", () => togglePanel());
    document.body.appendChild(btn);
    return btn;
  }

  function createPanel() {
    const panel = document.createElement("div");
    panel.id = "bunker-panel";
    panel.style.display = "none";
    panel.innerHTML = `
      <div class="bunker-titlebar">`+ TITLE + `</div>

      <div class="bunker-listwrap">
        <div class="bunker-list" id="bunker-list"></div>
      </div>

      <div class="bunker-bottom">
        <label class="bunker-toggle">
          <input type="checkbox" id="bunker-hide-read">
          <span>Hide read</span>
        </label>

        <button class="bunker-save" id="bunker-save" type="button">Save this work</button>
      </div>
    `;
    document.body.appendChild(panel);

    const prefs = getPrefs();
    const hideCb = panel.querySelector("#bunker-hide-read");
    hideCb.checked = prefs.hideRead;
    hideCb.addEventListener("change", () => {
      const p = getPrefs();
      p.hideRead = hideCb.checked;
      savePrefs(p);
      render();
    });

    const saveBtn = panel.querySelector("#bunker-save");
    saveBtn.addEventListener("click", () => {
      if (saveBtn.disabled) return;
      const res = addCurrentWork();
      if (!res.ok) return;
      render();
      scrollListToBottom();
    });

    return panel;
  }

  function scrollListToBottom() {
    const list = document.getElementById("bunker-list");
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }

  function togglePanel(force) {
    const panel = document.getElementById("bunker-panel");
    if (!panel) return;

    panelOpen = (typeof force === "boolean") ? force : !panelOpen;
    panel.style.display = panelOpen ? "block" : "none";

    document.documentElement.classList.toggle("bunker-lock-scroll", panelOpen);
    document.body.classList.toggle("bunker-lock-scroll", panelOpen);

    if (panelOpen) {
      refreshIfCurrentWorkIsSaved();
      render();
      scrollListToBottom();
      btn.style.opacity = "0.9";
    }
  }

  function installOutsideDismiss() {
    document.addEventListener("pointerdown", (e) => {
      if (!panelOpen) return;

      const panel = document.getElementById("bunker-panel");
      if (!panel) return;

      const t = e.target;
      if (panel.contains(t)) return;
      if (btn && (btn === t || btn.contains(t))) return;

      togglePanel(false);
    }, true);
  }

  // ----------------------------
  // Render
  // ----------------------------
  function render() {
    const list = document.getElementById("bunker-list");
    const saveBtn = document.getElementById("bunker-save");
    if (!list || !saveBtn) return;

    // Single storage read for the entire render cycle
    const bookmarks = getBookmarks();

    // Save button state
    if (!isWorkPage) {
      saveBtn.disabled = true;
      saveBtn.classList.add("bunker-disabled");
      saveBtn.textContent = "Save this work";
    } else {
      const saved = isCurrentWorkSaved(bookmarks);
      const pendingDel = isCurrentWorkPendingDelete();
      const disabled = saved || pendingDel;
      saveBtn.disabled = disabled;
      saveBtn.classList.toggle("bunker-disabled", disabled);
      saveBtn.textContent = disabled ? "Saved" : "Save this work";
    }

    const prefs = getPrefs();

    const ordered = [...bookmarks].sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    const visible = prefs.hideRead ? ordered.filter(b => !b.readAt) : ordered;

    list.innerHTML = "";

    if (!visible.length) {
      list.innerHTML = `<div class="bunker-empty">Nothing here yet.</div>`;
      return;
    }

    for (let i = 0; i < visible.length; i++) {
      const b = visible[i];
      const key = deleteKey(b);
      const p = pendingDeletes.get(key);

      const row = document.createElement("div");
      row.className = "bunker-row";
      row.style.setProperty("--x", "0px");
      row.style.setProperty("--fade", "1");

      const pending = isPendingDelete(b);
      const finalizing = !!p?.finalizing;

      if (pending) row.classList.add("bunker-delete-pending");
      if (finalizing) row.classList.add("bunker-delete-finalizing");

      if (b.readAt) row.classList.add("bunker-read");

      const content = document.createElement("div");
      content.className = "bunker-row-content";

      const left = document.createElement("div");
      left.className = "bunker-row-left";

      if (pending) {
        const title = document.createElement("div");
        title.className = "bunker-deleted-title";
        title.textContent = "Deleted.";

        const meta = document.createElement("div");
        meta.className = "bunker-meta";
        meta.textContent = b.title || "";

        left.appendChild(title);
        left.appendChild(meta);
      } else {
        const title = document.createElement("a");
        title.className = "bunker-link";
        title.href = b.chapterUrl || b.url;
        title.target = "_blank";
        title.rel = "noopener noreferrer";
        title.textContent = b.title;

        const meta = document.createElement("div");
        meta.className = "bunker-meta";

        const parts = [];
        if (b.chapterLabel) parts.push(b.chapterLabel);
        if (b.fandom) parts.push(b.fandom);
        if (b.author) parts.push(b.author);
        if (b.dateText) parts.push(b.dateText);
        const ago = timeAgo(b.savedAt);
        if (ago) parts.push(ago);
        if (b.readAt) parts.push("read");
        meta.textContent = parts.join(" · ");

        left.appendChild(title);
        if (parts.length) left.appendChild(meta);
      }

      content.appendChild(left);

      // Actions: both swipe AND buttons are always in the DOM.
      // CSS media queries hide/show the appropriate one.
      const actions = document.createElement("div");
      actions.className = "bunker-actions";

      if (pending) {
        const undoBtn = document.createElement("button");
        undoBtn.className = "bunker-undo-btn";
        undoBtn.type = "button";
        undoBtn.textContent = "Undo";
        undoBtn.addEventListener("click", () => undoDelete(b));
        actions.appendChild(undoBtn);
      } else {
        const readBtn = document.createElement("button");
        readBtn.className = "bunker-iconbtn";
        readBtn.type = "button";
        readBtn.textContent = b.readAt ? "↺" : "✓";
        readBtn.title = b.readAt ? "Mark unread" : "Mark read";
        readBtn.addEventListener("click", () => {
          toggleRead(b);
          render();
        });

        const delBtn = document.createElement("button");
        delBtn.className = "bunker-iconbtn";
        delBtn.type = "button";
        delBtn.textContent = "✕";
        delBtn.title = "Delete";
        delBtn.addEventListener("click", () => requestDelete(b));

        actions.appendChild(readBtn);
        actions.appendChild(delBtn);
      }

      content.appendChild(actions);
      row.appendChild(content);

      // Always install swipe handlers — they only fire on touch events,
      // so they're harmless on desktop. CSS hides the buttons on
      // coarse-pointer devices, giving touch users the swipe UX instead.
      if (!pending) {
        installSwipeHandlers(row, b);
      }

      list.appendChild(row);
    }
  }

  // ----------------------------
  // Swipe handling (touch)
  // ----------------------------
  function installSwipeHandlers(rowEl, bookmark) {
    let startX = 0, startY = 0;
    let lastX = 0, lastY = 0;
    let tracking = false;
    let locked = null;

    const SWIPE_COMMIT_PX = 70;
    const LOCK_PX = 10;

    function resetVisuals() {
      rowEl.style.setProperty("--x", "0px");
      rowEl.style.setProperty("--fade", "1");
      rowEl.classList.remove("bunker-read-fading", "bunker-unread-preview");
      rowEl.style.background = "#000";
    }

    function onStart(e) {
      const t = e.touches?.[0];
      if (!t) return;
      tracking = true;
      locked = null;
      startX = lastX = t.clientX;
      startY = lastY = t.clientY;
      resetVisuals();
    }

    function onMove(e) {
      if (!tracking) return;
      const t = e.touches?.[0];
      if (!t) return;

      lastX = t.clientX;
      lastY = t.clientY;

      const dx = lastX - startX;
      const dy = lastY - startY;

      if (locked === null) {
        if (Math.abs(dx) > LOCK_PX || Math.abs(dy) > LOCK_PX) {
          locked = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
        }
      }
      if (locked !== "h") return;

      e.preventDefault();

      const clamped = Math.max(-120, Math.min(120, dx));
      rowEl.style.setProperty("--x", `${clamped}px`);

      if (clamped < 0) {
        const intensity = Math.min(Math.abs(clamped) / 120, 1);
        rowEl.style.background = `linear-gradient(
          to left,
          rgba(140,0,0,${0.10 + intensity * 0.18}),
          rgba(140,0,0,${0.22 + intensity * 0.34})
        )`;
        rowEl.style.setProperty("--fade", "1");
        rowEl.classList.remove("bunker-unread-preview");
      } else if (clamped > 0) {
        rowEl.style.background = "#000";
        rowEl.classList.add("bunker-read-fading");

        const goingToRead = !bookmark.readAt;

        if (goingToRead) {
          const fade = 1 - Math.min(clamped / 150, 0.6);
          rowEl.style.setProperty("--fade", String(fade));
          rowEl.classList.remove("bunker-unread-preview");
        } else {
          const t2 = Math.min(clamped / 140, 1);
          const fadeUp = 0.62 + (1 - 0.62) * t2;
          rowEl.style.setProperty("--fade", String(fadeUp));
          rowEl.classList.add("bunker-unread-preview");
        }
      } else {
        resetVisuals();
      }
    }

    function onEnd() {
      if (!tracking) return;
      tracking = false;

      const dx = lastX - startX;
      const dy = lastY - startY;

      if (Math.abs(dx) < Math.abs(dy)) {
        resetVisuals();
        return;
      }

      if (dx > SWIPE_COMMIT_PX) {
        toggleRead(bookmark);
        render();
      } else if (dx < -SWIPE_COMMIT_PX) {
        requestDelete(bookmark);
      }

      resetVisuals();
    }

    rowEl.addEventListener("touchstart", onStart, { passive: true });
    rowEl.addEventListener("touchmove", onMove, { passive: false });
    rowEl.addEventListener("touchend", onEnd, { passive: true });
    rowEl.addEventListener("touchcancel", onEnd, { passive: true });
  }

  // ----------------------------
  // Scroll behavior for button (#7: no cleanup needed, page-lifetime listener)
  // ----------------------------
  function installScroll(btnEl) {
    if (isHomePage) {
      btnEl.style.opacity = "0.9";
      return;
    }
    if (!isWorkPage) return;

    let lastY = window.scrollY;
    let lastT = Date.now();

    const SHOW_THRESHOLD = 12;
    const HIDE_THRESHOLD = 8;
    const MIN_INTERVAL_MS = 60;

    window.addEventListener("scroll", () => {
      if (panelOpen) {
        btnEl.style.opacity = "0.9";
        lastY = window.scrollY;
        return;
      }

      const now = Date.now();
      if (now - lastT < MIN_INTERVAL_MS) return;
      lastT = now;

      const y = window.scrollY;
      const dy = y - lastY;

      if (dy > HIDE_THRESHOLD) btnEl.style.opacity = "0";
      else if (dy < -SHOW_THRESHOLD) btnEl.style.opacity = "0.9";
      if (y < 20) btnEl.style.opacity = "0.9";

      lastY = y;
    }, { passive: true });
  }

  // ----------------------------
  // Styles
  // ----------------------------
  GM_addStyle(`
    .bunker-lock-scroll { overflow: hidden !important; overscroll-behavior: none !important; }

    #bunker-btn {
      position: fixed;
      bottom: 16px;
      right: 16px;
      width: 44px;
      height: 44px;
      border-radius: 50% !important;
      aspect-ratio: 1 / 1;
      border: 1px solid rgba(255,255,255,0.26);
      background: #000;
      color: #fff;
      font-size: 18px;
      z-index: 999999;
      opacity: 0.9;
      transition: opacity 0.18s ease, transform 0.18s ease;
      touch-action: manipulation;
      padding: 0;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.05);
    }
    #bunker-btn:active { transform: scale(0.96); border-style: dashed; }

    #bunker-panel {
      position: fixed;
      left: 10px;
      right: 10px;
      bottom: 70px;
      z-index: 999999;
      background: #000;
      color: #fff;
      border: 1px solid rgba(255,255,255,0.30);
      box-shadow:
        0 10px 34px rgba(0,0,0,0.85),
        0 0 0 1px rgba(255,255,255,0.06);
      border-radius: 12px;
      padding: 12px;
      display: none;
      max-width: 800px;
    }
    @media (min-width: 840px) {
      #bunker-panel {
        left: auto;
      }
    }

    .bunker-titlebar {
      font-weight: 600;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.14);
      margin-bottom: 10px;
      font-size: 20px;
      line-height: 1.15;
    }

    .bunker-listwrap { max-height: 220px; overflow: hidden; }
    .bunker-list {
      max-height: 220px;
      overflow-y: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      padding-right: 2px;
    }

    .bunker-row {
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 10px;
      margin-bottom: 8px;
      background: #000;
      overflow: hidden;
      touch-action: pan-y;
      transition: background 120ms ease, opacity 200ms ease;
    }

    .bunker-row.bunker-delete-pending {
      border-color: rgba(180, 20, 20, 0.78) !important;
    }
    .bunker-row.bunker-delete-finalizing {
      opacity: 0;
    }

    .bunker-row-content {
      padding: 10px;
      transform: translateX(var(--x));
      transition: transform 120ms ease;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .bunker-row-left {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      opacity: var(--fade, 1);
      transition: opacity 120ms ease;
    }

    .bunker-link,
    .bunker-link:visited,
    .bunker-link:hover {
      color: #fff !important;
      text-decoration-line: underline;
      text-decoration-style: dotted;
      text-decoration-color: currentColor;
      text-underline-offset: 3px;
      display: block;
      word-break: break-word;
      transition: color 140ms ease;
    }

    .bunker-read .bunker-link,
    .bunker-read .bunker-link:visited,
    .bunker-read .bunker-link:hover {
      color: rgba(255,255,255,0.62) !important;
      text-decoration-color: currentColor;
    }

    .bunker-unread-preview .bunker-link,
    .bunker-unread-preview .bunker-link:visited,
    .bunker-unread-preview .bunker-link:hover {
      color: #fff !important;
    }

    .bunker-meta {
      font-size: 12px;
      color: rgba(255,255,255,0.62);
      word-break: break-word;
    }

    .bunker-deleted-title {
      font-weight: 600;
      color: rgba(255,255,255,0.92);
      border-bottom: 1px solid rgba(0,0,0,0);
    }

    /* Action buttons: visible by default (fine/coarse pointer) */
    .bunker-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-shrink: 0;
    }

    /* On coarse-pointer (touch) devices, hide the icon buttons but keep
       undo visible. Swipe gestures replace read/delete buttons. */
    @media (pointer: coarse) {
      .bunker-actions .bunker-iconbtn {
        display: none;
      }
    }

    .bunker-iconbtn {
      width: 34px;
      height: 34px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.22);
      background: #000;
      color: #fff;
      font-size: 16px;
      display: grid;
      place-items: center;
      padding: 0;
    }
    .bunker-iconbtn:active { border-style: dashed; transform: scale(0.98); }

    .bunker-undo-btn {
      border: 1px solid rgba(180, 20, 20, 0.78);
      background: #000;
      color: #fff;
      padding: 8px 10px;
      border-radius: 10px;
      font-size: 13px;
      white-space: nowrap;
    }
    .bunker-undo-btn:active { border-style: dashed; transform: scale(0.98); }

    .bunker-empty {
      opacity: 0.6;
      text-align: center;
      padding: 18px 0;
      border: 1px dashed rgba(255,255,255,0.22);
      border-radius: 10px;
      margin-bottom: 8px;
    }

    .bunker-bottom {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(255,255,255,0.14);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }

    .bunker-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid rgba(255,255,255,0.22);
      border-radius: 10px;
      padding: 8px 10px;
      user-select: none;
      -webkit-user-select: none;
      font-size: 14px;
    }
    .bunker-toggle input { width: 16px; height: 16px; accent-color: #fff; }

    .bunker-save {
      border: 1px solid rgba(255,255,255,0.22);
      background: #000;
      color: #fff;
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 14px;
      touch-action: manipulation;
    }
    .bunker-save:active { border-style: dashed; transform: scale(0.98); }
    .bunker-disabled { opacity: 0.35; }
    .bunker-save.bunker-disabled { pointer-events: none; }
  `);

  // ----------------------------
  // Boot
  // ----------------------------
  normalizeBookmarks();

  // Update chapter tracking whenever the user visits a saved work,
  // even if they never open the panel on this page.
  refreshIfCurrentWorkIsSaved();

  createButton();
  installScroll(btn);
  createPanel();
  installOutsideDismiss();

  if (isBunkerHash) togglePanel(true);
})();
