// Builds web/data/*.json from the v1 sources, so the new front end shows exactly v1's content.
//   docs/tracker-table.csv  v1's own export of the comparison table (row order = entry ids)
//   tracker.md              the content of record; adds the columns and links the CSV drops
//   build/news.json, build/relationships.json  copied as is
// Run from the repository root:  node web/scripts/build-data.mjs
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const R = (...p) => path.join(root, ...p);
const out = R('web', 'data');
fs.mkdirSync(out, { recursive: true });

// ---------- CSV (v1 export) ----------
const csv = fs.readFileSync(R('docs', 'tracker-table.csv'), 'utf8').replace(/^﻿/, '');
function parseCsv(t) {
  const rows = []; let r = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; r.push(f); f = ''; if (r.length > 1 || r[0]) rows.push(r); r = []; }
    else f += c;
  }
  if (f || r.length) { r.push(f); rows.push(r); }
  return rows;
}
const [head, ...rows] = parseCsv(csv);
const key = { 'Section': 'section', 'Entry': 'title', 'Jurisdiction': 'jurisdiction', 'Sponsor': 'sponsor', 'Core mechanism / description': 'mechanism', 'Thresholds / scope': 'thresholds', 'Status and dates': 'status_and_dates', 'Source': 'source', 'Confidence': 'confidence', 'Years with dated events': 'years', 'Permalink': 'permalink_old_site' };
const names = { A: 'Enacted state frontier-developer laws', B: 'Pending, stalled and failed state bills', 'B.2': 'Catastrophic-risk regulation without a frontier threshold', C: 'State IVO / AI-auditor licensing measures', D: 'Federal frontier-AI bills introduced (none enacted)', E: 'Federal frameworks and discussion drafts (not introduced bills)', F: 'Adjacent and sectoral federal bills', G: 'Executive actions', 'G.2': 'Litigation and enforcement', 'G.3': 'Compute and export controls', H: 'Precursors and withdrawn proposals', I: 'Adjacent provisions inside broader AI laws', J: 'Checked and excluded' };

// ---------- tracker.md: every table row in sections A-J, in file order ----------
const md = fs.readFileSync(R('tracker.md'), 'utf8').split(/\r?\n/);
const plain = (s) => s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1').replace(/\*\*/g, '').replace(/\\([*_|])/g, '$1').replace(/\s+/g, ' ').trim();
const linksOf = (s) => [...s.matchAll(/\[([^\]]*)\]\((https?:[^)\s]+)\)/g)].map((m) => ({ t: plain(m[1]), u: m[2] }));
const mdRows = [];
let section = null, headers = null, inTable = false;
for (const line of md) {
  const h = line.match(/^## ([A-L](?:\.\d)?)[.\s]/);
  if (h) { section = h[1]; headers = null; inTable = false; continue; }
  if (!section || !/^[A-J](\.\d)?$/.test(section)) continue;
  if (!line.startsWith('|')) { if (line.trim() === '') { inTable = false; headers = null; } continue; }
  const cells = line.replace(/^\|\s?/, '').replace(/\s?\|\s*$/, '').split(/\s\|\s/);
  if (!headers) { headers = cells.map(plain); inTable = true; continue; }
  if (/^[\s:|-]+$/.test(line)) continue;
  mdRows.push({ section, headers, cells });
}

const entries = rows.map((r, i) => {
  const o = { id: i + 1 };
  head.forEach((k, j) => { o[key[k] || k] = r[j]; });
  o.section_name = names[o.section] || '';
  o.years = o.years ? o.years.split(' ') : [];
  const raw = (o.confidence || '').replace(/\*/g, '').trim();
  const m = raw.match(/^(HIGH|MED-HIGH|MED|SEARCH-QUALIFIED|LOW)/);
  o.confidence_level = m ? m[1] : null;
  o.confidence_note = raw;
  delete o.confidence;
  return o;
});

// ---------- enrich + verify ----------
const problems = [];
const evTables = []; // one single-row table per entry, in the shape v1's event extractor expects
const norm = (s) => plain(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const sameText = (a, b) => norm(a) === norm(b);
// Align by title (in order), so rows that are not entries in v1 (extra tables in the markdown) are reported, not silently mixed in.
let cursor = 0;
const used = new Set();
entries.forEach((e) => {
  let j = cursor;
  while (j < mdRows.length && norm(mdRows[j].cells[0]) !== norm(e.title)) j++;
  if (j >= mdRows.length) { problems.push(`#${e.id}: no matching row in tracker.md for "${e.title.slice(0, 60)}"`); return; }
  cursor = j + 1; used.add(j);
  const row = mdRows[j];
  if (row.section !== e.section) problems.push(`#${e.id}: section ${row.section} vs ${e.section}`);
  const cells = row.headers.map((hd, k) => ({ h: hd, t: plain(row.cells[k] || ''), links: linksOf(row.cells[k] || '') }));
  e.cells = cells;
  evTables.push({ heads: row.headers, rows: [{ id: e.id, cells: row.cells.map((c) => plain(c || '')) }] });
  const byH = (re) => cells.find((c) => re.test(c.h));
  const src = byH(/^source/i);
  e.source_links = src ? src.links : [];
  e.all_links = cells.flatMap((c) => c.links).filter((l, idx, a) => a.findIndex((z) => z.u === l.u) === idx);
  const pen = byH(/penalt/i), signed = byH(/^signed/i), eff = byH(/^effective/i);
  if (pen) e.penalties = pen.t;
  if (signed) e.signed = signed.t;
  if (eff) e.effective = eff.t;
  const mech = byH(/mechanism|what it does|description/i);
  if (mech && !sameText(mech.t, e.mechanism)) problems.push(`#${e.id}: mechanism text differs from tracker.md`);
});
mdRows.forEach((r, j) => { if (!used.has(j)) problems.push(`tracker.md row not in v1 table export: [${r.section}] ${plain(r.cells[0]).slice(0, 70)}`); });

// ---------- typed events (v1's own extractor, read-only import) ----------
// Every event keeps the clause it was read from, so the UI can show the author's own sentence.
const { extractEvents, TYPES: EVENT_TYPES } = await import(pathToFileURL(R('build', 'events.mjs')).href);
const secOf = new Map(entries.map((e) => [e.id, e.section]));
const events = extractEvents(evTables, (id) => (secOf.has(id) ? { label: secOf.get(id) } : null));
fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify({ types: EVENT_TYPES, events }, null, 1));

fs.writeFileSync(path.join(out, 'entries.json'), JSON.stringify(entries, null, 1));
for (const f of ['news.json', 'relationships.json']) fs.copyFileSync(R('build', f), path.join(out, f));

const withLinks = entries.filter((e) => e.source_links.length).length;
console.log(`entries: ${entries.length}; with source links: ${withLinks}; total links: ${entries.reduce((n, e) => n + e.all_links.length, 0)}`);
console.log(problems.length ? `PROBLEMS (${problems.length}):\n` + problems.join('\n') : 'verification: every title and mechanism matches tracker.md');
console.log(`typed events: ${events.length} across ${new Set(events.map((e) => e.id)).size} entries`);
