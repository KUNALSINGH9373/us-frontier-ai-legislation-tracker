// Cosponsor totals as record facts (Tier A): compare spots a changed total, the publisher writes it in fixed wording, the guards let
// only that fixed-wording end of the hand-written sponsor text change. Built on the site data of 8 Oct 2026 and the real Congress.gov
// record of H.R. 9925 (11 cosponsors). No network.
//   node publish/test-cosponsors.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { publishRun, loadData } from './run.mjs';
import { checkPublish, sponsorTextProblem } from './guards.mjs';
import { compareRun } from '../compare/run.mjs';
import { compareCongress, knownCosponsors } from '../compare/congress.mjs';
import { sha } from '../grabber/lib/run-common.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { runAgents } from '../agents/run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, '..', 'fixtures');
const CONFIG = { max_entries_changed_per_run: 15, news_from_official_actions: true };
const KEY = 'h-r-9925-frontier-act', HAND = 'Reps. Jay Obernolte (R-CA), Lori Trahan (D-MA), Franklin (R-FL), Peters (D-CA), Houchin (R-IN), Subramanyam (D-VA)';
const URL_9925 = 'https://www.congress.gov/bill/119th-congress/house-bill/9925';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const j = (f) => JSON.parse(fs.readFileSync(f, 'utf8')), w = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 1));

// A temp copy of the data and a one-item run for H.R. 9925. editEntry changes the entry; count overrides the record's total.
function setup({ editEntry = () => {}, count = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosponsors-'));
  const dataDir = path.join(dir, 'data'), docsDir = path.join(dir, 'docs'), runDir = path.join(dir, 'run');
  fs.cpSync(path.join(FX, 'publish', 'data-2026-10-08'), dataDir, { recursive: true });
  const entries = j(path.join(dataDir, 'entries.json'));
  editEntry(entries.find((e) => e.key === KEY), entries);
  w(path.join(dataDir, 'entries.json'), entries);
  const bill = j(path.join(FX, 'congress', '119-hr-9925.json')).bill;
  if (count !== null) bill.cosponsors.count = count;
  const raw = JSON.stringify({ id: '119/hr/9925', list_item: null, bill, actions: [], summaries: [] }, null, 1);
  fs.mkdirSync(path.join(runDir, 'raw', 'congress_gov'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'raw', 'congress_gov', '119-hr-9925.json'), raw);
  w(path.join(runDir, 'changeset.json'), { run_id: 'run-20261028-0900-abcd', generated_at: '2026-10-28T09:00:00Z', items: [{ item_id: 'congress_gov:119/hr/9925', source: 'congress_gov', source_id: '119/hr/9925', entry_key: KEY, change: 'changed', reason: 'updated_since_cursor', source_url: URL_9925, fetched_at: '2026-10-28T09:00:00Z', raw_hash: sha(raw), raw_path: 'raw/congress_gov/119-hr-9925.json', title: 'FRONTIER Act' }] });
  const diff = compareRun({ runDir, entries });
  return { dataDir, docsDir, runDir, diff };
}
const publish = (s) => publishRun({ runDir: s.runDir, dataDir: s.dataDir, docsDir: s.docsDir, config: CONFIG });
const entry = (dir) => loadData(dir).entries.find((e) => e.key === KEY);

// ---------- 1. a total in the fixed wording, now out of date ----------
{
  const s = setup({ editEntry: (e) => { e.sponsor_text = HAND + '; 9 cosponsors in all (Congress.gov)'; } });
  const d = s.diff.items[0];
  ok('compare: a changed total on the record is material, with the record\'s number', d.verdict === 'material' && d.reasons.length === 1 && d.reasons[0].kind === 'cosponsors_change' && d.reasons[0].api_value === '11' && d.reasons[0].our_value === '9', JSON.stringify(d));
  ok('the diff passes its schema', makeValidator().check('diff', d).length === 0);
  const r = publish(s), e = entry(s.dataDir), data = loadData(s.dataDir);
  ok('it publishes', r.status === 'published', r.summary);
  ok('sponsor text: the hand-written part kept, the fixed-wording end replaced', e.sponsor_text === HAND + '; 11 cosponsors in all (Congress.gov)', e.sponsor_text);
  ok('the total is stored as a record fact with date and source', JSON.stringify(e.record_facts) === JSON.stringify({ cosponsors: { count: 11, as_of: '2026-10-28', source_url: URL_9925 } }), JSON.stringify(e.record_facts));
  ok('the entry passes its schema', makeValidator().check('entry', e).length === 0);
  ok('reading fields and status untouched', ['mechanism', 'thresholds', 'penalties', 'title', 'status', 'status_text'].every((f) => JSON.stringify(e[f]) === JSON.stringify(loadData(path.join(FX, 'publish', 'data-2026-10-08')).entries.find((x) => x.key === KEY)[f])));
  ok('the change log has both fields, tier A', ['sponsor_text', 'record_facts.cosponsors'].every((f) => data.changes.items.some((c) => c.entry_key === KEY && c.field === f && c.tier === 'A' && c.source_url === URL_9925)) && data.changes.items.find((c) => c.field === 'sponsor_text').old === HAND + '; 9 cosponsors in all (Congress.gov)');
  ok('marked checked and changed by the run; no news item for a cosponsor total', e.last_changed === '2026-10-28' && e.verification.method === 'agent' && !data.news.items.some((n) => n.tracker === KEY && n.origin === 'automated'));
  ok('the summary says it', /cosponsors now 11/.test(r.summary));
  // the AI step never reads an item whose only change is a cosponsor total (a scripted model that fails the test if asked)
  let asked = 0;
  const llm = { generate: async () => { asked++; throw new Error('the AI was asked'); } };
  const factory = { make: () => llm, ledger: { itemTokens: () => null, totals: () => ({}) }, keyName: 'TEST' };
  const sa = await runAgents({ runDir: s.runDir, entries: loadData(path.join(FX, 'publish', 'data-2026-10-08')).entries, factory, today: '2026-10-28', log: () => {} });
  ok('the AI step skips an item whose only change is a cosponsor total', asked === 0 && sa.eligible_items === 0, JSON.stringify(sa));
  ok('docs copy written too', JSON.stringify(j(path.join(s.docsDir, 'entries.json')).find((x) => x.key === KEY).record_facts) === JSON.stringify(e.record_facts));
  // the next run with the same record: nothing to do
  const again = compareCongress({ item: { item_id: 'x' }, raw: { bill: j(path.join(FX, 'congress', '119-hr-9925.json')).bill, actions: [] }, entry: e });
  ok('once written, the same total is not material again', !again.reasons.some((x) => x.kind === 'cosponsors_change'));
}

// ---------- 2. the cases where nothing is written ----------
{
  const s = setup(); // the fixture's hand-written text has no total the code can read
  ok('no readable total on the entry: not material, nothing written', s.diff.items[0].verdict !== 'material' && publish(s).status === 'quiet');
  const t = setup({ editEntry: (e) => { e.sponsor_text = HAND + '; 11 cosponsors in all (Congress.gov)'; } });
  ok('the same total: nothing to do', !t.diff.items[0].reasons.some((x) => x.kind === 'cosponsors_change'));
  const m = setup({ editEntry: (e) => { e.sponsor_text = HAND + '; 9 cosponsors in all (Congress.gov)'; e.identifiers.external.congress_gov.push('119/s/9999'); } });
  ok('an entry covering several bills: totals are never mixed', !m.diff.items[0].reasons.some((x) => x.kind === 'cosponsors_change'));
  ok('hand-written wording is never parsed', knownCosponsors({ sponsor_text: 'House cosponsors Khanna, Lynch (twelve as of Oct 27, 2026)' }) === null && knownCosponsors({ sponsor_text: 'X; 13 Senate and 9 House cosponsors in all (Congress.gov)' }) === null);
  // the diff claims a total the stored record does not have
  const f = setup({ editEntry: (e) => { e.sponsor_text = HAND + '; 9 cosponsors in all (Congress.gov)'; } });
  f.diff.items[0].reasons[0].api_value = '12'; w(path.join(f.runDir, 'diff.json'), f.diff);
  const rf = publish(f);
  ok('a total not in the stored record is not written', rf.status === 'quiet' && /not found in the stored record/.test(rf.summary), rf.summary);
}

// ---------- 3. a structured total, a text without the fixed end; and one cosponsor ----------
{
  const s = setup({ count: 1, editEntry: (e) => { e.record_facts = { cosponsors: { count: 0, as_of: '2026-10-01', source_url: URL_9925 } }; } });
  ok('the stored total is used when the text has none', s.diff.items[0].reasons[0] && s.diff.items[0].reasons[0].our_value === '0');
  const r = publish(s), e = entry(s.dataDir);
  ok('the fixed wording is added, singular for one', r.status === 'published' && e.sponsor_text === HAND + '; 1 cosponsor in all (Congress.gov)' && e.record_facts.cosponsors.count === 1, e.sponsor_text);
  const data = loadData(s.dataDir);
  ok('the old stored total is in the change log', data.changes.items.find((c) => c.field === 'record_facts.cosponsors').old.count === 0);
}

// ---------- 4. the guard: only the fixed-wording end may change ----------
{
  const base = { sponsor_text: HAND + '; 9 cosponsors in all (Congress.gov)' };
  const facts = (n) => ({ record_facts: { cosponsors: { count: n, as_of: '2026-10-28', source_url: URL_9925 } } });
  ok('the guard allows the fixed end, to the stored total', sponsorTextProblem(base, { ...facts(11), sponsor_text: HAND + '; 11 cosponsors in all (Congress.gov)' }) === null);
  ok('the guard refuses a change to the hand-written part', /hand-written part/.test(sponsorTextProblem(base, { ...facts(11), sponsor_text: 'Rep. Someone Else; 11 cosponsors in all (Congress.gov)' })));
  ok('the guard refuses a total that is not the stored one', /fixed wording/.test(sponsorTextProblem(base, { ...facts(12), sponsor_text: HAND + '; 11 cosponsors in all (Congress.gov)' })));
  ok('the guard refuses a change with no stored total', /without a cosponsor total/.test(sponsorTextProblem(base, { sponsor_text: HAND + '; 11 cosponsors in all (Congress.gov)' })));
  // and through checkPublish: a hand edit of the sponsor text is still stopped
  const before = loadData(path.join(FX, 'publish', 'data-2026-10-08')), after = JSON.parse(JSON.stringify(before));
  after.entries.find((x) => x.key === KEY).sponsor_text = 'Rep. Someone Else';
  const c = checkPublish({ before, after, runDate: '2026-10-28', maxEntries: 15 });
  ok('checkPublish stops any other change to the sponsor text', c.problems.some((p) => /sponsor_text/.test(p) && p.includes(KEY)), JSON.stringify(c.problems));
  const bad = JSON.parse(JSON.stringify(before));
  bad.entries.find((x) => x.key === KEY).record_facts = { cosponsors: { count: -1, as_of: 'yesterday', source_url: URL_9925 } };
  ok('a malformed record fact fails the schema', checkPublish({ before, after: bad, runDate: '2026-10-28', maxEntries: 15 }).problems.some((p) => /schema/.test(p)));
}

console.log(`\ncosponsors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
