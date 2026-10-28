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
import { relevantSections, SECTION_CHARS } from '../agents/sections.mjs';

export const MAX_SOURCE_CHARS = 110000; // longer texts are read section by section (agents/sections.mjs)
const LIMIT = { mechanism: 700, thresholds: 500, penalties: 500 };
// Many hand-written fields are already longer than a new entry may be (35 mechanisms over 650 characters): a fix may add up to 200.
export const limitFor = (f, old) => Math.max(LIMIT[f], String(old || '').length + 200);
// A statement about what the bill leaves out ("no compute threshold is set", "the bill does not define"): nobody can check absence.
const ABSENCE = /\bno\s+(?:numeric\s+|specific\s+|explicit\s+)?[a-z ,/-]{0,50}?(?:thresholds?|figures?|penalt(?:y|ies)|deadlines?|definitions?|amounts?)\s+(?:is|are)\s+(?:set|stated|specified|given|provided|defined|established)|\b(?:does|do)\s+not\s+(?:set|state|specify|define|include|provide|establish)\b|\bnot\s+(?:set|stated|specified)\s+(?:in|by)\s+the\s+(?:bill|text|source)|\bnot\s+a\s+(?:statutory|numeric|specific)\b|\bno\s+(?:statutory|numeric)\b/i;
const DEBRIS =/[{}]|['"][a-z_]{3,}['"]\s*:|['"],\s*['"]|```|\\n|\\u[0-9a-f]{4}/i;

// The fields one entry's correction may touch. Penalties have their own field only in section A; elsewhere they live in the mechanism.
export const fieldsFor = (e) => ['mechanism', 'thresholds', ...(e.section === 'A' || e.penalties ? ['penalties'] : [])];

// Plain-code checks on one proposed correction. Returns readable problems; empty means it may go to the confirmer.
export function checkCorrection({ c, entry, fields, source }) {
  const p = [], f = c && c.field, old = entry[f] == null ? '' : String(entry[f]), v = String((c && c.new_text) || '').trim();
  if (!fields.includes(f)) return [`field "${f}" may not be corrected`];
  if (!v) return [`no new text for ${f}`];
  if (norm(v) === norm(old)) return [`the new ${f} is the same as the current one`];
  if (v.length > limitFor(f, old)) p.push(`${f} is ${v.length} characters, over ${limitFor(f, old)}`);
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
  if (ABSENCE.test(v) && !ABSENCE.test(old)) p.push(`it states what the bill does not contain ("${v.match(ABSENCE)[0]}"): say only what SOURCE states`);
  p.push(...droppedFacts({ c, old, v }));
  return p;
}

// Nothing true may be lost. An omission fix keeps every figure and every quoted defined term of the current text; an error fix may drop a
// figure only when its stated problem names that figure as the wrong one. (A live run on 28 Oct 2026 rewrote the CT entry and dropped its
// 10^26 and $500M definitions while adding true facts; every added fact checked out, so only this check catches that.)
const TERM = /[“"]([^”"]{3,80})[”"]/g;
// "$500M", "$500 million" and "$500,000,000" are one figure: amounts are written out in full before figures are compared.
const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };
export const expandAmounts = (s) => String(s || '').replace(/(\d+(?:\.\d+)?)\s*(thousand|million|billion|trillion|mn|bn|[kmbt])\b/gi, (m, n, u) => String(Math.round(Number(n) * SCALE[u.toLowerCase()])));
const figures = (s) => new Set([...digitRuns(s), ...digitRuns(expandAmounts(String(s || '').replace(/(\d),(?=\d{3}\b)/g, '$1')))]);
export function droppedFacts({ c, old, v }) {
  const out = [], now = figures(v), named = figures(String((c && c.problem) || ''));
  const lost = [...digitRuns(expandAmounts(old))].filter((n) => n.length > 1 && !now.has(n) && !(c.kind === 'error' && named.has(n)));
  if (lost.length) out.push(`the new text drops figures the current text has: ${lost.join(', ')}; keep every fact that is not wrong${c.kind === 'error' ? ', and name a figure in the problem if it is the wrong one' : ''}`);
  const terms = [...old.matchAll(TERM)].map((m) => m[1]).filter((t) => !norm(v).includes(norm(t)) && !(c.kind === 'error' && norm(String(c.problem || '')).includes(norm(t))));
  if (terms.length) out.push(`the new text drops defined terms the current text has: "${terms.slice(0, 3).join('", "')}"`);
  return out;
}

// reviewer, confirmer: AI clients (generate({ system, prompt, itemId }) -> { data }). text: the bill's official text; url: where it is.
// otherBills: the entry's other bill numbers (SOURCE is one bill's text). Returns
//   { outcome: 'clean' | 'corrected' | 'rejected' | 'too_long' | 'error', corrections: [...], rejected: [...], reason }
// 'rejected' = the reader proposed something but none of it survived; the entry is retried on a later run.
export async function reviewEntry({ reviewer, confirmer, entry, text, url, otherBills = [], log = () => {} }) {
  const itemId = 'correct:' + entry.key, fields = fieldsFor(entry);
  const out = { outcome: 'clean', corrections: [], rejected: [], reason: null };
  // A longer text (an omnibus bill) is read section by section: the models see only its frontier-AI sections, copied word for word,
  // and every code check below still runs on the FULL text. With no such section found it stays too long.
  let read = text;
  if (text.length > MAX_SOURCE_CHARS) {
    const sel = relevantSections(text, { maxChars: SECTION_CHARS });
    if (!sel.chunks.length) return { ...out, outcome: 'too_long', reason: `the text is ${text.length} characters and no section about frontier AI was found in it` };
    read = sel.text; log(`${entry.key}: text is ${text.length} characters; reading ${sel.selected.length} sections (${read.length} characters)`);
  }
  try {
    let r;
    try { r = await reviewer.generate({ system: REVIEWER_SYSTEM, prompt: reviewerPrompt({ entry, fields, source: read, url, otherBills }), itemId }); }
    catch (e) { if (e instanceof LlmOutputError) return { ...out, outcome: 'error', reason: `the reader gave an unusable answer: ${e.message}` }; throw e; }
    const proposed = ((r.data && r.data.corrections) || []).filter((c) => c && typeof c === 'object');
    const seen = new Set(), failed = [];
    for (const c of proposed) {
      if (seen.has(c.field)) { out.rejected.push({ field: c.field, problem: c.problem || '', why: 'a second correction for the same field' }); continue; }
      seen.add(c.field);
      const problems = checkCorrection({ c, entry, fields, source: text });
      if (problems.length) { failed.push({ c, problems }); continue; }
      await confirm(c);
    }
    // One rewrite: the reader gets code's exact complaints (usually length) for the fields that failed, and tries once more.
    if (failed.length) {
      let again = [];
      try {
        const r2 = await reviewer.generate({ system: REVIEWER_SYSTEM, prompt: reviewerPrompt({ entry, fields, source: read, url, otherBills }) + `\n\nYOUR PREVIOUS CORRECTIONS WERE REFUSED BY CODE. Return corrected versions of ONLY these fields, fixing exactly these problems (or leave a field out if it cannot be fixed):\n${failed.map((f) => `- ${f.c.field}: ${f.problems.join('; ')}\n  your text was: ${String(f.c.new_text || '').slice(0, 1200)}`).join('\n')}`, itemId: itemId + ':rewrite' });
        again = ((r2.data && r2.data.corrections) || []).filter((c) => c && typeof c === 'object');
      } catch (e) { if (!(e instanceof LlmOutputError)) throw e; }
      for (const f of failed) {
        const c = again.find((x) => x.field === f.c.field);
        const problems = c ? checkCorrection({ c, entry, fields, source: text }) : f.problems;
        if (problems.length) { out.rejected.push({ field: f.c.field, problem: f.c.problem || '', why: 'code check: ' + problems.join('; ') }); log(`${entry.key} ${f.c.field}: rejected by code (${problems[0]})`); continue; }
        await confirm(c);
      }
    }
  } catch (e) {
    // One entry can fail without stopping the step: a too-long prompt or a model outage leaves it for a later run.
    if (e instanceof InputTooLarge) return { ...out, outcome: 'too_long', reason: e.message };
    if (e instanceof HttpError || e instanceof NetworkError) return { ...out, outcome: 'error', service_error: true, reason: `the model service failed: ${String(e.message).slice(0, 160)}` };
    throw e;
  }
  out.outcome = out.corrections.length ? 'corrected' : out.rejected.length ? 'rejected' : 'clean';
  return out;

  // The confirmer's turn for one correction that passed code.
  async function confirm(c) {
    let v;
    // Each confirmation is its own item for the per-item token budget: a long bill sends its whole text once per proposed field.
    try { v = await confirmer.generate({ system: CONFIRMER_SYSTEM, prompt: confirmerPrompt({ source: read, field: c.field, current: entry[c.field], proposed: c.new_text.trim(), problem: c.problem || '' }), itemId: `${itemId}:${c.field}` }); }
    catch (e) { if (!(e instanceof LlmOutputError)) throw e; out.rejected.push({ field: c.field, problem: c.problem || '', why: `the confirmer gave an unusable answer (${e.message})` }); return; }
    const d = v.data || {};
    if (d.confirmed !== true) { out.rejected.push({ field: c.field, problem: c.problem || '', why: 'not confirmed: ' + String(d.reason || 'no reason given').slice(0, 300) }); log(`${entry.key} ${c.field}: not confirmed`); return; }
    if (d.quote && !containsQuote(text, d.quote)) { out.rejected.push({ field: c.field, problem: c.problem || '', why: "the confirmer's quote is not in the source" }); return; }
    out.corrections.push({ field: c.field, kind: c.kind === 'omission' ? 'omission' : 'error', problem: String(c.problem || '').slice(0, 400), old: entry[c.field] == null ? null : entry[c.field], new: c.new_text.trim(), evidence: c.evidence.filter((x) => x && x.quote).map((x) => x.quote), confirmer_quote: d.quote || null, url });
    log(`${entry.key} ${c.field}: confirmed (${c.kind})`);
  }
}
