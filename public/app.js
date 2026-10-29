(() => {
  "use strict";

  const ICONS = {
    heart: `<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.3C.5 8.2 2.3 5 5.6 5 7.9 5 9.6 6.3 12 9c2.4-2.7 4.1-4 6.4-4 3.3 0 5.1 3.2 3.6 6.7C19.5 16.4 12 21 12 21z"/></svg>`,
    note: `<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    share: `<svg viewBox="0 0 24 24"><path d="M12 3v12M12 3l4 4M12 3 8 7M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`,
  };

  const LS_LIKES = "gatha:likes";
  const LS_NOTES = "gatha:notes";
  const LS_LAST_READ = "gatha:lastRead";

  const onboarding = document.getElementById("onboarding");
  const startBtn = document.getElementById("startBtn");
  const feedEl = document.getElementById("feed");
  const sheet = document.getElementById("sheet");
  const sheetBackdrop = document.getElementById("sheetBackdrop");
  const sheetClose = document.getElementById("sheetClose");
  const chaptersSheet = document.getElementById("chaptersSheet");
  const chaptersBackdrop = document.getElementById("chaptersBackdrop");
  const chaptersClose = document.getElementById("chaptersClose");
  const chapterListEl = document.getElementById("chapterList");
  const chapterSearchEl = document.getElementById("chapterSearch");
  const chapterSearchResultsEl = document.getElementById("chapterSearchResults");
  const chapterSearchStatusEl = document.getElementById("chapterSearchStatus");
  const moreTextsBlockEl = document.getElementById("moreTextsBlock");
  const moreTextsDividerEl = document.getElementById("moreTextsDivider");
  const keptSheet = document.getElementById("keptSheet");
  const keptBackdrop = document.getElementById("keptBackdrop");
  const keptClose = document.getElementById("keptClose");
  const keptListEl = document.getElementById("keptList");
  const keptListStatusEl = document.getElementById("keptListStatus");

  let verses = [];
  let renderedCount = 0;
  const BATCH = 16;
  let sentinel = null;
  let io = null;
  let progressBar = null;
  let progressLabel = null;
  let keptBtn = null;
  let chapters = []; // [{ chapter, title, paliName, firstIdx, count }]
  let currentChapter = 1;

  // ---------- Focus trap (keyboard/screen-reader users) ----------
  // None of the three bottom sheets ever moved keyboard focus when they
  // opened. Reproduced live: focusing a verse's Note button with the keyboard
  // and pressing Enter opened the detail sheet, but `document.activeElement`
  // stayed on that same (now visually covered) background button — pressing
  // Tab from there walked through the *next* verse card's action buttons
  // behind the sheet, never reaching the sheet's own close button or its note
  // textarea. A keyboard-only or screen-reader user could open the sheet
  // (Escape already closed it) but had no way to reach anything inside it —
  // the Note feature, one of the app's three primary actions, was completely
  // unusable without a mouse/touch. Fixed with a minimal reusable focus trap:
  // move focus into the sheet on open, cycle Tab/Shift+Tab within it while
  // open, and restore focus to whatever triggered it on close.
  let lastFocusedEl = null;
  let focusTrapHandler = null;

  function focusableElements(container) {
    return [...container.querySelectorAll(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
    )].filter((el) => !el.disabled && el.offsetParent !== null);
  }

  function trapFocusOpen(panelEl) {
    lastFocusedEl = document.activeElement;
    const focusables = focusableElements(panelEl);
    (focusables[0] || panelEl).focus();
    focusTrapHandler = (e) => {
      if (e.key !== "Tab") return;
      const f = focusableElements(panelEl);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", focusTrapHandler);
  }

  function trapFocusClose() {
    if (focusTrapHandler) {
      document.removeEventListener("keydown", focusTrapHandler);
      focusTrapHandler = null;
    }
    if (lastFocusedEl && document.body.contains(lastFocusedEl)) lastFocusedEl.focus();
    lastFocusedEl = null;
  }

  function loadSet(key) {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
    } catch (e) {
      return new Set();
    }
  }
  // Writes must never throw: Safari private browsing (older WebKit) and any
  // browser/profile with storage disabled or quota-exceeded throws a real
  // DOMException from localStorage.setItem. Every caller of saveSet/saveNotes
  // does its own DOM update (button state, kept count, sheet refresh) in the
  // lines right after the write — an uncaught throw here aborted that whole
  // function, so the heart/note icon never visually updated and stayed
  // silently "stuck" on every future tap (confirmed live: tapping Keep with
  // localStorage.setItem throwing left the button reading "Keep" forever).
  // Swallow the error (same pattern loadSet/loadNotes already use for reads,
  // and updateProgress already uses for its own write) so the in-memory state
  // and its UI stay in sync even when nothing can actually persist.
  function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify([...set])); } catch (e) { /* storage unavailable */ }
  }
  function loadNotes() {
    try {
      return JSON.parse(localStorage.getItem(LS_NOTES) || "{}");
    } catch (e) {
      return {};
    }
  }
  function saveNotes(notes) {
    try { localStorage.setItem(LS_NOTES, JSON.stringify(notes)); } catch (e) { /* storage unavailable */ }
  }

  // `likes`/`notes` are reassigned (not const) because every write path below
  // re-reads localStorage immediately before mutating it. The app can be open
  // in more than one tab/window at once — each loads its own in-memory
  // snapshot at page load, and a write from tab B that blindly serializes its
  // stale snapshot silently erases anything tab A already persisted (same
  // bug found + fixed in sibling app Shloka, commit ded1f8a). Re-reading
  // right before each write shrinks that race from "whole session" to
  // milliseconds.
  let likes = loadSet(LS_LIKES);
  let notes = loadNotes();

  async function fetchData() {
    const res = await fetch("/data/dhammapada.json");
    if (!res.ok) throw new Error("failed to load verses");
    return res.json();
  }

  function cardHtml(v, idx) {
    const liked = likes.has(v.id);
    return `
      <section class="verse-card" data-id="${v.id}" data-idx="${idx}" data-chapter="${v.chapter}">
        <div class="verse-inner" data-open="${v.id}">
          <div class="verse-chapter-tag">Chapter ${v.chapter} &middot; ${escapeHtml(v.chapterTitle)}</div>
          <p class="verse-text">${escapeHtml(v.translation)}</p>
          <p class="verse-pali-preview">${escapeHtml(truncate(v.pali, 70))}</p>
        </div>
        <div class="verse-tap-hint">Tap to read Pali &amp; context</div>
        <div class="verse-actions">
          <button class="action-btn like-btn ${liked ? "liked" : ""}" data-id="${v.id}" aria-label="Like">
            ${ICONS.heart}
            <span class="action-count">${liked ? "Kept" : "Keep"}</span>
          </button>
          <button class="action-btn note-btn" data-id="${v.id}" aria-label="Note">
            ${ICONS.note}
            <span class="action-count">${notes[v.id] ? "Noted" : "Note"}</span>
          </button>
          <button class="action-btn share-btn" data-id="${v.id}" aria-label="Share">
            ${ICONS.share}
            <span class="action-count">Share</span>
          </button>
        </div>
      </section>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function truncate(s, n) {
    return s.length > n ? s.slice(0, n).trim() + "…" : s;
  }

  function renderNextBatch() {
    if (renderedCount >= verses.length) return;
    const end = Math.min(renderedCount + BATCH, verses.length);
    let html = "";
    for (let i = renderedCount; i < end; i++) {
      html += cardHtml(verses[i], i);
    }
    if (sentinel) sentinel.remove();
    feedEl.insertAdjacentHTML("beforeend", html);
    renderedCount = end;
    attachSentinel();
    observeCards();
  }

  function attachSentinel() {
    sentinel = document.createElement("div");
    sentinel.style.height = "1px";
    sentinel.id = "sentinel";
    feedEl.appendChild(sentinel);
    if (io) io.observe(sentinel);
  }

  let cardObserver = null;
  function observeCards() {
    const cards = feedEl.querySelectorAll(".verse-card:not([data-observed])");
    cards.forEach((c) => {
      c.setAttribute("data-observed", "1");
      if (cardObserver) cardObserver.observe(c);
    });
  }

  function setupObservers() {
    io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) renderNextBatch();
      });
    }, { root: feedEl, threshold: 0 });

    cardObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting && e.intersectionRatio > 0.6) {
          const idx = parseInt(e.target.getAttribute("data-idx"), 10);
          const chapter = e.target.getAttribute("data-chapter");
          const id = e.target.getAttribute("data-id");
          updateProgress(idx, chapter, id);
        }
      });
    }, { root: feedEl, threshold: [0.6] });
  }

  function updateProgress(idx, chapter, id) {
    currentChapter = parseInt(chapter, 10);
    if (progressBar) {
      const pct = ((idx + 1) / verses.length) * 100;
      progressBar.style.width = pct.toFixed(2) + "%";
    }
    if (progressLabel) {
      progressLabel.textContent = `Ch. ${chapter} / ${chapters.length || 26}`;
    }
    if (id) {
      try { localStorage.setItem(LS_LAST_READ, id); } catch (e) { /* storage unavailable */ }
    }
  }

  function buildChapters() {
    const map = new Map();
    verses.forEach((v, idx) => {
      if (!map.has(v.chapter)) {
        map.set(v.chapter, {
          chapter: v.chapter,
          title: v.chapterTitle,
          paliName: v.chapterPaliName,
          firstIdx: idx,
          count: 0,
        });
      }
      map.get(v.chapter).count += 1;
    });
    chapters = [...map.values()].sort((a, b) => a.chapter - b.chapter);
  }

  function renderChapterList() {
    chapterListEl.innerHTML = chapters
      .map(
        (c) => `
        <button class="chapter-row${c.chapter === currentChapter ? " chapter-row-active" : ""}" data-chapter="${c.chapter}">
          <span class="chapter-row-num">${c.chapter}</span>
          <span class="chapter-row-names">
            <span class="chapter-row-title">${escapeHtml(c.title)}</span>
            <span class="chapter-row-pali">${escapeHtml(c.paliName)} &middot; ${c.count} verses</span>
          </span>
        </button>`
      )
      .join("");
  }

  async function jumpToChapter(chapterNum) {
    const target = chapters.find((c) => c.chapter === chapterNum);
    if (!target) return;
    while (renderedCount <= target.firstIdx) renderNextBatch();
    closeChaptersSheet();
    requestAnimationFrame(() => {
      const el = feedEl.querySelector(`.verse-card[data-idx="${target.firstIdx}"]`);
      if (el) el.scrollIntoView({ block: "start" });
    });
  }

  function openChaptersSheet() {
    chapterSearchEl.value = "";
    renderChapterList();
    showChapterBrowseView();
    chaptersSheet.hidden = false;
    document.body.style.overflow = "hidden";
    trapFocusOpen(chaptersSheet.querySelector(".sheet-panel"));
  }

  function closeChaptersSheet() {
    chaptersSheet.hidden = true;
    document.body.style.overflow = "";
    trapFocusClose();
  }

  // ---------- Chapter + full-text verse search ----------
  // The chapter picker (above) only ever let you jump by chapter number —
  // there was no way to find a specific verse by its content, so a reader
  // who half-remembered a line had to re-scroll the whole 423-verse feed to
  // find it again. All verses are already loaded in memory (unlike Versling's
  // per-surah files), so search here is synchronous — no lazy-loading step.
  function showChapterBrowseView() {
    chapterListEl.hidden = false;
    chapterSearchResultsEl.hidden = true;
    if (moreTextsBlockEl) moreTextsBlockEl.hidden = false;
    if (moreTextsDividerEl) moreTextsDividerEl.hidden = false;
    if (chapterSearchStatusEl) chapterSearchStatusEl.textContent = "";
  }

  function chapterResultHtml(c) {
    return `
      <button class="search-result-item" data-chapter="${c.chapter}">
        <span class="search-result-tag">Chapter ${c.chapter} &middot; ${escapeHtml(c.paliName)}</span>
        <span class="search-result-text">${escapeHtml(c.title)} &middot; ${c.count} verses</span>
      </button>`;
  }

  function verseResultHtml(v, idx) {
    return `
      <button class="search-result-item" data-idx="${idx}">
        <span class="search-result-tag">Chapter ${v.chapter}.${v.verse} &middot; ${escapeHtml(v.chapterTitle)}</span>
        <span class="search-result-text">${escapeHtml(truncate(v.translation, 120))}</span>
      </button>`;
  }

  // Pali romanization uses diacritics (ā, ī, ū, ṅ, ñ, ṭ, ḍ, ṇ, ḷ, ṁ) on
  // every single one of the 423 verses — but no standard keyboard lets a
  // reader type those. Before this, searching the plain-ASCII spelling of a
  // Pali word a reader actually remembers (e.g. "nibbana", "tanha",
  // "brahmana") silently returned zero real matches against `v.pali`, even
  // though the word is in the text — the search just required the exact
  // diacritic marks it would never receive. Fold both the query and the
  // comparison text to base Latin letters (NFD-decompose, strip combining
  // marks) so plain-ASCII typing matches the real diacritic text. English
  // translation search is unaffected (already plain ASCII).
  function foldDiacritics(s) {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  }

  function renderChapterSearch(query) {
    if (!query) {
      showChapterBrowseView();
      return;
    }
    chapterListEl.hidden = true;
    if (moreTextsBlockEl) moreTextsBlockEl.hidden = true;
    if (moreTextsDividerEl) moreTextsDividerEl.hidden = true;
    chapterSearchResultsEl.hidden = false;

    const q = query.toLowerCase();
    const qFolded = foldDiacritics(q);
    // Guard: a query made up of only combining marks folds to "" — never
    // treat that as a wildcard match against every verse.
    const useFold = qFolded.length > 0;
    const chapterMatches = chapters.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.paliName.toLowerCase().includes(q) ||
        (useFold && foldDiacritics(c.paliName.toLowerCase()).includes(qFolded)) ||
        String(c.chapter) === query
    );
    const verseMatches = [];
    for (let i = 0; i < verses.length; i++) {
      const v = verses[i];
      if (
        v.translation.toLowerCase().includes(q) ||
        v.pali.toLowerCase().includes(q) ||
        (useFold && foldDiacritics(v.pali.toLowerCase()).includes(qFolded))
      ) {
        verseMatches.push({ v, idx: i });
        if (verseMatches.length >= 40) break;
      }
    }

    // Announce the outcome to screen-reader users. `chapterSearchResultsEl`
    // itself is intentionally not a live region (it can hold up to ~40+
    // button rows and making the whole thing live would read every row's
    // text aloud on each keystroke) — this separate visually-hidden
    // `role="status"` element gives a short, polite summary instead, the
    // same pattern used for search result counts elsewhere on the web.
    // Before this fix there was no `aria-live` anywhere on this sheet:
    // a screen-reader user typing a query got the results rendered
    // silently with zero spoken feedback that anything had changed.
    const total = chapterMatches.length + verseMatches.length;
    if (chapterSearchStatusEl) {
      chapterSearchStatusEl.textContent = total
        ? `${total} result${total === 1 ? "" : "s"} for "${query}".`
        : `No chapters or verses match "${query}".`;
    }

    if (!chapterMatches.length && !verseMatches.length) {
      chapterSearchResultsEl.innerHTML = `<p class="kept-empty">No chapters or verses match "${escapeHtml(query)}".</p>`;
      return;
    }
    chapterSearchResultsEl.innerHTML =
      chapterMatches.map(chapterResultHtml).join("") +
      verseMatches.map(({ v, idx }) => verseResultHtml(v, idx)).join("");
  }

  function wireChapterSearch() {
    chapterSearchEl.addEventListener("input", () => {
      renderChapterSearch(chapterSearchEl.value.trim());
    });
    chapterSearchResultsEl.addEventListener("click", (e) => {
      const item = e.target.closest(".search-result-item");
      if (!item) return;
      if (item.dataset.chapter) {
        jumpToChapter(parseInt(item.dataset.chapter, 10));
        return;
      }
      const idx = parseInt(item.dataset.idx, 10);
      const v = verses[idx];
      closeChaptersSheet();
      if (v) jumpToVerse(v.id);
    });
  }

  // ---------- Kept verses sheet ----------
  // The side-rail "Keep" action only ever wrote to localStorage with no way
  // to see or revisit what was kept — the feature was effectively write-only.
  // This renders every currently-kept verse (resolved live against `likes`)
  // so a kept verse can be reopened or un-kept without re-scrolling the feed.
  //
  // The exact same write-only gap existed for private notes (notes[] has been
  // readable/writable from inside the detail sheet since the original build,
  // but nothing ever listed them back) — a note written on verse 300 was
  // effectively lost until manually re-scrolling through all 423 verses to
  // find it again. Only the "kept" half of this gap was fixed here originally;
  // sibling app Shloka (`plans/shloka.md`) already fixed both halves. This
  // sheet now also lists every noted verse (independent of liked state) so
  // notes are actually revisitable.
  function renderKeptList() {
    const kept = verses
      .map((v, idx) => ({ v, idx }))
      .filter(({ v }) => likes.has(v.id));
    const noted = verses
      .map((v, idx) => ({ v, idx }))
      .filter(({ v }) => !!notes[v.id]);

    if (kept.length === 0 && noted.length === 0) {
      keptListEl.innerHTML = `<p class="kept-empty">No kept verses or notes yet — tap the heart or note icon on any verse to save it here.</p>`;
      if (keptListStatusEl) keptListStatusEl.textContent = "No kept verses or notes yet.";
      return;
    }

    if (keptListStatusEl) {
      const parts = [];
      if (kept.length) parts.push(`${kept.length} kept verse${kept.length === 1 ? "" : "s"}`);
      if (noted.length) parts.push(`${noted.length} note${noted.length === 1 ? "" : "s"}`);
      keptListStatusEl.textContent = parts.join(", ") + ".";
    }

    let html = "";
    if (kept.length) {
      html += kept
        .map(
          ({ v, idx }) => `
        <div class="kept-row">
          <button class="kept-row-main" data-idx="${idx}">
            <span class="kept-row-tag">Chapter ${v.chapter}.${v.verse} &middot; ${escapeHtml(v.chapterTitle)}</span>
            <span class="kept-row-text">${escapeHtml(truncate(v.translation, 110))}</span>
          </button>
          <button class="kept-row-remove" data-id="${v.id}" aria-label="Remove from kept">&times;</button>
        </div>`
        )
        .join("");
    }
    if (noted.length) {
      html += `<div class="kept-section-label">Your notes</div>`;
      html += noted
        .map(
          ({ v, idx }) => `
        <div class="kept-row">
          <button class="noted-row-main" data-idx="${idx}" data-id="${v.id}">
            <span class="kept-row-tag">Chapter ${v.chapter}.${v.verse} &middot; ${escapeHtml(v.chapterTitle)}</span>
            <span class="kept-row-text">${escapeHtml(truncate(notes[v.id], 110))}</span>
          </button>
          <button class="kept-row-remove" data-note-id="${v.id}" aria-label="Delete note">&times;</button>
        </div>`
        )
        .join("");
    }
    keptListEl.innerHTML = html;
  }

  function updateKeptCount() {
    if (keptBtn) keptBtn.textContent = likes.size ? `Kept (${likes.size})` : "Kept";
  }

  function openKeptSheet() {
    renderKeptList();
    keptSheet.hidden = false;
    document.body.style.overflow = "hidden";
    trapFocusOpen(keptSheet.querySelector(".sheet-panel"));
  }

  function closeKeptSheet() {
    keptSheet.hidden = true;
    document.body.style.overflow = "";
    trapFocusClose();
  }

  function openSheet(id) {
    const v = verses.find((x) => x.id === id);
    if (!v) return;
    sheet.querySelector(".sheet-kicker").textContent =
      `Chapter ${v.chapter} · Verse ${v.verse} · ${v.chapterPaliName}`;
    sheet.querySelector(".sheet-chapter-title").textContent = v.chapterTitle;
    sheet.querySelector(".sheet-chapter-summary").textContent = v.chapterSummary;
    sheet.querySelector(".sheet-pali").textContent = v.pali;
    sheet.querySelector(".sheet-translation").textContent = v.translation;

    let noteWrap = sheet.querySelector(".sheet-note-wrap");
    if (!noteWrap) {
      noteWrap = document.createElement("div");
      noteWrap.className = "sheet-note-wrap";
      noteWrap.innerHTML = `
        <div class="sheet-divider"></div>
        <div class="sheet-label">Your note (private, saved on this device)</div>
        <textarea class="sheet-note" rows="3" placeholder="Write a private reflection on this verse..."></textarea>
      `;
      sheet.querySelector(".sheet-scroll").appendChild(noteWrap);
    }
    const textarea = noteWrap.querySelector(".sheet-note");
    textarea.value = notes[id] || "";
    textarea.oninput = () => {
      notes = loadNotes(); // re-read fresh so a concurrent tab's note isn't clobbered
      const val = textarea.value;
      if (val.trim()) notes[id] = val; else delete notes[id];
      saveNotes(notes);
      const btn = feedEl.querySelector(`.note-btn[data-id="${id}"] .action-count`);
      if (btn) btn.textContent = notes[id] ? "Noted" : "Note";
      if (!keptSheet.hidden) renderKeptList();
    };

    sheet.hidden = false;
    document.body.style.overflow = "hidden";
    trapFocusOpen(sheet.querySelector(".sheet-panel"));
  }

  function closeSheet() {
    sheet.hidden = true;
    document.body.style.overflow = "";
    trapFocusClose();
  }

  function toggleLike(id) {
    likes = loadSet(LS_LIKES); // re-read fresh so a concurrent tab's like isn't clobbered
    if (likes.has(id)) likes.delete(id); else likes.add(id);
    saveSet(LS_LIKES, likes);
    const btn = feedEl.querySelector(`.like-btn[data-id="${id}"]`);
    if (btn) {
      btn.classList.toggle("liked", likes.has(id));
      btn.querySelector(".action-count").textContent = likes.has(id) ? "Kept" : "Keep";
    }
    updateKeptCount();
    if (!keptSheet.hidden) renderKeptList();
  }

  async function shareVerse(id) {
    const v = verses.find((x) => x.id === id);
    if (!v) return;
    const text = `"${v.translation}"\n— Dhammapada ${v.chapter}.${v.verse}, ${v.chapterTitle}`;
    const url = `${location.origin}/#${id}`;
    if (navigator.share) {
      try {
        await navigator.share({ text, url, title: "Gatha" });
        return;
      } catch (e) { /* user cancelled */ return; }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast("Copied to clipboard");
    } catch (e) {
      toast("Could not copy");
    }
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.style.position = "fixed";
      el.style.bottom = "calc(32px + env(safe-area-inset-bottom, 0px))";
      el.style.left = "50%";
      el.style.transform = "translateX(-50%)";
      el.style.background = "rgba(18,20,18,0.95)";
      el.style.color = "#eef1ee";
      el.style.padding = "10px 18px";
      el.style.borderRadius = "999px";
      el.style.fontSize = "13px";
      el.style.zIndex = "50";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = "0"; }, 1800);
  }

  function wireFeedEvents() {
    feedEl.addEventListener("click", (e) => {
      const likeBtn = e.target.closest(".like-btn");
      if (likeBtn) { toggleLike(likeBtn.dataset.id); return; }
      const noteBtn = e.target.closest(".note-btn");
      if (noteBtn) { openSheet(noteBtn.dataset.id); return; }
      const shareBtn = e.target.closest(".share-btn");
      if (shareBtn) { shareVerse(shareBtn.dataset.id); return; }
      const openTarget = e.target.closest("[data-open]");
      if (openTarget) { openSheet(openTarget.getAttribute("data-open")); return; }
    });
  }

  function createProgressBar() {
    const wrap = document.createElement("div");
    wrap.className = "feed-progress";
    wrap.innerHTML = `<div class="feed-progress-bar"></div>`;
    document.body.appendChild(wrap);
    progressBar = wrap.querySelector(".feed-progress-bar");

    const label = document.createElement("button");
    label.className = "feed-progress-label";
    label.setAttribute("aria-label", "Jump to chapter");
    label.textContent = `Ch. 1 / ${chapters.length || 26}`;
    label.addEventListener("click", openChaptersSheet);
    document.body.appendChild(label);
    progressLabel = label;

    const kBtn = document.createElement("button");
    kBtn.className = "kept-btn";
    kBtn.type = "button";
    kBtn.setAttribute("aria-label", "Your kept verses");
    kBtn.addEventListener("click", openKeptSheet);
    document.body.appendChild(kBtn);
    keptBtn = kBtn;
    updateKeptCount();
  }

  async function start() {
    startBtn.disabled = true;
    startBtn.textContent = "Loading...";
    try {
      verses = await fetchData();
    } catch (e) {
      startBtn.textContent = "Could not load — tap to retry";
      startBtn.disabled = false;
      return;
    }
    buildChapters();
    onboarding.hidden = true;
    feedEl.hidden = false;
    createProgressBar();
    setupObservers();
    wireFeedEvents();
    wireChaptersSheet();
    renderNextBatch();

    const hashId = location.hash.replace("#", "");
    if (hashId) {
      jumpToVerse(hashId);
    } else {
      const lastReadId = safeGetLastRead();
      if (lastReadId && lastReadId !== verses[0].id) {
        jumpToVerse(lastReadId, () => toast("Continuing where you left off"));
      }
    }
  }

  function safeGetLastRead() {
    try { return localStorage.getItem(LS_LAST_READ); } catch (e) { return null; }
  }

  function jumpToVerse(id, onJumped) {
    const idx = verses.findIndex((v) => v.id === id);
    if (idx < 0) return;
    while (renderedCount <= idx) renderNextBatch();
    requestAnimationFrame(() => {
      const el = feedEl.querySelector(`.verse-card[data-id="${id}"]`);
      if (el) {
        el.scrollIntoView({ block: "start" });
        if (onJumped) onJumped();
      }
    });
  }

  function wireChaptersSheet() {
    chapterListEl.addEventListener("click", (e) => {
      const row = e.target.closest(".chapter-row");
      if (!row) return;
      jumpToChapter(parseInt(row.getAttribute("data-chapter"), 10));
    });
    wireChapterSearch();
  }

  // A shared verse (`shareVerse()` above) produces a link like
  // `https://gatha.ereboslab.com/#5.60`. Previously, opening that link cold
  // still forced the recipient through the onboarding screen and a manual
  // "Start reading" tap before they ever saw the verse that was actually
  // shared with them — the deep link only "worked" after an extra step,
  // undermining sharing as a real growth lever (same bug found + fixed in
  // sibling app Shloka, commit ca0e400). If the URL already carries a valid
  // verse hash on first load, skip onboarding and jump straight into the
  // feed at that verse.
  const hasDeepLinkHash = /^#?\d+\.\d+$/.test(location.hash);

  startBtn.addEventListener("click", start);
  sheetClose.addEventListener("click", closeSheet);
  sheetBackdrop.addEventListener("click", closeSheet);
  chaptersClose.addEventListener("click", closeChaptersSheet);
  chaptersBackdrop.addEventListener("click", closeChaptersSheet);
  keptClose.addEventListener("click", closeKeptSheet);
  keptBackdrop.addEventListener("click", closeKeptSheet);
  keptListEl.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".kept-row-remove");
    if (removeBtn) {
      if (removeBtn.dataset.noteId) {
        notes = loadNotes(); // re-read fresh so a concurrent tab's note isn't clobbered
        delete notes[removeBtn.dataset.noteId];
        saveNotes(notes);
        const noteCountBtn = feedEl.querySelector(`.note-btn[data-id="${removeBtn.dataset.noteId}"] .action-count`);
        if (noteCountBtn) noteCountBtn.textContent = "Note";
        renderKeptList();
      } else {
        toggleLike(removeBtn.dataset.id);
      }
      return;
    }
    const row = e.target.closest(".kept-row-main");
    if (row) {
      const idx = parseInt(row.dataset.idx, 10);
      const v = verses[idx];
      closeKeptSheet();
      if (v) jumpToVerse(v.id);
      return;
    }
    const notedRow = e.target.closest(".noted-row-main");
    if (notedRow) {
      const idx = parseInt(notedRow.dataset.idx, 10);
      const v = verses[idx];
      closeKeptSheet();
      if (v) jumpToVerse(v.id);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) closeSheet();
    if (e.key === "Escape" && !chaptersSheet.hidden) closeChaptersSheet();
    if (e.key === "Escape" && !keptSheet.hidden) closeKeptSheet();
  });

  // Picks up likes/notes written by another tab/window of this same app so
  // this tab's UI (and its own next write) never works from a stale snapshot.
  window.addEventListener("storage", (e) => {
    if (e.key === LS_LIKES) {
      likes = loadSet(LS_LIKES);
      feedEl.querySelectorAll(".like-btn").forEach((btn) => {
        const liked = likes.has(btn.dataset.id);
        btn.classList.toggle("liked", liked);
        const count = btn.querySelector(".action-count");
        if (count) count.textContent = liked ? "Kept" : "Keep";
      });
      updateKeptCount();
      if (!keptSheet.hidden) renderKeptList();
    } else if (e.key === LS_NOTES) {
      notes = loadNotes();
      feedEl.querySelectorAll(".note-btn").forEach((btn) => {
        const count = btn.querySelector(".action-count");
        if (count) count.textContent = notes[btn.dataset.id] ? "Noted" : "Note";
      });
      if (!keptSheet.hidden) renderKeptList();
    }
  });

  if (hasDeepLinkHash) start();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
})();
