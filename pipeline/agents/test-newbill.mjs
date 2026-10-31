// The new-bills simple build (agents/newbill*.mjs): the prompt document, the code checks, the review reading, and every outcome of one
// bill through processItem. Code only: the writer and reviewer are scripted fakes. The bill is invented (no test bill's words).
//   node agents/test-newbill.mjs
import { processItem } from './process-item.mjs';
import { promptBlocks, BLOCK_COUNT, writerSystem, reviewerSystem, writerSchema, expandAnswer, ROW_KEYS } from './newbill-prompts.mjs';
import { writerProblems, readReview, crossesSection, reviewTargets } from './newbill-checks.mjs';
import { FACTS_ONLY_MECHANISM } from './newbill-entry.mjs';
import { stateSectionRule, SCOPE_DEFINITION } from './prompts.mjs';
import { toJsonSchema } from '../llm/schema.mjs';
import { LlmOutputError } from '../llm/gemini.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { checkNewEntry } from '../publish/guards.mjs';
import { sourceText } from './source-text.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail === undefined ? '' : detail); } };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- an invented bill ----------
const TEXT = [
  'AN ACT relating to covered model operators.',
  'SECTION 1. Short title. This act may be cited as the Model Operator Safety Act.',
  'SECTION 2. Definitions. As used in this act: (1) "Covered model" means an artificial intelligence model trained using more than 10^25 integer or floating-point operations. (2) "Covered model operator" means a person who trains a covered model.',
  'SECTION 3. Duties. Before deploying a covered model, a covered model operator shall do all of the following: (1) publish a safety plan; (2) implement the capability to promptly enact a full shutdown.',
  'SECTION 4. Enforcement. The attorney general may bring a civil action against a covered model operator that violates this act for a civil penalty of not more than $75,000 for each violation.',
  'SECTION 5. This act takes effect January 1, 2032.'
].join('\n');
const raw = { bill: { bill_id: 77, state: 'XX', bill_number: 'HB77', title: 'Model operator safety', status: 1, history: [{ date: '2031-01-10', action: 'Introduced' }], sponsors: [{ name: 'Alex Rivera', role: 'Rep', party: 'D', sponsor_type_id: 1, sponsor_order: 1 }], texts: [], session: { session_name: '2031-2032 Regular Session', year_start: 2031, year_end: 2032 } }, text: TEXT };
const item = { item_id: 'legiscan:77', source: 'legiscan', source_id: '77', source_url: 'https://legiscan.com/XX/bill/HB77/2031', fetched_at: '2031-01-15T00:00:00Z' };
const diff = { item_id: item.item_id, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'x' }] };

const notIn = { value: 'not_in_bill', items: [], quote: '', sec: '', summary: '' };
const good = {
  inventory: [{ sec: 'Sec. 3', provision_type: 'duty', party: 'covered model operator' }],
  readable: true, text_problems: [], in_scope: true, scope_reason: 'Sec. 2 limits the act to models trained using more than 10^25 operations and Sec. 3 puts safety duties on their operators (type 1).', tracker_section: 'B',
  name_quote: 'This act may be cited as the Model Operator Safety Act.', name: 'Model Operator Safety Act',
  coverage: [{ id: 'c1', lead_in: '', quote: '"Covered model" means an artificial intelligence model trained using more than 10^25 integer or floating-point operations.', sec: 'Sec. 2(1)', party: 'covered model operator', conditions: ['more than 10^25'], headline: true, text: 'Covers operators of models trained using more than 10^25 operations.' }],
  definitions: [], exclusions: [],
  duties: [
    { id: 'u1', lead_in: 'Before deploying a covered model, a covered model operator shall do all of the following:', quote: '(1) publish a safety plan;', sec: 'Sec. 3(1)', party: 'covered model operator', force: 'duty', kind: 'framework', conditions: ['before deploying a covered model'], deadline: '', text: 'Must publish a safety plan before deploying a covered model.' },
    { id: 'u2', lead_in: 'Before deploying a covered model, a covered model operator shall do all of the following:', quote: '(2) implement the capability to promptly enact a full shutdown.', sec: 'Sec. 3(2)', party: 'covered model operator', force: 'duty', kind: 'shutdown', conditions: [], deadline: '', text: 'Must implement the capability to promptly enact a full shutdown of a covered model before deploying it.' }
  ],
  penalties: [{ id: 'p1', lead_in: '', quote: 'The attorney general may bring a civil action against a covered model operator that violates this act for a civil penalty of not more than $75,000 for each violation.', sec: 'Sec. 4', applies_to: 'covered model operator', trigger: 'violating this act', amount: 'not more than $75,000', unit: 'for each violation', enforcer: 'the attorney general', conditions: [], text: 'The attorney general may seek a civil penalty of not more than $75,000 for each violation.' }],
  effective: [{ id: 'e1', lead_in: '', quote: 'This act takes effect January 1, 2032.', sec: 'Sec. 5', type: 'act', text: 'Takes effect January 1, 2032.' }],
  other_provisions: [],
  rows: Object.fromEntries(ROW_KEYS.map((k) => [k, clone(notIn)])),
  box: {
    main_party: 'covered model operator',
    applies_to: { based_on: ['c1'], text: 'covered model operators: those who train models using more than 10^25 operations' },
    requires_lead: 'Requires them to',
    requires: { based_on: ['u1', 'u2'], text: 'publish a safety plan and be able to shut a model down fully, before deploying it' },
    enforcement: { based_on: ['p1'], text: 'the attorney general, by civil action; civil penalty of not more than $75,000 for each violation' },
    effective: { based_on: ['e1'], text: 'January 1, 2032' }
  }
};
good.rows.framework = { value: 'yes', items: ['u1'], quote: '(1) publish a safety plan;', sec: 'Sec. 3(1)', summary: 'Covered model operators must publish a safety plan before deploying.' };
good.rows.shutdown = { value: 'yes', items: ['u2'], quote: '(2) implement the capability to promptly enact a full shutdown.', sec: 'Sec. 3(2)', summary: 'Covered model operators must be able to fully shut a model down.' };
good.rows.compute_threshold = { value: 'yes', items: ['c1'], quote: '"Covered model" means an artificial intelligence model trained using more than 10^25 integer or floating-point operations.', sec: 'Sec. 2(1)', summary: 'Models trained using more than 10^25 operations.' };
const out = { name: 'XX HB77' };
const source = TEXT;

// ---------- the prompt document ----------
ok('the prompt document has its eight blocks', promptBlocks().length === BLOCK_COUNT);
const ws = writerSystem({ sectionRule: stateSectionRule(['B', 'B.2', 'C']) }), rs = reviewerSystem();
ok('writer and reviewer both carry the scope definition, filled in', ws.includes(SCOPE_DEFINITION.slice(0, 80)) && rs.includes(SCOPE_DEFINITION.slice(0, 80)) && !/\{\{/.test(ws + rs));
ok('both carry the binding-provision scope rule and the small-company test', /small-company test/i.test(ws) && /small-company test/i.test(rs));
ok('the writer shape puts lead_in and quote before text, and the plan first', (() => { const s = toJsonSchema(writerSchema(['B'])); const k = Object.keys(s.properties.items.items.properties); return Object.keys(s.properties)[0] === 'inventory' && k.indexOf('quote') < k.indexOf('text') && k.indexOf('lead_in') < k.indexOf('quote'); })());
// the compact answer the API accepts (one items list, one rows list) becomes the full shape at once
{
  const compact = { ...clone(good), items: [...good.coverage.map((x) => ({ list: 'coverage', ...x })), ...good.duties.map((x) => ({ list: 'duties', ...x })), ...good.penalties.map((x) => ({ list: 'penalties', ...x })), ...good.effective.map((x) => ({ list: 'effective', ...x }))], rows: ROW_KEYS.map((k) => ({ key: k, ...good.rows[k] })) };
  for (const l of ['coverage', 'definitions', 'exclusions', 'duties', 'penalties', 'effective', 'other_provisions']) delete compact[l];
  const full = expandAnswer(compact);
  ok('a compact answer expands to the seven lists and thirteen named rows, and passes the same checks', full.duties.length === 2 && full.coverage[0].headline === true && full.rows.shutdown.value === 'yes' && !('list' in full.duties[0]) && writerProblems(full, { source }).length === 0, writerProblems(full, { source }));
  ok('an answer already in the full shape is left as it is', expandAnswer(good) === good);
  const bad = clone(good); bad.duties[0].kind = 'safety';
  ok('a per-list choice the grammar leaves open is checked by code', writerProblems(bad, { source }).some((p) => /kind "safety" is not one of/.test(p)));
  ok('the compact shape is small enough: one item shape and one row shape', (() => { const s = toJsonSchema(writerSchema(['B'])); return s.properties.items.type === 'array' && s.properties.rows.type === 'array' && !('coverage' in s.properties) && JSON.stringify(s).length < 4500; })());
}

// ---------- code checks ----------
ok('a faithful answer passes every check', writerProblems(good, { source }).length === 0, writerProblems(good, { source }));
const bad1 = clone(good); bad1.duties[0].quote = '(1) publish a safety plan and a security plan;';
ok('a quote not in the bill is refused', writerProblems(bad1, { source }).some((p) => /u1\]: quote is not in the bill/.test(p)));
const bad2 = clone(good); bad2.penalties[0].text = 'A civil penalty of not more than $100,000 per violation.';
ok('a number not in the bill is refused (one way)', writerProblems(bad2, { source }).some((p) => /"100000" is not in the bill/.test(p)));
const bad3 = clone(good); bad3.box.effective.text = '';
ok('a blank box slot is refused', writerProblems(bad3, { source }).some((p) => /box.effective is blank/.test(p)));
const bad4 = clone(good); bad4.duties[0].lead_in = 'Before deploying, an operator shall:';
ok('a duty quoted as one item of a list without the words that open it is sent back', (() => { const b = clone(good); b.duties[1].lead_in = ''; return writerProblems(b, { source }).some((p) => /u2]: the quote is one item of a list/.test(p)); })());
ok('a quote that is not a list item needs no lead_in', (() => { const b = clone(good); return !writerProblems(b, { source }).some((p) => /one item of a list/.test(p)) && !writerProblems({ ...b, penalties: [{ ...b.penalties[0], lead_in: '' }] }, { source }).some((p) => /one item of a list/.test(p)); })());
ok('a lead_in not in the bill is refused', writerProblems(bad4, { source }).some((p) => /lead_in is not in the bill/.test(p)));
const bad5 = clone(good); bad5.duties[0].lead_in = ''; bad5.duties[0].quote = 'Before deploying a covered model, a covered model operator shall do all of the following: (2) implement the capability';
ok('a lead-in stitched onto a later list item is refused (not one span)', writerProblems(bad5, { source }).some((p) => /u1\]: quote is not in the bill/.test(p)));
ok('a quote running into the next section is caught; a cross-reference is not', crossesSection('(2) implement the capability to promptly enact a full shutdown. SECTION 4. Enforcement. The attorney') && !crossesSection('as set forth in SECTION 6-1-1701 (2), a developer') && crossesSection('may be made public. ``SEC. 803. REPORT. The Secretary'));
const out1 = { ...clone(good), in_scope: false, scope_reason: 'general duties' };
ok('an out-of-scope answer with items is refused; an empty one passes', writerProblems(out1, { source }).some((p) => /every list must be empty/.test(p)) && writerProblems({ readable: true, in_scope: false, scope_reason: 'x', coverage: [], definitions: [], exclusions: [], duties: [], penalties: [], effective: [], other_provisions: [] }, { source }).length === 0);
const bad6 = clone(good); bad6.name = 'Safety Act for Operators';
ok('a name that rewords the bill\'s short title is refused', writerProblems(bad6, { source }).some((p) => /name is not copied/.test(p)));

// ---------- reading a review ----------
const finding = (severity, where, bill_quote) => ({ severity, where, bill_quote, problem: 'p', fix: 'f' });
const all = reviewTargets(good);
const rv = readReview({ checked: all, findings: [finding('MISLEADING', 'box.requires', 'publish a safety plan'), finding('WRONG', 'p1', 'a fine of $1,000,000')] }, { source, out: good });
ok('a finding whose proof is not in the bill is dropped; the verdict is computed', rv.findings.length === 1 && rv.discarded.length === 1 && rv.verdict === 'fix' && rv.wrong === 0);
ok('a proved WRONG finding fails the entry', readReview({ checked: all, findings: [finding('WRONG', 'p1', 'not more than $75,000')] }, { source, out: good }).verdict === 'fail');
ok('a proved WRONG scope finding marks the bill out', readReview({ checked: all, findings: [finding('WRONG', 'in_scope / scope_reason', 'publish a safety plan')] }, { source, out: good }).scopeWrong && !readReview({ checked: all, findings: [finding('WRONG', 'tracker_section', 'publish a safety plan')] }, { source, out: good }).scopeWrong);
ok('parts named with the reviewer own paths count as checked (rows.framework, in_scope, name_quote, box.requires)', readReview({ checked: [...all.filter((t) => !['framework', 'shutdown', 'scope', 'name'].includes(t)), 'rows.framework', 'duty row: shutdown', 'in_scope', 'name_quote'], findings: [] }, { source, out: good }).missing.length === 0, readReview({ checked: [...all.filter((t) => !['framework', 'shutdown', 'scope', 'name'].includes(t)), 'rows.framework', 'duty row: shutdown', 'in_scope', 'name_quote'], findings: [] }, { source, out: good }).missing);
ok('a part never named is still missing', readReview({ checked: all.filter((t) => t !== 'shutdown'), findings: [] }, { source, out: good }).missing.join() === 'shutdown');
ok('parts the reviewer did not say it checked are listed', readReview({ checked: all.slice(2), findings: [] }, { source, out: good }).missing.length === 2);

// ---------- the whole flow through processItem ----------
const script = (answers) => ({ calls: [], async generate(req) { this.calls.push(req); const a = answers.shift(); if (a instanceof Error) throw a; if (a === undefined) throw new Error('unexpected call'); return { data: typeof a === 'function' ? a(req) : a, usage: {} }; } });
const trap = { calls: 0, async generate() { this.calls++; throw new Error('the older loop must not run'); } };
const run = (writer, reviewer, extra = {}) => processItem({ generator: trap, validator: trap, referee: trap, writer, billReviewer: reviewer, item, raw, diff, entries: [], today: '2031-01-15', runId: 'update-20310115-0000', now: new Date('2031-01-15T00:00:00Z'), ...extra });
const passReview = { reviewer_map: [], checked: all, findings: [] };

{
  const w = script([clone(good)]), r = script([passReview]);
  const res = await run(w, r);
  const e = res.entry, v = makeValidator();
  ok('a clean bill publishes: one writer call, one review, the older loop untouched', res.outcome === 'publishable' && w.calls.length === 1 && r.calls.length === 1 && trap.calls === 0, `${res.outcome} ${res.reason}`);
  ok('the headline is the bill\'s own name; the official number and title come from the record', e.short_name === 'Model Operator Safety Act' && /HB77|H\.B\. 77/.test(e.title));
  ok('the plain page carries the box and each item with its quote and lead_in', e.plain.box.requires_lead === 'Requires them to' && e.plain.box.effective === 'January 1, 2032' && e.plain.items.duties[0].lead_in.startsWith('Before deploying') && e.plain.items.duties[0].quote === '(1) publish a safety plan;');
  ok('the 13 duties come from the rows, with the text they were read from', e.duties.shutdown.value === 'yes' && e.duties.registration.value === 'not_in_bill' && e.duties_basis.chars >= TEXT.length && /^[a-f0-9]{64}$/.test(e.duties_basis.sha256));
  ok('the reading fields are built from the items (catastrophic-risk duties first)', /shutdown/.test(e.mechanism.split(';')[0]) && /10\^25/.test(e.thresholds) && /\$75,000/.test(e.penalties) && e.effective_text === 'Takes effect January 1, 2032.');
  ok('the published entry passes the entry schema', v.check('entry', e).length === 0, JSON.stringify(v.check('entry', e)).slice(0, 400));
  ok('the reviewer reads the entry without the writer\'s inventory', !r.calls[0].prompt.includes('"inventory"') && r.calls[0].system.includes('fact-checker'));
}
{
  const w = script([clone(good)]), r = script([{ reviewer_map: [], checked: all, findings: [finding('WRONG', 'scope', 'publish a safety plan')] }]);
  const res = await run(w, r);
  ok('a proved wrong scope call keeps the bill out: no entry, not even facts-only', res.outcome === 'out_of_scope' && !res.entry && res.excluded_by_reviewer === true, `${res.outcome}`);
}
{
  const w = script([{ ...clone(good), in_scope: false, scope_reason: 'general duties on every AI product', coverage: [], duties: [], penalties: [], effective: [] }]), r = script([]);
  const res = await run(w, r);
  ok('the writer ruling it out ends it: out of scope, reviewer not asked', res.outcome === 'out_of_scope' && r.calls.length === 0);
}
{
  const w = script([clone(good)]), r = script([]);
  const res = await run(w, r, { newEntriesOn: false });
  ok('new entries switched off: the draft is reported, unconfirmed; no reviewer (Opus) spend', res.outcome === 'held' && res.unconfirmed && r.calls.length === 0 && /switched off/.test(res.reason));
}
{
  const w = script([clone(bad2), clone(good)]), r = script([passReview]);
  const res = await run(w, r);
  ok('a failed check gets one retry listing the problem; the fixed answer publishes', res.outcome === 'publishable' && w.calls.length === 2 && /checks_failed/.test(w.calls[1].prompt) && /100000/.test(w.calls[1].prompt) && /previous_answer/.test(w.calls[1].prompt));
}
{
  const wrong = { reviewer_map: [], checked: all, findings: [finding('WRONG', 'p1', 'not more than $75,000')] };
  const w = script([clone(good), clone(good)]), r = script([wrong, clone(wrong)]);
  const res = await run(w, r);
  ok('a WRONG that survives the fix round publishes facts only, flagged and reported', res.outcome === 'publishable' && res.facts_only === true && res.entry.mechanism === FACTS_ONLY_MECHANISM && res.entry.plain.facts_only === true && /review/.test(w.calls[1].prompt) && res.proposal, `${res.outcome} ${res.reason}`);
  ok('the facts-only entry passes the entry schema', makeValidator().check('entry', res.entry).length === 0);
}
{
  const misleading = { reviewer_map: [], checked: all, findings: [finding('MISLEADING', 'box.requires', 'publish a safety plan')] };
  const w = script([clone(good), clone(good)]), r = script([misleading, misleading]);
  const res = await run(w, r);
  ok('misleading findings alone do not hold the entry after the fix round (the new-bills bar)', res.outcome === 'publishable' && !res.facts_only && w.calls.length === 2 && r.calls.length === 2);
}
{
  const w = script([new LlmOutputError('not JSON'), new LlmOutputError('not JSON')]), r = script([]);
  const res = await run(w, r);
  ok('two unusable writer answers hold the bill, no reviewer spend', res.outcome === 'held' && /unusable/.test(res.reason) && r.calls.length === 0);
}
{
  const short = { reviewer_map: [], checked: all.slice(3), findings: [] };
  const w = script([clone(good)]), r = script([short, passReview]);
  const res = await run(w, r);
  ok('a review that skipped parts is asked again, naming them; complete, it counts', res.outcome === 'publishable' && r.calls.length === 2 && /did not list these parts as checked/.test(r.calls[1].prompt));
}

{
  // a duty line in words the bill does not use: the publisher's guard would refuse it, so it goes back in the one retry
  const loose = clone(good); loose.duties[1].text = 'Must be able to switch everything off quickly before going live.';
  ok('a duty line not in the bill\'s own words is caught by the checks (the publisher\'s rule)', writerProblems(loose, { source }).some((p) => /no quote backs/.test(p) && /closer to the bill's own words/.test(p)));
  const w = script([loose, clone(good)]), r = script([passReview]);
  const res = await run(w, r);
  ok('and the retry with the bill\'s words publishes', res.outcome === 'publishable' && w.calls.length === 2 && /no quote backs/.test(w.calls[1].prompt));
}

// ---------- the scope check (owner, 31 Oct 2026) ----------
{
  const judgeOf = (answers) => script(answers);
  const inQ = { considered: [], in_scope: true, sec: 'Sec. 2(1)', quote: good.coverage[0].quote, reason: 'limited by 10^25' };
  const runJ = (w, r, j, extra = {}) => processItem({ generator: trap, validator: trap, referee: trap, writer: w, billReviewer: r, scopeJudge: j, item, raw, diff, entries: [], today: '2031-01-15', runId: 'update-20310115-0000', now: new Date('2031-01-15T00:00:00Z'), ...extra });
  let j = judgeOf([inQ]), r = script([passReview]);
  let res = await runJ(script([clone(good)]), r, j);
  ok('the scope check proves the bill in with a provision found in the bill, then the reviewer runs and it publishes', res.outcome === 'publishable' && j.calls.length === 1 && r.calls.length === 1 && /scope_definition/.test(j.calls[0].system) && /writer_reason/.test(j.calls[0].prompt));
  j = judgeOf([{ considered: [], in_scope: false, sec: '', quote: '', reason: 'the duties fall on every generative AI system' }]); r = script([]);
  res = await runJ(script([clone(good)]), r, j);
  ok('the scope check ruling it out keeps the bill out: no entry, reviewer not asked', res.outcome === 'out_of_scope' && !res.entry && r.calls.length === 0 && /every generative AI system/.test(res.reason));
  j = judgeOf([{ ...inQ, quote: 'a covered model operator must be licensed' }, inQ]); r = script([passReview]);
  res = await runJ(script([clone(good)]), r, j);
  ok('an in-scope answer whose quote is not in the bill is asked once more; proved, it goes on', res.outcome === 'publishable' && j.calls.length === 2 && /not in the bill word for word/.test(j.calls[1].prompt));
  j = judgeOf([{ ...inQ, quote: 'invented words' }, { ...inQ, quote: 'still invented words' }]); r = script([]);
  res = await runJ(script([clone(good)]), r, j);
  ok('an in-scope answer it cannot prove twice keeps the bill out (fail closed)', res.outcome === 'out_of_scope' && !res.entry && r.calls.length === 0);
  j = judgeOf([]);
  res = await runJ(script([clone(good)]), script([]), j, { newEntriesOn: false });
  ok('with new entries off the scope check is not run (no Opus spend)', res.outcome === 'held' && j.calls.length === 0);
}

// ---------- the publisher's guard (publish/guards.mjs checkNewEntry) accepts what the simple build publishes ----------
{
  const src = sourceText(raw, item.source);
  const a = await run(script([clone(good)]), script([passReview]));
  ok('the section is proved by the writer\'s own quote (code-checked criterion)', a.entry.evidence.some((x) => x.field === 'section' && /10\^25/.test(x.quote)));
  ok('the publisher\'s guard accepts a published entry', checkNewEntry(a.entry, { source: src }).length === 0, checkNewEntry(a.entry, { source: src }));
  const wrong = { reviewer_map: [], checked: all, findings: [finding('WRONG', 'p1', 'not more than $75,000')] };
  const f = await run(script([clone(good), clone(good)]), script([wrong, clone(wrong)]));
  ok('the publisher\'s guard accepts a facts-only entry', checkNewEntry(f.entry, { source: src }).length === 0, checkNewEntry(f.entry, { source: src }));
  ok('a facts-only entry with any other text is refused by the guard', checkNewEntry({ ...f.entry, thresholds: 'Covers everyone.' }, { source: src }).some((p) => /facts-only/.test(p)));
  // no quote shows section B's frontier threshold: the section is not proved and nothing is created
  const noProof = clone(good); noProof.tracker_section = 'C';
  const h = await run(script([noProof]), script([passReview]));
  ok('a section its quotes cannot prove is held, not published', h.outcome === 'held' && /section C's criterion/.test(h.reason), `${h.outcome} ${h.reason}`);
}

console.log(`newbill: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
