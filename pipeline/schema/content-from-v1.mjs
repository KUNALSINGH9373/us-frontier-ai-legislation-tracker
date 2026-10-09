// Reads the v1 site's own text (tracker.md, handbook.md, the built About section, the AAF cross-check) into the v2
// content file, so the v2 UI shows v1's words from data instead of copies pasted into the page.
// Text is kept verbatim as inline markdown (**bold**, *italic*, [text](url)); only structure is added.
import fs from 'fs';
import path from 'path';

// Markdown table row → cells (respects escaped pipes).
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
const isTable = (l) => /^\s*\|/.test(l);
const isRule = (l) => /^\s*\|?\s*:?-{3,}/.test(l);
// Plain text of an inline-markdown cell: drop emphasis markers and escapes (for the comparison matrix, which is diffed).
export const plain = (s) => s.replace(/\\([\\`*_{}[\]()#+\-.!|<>&])/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\s+/g, ' ').trim();
const unescape = (s) => s.replace(/\\([\\`*_{}[\]()#+\-.!|<>&])/g, '$1');
const bold = (s) => (s.match(/^\*\*([^*]+?)\*\*/) || [])[1];

// tracker.md split at "## X." / "### K.2" headings, each with its lines.
function sectionsOf(md) {
  const out = []; let cur = { code: '_intro', title: '', lines: [] };
  md.split(/\r?\n/).forEach((l) => {
    const m = l.match(/^#{2,3} ([A-Z](?:\.\d)?)\.?\s+(.*)$/);
    if (m) { out.push(cur); cur = { code: m[1], title: m[2], heading: l.replace(/^#+\s*/, ''), lines: [] }; } else if (/^# /.test(l)) cur.h1 = l.slice(2); else cur.lines.push(l);
  });
  out.push(cur);
  return out;
}
const paragraphs = (lines) => lines.filter((l) => l.trim() && !isTable(l)).map((l) => unescape(l.trim()));
const tableOf = (lines) => { const t = lines.filter(isTable); if (!t.length) return null; return { head: cells(t[0]).map(unescape), rows: t.slice(1).filter((l) => !isRule(l)).map((l) => cells(l).map(unescape)) }; };

export function trackerContent(md, kIds, keyOfId) {
  const S = sectionsOf(md), by = Object.fromEntries(S.map((s) => [s.code, s]));
  const intro = by._intro;
  const introParas = intro.lines.filter((l) => l.trim() && !/^\s+- /.test(l)).map((l) => l.trim());
  const key = intro.lines.filter((l) => /^\s+- \*\*/.test(l)).map((l) => { const m = l.trim().match(/^- \*\*([A-Z-]+)\*\* — (.*)$/); return { level: m[1], text: unescape(m[2]) }; });
  // Section notes: every paragraph of a lettered section that is not part of its table.
  const notes = {};
  S.filter((s) => /^[A-J]/.test(s.code)).forEach((s) => { const p = paragraphs(s.lines); if (p.length) notes[s.code] = p; });
  // Section K: the divergence matrix, the clusters paragraph; K.2 the assurance layers.
  const K = by.K, kt = tableOf(K.lines);
  if (kt.head.length !== kIds.length + 1) throw new Error(`section K has ${kt.head.length - 1} columns, expected ${kIds.length}`);
  const keys = kIds.map((i) => keyOfId[i]);
  const matrixRows = kt.rows.map((r) => {
    const dim = plain(r[0]), vals = r.slice(1);
    // "full spread" lists other bills' figures under each column, so it is kept as one note, not per-entry values
    if (/full spread/i.test(dim)) return { dimension: dim, values: {}, note: vals.map(plain).filter((v) => v && v !== '—').join(' · ') };
    return { dimension: dim, values: Object.fromEntries(keys.map((k, i) => [k, plain(vals[i] || '—')])) };
  });
  const kParas = paragraphs(K.lines);
  const clusters = kParas.find((p) => /^\*\*Two textual clusters/.test(p));
  const K2 = by['K.2'], k2 = tableOf(K2.lines);
  const L = by.L, lParas = paragraphs(L.lines);
  return {
    matrix: { entry_keys: keys, rows: matrixRows },
    content: {
      intro: { title: intro.h1, paragraphs: introParas.slice(0, 1), confidence_key_intro: unescape(introParas.find((p) => /^\*\*Confidence key/.test(p)) || ''), confidence_key: key, verification_note: introParas.find((p) => /^Verified as of/.test(p)) || '' },
      section_notes: notes,
      section_headings: Object.fromEntries(S.filter((s) => s.heading).map((s) => [s.code, unescape(s.heading)])),
      comparison: {
        heading: unescape(K.heading), columns: kt.head.slice(1).map(plain), clusters: clusters || '',
        assurance: { heading: unescape(K2.heading), intro: paragraphs(K2.lines), columns: k2.head, rows: k2.rows }
      },
      methodology: { heading: unescape(L.heading), paragraphs: lParas.map((p) => ({ label: bold(p) || null, text: p })) }
    }
  };
}

// handbook.md: the title, the opening paragraphs, and one entry per "## " chapter with its markdown body.
export function handbookContent(md) {
  const lines = md.split(/\r?\n/), title = (lines.find((l) => /^# /.test(l)) || '').slice(2);
  const chapters = []; let cur = null; const intro = [];
  lines.forEach((l) => {
    if (/^# /.test(l)) return;
    const m = l.match(/^## (?:(\d+)\.\s+)?(.*)$/);
    if (m) { cur = { n: m[1] ? +m[1] : null, title: m[2].trim(), md: '' }; chapters.push(cur); return; }
    if (cur) cur.md += l + '\n'; else intro.push(l);
  });
  chapters.forEach((c, i) => { c.md = c.md.replace(/\n*(---\s*\n*)+$/, '').trim(); c.slug = (c.n ? c.n + '-' : '') + c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); if (c.n == null) delete c.n; });
  return { title, intro: intro.join('\n').replace(/^\s*---\s*$/gm, '').trim(), chapters };
}

// The About section of the built v1 page (docs/index.html), as headed blocks of inline markdown.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const inline = (html) => html
  .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (m, u, t) => `[${t.replace(/<[^>]+>/g, '')}](${u})`)
  .replace(/<(em|i)>([\s\S]*?)<\/\1>/g, '*$2*').replace(/<(strong|b)>([\s\S]*?)<\/\1>/g, '**$2**')
  .replace(/<[^>]+>/g, '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (ENT[e] != null ? ENT[e] : e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : m))
  .replace(/\s+/g, ' ').trim();
export function aboutContent(html) {
  const i = html.indexOf('id="sec-about"'); if (i < 0) throw new Error('docs/index.html has no #sec-about section');
  const body = html.slice(i, html.indexOf('</section>', i)).replace(/<nav[\s\S]*?<\/nav>/g, '').replace(/<header[\s\S]*?<\/header>/, '');
  const blocks = []; const re = /<(h3|h4|p|ol|ul)\b[^>]*>([\s\S]*?)<\/\1>/g; let m;
  while ((m = re.exec(body))) {
    const tag = m[1];
    if (tag === 'ol' || tag === 'ul') blocks.push({ type: tag, items: [...m[2].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((x) => inline(x[1])) });
    else blocks.push({ type: tag, text: inline(m[2]) });
  }
  // the tracker's own introduction is reproduced verbatim inside About; its confidence list is a <ul>
  return { heading: 'About this site', blocks };
}

export function convertContent(root, L, keyOfId) {
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
  const t = trackerContent(read('tracker.md'), L.K_IDS, keyOfId);
  const aaf = JSON.parse(read('build', 'aaf-crosscheck.json'));
  return {
    matrix: t.matrix,
    content: {
      source: { tracker: 'tracker.md', handbook: 'handbook.md', about: 'docs/index.html#sec-about', aaf: 'build/aaf-crosscheck.json' },
      downloads: { handbook_pdf: 'downloads/handbook.pdf', handbook_md: 'downloads/handbook.md', tracker_md: 'downloads/tracker.md' },
      ...t.content,
      // v1's relative download link points at its own docs folder; v2 serves the same file from downloads/
      about: JSON.parse(JSON.stringify(aboutContent(read('docs', 'index.html'))).replace(/\]\(tracker\.md\)/g, '](downloads/tracker.md)')),
      handbook: handbookContent(read('handbook.md')),
      aaf_crosscheck: aaf
    }
  };
}
