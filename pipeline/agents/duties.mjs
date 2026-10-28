// The duty step for a NEW entry: after the entry itself has passed, the Generator answers the 13 duties of entry.schema.json "duties"
// from the same official text, and each answer is proved before it is kept:
//   1) code (duties/check.mjs checkAnswer): format, quote found word for word, every number in the text, the section's numbers in the text
//   2) the independent reader (role validator) confirms every yes / partial / no answer, with its own quote checked word for word
// The schema has no "unknown" answer (not_in_bill claims the text is silent, which nobody proved), so a failed answer cannot be blanked:
// after one round of feedback, if any answer still fails the whole duties object is left off the entry. Never an unverified duty.
import { DUTIES_SYSTEM, dutiesPrompt, dutyClaim, DUTY_NAMES } from './duties-prompt.mjs';
import { VALIDATOR_SYSTEM, validatorPrompt } from './prompts.mjs';
import { containsQuote } from './source-text.mjs';
import { checkAnswer, checkDuties } from '../duties/check.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { sha } from '../grabber/lib/run-common.mjs';
import { LlmOutputError, InputTooLarge, BudgetExceeded } from '../llm/gemini.mjs';
import { HttpError, NetworkError } from '../grabber/lib/http.mjs';

export const DUTY_ROUNDS = 2;
export const DUTY_SECTIONS = ['D', 'F']; // bills; only bills impose duties (the session-written duties are all on bills)
const schema = makeValidator();

// Code knows the URL the text came from: every answer that quotes gets it, and a silence answer carries no section, quote or URL.
export function normaliseDuties(duties, sourceUrl) {
  const out = {};
  for (const k of DUTY_NAMES) {
    const d = duties && duties[k];
    if (!d || typeof d !== 'object') continue;
    const a = { value: d.value, summary: typeof d.summary === 'string' ? d.summary.trim() : d.summary };
    if (d.value !== 'not_in_bill') { if (d.section != null) a.section = String(d.section).trim(); if (d.quote != null) a.quote = d.quote; a.source_url = sourceUrl; }
    out[k] = a;
  }
  return out;
}

// The reader's verdict on every answer that asserts something. Returns { name: problem } for each one it did not confirm.
export async function confirmDuties({ llm, sourceText, duties, itemId }) {
  const list = DUTY_NAMES.filter((k) => duties[k] && duties[k].value !== 'not_in_bill').map((k) => ({ field: k, claim: dutyClaim(k, duties[k]) }));
  const rejected = {};
  if (!list.length) return rejected;
  let res;
  try { res = await llm.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: sourceText, claims: list }), itemId }); }
  catch (e) {
    if (!(e instanceof LlmOutputError)) throw e;
    list.forEach((c) => { rejected[c.field] = `the independent reader gave an unusable answer (${e.message}); treated as unsupported`; });
    return rejected;
  }
  const byN = new Map(((res && res.data && res.data.results) || []).map((r) => [r.n, r]));
  list.forEach((c, i) => {
    const r = byN.get(i + 1);
    if (!r) rejected[c.field] = 'the independent reader did not answer for this duty';
    else if (r.supported !== true) rejected[c.field] = `the independent reader rejected it: ${r.reason || 'not supported by the source'}`;
    else if (!containsQuote(sourceText, r.quote)) rejected[c.field] = 'the reader marked it supported but its quote does not appear in the source';
  });
  return rejected;
}

// One round: ask, normalise, check every answer in code and with the reader. Returns { duties, problems: { name: [problem] }, notes }.
async function dutyRound({ generator, validator, entry, sourceText, sourceUrl, itemId, feedback, previous }) {
  let res;
  try { res = await generator.generate({ system: DUTIES_SYSTEM, prompt: dutiesPrompt({ entry, source: sourceText, sourceUrl, feedback, previous }), itemId }); }
  catch (e) { if (e instanceof LlmOutputError) return { duties: null, problems: { answer: [`your answer was unusable: ${e.message}`] } }; throw e; }
  const data = res && res.data;
  if (!data || typeof data !== 'object' || !data.duties || typeof data.duties !== 'object') return { duties: null, problems: { answer: ['your answer had no "duties" object'] } };
  const duties = normaliseDuties(data.duties, sourceUrl), problems = {};
  const add = (k, p) => { (problems[k] = problems[k] || []).push(p); };
  for (const k of DUTY_NAMES) {
    if (!duties[k]) { add(k, `${k}: missing; all 13 duties must be answered`); continue; }
    checkAnswer(k, duties[k], sourceText, { sourceUrl }).forEach((p) => add(k, p));
  }
  Object.keys(data.duties).filter((k) => !DUTY_NAMES.includes(k)).forEach((k) => add(k, `${k}: not one of the 13 duties`));
  // Only answers that passed the code checks go to the reader; a failed one is already out.
  const passed = Object.fromEntries(DUTY_NAMES.filter((k) => duties[k] && !problems[k]).map((k) => [k, duties[k]]));
  const rejected = await confirmDuties({ llm: validator, sourceText, duties: passed, itemId });
  Object.entries(rejected).forEach(([k, why]) => add(k, `${k}: ${why}`));
  return { duties, problems };
}

// Returns { duties, duties_basis } to put on the entry, or { duties: null } with the reason; dropped lists the answers that failed.
export async function writeDuties({ generator, validator, entry, sourceText, sourceUrl, itemId, now = new Date(), maxRounds = DUTY_ROUNDS, log = () => {} }) {
  let feedback = [], previous = null, last = null;
  try {
    for (let round = 1; round <= maxRounds; round++) {
      const r = await dutyRound({ generator, validator, entry, sourceText, sourceUrl, itemId, feedback, previous });
      last = r;
      const failed = Object.keys(r.problems);
      log(`duties round ${round}: ${failed.length ? failed.length + ' answer(s) failed' : 'every answer proved'}`);
      if (!failed.length) {
        // The whole set once more, as duties/check.mjs checks a session draft, and the entry with it against the entry schema.
        const whole = checkDuties(r.duties, sourceText, { sourceUrl });
        const duties_basis = { source_url: sourceUrl, sha256: sha(sourceText), chars: sourceText.length, method: 'agent', checked_at: now.toISOString().replace(/\.\d+Z$/, 'Z') };
        const errs = whole.concat(schema.check('entry', { ...entry, duties: r.duties, duties_basis }).map((m) => 'entry schema: ' + m));
        if (errs.length) return { duties: null, dropped: [], rounds: round, reason: `the duty set failed its final check: ${errs[0]}` };
        if (DUTY_NAMES.every((k) => r.duties[k].value === 'not_in_bill')) return { duties: null, dropped: [], rounds: round, reason: 'every answer was not_in_bill; nothing the text states was found to record' };
        return { duties: r.duties, duties_basis, dropped: [], rounds: round, reason: null };
      }
      feedback = Object.values(r.problems).flat(); previous = r.duties;
    }
  } catch (e) {
    // The entry itself has passed: a failing model service or a spent item budget costs only the duties, never the entry.
    if (e instanceof HttpError || e instanceof NetworkError || e instanceof InputTooLarge || (e instanceof BudgetExceeded && e.scope === 'item')) return { duties: null, dropped: [], rounds: 0, reason: `the duty step could not run: ${String(e.message).slice(0, 160)}` };
    throw e;
  }
  const dropped = Object.keys(last.problems);
  return { duties: null, dropped, rounds: maxRounds, reason: `left off: ${dropped.length} answer(s) still unproved after ${maxRounds} rounds and the schema has no "unknown" answer (${Object.values(last.problems).flat()[0].slice(0, 200)})` };
}
