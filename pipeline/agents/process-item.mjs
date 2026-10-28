// One item through the whole loop: Generator -> assemble -> Validator -> (fail? feed the complaints back) -> up to 3 rounds.
//   publishable   every code check passed, every claim was supported, and (new items) the referee confirmed the scope with a quote
//   out_of_scope  the readers (and, when they disagree or rule it out, the referee) say it is not about frontier AI (nothing is published)
//   held          not proved. A held item that ran out of its token budget or of rounds gets ONE escalated pass (the referee's stronger
//                 model writes, a larger budget, long bills read section by section); still held after that, or held for a reason no
//                 retry can fix (a resolution, an amendment record, a duplicate, the referee disagreeing), it carries escalate: true and
//                 is read again only when its record changes. Nothing loops.
import { sourceText, containsQuote } from './source-text.mjs';
import { generatePatch } from './generator.mjs';
import { assembleEntry } from './assemble.mjs';
import { validateDraft, complaints } from './validator.mjs';
import { SCOPE_CLAIM, VALIDATOR_SYSTEM, validatorPrompt } from './prompts.mjs';
import { LlmOutputError, InputTooLarge, BudgetExceeded } from '../llm/gemini.mjs';
import { deriveCreate } from './derive.mjs';
import { relevantSections, markerPassages } from './sections.mjs';
import { HttpError, NetworkError } from '../grabber/lib/http.mjs';
import { writeDuties, DUTY_SECTIONS, DUTY_REQUIRED_SECTIONS } from './duties.mjs';
import { recordRefusals } from './record-kind.mjs';
import { trackerIndex, duplicateOf } from './dedupe.mjs';

export const MAX_ROUNDS = 3;
const TRIAGE_OVER = 100000, TRIAGE_CHARS = 30000; // sources longer than this are read section by section (or by frontier passages)
const ESCALATED_READ_OVER = 30000, ESCALATED_READ_CHARS = 45000; // the escalated pass reads a long bill's frontier sections only

// The referee (config role "referee", a stronger model) on scope. Its answer counts only with a quote that code finds in the source:
// { in: true | false | null, quote }. null = no referee, no usable answer, or "in scope" without a verifiable quote.
export async function refereeVerdict(referee, source, itemId, fullText = source) {
  if (!referee) return { in: null, quote: null };
  try {
    const r = await referee.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source, claims: [{ field: 'in_scope', claim: SCOPE_CLAIM }] }), itemId });
    const x = r && r.data && r.data.results && r.data.results[0];
    if (!x) return { in: null, quote: null };
    if (x.supported === true) return containsQuote(fullText, x.quote) && String(x.quote).trim().length >= 8 ? { in: true, quote: x.quote } : { in: null, quote: null, why: 'the referee said in scope but its quote is not in the source' };
    return { in: false, quote: null, reason: x.reason || null };
  } catch (e) { if (e instanceof LlmOutputError) return { in: null, quote: null }; throw e; }
}
// true = in scope, false = out, null = no referee or no usable answer (eval/run.mjs uses this form).
export async function refereeSays(referee, source, itemId, fullText = source) { return (await refereeVerdict(referee, source, itemId, fullText)).in; }
const IN_SCOPE_NOW = (sections) => `An independent reader judged this item IN scope for the tracker. Set in_scope to true and write the entry now: mechanism (what it does), thresholds and penalties only if the source states them, and section (${sections ? `one of ${sections.join(', ')}` : 'D or F'} for a bill). Do not return an empty "fields" object.`;

function styleExamplesFor({ source, entry, entries }) {
  const sections = entry ? [entry.section] : source === 'federal_register' ? ['G', 'G.3'] : source === 'legiscan' ? ['A', 'B'] : ['D', 'F'];
  return entries.filter((e) => sections.includes(e.section) && (!entry || e.key !== entry.key) && e.mechanism && e.mechanism.length < 600).slice(0, 2);
}

const heldResult = (item, operation, reason, extra = {}) => ({ item_id: item.item_id, outcome: 'held', operation, attempts: 0, entry: null, patch: null, verdicts: [], reason, ...extra });

// One item can fail without taking the run down: a source that is too long, or an item that has used its own token budget, is held
// with a clear reason. Only the run-wide budget (BudgetExceeded with scope "run" or "month") and real bugs propagate to the caller.
// escalation (optional): { generator, validator, budget } from agents/run.mjs: the second, stronger pass for an item held as retryable.
export async function processItem(args) {
  const first = await guarded(args);
  if (!(first.outcome === 'held' && first.retryable && args.escalation)) return finish({ ...first, retryable: false });
  const esc = args.escalation;
  (args.log || (() => {}))(`escalating: ${first.reason}`);
  const second = await guarded({ ...args, generator: esc.budget.wrap(esc.generator), validator: esc.budget.wrap(esc.validator || args.validator), referee: esc.budget.wrap(args.referee), escalated: true });
  return finish({ ...second, escalated: true, first_reason: first.reason });
}
// A held item is either retryable once (by the escalated pass) or escalated: no automatic step will publish it as its record stands.
function finish(r) {
  if (r.outcome === 'held' && (!r.retryable || r.escalated)) r.escalate = true;
  delete r.retryable;
  return r;
}
async function guarded(args) {
  const operation = args.diff.verdict === 'new_entry_candidate' ? 'create' : 'update';
  try { return await processItemInner(args); }
  catch (e) {
    if (e instanceof InputTooLarge) return heldResult(args.item, operation, `source too long for automatic processing: ${e.message}`, { retryable: true });
    if (e instanceof BudgetExceeded && e.scope === 'item') return heldResult(args.item, operation, e.message, { retryable: true });
    // The model service itself failed (timeout, outage, rejected request) even after retries: hold the item and let the caller count it.
    if (e instanceof HttpError || e instanceof NetworkError) return heldResult(args.item, operation, `the model service failed: ${String(e.message).slice(0, 160)}`, { service_error: true });
    throw e;
  }
}

// What the models read of a long source: its frontier-AI sections (agents/sections.mjs), else the passages around frontier-AI terms
// anywhere in it. null when nothing was found.
function selectionOf(source, maxChars) {
  const sel = relevantSections(source, maxChars ? { maxChars } : undefined);
  if (sel.chunks.length) return sel;
  const p = markerPassages(source, maxChars ? { maxChars } : undefined);
  return p.chunks.length ? p : null;
}

async function processItemInner({ generator, validator, referee = null, item, raw, diff, entry = null, entries = [], today, runId, now = new Date(), maxRounds = MAX_ROUNDS, escalated = false, log = () => {} }) {
  const operation = diff.verdict === 'new_entry_candidate' ? 'create' : 'update';
  const source = sourceText(raw, item.source);
  const held = (reason, extra = {}) => heldResult(item, operation, reason, extra);

  if (operation === 'create') {
    // Code first, before any AI is spent: a record that is not a bill (a resolution, a memorial, an amendment filed as its own record, a
    // placeholder title) and an item the tracker already has under another id or number are never written up.
    if (item.source === 'legiscan') { const refused = recordRefusals(raw); if (refused.length) return held(`not created: ${refused.join('; ')}`); }
    const dup = duplicateOf({ item, raw, idx: trackerIndex(entries) });
    if (dup) return held(`${dup.why}${dup.key ? ` (entry ${dup.key})` : ''}: not created; the id belongs on that entry`);
    // A new bill whose text is not published (or could not be fetched): nothing can be described or checked, and its scope is never
    // judged from the title alone (NJ S4934 was ruled out on its title). It is held and read again when its record changes.
    const textMissing = raw.text_missing === true || ((item.source === 'congress_gov' || item.source === 'legiscan') && !String(raw.text || '').trim());
    if (textMissing) return held('the full text is not available yet (not published, or could not be fetched), so nothing can be verified and its scope is not judged from the title; read again when its record changes', { text_missing: true });
  }

  const styleExamples = styleExamplesFor({ source: item.source, entry, entries });
  // A very long source (an omnibus bill) cannot be sent whole: the models read only its frontier-AI sections, copied word for word
  // (sections.mjs). Every code check still runs on the FULL source, so a quote must be in the bill itself. The escalated pass reads a
  // shorter selection of a long bill, so its larger budget goes to more rounds rather than to re-reading the whole text.
  const over = escalated ? ESCALATED_READ_OVER : TRIAGE_OVER;
  const sel = source.length > over ? selectionOf(source, escalated ? ESCALATED_READ_CHARS : undefined) : null, read = sel ? sel.text : source;
  if (read !== source) log(`source is ${source.length} characters: reading ${sel.selected.length} sections or passages (${read.length} characters)`);
  const verdicts = [];
  let feedback = [], previousPatch = null, last = null, scopeRetries = 0, scopeObjections = 0, refereeIn = null;
  const askReferee = async () => (refereeIn === null && referee ? (refereeIn = await refereeVerdict(referee, read, item.item_id, source)) : refereeIn) || { in: null, quote: null };

  // A new item whose section no rule decides gets it from the Generator: a federal bill D, F or G.3; a state bill one of the state sections
  // its status allows (derive.mjs stateSections), and nothing else (the answer schema and assemble.mjs both refuse any other).
  const derivedNow = operation === 'create' ? deriveCreate({ item, raw }) : null;
  const needsSection = operation === 'create' && !derivedNow.section, sections = (derivedNow && derivedNow.sections) || null;

  // A very long source in which no frontier-AI section or passage was found: whether it is in scope is judged on its opening. If both
  // readers (and the referee) say it is out of scope we are done; otherwise it is held for a person.
  if (operation === 'create' && source.length > TRIAGE_OVER && read === source) {
    const head = source.slice(0, TRIAGE_CHARS);
    const note = { kind: 'candidate', detail: `NOTE: SOURCE below is incomplete: it is cut off after its first ${TRIAGE_CHARS} characters because the full text is ${source.length} characters, and no frontier-AI term appears anywhere in the rest. Decide ONLY in_scope and scope_reason; leave "fields" empty.` };
    const g = await generatePatch({ llm: generator, item, source: head, entry, reasons: [...diff.reasons, note], operation, styleExamples: [], feedback: [], previousPatch: null, sections });
    if (g.patch && g.patch.in_scope === false) {
      const scopeClaim = [{ field: 'in_scope', claim: SCOPE_CLAIM }];
      let res; try { res = await validator.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: head, claims: scopeClaim }), itemId: item.item_id }); } catch (e) { if (!(e instanceof LlmOutputError)) throw e; }
      const r = res && res.data && res.data.results && res.data.results[0];
      if (r && r.supported === false && (await refereeSays(referee, head, item.item_id, source)) !== true) return { item_id: item.item_id, outcome: 'out_of_scope', operation, attempts: 1, entry: null, patch: g.patch, verdicts, reason: `${g.patch.scope_reason} (judged on the first ${TRIAGE_CHARS} characters of a ${source.length}-character text in which no frontier-AI term appears)` };
    }
    return { ...held(`source too long for automatic processing (${source.length} characters), no frontier-AI section or term was found in it, and it may be in scope, so it needs a person`), attempts: 1, patch: g.patch || null };
  }

  for (let attempt = 1; attempt <= maxRounds; attempt++) {
    const g = await generatePatch({ llm: generator, item, source: read, entry, reasons: diff.reasons, operation, styleExamples, feedback, previousPatch, needsSection, sections });
    if (!g.patch) { feedback = g.problems; log(`attempt ${attempt}: unusable patch (${g.problems[0]})`); continue; }
    const patch = g.patch;
    if (operation === 'create') {
      // The system owns every field the official record states exactly; anything the model wrote there is dropped, with its evidence.
      const d = deriveCreate({ item, raw });
      const dropped = Object.keys(d.fields).filter((k) => d.fields[k] != null).concat(d.section ? ['section'] : []);
      dropped.forEach((k) => delete patch.fields[k]);
      patch.evidence = patch.evidence.filter((e) => !dropped.includes(e.field));
    }
    previousPatch = patch;

    // The Generator says "not about frontier AI": let the independent reader confirm before anything is dropped.
    if (operation === 'create' && patch.in_scope === false) {
      const scopeClaim = [{ field: 'in_scope', claim: SCOPE_CLAIM }];
      let res;
      try { res = await validator.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: read, claims: scopeClaim }), itemId: item.item_id }); }
      catch (e) { if (!(e instanceof LlmOutputError)) throw e; }
      const r = res && res.data && res.data.results && res.data.results[0];
      // Both readers say out, or they disagree: the referee decides. Without a referee, both saying out drops it; a disagreement gets one firm retry.
      const ref = (await askReferee()).in;
      if (ref === false || (ref === null && r && r.supported === false)) return { item_id: item.item_id, outcome: 'out_of_scope', operation, attempts: attempt, entry: null, patch, verdicts, reason: patch.scope_reason + (ref === false ? ' (confirmed by the referee)' : '') };
      if (scopeRetries++ >= 1) return { ...held(`scope disagreement: the generator still says out of scope ("${patch.scope_reason}") after ${ref === true ? 'the referee ruled it in scope' : 'the independent reader said in scope'}`), attempts: attempt, patch, verdicts };
      feedback = [IN_SCOPE_NOW(sections)]; continue;
    }

    const asm = assembleEntry({ entry, patch, item, raw, today, runId, rounds: attempt, entries, now });
    const verdict = await validateDraft({ llm: validator, patch, before: entry, after: asm.entry, assembleProblems: asm.problems, source: item.source, sourceText: source, readText: read, entries, operation, itemId: item.item_id, run_id: runId, attempt });
    // The reader objects to the scope of an item the generator wrote up: the referee decides, once per item.
    const objection = verdict.claims.find((c) => c.field === 'in_scope' && !c.supported);
    if (objection && referee) {
      const ref = await askReferee();
      if (ref.in === false) return { item_id: item.item_id, outcome: 'out_of_scope', operation, attempts: attempt, entry: null, patch, verdicts: [...verdicts, verdict], reason: `${(objection.reason || 'out of scope').slice(0, 200)} (confirmed by the referee)` };
      if (ref.in === true) { objection.supported = true; objection.evidence_quote = ref.quote; delete objection.reason; verdict.passed = verdict.code_checks.every((c) => c.passed) && verdict.claims.every((c) => c.supported); }
    }
    verdicts.push(verdict); last = { patch, asm, verdict };
    log(`attempt ${attempt}: ${verdict.passed ? 'passed' : 'rejected (' + complaints(verdict).length + ' problem(s))'}`);
    if (verdict.passed) {
      if (operation === 'create') {
        // The generator and the reader may be the same model: a new entry is published only when the referee (a different, stronger
        // model) also rules it in scope, with a quote code finds in the source. No referee, no usable answer, or "out": held for a person.
        const ref = await askReferee();
        if (ref.in !== true) return { ...held(ref.in === false ? `the referee rules it out of scope after both readers said in ("${String(ref.reason || '').slice(0, 160)}"); held for a person` : `the referee did not confirm the scope with a quote found in the source${ref.why ? ` (${ref.why})` : referee ? '' : ' (no referee is configured)'}`), attempts: attempt, patch, verdicts };
        asm.entry.evidence = [...(asm.entry.evidence || []), { field: 'in_scope', quote: ref.quote, source_url: item.source_url }];
      }
      // A new bill (federal or state) also gets its 13 duty answers, each proved on its own (agents/duties.mjs). An A or B entry (a
      // frontier law or bill) is never published without them: it is held (retried once by the escalated pass).
      if (operation === 'create' && (item.source === 'congress_gov' || item.source === 'legiscan') && DUTY_SECTIONS.includes(asm.entry.section)) {
        const d = await writeDuties({ generator, validator, entry: asm.entry, sourceText: source, readText: read, sourceUrl: item.source_url, itemId: item.item_id, now, log });
        if (d.duties) Object.assign(asm.entry, { duties: d.duties, duties_basis: d.duties_basis });
        else if (DUTY_REQUIRED_SECTIONS.includes(asm.entry.section)) return { ...held(`a section ${asm.entry.section} entry is not published without its duty answers, and they were not proved: ${d.reason}`, { retryable: !/every answer was not_in_bill/.test(d.reason || '') }), attempts: attempt, patch, verdicts, duties: { added: false, rounds: d.rounds, dropped: d.dropped, reason: d.reason } };
        return { item_id: item.item_id, outcome: 'publishable', operation, attempts: attempt, entry: asm.entry, patch, verdicts, reason: null, duties: { added: !!d.duties, rounds: d.rounds, dropped: d.dropped, reason: d.reason } };
      }
      return { item_id: item.item_id, outcome: 'publishable', operation, attempts: attempt, entry: asm.entry, patch, verdicts, reason: null };
    }
    // The generator says "in scope" and the reader says "out" (twice): stop, do not keep arguing.
    if (verdict.claims.some((c) => c.field === 'in_scope' && !c.supported) && ++scopeObjections >= 2) {
      return { ...held(`scope disagreement: the generator says in scope but the independent reader says out of scope ("${(verdict.claims.find((c) => c.field === 'in_scope').reason || '').slice(0, 160)}"). The author's scope rule needs to decide cases like this.`), attempts: attempt, patch, verdicts };
    }
    feedback = complaints(verdict);
  }
  return { ...held(`still failing after ${maxRounds} rounds: ${(feedback[0] || 'unusable answers').slice(0, 200)}`, { retryable: true }), attempts: maxRounds, patch: last && last.patch, verdicts };
}
