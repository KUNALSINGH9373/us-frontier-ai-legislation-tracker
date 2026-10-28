// One item through the whole loop: Generator -> assemble -> Validator -> (fail? feed the complaints back) -> up to 3 rounds.
//   publishable   every code check passed and every claim was supported
//   out_of_scope  both the Generator and the independent reader say it is not about frontier AI (nothing is published)
//   held          still failing after 3 rounds; it waits in the held list and is retried on the next run
import { sourceText } from './source-text.mjs';
import { generatePatch } from './generator.mjs';
import { assembleEntry } from './assemble.mjs';
import { validateDraft, complaints } from './validator.mjs';
import { SCOPE_CLAIM, VALIDATOR_SYSTEM, validatorPrompt } from './prompts.mjs';
import { LlmOutputError, InputTooLarge, BudgetExceeded } from '../llm/gemini.mjs';
import { deriveCreate } from './derive.mjs';
import { relevantSections } from './sections.mjs';
import { HttpError, NetworkError } from '../grabber/lib/http.mjs';

export const MAX_ROUNDS = 3;
const TRIAGE_OVER = 100000, TRIAGE_CHARS = 30000; // sources longer than this are read section by section, or triaged on their opening

// A second opinion on scope from a stronger model (config role "referee"), asked only when the two readers rule an item out or
// disagree about it. No person reviews held items, so its answer is final. true = in scope, false = out, null = no referee or no answer.
export async function refereeSays(referee, source, itemId) {
  if (!referee) return null;
  try {
    const r = await referee.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source, claims: [{ field: 'in_scope', claim: SCOPE_CLAIM }] }), itemId });
    const x = r && r.data && r.data.results && r.data.results[0];
    return x ? x.supported === true : null;
  } catch (e) { if (e instanceof LlmOutputError) return null; throw e; }
}
const IN_SCOPE_NOW = 'An independent reader judged this item IN scope for the tracker. Set in_scope to true and write the entry now: mechanism (what it does), thresholds and penalties only if the source states them, and section (D or F for a bill). Do not return an empty "fields" object.';

function styleExamplesFor({ source, entry, entries }) {
  const sections = entry ? [entry.section] : source === 'federal_register' ? ['G', 'G.3'] : ['D', 'F'];
  return entries.filter((e) => sections.includes(e.section) && (!entry || e.key !== entry.key) && e.mechanism && e.mechanism.length < 600).slice(0, 2);
}

// One item can fail without taking the run down: a source that is too long, or an item that has used its own token budget, is held
// with a clear reason. Only the run-wide budget (BudgetExceeded with scope "run") and real bugs propagate to the caller.
export async function processItem(args) {
  try { return await processItemInner(args); }
  catch (e) {
    const operation = args.diff.verdict === 'new_entry_candidate' ? 'create' : 'update';
    if (e instanceof InputTooLarge) return { item_id: args.item.item_id, outcome: 'held', operation, attempts: 0, entry: null, patch: null, verdicts: [], reason: `source too long for automatic processing: ${e.message}` };
    if (e instanceof BudgetExceeded && e.scope === 'item') return { item_id: args.item.item_id, outcome: 'held', operation, attempts: 0, entry: null, patch: null, verdicts: [], reason: e.message };
    // The model service itself failed (timeout, outage, rejected request) even after retries: hold the item and let the caller count it.
    if (e instanceof HttpError || e instanceof NetworkError) return { item_id: args.item.item_id, outcome: 'held', operation, attempts: 0, entry: null, patch: null, verdicts: [], service_error: true, reason: `the model service failed: ${String(e.message).slice(0, 160)}` };
    throw e;
  }
}

async function processItemInner({ generator, validator, referee = null, item, raw, diff, entry = null, entries = [], today, runId, now = new Date(), maxRounds = MAX_ROUNDS, log = () => {} }) {
  const operation = diff.verdict === 'new_entry_candidate' ? 'create' : 'update';
  const source = sourceText(raw, item.source);
  const styleExamples = styleExamplesFor({ source: item.source, entry, entries });
  // A very long source (an omnibus bill) cannot be sent whole: the models read only its frontier-AI sections, copied word for word
  // (sections.mjs). Every code check still runs on the FULL source, so a quote must be in the bill itself.
  const sel = source.length > TRIAGE_OVER ? relevantSections(source) : null, read = sel && sel.chunks.length ? sel.text : source;
  if (read !== source) log(`source is ${source.length} characters: reading ${sel.selected.length} sections (${read.length} characters)`);
  const verdicts = [];
  let feedback = [], previousPatch = null, last = null, scopeRetries = 0, scopeObjections = 0, refereeIn = null;
  const askReferee = async () => (refereeIn === null && referee ? (refereeIn = await refereeSays(referee, read, item.item_id)) : refereeIn);

  const needsSection = operation === 'create' && !deriveCreate({ item, raw }).section;

  // Two cases cannot be written up yet: a new bill whose text is not published (or could not be fetched), so nothing can be described or
  // checked; and a very long source in which no frontier-AI section was found, so it cannot be sent whole or in part. In both, whether
  // the item is about frontier AI is usually clear from what we have (the title and actions, or the opening of the text). If both readers say it is out of scope we are done;
  // otherwise it is held and retried (text not yet available) or waits for a person (too long).
  const textMissing = operation === 'create' && (raw.text_missing === true || (item.source === 'congress_gov' && !raw.text));
  if (operation === 'create' && (textMissing || (source.length > TRIAGE_OVER && read === source))) {
    const head = source.slice(0, TRIAGE_CHARS);
    const why = textMissing ? 'the bill text is not published yet, so only its title and actions are shown' : `it is cut off after its first ${TRIAGE_CHARS} characters because the full text is ${source.length} characters`;
    const note = { kind: 'candidate', detail: `NOTE: SOURCE below is incomplete: ${why}. Decide ONLY in_scope and scope_reason; leave "fields" empty.` };
    const g = await generatePatch({ llm: generator, item, source: head, entry, reasons: [...diff.reasons, note], operation, styleExamples: [], feedback: [], previousPatch: null });
    if (g.patch && g.patch.in_scope === false) {
      const scopeClaim = [{ field: 'in_scope', claim: SCOPE_CLAIM }];
      let res; try { res = await validator.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: head, claims: scopeClaim }), itemId: item.item_id }); } catch (e) { if (!(e instanceof LlmOutputError)) throw e; }
      const r = res && res.data && res.data.results && res.data.results[0];
      if (r && r.supported === false && (await refereeSays(referee, head, item.item_id)) !== true) return { item_id: item.item_id, outcome: 'out_of_scope', operation, attempts: 1, entry: null, patch: g.patch, verdicts, reason: `${g.patch.scope_reason} (judged on ${textMissing ? 'the title and actions, as the text is not published yet' : `the first ${TRIAGE_CHARS} characters of a ${source.length}-character text`})` };
    }
    return { item_id: item.item_id, outcome: 'held', operation, attempts: 1, entry: null, patch: g.patch || null, verdicts, reason: textMissing ? 'it may be in scope, but the full text is not available yet (not published, or could not be fetched), so nothing can be verified; retried on a later run' : `source too long for automatic processing (${source.length} characters), no section about frontier AI was found in it, and it may be in scope, so it needs a person` };
  }

  for (let attempt = 1; attempt <= maxRounds; attempt++) {
    const g = await generatePatch({ llm: generator, item, source: read, entry, reasons: diff.reasons, operation, styleExamples, feedback, previousPatch, needsSection });
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
      const ref = await askReferee();
      if (ref === false || (ref === null && r && r.supported === false)) return { item_id: item.item_id, outcome: 'out_of_scope', operation, attempts: attempt, entry: null, patch, verdicts, reason: patch.scope_reason + (ref === false ? ' (confirmed by the referee)' : '') };
      if (scopeRetries++ >= 1) return { item_id: item.item_id, outcome: 'held', operation, attempts: attempt, entry: null, patch, verdicts, reason: `scope disagreement: the generator still says out of scope ("${patch.scope_reason}") after ${ref === true ? 'the referee ruled it in scope' : 'the independent reader said in scope'}; retried on the next run.` };
      feedback = [IN_SCOPE_NOW]; continue;
    }

    const asm = assembleEntry({ entry, patch, item, raw, today, runId, rounds: attempt, entries, now });
    const verdict = await validateDraft({ llm: validator, patch, before: entry, after: asm.entry, assembleProblems: asm.problems, source: item.source, sourceText: source, readText: read, entries, operation, itemId: item.item_id, run_id: runId, attempt });
    // The reader objects to the scope of an item the generator wrote up: the referee decides, once per item.
    const objection = verdict.claims.find((c) => c.field === 'in_scope' && !c.supported);
    if (objection && referee) {
      const ref = await askReferee();
      if (ref === false) return { item_id: item.item_id, outcome: 'out_of_scope', operation, attempts: attempt, entry: null, patch, verdicts: [...verdicts, verdict], reason: `${(objection.reason || 'out of scope').slice(0, 200)} (confirmed by the referee)` };
      if (ref === true) { objection.supported = true; delete objection.reason; verdict.passed = verdict.code_checks.every((c) => c.passed) && verdict.claims.every((c) => c.supported); }
    }
    verdicts.push(verdict); last = { patch, asm, verdict };
    log(`attempt ${attempt}: ${verdict.passed ? 'passed' : 'rejected (' + complaints(verdict).length + ' problem(s))'}`);
    if (verdict.passed) return { item_id: item.item_id, outcome: 'publishable', operation, attempts: attempt, entry: asm.entry, patch, verdicts, reason: null };
    // The generator says "in scope" and the reader says "out" (twice): stop, do not keep arguing.
    if (verdict.claims.some((c) => c.field === 'in_scope' && !c.supported) && ++scopeObjections >= 2) {
      return { item_id: item.item_id, outcome: 'held', operation, attempts: attempt, entry: null, patch, verdicts, reason: `scope disagreement: the generator says in scope but the independent reader says out of scope ("${(verdict.claims.find((c) => c.field === 'in_scope').reason || '').slice(0, 160)}"). The author's scope rule needs to decide cases like this.` };
    }
    feedback = complaints(verdict);
  }
  return { item_id: item.item_id, outcome: 'held', operation, attempts: maxRounds, entry: null, patch: last && last.patch, verdicts, reason: `still failing after ${maxRounds} rounds: ${(feedback[0] || 'unusable answers').slice(0, 200)}` };
}
