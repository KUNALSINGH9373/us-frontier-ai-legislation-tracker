// Tier B for a new STATE bill: a real LegiScan candidate (AZ HB 4098 and NE LB 1185, saved by the grabber on 13 Oct 2026), drafted with the
// real assembleEntry (no AI), published on top of the S. 2938 run of 6 Oct 2026 against the site data of 8 Oct 2026. The entry, its news item
// and its place in config/identifiers-legiscan.json; a dead bill; bills already tracked (by id, by the LegiScan list, by an entry's bill
// number); and the stricter guard path refusing a wrong section or level, a status the record did not give, an invented quote and missing ids.
//   node publish/test-tier-b-state.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { publishRun, loadData } from './run.mjs';
import { checkPublish, checkNewEntry } from './guards.mjs';
import { assembleEntry } from '../agents/assemble.mjs';
import { sha } from '../grabber/lib/run-common.mjs';
import { trackedBills } from '../grabber/run-legiscan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, '..', 'fixtures');
const ON = { max_entries_changed_per_run: 15, max_new_entries_per_run: 3, news_from_official_actions: true, auto_publish: { new_entries: true } };
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const j = (f) => JSON.parse(fs.readFileSync(f, 'utf8')), w = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 1));

const CANDIDATES = { az: 'AZ-HB4098-2112241.json', ne: 'NE-LB1185-2088052.json' };
const PATCHES = {
  az: {
    operation: 'create', in_scope: true, scope_reason: 'Duties on businesses using a frontier model owned or operated by a large developer.', events_add: [],
    fields: { section: 'B', mechanism: 'An artificial intelligence business must submit a transparency report to the attorney general before using or selling a high risk AI system and conduct a quarterly audit.', thresholds: 'A large developer has spent more than $5,000,000 developing and more than $100,000,000 training the frontier model.', penalties: 'Civil penalty of not more than $50,000 per violation, enforced by the attorney general.' },
    evidence: [{ field: 'mechanism', quote: 'shall submit a transparency report to the attorney general' }, { field: 'thresholds', quote: 'has spent more than $5,000,000 in developing the frontier model and more than $100,000,000 in training the frontier model' }, { field: 'penalties', quote: 'civil penalty of not more than $50,000 per violation' }]
  },
  ne: {
    operation: 'create', in_scope: true, scope_reason: 'Safety duties for conversational AI services.', events_add: [],
    fields: { section: 'B', mechanism: 'An operator must clearly and conspicuously disclose to each minor account holder that the account holder is interacting with artificial intelligence.' },
    evidence: [{ field: 'mechanism', quote: 'An operator shall clearly and conspicuously disclose to each minor account holder' }]
  }
};

// The S. 2938 run plus state candidates, each with its stored record, change-set and diff rows, and the agents' result file.
function setup({ bills = ['az'], edit = () => {}, tweak = () => {}, lsIds = { _note: 'test', legiscan: {} } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-b-state-'));
  const dataDir = path.join(dir, 'data'), docsDir = path.join(dir, 'docs'), runDir = path.join(dir, 'run'), idsFile = path.join(dir, 'identifiers.json'), lsIdsFile = path.join(dir, 'identifiers-legiscan.json');
  fs.cpSync(path.join(FX, 'publish', 'data-2026-10-08'), dataDir, { recursive: true });
  fs.cpSync(path.join(FX, 'publish', 'run-20261006'), runDir, { recursive: true });
  w(idsFile, { _note: 'test', congress_gov: {} }); w(lsIdsFile, lsIds);
  const changeset = j(path.join(runDir, 'changeset.json')), diff = j(path.join(runDir, 'diff.json')), entries = j(path.join(dataDir, 'entries.json'));
  const summary = { run_id: changeset.run_id, outcomes: { publishable: bills.length }, items: [] };
  fs.mkdirSync(path.join(runDir, 'results'), { recursive: true }); fs.mkdirSync(path.join(runDir, 'raw', 'legiscan'), { recursive: true });
  for (const k of bills) {
    const file = CANDIDATES[k], text = fs.readFileSync(path.join(FX, 'legiscan', 'candidates', file), 'utf8'), raw = JSON.parse(text), rel = `raw/legiscan/${file}`;
    fs.writeFileSync(path.join(runDir, rel), text);
    const b = raw.bill, item = { item_id: `legiscan:${b.bill_id}`, source: 'legiscan', source_id: String(b.bill_id), entry_key: null, change: 'new', reason: 'discovery', source_url: b.state_link, fetched_at: '2026-10-06T15:53:30Z', raw_hash: sha(text), raw_path: rel, title: `${b.state} ${b.bill_number}: ${b.title}` };
    changeset.items.push(item);
    diff.items.push({ item_id: item.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: `New state bill ${b.state} ${b.bill_number} "${b.title}" is not in the tracker.` }] });
    const asm = assembleEntry({ entry: null, patch: JSON.parse(JSON.stringify(PATCHES[k])), item, raw, today: '2026-10-06', runId: changeset.run_id, rounds: 1, entries, now: new Date('2026-10-06T16:00:00Z') });
    if (asm.problems.length) throw new Error('fixture draft did not assemble: ' + asm.problems.join('; '));
    const r = { item_id: item.item_id, outcome: 'publishable', operation: 'create', attempts: 1, entry: asm.entry, patch: PATCHES[k], verdicts: [], reason: null };
    edit(r, k);
    w(path.join(runDir, 'results', item.item_id.replace(/[^A-Za-z0-9._-]+/g, '-') + '.json'), r);
    summary.items.push({ item_id: item.item_id, outcome: r.outcome });
  }
  w(path.join(runDir, 'changeset.json'), changeset); w(path.join(runDir, 'diff.json'), diff); w(path.join(runDir, 'results.json'), summary);
  const s = { dir, dataDir, docsDir, runDir, idsFile, lsIdsFile };
  tweak(s);
  return s;
}
const publish = (s, over = {}) => publishRun({ runDir: s.runDir, dataDir: s.dataDir, docsDir: s.docsDir, idsFile: s.idsFile, lsIdsFile: s.lsIdsFile, config: { ...ON, ...over } });
const newOnes = (dir) => loadData(dir).entries.filter((e) => e.origin === 'automated');

// ---------- a new state bill is added ----------
{
  const s = setup(), r = publish(s), d = loadData(s.dataDir), e = d.entries.find((x) => x.origin === 'automated');
  ok('state: the run publishes, with one new entry', r.status === 'published' && r.result.added.length === 1 && !!e, r.summary);
  ok('state: section, type, level, jurisdiction, state and status by rule', e.section === 'B' && e.type === 'bill' && e.level === 'state' && e.jurisdiction === 'AZ' && e.state === 'AZ' && e.status === 'pending');
  ok('state: facts from the record in fixed wording', e.title === 'H.B. 4098 — Artificial intelligence business; attorney general' && e.short_name === 'AZ HB 4098' && e.key === 'az-hb-4098' && e.sponsor_text === 'Rep. Anastasia Travers (D)' && /^Status: Introduced Feb 10, 2026/.test(e.status_text));
  ok('state: tracked by its LegiScan id and session', e.identifiers.external.legiscan[0] === 2112241 && e.identifiers.session === 'Fifty-seventh Legislature - Second Regular Session (2026)');
  const n = d.news.items.find((x) => x.tracker === e.key);
  ok('state: one "introduced" news item in fixed wording, linking the legislature\'s page', n && n.date === '2026-02-10' && n.kind === 'state' && n.title === 'AZ HB 4098: introduced' && n.body === 'The AZ Legislature records that H.B. 4098 — Artificial intelligence business; attorney general was introduced on Feb 10, 2026, sponsored by Rep. Anastasia Travers (D).' && n.links[0].u === 'https://apps.azleg.gov/BillStatus/BillOverview/85620' && n.links[0].t === 'AZ HB 4098 on the AZ Legislature site' && /no AI/.test(n.check) && n.evidence[0].quote === 'Artificial intelligence business; attorney general', n && JSON.stringify(n));
  const ls = j(s.lsIdsFile).legiscan[e.key];
  ok('state: the bill joins config/identifiers-legiscan.json as a confirmed mapping, in the map-ids shape', ls && ls.status === 'confirmed' && ls.entry_id === e.id && ls.short_name === 'AZ HB 4098' && ls.added_by === 'pipeline' && ls.checks[0].result === 'match'
    && JSON.stringify(Object.keys(ls.bills[0])) === JSON.stringify(['bill_id', 'number', 'state', 'session_id', 'session_name', 'official_url', 'legiscan_url', 'year_end', 'session_open'])
    && ls.bills[0].bill_id === 2112241 && ls.bills[0].number === 'HB4098' && ls.bills[0].session_id === az().bill.session_id && ls.bills[0].official_url === 'https://apps.azleg.gov/BillStatus/BillOverview/85620' && ls.bills[0].legiscan_url === 'https://legiscan.com/AZ/bill/HB4098/2026' && ls.bills[0].session_open === true, JSON.stringify(ls));
  ok('state: the LegiScan grabber now watches it', trackedBills(j(s.lsIdsFile)).some((t) => t.entry_key === e.key && t.bill_id === 2112241 && t.session_id === az().bill.session_id));
  ok('state: the Congress list is not touched by a state bill', JSON.stringify(j(s.idsFile).congress_gov) === '{}');
  const r2 = publish(s);
  ok('state: publishing the same run again adds nothing (the bill is tracked now)', r2.status === 'quiet' && newOnes(s.dataDir).length === 1 && r2.result.skipped.some((x) => /already tracked/.test(x.why)), r2.status);
}
function az() { return j(path.join(FX, 'legiscan', 'candidates', CANDIDATES.az)); }

// ---------- a dead bill ----------
{
  const s = setup({ bills: ['ne'] }), r = publish(s), e = newOnes(s.dataDir)[0];
  ok('dead state bill: added with status failed, as the record gives it', r.status === 'published' && e && e.status === 'failed' && e.section === 'B' && /Indefinitely postponed \(Apr 17, 2026\)/.test(e.status_text), r.summary);
  const nb = j(s.lsIdsFile).legiscan[e.key].bills[0];
  ok('dead state bill: joins the LegiScan list with its session (109th Legislature, last year 2026)', nb.bill_id === 2088052 && nb.session_name === '109th Legislature' && nb.year_end === 2026 && nb.session_open === true, JSON.stringify(nb));
}

// ---------- already tracked: never added again ----------
{
  const s = setup({ lsIds: { legiscan: { 'az-old': { bills: [{ bill_id: 2112241, number: 'HB4098', state: 'AZ', session_id: 1, session_name: 'x' }], status: 'confirmed', entry_id: 1, short_name: 'x' } } } });
  const r = publish(s);
  ok('a bill already on the LegiScan list is not added', r.result.added.length === 0 && r.result.skipped.some((x) => x.item_id === 'legiscan:2112241' && /already tracked/.test(x.why)), JSON.stringify(r.result.skipped));
}
{
  const s = setup({ tweak: (x) => { const f = path.join(x.dataDir, 'entries.json'), es = j(f); es.find((e) => e.key === 'la-sb-474').identifiers = { session: '2026 Regular Session', external: { legiscan: [2112241] } }; w(f, es); } });
  const r = publish(s);
  ok('a bill an existing entry tracks by LegiScan id is not added', r.result.added.length === 0 && r.result.skipped.some((x) => /already tracked/.test(x.why)));
}
{
  const s = setup({ tweak: (x) => { const f = path.join(x.dataDir, 'entries.json'), es = j(f), e = es.find((y) => y.key === 'mi-hb-4668'); e.state = 'AZ'; e.jurisdiction = 'AZ'; e.title = 'H.B. 4098 — an entry written by hand'; w(f, es); } });
  const r = publish(s);
  ok('a bill a hand-written state entry names by number (no ids yet) is not added', r.result.added.length === 0 && r.result.skipped.some((x) => /already tracked \(an entry covers AZ HB4098\)/.test(x.why)), JSON.stringify(r.result.skipped));
}

// ---------- not proved: nothing is added ----------
const skippedFor = (edit, re, name) => { const s = setup({ edit }), r = publish(s); ok(name, newOnes(s.dataDir).length === 0 && r.result.skipped.some((x) => re.test(x.why)), JSON.stringify(r.result.skipped)); };
skippedFor((r) => { r.entry.evidence.find((x) => x.field === 'penalties').quote = 'civil penalty of not more than $500,000 per violation'; }, /quote for penalties is not in the stored record/, 'state: an invented quote keeps the entry out');
skippedFor((r) => { r.entry.status = 'failed'; }, /status failed is not what the record gives \(pending\)/, 'state: a status the record did not give keeps the entry out');
skippedFor((r) => { r.entry.section = 'D'; r.entry.type = 'bill'; r.entry.level = 'federal'; }, /federal entry has jurisdiction Federal/, 'state: a state bill filed in a federal section keeps the entry out');
skippedFor((r) => { r.entry.level = 'federal'; }, /do not follow the rule for section B/, 'state: a level that does not follow the section rule keeps the entry out');
skippedFor((r) => { r.entry.section = 'A'; r.entry.type = 'law'; }, /status pending does not follow the rule for section A/, 'state: a pending bill filed as an enacted law keeps the entry out');
skippedFor((r) => { r.entry.identifiers = { external: {} }; }, /needs its LegiScan id and session/, 'state: an entry without its LegiScan id and session keeps the entry out');
skippedFor((r) => { r.entry.identifiers.session = '2025 Regular Session'; }, /session "2025 Regular Session" is not the record's/, 'state: a session that is not the record\'s keeps the entry out');
skippedFor((r) => { r.entry.state = 'CA'; r.entry.jurisdiction = 'CA'; }, /jurisdiction\/state CA\/CA are not the record's state \(AZ\)/, 'state: a state that is not the record\'s keeps the entry out');

// ---------- the stricter guard path, directly ----------
{
  const s = setup(), r = publish(s), before = loadData(path.join(FX, 'publish', 'data-2026-10-08')), after = loadData(s.dataDir), key = r.result.added[0].entry_key;
  const variant = (f) => { const a = JSON.parse(JSON.stringify(after)); f(a.entries.find((x) => x.key === key)); return checkPublish({ before, after: a, runDate: '2026-10-08', maxEntries: 15, maxNew: 3, newKeys: [key] }).problems; };
  ok('state guard: the published data passes every rule', variant(() => {}).length === 0, variant(() => {}).join('; '));
  ok('checkNewEntry passes a correct state entry', checkNewEntry(after.entries.find((x) => x.key === key)).length === 0);
  ok('state guard: wrong section (a federal one)', variant((e) => { e.section = 'F'; }).some((p) => /type\/level bill\/state do not follow the rule for section F/.test(p)));
  ok('state guard: a section that needs a person', variant((e) => { e.section = 'H'; e.type = 'precursor'; }).some((p) => /section H needs a person/.test(p)));
  ok('state guard: an enacted status in B', variant((e) => { e.status = 'enacted'; }).some((p) => /status enacted does not follow the rule for section B/.test(p)));
  ok('state guard: "stalled" is a person\'s judgement, never the pipeline\'s', variant((e) => { e.status = 'stalled'; }).some((p) => /status stalled does not follow the rule for section B/.test(p)));
  ok('state guard: missing LegiScan ids', variant((e) => { delete e.identifiers.external.legiscan; }).some((p) => /needs its LegiScan id and session/.test(p)));
  ok('state guard: jurisdiction not the state', variant((e) => { e.jurisdiction = 'Federal'; }).some((p) => /two-letter state as both jurisdiction and state/.test(p)));
  ok('state guard: a reading field without evidence', variant((e) => { e.evidence = e.evidence.filter((x) => x.field !== 'thresholds'); }).some((p) => /no evidence quote for thresholds/.test(p)));
}

console.log(`tier B state publish: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
