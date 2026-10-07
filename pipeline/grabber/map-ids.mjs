// Proposes the Congress.gov bill id(s) for each federal entry and checks every proposal against the live record.
//   node grabber/map-ids.mjs            writes config/identifiers.json and out/identifier-review.md
// A person confirms the result (set "status": "confirmed" or fix an id); the converter then uses it.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './lib/env.mjs';
import { createHttp } from './lib/http.mjs';
import { createCongress, billId, parseBillId } from './sources/congress.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');
const CONGRESS = '119'; // the tracker covers 2025-2026, the 119th Congress
const TYPE = { 'H.R.': 'hr', 'S.': 's', 'H.J.Res.': 'hjres', 'S.J.Res.': 'sjres', 'H.Res.': 'hres', 'S.Res.': 'sres' };
const RE = /\b(H\.R\.|S\.J\.Res\.|H\.J\.Res\.|S\.Res\.|H\.Res\.|S\.)\s?(\d+)/g;
const STOP = new Set(['the', 'and', 'act', 'for', 'bill', 'new', 'with', 'ndaa']);
const tokens = (s) => new Set((s || '').toLowerCase().replace(/\bh\.?r\.?\s?\d+|\bs\.?\s?\d+/g, ' ').normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z]{3,}/g)?.filter((t) => !STOP.has(t)) || []);

export const proposeIds = (e) => [...new Set([...(e.title + ' ' + e.short_name).matchAll(RE)].map((m) => `${CONGRESS}/${TYPE[m[1]]}/${m[2]}`))];
export const surname = (fullName) => (fullName || '').replace(/^(Rep\.|Sen\.|Del\.)\s*/, '').split(',')[0].trim().toLowerCase();

const INITIAL_SKIP = new Set(['of', 'and', 'the', 'for', 'on', 'to', 'in', 'act', 'a', 'an']);
const initials = (title) => (title || '').replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter((w) => w && !INITIAL_SKIP.has(w.toLowerCase())).map((w) => w[0].toLowerCase()).join('');

export function score(entry, bill) {
  const et = tokens(entry.short_name), at = tokens(bill.title);
  const near = (a, b) => a === b || a.startsWith(b) || b.startsWith(a);
  const overlap = et.size ? [...et].filter((t) => [...at].some((a) => near(a, t))).length / et.size : 0;       // how much of OUR name appears in the API title
  const coverage = at.size ? [...at].filter((a) => [...et].some((t) => near(a, t))).length / at.size : 0;      // how much of the API title appears in OUR name
  const acronym = [...(entry.short_name.match(/\b[A-Z]{4,}\b/g) || [])].some((a) => initials(bill.title).includes(a.toLowerCase()));
  const sponsorOk = (bill.sponsors || []).some((s) => entry.sponsor_text && entry.sponsor_text.toLowerCase().includes(surname(s.fullName)));
  const best = Math.max(overlap, coverage);
  return { overlap: Math.round(best * 100) / 100, acronym, sponsorOk, result: best >= 0.6 || acronym || (best >= 0.34 && sponsorOk) ? 'match' : 'check' };
}

export async function mapIds({ entries, congress, sections = ['D', 'E', 'F', 'G.3'] }) {
  const out = {};
  for (const e of entries.filter((x) => x.level === 'federal' && sections.includes(x.section))) {
    const ids = proposeIds(e);
    if (!ids.length) { out[e.key] = { congress_gov: [], status: 'no_number_found', note: 'No bill number in the title; discovery may find it later.', entry_id: e.id, short_name: e.short_name, checks: [] }; continue; }
    const checks = [];
    for (const id of ids) {
      const ref = parseBillId(id);
      try {
        const b = await congress.getBill(ref);
        const s = score(e, b);
        checks.push({ id, found: true, api_title: b.title, api_sponsor: (b.sponsors || []).map((x) => x.fullName).join('; '), ...s });
      } catch (err) { checks.push({ id, found: false, error: String(err.message).slice(0, 120), result: 'check' }); }
    }
    const allMatch = checks.every((c) => c.found && c.result === 'match');
    out[e.key] = { congress_gov: ids, status: allMatch ? 'proposed' : 'needs_review', entry_id: e.id, short_name: e.short_name, checks };
  }
  return out;
}

const md = (m) => ['# Congress.gov identifier review', '', 'Proposed bill ids for each federal entry, each checked against the live Congress.gov record. **status = proposed** means the title and sponsor agree. **needs_review** means something did not match: please check it.', '',
  '| # | Entry | Proposed id(s) | API title | API sponsor | Title overlap | Result |', '| --- | --- | --- | --- | --- | --- | --- |',
  ...Object.values(m).sort((a, b) => a.entry_id - b.entry_id).flatMap((v) => v.checks.length ? v.checks.map((c, i) => `| ${i ? '' : v.entry_id} | ${i ? '' : v.short_name} | ${c.id} | ${c.found ? c.api_title : '(not found: ' + c.error + ')'} | ${c.found ? c.api_sponsor : ''} | ${c.found ? c.overlap : ''} | ${c.result === 'match' ? 'match' : '**CHECK**'} |`) : [`| ${v.entry_id} | ${v.short_name} | none | | | | **no bill number in the title** |`])].join('\n') + '\n';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadEnv(pipelineDir);
  const key = process.env.CONGRESS_API_KEY;
  if (!key) { console.error('CONGRESS_API_KEY is not set'); process.exit(2); }
  const entries = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'out', 'entries.v2.json'), 'utf8'));
  const http = createHttp({ headers: { 'X-Api-Key': key }, secrets: [key], maxRequests: 120, log: (m) => console.log('  ' + m) });
  const m = await mapIds({ entries, congress: createCongress(http) });
  fs.mkdirSync(path.join(pipelineDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'config', 'identifiers.json'), JSON.stringify({ _note: 'Proposed by grabber/map-ids.mjs. Confirm each entry by setting status to "confirmed", or correct the ids.', congress_gov: m }, null, 1) + '\n');
  fs.writeFileSync(path.join(pipelineDir, 'out', 'identifier-review.md'), md(m));
  const c = Object.values(m).reduce((n, v) => ({ ...n, [v.status]: (n[v.status] || 0) + 1 }), {});
  console.log(`mapped ${Object.keys(m).length} federal entries: ${JSON.stringify(c)}; ${http.used()} request(s)`);
}
