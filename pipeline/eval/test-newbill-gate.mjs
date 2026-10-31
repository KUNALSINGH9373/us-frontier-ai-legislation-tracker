// The new-bills measure and its gate (eval/newbill-eval.mjs, eval/gate.mjs under new_bills.engine "simple"). Code only, no AI.
//   node eval/test-newbill-gate.mjs
import { gate } from './gate.mjs';
import { scoreBill, summariseBills, sectionsFor, billOf } from './newbill-eval.mjs';
import { readScore } from './newbill-scorer.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail === undefined ? '' : detail); } };

// ---------- scoring one bill ----------
const gIn = { key: 'a', in_scope: true }, gOut = { key: 'b', in_scope: false };
ok('a published in-scope bill with proved findings counts them', (() => { const s = scoreBill(gIn, { decision: 'publish', trail: { writer_calls: 1, reviews: [1] } }, { wrong: 0, misleading: 2, omission: 1, dropped: 1, findings: [] }); return s.published && s.wrong === 0 && s.misleading === 2 && !s.scope_error; })());
ok('publishing an out-of-scope bill is WRONG and a scope error', (() => { const s = scoreBill(gOut, { decision: 'publish' }, { wrong: 0, misleading: 0, omission: 0, dropped: 0, findings: [] }); return s.wrong === 1 && s.scope_error === 'published_out_of_scope'; })());
ok('a facts-only page of an out-of-scope bill is a scope error too', scoreBill(gOut, { decision: 'facts_only' }, null).scope_error === 'published_out_of_scope');
ok('ruling out an in-scope bill is a missed bill', scoreBill(gIn, { decision: 'excluded' }, null).scope_error === 'missed' && scoreBill(gIn, { decision: 'out_of_scope' }, null).scope_error === 'missed');
ok('correctly ruling out an out-of-scope bill is not an error', !scoreBill(gOut, { decision: 'excluded' }, null).scope_error && !scoreBill(gOut, { decision: 'out_of_scope' }, null).scope_error);
const sum = summariseBills([scoreBill(gIn, { decision: 'publish' }, { wrong: 0, misleading: 1, omission: 0, dropped: 0, findings: [] }), scoreBill(gOut, { decision: 'out_of_scope' }, null), scoreBill({ key: 'c', in_scope: true }, { decision: 'error' }, null)]);
ok('the summary counts published, scope errors, errors and misleading per published bill', sum.items === 3 && sum.published === 1 && sum.scope_errors === 0 && sum.errors === 1 && sum.misleading_per_published === 1 && sum.publish_rate === 0.5, JSON.stringify(sum));
ok('the scorer\'s unproved findings are dropped', (() => { const r = readScore({ scope_in: true, findings: [{ severity: 'WRONG', where: 'x', bill_quote: 'not in the bill at all', problem: 'p' }, { severity: 'MISLEADING', where: 'y', bill_quote: 'a civil penalty', problem: 'p' }] }, 'The board may impose a civil penalty of $5,000.'); return r.wrong === 0 && r.misleading === 1 && r.dropped === 1; })());
ok('sections follow production: enacted state law A or C, state bill B, B.2 or C, federal D, F or G.3', sectionsFor({ level: 'state', section: 'A' }).join() === 'A,C' && sectionsFor({ level: 'state', section: 'B.2' }).join() === 'B,B.2,C' && sectionsFor({ level: 'federal', section: 'F' }).join() === 'D,F,G.3');
ok('a set bill is read like production (readerText): line numbers gone', billOf({ key: 'k', title: 'T' }, { kind: 'legiscan', bill: 'NE LB1 (5)' }, '1 a frontier developer shall\n2 publish a plan;\n3 and report\n4 incidents.\n').text.includes('a frontier developer shall\npublish a plan;'));

// ---------- the gate ----------
const HASH = 'h-now', hashes = { fields: 'f', new_entries: HASH, relationships: 'r', news: 'n', news_writer: 'w' };
const models = { provider: 'anthropic', anthropic: { roles: { generator: { model: 'sonnet' }, validator: { model: 'haiku' }, referee: { model: 'opus' }, writer: { model: 'sonnet' }, bill_reviewer: { model: 'opus' } } } };
const config = { auto_publish: { mechanism: false, thresholds: false, penalties: false, new_entries: true, relationships: false, news: false } };
const pin = { items: 26, gold_sha256: 'G', references_sha256: 'R' };
const expected = { tierb: 10, news: 1, news_writer: 1, links: null, unseen: pin };
const tierb = { measure: 'tierb', run_at: '2026-11-01T00:00:00Z', checks_hash: HASH, cases: 10, wrong: 0 };
const good = { wrong: 0, scope_errors: 0, errors: 0, no_text: 0, published: 20, misleading: 30 };
const nb = (set, extra = {}, summary = {}) => ({ measure: 'new_bills', method: 'simple', set, run_at: '2026-11-02T00:00:00Z', writer: 'sonnet', reviewer: 'opus', checks_hash: HASH, partial: false,
  set_size: set === 'test' ? 48 : 26, gold_sha256: set === 'unseen' ? 'G' : 'x', references_sha256: set === 'unseen' ? 'R' : null, summary: { items: set === 'test' ? 48 : 26, ...good, ...summary }, ...extra });
const run = (measures, extra = {}) => gate({ config, models, reports: [], goldItems: 48, measures, hashes, expected, engine: 'simple', ...extra }).fields.new_entries;

ok('no new-bills report: new entries stay off', !run([tierb]).meets && /no new-bills report covering the test set \(whole set\)/.test(run([tierb]).note));
ok('both sets passing at zero wrong, plus Tier B: new entries may switch on (misleading does not block)', run([tierb, nb('test'), nb('unseen')]).meets, run([tierb, nb('test'), nb('unseen')]).note);
ok('one WRONG on the test set keeps it off', !run([tierb, nb('test', {}, { wrong: 1 }), nb('unseen')]).meets);
ok('a scope error (a missed or wrongly published bill) on the unseen set keeps it off', !run([tierb, nb('test'), nb('unseen', {}, { scope_errors: 1 })]).meets);
ok('an error or a missing text keeps it off', !run([tierb, nb('test', {}, { errors: 1 }), nb('unseen')]).meets && !run([tierb, nb('test'), nb('unseen', {}, { no_text: 1 })]).meets);
ok('a set where nothing publishes proves nothing', !run([tierb, nb('test', {}, { published: 0 }), nb('unseen')]).meets);
ok('an unseen report over a different set (fingerprints) does not count', !run([tierb, nb('test'), nb('unseen', { references_sha256: 'OTHER' })]).meets);
ok('no pin: the unseen set never counts (fail closed)', !run([tierb, nb('test'), nb('unseen')], { expected: { ...expected, unseen: null } }).meets);
ok('a partial run (--only) does not count', !run([tierb, nb('test', { partial: true }), nb('unseen')]).meets);
ok('a report from other models does not count', !run([tierb, nb('test', { reviewer: 'haiku' }), nb('unseen')]).meets);
ok('a report from older code (stale hash) does not count', !run([tierb, nb('test', { checks_hash: 'old' }), nb('unseen')]).meets);
ok('the latest report decides: a newer failing run overrides an older pass', !run([tierb, nb('test'), nb('test', { run_at: '2026-11-03T00:00:00Z' }, { wrong: 2 }), nb('unseen')]).meets);
ok('Tier B still has to pass', !run([{ ...tierb, wrong: 1 }, nb('test'), nb('unseen')]).meets);
ok('the older engine keeps the older rule (field eval + Tier B), ignoring new-bills reports', /every reading field must meet the bar/.test(run([tierb, nb('test'), nb('unseen')], { engine: 'generator' }).note));

// the smaller bar (config/publish.json new_bills_gate.min_items, owner 31 Oct 2026): at least N bills of each set
{
  const small = { ...config, new_bills_gate: { min_items: { test: 5, unseen: 5 } } };
  const part = (set, n, extra = {}, summary = {}) => nb(set, { partial: true, ...extra }, { items: n, ...summary });
  const runS = (measures, extra = {}) => run(measures, { config: small, ...extra });
  ok('with min_items 5, a 5-bill run of each set at zero wrong counts', runS([tierb, part('test', 5), part('unseen', 5)]).meets, runS([tierb, part('test', 5), part('unseen', 5)]).note);
  ok('a 4-bill run does not', !runS([tierb, part('test', 4), part('unseen', 5)]).meets && /at least 5 bills/.test(runS([tierb, part('test', 4), part('unseen', 5)]).note));
  ok('a small run still needs zero wrong and every scope call right', !runS([tierb, part('test', 5, {}, { wrong: 1 }), part('unseen', 5)]).meets && !runS([tierb, part('test', 5), part('unseen', 5, {}, { scope_errors: 1 })]).meets);
  ok('a small run still needs the pinned unseen set, the current code and the production models', !runS([tierb, part('test', 5), part('unseen', 5, { gold_sha256: 'OTHER' })]).meets && !runS([tierb, part('test', 5, { checks_hash: 'old' }), part('unseen', 5)]).meets && !runS([tierb, part('test', 5, { writer: 'haiku' }), part('unseen', 5)]).meets);
  ok('without min_items a small run never counts (the whole set is required)', !run([tierb, part('test', 5), part('unseen', 5)]).meets);
}

// the owner's override (config/publish.json gate_override)
{
  const ov = { ...config, gate_override: { new_entries: { by: 'owner', date: '2026-10-31', reason: 'accepted the live test' } } };
  const g = run([tierb], { config: ov });
  ok('an owner override lets the switch on without a report, and says so with who, when and why', g.meets && g.override && g.override.by === 'owner' && /on by owner override \(owner, 2026-10-31: accepted the live test\)/.test(g.note));
  ok('an override missing who or when does nothing', !run([tierb], { config: { ...config, gate_override: { new_entries: { reason: 'x' } } } }).meets);
  ok('without the override the gate holds again', !run([tierb]).meets);
}

console.log(`newbill gate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
