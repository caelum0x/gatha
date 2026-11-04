// Gatha worker: serves the static site via the ASSETS binding, and for
// deep-linked verse URLs (?v=chapter.verse) rewrites the page's <title>
// and og:/twitter: meta tags to the real verse text before the response
// goes out.
//
// Why this exists: the app already builds and shares real ?v=chapter.verse
// links (see public/app.js verseUrl()/shareVerse()/shareVerseCard()), but
// the static HTML always carried the same generic title/description for
// every URL. Social apps and iMessage/WhatsApp link previews are generated
// by crawlers that don't execute client JS, so every shared verse link
// showed the same generic "Gatha — the Dhammapada, one verse at a time"
// card instead of the actual verse — undermining the point of sharing a
// specific verse. Ported from the same ?v= rewrite pattern already shipped
// in sibling app Versling (src/worker.js).

function parseVerseRef(raw) {
  if (!raw) return null;
  const m = /^(\d{1,3})\.(\d{1,3})$/.exec(String(raw).trim());
  if (!m) return null;
  return { chapter: parseInt(m[1], 10), verse: parseInt(m[2], 10) };
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n).trim() + "…" : s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ref = parseVerseRef(url.searchParams.get("v"));

    // No deep-link param, or asset/data/API requests: serve as-is.
    if (!ref || url.pathname !== "/") {
      return env.ASSETS.fetch(request);
    }

    try {
      const dataUrl = new URL("/data/dhammapada.json", url);
      const dataRes = await env.ASSETS.fetch(new Request(dataUrl));
      if (!dataRes.ok) return env.ASSETS.fetch(request);
      const verses = await dataRes.json();
      const id = `${ref.chapter}.${ref.verse}`;
      const v = Array.isArray(verses) ? verses.find((x) => x.id === id) : null;
      if (!v) return env.ASSETS.fetch(request);

      const pageRes = await env.ASSETS.fetch(request);
      const contentType = pageRes.headers.get("content-type") || "";
      if (!pageRes.ok || !contentType.includes("text/html")) {
        return pageRes;
      }

      const title = `Dhammapada ${v.chapter}.${v.verse} — ${v.chapterTitle} | Gatha`;
      const description = truncate(v.translation, 180);
      const pageUrl = `${url.origin}/?v=${id}`;

      // Real server-rendered verse content, not just meta tags: the SPA
      // only ever fills #feed from client JS, so a crawler (or any client
      // with JS disabled/budget-limited) reading the raw HTML for one of
      // the 423 ?v= URLs the sitemap now lists would otherwise see an
      // empty <main> with nothing to index — the title/description alone
      // aren't page content. This injects the exact same verse text the
      // client renders a moment later via renderNextBatch()/jumpToVerse(),
      // so there's something real to crawl.
      const feedHtml = `<section class="verse-page" data-id="ssr">
        <div class="verse-ref">Dhammapada ${v.chapter}.${v.verse} · ${escapeHtml(v.chapterTitle)}</div>
        <div class="verse-pali" lang="pi">${escapeHtml(v.pali)}</div>
        <div class="verse-translation">${escapeHtml(v.translation)}</div>
      </section>`;

      const rewriter = new HTMLRewriter()
        .on("title", { element(el) { el.setInnerContent(title); } })
        .on('meta[name="description"]', { element(el) { el.setAttribute("content", description); } })
        .on('meta[property="og:title"]', { element(el) { el.setAttribute("content", title); } })
        .on('meta[property="og:description"]', { element(el) { el.setAttribute("content", description); } })
        .on('meta[property="og:url"]', { element(el) { el.setAttribute("content", pageUrl); } })
        .on('meta[name="twitter:title"]', { element(el) { el.setAttribute("content", title); } })
        .on('meta[name="twitter:description"]', { element(el) { el.setAttribute("content", description); } })
        .on("main#feed", { element(el) { el.setInnerContent(feedHtml, { html: true }); } });

      return rewriter.transform(pageRes);
    } catch {
      // Any failure in the lookup path falls back to the plain static page
      // — never break the actual app over a preview-card nicety.
      return env.ASSETS.fetch(request);
    }
  },
};
