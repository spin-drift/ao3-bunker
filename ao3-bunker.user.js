// ==UserScript==
// @name         AO3 Bunker
// @namespace    http://tampermonkey.net/
// @version      2.11
// @description  AO3 reading list and scroll-saver
// @match        https://archiveofourown.org/*
// @downloadURL  https://greasyfork.org/en/scripts/567423-ao3-bunker
// ==/UserScript==

// big thanks to lizzie

(function () {
    'use strict';

    // ============================================================
    // CONFIG -- edit these if you want to tweak behavior
    // ============================================================
    var TITLE = 'the bunker \u{1F607}'; // Titlebar text
    var UNDO_MS = 2500; // Time (ms) to undo a delete
    var SCROLL_SAVE_MS = 500; // Save scroll after this many ms of no scrolling
    var SCROLL_KEEP_DAYS = 30; // Expire saved positions after this many days
    var SCROLL_ANIMATE = true; // Smooth-scroll to saved position on restore
    var SCROLL_ANIMATE_MS = 1000; // Duration (in ms) of the scroll animation
    var SCROLL_POLL_INTERVAL = 100; // Time (in ms) between page-height checks before restoring
    var SCROLL_POLL_MAX = 2000; // Time (in ms) to wait for page to be tall enough
    // ============================================================

    var STORAGE_KEY = 'ao3_bunker';
    var PREFS_KEY = 'ao3_bunker_prefs';
    var SCROLL_KEY = 'ao3_bunker_scroll';

    var params = new URLSearchParams(location.search);

    var isAdultGate = params.get('view_adult') === 'true';
    var isWorkPage = /^\/works\/\d+/.test(location.pathname) && !isAdultGate;
    var isHomePage = location.pathname === '/' || location.pathname === '/index';
    var isBunkerHash = location.hash === '#bunker';

    if (!(isHomePage || isWorkPage || isAdultGate || isBunkerHash)) return;

    // ----------------------------
    // URL normalization
    // Extract a stable work ID from the path so that
    // /works/12345, /works/12345?view_adult=true, /works/12345/chapters/6789
    // all resolve to the same canonical URL and workId.
    // ----------------------------
    function extractWorkId(url) {
        try {
            var u = new URL(url, location.origin);
            var m = u.pathname.match(/^\/works\/(\d+)/);
            return m ? m[1] : null;
        } catch (e) { return null; }
    }

    function canonicalWorkUrl(url) {
        var id = extractWorkId(url);
        return id ? location.origin + '/works/' + id : url;
    }

    var isFullWorkView = params.get('view_full_work') === 'true';

    function cleanChapterUrl() {
        var m = location.pathname.match(/^(\/works\/\d+(?:\/chapters\/\d+)?)/);
        var base = m ? location.origin + m[1] : canonicalWorkUrl(location.href);
        if (isFullWorkView) return base + '?view_full_work=true';
        return base;
    }

    // ----------------------------
    // Chapter detection
    // AO3 multi-chapter works have a <select id="selected_id"> dropdown.
    // The selected <option> tells us the current chapter number (by position)
    // and the total count. Single-chapter works lack this element.
    // Full-work view shows all chapters on one page (no chapter to track).
    // ----------------------------
    function extractChapter() {
        if (isFullWorkView) return null;
        var sel = document.querySelector('select#selected_id');
        if (!sel) return null;
        var opts = Array.from(sel.options);
        var idx = sel.selectedIndex;
        if (idx < 0 || !opts.length) return null;
        return { current: idx + 1, total: opts.length, label: 'Ch. ' + (idx + 1) + '/' + opts.length };
    }

    // ----------------------------
    // Storage
    // ----------------------------
    function LS_getValue(k, d) {
        try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    }
    function LS_setValue(k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { }
    }

    function getBookmarks() {
        var raw = LS_getValue(STORAGE_KEY, []);
        return Array.isArray(raw) ? raw : [];
    }
    function saveBookmarks(b) { LS_setValue(STORAGE_KEY, b); }

    var DEFAULT_PREFS = { hideRead: false, keepPlace: true };

    function getPrefs() {
        var stored = LS_getValue(PREFS_KEY, {});
        return Object.assign({}, DEFAULT_PREFS, stored);
    }
    function savePrefs(p) { LS_setValue(PREFS_KEY, p); }

    var _scrollCache = null;
    function getScrollPositions() {
        if (_scrollCache) return _scrollCache;
        var raw = LS_getValue(SCROLL_KEY, {});
        _scrollCache = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        return _scrollCache;
    }
    function saveScrollPositions(s) {
        _scrollCache = s;
        LS_setValue(SCROLL_KEY, s);
    }

    function normalizeBookmarks() {
        var b = getBookmarks();
        var changed = false;
        var seenIds = new Set();
        var deduped = [];

        for (var i = 0; i < b.length; i++) {
            var item = b[i];
            if (typeof item.savedAt !== 'number' || !Number.isFinite(item.savedAt)) { item.savedAt = Date.now(); changed = true; }
            if (typeof item.readAt !== 'number' && item.readAt !== null) { item.readAt = null; changed = true; }
            if (typeof item.title !== 'string') { item.title = String(item.title || item.url || ''); changed = true; }
            if (typeof item.author !== 'string') { item.author = String(item.author || ''); changed = true; }
            if (typeof item.dateText !== 'string') { item.dateText = String(item.dateText || ''); changed = true; }
            if (typeof item.url !== 'string') { item.url = String(item.url || ''); changed = true; }
            var wid = extractWorkId(item.url);
            if (wid && !item.workId) { item.workId = wid; changed = true; }
            var canon = canonicalWorkUrl(item.url);
            if (canon !== item.url) { item.url = canon; changed = true; }
            var key = item.workId || item.url;
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
        try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { }
    }

    function timeAgo(ts) {
        var n = Number(ts);
        if (!Number.isFinite(n)) return '';
        var s = Math.floor((Date.now() - n) / 1000);
        if (!Number.isFinite(s) || s < 0) return '';
        if (s < 60) return s + 's ago';
        var m = Math.floor(s / 60);
        if (m < 60) return m + 'm ago';
        var h = Math.floor(m / 60);
        if (h < 48) return h + 'h ago';
        var d = Math.floor(h / 24);
        if (d < 14) return d + 'd ago';
        var w = Math.floor(d / 7);
        return w + 'w ago';
    }

    function extractMeta() {
        var titleEl = document.querySelector('h2.title');
        var title = titleEl ? titleEl.textContent.trim().replace(/\s+/g, ' ') : document.title;
        var authorEls = Array.from(document.querySelectorAll("h3.byline a[rel='author']"));
        var author = authorEls.map(function (a) { return a.textContent.trim(); }).filter(Boolean).join(', ');
        var fandomEls = Array.from(document.querySelectorAll('dd.fandom.tags a.tag'));
        var fandom = fandomEls.map(function (a) { return a.textContent.trim(); }).filter(Boolean).join(', ');
        var stats = document.querySelector('dl.stats');
        var dateText = '';
        if (stats) {
            var dts = Array.from(stats.querySelectorAll('dt'));
            var find = function (label) {
                var dt = dts.find(function (d) { return d.textContent.trim().toLowerCase().startsWith(label); });
                if (!dt) return '';
                var dd = dt.nextElementSibling;
                return dd ? dd.textContent.trim().replace(/\s+/g, ' ') : '';
            };
            dateText = find('updated') || find('published') || '';
        }
        return { title: title, author: author, fandom: fandom, dateText: dateText };
    }

    function easeInOutExpo(t) {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        if (t < 0.5) return Math.pow(2, 20 * t - 10) / 2;
        return (2 - Math.pow(2, -20 * t + 10)) / 2;
    }

    // ----------------------------
    // Work identity helpers
    // ----------------------------
    var currentWorkId = extractWorkId(location.href);
    var currentCanonical = canonicalWorkUrl(location.href);
    var currentChapterUrl = cleanChapterUrl();

    function findBookmark(bookmarks, url) {
        var wid = extractWorkId(url);
        if (wid) return bookmarks.find(function (b) { return b.workId === wid; });
        return bookmarks.find(function (b) { return b.url === url; });
    }

    function openBookmark(bookmark) {
        var url = bookmark.chapterUrl || bookmark.url;
        if (!url) return;
        location.href = url;
    }

    // ----------------------------
    // Pending delete state
    // workId|url -> { timeoutId, finalizing }
    // ----------------------------
    const pendingDeletes = new Map();

    function deleteKey(bookmark) { return bookmark.workId || bookmark.url; }
    function isPendingDelete(bookmark) { return pendingDeletes.has(deleteKey(bookmark)); }

    function requestDelete(bookmark) {
        var key = deleteKey(bookmark);
        if (pendingDeletes.has(key)) return;
        var timeoutId = setTimeout(function () {
            var p = pendingDeletes.get(key);
            if (!p) return;
            p.finalizing = true;
            render();
            setTimeout(function () { finalizeDelete(bookmark); }, 220);
        }, UNDO_MS);
        pendingDeletes.set(key, { timeoutId: timeoutId, finalizing: false });
        vibe(18);
        render();
    }

    function undoDelete(bookmark) {
        var key = deleteKey(bookmark);
        var p = pendingDeletes.get(key);
        if (!p) return;
        clearTimeout(p.timeoutId);
        pendingDeletes.delete(key);
        vibe(10);
        render();
    }

    function finalizeDelete(bookmark) {
        var key = deleteKey(bookmark);
        var p = pendingDeletes.get(key);
        if (p) { clearTimeout(p.timeoutId); pendingDeletes.delete(key); }
        var b = getBookmarks();
        var i = b.findIndex(function (x) { return (x.workId || x.url) === key; });
        if (i !== -1) { b.splice(i, 1); saveBookmarks(b); }
        render();
    }

    // ----------------------------
    // Bookmark operations
    // ----------------------------
    function isCurrentWorkSaved(bookmarks) {
        if (!isWorkPage || !currentWorkId) return false;
        return !!bookmarks.find(function (b) { return b.workId === currentWorkId; });
    }

    function isCurrentWorkPendingDelete() {
        return currentWorkId ? pendingDeletes.has(currentWorkId) : false;
    }

    function addCurrentWork() {
        if (!isWorkPage) return { ok: false };
        var bookmarks = getBookmarks();
        if (isCurrentWorkSaved(bookmarks) || isCurrentWorkPendingDelete()) return { ok: false };
        var meta = extractMeta();
        var chapter = extractChapter();
        bookmarks.push({
            url: currentCanonical, workId: currentWorkId,
            title: meta.title, author: meta.author, fandom: meta.fandom, dateText: meta.dateText,
            chapterUrl: currentChapterUrl, chapterLabel: chapter ? chapter.label : null,
            readAt: null, savedAt: Date.now()
        });
        saveBookmarks(bookmarks);
        vibe(10);
        return { ok: true };
    }

    function toggleRead(bookmark) {
        var b = getBookmarks();
        var key = deleteKey(bookmark);
        var item = b.find(function (x) { return (x.workId || x.url) === key; });
        if (!item) return;
        item.readAt = item.readAt ? null : Date.now();
        saveBookmarks(b);
        vibe(8);
    }

    function refreshIfCurrentWorkIsSaved() {
        if (!isWorkPage) return;
        var b = getBookmarks();
        var item = findBookmark(b, location.href);
        if (!item) return;
        var meta = extractMeta();
        var chapter = extractChapter();
        var changed = false;
        if (meta.title && meta.title !== item.title) { item.title = meta.title; changed = true; }
        if (meta.author && meta.author !== item.author) { item.author = meta.author; changed = true; }
        if (meta.fandom && meta.fandom !== item.fandom) { item.fandom = meta.fandom; changed = true; }
        if (meta.dateText && meta.dateText !== item.dateText) { item.dateText = meta.dateText; changed = true; }
        if (currentChapterUrl !== item.chapterUrl) { item.chapterUrl = currentChapterUrl; changed = true; }
        var newLabel = chapter ? chapter.label : null;
        if (newLabel !== item.chapterLabel) { item.chapterLabel = newLabel; changed = true; }
        if (changed) saveBookmarks(b);
    }

    // ----------------------------
    // Scroll position tracking
    // Adapted from "Remember page scroll position" by jcunews
    // https://greasyfork.org/en/users/85671-jcunews
    // https://www.reddit.com/r/userscripts/comments/1ayfnoh/
    // ----------------------------
    var scrollTrackingActive = false;
    var scrollSaveTimer = null;
    var lastSavedX = null;
    var lastSavedY = null;
    var scrollRestoring = false;

    function scrollPageKey() { return currentChapterUrl || currentCanonical; }

    function saveCurrentScrollPosition() {
        if (!isWorkPage) return;
        if (scrollX === lastSavedX && scrollY === lastSavedY) return;
        lastSavedX = scrollX;
        lastSavedY = scrollY;
        var positions = getScrollPositions();
        positions[scrollPageKey()] = { x: scrollX, y: scrollY, ts: Date.now() };
        var maxAge = SCROLL_KEEP_DAYS * 86400000;
        var now = Date.now();
        var keys = Object.keys(positions);
        for (var i = 0; i < keys.length; i++) {
            if (now - positions[keys[i]].ts > maxAge) delete positions[keys[i]];
        }
        saveScrollPositions(positions);
    }

    // Perform the actual scroll (instant or animated)
    function doRestore(rec) {
        if (!SCROLL_ANIMATE || SCROLL_ANIMATE_MS <= 0) {
            scrollRestoring = true;
            scrollTo(rec.x, rec.y);
            if (btn) btn.style.opacity = '0.9';
            requestAnimationFrame(function () { scrollRestoring = false; });
            return;
        }

        var startX = scrollX, startY = scrollY;
        var dx = rec.x - startX, dy = rec.y - startY;
        if (dx === 0 && dy === 0) return;

        var duration = SCROLL_ANIMATE_MS;
        var startTime = null;
        var animating = true;
        var emojiSwapped = false;
        scrollRestoring = true;

        function step(timestamp) {
            if (!animating) return;
            if (!startTime) startTime = timestamp;
            var elapsed = timestamp - startTime;
            var t = Math.min(elapsed / duration, 1);
            var e = easeInOutExpo(t);
            if (!emojiSwapped && t >= 0.2) { setButtonEmoji('\u{1F440}'); emojiSwapped = true; }
            scrollTo(startX + dx * e, startY + dy * e);
            if (t < 1) {
                requestAnimationFrame(step);
            } else {
                animating = false;
                scrollRestoring = false;
                setButtonEmoji('\u{1F4E6}');
                if (btn) btn.style.opacity = '0.9';
            }
        }

        var cancel = function () {
            if (!animating) return;
            animating = false;
            scrollRestoring = false;
            setButtonEmoji('\u{1F4E6}');
            window.removeEventListener('wheel', cancel);
            window.removeEventListener('touchstart', cancel);
        };
        window.addEventListener('wheel', cancel, { once: true, passive: true });
        window.addEventListener('touchstart', cancel, { once: true, passive: true });
        requestAnimationFrame(step);
    }

    // Wait for page to be tall enough, then restore
    function restoreScrollPosition() {
        if (!isWorkPage) return;
        var rec = getScrollPositions()[scrollPageKey()];
        if (!rec || (rec.x === 0 && rec.y === 0)) return;

        // If the page is already tall enough, restore immediately
        if (document.documentElement.scrollHeight >= rec.y + window.innerHeight) {
            doRestore(rec);
            return;
        }

        // Poll until the page is tall enough or we hit the timeout
        var elapsed = 0;
        var poll = setInterval(function () {
            elapsed += SCROLL_POLL_INTERVAL;
            if (document.documentElement.scrollHeight >= rec.y + window.innerHeight || elapsed >= SCROLL_POLL_MAX) {
                clearInterval(poll);
                doRestore(rec);
            }
        }, SCROLL_POLL_INTERVAL);
    }

    function ensureScrollTracking() {
        if (scrollTrackingActive) return;
        scrollTrackingActive = true;
        addEventListener('beforeunload', saveCurrentScrollPosition);
        addEventListener('blur', saveCurrentScrollPosition);
        addEventListener('focus', saveCurrentScrollPosition);
        addEventListener('scroll', function () {
            clearTimeout(scrollSaveTimer);
            scrollSaveTimer = setTimeout(saveCurrentScrollPosition, SCROLL_SAVE_MS);
        });
    }

    function initScrollTracking() {
        if (!isWorkPage) return;
        if (!getPrefs().keepPlace) return;
        ensureScrollTracking();
        restoreScrollPosition();
    }

    // ----------------------------
    // Help overlay state
    // ----------------------------
    var helpOpen = false;

    var HELP_ICON_CLOSED = '<svg xmlns="http://www.w3.org/2000/svg" class="ionicon" viewBox="0 0 512 512"><path d="M256 80a176 176 0 10176 176A176 176 0 00256 80z" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32"/><path d="M200 202.29s.84-17.5 19.57-32.57C230.68 160.77 244 158.18 256 158c10.93-.14 20.69 1.67 26.53 4.45 10 4.76 29.47 16.38 29.47 41.09 0 26-17 37.81-36.37 50.8S251 281.43 251 296" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="28"/><circle cx="250" cy="348" r="20"/></svg>';
    var HELP_ICON_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" class="ionicon" viewBox="0 0 512 512"><path d="M256 64C150 64 64 150 64 256s86 192 192 192 192-86 192-192S362 64 256 64zm-6 304a20 20 0 1120-20 20 20 0 01-20 20zm33.44-102C267.23 276.88 265 286.85 265 296a14 14 0 01-28 0c0-21.91 10.08-39.33 30.82-53.26C287.1 229.8 298 221.6 298 203.57c0-12.26-7-21.57-21.49-28.46-3.41-1.62-11-3.2-20.34-3.09-11.72.15-20.82 2.95-27.83 8.59C215.12 191.25 214 202.83 214 203a14 14 0 11-28-1.35c.11-2.43 1.8-24.32 24.77-42.8 11.91-9.58 27.06-14.56 45-14.78 12.7-.15 24.63 2 32.72 5.82C312.7 161.34 326 180.43 326 203.57c0 33.83-22.61 49.02-42.56 62.43z"/></svg>';

    var HELP_CONTENT =
        '<p><a href="https://github.com/spin-drift/ao3-bunker/issues" target="_blank">Bugs and requests</a> \u00B7 ' +
        'Love it? Please consider <a href="https://buymeacoffee.com/spindrift" target="_blank">donating!</a>' +
        '<br/>(Scroll down for usage instructions)</p>' +
        '<p><strong>Mobile:</strong> Swipe right on a row to toggle read/unread. Swipe left to delete/undo (before timer runs out).' +
        '<br/><strong>Desktop:</strong> Just use the buttons. :)' +
        '<br/><strong>Keep place</strong> saves and restores your scroll position on fic pages.' +
        '<br/>Add <strong style="font-family:monospace;">#bunker</strong> to the end of any AO3 URL to start with the list open.</p>' +
        '<p>Data is stored locally in your browser and never leaves your device.</p>' +
        '<p><3, spindrift</p>';

    function setHelpOpen(open) {
        helpOpen = open;
        var helpEl = document.getElementById('bunker-help-overlay');
        var helpBtn = document.getElementById('bunker-help-btn');
        if (!helpEl || !helpBtn) return;
        helpEl.style.display = open ? 'block' : 'none';
        helpBtn.innerHTML = open ? HELP_ICON_OPEN : HELP_ICON_CLOSED;
        helpBtn.title = open ? 'Close help' : 'Help';
    }

    // ----------------------------
    // UI
    // ----------------------------
    var panelOpen = false;
    var btn;

    function setButtonEmoji(emoji) { if (btn) btn.textContent = emoji; }

    function createButton() {
        btn = document.createElement('button');
        btn.id = 'bunker-btn';
        btn.textContent = '\u{1F4E6}';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Toggle bunker');
        btn.addEventListener('click', function () { togglePanel(); });
        document.body.appendChild(btn);
    }

    function createPanel() {
        var panel = document.createElement('div');
        panel.id = 'bunker-panel';
        panel.style.display = 'none';

        panel.innerHTML =
            '<div class="bunker-titlebar">' +
            '<span class="bunker-titlebar-text">' + TITLE + '</span>' +
            '<button type="button" id="bunker-help-btn" class="bunker-iconbtn bunker-help-btn" title="Help">' + HELP_ICON_CLOSED + '</button>' +
            '</div>' +
            '<div class="bunker-listwrap" id="bunker-listwrap">' +
            '<div class="bunker-list" id="bunker-list"></div>' +
            '<div class="bunker-help-overlay" id="bunker-help-overlay" style="display:none">' +
            '<div class="bunker-help-content">' + HELP_CONTENT + '</div>' +
            '</div>' +
            '</div>' +
            '<div class="bunker-bottom">' +
            '<div class="bunker-bottom-left">' +
            '<div class="bunker-btngroup" id="bunker-filter">' +
            '<button type="button" data-value="all" class="bunker-btngroup-opt">All</button>' +
            '<button type="button" data-value="unread" class="bunker-btngroup-opt">Unread</button>' +
            '</div>' +
            '<label class="bunker-toggle" id="bunker-keep-place">' +
            '<input type="checkbox" id="bunker-keep-place-cb">' +
            '<span>Keep place</span>' +
            '</label>' +
            '</div>' +
            '<button class="bunker-save" id="bunker-save" type="button">Save this work</button>' +
            '</div>';

        document.body.appendChild(panel);
        var prefs = getPrefs();

        // Help button
        var helpBtn = panel.querySelector('#bunker-help-btn');
        helpBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            setHelpOpen(!helpOpen);
        });

        // Click inside panel but outside help overlay dismisses help
        panel.addEventListener('click', function (e) {
            if (!helpOpen) return;
            var helpEl = document.getElementById('bunker-help-overlay');
            var helpBtn = document.getElementById('bunker-help-btn');
            if (helpEl && helpEl.contains(e.target)) return;
            if (helpBtn && helpBtn.contains(e.target)) return;
            setHelpOpen(false);
        });

        // Filter
        var filterGroup = panel.querySelector('#bunker-filter');
        syncButtonGroup(filterGroup, prefs.hideRead ? 'unread' : 'all');
        filterGroup.addEventListener('click', function (e) {
            var opt = e.target.closest('[data-value]');
            if (!opt) return;
            syncButtonGroup(filterGroup, opt.dataset.value);
            var p = getPrefs();
            p.hideRead = (opt.dataset.value === 'unread');
            savePrefs(p);
            render();
            scrollListToBottom();
        });

        // Keep place
        var keepCb = panel.querySelector('#bunker-keep-place-cb');
        keepCb.checked = prefs.keepPlace;
        keepCb.addEventListener('change', function () {
            var p = getPrefs();
            p.keepPlace = keepCb.checked;
            savePrefs(p);
            if (p.keepPlace && !scrollTrackingActive) {
                ensureScrollTracking();
                saveCurrentScrollPosition();
            }
        });

        // Save
        var saveBtn = panel.querySelector('#bunker-save');
        saveBtn.addEventListener('click', function () {
            if (saveBtn.disabled) return;
            if (!addCurrentWork().ok) return;
            render();
            scrollListToBottom();
        });
    }

    function syncButtonGroup(groupEl, activeValue) {
        var opts = groupEl.querySelectorAll('[data-value]');
        for (var i = 0; i < opts.length; i++) {
            opts[i].classList.toggle('bunker-btngroup-active', opts[i].dataset.value === activeValue);
        }
    }

    function scrollListToBottom() {
        var list = document.getElementById('bunker-list');
        if (list) list.scrollTop = list.scrollHeight;
    }

    function togglePanel(force) {
        var panel = document.getElementById('bunker-panel');
        if (!panel) return;
        panelOpen = (typeof force === 'boolean') ? force : !panelOpen;
        panel.style.display = panelOpen ? 'block' : 'none';
        document.documentElement.classList.toggle('bunker-lock-scroll', panelOpen);
        document.body.classList.toggle('bunker-lock-scroll', panelOpen);
        if (panelOpen) {
            refreshIfCurrentWorkIsSaved();
            render();
            scrollListToBottom();
            btn.style.opacity = '0.9';
        } else {
            setHelpOpen(false);
        }
    }

    function installOutsideDismiss() {
        document.addEventListener('pointerdown', function (e) {
            if (!panelOpen) return;
            var panel = document.getElementById('bunker-panel');
            if (!panel) return;
            if (panel.contains(e.target)) return;
            if (btn && (btn === e.target || btn.contains(e.target))) return;
            togglePanel(false);
        }, true);
    }

    // ----------------------------
    // Render
    // ----------------------------
    function render() {
        var list = document.getElementById('bunker-list');
        var saveBtn = document.getElementById('bunker-save');
        if (!list || !saveBtn) return;

        var bookmarks = getBookmarks();

        // Gray out "Save this work" on adult gate pages and any other
        // non-work page (home, search, user profiles, etc.) the panel might open on.
        if (!isWorkPage) {
            saveBtn.disabled = true;
            saveBtn.classList.add('bunker-disabled');
            saveBtn.textContent = 'Save this work';
        } else {
            var saved = isCurrentWorkSaved(bookmarks);
            var pendingDel = isCurrentWorkPendingDelete();
            var disabled = saved || pendingDel;
            saveBtn.disabled = disabled;
            saveBtn.classList.toggle('bunker-disabled', disabled);
            saveBtn.textContent = disabled ? 'Saved' : 'Save this work';
        }

        var prefs = getPrefs();
        var ordered = bookmarks.slice().sort(function (a, b) { return (a.savedAt || 0) - (b.savedAt || 0); });
        var visible = prefs.hideRead ? ordered.filter(function (b) { return !b.readAt; }) : ordered;

        list.innerHTML = '';

        if (!visible.length) {
            list.innerHTML = '<div class="bunker-empty">Nothing here yet.</div>';
            return;
        }

        for (var i = 0; i < visible.length; i++) {
            var b = visible[i];
            var key = deleteKey(b);
            var p = pendingDeletes.get(key);
            var pending = isPendingDelete(b);
            var finalizing = !!(p && p.finalizing);

            var row = document.createElement('div');
            row.className = 'bunker-row';
            row.style.setProperty('--x', '0px');
            row.style.setProperty('--fade', '1');

            if (pending) row.classList.add('bunker-pending');
            if (finalizing) row.classList.add('bunker-finalizing');
            if (b.readAt) row.classList.add('bunker-read');
            if (pending && !finalizing) row.style.setProperty('--undo-ms', UNDO_MS + 'ms');

            var content = document.createElement('div');
            content.className = 'bunker-row-content';

            var left = document.createElement('div');
            left.className = 'bunker-row-left';
            left.dataset.href = (b.chapterUrl || b.url);

            left.addEventListener('click', (function (bk) {
                return function (e) {
                    if (e.target.closest('button')) return;
                    if (e.target.closest('a')) return;
                    if (isPendingDelete(bk)) return;
                    openBookmark(bk);
                };
            })(b));

            var titleEl;
            if (pending) {
                titleEl = document.createElement('div');
                titleEl.className = 'bunker-title';
                titleEl.textContent = b.title;
            } else {
                titleEl = document.createElement('a');
                titleEl.className = 'bunker-title';
                titleEl.href = b.chapterUrl || b.url;
                titleEl.target = '_self';
                titleEl.rel = 'noopener noreferrer';
                titleEl.textContent = b.title;
            }
            left.appendChild(titleEl);

            var sep = document.createElement('div');
            sep.className = 'bunker-sep';
            if (pending && !finalizing) sep.classList.add('bunker-sep-timer');
            left.appendChild(sep);

            var meta = document.createElement('div');
            meta.className = 'bunker-meta';
            var parts = [];
            if (b.chapterLabel) parts.push(b.chapterLabel);
            if (b.fandom) parts.push(b.fandom);
            if (b.author) parts.push(b.author);
            if (b.dateText) parts.push(b.dateText);
            var ago = timeAgo(b.savedAt);
            if (ago) parts.push(ago);
            meta.textContent = parts.join(' \u00B7 ');
            if (parts.length) left.appendChild(meta);

            content.appendChild(left);

            var actions = document.createElement('div');
            actions.className = 'bunker-actions';

            if (pending) {
                var undoBtn = document.createElement('button');
                undoBtn.className = 'bunker-iconbtn bunker-undo';
                undoBtn.type = 'button';
                undoBtn.textContent = 'Undo';
                undoBtn.title = 'Undo delete';
                undoBtn.addEventListener('click', (function (bk) {
                    return function () { undoDelete(bk); };
                })(b));
                actions.appendChild(undoBtn);
            } else {
                var readBtn = document.createElement('button');
                var readIcon = '<svg xmlns="http://www.w3.org/2000/svg" class="ionicon" viewBox="0 0 512 512"><path d="M320 146s24.36-12-64-12a160 160 0 10160 160" fill="none" stroke="currentColor" stroke-linecap="round" stroke-miterlimit="10" stroke-width="32"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32" d="M256 58l80 80-80 80"/></svg>';
                var unreadIcon = '<svg xmlns="http://www.w3.org/2000/svg" class="ionicon" viewBox="0 0 512 512"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32" d="M416 128L192 384l-96-96"/></svg>';
                readBtn.className = 'bunker-iconbtn';
                readBtn.type = 'button';
                readBtn.innerHTML = b.readAt ? readIcon : unreadIcon;
                readBtn.title = b.readAt ? 'Mark unread' : 'Mark read';
                readBtn.addEventListener('click', (function (bk) {
                    return function () { toggleRead(bk); render(); };
                })(b));

                var delBtn = document.createElement('button');
                var delIcon = '<svg xmlns="http://www.w3.org/2000/svg" class="ionicon" viewBox="0 0 512 512"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="32" d="M368 368L144 144M368 144L144 368"/></svg>';
                delBtn.className = 'bunker-iconbtn';
                delBtn.type = 'button';
                delBtn.innerHTML = delIcon;
                delBtn.title = 'Delete';
                delBtn.addEventListener('click', (function (bk) {
                    return function () { requestDelete(bk); };
                })(b));

                actions.appendChild(readBtn);
                actions.appendChild(delBtn);
            }

            content.appendChild(actions);
            row.appendChild(content);

            installSwipeHandlers(row, b);

            list.appendChild(row);
        }
    }

    // ----------------------------
    // Swipe/tap handling
    // ----------------------------
    function installSwipeHandlers(rowEl, bookmark) {
        var startX = 0, startY = 0;
        var lastX = 0, lastY = 0;
        var tracking = false;
        var locked = null;
        var moved = false;

        var SWIPE_COMMIT_PX = 70;
        var LOCK_PX = 10;

        var contentEl = rowEl.querySelector('.bunker-row-content');

        function resetVisuals() {
            contentEl.classList.remove('bunker-dragging');
            rowEl.style.setProperty('--x', '0px');
            rowEl.style.setProperty('--fade', '1');
            rowEl.classList.remove('bunker-read-fading', 'bunker-unread-preview');
            rowEl.style.background = '#000';
        }

        function onStart(e) {
            var t = e.touches && e.touches[0];
            if (!t) return;
            tracking = true;
            moved = false;
            locked = null;
            startX = lastX = t.clientX;
            startY = lastY = t.clientY;
            resetVisuals();
        }

        function onMove(e) {
            if (!tracking) return;
            var t = e.touches && e.touches[0];
            if (!t) return;
            lastX = t.clientX;
            lastY = t.clientY;

            var dx = lastX - startX;
            var dy = lastY - startY;

            if (locked === null) {
                if (Math.abs(dx) > LOCK_PX || Math.abs(dy) > LOCK_PX) {
                    locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
                }
            }
            if (locked !== 'h') return;

            contentEl.classList.add('bunker-dragging');

            moved = true;
            e.preventDefault();

            var clamped = Math.max(-120, Math.min(120, dx));
            rowEl.style.setProperty('--x', clamped + 'px');

            if (clamped < 0) {
                var intensity = Math.min(Math.abs(clamped) / 120, 1);
                rowEl.style.background =
                    'linear-gradient(to left, rgba(140,0,0,' + (0.10 + intensity * 0.18) + '), rgba(140,0,0,' + (0.22 + intensity * 0.34) + '))';
                rowEl.style.setProperty('--fade', '1');
                rowEl.classList.remove('bunker-unread-preview');
            } else if (clamped > 0) {
                rowEl.style.background = '#000';
                rowEl.classList.add('bunker-read-fading');
                if (!bookmark.readAt) {
                    rowEl.style.setProperty('--fade', String(1 - Math.min(clamped / 150, 0.6)));
                    rowEl.classList.remove('bunker-unread-preview');
                } else {
                    rowEl.style.setProperty('--fade', String(0.62 + (1 - 0.62) * Math.min(clamped / 140, 1)));
                    rowEl.classList.add('bunker-unread-preview');
                }
            } else {
                resetVisuals();
            }
        }

        function onEnd() {
            if (!tracking) return;
            tracking = false;

            var dx = lastX - startX;
            var dy = lastY - startY;

            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < LOCK_PX && !moved && !isPendingDelete(bookmark)) {
                openBookmark(bookmark);
                return;
            }

            if (Math.abs(dx) < Math.abs(dy)) { resetVisuals(); return; }

            if (dx > SWIPE_COMMIT_PX) {
                toggleRead(bookmark);
                render();
            } else if (dx < -SWIPE_COMMIT_PX) {
                if (isPendingDelete(bookmark)) { undoDelete(bookmark); }
                else { requestDelete(bookmark); }
            }

            resetVisuals();
        }

        rowEl.addEventListener('touchstart', onStart, { passive: true });
        rowEl.addEventListener('touchmove', onMove, { passive: false });
        rowEl.addEventListener('touchend', onEnd, { passive: true });
        rowEl.addEventListener('touchcancel', onEnd, { passive: true });
    }

    // ----------------------------
    // FAB scroll behavior
    // ----------------------------
    function installScroll(btnEl) {
        if (isHomePage) { btnEl.style.opacity = '0.9'; return; }
        if (!isWorkPage) return;
        var lastY = window.scrollY;
        var lastT = Date.now();

        window.addEventListener('scroll', function () {
            if (panelOpen || scrollRestoring) { btnEl.style.opacity = '0.9'; lastY = window.scrollY; return; }
            var now = Date.now();
            if (now - lastT < 60) return;
            lastT = now;
            var y = window.scrollY;
            var dy = y - lastY;
            if (dy > 8) btnEl.style.opacity = '0';
            else if (dy < -12) btnEl.style.opacity = '0.9';
            if (y < 20) btnEl.style.opacity = '0.9';
            lastY = y;
        }, { passive: true });
    }

    // ----------------------------
    // Styles
    // ----------------------------
    (function () {
        'use strict';

        const css = [
            '.bunker-lock-scroll { overflow: hidden !important; overscroll-behavior: none !important; }',

            /* FAB */
            '#bunker-btn {',
            '  position: fixed; bottom: 16px; right: 16px;',
            '  width: 44px; height: 44px;',
            '  border-radius: 50% !important; aspect-ratio: 1/1;',
            '  border: 1px solid rgba(255,255,255,0.26);',
            '  background: #000; color: #fff; font-size: 18px;',
            '  z-index: 999999; opacity: 0.9;',
            '  transition: opacity 0.18s ease, transform 0.18s ease;',
            '  touch-action: manipulation; padding: 0;',
            '  box-shadow: 0 0 0 1px rgba(255,255,255,0.05);',
            '}',
            '#bunker-btn:active { transform: scale(0.96); border-style: dashed; }',

            /* Panel */
            '#bunker-panel {',
            '  position: fixed; left: 10px; right: 10px; bottom: 70px;',
            '  z-index: 999999; background: #000; color: #fff;',
            '  border: 1px solid rgba(255,255,255,0.30);',
            '  box-shadow: 0 10px 34px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,255,255,0.06);',
            '  border-radius: 12px; padding: 12px;',
            '  display: none; max-width: 800px;',
            '}',
            '@media (min-width: 840px) { #bunker-panel { left: auto; } }',

            /* Titlebar */
            '.bunker-titlebar {',
            '  display: flex; align-items: center; justify-content: space-between;',
            '  padding-bottom: 8px;',
            '  border-bottom: 1px solid rgba(255,255,255,0.14);',
            '  margin-bottom: 10px;',
            '}',
            '.bunker-titlebar-text {',
            '  font-weight: 600; font-size: 20px; line-height: 1.15;',
            '}',
            '.bunker-help-btn {',
            '  width: 28px !important; height: 28px !important;',
            '  border-radius: 8px !important;',
            '  flex-shrink: 0; opacity: 0.70;',
            '  transition: opacity 120ms ease, border-color 120ms ease;',
            '}',
            '.bunker-help-btn:hover { opacity: 1; }',
            '.bunker-help-btn.active { opacity: 1; border-color: rgba(255,255,255,0.50); }',

            /* List wrapper -- the positioning context for the overlay */
            '.bunker-listwrap {',
            '  position: relative;',
            '  max-height: 220px; overflow: hidden;',
            '}',
            '.bunker-list {',
            '  max-height: 220px; overflow-y: auto;',
            '  overscroll-behavior: contain; -webkit-overflow-scrolling: touch;',
            '  padding-right: 2px;',
            '}',

            /* Help overlay */
            '.bunker-help-overlay {',
            '  position: absolute; inset: 0;',
            '  background: #000;',
            '  border-radius: 8px;',
            '  overflow-y: auto;',
            '  overscroll-behavior: contain; -webkit-overflow-scrolling: touch;',
            '  z-index: 2;',
            '}',
            '.bunker-help-content {',
            '  padding: 4px 2px 4px 2px;',
            '  font-size: 13px; line-height: 1.55;',
            '  color: rgba(255,255,255,0.80);',
            '}',
            '.bunker-help-content p { margin: 0 0 10px 0; }',
            '.bunker-help-content p:last-child { margin-bottom: 0; }',
            '.bunker-help-content strong { color: #fff; font-weight: 600; }',
            '.bunker-help-content a, .bunker-help-content a:visited { color: #fff; }',
            '.bunker-help-content a:hover { color: #999; }',

            /* Row */
            '.bunker-row {',
            '  border: 1px solid rgba(255,255,255,0.10);',
            '  border-radius: 10px; margin-bottom: 8px;',
            '  background: #000; overflow: hidden; touch-action: pan-y;',
            '  transition: background 120ms ease, opacity 200ms ease, border-color 120ms ease;',
            '}',
            '.bunker-row.bunker-pending, .bunker-row.bunker-pending:hover { border-color: rgba(180,20,20,0.50); }',
            '.bunker-row.bunker-finalizing { opacity: 0; }',
            '.bunker-row a, .bunker-row a:link, .bunker-row a:visited:hover { text-decoration: none !important; border-bottom: none; }',

            /* Desktop hover */
            '@media (pointer: fine) {',
            '  .bunker-row:hover { border-color: rgba(255,255,255,0.22); }',
            '  .bunker-row-left { cursor: pointer; }',
            '}',

            '.bunker-row-content {',
            '  padding: 10px;',
            '  transform: translateX(var(--x));',
            '  transition: transform 120ms ease;',
            '  display: flex; align-items: flex-start;',
            '  justify-content: space-between; gap: 10px;',
            '  touch-action: pan-y;',
            '}',

            /* No transition while actively dragging -- prevents jitter */
            '.bunker-row-content.bunker-dragging { transition: none; }',

            '.bunker-row-left {',
            '  flex: 1; min-width: 0;',
            '  display: flex; flex-direction: column; gap: 0;',
            '  opacity: var(--fade, 1); transition: opacity 120ms ease;',
            '}',

            /* Title */
            '.bunker-title {',
            '  display: block; word-break: break-word;',
            '  color: #fff !important; text-decoration: none !important;',
            '  transition: color 140ms ease;',
            '}',
            '.bunker-read .bunker-title { color: rgba(255,255,255,0.62) !important; }',
            '.bunker-unread-preview .bunker-title { color: #fff !important; }',
            '.bunker-pending .bunker-title { color: rgba(200,80,80,0.92) !important; }',

            /* Separator line */
            '.bunker-sep {',
            '  height: 1px; margin: 4px 0;',
            '  background: #fff;',
            '}',
            '.bunker-read .bunker-sep { background: rgba(255,255,255,0.62); }',
            '.bunker-sep-timer {',
            '  background: rgba(180,20,20,0.78) !important;',
            '  transform-origin: left;',
            '  animation: bunker-timer var(--undo-ms, 5000ms) linear forwards;',
            '}',
            '@keyframes bunker-timer {',
            '  from { transform: scaleX(1); }',
            '  to   { transform: scaleX(0); }',
            '}',

            /* Meta */
            '.bunker-meta {',
            '  font-size: 12px; color: rgba(255,255,255,0.62); word-break: break-word;',
            '}',
            '.bunker-pending .bunker-meta { color: rgba(200,80,80,0.55); }',

            /* Actions */
            '.bunker-actions {',
            '  display: flex; gap: 8px; align-items: center; flex-shrink: 0;',
            '}',
            '@media (pointer: coarse) {',
            '  .bunker-actions .bunker-iconbtn { display: none; }',
            '}',
            '.ionicon { width: 20px; fill: #fff; }',

            '.bunker-iconbtn {',
            '  width: 34px; height: 34px; border-radius: 10px;',
            '  border: 1px solid rgba(255,255,255,0.22);',
            '  background: #000; color: #fff; font-size: 16px;',
            '  display: grid; place-items: center; padding: 0;',
            '}',
            '.bunker-iconbtn:active { border-style: dashed; transform: scale(0.98); }',

            '.bunker-undo {',
            '  width: 78px; font-size: 13px;',
            '  border-color: rgba(180,20,20,0.60);',
            '}',

            '.bunker-empty {',
            '  opacity: 0.6; text-align: center; padding: 18px 0;',
            '  border: 1px dashed rgba(255,255,255,0.22);',
            '  border-radius: 10px; margin-bottom: 8px;',
            '}',

            /* Bottom bar */
            '.bunker-bottom {',
            '  margin-top: 10px; padding-top: 10px;',
            '  border-top: 1px solid rgba(255,255,255,0.14);',
            '  display: flex; justify-content: space-between;',
            '  align-items: center; gap: 8px;',
            '}',
            '.bunker-bottom-left {',
            '  display: flex; align-items: center; gap: 8px;',
            '}',

            /* Button group */
            '.bunker-btngroup {',
            '  display: inline-flex;',
            '  border: 1px solid rgba(255,255,255,0.22);',
            '  border-radius: 10px; overflow: hidden; flex-shrink: 0;',
            '}',
            '.bunker-btngroup, .bunker-toggle {',
            '  height: 34px;',
            '  box-sizing: border-box;',
            '  display: inline-flex;',
            '  align-items: center;',
            '}',
            '.bunker-btngroup-opt {',
            '  background: #000; color: rgba(255,255,255,0.55);',
            '  border: none;',
            '  height: 100%;',
            '  display: inline-flex;',
            '  align-items: center;',
            '  line-height: 1;',
            '  padding: 0 10px;',
            '  font-size: 13px;',
            '  cursor: pointer;',
            '  transition: color 100ms ease, background 100ms ease;',
            '  white-space: nowrap;',
            '}',
            '.bunker-btngroup-opt:first-child { border-radius: 9px 0 0 9px; }',
            '.bunker-btngroup-opt:last-child  { border-radius: 0 9px 9px 0; }',
            '.bunker-btngroup-opt + .bunker-btngroup-opt {',
            '  border-left: 1px solid rgba(255,255,255,0.22);',
            '}',
            '.bunker-btngroup-opt.bunker-btngroup-active {',
            '  color: #fff; background: rgba(255,255,255,0.10);',
            '}',
            '.bunker-btngroup-opt:active { transform: scale(0.98); }',

            /* Keep-place toggle */
            '.bunker-toggle {',
            '  display: inline-flex; align-items: center; gap: 8px;',
            '  border: 1px solid rgba(255,255,255,0.22);',
            '  border-radius: 10px; height: 34px; padding: 0 10px;',
            '  font-size: 13px; color: rgba(255,255,255,0.55);',
            '  user-select: none; -webkit-user-select: none;',
            '  white-space: nowrap; flex-shrink: 0; cursor: pointer;',
            '}',
            '.bunker-toggle input {',
            '  appearance: none; -webkit-appearance: none;',
            '  width: 12px; height: 12px; margin: 0;',
            '  border: 1px solid rgba(255,255,255,0.40);',
            '  border-radius: 3px; background: transparent;',
            '  display: grid; place-items: center; flex-shrink: 0;',
            '}',
            '.bunker-toggle input:checked::after {',
            '  content: ""; width: 6px; height: 6px;',
            '  border-radius: 1px; background: rgba(255,255,255,0.70);',
            '}',

            /* Save button */
            '.bunker-save {',
            '  border: 1px solid rgba(255,255,255,0.22);',
            '  background: #000; color: #fff;',
            '  padding: 8px 10px; border-radius: 10px;',
            '  font-size: 13px; touch-action: manipulation;',
            '  white-space: nowrap; flex-shrink: 0;',
            '}',
            '.bunker-save:active { border-style: dashed; transform: scale(0.98); }',
            '.bunker-disabled { opacity: 0.35; }',
            '.bunker-save.bunker-disabled { pointer-events: none; }',
        ].join('\n');

        const style = document.createElement('style');
        style.textContent = css;
        const target = document.head || document.documentElement;
        if (target) {
            target.appendChild(style);
        } else {
            const observer = new MutationObserver(() => {
                if (document.head || document.documentElement) {
                    (document.head || document.documentElement).appendChild(style);
                    observer.disconnect();
                }
            });
            observer.observe(document, { childList: true, subtree: true });
        }
    })();

    // ----------------------------
    // Boot
    // ----------------------------
    normalizeBookmarks();

    refreshIfCurrentWorkIsSaved();
    createButton();
    installScroll(btn);
    createPanel();
    installOutsideDismiss();
    initScrollTracking();
    if (isBunkerHash) togglePanel(true);
})();
