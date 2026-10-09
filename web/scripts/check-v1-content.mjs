// Checks that v1's reference text is on the v2 pages, read straight from v1's own files (not from content.json):
//   handbook.md            → #/handbook?all=1   every heading, paragraph, list item and table cell
//   tracker.md intro, L    → #/method           the "Frontier =" definition, the confidence key, the verification note, section L
//   build/aaf-crosscheck   → #/method           every AAF row, candidate, tracker-only item and caveat
//   tracker.md K, K.2      → #/compare          every matrix cell, the clusters paragraph, K.2's intro and cells
//   tracker.md notes       → #/explore?sec=X    the paragraphs beside each section's table
//   docs/index.html About  → #/about            every heading, paragraph and list item of v1's About section
//   node web/scripts/check-v1-content.mjs [--chrome <path>]
import fs from 'fs';
import path from 'path';
import { web, startServer, textOf, squash } from './render-lib.mjs';

const root = path.resolve(web, '..'), read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const isTable = (l) => /^\s*\|/.test(l), isRule = (l) => /^\s*\|?\s*:?-{3,}/.test(l);
const cellsOf = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()).filter((c) => c && c !== '—');
// the pieces of a markdown block of lines: one per heading, paragraph line, list item or table cell
const piecesOf = (lines) => lines.flatMap((l) => { if (!l.trim() || /^\s*---\s*$/.test(l) || isRule(l)) return []; if (isTable(l)) return cellsOf(l); return [l.replace(/^\s*(#+|>|[-*]|\d+\.)\s+/, '').trim()]; });
const md = read('tracker.md'), mdLines = md.split(/\r?\n/);
const section = (code) => { const s = mdLines.findIndex((l) => new RegExp('^#{2,3} ' + code.replace('.', '\\.') + '[.\\s]').test(l)); let e = s + 1; while (e < mdLines.length && !/^#{2,3} /.test(mdLines[e])) e++; return mdLines.slice(s + 1, e); };
const notes = (code) => section(code).filter((l) => l.trim() && !isTable(l));
const plainHtml = (h) => h.replace(/<[^>]+>/g, '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' }[e] ?? m));

const aaf = JSON.parse(read('build', 'aaf-crosscheck.json'));
const html = read('docs', 'index.html'), ai = html.indexOf('id="sec-about"'), about = html.slice(ai, html.indexOf('</section>', ai)).replace(/<nav[\s\S]*?<\/nav>/g, '').replace(/<header[\s\S]*?<\/header>/, '');
const CHECKS = [
  ['Handbook (all chapters)', '#/handbook?all=1', piecesOf(read('handbook.md').split(/\r?\n/))],
  ['Data & trust: intro and confidence key', '#/method', piecesOf(mdLines.slice(0, mdLines.findIndex((l) => /^## A\./.test(l))))],
  ['Data & trust: section L', '#/method', piecesOf(section('L'))],
  ['Data & trust: AAF cross-check', '#/method', [aaf.scope_note, ...aaf.in_both.flatMap((x) => [x.bill, x.title, x.tracker]), ...aaf.candidates.flatMap((x) => [x.bill, x.sponsor, x.title, x.aaf_summary, x.assessment, x.suggested].filter(Boolean)), ...aaf.tracker_only, ...aaf.caveats]],
  ['Compare: section K', '#/compare', piecesOf(section('K'))],
  ['Compare: section K.2', '#/compare', piecesOf(section('K.2'))],
  ...['A', 'B.2', 'C', 'G.2', 'G.3'].map((c) => [`Explore: section ${c} notes`, '#/explore?sec=' + c, piecesOf(notes(c))]),
  ['About this site', '#/about', [...about.matchAll(/<(h3|h4|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => plainHtml(m[2]).replace(/\s+/g, ' ').trim()).filter(Boolean)]
];

const { dump, close } = await startServer();
const pages = {}; for (const r of new Set(CHECKS.map((c) => c[1]))) pages[r] = squash(textOf(await dump(r)));
close();
let bad = 0, total = 0;
for (const [name, route, pieces] of CHECKS) {
  const miss = pieces.filter((p) => squash(p).length > 1 && !pages[route].includes(squash(p)));
  total += pieces.length;
  if (miss.length) { bad += miss.length; console.log(`${name} (${route}): ${miss.length} of ${pieces.length} missing\n  - ` + miss.slice(0, 8).map((m) => m.slice(0, 160)).join('\n  - ')); }
  else console.log(`${name} (${route}): all ${pieces.length} present`);
}
if (bad) { console.log(`\n${bad} of ${total} pieces of v1 text missing.`); process.exit(1); }
console.log(`\nAll ${total} pieces of v1 reference text appear on the v2 pages.`);
