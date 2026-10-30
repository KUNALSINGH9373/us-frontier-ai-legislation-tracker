// Run:  node agents/test-duties.mjs
// The duty step for new entries (agents/duties.mjs) with scripted LLMs on the real text of S. 2938 (fixtures/congress/119-s-2938-text.json:
// the Congress.gov record plus the official bill text). The "correct" answers are the session-written ones (duties/drafts), which
// duties/check.mjs already accepts. An invented quote, a "yes" the reader rejects, a wrong section and a missing field each keep the
// duties off the entry; a clean set lands on it with its basis and the entry still passes its schema.
import { asSlots } from './test-slots-helper.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeDuties, normaliseDuties, DUTY_ROUNDS } from './duties.mjs';
import { DUTY_NAMES, dutiesPrompt } from './duties-prompt.mjs';
import { processItem } from './process-item.mjs';
import { sourceText } from './source-text.mjs';
import { checkAnswer } from '../duties/check.mjs';
import { LlmOutputError } from '../llm/gemini.mjs';
import { HttpError } from '../grabber/lib/http.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { sha } from '../grabber/lib/run-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const J = (...p) => JSON.parse(fs.readFileSync(path.join(here, '..', ...p), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const v = makeValidator();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };

const raw = J('fixtures', 'congress', '119-s-2938-text.json');
const text = sourceText(raw, 'congress_gov');
const URL = 'https://www.congress.gov/bill/119th-congress/senate-bill/2938';
const entry = (() => { const e = clone(J('fixtures', 'entries.sample.json').find((x) => x.key.startsWith('s-2938'))); delete e.duties; delete e.duties_basis; return e; })();
// What the model returns: the session answers, without the URLs code fills in.
const good = () => { const d = clone(J('duties', 'drafts', 's-2938-ai-risk-evaluation-act.json').duties); Object.values(d).forEach((a) => delete a.source_url); return { duties: d, notes: '' }; };
const READER_Q = 'trained using a quantity of computing power greater than 10^26 integer or floating-point operations';

function scriptedGenerator(queue) {
  return { calls: [], async generate(req) { this.calls.push(req); const r = queue.shift(); if (r instanceof Error) throw r; return { data: asSlots(typeof r === 'function' ? r(req) : r), usage: {} }; } };
}
// Reads the numbered claims out of the prompt as a real reader would; rejects the duties named in `reject`.
function scriptedValidator({ reject = {}, quote = READER_Q, quotes = {} } = {}) {
  return {
    calls: [],
    async generate(req) {
      this.calls.push(req);
      const claims = [...req.prompt.matchAll(/^(\d+)\. \[([^\]]+)\] (.*)$/gm)].map((m) => ({ n: +m[1], field: m[2] }));
      return { usage: {}, data: { results: claims.map((c) => reject[c.field] ? { n: c.n, supported: false, quote: null, reason: reject[c.field] } : { n: c.n, supported: true, quote: quotes[c.field] || quote, reason: null }) } };
    }
  };
}
const run = (generator, validator, o = {}) => writeDuties({ generator, validator, entry, sourceText: text, sourceUrl: URL, itemId: 'congress_gov:119/s/2938', now: new Date('2026-10-28T05:00:00Z'), ...o });
const asserted = DUTY_NAMES.filter((k) => good().duties[k].value !== 'not_in_bill');

// ---------- the fixture and the prompt ----------
ok('the fixture carries the official text, so the session answers are provable from it', DUTY_NAMES.every((k) => checkAnswer(k, normaliseDuties(good().duties, URL)[k], text, { sourceUrl: URL }).length === 0));
{
  const p = dutiesPrompt({ entry, source: text, sourceUrl: URL });
  ok('the duty prompt shows the bill and the whole source', p.includes(entry.title) && p.includes('<<<SOURCE') && p.includes(text));
}

// ---------- 1. a correct full set ----------
{
  const g = scriptedGenerator([good()]), val = scriptedValidator();
  const r = await run(g, val);
  ok('a correct full set is kept, in one round', r.duties && r.rounds === 1 && r.reason === null, r.reason);
  ok('every answer that quotes gets the URL the text came from; silence answers carry none', DUTY_NAMES.every((k) => (r.duties[k].value === 'not_in_bill') === !r.duties[k].source_url) && asserted.every((k) => r.duties[k].source_url === URL));
  ok('duties_basis records the text: URL, hash, length, method agent', r.duties_basis.source_url === URL && r.duties_basis.sha256 === sha(text) && r.duties_basis.chars === text.length && r.duties_basis.method === 'agent' && r.duties_basis.checked_at === '2026-10-28T05:00:00Z');
  ok('the entry with the duties passes the entry schema', v.check('entry', { ...entry, duties: r.duties, duties_basis: r.duties_basis }).length === 0, v.check('entry', { ...entry, duties: r.duties, duties_basis: r.duties_basis }).join('; '));
  const claims = [...val.calls[0].prompt.matchAll(/^\d+\. \[([^\]]+)\]/gm)].map((m) => m[1]);
  ok('the reader checks every yes / partial / no answer and no silence answer', val.calls.length === 1 && claims.join() === asserted.join(), claims.join());
  ok('the reader sees the source and the claims, not the generator\'s JSON', /<<<SOURCE/.test(val.calls[0].prompt) && !/"value"/.test(val.calls[0].prompt));
}

// ---------- 2. each kind of bad answer keeps the duties off ----------
const bad = (change) => () => { const x = good(); change(x.duties); return x; };
const cases = [
  ['an invented quote', 'penalties', bad((d) => { d.penalties.quote = 'shall be fined not less than $5,000,000 per day of the violation'; }), {}, /the quote is not in the official text|number 5000000/],
  ['a "yes" the reader rejects', 'compute_threshold', bad(() => {}), { compute_threshold: 'SOURCE sets no compute figure' }, /independent reader rejected it/],
  ['a wrong section', 'shutdown', bad((d) => { d.shutdown.section = 'Sec. 88(b)'; }), {}, /section "Sec\. 88\(b\)" has the number 88/],
  ['a missing required field (no quote on a partial answer)', 'third_party_audit', bad((d) => { delete d.third_party_audit.quote; }), {}, /format/],
  ['a missing duty', 'effective_date', bad((d) => { delete d.effective_date; }), {}, /all 13 duties must be answered/]
];
for (const [what, name, answer, reject, re] of cases) {
  const g = scriptedGenerator([answer(), answer()]), val = scriptedValidator({ reject });
  const r = await run(g, val);
  ok(`${what}: the duties are left off the entry (the schema has no "unknown" answer)`, r.duties === null && !r.duties_basis && r.dropped.join() === name && r.rounds === DUTY_ROUNDS, JSON.stringify(r));
  ok(`${what}: the reason names the problem`, re.test(r.reason), r.reason);
  ok(`${what}: the second round was told exactly what failed`, g.calls.length === 2 && /PREVIOUS ATTEMPT WAS REJECTED/.test(g.calls[1].prompt) && g.calls[1].prompt.includes(name + ':'));
}
{
  // Fixed on the second round: kept.
  const g = scriptedGenerator([bad((d) => { d.penalties.quote = 'fined $9 per day'; })(), good()]);
  const r = await run(g, scriptedValidator());
  ok('a bad answer fixed after feedback is kept', r.duties && r.rounds === 2 && r.dropped.length === 0, r.reason);
}
{
  // The reader's own quote must be in the text too.
  const r = await run(scriptedGenerator([good(), good()]), scriptedValidator({ quote: 'a sentence that is nowhere in the bill' }));
  ok('a reader that "supports" with a quote not in the text does not prove anything', r.duties === null && r.dropped.length === asserted.length, JSON.stringify(r.dropped));
}
{
  const allSilent = () => { const x = good(); DUTY_NAMES.forEach((k) => { x.duties[k] = { value: 'not_in_bill', summary: 'The bill does not address this.' }; }); return x; };
  const r = await run(scriptedGenerator([allSilent()]), scriptedValidator());
  ok('a set that is all not_in_bill records nothing', r.duties === null && /not_in_bill/.test(r.reason));
}
{
  const r = await run(scriptedGenerator([new LlmOutputError('not JSON'), { notes: 'no duties key' }]), scriptedValidator());
  ok('unusable answers twice: no duties, the step does not throw', r.duties === null && /no "duties" object/.test(r.reason), r.reason);
  const r2 = await run(scriptedGenerator([new HttpError(503, 'https://model.example/v1')]), scriptedValidator());
  ok('a failing model service costs only the duties', r2.duties === null && /could not run/.test(r2.reason), r2.reason);
}
{
  const x = good(); x.duties.whistleblower.quote = 'stray quote on a silence answer'; x.duties.whistleblower.section = 'Sec. 1';
  const n = normaliseDuties(x.duties, URL);
  ok('a silence answer loses any section, quote or URL the model gave it', !('quote' in n.whistleblower) && !('section' in n.whistleblower) && !('source_url' in n.whistleblower));
}

// ---------- 3. through processItem: a new bill in section D gets its duties ----------
{
  const item = { item_id: 'congress_gov:119/s/2938', source: 'congress_gov', source_id: '119/s/2938', entry_key: null, change: 'new', source_url: URL, fetched_at: '2026-10-07T04:00:00Z', raw_hash: 'x', raw_path: 'x' };
  const diff = { item_id: item.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'New bill "Artificial Intelligence Risk Evaluation Act of 2025"' }] };
  const M = 'shall be fined not less than $1,000,000 per day of the violation', T = READER_Q;
  // Round 3: a federal D entry needs the referee's section quote to show D's criterion (an advanced-AI developer definition).
  const SECTION_D_Q = 'covered advanced artificial intelligence system developer';
  const patch = { operation: 'create', in_scope: true, scope_reason: 'Sets mandatory evaluation duties on developers of advanced AI systems.', section: 'D', events_add: [], notes: '',
    fields: { mechanism: 'A person who violates the participation or deployment rules shall be fined not less than $1,000,000 per day of the violation.', thresholds: 'Trained using more than 10^26 integer or floating-point operations', penalties: 'Fined not less than $1,000,000 per day of the violation' },
    evidence: [{ field: 'mechanism', quote: M }, { field: 'thresholds', quote: T }, { field: 'penalties', quote: M }] };
  const entries = J('fixtures', 'entries.sample.json').filter((e) => !e.key.startsWith('s-2938'));
  const go = (dutyAnswers) => processItem({ generator: scriptedGenerator([clone(patch), ...dutyAnswers]), validator: scriptedValidator({ quote: M }), referee: scriptedValidator({ quote: M, quotes: { section: SECTION_D_Q } }), item, raw, diff, entry: null, entries, today: '2026-10-28', runId: 'run-test', now: new Date('2026-10-28T05:00:00Z') });
  const r = await go([good()]);
  ok('a new section D bill is publishable with its duties attached', r.outcome === 'publishable' && r.entry.section === 'D' && r.entry.duties && r.entry.duties_basis.method === 'agent' && r.duties.added === true, JSON.stringify({ o: r.outcome, reason: r.reason, d: r.duties, c: r.verdicts.map((x) => x.code_checks.filter((c) => !c.passed)) }));
  ok('the published entry with duties passes the entry schema', r.entry && v.check('entry', r.entry).length === 0, r.entry && v.check('entry', r.entry).join('; '));
  const r2 = await go([bad((d) => { d.penalties.quote = 'fined $9 per day'; })(), bad((d) => { d.penalties.quote = 'fined $9 per day'; })()]);
  ok('when a duty cannot be proved the bill is still publishable, without duties, and the result says why', r2.outcome === 'publishable' && !r2.entry.duties && !r2.entry.duties_basis && r2.duties.added === false && r2.duties.dropped.join() === 'penalties' && v.check('entry', r2.entry).length === 0, JSON.stringify(r2.duties));
}

console.log(`duty step: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
