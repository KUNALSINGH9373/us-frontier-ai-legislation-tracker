// A new bill through the simple build (owner, 31 Oct 2026): writer -> code checks (one retry) -> reviewer -> at most one fix round.
//   publishable   the code checks pass and the reviewer, its every finding proved by a bill quote, found nothing WRONG
//   out_of_scope  the writer rules it out, or the reviewer proves the writer's in-scope call wrong: an out-of-scope bill never gets an
//                 entry, not even a facts-only one
//   facts_only    in scope (no proved scope objection) but the description did not pass: published with official facts only
//                 (outcome "publishable", facts_only: true) and written again when its record changes
//   held          unreadable text, an unusable answer, or new entries switched off (the writer's draft is reported, not confirmed)
// The result has processItem's shape (agents/process-item.mjs), so the publisher and the run report read it unchanged.
// writeAndReview is the writing and checking alone (no entry); the eval (eval/newbill-eval.mjs) runs exactly that, so the gate measures
// what production does.
import { sourceText, readerSourceText, containsQuote } from './source-text.mjs';
import { relevantSections, markerPassages } from './sections.mjs';
import { deriveCreate } from './derive.mjs';
import { assembleEntry } from './assemble.mjs';
import { refileOf, programmeDuplicateOf } from './dedupe.mjs';
import { LlmOutputError } from '../llm/gemini.mjs';
import { SECTION_MARKERS, SECTION_CRITERIA, quoteMeetsSection } from './rules.mjs';
import { writerSystem, writerUser, checksFailed, reviewerSystem, reviewerUser, fixRound, writerSchema, expandAnswer, REVIEWER_SCHEMA, scopeJudgeSystem, scopeJudgeUser, SCOPE_JUDGE_SCHEMA } from './newbill-prompts.mjs';
import { writerProblems, readReview, itemsOf } from './newbill-checks.mjs';
import { toPatch, finishEntry, factsOnlyPatch } from './newbill-entry.mjs';

// A bill longer than this is read by its frontier-AI sections (agents/sections.mjs), copied word for word; every check still runs on the
// whole bill. The writer's system prompt is about 28,000 characters and one call may hold 200,000 (config/models.json limits).
export const READ_MAX = 150000;
const askAgainIfUnusable = async (llm, req) => { try { return await llm.generate(req); } catch (e) { if (!(e instanceof LlmOutputError)) throw e; return llm.generate(req); } };
const previousAnswer = (out) => `<previous_answer>\n${JSON.stringify(out, null, 1)}\n</previous_answer>`;

// What the models read of a cleaned bill (readerText): all of it, or its AI sections when it is very long. null = too long, none found.
export function modelText(full) {
  if (full.length <= READ_MAX) return full;
  const sel = relevantSections(full, { maxChars: READ_MAX });
  const pick = sel.chunks.length ? sel : markerPassages(full, { maxChars: READ_MAX });
  if (!pick.chunks.length) return null;
  return `NOTE: this bill is ${full.length} characters long; below are its sections that concern artificial intelligence, copied word for word.\n\n${pick.text}`;
}
export function billForModels(raw, item) {
  const text = modelText(readerSourceText(raw, item.source));
  if (text == null) return null;
  const title = deriveCreate({ item, raw }).fields.title || item.title || '';
  return { jurisdiction: item.source === 'legiscan' ? ((raw.bill && raw.bill.state) || 'State') : 'US', number: String(title).split(' — ')[0], title, text };
}

// The writing and checking of one bill, without building an entry. Returns { decision, out, problems, reason, finding, trail }, decision:
//   publish        checks pass and the reviewer found nothing WRONG (after at most one fix round)
//   facts_only     in scope, but WRONG or a check problem remains after the fix round
//   excluded       the reviewer proved the in-scope call wrong
//   out_of_scope   the writer ruled it out
//   unreadable     the writer says the text is too damaged to describe honestly
//   draft_only     review off (new entries switched off): the writer's draft only
//   unusable       an answer that is not usable, twice
export async function writeAndReview({ writer, reviewer = null, scopeJudge = null, bill, source, sections, sectionRule, itemId, reviewOn = true, log = () => {} }) {
  const trail = { writer_calls: 0, check_problems: [], reviews: [], scope_check: null };
  const write = async (extra = '') => {
    trail.writer_calls++;
    const r = await askAgainIfUnusable(writer, { system: writerSystem({ sectionRule }), prompt: writerUser(bill) + (extra ? `\n\n${extra}` : ''), itemId, responseSchema: writerSchema(sections) });
    return expandAnswer(r.data); // the compact answer (one items list, one rows list) in the shape everything reads
  };
  const review = async (out, missing = []) => {
    const note = missing.length ? `\n\nYour previous review did not list these parts as checked: ${missing.join(', ')}. Check every part, and list each one in "checked".` : '';
    const r = await askAgainIfUnusable(reviewer, { system: reviewerSystem(), prompt: reviewerUser(bill, out) + note, itemId, responseSchema: REVIEWER_SCHEMA });
    return readReview(r.data, { source, out });
  };
  // A review whose coverage is short is asked once more, naming the parts it skipped; still short, it does not count as a pass.
  const fullReview = async (out) => {
    let r = await review(out);
    if (r.missing.length) { log(`reviewer skipped ${r.missing.length} part(s); asking again`); r = await review(out, r.missing); }
    trail.reviews.push({ verdict: r.verdict, wrong: r.wrong, findings: r.findings, discarded: r.discarded.length, missing: r.missing });
    return r;
  };
  // Writer answer + its code checks, with one retry that lists the problems.
  const writeChecked = async (extra = '') => {
    let out = await write(extra), problems = writerProblems(out, { source });
    if (problems.length && out.in_scope !== false && out.readable !== false) {
      log(`writer answer failed ${problems.length} check(s); one retry`);
      trail.check_problems.push(problems);
      out = await write(`${extra ? extra + '\n\n' : ''}${previousAnswer(out)}\n\n${checksFailed(problems)}`);
      problems = writerProblems(out, { source });
    }
    if (problems.length) trail.check_problems.push(problems);
    return { out, problems };
  };
  const result = (decision, extra = {}) => ({ decision, trail, ...extra });

  let first;
  try { first = await writeChecked(); }
  catch (e) { if (e instanceof LlmOutputError) return result('unusable', { reason: `the writer gave an unusable answer twice: ${e.message}` }); throw e; }
  let { out, problems } = first;
  if (out.readable === false) return result('unreadable', { out, reason: `the bill text is too damaged to describe honestly: ${(out.text_problems || []).join('; ').slice(0, 200)}` });
  if (out.in_scope === false) return result('out_of_scope', { out, reason: out.scope_reason });
  if (!reviewOn || !reviewer) return result('draft_only', { out, problems });

  const excluded = (r) => { const f = r.findings.find((x) => x.severity === 'WRONG' && /scope/i.test(x.where)) || r.findings[0]; return result('excluded', { out, finding: f, reason: `the reviewer proved the in-scope call wrong: ${f.problem}` }); };
  // The scope check (owner, 31 Oct 2026): before the reviewer, a separate, stronger call decides scope from the bill alone. Its "in" counts
  // only with the qualifying provision's words found in the bill (asked once more if not); an "out", or an "in" it cannot prove, keeps the
  // bill out: no entry. It runs only when new entries are on (with them off nothing can publish).
  if (scopeJudge) {
    const ask = async (again = '') => (await askAgainIfUnusable(scopeJudge, { system: scopeJudgeSystem(), prompt: scopeJudgeUser(bill, out.scope_reason) + again, itemId, responseSchema: SCOPE_JUDGE_SCHEMA })).data;
    let j;
    try {
      j = await ask();
      if (j.in_scope && !(String(j.quote || '').trim().length >= 8 && containsQuote(source, j.quote))) j = await ask('\n\nYour previous answer said in scope, but its quote is not in the bill word for word. Copy the qualifying provision exactly, or say the bill is out of scope.');
    } catch (e) { if (e instanceof LlmOutputError) return result('unusable', { out, reason: `the scope check gave an unusable answer twice: ${e.message}` }); throw e; }
    const proved = j.in_scope && String(j.quote || '').trim().length >= 8 && containsQuote(source, j.quote);
    trail.scope_check = { in_scope: !!j.in_scope, proved, sec: j.sec || '', reason: j.reason || '' };
    if (!proved) return result('excluded', { out, finding: { severity: 'WRONG', where: 'scope', problem: j.in_scope ? "the scope check could not prove the bill in scope with the bill's own words" : (j.reason || 'out of scope'), bill_quote: '' }, reason: `the scope check rules it out of scope: ${(j.in_scope ? 'no qualifying provision found word for word in the bill' : j.reason || '').slice(0, 300)}` });
  }
  let r;
  try { r = await fullReview(out); }
  catch (e) { if (e instanceof LlmOutputError) return result('unusable', { out, reason: `the reviewer gave an unusable answer twice: ${e.message}` }); throw e; }
  if (r.scopeWrong) return excluded(r);
  if (!problems.length && r.verdict === 'pass' && !r.missing.length) return result('publish', { out });

  // One fix round: the reviewer's proved findings (and any check problems left) go back to the writer, then a fresh review.
  const asks = [...r.findings, ...problems.map((p) => ({ severity: 'WRONG', where: p.split(':')[0], problem: p, bill_quote: '', fix: 'see the check above' }))];
  log(`fix round: ${r.findings.length} finding(s), ${problems.length} check problem(s)`);
  let fixed;
  try { fixed = await writeChecked(fixRound(asks, out)); }
  catch (e) { if (e instanceof LlmOutputError) return result('facts_only', { out, reason: 'the writer gave an unusable answer in the fix round' }); throw e; }
  if (fixed.out.in_scope === false) return result('out_of_scope', { out: fixed.out, reason: fixed.out.scope_reason });
  if (fixed.problems.length) return result('facts_only', { out, reason: `the code checks still fail after the fix round: ${fixed.problems[0]}` });
  out = fixed.out;
  let r2;
  try { r2 = await fullReview(out); }
  catch (e) { if (e instanceof LlmOutputError) return result('facts_only', { out, reason: 'the reviewer gave an unusable answer after the fix round' }); throw e; }
  if (r2.scopeWrong) return excluded(r2);
  // The new-bills bar: zero WRONG, reviewer-checked (misleading findings do not hold an entry: quotes are shown and self-correction runs).
  if (r2.wrong === 0 && !r2.missing.length) return result('publish', { out });
  return result('facts_only', { out, reason: r2.missing.length ? `the reviewer did not check every part (${r2.missing.slice(0, 5).join(', ')})` : `the reviewer still found ${r2.wrong} WRONG finding(s): ${r2.findings.find((f) => f.severity === 'WRONG').problem.slice(0, 120)}` });
}

export async function runNewBill({ writer, reviewer = null, scopeJudge = null, item, raw, entries = [], sections, sectionRule, today, runId, now = new Date(), newEntriesOn = true, log = () => {} }) {
  const source = sourceText(raw, item.source);
  const base = { item_id: item.item_id, operation: 'create', attempts: 0, entry: null, patch: null, verdicts: [], reason: null };
  const held = (reason, extra = {}) => ({ ...base, outcome: 'held', reason, ...extra });
  const bill = billForModels(raw, item);
  if (!bill) return held(`the text is ${source.length} characters and no artificial-intelligence section was found in it; held until its record changes`, { proposal: `${item.item_id}: very long text with no AI section found; not created` });

  const w = await writeAndReview({ writer, reviewer, scopeJudge, bill, source, sections, sectionRule, itemId: item.item_id, reviewOn: newEntriesOn, log });
  const out = w.out, trail = w.trail;
  const done = (o) => ({ ...o, attempts: trail.writer_calls, newbill: trail });
  if (w.decision === 'unusable') return done(held(w.reason));
  if (w.decision === 'unreadable') return done(held(w.reason, { proposal: `${item.item_id}: text unreadable; not created` }));
  if (w.decision === 'out_of_scope') return done({ ...base, outcome: 'out_of_scope', patch: { in_scope: false, scope_reason: out.scope_reason }, reason: out.scope_reason });
  if (w.decision === 'excluded') return done({ ...base, outcome: 'out_of_scope', patch: { in_scope: false, scope_reason: w.finding.problem }, reason: w.reason, excluded_by_reviewer: true });
  if (w.decision === 'draft_only') return done(held(`the writer's draft is ready${w.problems.length ? ` (${w.problems.length} check problem(s) left)` : ''}, but it is not confirmed: new entries are switched off, so the reviewer was not asked and nothing is created`, { unconfirmed: true, draft: out, proposal: `${item.item_id} (${out.name}, section ${out.tracker_section}): writer's draft, not reviewed: new entries are switched off; not created` }));

  // A section whose criterion code checks (a frontier threshold for A/B, a catastrophic-risk term for B.2, IVO / auditor licensing for C;
  // agents/rules.mjs) is published only with a quote showing it: code picks it from the writer's quotes found in the bill (coverage and
  // definitions first), as the referee's quote was picked before. None qualifies: the section is not proved and nothing is created.
  const sectionProof = (o) => {
    const s = o.tracker_section;
    if (!SECTION_MARKERS[s]) return { ok: true, evidence: [] };
    const order = ['coverage', 'definitions', 'duties', 'penalties', 'exclusions', 'other_provisions', 'effective'];
    const quotes = order.flatMap((l) => (o[l] || []).map((x) => String(x.quote || '').trim())).filter((q) => q.length >= 8 && containsQuote(source, q));
    const q = quotes.find((x) => quoteMeetsSection(s, x, source));
    return q ? { ok: true, evidence: [{ field: 'section', quote: q }] } : { ok: false, why: `no quote of the entry shows section ${s}'s criterion (${SECTION_CRITERIA[s]})` };
  };
  // An entry assembled from an answer: official facts from code, the model's words in the reading fields and `plain`.
  const build = (patchIn, finish) => {
    const proof = sectionProof(out);
    if (!proof.ok) return { problems: [proof.why] };
    const patch = { ...patchIn, evidence: [...patchIn.evidence, ...proof.evidence] };
    const asm = assembleEntry({ entry: null, patch, item, raw, today, runId, rounds: trail.writer_calls, entries, now });
    if (!asm.entry) return { problems: asm.problems };
    const dup = refileOf(asm.entry, entries) || (asm.entry.state ? programmeDuplicateOf(asm.entry, entries) : null);
    if (dup) return { duplicate: dup };
    return { entry: finish ? finish(asm.entry) : asm.entry };
  };
  if (w.decision === 'publish') {
    const b = build(toPatch(out), (e) => finishEntry(e, out, { sourceUrl: item.source_url, source, now }));
    if (b.duplicate) return done(held(`${b.duplicate.why} (entry ${b.duplicate.key}); not created`, { possible_duplicate: b.duplicate.key, proposal: `${item.item_id} (${out.name}) may duplicate or update entry ${b.duplicate.key}: ${b.duplicate.why}` }));
    if (!b.entry) return done(held(`the entry could not be assembled: ${b.problems.join('; ')}`, { proposal: `${item.item_id}: not created (${b.problems[0]})` }));
    return done({ ...base, outcome: 'publishable', entry: b.entry, patch: toPatch(out) });
  }
  // facts_only: in scope (no proved scope objection) but the description did not pass. The scope evidence is the writer's quotes that
  // code finds in the bill (an automated entry always carries a checked quote).
  const why = w.reason;
  const proved = itemsOf(out).map((x) => String(x.quote || '').trim()).filter((q) => q.length >= 8 && containsQuote(source, q)).slice(0, 3);
  if (!proved.length) return done(held(`${why}; and no quote of the writer's could be checked, so not even a facts-only entry is made`, { proposal: `${item.item_id}: not created (${why.slice(0, 120)})` }));
  const patch = { ...factsOnlyPatch(out), evidence: proved.map((quote) => ({ field: 'in_scope', quote })) };
  const b = build(patch, (e) => ({ ...e, plain: { box: { applies_to: '', requires_lead: 'Requires them to', requires: '', enforcement: '', effective: '' }, items: {}, facts_only: true } }));
  if (b.duplicate) return done(held(`${b.duplicate.why} (entry ${b.duplicate.key}); not created`, { possible_duplicate: b.duplicate.key }));
  if (!b.entry) return done(held(`${why}; a facts-only entry could not be assembled either: ${b.problems.join('; ')}`));
  return done({ ...base, outcome: 'publishable', facts_only: true, entry: b.entry, patch: factsOnlyPatch(out), reason: why, proposal: `${item.item_id} (${out.name}): published with official facts only (${why.slice(0, 120)}); the description is written again when the record changes` });
}
