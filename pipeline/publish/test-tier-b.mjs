// Tier B tests: a new bill drafted by the agents (built here with the real assembleEntry, no AI) published on top of the S. 2938 run
// of 6 Oct 2026 against the site data of 8 Oct 2026. The switch, the per-run limit, quotes checked against the stored record, already
// tracked bills, numbering of two drafts from one run, the tracked list, the news item, and the stricter guard path. No network.
//   node publish/test-tier-b.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { publishRun, loadData } from './run.mjs';
import { checkPublish, checkNewEntry } from './guards.mjs';
import { assembleEntry } from '../agents/assemble.mjs';
import { sha } from '../grabber/lib/run-common.mjs';
import { publishEntry } from '../report/build.mjs';
import { sourceText } from '../agents/source-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, '..', 'fixtures', 'publish');
const ON = { max_entries_changed_per_run: 15, max_new_entries_per_run: 3, news_from_official_actions: true, auto_publish: { new_entries: true } };
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const j = (f) => JSON.parse(fs.readFileSync(f, 'utf8')), w = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 1));

// A new House bill as Congress.gov returns it, with its text.
function bill(n, title) {
  return {
    id: `119/hr/${n}`, bill: { type: 'HR', number: String(n), congress: 119, title, introducedDate: '2026-10-02', originChamber: 'House', sponsors: [{ fullName: 'Rep. Doe, Jane [D-CA-12]' }], latestAction: { actionDate: '2026-10-02', text: 'Referred to the House Committee on Energy and Commerce.' } },
    actions: [], summaries: [],
    text: 'SEC. 2. DUTIES. A developer of a frontier model trained using more than 10^26 integer or floating-point operations shall publish a safety and security protocol before deployment. SEC. 4. ENFORCEMENT. A developer that violates section 2 is liable for a civil penalty of not more than $1,000,000 for each violation.'
  };
}
const PATCH = {
  operation: 'create', in_scope: true, scope_reason: 'Regulates developers of frontier models.', events_add: [],
  fields: { section: 'D', mechanism: 'Requires developers of large frontier models to publish a safety and security protocol before deployment.', thresholds: 'Models trained using more than 10^26 operations.', penalties: 'Civil penalty of up to $1,000,000 per violation.' },
  evidence: [{ field: 'mechanism', quote: 'shall publish a safety and security protocol before deployment' }, { field: 'thresholds', quote: 'trained using more than 10^26 integer or floating-point operations' }, { field: 'penalties', quote: 'civil penalty of not more than $1,000,000 for each violation' }]
};

// The S. 2938 run plus new bills, each with its stored record, its change-set and diff rows, and the agents' result file.
// edit(draft, n) may change a draft before it is saved; tweak(dirs) may change anything else.
function setup({ bills = [[9990, 'Frontier Model Safety Testing Act']], edit = () => {}, tweak = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-b-'));
  const dataDir = path.join(dir, 'data'), docsDir = path.join(dir, 'docs'), runDir = path.join(dir, 'run'), idsFile = path.join(dir, 'identifiers.json');
  fs.cpSync(path.join(FX, 'data-2026-10-08'), dataDir, { recursive: true });
  fs.cpSync(path.join(FX, 'run-20261006'), runDir, { recursive: true });
  w(idsFile, { _note: 'test', congress_gov: {} });
  const changeset = j(path.join(runDir, 'changeset.json')), diff = j(path.join(runDir, 'diff.json')), entries = j(path.join(dataDir, 'entries.json'));
  const summary = { run_id: changeset.run_id, outcomes: { publishable: bills.length }, items: [] };
  fs.mkdirSync(path.join(runDir, 'results'), { recursive: true });
  for (const [n, title] of bills) {
    const raw = bill(n, title), text = JSON.stringify(raw, null, 1), rel = `raw/congress_gov/119-hr-${n}.json`;
    fs.writeFileSync(path.join(runDir, rel), text);
    const item = { item_id: `congress_gov:119/hr/${n}`, source: 'congress_gov', source_id: `119/hr/${n}`, entry_key: null, change: 'new', reason: 'search', source_url: `https://www.congress.gov/bill/119th-congress/house-bill/${n}`, fetched_at: '2026-10-06T15:53:30Z', raw_hash: sha(text), raw_path: rel, title };
    changeset.items.push(item);
    diff.items.push({ item_id: item.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: `New bill "${title}"` }] });
    // Each draft is assembled against the same data, as the agents do it: so two drafts get the same id.
    const asm = assembleEntry({ entry: null, patch: JSON.parse(JSON.stringify(PATCH)), item, raw, today: '2026-10-06', runId: changeset.run_id, rounds: 1, entries, now: new Date('2026-10-06T16:00:00Z') });
    if (asm.problems.length) throw new Error('fixture draft did not assemble: ' + asm.problems.join('; '));
    const r = { item_id: item.item_id, outcome: 'publishable', operation: 'create', attempts: 1, entry: asm.entry, patch: PATCH, verdicts: [], reason: null };
    edit(r, n);
    w(path.join(runDir, 'results', item.item_id.replace(/[^A-Za-z0-9._-]+/g, '-') + '.json'), r);
    summary.items.push({ item_id: item.item_id, outcome: r.outcome });
  }
  w(path.join(runDir, 'changeset.json'), changeset); w(path.join(runDir, 'diff.json'), diff); w(path.join(runDir, 'results.json'), summary);
  const s = { dir, dataDir, docsDir, runDir, idsFile };
  tweak(s);
  s.mtimes = () => [...fs.readdirSync(dataDir).map((f) => fs.statSync(path.join(dataDir, f)).mtimeMs + f), fs.statSync(idsFile).mtimeMs].join();
  return s;
}
const publish = (s, over = {}, dry = false) => publishRun({ runDir: s.runDir, dataDir: s.dataDir, docsDir: s.docsDir, idsFile: s.idsFile, dry, config: { ...ON, ...over } });
const newOnes = (dir) => loadData(dir).entries.filter((e) => e.origin === 'automated');

// ---------- switched off (as shipped): the draft is reported as ready, Tier A still runs ----------
{
  const s = setup(), ids = fs.readFileSync(s.idsFile, 'utf8');
  const r = publish(s, { auto_publish: { new_entries: false } });
  ok('switch off: the Tier A update still publishes', r.status === 'published' && r.result.touched.length === 1, r.summary);
  ok('switch off: no new entry, and the draft is reported as ready', newOnes(s.dataDir).length === 0 && r.result.added.length === 0 && r.result.skipped.some((x) => x.item_id === 'congress_gov:119/hr/9990' && /switched off/.test(x.why)));
  ok('switch off: the tracked list is untouched', fs.readFileSync(s.idsFile, 'utf8') === ids);
}

// ---------- switched on: the new bill is added ----------
{
  const s = setup(), before = loadData(s.dataDir);
  const r = publish(s), d = loadData(s.dataDir), e = d.entries.find((x) => x.origin === 'automated');
  ok('the run publishes, with one new entry', r.status === 'published' && r.result.added.length === 1 && !!e, r.summary);
  ok('the entry is numbered after the highest id and keyed from its short name', e.id === Math.max(...before.entries.map((x) => x.id)) + 1 && /^h-r-9990-frontier-model-safety-testing-act/.test(e.key), `${e.id} ${e.key}`);
  ok('the rules decide section, type, level and status', e.section === 'D' && e.type === 'bill' && e.level === 'federal' && e.status === 'pending' && e.jurisdiction === 'Federal');
  ok('facts from the record are written by code', e.title === 'H.R. 9990 — Frontier Model Safety Testing Act' && e.sponsor_text === 'Rep. Jane Doe (D-CA)' && e.events.some((v) => v.date === '2026-10-02' && v.type === 'Introduced / published'));
  ok('the reading fields come with their quotes', ['mechanism', 'thresholds', 'penalties'].every((f) => e[f] && e.evidence.some((x) => x.field === f)));
  ok('it is tracked by its Congress.gov id, so the grabber keeps it current', e.identifiers.external.congress_gov.includes('119/hr/9990'));
  ok('it is dated by the run and marked as the pipeline\'s', e.last_checked === '2026-10-06' && e.last_changed === '2026-10-06' && e.origin === 'automated' && e.verification.method === 'agent' && e.verification.run_id === 'run-20261006-1553-c59a');
  const n = d.news.items.find((x) => x.tracker === e.key);
  ok('one "introduced" news item in fixed wording, dated by the record', n && n.date === '2026-10-02' && n.kind === 'federal' && n.title === `${e.short_name}: introduced` && /^Congress\.gov records that H\.R\. 9990 .* was introduced on Oct 2, 2026, sponsored by Rep\. Jane Doe \(D-CA\)\.$/.test(n.body) && /no AI/.test(n.check), n && n.body);
  ok('the news item quotes the official title', n && n.evidence[0].quote === 'Frontier Model Safety Testing Act');
  ok('the change log records the new entry as Tier B', d.changes.items.some((c) => c.entry_key === e.key && c.field === 'entry' && c.old === null && c.tier === 'B'));
  ok('the Tier A update in the same run is still applied', d.entries.find((x) => x.key === 's-2938-ai-risk-evaluation-act').origin === 'mixed');
  const ids = j(s.idsFile).congress_gov[e.key];
  ok('the bill joins the tracked list as confirmed, added by the pipeline', ids && ids.status === 'confirmed' && ids.added_by === 'pipeline' && ids.congress_gov[0] === '119/hr/9990' && ids.entry_id === e.id);
  ok('the live site gets the same files', fs.readFileSync(path.join(s.docsDir, 'entries.json'), 'utf8') === fs.readFileSync(path.join(s.dataDir, 'entries.json'), 'utf8'));
  ok('the summary names the new entry', /1 new entry added/.test(r.summary) && /NEW h-r-9990/.test(r.summary) && /Tier B: new entries/.test(r.summary));
  const p = publishEntry({ result: r.result, status: r.status });
  ok('the run report lists it under entries added', p.entries_added.length === 1 && p.entries_added[0].entry_key === e.key && p.entries_added[0].item_id === 'congress_gov:119/hr/9990');
  // the same run again: the bill is tracked now
  const m = s.mtimes(), r2 = publish(s);
  ok('publishing the same run again adds nothing and writes nothing', r2.status === 'quiet' && s.mtimes() === m && newOnes(s.dataDir).length === 1 && r2.result.skipped.some((x) => /already tracked/.test(x.why)), r2.status);
}

// ---------- dry run ----------
{
  const s = setup(), m = s.mtimes(), r = publish(s, {}, true);
  ok('a dry run reports the new entry but writes nothing, not even the tracked list', r.status === 'dry-run' && r.result.added.length === 1 && s.mtimes() === m);
}

// ---------- two drafts from one run, and the per-run limit ----------
{
  const two = [[9990, 'Frontier Model Safety Testing Act'], [9991, 'Frontier Model Transparency Act']];
  const s = setup({ bills: two }), r = publish(s), e = newOnes(s.dataDir);
  ok('two drafts numbered alike by the agents get their own ids', r.result.added.length === 2 && e.length === 2 && e[0].id !== e[1].id && e[0].key !== e[1].key, e.map((x) => x.id + ' ' + x.key).join(', '));
  const s2 = setup({ bills: two }), r2 = publish(s2, { max_new_entries_per_run: 1 });
  ok('over the per-run limit, the rest wait for a later run', r2.status === 'published' && r2.result.added.length === 1 && r2.result.skipped.some((x) => x.item_id === 'congress_gov:119/hr/9991' && /over the limit of 1/.test(x.why)) && newOnes(s2.dataDir).length === 1);
}

// ---------- not proved: nothing is added ----------
{
  const s = setup({ edit: (r) => { r.entry.evidence.find((x) => x.field === 'penalties').quote = 'civil penalty of not more than $5,000,000 for each violation'; } });
  const r = publish(s);
  ok('a quote that is not in the stored record keeps the entry out', r.result.added.length === 0 && newOnes(s.dataDir).length === 0 && r.result.skipped.some((x) => /quote for penalties is not in the stored record/.test(x.why)), r.summary);
}
{
  const s = setup({ edit: (r) => { r.entry.evidence = r.entry.evidence.filter((x) => x.field !== 'thresholds'); } });
  const r = publish(s);
  ok('a reading field without a quote keeps the entry out', r.result.added.length === 0 && r.result.skipped.some((x) => /no evidence quote for thresholds/.test(x.why)));
}
{
  const s = setup({ edit: (r) => { r.entry.status = 'enacted'; } });
  const r = publish(s);
  ok('a status the record did not give keeps the entry out', r.result.added.length === 0 && r.result.skipped.some((x) => /status enacted is not what the record gives \(pending\)/.test(x.why)), r.summary);
}
{
  const s = setup({ tweak: (x) => { const f = path.join(x.dataDir, 'entries.json'), es = j(f); es[0].identifiers = { external: { congress_gov: ['119/hr/9990'] } }; w(f, es); } });
  const r = publish(s);
  ok('a bill an existing entry already tracks is not added twice', r.result.added.length === 0 && r.result.skipped.some((x) => /already tracked/.test(x.why)));
}
{
  const s = setup({ tweak: (x) => fs.appendFileSync(path.join(x.runDir, 'raw', 'congress_gov', '119-hr-9990.json'), ' ') });
  const m = s.mtimes(), r = publish(s);
  ok('stop: the new bill\'s stored record changed after it was fetched', r.status === 'stopped' && r.check.problems.some((p) => /stored source changed since it was fetched: congress_gov:119\/hr\/9990/.test(p)) && s.mtimes() === m);
}
{
  const s = setup({ edit: (r) => { r.outcome = 'held'; } });
  ok('only drafts marked publishable are read', publish(s).result.added.length === 0);
}

// ---------- the stricter guard path, directly ----------
{
  const s = setup(), r = publish(s), before = loadData(path.join(FX, 'data-2026-10-08')), after = loadData(s.dataDir), key = r.result.added[0].entry_key;
  const variant = (f, opts = {}) => { const a = JSON.parse(JSON.stringify(after)); f(a, a.entries.find((x) => x.key === key)); return checkPublish({ before, after: a, runDate: '2026-10-08', maxEntries: 15, maxNew: 3, newKeys: [key], ...opts }).problems; };
  ok('the published data passes every rule', variant(() => {}).length === 0, variant(() => {}).join('; '));
  ok('stop: a new entry Tier B did not create', variant(() => {}, { newKeys: [] }).some((p) => /not created by Tier B/.test(p)));
  ok('stop: more new entries than the per-run limit', variant(() => {}, { maxNew: 0 }).some((p) => /over the limit of 0 per run/.test(p)));
  ok('stop: a new entry in a section that needs a person', variant((a, e) => { e.section = 'B'; e.type = 'bill'; e.level = 'state'; }).some((p) => /section B needs a person/.test(p)));
  ok('stop: a type that does not follow the section rule', variant((a, e) => { e.type = 'law'; }).some((p) => /do not follow the rule for section D/.test(p)));
  ok('stop: a reading field without evidence', variant((a, e) => { e.evidence = e.evidence.filter((x) => x.field !== 'mechanism'); }).some((p) => /no evidence quote for mechanism/.test(p)));
  ok('stop: a "none located" finding written by the pipeline', variant((a, e) => { e.penalties = 'No penalties located.'; }).some((p) => /search finding/.test(p)));
  ok('stop: a new entry not marked as the pipeline\'s', variant((a, e) => { e.origin = 'authored'; }).some((p) => /not marked as written and checked by the pipeline/.test(p)));
  ok('stop: a future event on a new entry not marked scheduled', variant((a, e) => { e.events.push({ date: '2026-12-01', precision: 'day', type: 'Passed / advanced', text: 'x', scheduled: false }); }).some((p) => /future event not marked scheduled on h-r-9990/.test(p)));
  ok('checkNewEntry passes a well-formed draft', checkNewEntry(after.entries.find((x) => x.key === key)).length === 0);
}

// ---------- duties written by the agents' duty step (agents/duties.mjs) ----------
{
  const url = 'https://www.congress.gov/bill/119th-congress/house-bill/9990', text = sourceText(bill(9990, 'Frontier Model Safety Testing Act'), 'congress_gov');
  const none = (summary) => ({ value: 'not_in_bill', summary });
  const duties = () => ({
    framework: { value: 'yes', summary: 'Developers of frontier models must publish a safety and security protocol before deployment.', section: 'Sec. 2', quote: 'shall publish a safety and security protocol before deployment', source_url: url },
    transparency_report: none('No public model report is required.'), incident_reporting: none('No incident reporting.'), imminent_risk_reporting: none('No shorter window.'),
    third_party_audit: none('No audit.'), whistleblower: none('No employee protections.'), registration: none('No registration.'), shutdown: none('No shutdown duty.'),
    compute_threshold: { value: 'yes', summary: 'Covers models trained using more than 10^26 operations.', section: 'Sec. 2', quote: 'trained using more than 10^26 integer or floating-point operations', source_url: url },
    revenue_threshold: none('No revenue test.'), harm_threshold: none('No harm figures.'),
    penalties: { value: 'yes', summary: 'Civil penalty of not more than $1,000,000 for each violation.', section: 'Sec. 4', quote: 'civil penalty of not more than $1,000,000 for each violation', source_url: url },
    effective_date: none('No effective date stated.')
  });
  const basis = () => ({ source_url: url, sha256: sha(text), chars: text.length, method: 'agent', checked_at: '2026-10-06T16:00:00Z' });
  const withDuties = (change = () => {}) => setup({ edit: (r) => { r.entry.duties = duties(); r.entry.duties_basis = basis(); change(r.entry); } });
  {
    const s = withDuties(), r = publish(s), e = newOnes(s.dataDir)[0];
    ok('duties: a new entry with proved duties is published with them and their basis', r.status === 'published' && e && e.duties && e.duties.penalties.value === 'yes' && e.duties_basis.method === 'agent', r.summary);
  }
  const skippedFor = (change, re, name) => { const s = withDuties(change), r = publish(s); ok(name, newOnes(s.dataDir).length === 0 && r.result.skipped.some((x) => re.test(x.why)), JSON.stringify(r.result.skipped)); };
  skippedFor((e) => { e.duties.penalties.quote = 'civil penalty of not more than $5,000,000 for each violation'; }, /duty penalties: the quote is not in the official text/, 'duties: an answer whose quote is not in the stored record stops the new entry');
  skippedFor((e) => { e.duties.framework.section = 'Sec. 77'; }, /duty framework: the section "Sec. 77"/, 'duties: a section number the record does not have stops the new entry');
  skippedFor((e) => { e.duties_basis.sha256 = 'a'.repeat(64); }, /different text than the stored record/, 'duties: duties read from another text (hash differs) stop the new entry');
  skippedFor((e) => { delete e.duties.shutdown; }, /duty format/, 'duties: a duty set missing an answer stops the new entry');
  skippedFor((e) => { delete e.duties_basis; }, /duties without a duties_basis/, 'duties: duties with no basis from the pipeline stop the new entry');
  skippedFor((e) => { e.duties_basis.method = 'session'; }, /duties without a duties_basis from the pipeline/, 'duties: duties marked as session-written are not accepted on a new entry');
}

console.log(`tier B publish: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
