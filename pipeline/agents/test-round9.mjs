// Round 9 regressions (Tier B new entries; the 29 Oct 2026 paid field eval). Code only, no AI.
//   node agents/test-round9.mjs
import { repairExponents, digitRuns, provedQuote, containsQuote } from './source-text.mjs';
import { textProblems, normaliseExponents, thresholdNumberProblems } from './checks.mjs';
import { refereeVerdict, refereeSection, processItem, selectionOf } from './process-item.mjs';
import { SCOPE_DEFINITION } from './prompts.mjs';
import { adoptedAmendments, withAmendments } from '../grabber/sources/legiscan.mjs';
import { SECTION_CHARS } from './sections.mjs';

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
  ok('2 two exact passages joined by an ellipsis are refused (independent review: joined parts can change the meaning)', provedQuote(t, 'A large developer shall publish a safety ... report critical safety incidents to the attorney general') === null);
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
  ok('4 testing duties on every AI company with no threshold are OUT (NJ S 1802)', /on every AI company or every AI system, with no frontier, compute or capability threshold and no catastrophic-risk aim, are OUT/.test(SCOPE_DEFINITION) && /aimed at catastrophic risk .* are type \(1\) even with no threshold/.test(SCOPE_DEFINITION));
  ok('4 but duties aimed at catastrophic risk with no threshold stay in (MN HF 4532)', /duties aimed at catastrophic risk \(critical harm, mass casualties, weapons, loss of control\) are type \(1\)/.test(SCOPE_DEFINITION));
}

// ---------- 5. Minnesota "page.line" numbering (MN HF 4532) ----------
{
  const mn = '3.28 Subd. 4. Safety incident disclosure. A developer must disclose each safety incident\n3.29 affecting the artificial intelligence model to the attorney general within 72 hours of the date\n3.30 the developer learns of the safety incident or within 72 hours of the date the developer learns\n3.31 sufficient facts to establish a reasonable belief that a safety incident has occurred.';
  ok('5 a quote across a page.line break matches', containsQuote(mn, 'to the attorney general within 72 hours of the date the developer learns of the safety incident'));
  ok('5 a quote that copied the page.line number matches', containsQuote(mn, 'within 72 hours of the date 3.30 the developer learns'));
  ok('5 a paraphrase still does not', !containsQuote(mn, 'must tell the attorney general within 72 hours'));
  ok('5 a decimal figure is never taken for a line number', !containsQuote('A fee of 3.5 percent applies. A rate of 3.6 percent applies.', 'A fee of percent applies'));
}

// ---------- 6. amendments adopted since the text was printed (IL HB 3506) ----------
{
  const bill = { texts: [{ doc_id: 1, date: '2025-02-07', mime: 'text/html' }],
    amendments: [{ amendment_id: 11, title: 'House Amendment 001', chamber: 'H', date: '2025-03-18', adopted: 0 }, { amendment_id: 12, title: 'House Amendment 002', chamber: 'H', date: '2025-04-08', adopted: 0 }],
    history: [{ chamber: 'H', action: 'House Committee Amendment No. 1 Adopted in Cybersecurity, Data Analytics, & IT Committee; 007-004-000' }, { chamber: 'H', action: 'House Floor Amendment No. 2 Filed with Clerk' }, { chamber: 'H', action: 'House Floor Amendment No. 2 Rule 19(c) / Re-referred to Rules Committee' }] };
  const a = adoptedAmendments(bill);
  ok('6 an amendment the history says was adopted counts though LegiScan says not; a filed one does not', a.length === 1 && a[0].amendment_id === 11, JSON.stringify(a));
  ok('6 one adopted then tabled does not count', adoptedAmendments({ ...bill, history: [...bill.history, { chamber: 'H', action: 'House Committee Amendment No. 1 Tabled' }] }).length === 0);
  ok('6 another chamber\'s "Amendment No. 1" does not count', adoptedAmendments({ ...bill, history: [{ chamber: 'S', action: 'Senate Committee Amendment No. 1 Adopted' }] }).length === 0);
  ok('6 an amendment older than the newest text is already in it', adoptedAmendments({ ...bill, texts: [{ doc_id: 2, date: '2025-05-01', mime: 'text/html' }] }).length === 0);
  ok('6 LegiScan\'s own adopted flag counts', adoptedAmendments({ ...bill, history: [], amendments: [{ ...bill.amendments[1], adopted: 1 }] }).length === 1);
  const t = withAmendments('BILL TEXT', [{ title: 'House Amendment 001', date: '2025-03-18', text: 'AMENDMENT TEXT' }]);
  ok('6 the amendment follows the bill text under a header saying it changes it', /^BILL TEXT\n\nADOPTED AMENDMENT: House Amendment 001 \(dated 2025-03-18\)\. It changes the bill text above/.test(t) && t.endsWith('AMENDMENT TEXT'));
  ok('6 one not read is named, not dropped', /ADOPTED AMENDMENT NOT READ: X/.test(withAmendments('B', [{ title: 'X', date: 'd', text: null }])));
  const trap = { calls: 0, async generate() { this.calls++; throw new Error('AI must not be called'); } };
  const raw = { bill: { bill_id: 1, state: 'IL', bill_number: 'HB1', title: 'Test', status: 1, history: [], sponsors: [], texts: [] }, text: withAmendments('A frontier developer shall publish a safety plan.', [{ title: 'House Amendment 001', date: '2025-03-18', text: null }]) };
  const item = { item_id: 'legiscan:IL-HB1', source: 'legiscan', source_id: '1', source_url: 'https://legiscan.com/IL/bill/HB1/2025', fetched_at: '2026-10-30T00:00:00Z' };
  const out = await processItem({ generator: trap, validator: trap, referee: trap, item, raw, diff: { item_id: item.item_id, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'x' }] }, entries: [], today: '2026-10-30', runId: 't' });
  ok('6 a new bill whose adopted amendment could not be read is held, no AI spent', out.outcome === 'held' && /amendment was adopted since/.test(out.reason) && trap.calls === 0, `${out.outcome} ${out.reason}`);
  const raw2 = { ...raw, text: withAmendments('A frontier developer shall publish a safety plan.', [{ title: 'House Amendment 001', date: '2025-03-18', text: 'Amend by deleting the safety plan.' }]) };
  const out2 = await processItem({ generator: trap, validator: trap, referee: trap, item, raw: raw2, diff: { item_id: item.item_id, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'x' }] }, entries: [], today: '2026-10-30', runId: 't' });
  ok('6 a new bill with ANY adopted amendment not yet printed is held (struck words would still pass the quote check), no AI spent', out2.outcome === 'held' && /amendment was adopted since/.test(out2.reason) && trap.calls === 0, `${out2.outcome} ${out2.reason}`);
  ok('6 "Motion to Table Amendment No. 1 - Lost" leaves it adopted', adoptedAmendments({ ...bill, history: [...bill.history, { chamber: 'H', action: 'Motion to Table Committee Amendment No. 1 - Lost' }] }).length === 1);
}

// ---------- 7. a long bill's frontier sections are read together, not cut ----------
{
  ok('7 a selection may hold 160,000 characters', SECTION_CHARS === 160000);
  const sec = (n, body) => `Sec. ${n}. ${body}\n`;
  const filler = Array.from({ length: 60 }, (_, i) => sec(i + 1, 'The department shall maintain highway signage and roadside facilities. '.repeat(40))).join('');
  const frontier = Array.from({ length: 30 }, (_, i) => sec(100 + i, `A large frontier developer shall publish a frontier AI framework and report each critical safety incident (${i}). `.repeat(30))).join('');
  const sel = selectionOf(filler + frontier);
  ok('7 a 110,000-character run of frontier sections in a long bill is read whole', sel && sel.text.length > 100000 && /\(29\)/.test(sel.text) && !/highway signage/.test(sel.text), sel && String(sel.text.length));
}

// ---------- 8. spelled-out exponent; the referee asked again after an unusable answer ----------
{
  ok('8 CT P.A. 26-15 "ten to the twen ty - sixth power" is 10^26', repairExponents('greater than ten to the twen ty - sixth power integer or') === 'greater than 10^26 integer or');
  ok('8 "ten to the sixth power" (not a compute figure) is left alone', repairExponents('ten to the sixth power') === 'ten to the sixth power');
  const t = '"Frontier model" means a model trained using greater than 10^26 integer or floating-point operations. A large developer shall publish a safety and security protocol.';
  let n = 0;
  const flaky = { async generate() { n++; if (n === 1) { const { LlmOutputError } = await import('../llm/gemini.mjs'); throw new LlmOutputError('the model did not return valid JSON'); } return { data: { results: [{ n: 1, supported: true, quote: 'A large developer shall publish a safety and security protocol', reason: null }] }, usage: {} }; } };
  const v = await refereeVerdict(flaky, t, 'x');
  ok('8 an unusable referee answer is asked once more, and a good second answer counts', v.in === true && n === 2, JSON.stringify(v));
  let m = 0;
  const broken = { async generate() { m++; const { LlmOutputError } = await import('../llm/gemini.mjs'); throw new LlmOutputError('the model did not return valid JSON'); } };
  const w = await refereeVerdict(broken, t, 'x');
  ok('8 two unusable answers: not confirmed (held), with the reason, and no third call', w.in === null && /unusable/.test(w.why) && m === 2);
}

console.log(`round 9: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
