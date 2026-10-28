// Run:  node correct/test.mjs
// The self-correction step with scripted models (no AI, no network) on a copy of the real site data: a confirmed fix is applied
// and logged, and every way a fix can be wrong (invented quote or number, a field it may not touch, the confirmer saying no, a stop
// rule) leaves the data as it was and marks the entry for a retry.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { correctRun } from './run.mjs';
import { pickEntries, nextState } from './select.mjs';
import { checkCorrection, fieldsFor, MAX_SOURCE_CHARS } from './review.mjs';
import { checkPublish } from '../publish/guards.mjs';
import { loadData } from '../publish/run.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { newReport, finalize } from '../report/build.mjs';
import { formatReport } from '../report/format.mjs';
import { formatHtml } from '../report/html.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const realData = path.join(here, '..', '..', 'web', 'data', 'v2');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const clone = (o) => JSON.parse(JSON.stringify(o));

const entries = JSON.parse(fs.readFileSync(path.join(realData, 'entries.json'), 'utf8'));
// Two federal bills with a short mechanism, so a corrected one stays under the length limit.
const [E1, E2] = entries.filter((e) => ['D', 'F'].includes(e.section) && e.origin === 'authored' && e.mechanism && e.mechanism.length < 600 && !/72|48|24/.test(e.mechanism)).slice(0, 2);
if (!E2) throw new Error('test needs two federal bill entries with a short mechanism');
const ADD = 'The developer shall report each critical safety incident within 72 hours.';
const TEXT = (e) => `SEC. 1. SHORT TITLE. ${e.title}.\nSEC. 2. ${e.mechanism}\nSEC. 3. INCIDENTS. ${ADD}\n`;
const URL = (e) => `https://www.congress.gov/bill/119th-congress/senate-bill/${e.id}/text`;

function fakeTexts(map) { return { sourceOf: (k) => (k in map ? 'congress_gov' : null), textFor: async (k) => (map[k] == null ? { text: null, why: 'no text published on Congress.gov yet' } : { text: map[k], url: URL(entries.find((e) => e.key === k)) }) }; }
function scripted(fn) { return { calls: [], async generate(req) { this.calls.push(req); const r = fn(req, this.calls.length); if (r instanceof Error) throw r; return { data: r, usage: {} }; } }; }
const goodFix = (e) => ({ corrections: [{ field: 'mechanism', kind: 'omission', problem: 'The 72-hour incident deadline is missing.', new_text: `${e.mechanism} Critical safety incidents must be reported within 72 hours.`, evidence: [{ quote: ADD }] }] });
const factoryOf = (reviewer, confirmer) => ({ keyName: 'ANTHROPIC_API_KEY', make: (role) => (role === 'reviewer' ? reviewer : role === 'confirmer' ? confirmer : null) });
const yes = () => ({ confirmed: true, quote: ADD, reason: 'SOURCE sets the 72-hour deadline.' });
const config = { max_entries_changed_per_run: 15, self_correction: { enabled: true, once_per_day: true, max_entries_per_run: 3, recheck_after_days: 30, max_retries: 3 } };

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'correct-test-'));
  for (const d of ['data', 'docs']) { fs.mkdirSync(path.join(dir, d)); for (const f of ['entries', 'news', 'site', 'changes', 'relationships']) if (fs.existsSync(path.join(realData, f + '.json'))) fs.copyFileSync(path.join(realData, f + '.json'), path.join(dir, d, f + '.json')); }
  return { dir, dataDir: path.join(dir, 'data'), docsDir: path.join(dir, 'docs'), stateFile: path.join(dir, 'state', 'corrections.json') };
}
const run = (sb, o) => correctRun({ dataDir: sb.dataDir, docsDir: sb.docsDir, stateFile: sb.stateFile, config, today: '2026-10-28', now: new Date('2026-10-28T06:00:00Z'), runId: 'update-test', ic: {}, il: {}, ...o });
const readEntry = (dir, key) => JSON.parse(fs.readFileSync(path.join(dir, 'entries.json'), 'utf8')).find((e) => e.key === key);
const state = (sb) => JSON.parse(fs.readFileSync(sb.stateFile, 'utf8'));

// ---------- 1. a confirmed omission is applied, logged and copied to the live folder ----------
{
  const sb = sandbox(), reviewer = scripted((req) => (req.itemId === 'correct:' + E1.key ? goodFix(E1) : { corrections: [] })), confirmer = scripted(yes);
  const r = await run(sb, { factory: factoryOf(reviewer, confirmer), texts: fakeTexts({ [E1.key]: TEXT(E1), [E2.key]: TEXT(E2) }) });
  ok('1 ran and wrote', r.ran && r.status === 'written', JSON.stringify(r.problems));
  ok('1 one field corrected', r.corrected.length === 1 && r.corrected[0].entry_key === E1.key && r.corrected[0].field === 'mechanism');
  const e = readEntry(sb.dataDir, E1.key);
  ok('1 new mechanism written', e.mechanism.endsWith('within 72 hours.'));
  ok('1 evidence carries the quote', e.evidence.some((x) => x.field === 'mechanism' && x.quote === ADD));
  ok('1 authored entry becomes mixed, checked by the pipeline', e.origin === 'mixed' && e.verification.method === 'agent' && e.verification.run_id === 'update-test');
  ok('1 dates moved', e.last_changed === '2026-10-28' && e.last_checked === '2026-10-28');
  ok('1 same in the live copy', JSON.stringify(readEntry(sb.docsDir, E1.key)) === JSON.stringify(e));
  const ch = JSON.parse(fs.readFileSync(path.join(sb.dataDir, 'changes.json'), 'utf8')).items.filter((x) => x.tier === 'C');
  ok('1 change log: field old -> new with the quote', ch.some((x) => x.entry_key === E1.key && x.field === 'mechanism' && x.old === E1.mechanism && /72 hours/.test(x.note)));
  ok('1 untouched entry unchanged', JSON.stringify(readEntry(sb.dataDir, E2.key)) === JSON.stringify(E2));
  const v = makeValidator(), after = loadData(sb.dataDir);
  ok('1 schema passes', after.entries.every((x) => !v.check('entry', x).length) && !v.check('changes', after.changes).length);
  ok('1 integrity passes', checkIntegrity(after).length === 0, checkIntegrity(after).join('; '));
  const s = state(sb);
  ok('1 state: last run and both entries recorded', s.last_run === '2026-10-28' && s.items[E1.key].outcome === 'corrected' && s.items[E2.key].outcome === 'clean' && !s.items[E2.key].retry);
  ok('1 confirmer asked once, per field', confirmer.calls.length === 1 && confirmer.calls[0].itemId === `correct:${E1.key}:mechanism`);

  // the same day again: skipped
  const again = await run(sb, { factory: factoryOf(reviewer, confirmer), texts: fakeTexts({ [E1.key]: TEXT(E1) }) });
  ok('1 once a day', !again.ran && again.skipped_why === 'already ran today');

  // the report shows it
  const rep = newReport({ id: 'update-test', now: new Date('2026-10-28T06:00:00Z') });
  rep.corrections = r; rep.names = { [E1.key]: E1.short_name };
  finalize(rep, { now: new Date('2026-10-28T06:01:00Z') });
  ok('1 report counts it as a change', rep.changed && rep.totals.fields_corrected === 1 && rep.totals.entries_rechecked === 2);
  ok('1 plain message lists it', /Self-check: 2 entries re-read against the bill text, 1 field corrected/.test(formatReport(rep)) && formatReport(rep).includes(E1.short_name));
  ok('1 html message lists it', /Self-check \(1 fixed\)/.test(formatHtml(rep).text) && !formatHtml(rep).silent);
}

// ---------- 2. every bad fix is refused; nothing is written; the entry is retried ----------
const bad = [
  ['invented quote', { ...goodFix(E1).corrections[0], evidence: [{ quote: 'The developer shall report each incident within 24 hours.' }] }, /quote not in the source/],
  ['invented number', { ...goodFix(E1).corrections[0], new_text: `${E1.mechanism} Incidents must be reported within 48 hours.` }, /numbers not in the source: 48/],
  ['a field it may not touch', { ...goodFix(E1).corrections[0], field: 'title' }, /may not be corrected/],
  ['penalties outside section A', { ...goodFix(E1).corrections[0], field: 'penalties', new_text: 'Report within 72 hours.' }, /may not be corrected/],
  ['no evidence', { ...goodFix(E1).corrections[0], evidence: [] }, /no evidence quote/],
  ['unchanged text', { ...goodFix(E1).corrections[0], new_text: E1.mechanism }, /same as the current/],
  ['a claim about what the bill lacks', { ...goodFix(E1).corrections[0], new_text: `${E1.mechanism} Report within 72 hours; no numeric compute or revenue threshold is set in the bill.` }, /does not contain/],
  ['date without a year',{ ...goodFix(E1).corrections[0], new_text: `${E1.mechanism} Report within 72 hours from Sept 30.` }, /without its year/]
];
for (const [name, c, re] of bad) {
  const sb = sandbox(), confirmer = scripted(yes);
  const r = await run(sb, { factory: factoryOf(scripted(() => ({ corrections: [c] })), confirmer), texts: fakeTexts({ [E1.key]: TEXT(E1) }) });
  ok(`2 ${name}: refused by code`, r.corrected.length === 0 && r.rejected.length === 1 && re.test(r.rejected[0].why), JSON.stringify(r.rejected));
  ok(`2 ${name}: confirmer never asked, nothing written`, confirmer.calls.length === 0 && JSON.stringify(readEntry(sb.dataDir, E1.key)) === JSON.stringify(E1));
  ok(`2 ${name}: retried next time`, state(sb).items[E1.key].retry === true && state(sb).items[E1.key].outcome === 'rejected');
}
{
  // too long the first time: the reader is told why, rewrites once, and the shorter text goes on to the confirmer
  const sb = sandbox(), long = { ...goodFix(E1).corrections[0], new_text: `${E1.mechanism} ${'Critical safety incidents must be reported within 72 hours. '.repeat(12)}` };
  const reviewer = scripted((req, n) => (n === 1 ? { corrections: [long] } : goodFix(E1)));
  const r = await run(sb, { factory: factoryOf(reviewer, scripted(yes)), texts: fakeTexts({ [E1.key]: TEXT(E1) }) });
  ok('2 rewrite: told the exact problem, then accepted', reviewer.calls.length === 2 && /REFUSED BY CODE[\s\S]*characters, over \d+/.test(reviewer.calls[1].prompt) && r.corrected.length === 1 && r.status === 'written');
}
{
  const sb = sandbox();
  const r = await run(sb, { factory: factoryOf(scripted(() => goodFix(E1)), scripted(() => ({ confirmed: false, quote: null, reason: 'SOURCE gives 72 hours only for some incidents.' }))), texts: fakeTexts({ [E1.key]: TEXT(E1) }) });
  ok('2 confirmer says no: nothing written', r.corrected.length === 0 && /not confirmed/.test(r.rejected[0].why) && JSON.stringify(readEntry(sb.dataDir, E1.key)) === JSON.stringify(E1));
}
{
  const sb = sandbox();
  const r = await run(sb, { factory: factoryOf(scripted(() => goodFix(E1)), scripted(() => ({ confirmed: true, quote: 'words SOURCE does not have', reason: 'x' }))), texts: fakeTexts({ [E1.key]: TEXT(E1) }) });
  ok("2 confirmer's own quote must be in the source", r.corrected.length === 0 && /quote is not in the source/.test(r.rejected[0].why));
}
{
  // a stop rule fails (a corrupt site file): nothing written, entry marked for a retry
  const sb = sandbox();
  const site = JSON.parse(fs.readFileSync(path.join(sb.dataDir, 'site.json'), 'utf8')); site.bogus_key = 1; fs.writeFileSync(path.join(sb.dataDir, 'site.json'), JSON.stringify(site));
  const r = await run(sb, { factory: factoryOf(scripted(() => goodFix(E1)), scripted(yes)), texts: fakeTexts({ [E1.key]: TEXT(E1) }) });
  ok('2 stop rule: stopped, nothing written', r.status === 'stopped' && JSON.stringify(readEntry(sb.dataDir, E1.key)) === JSON.stringify(E1), JSON.stringify(r.problems));
  ok('2 stop rule: retried', state(sb).items[E1.key].retry === true && state(sb).items[E1.key].outcome === 'error');
  const rep = newReport({ id: 'x' }); rep.corrections = r; finalize(rep);
  ok('2 stop rule: the message says so', /Self-check corrections were not written/.test(formatReport(rep)) && !rep.changed);
}

// ---------- 3. dry run, AI off, no text, too long ----------
{
  const sb = sandbox();
  const r = await run(sb, { dry: true, factory: factoryOf(scripted(() => goodFix(E1)), scripted(yes)), texts: fakeTexts({ [E1.key]: TEXT(E1) }) });
  ok('3 dry run: found, not written, no state', r.status === 'dry-run' && r.corrected.length === 1 && JSON.stringify(readEntry(sb.dataDir, E1.key)) === JSON.stringify(E1) && !fs.existsSync(sb.stateFile));
  const off = await run(sandbox(), { aiOff: 'dry run (no AI calls are made)', factory: factoryOf(null, null), texts: fakeTexts({}) });
  ok('3 AI off: skipped with the reason', !off.ran && /dry run/.test(off.skipped_why));
  const sb2 = sandbox(), rv = scripted(() => ({ corrections: [] }));
  const nt = await run(sb2, { factory: factoryOf(rv, scripted(yes)), texts: fakeTexts({ [E1.key]: null, [E2.key]: 'x'.repeat(MAX_SOURCE_CHARS + 1) }) });
  ok('3 no text: listed, not checked, no state', nt.missing_text.length === 1 && nt.missing_text[0].entry_key === E1.key && !state(sb2).items[E1.key]);
  ok('3 too long: no AI call, recorded without a retry', rv.calls.length === 0 && state(sb2).items[E2.key].outcome === 'too_long' && !state(sb2).items[E2.key].retry);
}

// ---------- 4. which entries are picked ----------
{
  const e = (key, extra = {}) => ({ key, section: 'D', mechanism: 'm', thresholds: 't', last_checked: '2026-10-01', ...extra });
  const cands = [
    { key: 'old', entry: e('old'), sha: 's' }, { key: 'changed', entry: e('changed'), sha: 'NEW' }, { key: 'retry', entry: e('retry'), sha: 's' },
    { key: 'gaveup', entry: e('gaveup'), sha: 's' }, { key: 'fresh', entry: e('fresh'), sha: 's' }, { key: 'new-full', entry: e('new-full'), sha: 's' },
    { key: 'new-empty', entry: e('new-empty', { thresholds: null }), sha: 's' }
  ];
  const st = { old: { text_sha: 's', checked_at: '2026-08-01' }, changed: { text_sha: 's', checked_at: '2026-10-27' }, retry: { text_sha: 's', checked_at: '2026-10-27', retry: true, retries: 1, outcome: 'rejected' },
    gaveup: { text_sha: 's', checked_at: '2026-10-27', retry: true, retries: 3 }, fresh: { text_sha: 's', checked_at: '2026-10-20' } };
  const { picked, waiting } = pickEntries({ candidates: cands, state: st, today: '2026-10-28', max: 10 });
  ok('4 order: text changed, retry, never checked (empty field first), oldest', picked.map((p) => p.key).join() === 'changed,retry,new-empty,new-full,old', picked.map((p) => p.key).join());
  ok('4 recently checked and retried-out entries wait', !picked.some((p) => ['fresh', 'gaveup'].includes(p.key)) && waiting === 0);
  ok('4 max per run', pickEntries({ candidates: cands, state: st, today: '2026-10-28', max: 2 }).waiting === 3);
  ok('4 retries count up on the same text, reset on a new one', nextState({ text_sha: 'a', retry: true, retries: 1 }, { sha: 'a', outcome: 'rejected', today: 't' }).retries === 2 && nextState({ text_sha: 'a', retry: true, retries: 2 }, { sha: 'b', outcome: 'rejected', today: 't' }).retries === 1 && nextState({ text_sha: 'a', retry: true, retries: 2 }, { sha: 'a', outcome: 'clean', today: 't' }).retry === false);
  ok('4 penalties only in section A', fieldsFor({ section: 'A' }).includes('penalties') && !fieldsFor({ section: 'D' }).includes('penalties'));
  ok('4 code check passes a clean fix', checkCorrection({ c: goodFix(E1).corrections[0], entry: E1, fields: fieldsFor(E1), source: TEXT(E1) }).length === 0);
}

// ---------- 5. the publisher's stop rules know about corrections ----------
{
  const before = loadData(realData), after = clone(before), e = after.entries.find((x) => x.key === E1.key);
  e.mechanism = 'changed'; e.title = 'changed too';
  const p1 = checkPublish({ before, after, runDate: '2026-10-28', maxEntries: 15 }).problems;
  ok('5 without the correction list, a mechanism change stops the run', p1.some((p) => /field mechanism changed/.test(p)));
  const p2 = checkPublish({ before, after, runDate: '2026-10-28', maxEntries: 15, corrected: { [E1.key]: ['mechanism'] } }).problems;
  ok('5 a corrected mechanism is allowed, the title still is not', !p2.some((p) => /field mechanism/.test(p)) && p2.some((p) => /field title changed/.test(p)));
  const p3 = checkPublish({ before, after: before, runDate: '2026-10-28', maxEntries: 15, corrected: { [E1.key]: ['title'] } }).problems;
  ok('5 a correction may not name a fact field', p3.some((p) => /only mechanism, thresholds, penalties may be corrected/.test(p)));
}

// ---------- 6. nothing true is lost (the 28 Oct live run's CT rewrite dropped the 10^26 and $500M definitions) ----------
{
  const { droppedFacts, expandAmounts } = await import('./review.mjs');
  const old = '"frontier developer" = doing business in CT + >10²⁶ FLOPs; "large frontier developer" = >$500M revenue; civil penalty up to $1,000 per violation';
  const ct = droppedFacts({ c: { kind: 'omission', problem: 'adds the employee notice duty' }, old, v: 'frontier developers must give notice; civil penalty up to $1,000 per violation, with investigation costs' });
  ok('6 an omission fix that drops figures is refused', ct.some((x) => /drops figures/.test(x) && /26/.test(x) && /500000000/.test(x)));
  ok('6 ... and one that drops a defined term', ct.some((x) => /drops defined terms/.test(x) && /large frontier developer/.test(x)));
  ok('6 the same figure written out in full is kept ($500M = $500,000,000)', droppedFacts({ c: { kind: 'omission', problem: '' }, old: '>$500M revenue; $1B damage', v: '>$500,000,000 annual gross revenues; $1,000,000,000 damage' }).length === 0);
  ok('6 an error fix may drop a figure its problem names as wrong', droppedFacts({ c: { kind: 'error', problem: 'The deadline is 15 days, not 30 days.' }, old: 'report within 30 days', v: 'report within 15 days' }).length === 0);
  ok('6 ... but not one its problem does not name', droppedFacts({ c: { kind: 'error', problem: 'Wrong deadline.' }, old: 'report within 30 days', v: 'report within 15 days' }).length === 1);
  ok('6 amounts are expanded', expandAmounts('$500M, $1.5 billion') === '$500000000, $1500000000');
  const e = { ...E1, mechanism: `${E1.mechanism} Large developers are those with revenue over $500M.` };
  ok('6 checkCorrection refuses a rewrite that loses a figure', checkCorrection({ c: { field: 'mechanism', kind: 'omission', problem: 'adds the 72-hour deadline', new_text: `${E1.mechanism} Critical safety incidents must be reported within 72 hours.`, evidence: [{ quote: ADD }] }, entry: e, fields: fieldsFor(e), source: TEXT(e) + ' revenue over $500M.' }).some((x) => /drops figures/.test(x)));
}

console.log(`\ncorrect: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
