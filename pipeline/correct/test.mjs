// Run:  node correct/test.mjs
// The self-correction step with scripted models (no AI, no network) on a copy of the real site data: a confirmed fix is applied
// and logged, and every way a fix can be wrong (invented quote or number, a field it may not touch, the confirmer saying no, a stop
// rule) leaves the data as it was and marks the entry for a retry.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { correctRun } from './run.mjs';
import { operativeBillId } from './texts.mjs';
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

// ---------- 7. multi-bill entries, small figures, legal force, the confirmer's quote ----------
{
  const { droppedFacts, multiBillEntry, unquotedChanges } = await import('./review.mjs');
  const errFix = { field: 'mechanism', kind: 'error', problem: 'The deadline is wrong.', new_text: `${E1.mechanism} Critical safety incidents must be reported within 72 hours.`, evidence: [{ quote: ADD }] };
  const two = { ...E1, identifiers: { external: { congress_gov: ['119/hr/1', '119/s/2'] } } };
  ok('7 multi-bill: more than one Congress.gov or LegiScan id, otherBills, or the reader\'s list', multiBillEntry(two) && multiBillEntry({ identifiers: { external: { legiscan: [1, 2] } } }) && multiBillEntry({ otherBills: ['S. 2'] }) && multiBillEntry({}, ['S. 2']) && !multiBillEntry({ identifiers: { external: { congress_gov: ['119/hr/1'] } } }) && !multiBillEntry(E1));
  ok('7 multi-bill: an error correction is refused with a reason', checkCorrection({ c: errFix, entry: two, fields: fieldsFor(two), source: TEXT(two), multiBill: true }).some((x) => /more than one bill.*only an omission/.test(x)));
  ok('7 multi-bill: an omission still passes', checkCorrection({ c: goodFix(two).corrections[0], entry: two, fields: fieldsFor(two), source: TEXT(two), multiBill: true }).length === 0);
  const mb = sandbox(), mrev = scripted(() => ({ corrections: [errFix] })), mcon = scripted(yes);
  const mr = await run(mb, { factory: factoryOf(mrev, mcon), texts: fakeTexts({ [E1.key]: TEXT(E1) }), ic: { [E1.key]: { congress_gov: ['119/hr/1', '119/s/2'] } }, only: [E1.key] });
  ok('7 multi-bill through the step: refused, never confirmed, nothing written', mr.corrected.length === 0 && mcon.calls.length === 0 && JSON.stringify(readEntry(mb.dataDir, E1.key)) === JSON.stringify(E1), JSON.stringify(mr.rejected));
  ok('7 multi-bill: the reader is told only omissions are allowed', /only "omission" corrections are allowed/.test(mrev.calls[0].prompt));

  const om = (old, v, problem = '') => droppedFacts({ c: { kind: 'omission', problem }, old, v });
  ok('7 a single-digit figure with its unit is kept ("within 3 years" removed is caught)', om('report within 3 years of enactment', 'report after enactment').some((x) => /3 year/.test(x)));
  ok('7 ... days, hours, people, percent too', ['5 days', '2 hours', '4 people', '7%', '9 percent'].every((f) => om(`within ${f} of notice`, 'after notice').length === 1));
  ok('7 ... kept in another notation is not flagged ("3-year", "three years", "15 percent")', om('within 3 years', 'a 3-year deadline').length === 0 && om('within 3 years', 'within three years').length === 0 && om('15% of revenue', '15 percent of revenue').length === 0);
  ok('7 ... the expanded-amount equivalence still holds', om('fines of $5M', 'fines of $5,000,000').length === 0);
  ok('7 ... an error fix may drop one its problem names', droppedFacts({ c: { kind: 'error', problem: 'The deadline is 5 days, not 3 years.' }, old: 'within 3 years', v: 'within 5 days' }).length === 0);
  ok('7 ... a bare single digit with no unit is not compared', om('Tier 2 developers', 'covered developers').length === 0);

  const uq = (old, v, quotes, kind = 'omission', problem = '') => unquotedChanges({ c: { kind, problem }, old, v, quotes });
  ok('7 "shall" changed to "may" with no quote containing "may" is refused', uq('The developer shall publish a framework.', 'The developer may publish a framework.', ['The developer shall publish'], 'error', 'It is a power, the developer shall not be required.').some((x) => /power wording/.test(x)));
  ok('7 ... with a quote containing it, and the dropped word named, it passes', uq('The developer shall publish a framework.', 'The developer may publish a framework.', ['The developer may publish a framework'], 'error', 'shall is wrong: SOURCE gives a power').length === 0);
  ok('7 an omission may not drop a legal-force word', uq('Developers must report incidents; audits are voluntary.', 'Developers report incidents; audits are voluntary; whistleblowers are protected.', ['whistleblowers are protected']).some((x) => /drops the legal-force word "must"/.test(x)));
  ok('7 the month "May" is not a power', uq('Effective Jan 1, 2027.', 'Effective May 1, 2027.', ['takes effect May 1, 2027'], 'error', 'wrong month').length === 0);
  ok('7 a figure already in the old text used again for another step needs a quote', uq('Report within 72 hours.', 'Report within 72 hours; audit within 72 hours.', ['an annual audit']).some((x) => /uses again.*72/.test(x)));
  ok('7 ... so does a small figure with its unit', uq('Report within 3 days.', 'Report within 3 days; publish within 3 days.', ['publish the report']).some((x) => /3 day/.test(x)));
  ok('7 ... and a new figure the quotes do not contain', uq('Report incidents.', 'Report incidents within 15 days.', ['report each incident']).some((x) => /15/.test(x)) && uq('Report incidents.', 'Report incidents within 15 days.', ['report each incident within 15 days']).length === 0);

  const nq = sandbox(), nqr = await run(nq, { factory: factoryOf(scripted(() => goodFix(E1)), scripted(() => ({ confirmed: true, quote: null, reason: 'looks right' }))), texts: fakeTexts({ [E1.key]: TEXT(E1) }), only: [E1.key] });
  ok('7 a confirmation with no quote is not a confirmation', nqr.corrected.length === 0 && /confirmer gave no quote/.test(nqr.rejected[0].why) && JSON.stringify(readEntry(nq.dataDir, E1.key)) === JSON.stringify(E1));
  const eq = sandbox(), eqr = await run(eq, { factory: factoryOf(scripted(() => goodFix(E1)), scripted(() => ({ confirmed: true, quote: '   ', reason: 'x' }))), texts: fakeTexts({ [E1.key]: TEXT(E1) }), only: [E1.key] });
  ok('7 ... nor one with a blank quote', eqr.corrected.length === 0 && /no quote/.test(eqr.rejected[0].why));
}

// ---------- 8. nothing qualitative is lost: an omission only adds; an error changes only what its problem names ----------
{
  const { droppedWords, multiBillEntry } = await import('./review.mjs');
  const om = (old, v) => droppedWords({ c: { kind: 'omission', problem: 'x' }, old, v });
  const er = (old, v, problem) => droppedWords({ c: { kind: 'error', problem }, old, v });
  const ca = 'Developers must publish a framework; applies only to developers in California; AG enforces.';
  ok('8 an omission that drops a qualitative clause is refused, naming the first dropped words', om(ca, 'Developers must publish a framework; AG enforces; incidents within 72 hours.').some((x) => /may only add/.test(x) && /"applies only to developers in california"/.test(x)));
  ok('8 ... additions anywhere, case, punctuation and spacing are fine', om(ca, 'Large developers MUST publish a framework within 90 days -- applies only to developers in California (§2); the AG enforces, with civil penalties.').length === 0);
  ok('8 ... the old figures in another notation are kept ($500M = $500,000,000, 10²⁶ = 10^26, three = 3)', om('>$500M revenue; 10²⁶ ops; within three years', '>$500,000,000 revenue; 10^26 ops; within 3 years').length === 0);
  ok('8 ... a reworded word is a drop ("runs" -> "must establish")', om('DOE runs a program', 'DOE must establish a program within 90 days').some((x) => /starting "runs"/.test(x)));
  ok('8 ... reordering is a drop', om('audits and reports', 'reports and audits').length === 1);
  ok('8 an error fix may change the part its problem names', er('report within 30 days to the AG', 'report within 15 days to the AG', 'The deadline is 15 days, not 30 days.').length === 0);
  ok('8 ... but not drop a clause its problem does not name', er(ca, 'Developers must publish a framework by Jan 1, 2027; AG enforces.', 'The framework deadline is missing and wrong.').some((x) => /problem does not name/.test(x) && /california/.test(x)));
  ok('8 ... "not" and "only" are never function words', er('applies only to large developers', 'applies to large developers', 'wrong scope').length === 1 && er('does not apply to universities', 'does apply to universities', 'wrong').length === 1);
  ok('8 ... small function words around the named part may go', er('safe harbor for the labs', 'exemption for labs', 'It is an exemption, not a safe harbor.').length === 0);
  const e = { ...E1, mechanism: `${E1.mechanism} Applies only to developers in California.` }, src = TEXT(e);
  ok('8 checkCorrection runs it', checkCorrection({ c: { field: 'mechanism', kind: 'omission', problem: 'adds the 72-hour deadline', new_text: `${E1.mechanism} Critical safety incidents must be reported within 72 hours.`, evidence: [{ quote: ADD }] }, entry: e, fields: fieldsFor(e), source: src }).some((x) => /may only add.*applies only to developers in california/.test(x)));
  // the past week's hand fixes that the rule refuses as omissions (each removed or reworded something, so each is an error fix)
  ok('8 history: removing "and the designated federal standard need not require audits" is not an omission', om('it covers incident reporting only (§1422(8)–(9)), and the designated federal standard need not require audits.', 'it covers incident reporting only (§1422(8)–(9)).').length === 1);
  ok('8 history: dropping "independent reviews; whistleblower protections" is refused even as an error about something else', er('incident reporting 15 days; independent reviews; whistleblower protections; AG enforcement', 'incident reporting 15 days; plans must describe third-party assessments; AG enforcement', 'The plan content is missing.').length === 1);

  const mrev = scripted(() => ({ corrections: [] }));
  ok('8 multi-bill from the identifier files: two Congress.gov ids or two LegiScan bills', multiBillEntry(E1, [], { congress_gov: ['119/hr/1', '119/s/2'] }) && multiBillEntry(E1, [], { legiscan: [1, 2] }) && !multiBillEntry(E1, [], { congress_gov: ['119/hr/1'], legiscan: [1] }) && !multiBillEntry(E1, [], { legiscan: [1, 1] }));
  const sb = sandbox();
  await run(sb, { factory: factoryOf(mrev, scripted(yes)), texts: fakeTexts({ [E1.key]: TEXT(E1) }), il: { [E1.key]: { bills: [{ bill_id: 1, state: 'CA', number: 'SB1' }, { bill_id: 2, state: 'CA', number: 'AB2' }] } }, only: [E1.key] });
  ok('8 ... passed in by the step: two LegiScan bills make the reader see the multi-bill note', /only "omission" corrections are allowed/.test(mrev.calls[0].prompt) && /keep the current text intact and only add/.test(mrev.calls[0].prompt));
  const rrev = scripted(() => ({ corrections: [] }));
  await run(sandbox(), { factory: factoryOf(rrev, scripted(yes)), texts: fakeTexts({ [E1.key]: TEXT(E1) }), il: { [E1.key]: { status: 'rejected', bills: [{ bill_id: 1 }] } }, only: [E1.key] });
  ok('8 ... a single bill is not multi-bill; the reviewer prompt says omissions keep the old text', !/NOTE: this entry covers more than one bill/.test(rrev.calls[0].prompt) && /An "omission" only ADDS/.test(rrev.calls[0].system));
}

// ---------- E2: no starvation ----------
{
  // A backlog cleared in one day (41 entries, as on 28 Oct) all falls due on one day. Simulate 120 days of daily runs at 3 a run: every
  // entry must be re-checked within recheck_after_days, never sooner than half of it, and no run may go unused while entries are due.
  const e = (key) => ({ key, section: 'D', mechanism: 'm', thresholds: 't' });
  const keys = Array.from({ length: 41 }, (_, i) => 'k' + String(i).padStart(2, '0'));
  const cands = keys.map((k) => ({ key: k, entry: e(k), sha: 's' }));
  const st = Object.fromEntries(keys.map((k) => [k, { text_sha: 's', checked_at: '2026-10-28' }]));
  const day = (n) => new Date(Date.parse('2026-10-28') + n * 86400e3).toISOString().slice(0, 10);
  const gaps = [];
  for (let n = 1; n <= 120; n++) {
    for (const p of pickEntries({ candidates: cands, state: st, today: day(n), max: 3, recheckDays: 30 }).picked) {
      gaps.push(Math.round((Date.parse(day(n)) - Date.parse(st[p.key].checked_at)) / 86400e3));
      st[p.key] = { ...st[p.key], checked_at: day(n) };
    }
  }
  ok('E2 a same-day backlog is re-checked within 30 days, never sooner than 15', gaps.length >= 41 * 3 && Math.max(...gaps) <= 30 && Math.min(...gaps) >= 15, `${gaps.length} checks, gaps ${Math.min(...gaps)}-${Math.max(...gaps)}`);
  // A run stopped by the run budget before it checked its entries does not use up the day.
  const { BudgetExceeded } = await import('../llm/gemini.mjs');
  const sb = sandbox(), broke = scripted(() => new BudgetExceeded('600000 tokens per run'));
  const r = await run(sb, { factory: factoryOf(broke, scripted(yes)), texts: fakeTexts({ [E1.key]: TEXT(E1), [E2.key]: TEXT(E2) }) });
  const s = fs.existsSync(sb.stateFile) ? state(sb) : { last_run: null, items: {} };
  ok('E2 a run stopped by the budget leaves the day open, so the next run checks the entries', /stopped/.test(r.problems.join()) && s.last_run == null && !s.items[E1.key]);
  const again = await run(sb, { factory: factoryOf(scripted(() => ({ corrections: [] })), scripted(yes)), texts: fakeTexts({ [E1.key]: TEXT(E1), [E2.key]: TEXT(E2) }) });
  ok('E2 ... and the next run that day does check them', !again.skipped_why && again.checked.length === 2 && state(sb).last_run === '2026-10-28');
}

// ---------- D3: the bill in force is read from LegiScan's records, not a hand-kept list ----------
{
  // Shapes as LegiScan returns them (status 4 = Passed; sasts "Replaced by"; texts with dates), modelled on the NY RAISE and MA cases.
  const B = (id, status, status_date, textDates, sasts = []) => ({ bill_id: id, status, status_date, texts: textDates.map((date) => ({ date })), sasts });
  const get = (db) => async (id) => db[id] || null;
  const ny = { 1: B(1, 4, '2025-12-19', ['2025-03-27']), 2: B(2, 1, '2025-03-05', ['2025-03-05'], [{ type: 'Replaced by', sast_bill_id: 1 }]), 3: B(3, 4, '2026-03-27', ['2026-01-08']), 4: B(4, 1, '2026-01-06', ['2026-01-06'], [{ type: 'Replaced by', sast_bill_id: 3 }]) };
  ok('D3 of several enacted bills, the one enacted last is in force (a chapter amendment after the law)', (await operativeBillId([1, 2, 3, 4], get(ny))) === 3);
  const ma = { 10: B(10, 2, '2026-07-08', ['2026-07-08'], [{ type: 'Replaces', sast_bill_id: 9 }, { type: 'Replaced by', sast_bill_id: 30 }]), 20: B(20, 1, '2026-07-16', ['2026-07-16']), 30: B(30, 1, '2026-07-24', ['2026-07-24'], [{ type: 'Replaced by', sast_bill_id: 10 }]) };
  ok('D3 none enacted: the first bill is followed to the bill that replaced it with a newer text (not back again)', (await operativeBillId([10, 20], get(ma))) === 30);
  // The real MA records (30 Oct): H5576 <-> S3228 linked both ways, S3178 unlinked, S37 -> S2630 an older lineage. Any mapped order reads S3228.
  const ma4 = { 10: B(10, 2, '2026-07-08', ['2026-07-08'], [{ type: 'Replaces', sast_bill_id: 9 }, { type: 'Replaced by', sast_bill_id: 30 }]), 20: B(20, 1, '2026-07-16', ['2026-07-16']),
    30: B(30, 1, '2026-07-24', ['2026-07-24'], [{ type: 'Replaced by', sast_bill_id: 10 }]), 37: B(37, 1, '2025-02-27', ['2025-02-27'], [{ type: 'Replaced by', sast_bill_id: 38 }]), 38: B(38, 1, '2025-10-16', ['2025-10-16'], [{ type: 'Replaces', sast_bill_id: 37 }]) };
  const orders = [[10, 20, 37, 38], [20, 10, 37, 38], [37, 38, 10, 20], [38, 37, 20, 10]];
  ok('D3 MA: the newest text in the lineage (S3228) whatever order the bills were mapped in', (await Promise.all(orders.map((o) => operativeBillId(o, get(ma4))))).every((x) => x === 30));
  const conf = { ...ma4, 30: B(30, 1, '2026-07-24', ['2026-07-24'], [{ type: 'Replaced by', sast_bill_id: 10 }, { type: 'Replaced by', sast_bill_id: 60 }]), 60: B(60, 1, '2026-11-02', ['2026-11-02'], [{ type: 'Replaces', sast_bill_id: 30 }]) };
  ok('D3 MA: a later conference report replacing S3228 is read in its place', (await operativeBillId([10, 20, 37, 38], get(conf))) === 60);
  const plain = { 40: B(40, 1, '2026-01-01', ['2026-01-01']), 41: B(41, 1, '2026-02-01', ['2026-02-01']) };
  ok('D3 no enactment and no replacement: the first mapped bill, as before', (await operativeBillId([40, 41], get(plain))) === 40);
  const older = { 50: B(50, 1, '2026-05-01', ['2026-05-01'], [{ type: 'Replaced by', sast_bill_id: 51 }]), 51: B(51, 1, '2026-01-01', ['2026-01-01']) };
  ok('D3 a "Replaced by" link to an older text is not followed', (await operativeBillId([50], get(older))) === 50);
}

console.log(`\ncorrect: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
