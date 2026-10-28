// Proposes the LegiScan bill id(s) for each state entry and checks every proposal against the live record.
//   node grabber/map-ids-legiscan.mjs     writes config/identifiers-legiscan.json and out/identifier-review-legiscan.md
// Cost: one getSessionList per state, one getMasterList per 2025-2026 session, one getBill per matched bill (about 90 queries, once).
// Entries that are failed / dead, executive orders, litigation and ballot measures are skipped: nothing on LegiScan can change them.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './lib/env.mjs';
import { createHttp } from './lib/http.mjs';
import { createLegiScan, normNumber, billNumbersIn, officialUrl } from './sources/legiscan.mjs';
import { score } from './map-ids.mjs';
import { readUsage, addUsage, LEGISCAN_USAGE_FILE } from './run-legiscan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');
const FIRST_YEAR = 2025; // the tracker covers the 2025-2026 sessions

export const mappable = (e) => e.level === 'state' && ['law', 'bill', 'auditor', 'precursor'].includes(e.type) && e.status !== 'failed' && billNumbersIn(`${e.title} ${e.short_name}`).length > 0;

export async function mapLegiScan({ entries, ls, log = () => {} }) {
  const out = {}, sessionsByState = new Map(), lists = new Map();
  const sessionsOf = async (st) => {
    if (!sessionsByState.has(st)) sessionsByState.set(st, (await ls.sessions(st)).filter((s) => s.year_end >= FIRST_YEAR).sort((a, b) => b.year_start - a.year_start || a.special - b.special));
    return sessionsByState.get(st);
  };
  const listOf = async (sid) => { if (!lists.has(sid)) lists.set(sid, await ls.masterList(sid)); return lists.get(sid); };

  for (const e of entries.filter(mappable)) {
    const nums = billNumbersIn(`${e.title} ${e.short_name}`), bills = [], checks = [];
    for (const num of nums) {
      // every 2025+ session of the state that has this number; the best title match wins (the newest session on a tie)
      const found = [];
      for (const s of await sessionsOf(e.state)) {
        const ml = await listOf(s.session_id);
        const b = ml.bills.find((x) => normNumber(x.number) === num);
        if (b) found.push({ s, b, sc: score(e, { title: b.title }) });
      }
      if (!found.length) { checks.push({ number: num, found: false, result: 'check' }); continue; }
      const best = found.sort((x, y) => y.sc.overlap - x.sc.overlap)[0];
      const full = await ls.bill(best.b.bill_id);
      const sc0 = score(e, { title: `${full.title} ${full.description || ''}`, sponsors: (full.sponsors || []).map((p) => ({ fullName: p.last_name || p.name })) });
      // State titles are short subject lines ("BUSINESS-TECH"), so title overlap alone is weak here: a sponsor match is enough.
      const sc = { ...sc0, result: sc0.result === 'match' || sc0.sponsorOk ? 'match' : 'check' };
      checks.push({ number: num, found: true, bill_id: full.bill_id, session: best.s.session_name, api_title: full.title, api_sponsor: (full.sponsors || []).slice(0, 3).map((p) => p.name).join('; '), official_url: officialUrl(full), other_sessions: found.length - 1, ...sc });
      // LegiScan's sine_die flag is set after the regular session, but bills can still move (e.g. Illinois' veto session), so open = its last year has not ended
      bills.push({ bill_id: full.bill_id, number: full.bill_number, state: full.state, session_id: full.session_id, session_name: best.s.session_name, year_end: best.s.year_end, session_open: best.s.year_end >= new Date().getUTCFullYear(), official_url: officialUrl(full), legiscan_url: full.url });
      log(`${e.key}: ${num} -> ${full.bill_id} (${sc.result})`);
    }
    const allMatch = checks.length && checks.every((c) => c.found && c.result === 'match');
    out[e.key] = { bills, status: allMatch ? 'proposed' : 'needs_review', entry_id: e.id, short_name: e.short_name, checks };
  }
  return out;
}

export const md = (m) => ['# LegiScan identifier review', '', 'Proposed LegiScan bill ids for each live state entry, each checked against the live LegiScan record. **proposed** = the title (or sponsor) agrees. **CHECK** = please look at it. Official URL is the legislature page the site will cite.', '',
  '| # | Entry | Number | LegiScan id | Session | LegiScan title | Sponsor | Overlap | Result | Official URL |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...Object.values(m).sort((a, b) => a.entry_id - b.entry_id).flatMap((v) => v.checks.map((c, i) => `| ${i ? '' : v.entry_id} | ${i ? '' : v.short_name} | ${c.number} | ${c.found ? c.bill_id : '(not found)'} | ${c.found ? c.session : ''} | ${c.found ? String(c.api_title).replace(/\|/g, '/') : ''} | ${c.found ? c.api_sponsor : ''} | ${c.found ? c.overlap : ''} | ${c.result === 'match' ? 'match' : '**CHECK**'} | ${c.found ? c.official_url : ''} |`))].join('\n') + '\n';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadEnv(pipelineDir);
  const key = process.env.LEGISCAN_API_KEY;
  if (!key) { console.error('LEGISCAN_API_KEY is not set'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'legiscan.json'), 'utf8'));
  const usageFile = LEGISCAN_USAGE_FILE, now = new Date();
  const left = cfg.monthly_cap - readUsage(usageFile, now).used;
  const entries = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'out', 'entries.v2.json'), 'utf8'));
  const http = createHttp({ secrets: [key], maxRequests: Math.min(150, left), log: (m) => console.log('  ' + m) });
  let m;
  try { m = await mapLegiScan({ entries, ls: createLegiScan(http, key), log: (s) => console.log('  ' + s) }); }
  finally { const u = addUsage(usageFile, now, http.used()); console.log(`legiscan queries: ${http.used()}; this month ${u.used}/${cfg.monthly_cap}`); }
  fs.writeFileSync(path.join(pipelineDir, 'config', 'identifiers-legiscan.json'), JSON.stringify({ _note: 'Proposed by grabber/map-ids-legiscan.mjs. Confirm each entry by setting status to "confirmed", correct the ids, or set "rejected".', legiscan: m }, null, 1) + '\n');
  fs.mkdirSync(path.join(pipelineDir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'out', 'identifier-review-legiscan.md'), md(m));
  const c = Object.values(m).reduce((n, v) => ({ ...n, [v.status]: (n[v.status] || 0) + 1 }), {});
  console.log(`mapped ${Object.keys(m).length} state entries: ${JSON.stringify(c)}`);
}
