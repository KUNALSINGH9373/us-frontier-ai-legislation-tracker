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
  ok('the state run publishes one entry', r.status === 'published' && r.result.touched.length === 1 && r.result.touched[0] === 'ca-sb-813-ivos', r.summary);
  ok('the step becomes an event typed by the state rules, with the bill number and the legislature page', e.events.some((v) => v.date === '2026-09-08' && v.type === 'Passed / advanced' && v.text === 'CA SB813: Enrolled and presented to the Governor at 4 p.m.' && /leginfo\.legislature\.ca\.gov/.test(v.source_url)));
  ok('the status text names the legislature as the source', /CA SB813: Enrolled and presented to the Governor at 4 p\.m\. \(Sept 8, 2026, CA Legislature\)$/.test(e.status_text));
  ok('the entry gets its LegiScan identifiers when it becomes mixed', e.origin === 'mixed' && e.identifiers && e.identifiers.external.legiscan.includes(1980543));
  ok('the status is unchanged (already enacted)', e.status === 'enacted');
  const n = d.news.items.filter((x) => x.origin === 'automated');
  ok('one state news item, quoting the official words without the bill prefix', n.length === 1 && n[0].kind === 'state' && n[0].evidence[0].quote === 'Enrolled and presented to the Governor at 4 p.m.' && n[0].links[0].u.includes('leginfo'));
  ok('the cut-off moves to the run date', d.site.updates_through === '2026-10-16' && d.news.asof === 'October 16, 2026');
}

console.log(`legiscan publish: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
