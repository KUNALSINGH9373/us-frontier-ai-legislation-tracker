// Round 9 regressions (Tier B new entries; the 29 Oct 2026 paid field eval). Code only, no AI.
//   node agents/test-round9.mjs
import { repairExponents, digitRuns, provedQuote } from './source-text.mjs';
import { textProblems, normaliseExponents, thresholdNumberProblems } from './checks.mjs';
import { refereeVerdict, refereeSection } from './process-item.mjs';
import { SCOPE_DEFINITION } from './prompts.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const scripted = (queue) => ({ calls: 0, async generate() { this.calls++; const r = queue.shift(); if (!r) throw new Error('unexpected AI call'); return { data: typeof r === 'function' ? r() : r, usage: {} }; } });

// ---------- 1. numbers misread from printed bills ----------
{
  const pa = '(1) A foundation model that was trained using a\ncomputing power greater than 1,026 integer or floating-point\noperations.';
  ok('1 PA HB 2800 "1,026 integer or floating-point operations" is the bill\'s 10^26', /greater than 10\^26 integer/.test(repairExponents(pa)), repairExponents(pa));
  ok('1 a writer\'s "1,026 operations" is normalised and flagged until then', normaliseExponents('more than 1,026 operations') === 'more than 10^26 operations' && thresholdNumberProblems('t', 'more than 1,026 operations').some((p) => /lost exponent/.test(p)));
  ok('1 "1,026" still reads as the runs 10 and 26 for the numbers check', digitRuns(pa).has('10') && digitRuns(pa).has('26'));
  ok('1 a year or count before "operations" is untouched', repairExponents('in 2026 operations began; 1,025 operations were logged') === 'in 2026 operations began; 1,025 operations were logged');
  const il = 'collectively have an annual revenue of at least $500,000,000.8 "Minor" means; at least $25,000,000.5 "Large';
  const fixed = repairExponents(il);
  ok('1 IL HB 4705: a line number glued onto an amount is split off', !/\.8|\.5/.test(fixed) && /\$500,000,000\. +"Minor"/.test(fixed), fixed);
  ok('1 real cents are kept', repairExponents('a fee of $1,000.50 per day and $2,500.00. The') === 'a fee of $1,000.50 per day and $2,500.00. The');
  ok('1 a draft with "$500,000,000.8" is refused', textProblems('thresholds', 'annual revenue of at least $500,000,000.8 with affiliates', il).some((p) => /stray digit/.test(p)));
  ok('1 a draft with "$1,000.50" is not', !textProblems('penalties', 'a fee of $1,000.50 per day', 'a fee of $1,000.50 per day').some((p) => /stray digit/.test(p)));
}

// ---------- 2. a quote as proof, tidied ----------
{
  const t = 'Sec. 2. A large developer shall publish a safety and security protocol. The developer shall report critical safety incidents to the attorney general.';
  ok('2 an exact quote stands', provedQuote(t, 'A large developer shall publish a safety and security protocol') === 'A large developer shall publish a safety and security protocol');
  ok('2 wrapping quotation marks and a closing full stop are dropped', provedQuote(t, '"A large developer shall publish a safety and security protocol."') === 'A large developer shall publish a safety and security protocol');
  ok('2 two exact passages joined by an ellipsis: the longest is kept', provedQuote(t, 'A large developer shall publish a safety ... report critical safety incidents to the attorney general') === 'report critical safety incidents to the attorney general');
  ok('2 an ellipsis with any part not in the source is refused', provedQuote(t, 'shall publish a safety and security protocol ... report harms to the governor at once') === null);
  ok('2 an ellipsis with a short part is refused', provedQuote(t, 'shall publish a safety and security protocol ... the attorney') === null);
  ok('2 a paraphrase is refused', provedQuote(t, 'publish a protocol for safety') === null && provedQuote(t, '') === null);
}

// ---------- 3. the referee gets one retry for an exact quote ----------
{
  const t = '"Frontier model" means an artificial intelligence model trained using a quantity of computing power greater than 10^26 integer or floating-point operations. A large developer shall publish a safety and security protocol.';
  const bad = { results: [{ n: 1, supported: true, quote: 'a large developer must publish its safety protocol', reason: null }] };
  const good = { results: [{ n: 1, supported: true, quote: 'A large developer shall publish a safety and security protocol', reason: null }] };
  let ref = scripted([bad, good]);
  let v = await refereeVerdict(ref, t, 'x');
  ok('3 scope: a referee quote not in the source gets one retry, and an exact one confirms', v.in === true && ref.calls === 2 && /shall publish/.test(v.quote), JSON.stringify(v));
  ref = scripted([bad, bad]);
  v = await refereeVerdict(ref, t, 'x');
  ok('3 scope: still no exact quote: not confirmed (held), never ruled out, no third call', v.in === null && ref.calls === 2, JSON.stringify(v));
  ref = scripted([{ results: [{ n: 1, supported: false, quote: null, reason: 'companion chatbots only' }] }]);
  v = await refereeVerdict(ref, t, 'x');
  ok('3 scope: an "out" verdict is final, with no retry', v.in === false && ref.calls === 1);
  const secBad = { results: [{ n: 1, supported: true, quote: 'trained using computing power above 10^26 operations', reason: null }] };
  const secGood = { results: [{ n: 1, supported: true, quote: 'computing power greater than 10^26 integer or floating-point operations', reason: null }] };
  ref = scripted([secBad, secGood]);
  let s = await refereeSection(ref, t, 'B', 'x');
  ok('3 section: one retry for an exact quote, and the quote must still show the criterion', s.ok && ref.calls === 2, JSON.stringify(s));
  const t2 = `${t} The Department shall keep a public list of these reports.`;
  ref = scripted([secBad, { results: [{ n: 1, supported: true, quote: 'The Department shall keep a public list of these reports', reason: null }] }]);
  s = await refereeSection(ref, t2, 'B', 'x');
  ok('3 section: an exact retry quote without the criterion still holds it', !s.ok && /does not show/.test(s.why), JSON.stringify(s));
}

// ---------- 4. scope definition: the two field-eval mistakes are named ----------
{
  ok('4 a small-company revenue exemption on an OUT-list rule does not make it frontier (CA SB 1119)', /only exempts smaller companies from an OUT-list rule/.test(SCOPE_DEFINITION));
  ok('4 testing duties on every AI company with no threshold are OUT (NJ S 1802)', /on every AI company or every AI system, with no frontier, compute or capability threshold, are OUT/.test(SCOPE_DEFINITION));
}

console.log(`round 9: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
