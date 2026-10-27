// Tests for the run report and the Telegram message. No network, no AI.
//   node report/test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normaliseStats, sourceEntry, aiEntry, publishEntry, newReport, finalize, writeReport } from './build.mjs';
import { formatReport, formatFailed, formatNoChange, formatChanged, when, took } from './format.mjs';
import { chunk } from '../notify/telegram.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rep-'));
const put = (dir, f, o) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, f), JSON.stringify(o)); };

function runDir(source, { stats, diff, grab = {} }) {
  const d = path.join(tmp(), 'run-20261027-1200-aaaa');
  put(d, 'grab-stats.json', { source, run_id: 'run-20261027-1200-aaaa', items: diff.items.length, stats, requests: 3, truncated: false, ...grab });
  put(d, 'diff.json', { run_id: 'run-20261027-1200-aaaa', summary: diff.summary, items: diff.items });
  return d;
}

// ---- normalising each source's own counts ----
ok('Congress.gov counts', JSON.stringify(normaliseStats('congress_gov', { listed: 2701, tracked_changed: 3, candidates: 12, screened_out: 2600, unchanged: 10 })) === JSON.stringify({ listed: 2701, tracked_checked: null, tracked_changed: 3, candidates: 12, screened_out: 2600, unchanged: 10, waiting: 0, errors: 0 }));
ok('LegiScan counts add the two searches and read the intent "no" as screened out', (() => { const c = normaliseStats('legiscan', { precise_hits: 141, wide_hits: 2717, tracked_changed: 1, tracked_unchanged: 32, intent_no: 1346, candidates: 25, waiting_for_next_run: 650 }); return c.listed === 2858 && c.tracked_checked === 33 && c.screened_out === 1346 && c.waiting === 650; })());
ok('Federal Register counts', normaliseStats('federal_register', { found: 5, tracked: 1, unchanged: 1, candidates: 1, screened_out: 3 }).tracked_changed === 0);
ok('missing numbers read as zero, never NaN', normaliseStats('congress_gov', {}).listed === 0 && normaliseStats('legiscan', undefined).listed === 0);

// ---- a quiet run ----
const quietDir = runDir('congress_gov', { stats: { listed: 2701, tracked_changed: 0, candidates: 0, screened_out: 2650, unchanged: 25 }, diff: { summary: { unchanged: 25 }, items: [] } });
const lsDir = runDir('legiscan', { stats: { precise_hits: 141, wide_hits: 2717, tracked_unchanged: 33, intent_no: 1346 }, diff: { summary: { unchanged: 33 }, items: [] }, grab: { requests: 14, month_used: 1037, month_cap: 15000 } });
const quiet = newReport({ id: 'update-20261027-1200', now: new Date('2026-10-27T12:00:00Z'), sources: ['congress_gov', 'legiscan'] });
quiet.sources.push(sourceEntry({ runDir: quietDir, source: 'congress_gov' }), sourceEntry({ runDir: lsDir, source: 'legiscan' }));
quiet.ai = { enabled: true, skipped_why: null, runs: [] }; quiet.publish.runs.push(publishEntry({ result: { applied: [], skipped: [], log: [] }, newsBefore: 48, newsAfter: 48, status: 'quiet' }));
finalize(quiet, { now: new Date('2026-10-27T12:01:42Z'), spend: { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0, by_step: {}, by_model: {} }, month: { spent: 0.42, cap: 25, warn: false, over: false } });
ok('a quiet run is not "changed"', quiet.changed === false && quiet.totals.entries_updated === 0 && quiet.duration_s === 102);
ok('totals add the sources', quiet.totals.requests === 17 && quiet.totals.listed === 2701 + 2858 && quiet.legiscan.month_used === 1037);
const qm = formatReport(quiet);
ok('the no-change message says so, with counts, queries and cost', qm.startsWith('✅ No changes') && /Congress\.gov: 2,701 listed/.test(qm) && /LegiScan \(states\): .*14 queries/.test(qm) && /no AI calls/.test(qm) && /AI this month: \$0\.42 of \$25\.00 \(2%\)/.test(qm) && /LegiScan this month: 1,037 of 15,000/.test(qm) && /took 1m 42s/.test(qm), qm);
ok('a quiet run message is short', qm.length < 1800, String(qm.length));

// ---- a run that changed the data ----
const diffDir = runDir('congress_gov', { stats: { listed: 2701, tracked_changed: 1, candidates: 2, screened_out: 2600, unchanged: 20 }, diff: { summary: { material: 1, minor: 2, unchanged: 20, new_entry_candidate: 2 }, items: [{ item_id: 'congress_gov:119/s/2938', verdict: 'material', entry_key: 's-2938-ai-risk-evaluation-act' }, { item_id: 'congress_gov:119/hr/1', verdict: 'new_entry_candidate', title: 'Frontier Test Act' }, { item_id: 'congress_gov:119/hr/2', verdict: 'new_entry_candidate', title: 'Another Act' }] } });
const ch = newReport({ id: 'update-20261027-1600', now: new Date('2026-10-27T16:00:00Z') });
ch.sources.push(sourceEntry({ runDir: diffDir, source: 'congress_gov' }));
ch.ai = { enabled: true, skipped_why: null, runs: [aiEntry({ results: { run_id: 'r', eligible_items: 3, deferred_items: 0, outcomes: { publishable: 1, out_of_scope: 1, held: 1 }, items: [{ item_id: 'congress_gov:119/hr/1', outcome: 'publishable' }, { item_id: 'congress_gov:119/hr/2', outcome: 'out_of_scope' }, { item_id: 'congress_gov:119/s/2938', outcome: 'held', reason: 'the generator and reader disagree on scope' }] } })] };
ch.publish.runs.push(publishEntry({ status: 'published', newsBefore: 48, newsAfter: 49, result: { applied: [{ entry_key: 's-2938-ai-risk-evaluation-act', status: null, actions: [{ date: '2026-10-27', text: 'Committee hearing held (Oct 27, 2026, Congress.gov)' }] }], skipped: [{ entry_key: 'x-y', why: 'sponsor change is not a Tier A fact' }], log: [{ entry_key: 's-2938-ai-risk-evaluation-act', field: 'status_text', old: 'Referred to committee. No action in 11+ months', new: 'Referred to committee; hearing held (Oct 27, 2026)', source_url: 'https://www.congress.gov/bill/119th-congress/senate-bill/2938' }] } }));
ch.names = { 's-2938-ai-risk-evaluation-act': 'S. 2938 AI Risk Evaluation Act' };
finalize(ch, { now: new Date('2026-10-27T16:03:00Z'), spend: { calls: 6, input_tokens: 41000, output_tokens: 5200, cost_usd: 0.0067, unpriced_calls: 0, by_step: { writer: { cost_usd: 0.0041 }, checker: { cost_usd: 0.0026 } }, by_model: {} }, month: { spent: 21.0, cap: 25, warn: true, over: false } });
ok('a changed run is "changed" and counts entries, news and fields', ch.changed === true && ch.totals.entries_updated === 1 && ch.totals.news_added === 1 && ch.totals.fields_changed === 1 && ch.totals.candidates === 2);
ok('AI counts: in scope = publishable + held, out of scope, held', ch.totals.ai_in_scope === 2 && ch.totals.ai_out_of_scope === 1 && ch.totals.held === 1);
ok('held items collect AI holds and publisher skips, each with its reason', ch.held.length === 2 && ch.held.some((h) => /disagree on scope/.test(h.reason)) && ch.held.some((h) => /sponsor change/.test(h.reason)));
const cm = formatReport(ch);
ok('the changed message leads with what changed', cm.startsWith('✅ Updated: 1 entry updated, 1 news item added'), cm.split('\n')[0]);
ok('it names the entry, the action and the field old → new', /S\. 2938 AI Risk Evaluation Act/.test(cm) && /Committee hearing held/.test(cm) && /status_text: Referred to committee\. No action in 11\+ months → Referred to committee; hearing held/.test(cm), cm);
ok('it lists the AI step, held items with reasons, cost and a spending warning', /AI step: 2 in scope, 1 out of scope, 1 held/.test(cm) && /Held \(2\)/.test(cm) && /disagree on scope/.test(cm) && /6 calls, 41,000 in \/ 5,200 out tokens, \$0\.0067 \(writer \$0\.0041, checker \$0\.0026\)/.test(cm) && /⚠️ AI spending passed the warning level/.test(cm) && /84%/.test(cm), cm);
ok('a changed message fits in Telegram messages', chunk(cm).every((c) => c.length <= 4000));

// ---- a failed run ----
const bad = newReport({ id: 'update-20261027-2000', now: new Date('2026-10-27T20:00:00Z') });
bad.sources.push(sourceEntry({ runDir: quietDir, source: 'congress_gov' }));
bad.outcome = 'failed'; bad.failed_step = 'publish'; bad.error = 'publish stopped for run-20261027-2000-ab12; nothing from it was written';
finalize(bad, { now: new Date('2026-10-27T20:00:30Z'), spend: null, month: { spent: 3, cap: 25, warn: false, over: false } });
const fm = formatReport(bad);
ok('the failed message says where, why, and that nothing was written', fm.startsWith('❌ FAILED at publish: publish stopped for') && /Nothing was written/.test(fm) && /Done before it stopped/.test(fm), fm);
const dry = newReport({ id: 'update-d', now: new Date('2026-10-27T20:00:00Z'), dry: true }); dry.outcome = 'failed'; dry.failed_step = 'grab'; dry.error = 'HTTP 500'; finalize(dry, { now: new Date('2026-10-27T20:00:05Z') });
ok('a dry run is labelled', /dry run, nothing written/.test(formatReport(dry)) && /writes nothing/.test(formatReport(dry)));
ok('a month over the cap says AI is paused', /AI work is paused/.test(formatNoChange(finalize(newReport({ id: 'u', now: new Date('2026-10-27T10:00:00Z') }), { now: new Date('2026-10-27T10:00:09Z'), month: { spent: 25.2, cap: 25, warn: true, over: true } }))));
ok('an AI step skipped for a reason says why', /AI step skipped: dry run/.test(formatNoChange((() => { const r = newReport({ id: 'u', now: new Date('2026-10-27T10:00:00Z') }); r.ai.skipped_why = 'dry run'; return finalize(r, { now: new Date('2026-10-27T10:00:09Z') }); })())));

// ---- robustness ----
{
  const r = newReport({ id: 'u', now: new Date('2026-10-27T10:00:00Z') }); r.outcome = 'failed'; r.failed_step = 'grab'; r.error = 'x'.repeat(5000); finalize(r, { now: new Date('2026-10-27T10:00:01Z') });
  ok('a huge error text is cut, not sent whole', formatFailed(r).length < 1200 && /…/.test(formatFailed(r)));
  const many = newReport({ id: 'u', now: new Date('2026-10-27T10:00:00Z') }); many.sources.push(sourceEntry({ runDir: quietDir, source: 'congress_gov' }));
  many.publish.runs.push(publishEntry({ status: 'published', result: { applied: Array.from({ length: 15 }, (_, i) => ({ entry_key: 'k' + i, status: 'pending', actions: [{ date: '2026-10-27', text: 'Action text '.repeat(30) }, { date: '2026-10-26', text: 'b' }, { date: '2026-10-25', text: 'c' }, { date: '2026-10-24', text: 'd' }] })), skipped: [], log: [] }, newsBefore: 0, newsAfter: 15 }));
  finalize(many, { now: new Date('2026-10-27T10:00:09Z') });
  const mt = formatChanged(many);
  ok('even 15 changed entries produce text that Telegram can take in a few messages', chunk(mt).length <= 3 && chunk(mt).every((c) => c.length <= 4000), String(mt.length));
  ok('titles with markup characters pass through as plain text', formatChanged({ ...many, publish: many.publish }, { k0: '<b>*bold*_x_ [y](z)' }).includes('<b>*bold*_x_ [y](z)'));
  ok('when() and took() format as expected', when('2026-10-27T12:07:00Z') === '27 Oct 2026, 12:07 UTC' && took(102) === '1m 42s' && took(9) === '9s');
}

// ---- the file ----
{
  const dir = tmp(), f = writeReport(ch, path.join(dir, 'update-20261027-1600'));
  const back = JSON.parse(fs.readFileSync(f, 'utf8'));
  ok('the report is written as run-report.json and reads back whole', path.basename(f) === 'run-report.json' && back.id === ch.id && back.totals.entries_updated === 1 && back.month.spent === 21 && Array.isArray(back.held));
  ok('no key or token appears anywhere in the report', !/sk-ant|AIza|bot\d+:/.test(JSON.stringify(back)));
}

console.log(`report: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
