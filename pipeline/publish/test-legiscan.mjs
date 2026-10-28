// State bills end to end: compare/legiscan.mjs rules and the publisher, on real LegiScan records fetched 16 Oct 2026
// (fixtures/publish/run-legiscan-20261016) against the site data of 8 Oct 2026. No network.
//   node publish/test-legiscan.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareLegiScan } from '../compare/legiscan.mjs';
import { publishRun, loadData } from './run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, '..', 'fixtures', 'publish'), RUN = path.join(FX, 'run-legiscan-20261016');
const raw = (f) => JSON.parse(fs.readFileSync(path.join(RUN, 'raw', 'legiscan', f + '.json'), 'utf8'));
const data8 = loadData(path.join(FX, 'data-2026-10-08'));
const entry = (k) => JSON.parse(JSON.stringify(data8.entries.find((e) => e.key === k)));
const item = (id) => ({ item_id: 'legiscan:' + id });
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };

// ---------- compare ----------
{
  const d = compareLegiScan({ item: item(1980543), raw: raw('CA-SB813-1980543'), entry: entry('ca-sb-813-ivos') });
  ok('CA SB 813: a non-routine step after the last check is material', d.verdict === 'material' && d.reasons.length === 1 && d.reasons[0].kind === 'new_action' && /^2026-09-08: CA SB813: Enrolled and presented to the Governor at 4 p\.m\.$/.test(d.reasons[0].detail), JSON.stringify(d));
  const e = entry('ca-ab-1405-auditor-registry');
  const d2 = compareLegiScan({ item: item(1980302), raw: raw('CA-AB1405-1980302'), entry: e });
  ok('CA AB 1405: steps the tracker already dates are not new (routine only = minor)', d2.verdict === 'minor' && d2.reasons.every((r) => r.kind === 'record_updated'), JSON.stringify(d2));
  const e3 = { ...entry('ca-sb-53-tfaia'), status: 'pending' };
  const d3 = compareLegiScan({ item: item(1904800), raw: raw('CA-SB53-1904800'), entry: e3 });
  ok('a chaptered bill on a "pending" entry is a status change to enacted', d3.verdict === 'material' && d3.reasons.some((r) => r.kind === 'status_change' && r.api_value === 'enacted'));
  const d4 = compareLegiScan({ item: item(1904800), raw: raw('CA-SB53-1904800'), entry: entry('ca-sb-53-tfaia') });
  ok('an enacted entry whose law is unchanged stays unchanged', d4.verdict === 'unchanged', JSON.stringify(d4));
  const dead = raw('MN-HF4532-2136898'); dead.derived.status = 'failed';
  const mn = { ...entry('mn-hf-4532-no-threshold'), status: 'pending' };
  const d5 = compareLegiScan({ item: item(2136898), raw: dead, entry: mn, billsOfEntry: 2 });
  ok('one dead bill of a two-bill entry does not fail the entry (companion note only)', d5.verdict === 'minor' && d5.reasons.some((r) => r.kind === 'companion_status'), JSON.stringify(d5));
  const d6 = compareLegiScan({ item: item(2136898), raw: dead, entry: mn, billsOfEntry: 1 });
  ok('a single-bill entry whose bill failed is a status change to failed', d6.verdict === 'material' && d6.reasons.some((r) => r.kind === 'status_change' && r.api_value === 'failed'));
  ok('a bill not in the tracker is a new entry candidate', compareLegiScan({ item: item(1), raw: raw('MN-SF4509-2133932'), entry: null }).verdict === 'new_entry_candidate');
}

// ---------- publish ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-ls-')), dataDir = path.join(dir, 'data'), runDir = path.join(dir, 'run');
  fs.cpSync(path.join(FX, 'data-2026-10-08'), dataDir, { recursive: true });
  fs.cpSync(RUN, runDir, { recursive: true });
  const r = publishRun({ runDir, dataDir, docsDir: null, config: { max_entries_changed_per_run: 15, news_from_official_actions: true } });
  const e = loadData(dataDir).entries.find((x) => x.key === 'ca-sb-813-ivos'), d = loadData(dataDir);
  // the author wrote "enrolled Sept 1" (the record says Sept 8): the same step on a nearby date. Reported, and nothing is written twice:
  // no second event, no status line, no news. (The replay of 28 Oct 2026 found the event was still being added.)
  ok('enrolled Sept 8 vs the author\'s "enrolled Sept 1": nothing written, the run is quiet', r.status === 'quiet' && r.result.touched.length === 0, r.summary);
  const e8 = data8.entries.find((x) => x.key === 'ca-sb-813-ivos');
  ok('no second enrolment event, and the entry is unchanged', !e.events.some((v) => v.date === '2026-09-08') && JSON.stringify(e) === JSON.stringify(e8));
  ok('the date disagreement is reported in the run summary', r.result.disagreements.some((x) => x.entry_key === 'ca-sb-813-ivos' && x.date === '2026-09-08' && x.said === '2026-09-01') && /disagreement: the record dates "Enrolled and presented to the Governor at 4 p.m." Sept 8, 2026, the entry says Sept 1, 2026/.test(r.summary), r.summary);
  ok('no news item', d.news.items.filter((x) => x.origin === 'automated').length === 0);
}

// ---------- quotes and titles: the official words only in quotes; the bill number outside, and only for a multi-bill entry ----------
function sb813(edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-ls-')), dataDir = path.join(dir, 'data'), runDir = path.join(dir, 'run');
  fs.cpSync(path.join(FX, 'data-2026-10-08'), dataDir, { recursive: true });
  fs.cpSync(RUN, runDir, { recursive: true });
  const f = path.join(dataDir, 'entries.json'), all = JSON.parse(fs.readFileSync(f, 'utf8'));
  const e = all.find((x) => x.key === 'ca-sb-813-ivos');
  e.status_text = 'Status: Passed Assembly Aug 30, 2026 (Ayes 67, Noes 6)'; // nothing about Sept 8 yet
  e.events = e.events.filter((v) => v.date !== '2026-09-01'); // and no author event on a nearby date: the step is genuinely new
  edit(e);
  fs.writeFileSync(f, JSON.stringify(all, null, 1));
  const r = publishRun({ runDir, dataDir, docsDir: null, config: { max_entries_changed_per_run: 15, news_from_official_actions: true } });
  const d = loadData(dataDir);
  return { r, e: d.entries.find((x) => x.key === 'ca-sb-813-ivos'), n: d.news.items.filter((x) => x.origin === 'automated') };
}
{
  const { r, e, n } = sb813(() => {});
  ok('one bill: the status line has the official words only', r.status === 'published' && e.status_text.endsWith('; Enrolled and presented to the Governor at 4 p.m. (Sept 8, 2026, CA Legislature)'), e.status_text);
  ok('one bill: the news title is the short name and the official words, the bill number not doubled', n.length === 1 && n[0].title === `${e.short_name}: Enrolled and presented to the Governor at 4 p.m.` && !/SB ?813.*SB ?813/.test(n[0].title), JSON.stringify(n));
  ok('one bill: the body quotes the official words only', n[0].body.includes(': "Enrolled and presented to the Governor at 4 p.m." (Sept 8, 2026)') && !/"CA SB813/.test(n[0].body) && n[0].evidence[0].quote === 'Enrolled and presented to the Governor at 4 p.m.', n[0].body);
}
{
  const { e, n } = sb813((x) => { x.identifiers = { session: '2025-2026 Regular Session', external: { legiscan: [1980543, 1980544] } }; });
  ok('two bills: the bill number goes before the official words in the event and status line', e.events.some((v) => v.date === '2026-09-08' && v.text === 'CA SB813: Enrolled and presented to the Governor at 4 p.m.') && e.status_text.endsWith('; CA SB813: Enrolled and presented to the Governor at 4 p.m. (Sept 8, 2026, CA Legislature)'), e.status_text);
  ok('two bills: in the news the bill number is outside the quotes, and not in the title', n.length === 1 && n[0].body.includes('(CA SB813): "Enrolled and presented to the Governor at 4 p.m."') && n[0].title === `${e.short_name}: Enrolled and presented to the Governor at 4 p.m.`, JSON.stringify(n));
}

console.log(`legiscan publish: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
