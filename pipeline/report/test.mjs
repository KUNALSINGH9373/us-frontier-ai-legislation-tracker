// Tests for the run report and the Telegram message. No network, no AI.
//   node report/test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normaliseStats, sourceEntry, aiEntry, publishEntry, newReport, finalize, writeReport } from './build.mjs';
import { formatReport, formatFailed, formatDone, when, took } from './format.mjs';
import { formatHtml } from './html.mjs';
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
const SPEND0 = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0, by_step: {}, by_model: {} };

// ---- normalising each source's own counts ----
ok('Congress.gov counts', JSON.stringify(normaliseStats('congress_gov', { listed: 2701, tracked_changed: 3, candidates: 12, screened_out: 2600, unchanged: 10 })) === JSON.stringify({ listed: 2701, tracked_checked: null, tracked_changed: 3, candidates: 12, screened_out: 2600, unchanged: 10, waiting: 0, errors: 0 }));
ok('LegiScan counts add the two searches and read the intent "no" as screened out', (() => { const c = normaliseStats('legiscan', { precise_hits: 141, wide_hits: 2717, tracked_changed: 1, tracked_unchanged: 32, intent_no: 1346, candidates: 25, waiting_for_next_run: 650 }); return c.listed === 2858 && c.tracked_checked === 33 && c.screened_out === 1346 && c.waiting === 650; })());
ok('Federal Register counts', normaliseStats('federal_register', { found: 5, tracked: 1, unchanged: 1, candidates: 1, screened_out: 3 }).tracked_changed === 0);
ok('missing numbers read as zero, never NaN', normaliseStats('congress_gov', {}).listed === 0 && normaliseStats('legiscan', undefined).listed === 0);

// ---- a quiet run ----
const quietDir = runDir('congress_gov', { stats: { listed: 2701, tracked_changed: 0, candidates: 0, screened_out: 2650, unchanged: 25 }, diff: { summary: { unchanged: 25 }, items: [] }, grab: { requests: 4 } });
const lsDir = runDir('legiscan', { stats: { precise_hits: 141, wide_hits: 2717, tracked_unchanged: 33, intent_no: 1346 }, diff: { summary: { unchanged: 33 }, items: [] }, grab: { requests: 14, month_used: 1037, month_cap: 15000 } });
const quiet = newReport({ id: 'update-20261027-1200', now: new Date('2026-10-27T12:00:00Z'), sources: ['congress_gov', 'legiscan'] });
quiet.sources.push(sourceEntry({ runDir: quietDir, source: 'congress_gov' }), sourceEntry({ runDir: lsDir, source: 'legiscan' }));
quiet.ai = { enabled: true, skipped_why: null, runs: [] }; quiet.publish.runs.push(publishEntry({ result: { applied: [], skipped: [], log: [] }, newsBefore: 48, newsAfter: 48, status: 'quiet' }));
finalize(quiet, { now: new Date('2026-10-27T12:01:42Z'), spend: SPEND0, month: { spent: 0.42, cap: 25, warn: false, over: false } });
ok('a quiet run is not "changed"', quiet.changed === false && quiet.totals.entries_updated === 0 && quiet.duration_s === 102);
ok('totals add the sources', quiet.totals.requests === 18 && quiet.totals.listed === 2701 + 2858 && quiet.legiscan.month_used === 1037);
const qm = formatReport(quiet);
ok('the quiet message shows bills updated, AI cost and free queries, in plain words', /^✅ Update done, no changes · 27 Oct, 12:01 UTC · 1m 42s/.test(qm) && /Bills updated: 0/.test(qm) && /AI cost: \$0\.00 this run · \$0\.42 of \$25\.00 this month/.test(qm) && /Free API queries used: 18 \(Congress\.gov 4, LegiScan 14\)/.test(qm), qm);
ok('a healthy quiet message is short, with only one monitoring line (LegiScan usage)', qm.split('\n').length <= 8 && /LegiScan this month: 1,037 of 15,000 queries/.test(qm) && !/⚠️/.test(qm), qm);
ok('no jargon: no run ids, tiers or verdict names', !/run-2026|Tier|verdict|material|candidate/i.test(qm));

// ---- a run that changed the data ----
const diffDir = runDir('congress_gov', { stats: { listed: 2701, tracked_changed: 1, candidates: 2, screened_out: 2600, unchanged: 20 }, diff: { summary: { material: 1, minor: 2, unchanged: 20, new_entry_candidate: 2 }, items: [{ item_id: 'congress_gov:119/s/2938', verdict: 'material', entry_key: 's-2938-ai-risk-evaluation-act' }, { item_id: 'congress_gov:119/hr/1', verdict: 'new_entry_candidate', title: 'Frontier Test Act' }, { item_id: 'congress_gov:119/hr/2', verdict: 'new_entry_candidate', title: 'Another Act' }] }, grab: { requests: 4 } });
const ch = newReport({ id: 'update-20261027-1600', now: new Date('2026-10-27T16:00:00Z') });
ch.sources.push(sourceEntry({ runDir: diffDir, source: 'congress_gov' }));
ch.ai = { enabled: true, skipped_why: null, runs: [aiEntry({ results: { run_id: 'r', eligible_items: 3, deferred_items: 0, outcomes: { publishable: 1, out_of_scope: 1, held: 1 }, items: [{ item_id: 'congress_gov:119/hr/1', outcome: 'publishable' }, { item_id: 'congress_gov:119/hr/2', outcome: 'out_of_scope' }, { item_id: 'congress_gov:119/hr/1x', outcome: 'held', reason: 'the bill text is not published yet' }] } })] };
ch.publish.runs.push(publishEntry({ status: 'published', newsBefore: 48, newsAfter: 49, result: { applied: [{ entry_key: 's-2938-ai-risk-evaluation-act', status: null, actions: [{ date: '2026-10-27', text: 'Committee hearing held' }] }], skipped: [], log: [{ entry_key: 's-2938-ai-risk-evaluation-act', field: 'status_text', old: 'a', new: 'b', source_url: 'https://www.congress.gov/x' }] } }));
ch.names = { 's-2938-ai-risk-evaluation-act': 'S. 2938 AI Risk Evaluation Act' };
finalize(ch, { now: new Date('2026-10-27T16:03:00Z'), spend: { calls: 6, input_tokens: 41000, output_tokens: 5200, cost_usd: 0.0067, unpriced_calls: 0, by_step: {}, by_model: {} }, month: { spent: 21.0, cap: 25, warn: true, over: false } });
ok('a changed run counts entries, news and fields', ch.changed === true && ch.totals.entries_updated === 1 && ch.totals.news_added === 1 && ch.totals.fields_changed === 1 && ch.totals.candidates === 2);
ok('held items collect AI holds with a reason', ch.held.length === 1 && /not published yet/.test(ch.held[0].reason));
const cm = formatReport(ch);
ok('the changed message leads with the update and names the bill', /^✅ Update done · 27 Oct, 16:03 UTC · 3m 0s/.test(cm) && /Bills updated: 1 \(S\. 2938 AI Risk Evaluation Act\)/.test(cm), cm);
ok('it says how many new bills were spotted, by name, and that they are not published yet', /New bills spotted: 2 \(Frontier Test Act, Another Act\) — not published yet/.test(cm), cm);
ok('it shows AI cost (run and month) and free queries', /AI cost: \$0\.0067 this run · \$21\.00 of \$25\.00 this month/.test(cm) && /Free API queries used: 4 \(Congress\.gov 4\)/.test(cm), cm);
ok('it warns about spending at 84% and about the held item', /⚠️ AI spending is at 84% of the monthly limit/.test(cm) && /⚠️ 1 item on hold: .*the bill text is not published yet/.test(cm), cm);
ok('a changed message is still short', cm.length < 900 && chunk(cm).length === 1, String(cm.length));

// ---- a failed run: the exact error ----
const bad = newReport({ id: 'update-20261027-2000', now: new Date('2026-10-27T20:00:00Z') });
bad.sources.push(sourceEntry({ runDir: quietDir, source: 'congress_gov' }));
bad.outcome = 'failed'; bad.failed_step = 'publish'; bad.error = 'publish stopped for run-20261027-2000-ab12; nothing from it was written';
finalize(bad, { now: new Date('2026-10-27T20:00:30Z'), spend: null, month: { spent: 3, cap: 25, warn: false, over: false } });
const fm = formatReport(bad);
ok('the failed message names the step, gives the exact error, and says nothing was changed', fm.startsWith('❌ Update FAILED at publish · 27 Oct, 20:00 UTC') && fm.includes('Error: publish stopped for run-20261027-2000-ab12; nothing from it was written') && /Nothing was changed\. The next run starts from the same point\./.test(fm), fm);
ok('it still shows AI cost and queries used so far', /AI cost: \$0\.00 this run/.test(fm) && /Free API queries used: 4/.test(fm), fm);
{
  const real = 'the grabber stopped (exit 2): CONGRESS_API_KEY is not set (looked for a .env file upward from pipeline/; found: E:\\uslegislation\\.env)';
  const r = newReport({ id: 'u', now: new Date('2026-10-27T10:00:00Z') }); r.outcome = 'failed'; r.failed_step = 'grab'; r.error = real; finalize(r, { now: new Date('2026-10-27T10:00:01Z') });
  ok('a real error text is passed through exactly, not paraphrased', formatFailed(r).includes('Error: ' + real));
  const long = newReport({ id: 'u', now: new Date('2026-10-27T10:00:00Z') }); long.outcome = 'failed'; long.failed_step = 'grab'; long.error = 'x'.repeat(5000); finalize(long, { now: new Date('2026-10-27T10:00:01Z') });
  ok('only an absurdly long error is cut, and it still fits in one message', formatFailed(long).length < 1700 && /…/.test(formatFailed(long)) && chunk(formatFailed(long)).length === 1);
}
const dry = newReport({ id: 'update-d', now: new Date('2026-10-27T20:00:00Z'), dry: true }); dry.outcome = 'failed'; dry.failed_step = 'grab'; dry.error = 'HTTP 500'; finalize(dry, { now: new Date('2026-10-27T20:00:05Z') });
ok('a dry run is labelled and says it saves nothing', /dry run, nothing saved/.test(formatReport(dry)) && /A dry run saves nothing/.test(formatReport(dry)));

// ---- things worth watching ----
{
  const base = () => { const r = newReport({ id: 'u', now: new Date('2026-10-27T10:00:00Z') }); r.sources.push(sourceEntry({ runDir: quietDir, source: 'congress_gov' })); return r; };
  const over = finalize(base(), { now: new Date('2026-10-27T10:00:09Z'), month: { spent: 25.2, cap: 25, warn: true, over: true } });
  ok('a month over the AI limit says AI is paused', /⚠️ The monthly AI limit is reached: AI work is paused until next month\./.test(formatReport(over)));
  const skipped = base(); skipped.ai.skipped_why = 'ANTHROPIC_API_KEY is not set';
  ok('an AI step that did not run for a real reason is flagged', /⚠️ The AI step did not run: ANTHROPIC_API_KEY is not set\./.test(formatReport(finalize(skipped, { now: new Date('2026-10-27T10:00:09Z') }))));
  const off = base(); off.ai.skipped_why = 'turned off with --no-ai';
  ok('an AI step turned off on purpose is not a warning', !/⚠️/.test(formatReport(finalize(off, { now: new Date('2026-10-27T10:00:09Z') }))));
  const trunc = base(); trunc.sources[0].truncated = true;
  ok('a source that stopped early is flagged', /⚠️ Congress\.gov stopped early and will carry on next run\./.test(formatReport(finalize(trunc, { now: new Date('2026-10-27T10:00:09Z') }))));
  const hot = base(); hot.sources.push(sourceEntry({ runDir: runDir('legiscan', { stats: {}, diff: { summary: {}, items: [] }, grab: { requests: 14, month_used: 12500, month_cap: 15000 } }), source: 'legiscan' }));
  ok('LegiScan nearing its monthly limit is a warning', /⚠️ LegiScan queries are at 83% of this month's limit \(12,500 of 15,000\)/.test(formatReport(finalize(hot, { now: new Date('2026-10-27T10:00:09Z') }))));
  const note = base(); note.notes.push('2 AI-drafted entries are ready but not published');
  ok('a note from the run is shown as information', /ℹ️ 2 AI-drafted entries are ready but not published/.test(formatReport(finalize(note, { now: new Date('2026-10-27T10:00:09Z') }))));
}

// ---- robustness ----
{
  const many = newReport({ id: 'u', now: new Date('2026-10-27T10:00:00Z') }); many.sources.push(sourceEntry({ runDir: quietDir, source: 'congress_gov' }));
  many.publish.runs.push(publishEntry({ status: 'published', result: { applied: Array.from({ length: 15 }, (_, i) => ({ entry_key: 'k' + i, status: 'pending', actions: [{ date: '2026-10-27', text: 'x' }] })), skipped: [], log: [] }, newsBefore: 0, newsAfter: 15 }));
  finalize(many, { now: new Date('2026-10-27T10:00:09Z') });
  const mt = formatDone(many);
  ok('even 15 updated bills fit in one short message (first four named, the rest counted)', /Bills updated: 15 \(k0, k1, k2, k3 and 11 more\)/.test(mt) && mt.length < 700, mt);
  ok('titles with markup characters pass through as plain text', formatDone(many, { k0: '<b>*bold*_x_ [y](z)' }).includes('<b>*bold*_x_ [y](z)'));
  ok('when() and took() format as expected', when('2026-10-27T12:07:00Z') === '27 Oct, 12:07 UTC' && took(102) === '1m 42s' && took(9) === '9s');
}

// ---- the file ----
{
  const dir = tmp(), f = writeReport(ch, path.join(dir, 'update-20261027-1600'));
  const back = JSON.parse(fs.readFileSync(f, 'utf8'));
  ok('the report is written as run-report.json and reads back whole', path.basename(f) === 'run-report.json' && back.id === ch.id && back.totals.entries_updated === 1 && back.month.spent === 21 && Array.isArray(back.held));
  ok('no key or token appears anywhere in the report', !/sk-ant|AIza|bot\d+:/.test(JSON.stringify(back)));
}

// ---- the phone message (Telegram HTML) ----
{
  const hc = formatHtml(ch), hq = formatHtml(quiet), hf = formatHtml(bad);
  const TAGS = /<\/?(b|i|pre)>/g;
  ok('the changed message is yellow (spend at 84%, one item on hold), not silent, and names the bill', hc.text.startsWith('🟡 <b>Update complete</b>') && hc.silent === false && hc.text.includes('▸ S. 2938 AI Risk Evaluation Act'), hc.text);
  ok('it shows cost, month, free queries, and the held item with its reason', /💰 <b>AI cost<\/b>  \$0\.0067/.test(hc.text) && /📅 <b>This month<\/b>  \$21\.00 of \$25\.00 \(84\.0%\)/.test(hc.text) && /🔎 <b>Free queries<\/b>  4/.test(hc.text) && /<b>⚠️ Watch<\/b>/.test(hc.text) && /not published yet/.test(hc.text), hc.text);
  ok('a healthy quiet run is green and silent, so the phone does not buzz', hq.text.startsWith('🟢 <b>Update complete, no changes</b>') && hq.silent === true && !/Watch/.test(hq.text.replace(/LegiScan/g, '')), hq.text);
  ok('a failure is red, never silent, and holds the exact error in a code block', hf.text.startsWith('🔴 <b>Update failed</b>') && hf.silent === false && hf.text.includes('<pre>publish stopped for run-20261027-2000-ab12; nothing from it was written</pre>') && /Failed at:<\/b> publish/.test(hf.text), hf.text);
  const evil = newReport({ id: 'evil', now: new Date('2026-10-27T10:00:00Z') }); evil.sources.push(sourceEntry({ runDir: quietDir, source: 'congress_gov' }));
  evil.outcome = 'failed'; evil.failed_step = 'grab'; evil.error = 'HTTP 429 <rate limit> & "more"';
  finalize(evil, { now: new Date('2026-10-27T10:00:10Z') });
  const he = formatHtml(evil).text;
  ok('markup characters in an error or a title cannot break the message', he.includes('HTTP 429 &lt;rate limit&gt; &amp; "more"') && !/<rate/.test(he));
  const tagged = formatHtml(finalize(Object.assign(newReport({ id: 'n', now: new Date('2026-10-27T10:00:00Z') }), { sources: ch.sources, ai: ch.ai, publish: ch.publish, names: { 's-2938-ai-risk-evaluation-act': '<b>Evil & Co</b>' } }), { now: new Date('2026-10-27T10:01:00Z') })).text;
  ok('a bill title with tags is shown as text', tagged.includes('&lt;b&gt;Evil &amp; Co&lt;/b&gt;'), tagged);
  ok('every message is balanced (each tag opened is closed) and fits in one Telegram message', [hc, hq, hf].every((m) => { const o = (m.text.match(/<(b|i|pre)>/g) || []).length, c = (m.text.match(/<\/(b|i|pre)>/g) || []).length; return o === c && chunk(m.text).length === 1; }));
  const longLines = hc.text.replace(TAGS, '').split('\n').filter((l) => l.length > 48);
  ok('no line is wider than a phone screen (48 characters of visible text)', longLines.length === 0, longLines.join(' | '));
  const many = newReport({ id: 'many', now: new Date('2026-10-27T10:00:00Z') });
  many.publish.runs.push(publishEntry({ status: 'published', result: { applied: Array.from({ length: 9 }, (_, i) => ({ entry_key: 'k' + i, actions: [] })), skipped: [], log: [] } }));
  finalize(many, { now: new Date('2026-10-27T10:01:00Z') });
  const hm = formatHtml(many).text;
  ok('a long list is cut at 6 with "and N more"', /Bills updated \(9\)/.test(hm) && /▸ and 3 more/.test(hm), hm);
}

// ---- a new bill added (Tier B) ----
{
  const add = newReport({ id: 'update-20261027-2000', now: new Date('2026-10-27T20:00:00Z') });
  add.sources.push(sourceEntry({ runDir: diffDir, source: 'congress_gov' }));
  add.publish.runs.push(publishEntry({ result: { applied: [], skipped: [], log: [], added: [{ item_id: 'congress_gov:119/hr/1', entry_key: 'h-r-1-frontier-test-act', section: 'D' }] }, newsBefore: 48, newsAfter: 49, status: 'published' }));
  finalize(add, { now: new Date('2026-10-27T20:00:30Z'), spend: SPEND0 });
  const names = { 'h-r-1-frontier-test-act': 'H.R. 1 Frontier Test Act' }, h = formatHtml({ ...add, names }).text, t = formatDone(add, names);
  ok('an added bill counts as a change and is named under "New bills added"', add.changed && add.totals.entries_added === 1 && /<b>New bills added \(1\)<\/b>\n▸ H\.R\. 1 Frontier Test Act/.test(h) && /New bills added: 1 \(H\.R\. 1 Frontier Test Act\)/.test(t), h);
  ok('the added bill is no longer listed as spotted; the other one still is', /New bills spotted \(1\)/.test(h) && !/▸ Frontier Test Act/.test(h) && /▸ Another Act/.test(h) && /New bills spotted: 1 \(Another Act\)/.test(t), h + '\n' + t);
}

console.log(`report: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
