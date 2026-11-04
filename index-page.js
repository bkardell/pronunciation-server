/**
 * Builds the browsable HTML index of the audio cache.
 *
 * Shared by server.js (GET /index, links under /cache/) and build-index.js
 * (static index.html published next to the MP3s, relative links).
 *
 *   buildIndexHtml(cacheDir, { hrefBase = '/cache/', showPath = false, newHref })
 *   (newHref: if set, a link to the "new pronunciation" form)
 *
 * The cache is laid out as "${lang}/${term}-${ipa}.mp3" (unencoded UTF-8,
 * term lower-cased), the layout a-term's audio adapter reads. Each path
 * segment is URL-encoded in links.
 *
 *   listCache(cacheDir) → [{ lang, term, ipa, file, path }]
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

// Every "<lang>/<term>-<ipa>.mp3" under cacheDir. The file name is split at
// its last "-": terms may contain "-", IPA normally does not.
export function listCache(cacheDir) {
  if (!existsSync(cacheDir)) return [];
  const out = [];
  for (const d of readdirSync(cacheDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const lang = d.name.normalize('NFC');
    for (const f of readdirSync(join(cacheDir, d.name), { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.mp3')) continue;
      const file = f.name.normalize('NFC');
      const base = file.slice(0, -4);
      const cut  = base.lastIndexOf('-');
      if (cut < 1 || cut === base.length - 1) continue;
      out.push({ lang, term: base.slice(0, cut), ipa: base.slice(cut + 1), file, path: `${lang}/${file}` });
    }
  }
  return out;
}

export function buildIndexHtml(cacheDir, { hrefBase = '/cache/', showPath = false, newHref } = {}) {
  const entries = listCache(cacheDir);

  // Group by lang, sort each group by term then ipa
  const byLang = {};
  for (const entry of entries) {
    (byLang[entry.lang] ??= []).push(entry);
  }
  for (const group of Object.values(byLang)) {
    group.sort((a, b) =>
      (a.term || a.ipa).localeCompare(b.term || b.ipa, undefined, { sensitivity: 'base' })
    );
  }
  const sortedLangs = Object.keys(byLang).sort();
  const total       = entries.length;

  const langNav = sortedLangs.length > 1
    ? `<nav class="lang-nav">${sortedLangs.map(l => `<a href="#lang-${esc(l)}">${esc(l)}</a>`).join(' · ')}</nav>`
    : '';

  const sections = sortedLangs.map(lang => {
    const rows = byLang[lang].map(({ term, ipa, file }) => {
      const href = hrefBase + encodeURIComponent(lang) + '/' + encodeURIComponent(file);
      return `
      <tr>
        <td class="term">${term ? esc(term) : '<span class="empty">—</span>'}</td>
        <td class="ipa">/${esc(ipa)}/</td>
        <td class="actions">
          <button class="play-btn" data-src="${esc(href)}" aria-label="Play ${esc(term || ipa)}">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5l10 5.5-10 5.5V2.5z"/></svg>Play
          </button>
          <a class="dl-btn" href="${esc(href)}" download="${esc(file)}">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1v9M5 7l3 3 3-3M2 13h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>Download
          </a>
        </td>
      </tr>`;
    }).join('');

    return `
  <section>
    <h2 id="lang-${esc(lang)}">${esc(lang)} <span class="count">${byLang[lang].length}</span></h2>
    <table>
      <thead><tr><th>Term</th><th>IPA</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
  }).join('\n');

  const emptyState = `<div class="empty-state">
    No audio files in the cache yet.<br>
    Make a <code>POST /synthesize</code> request to generate some.
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>a-term audio index</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 15px;
    color: #111827;
    background: #f9fafb;
    padding: 2rem 1.5rem 4rem;
    max-width: 860px;
    margin: 0 auto;
  }
  header { margin-bottom: 2rem; }
  h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: .3rem; }
  .meta { color: #6b7280; font-size: .875rem; }
  .meta a { color: #2563eb; text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  .meta code { background: #e5e7eb; padding: 1px 5px; border-radius: 4px; font-size: .8em; }
  .lang-nav { margin-bottom: 2rem; font-size: .85rem; line-height: 2; }
  .lang-nav a { color: #2563eb; text-decoration: none; margin-right: .25rem; }
  .lang-nav a:hover { text-decoration: underline; }
  section { margin-bottom: 2.5rem; }
  h2 {
    font-size: .95rem; font-weight: 600; color: #374151;
    border-bottom: 1px solid #e5e7eb;
    padding-bottom: .4rem; margin-bottom: .75rem;
    display: flex; align-items: baseline; gap: .5rem;
  }
  .count { font-size: .8rem; font-weight: 400; color: #9ca3af; }
  table {
    width: 100%; border-collapse: collapse;
    background: #fff; border-radius: 8px; overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,.07);
  }
  th {
    text-align: left; font-size: .75rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: .06em; color: #6b7280;
    padding: .55rem 1rem; background: #f3f4f6;
    border-bottom: 1px solid #e5e7eb;
  }
  td { padding: .6rem 1rem; border-bottom: 1px solid #f3f4f6; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #fafafa; }
  td.term { font-weight: 500; }
  td.ipa { font-family: 'Lucida Sans Unicode','Noto Sans',sans-serif; color: #6b7280; font-size: .9rem; }
  td.actions { display: flex; gap: .5rem; justify-content: flex-end; }
  .empty { color: #d1d5db; }
  .play-btn, .dl-btn {
    all: unset; display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 12px; border-radius: 20px; font-size: .8rem;
    cursor: pointer; transition: background .15s, scale .1s; white-space: nowrap;
  }
  .play-btn { background: #111827; color: #f9fafb; }
  .play-btn:hover { background: #374151; scale: 1.04; }
  .play-btn.playing { background: #374151; animation: pulse .9s ease-in-out infinite alternate; }
  .play-btn.error { background: #dc2626; }
  .dl-btn { background: #e5e7eb; color: #374151; text-decoration: none; }
  .dl-btn:hover { background: #d1d5db; scale: 1.04; }
  svg { width: 12px; height: 12px; flex-shrink: 0; }
  .play-btn svg { fill: currentColor; }
  .empty-state { text-align: center; padding: 3rem; color: #9ca3af; line-height: 2; }
  @keyframes pulse {
    from { box-shadow: 0 0 0 0 rgba(55,65,81,.4); }
    to   { box-shadow: 0 0 0 6px rgba(55,65,81,0); }
  }
</style>
</head>
<body>
<header>
  <h1>a-term audio index</h1>
  <p class="meta">
    ${total} entr${total === 1 ? 'y' : 'ies'} &nbsp;·&nbsp;
    ${sortedLangs.length} language${sortedLangs.length === 1 ? '' : 's'}${showPath ? ` &nbsp;·&nbsp;
    <code>${esc(cacheDir)}</code>` : ''}${newHref ? ` &nbsp;·&nbsp;
    <a href="${esc(newHref)}">+ New pronunciation</a>` : ''}
  </p>
</header>
${langNav}
${sortedLangs.length === 0 ? emptyState : sections}
<script>
  let current = null;
  document.addEventListener('click', e => {
    const btn = e.target.closest('.play-btn');
    if (!btn) return;
    if (current) {
      current.audio.pause();
      current.btn.classList.remove('playing');
      if (current.btn === btn) { current = null; return; }
    }
    btn.classList.remove('error');
    btn.classList.add('playing');
    const audio = new Audio(btn.dataset.src);
    current = { audio, btn };
    audio.play().catch(() => {
      btn.classList.remove('playing');
      btn.classList.add('error');
      current = null;
    });
    audio.onended = () => { btn.classList.remove('playing'); current = null; };
  });
</script>
</body>
</html>`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
