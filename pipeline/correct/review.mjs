// One entry through the self-correction loop: the reader lists errors and omissions -> code checks each proposed field ->
// the confirmer (a stronger model) must agree -> the correction is returned for apply.mjs. Nothing is written here.
// Only reading fields can change (mechanism, thresholds, and penalties in section A, where that field is used); everything the
// official record states exactly (title, sponsor, status, dates, events) is code's and is never touched.
import { REVIEWER_SYSTEM, reviewerPrompt, CONFIRMER_SYSTEM, confirmerPrompt } from './prompts.mjs';
import { textProblems, foreignLetters } from '../agents/checks.mjs';
import { containsQuote, digitRuns, norm } from '../agents/source-text.mjs';
import { NEGATIVE_FINDING } from '../agents/rules.mjs';
import { LlmOutputError, InputTooLarge } from '../llm/gemini.mjs';
import { HttpError, NetworkError } from '../grabber/lib/http.mjs';

export const MAX_SOURCE_CHARS = 110000; // longer texts wait for section-by-section reading
const LIMIT = { mechanism: 700, thresholds: 500, penalties: 500 };
const DEBRIS = /[{}]|['"][a-z_]{3,}['"]\s*:|['"],\s*['"]|```|\\n|\\u[0-9a-f]{4}/i;

// The fields one entry's correction may touch. Penalties have their own field only in section A; elsewhere they live in the mechanism.
export const fieldsFor = (e) => ['mechanism', 'thresholds', ...(e.section === 'A' || e.penalties ? ['penalties'] : [])];

// Plain-code checks on one proposed correction. Returns readable problems; empty means it may go to the confirmer.
export function checkCorrection({ c, entry, fields, source }) {
  const p = [], f = c && c.field, old = entry[f] == null ? '' : String(entry[f]), v = String((c && c.new_text) || '').trim();
  if (!fields.includes(f)) return [`field "${f}" may not be corrected`];
  if (!v) return [`no new text for ${f}`];
  if (norm(v) === norm(old)) return [`the new ${f} is the same as the current one`];
  if (v.length > LIMIT[f]) p.push(`${f} is ${v.length} characters, over ${LIMIT[f]}`);
  const ev = (c.evidence || []).filter((x) => x && x.quote);
  if (!ev.length) p.push('no evidence quote');
  ev.filter((x) => !containsQuote(source, x.quote)).forEach((x) => p.push(`quote not in the source: "${String(x.quote).slice(0, 60)}"`));
  ev.filter((x) => String(x.quote).trim().length < 8).forEach((x) => p.push(`quote too short: "${x.quote}"`));
  const src = digitRuns(source), prev = digitRuns(old);
  const bad = [...digitRuns(v)].filter((n) => n.length > 1 && !src.has(n) && !prev.has(n));
  if (bad.length) p.push(`numbers not in the source: ${bad.join(', ')}`);
  // The text rules (dates with years, no garbled exponents, real quotations): a problem the current text already had is not the correction's fault.
  const before = new Set(textProblems(f, old, source));
  textProblems(f, v, source).filter((x) => !before.has(x)).forEach((x) => p.push(x));
  if (DEBRIS.test(v)) p.push('stray code or JSON syntax in the text');
  if (foreignLetters(v, source)) p.push('letters the source does not use');
  if (NEGATIVE_FINDING.test(v) && !NEGATIVE_FINDING.test(old)) p.push('a "none located" style claim');
  return p;
}

// reviewer, confirmer: AI clients (generate({ system, prompt, itemId }) -> { data }). text: the bill's official text; url: where it is.
// otherBills: the entry's other bill numbers (SOURCE is one bill's text). Returns
//   { outcome: 'clean' | 'corrected' | 'rejected' | 'too_long' | 'error', corrections: [...], rejected: [...], reason }
// 'rejected' = the reader proposed something but none of it survived; the entry is retried on a later run.
export async function reviewEntry({ reviewer, confirmer, entry, text, url, otherBills = [], log = () => {} }) {
  const itemId = 'correct:' + entry.key, fields = fieldsFor(entry);
  const out = { outcome: 'clean', corrections: [], rejected: [], reason: null };
  if (text.length > MAX_SOURCE_CHARS) return { ...out, outcome: 'too_long', reason: `the text is ${text.length} characters; it waits for section-by-section reading` };
  try {
    let r;
    try { r = await reviewer.generate({ system: REVIEWER_SYSTEM, prompt: reviewerPrompt({ entry, fields, source: text, url, otherBills }), itemId }); }
    catch (e) { if (e instanceof LlmOutputError) return { ...out, outcome: 'error', reason: `the reader gave an unusable answer: ${e.message}` }; throw e; }
    const proposed = ((r.data && r.data.corrections) || []).filter((c) => c && typeof c === 'object');
    const seen = new Set();
    for (const c of proposed) {
      if (seen.has(c.field)) { out.rejected.push({ field: c.field, problem: c.problem || '', why: 'a second correction for the same field' }); continue; }
      seen.add(c.field);
      const problems = checkCorrection({ c, entry, fields, source: text });
      if (problems.length) { out.rejected.push({ field: c.field, problem: c.problem || '', why: 'code check: ' + problems.join('; ') }); log(`${entry.key} ${c.field}: rejected by code (${problems[0]})`); continue; }
      let v;
      // Each confirmation is its own item for the per-item token budget: a long bill sends its whole text once per proposed field.
      try { v = await confirmer.generate({ system: CONFIRMER_SYSTEM, prompt: confirmerPrompt({ source: text, field: c.field, current: entry[c.field], proposed: c.new_text.trim(), problem: c.problem || '' }), itemId: `${itemId}:${c.field}` }); }
      catch (e) { if (!(e instanceof LlmOutputError)) throw e; out.rejected.push({ field: c.field, problem: c.problem || '', why: `the confirmer gave an unusable answer (${e.message})` }); continue; }
      const d = v.data || {};
      if (d.confirmed !== true) { out.rejected.push({ field: c.field, problem: c.problem || '', why: 'not confirmed: ' + String(d.reason || 'no reason given').slice(0, 300) }); log(`${entry.key} ${c.field}: not confirmed`); continue; }
      if (d.quote && !containsQuote(text, d.quote)) { out.rejected.push({ field: c.field, problem: c.problem || '', why: "the confirmer's quote is not in the source" }); continue; }
      out.corrections.push({ field: c.field, kind: c.kind === 'omission' ? 'omission' : 'error', problem: String(c.problem || '').slice(0, 400), old: entry[c.field] == null ? null : entry[c.field], new: c.new_text.trim(), evidence: c.evidence.filter((x) => x && x.quote).map((x) => x.quote), confirmer_quote: d.quote || null, url });
      log(`${entry.key} ${c.field}: confirmed (${c.kind})`);
    }
  } catch (e) {
    // One entry can fail without stopping the step: a too-long prompt or a model outage leaves it for a later run.
    if (e instanceof InputTooLarge) return { ...out, outcome: 'too_long', reason: e.message };
    if (e instanceof HttpError || e instanceof NetworkError) return { ...out, outcome: 'error', service_error: true, reason: `the model service failed: ${String(e.message).slice(0, 160)}` };
    throw e;
  }
  out.outcome = out.corrections.length ? 'corrected' : out.rejected.length ? 'rejected' : 'clean';
  return out;
}
