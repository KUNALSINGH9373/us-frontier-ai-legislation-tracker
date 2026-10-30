// One item through the whole loop: Generator -> assemble -> Validator -> (fail? feed the complaints back) -> up to 3 rounds.
//   publishable   every code check passed, every claim was supported, and (new items) the referee confirmed the scope with a quote
//   out_of_scope  the readers (and, when they disagree or rule it out, the referee) say it is not about frontier AI (nothing is published)
//   held          not proved. A held item that ran out of its token budget or of rounds gets ONE escalated pass (the referee's stronger
//                 model writes, a larger budget, long bills read section by section); still held after that, or held for a reason no
//                 retry can fix (a resolution, an amendment record, a duplicate, the referee disagreeing), it carries escalate: true and
//                 is read again only when its record changes. Nothing loops.
import { PIPELINE } from './pipeline-config.mjs';
import { sourceText, containsQuote, provedQuote } from './source-text.mjs';
import { generatePatch } from './generator.mjs';
import { assembleEntry } from './assemble.mjs';
import { validateDraft, complaints } from './validator.mjs';
import { VERDICT_SCHEMA, SCOPE_CLAIM, VALIDATOR_SYSTEM, validatorPrompt } from './prompts.mjs';
import { LlmOutputError, InputTooLarge, BudgetExceeded } from '../llm/gemini.mjs';
import { deriveCreate } from './derive.mjs';
import { relevantSections, markerPassages } from './sections.mjs';
import { HttpError, NetworkError } from '../grabber/lib/http.mjs';
import { writeDuties, DUTY_SECTIONS, DUTY_REQUIRED_SECTIONS } from './duties.mjs';
import { recordRefusals, federalRefusals } from './record-kind.mjs';
import { trackerIndex, duplicateOf, relatedUnread, programmeDuplicateOf, refileOf } from './dedupe.mjs';
import { SECTION_CRITERIA, quoteMeetsSection, SECTION_RULES, sectionPassage, FEDERAL_CHECKED_SECTIONS, fTitleOut } from './rules.mjs';
import { normaliseExponents } from './checks.mjs';

export const MAX_ROUNDS = 3;
export const TRIAGE_OVER = 100000; const TRIAGE_CHARS = 30000; // sources longer than this are read section by section (or by frontier passages)
const ESCALATED_READ_OVER = 30000, ESCALATED_READ_CHARS = 45000; // the escalated pass reads a long bill's frontier sections only

// The referee (config role "referee", a stronger model) on scope. Its answer counts only with a quote that code finds in the source:
// { in: true | false | null, quote }. null = no referee, no usable answer, or "in scope" without a verifiable quote.
// An unusable answer (not JSON) is not a verdict: the same question is asked once more (Opus as referee answered H.R. 9917 unreadably
// in two paid re-tests and cleanly when asked again, 30 Oct 2026). A second unusable answer is thrown to the caller as before.
const askAgainIfUnusable = async (llm, req) => { try { return await llm.generate(req); } catch (e) { if (!(e instanceof LlmOutputError)) throw e; return llm.generate(req); } };
export async function refereeVerdict(referee, source, itemId, fullText = source) {
  if (!referee) return { in: null, quote: null };
  try {
    const r = await askAgainIfUnusable(referee, { system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source, claims: [{ field: 'in_scope', claim: SCOPE_CLAIM }] }), responseSchema: VERDICT_SCHEMA, itemId });
    const x = r && r.data && r.data.results && r.data.results[0];
    if (!x) return { in: null, quote: null, why: 'the referee gave no answer for the claim' };
    if (x.supported === true) {
      // A quote that is not in the source is a failed quote, not a verdict: one more ask for an exact one, as the reader gets.
      const q = provedQuote(fullText, x.quote) || (await exactScopeQuote(referee, source, itemId, fullText) || {}).quote;
      return q ? { in: true, quote: q } : { in: null, quote: null, why: `the referee said in scope but its quote is not in the source, twice ("${String(x.quote || '').slice(0, 120)}")` };
    }
    return { in: false, quote: null, reason: x.reason || null };
  } catch (e) { if (e instanceof LlmOutputError) return { in: null, quote: null, why: `the referee gave an unusable answer: ${e.message}${e.detail ? ` (began: ${JSON.stringify(String(e.detail).slice(0, 200))})` : ''}` }; throw e; }
}
// The referee on a state entry's SECTION: it must confirm the section's own criterion (agents/rules.mjs SECTION_CRITERIA) with a quote
// that code finds in the source AND that carries the section's marker (a frontier threshold for A/B, a catastrophic-risk term without
// one for B.2, IVO / auditor licensing for C). { ok, quote, why }.
export const sectionClaim = (section) => `This item belongs in section ${section}: it is ${SECTION_CRITERIA[section]}. HOW TO JUDGE THIS CLAIM: it is a classification that you make yourself from what the provisions of SOURCE do; SOURCE will not mention any tracker, section letter or classification, and that is never a reason to mark this claim unsupported (round 3: a federal bill's referee refused "section F" for that reason alone). Support this claim ONLY with a word-for-word quote from SOURCE that itself shows that criterion (for example the definition or duty that states the threshold, the catastrophic-risk duty, or the auditor or verification-organization provision).`;
export async function refereeSection(referee, source, section, itemId, fullText = source) {
  if (!referee) return { ok: false, quote: null, why: 'no referee is configured' };
  try {
    const ask = async (claim) => { const r = await askAgainIfUnusable(referee, { system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source, claims: [{ field: 'section', claim }] }), responseSchema: VERDICT_SCHEMA, itemId }); return r && r.data && r.data.results && r.data.results[0]; };
    let x = await ask(sectionClaim(section));
    if (!x || x.supported !== true) return { ok: false, quote: null, why: `the referee did not confirm section ${section}${x && x.reason ? ` ("${String(x.reason).slice(0, 140)}")` : ''}` };
    let q = provedQuote(fullText, x.quote);
    // Its quote not in the source: one more ask for an exact one (a failed quote, not a verdict).
    if (!q) { x = await ask(`${sectionClaim(section)}\n${EXACT_AGAIN}`); q = x && x.supported === true ? provedQuote(fullText, x.quote) : null; }
    if (!q) return { ok: false, quote: null, why: `the referee's quote for section ${section} is not in the source` };
    if (!quoteMeetsSection(section, q, fullText)) return { ok: false, quote: null, why: `the referee's quote for section ${section} does not show that section's criterion ("${String(q).slice(0, 100)}")` };
    return { ok: true, quote: q };
  } catch (e) { if (e instanceof LlmOutputError) return { ok: false, quote: null, why: 'the referee gave an unusable answer' }; throw e; }
}
// One more ask of the independent reader for the scope claim when it said "supported" but its quote was not in the source: an exact quote
// this time. true = supported with a quote code finds; null = still no usable quote.
const EXACT_AGAIN = 'IMPORTANT: your previous answer to this claim said "supported" but its quote was not found word for word in SOURCE. Copy the quote EXACTLY, character for character, from SOURCE (no ellipses, no paraphrase, no added or changed words).';
async function exactScopeQuote(validator, source, itemId, fullText) {
  const claim = `${SCOPE_CLAIM}\n${EXACT_AGAIN}`;
  try {
    const r = await validator.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source, claims: [{ field: 'in_scope', claim }] }), responseSchema: VERDICT_SCHEMA, itemId });
    const x = r && r.data && r.data.results && r.data.results[0];
    const q = x && x.supported === true ? provedQuote(fullText, x.quote) : null;
    return q ? { quote: q } : null;
  } catch (e) { if (e instanceof LlmOutputError) return null; throw e; }
}
const QUOTE_FAILED = /quote does not appear in the source/;
// true = in scope, false = out, null = no referee or no usable answer (eval/run.mjs uses this form).
export async function refereeSays(referee, source, itemId, fullText = source) { return (await refereeVerdict(referee, source, itemId, fullText)).in; }
const IN_SCOPE_NOW = (sections) => `An independent reader judged this item IN scope for the tracker. Set in_scope to true and write the entry now: mechanism (what it does), thresholds and penalties only if the source states them, and section (${sections ? `one of ${sections.join(', ')}` : 'D or F'} for a bill). Do not return an empty "fields" object.`;

function styleExamplesFor({ source, entry, entries }) {
  const sections = entry ? [entry.section] : source === 'federal_register' ? ['G', 'G.3'] : source === 'legiscan' ? ['A', 'B'] : ['D', 'F'];
  return entries.filter((e) => sections.includes(e.section) && (!entry || e.key !== entry.key) && e.mechanism && e.mechanism.length < PIPELINE.style_examples.max_mechanism_chars).slice(0, PIPELINE.style_examples.count);
}

const heldResult = (item, operation, reason, extra = {}) => ({ item_id: item.item_id, outcome: 'held', operation, attempts: 0, entry: null, patch: null, verdicts: [], reason, ...extra });

// One item can fail without taking the run down: a source that is too long, or an item that has used its own token budget, is held
// with a clear reason. Only the run-wide budget (BudgetExceeded with scope "run" or "month") and real bugs propagate to the caller.
// escalation (optional): { generator, validator, budget } from agents/run.mjs: the second, stronger pass for an item held as retryable.
// newEntriesOn (default true): the GATED auto_publish.new_entries. When false a new entry can never publish, so no Sonnet is spent on
// it: no escalated pass at all, and no referee scope/section confirmation; a draft the cheaper readers pass is held as an unconfirmed
// proposal ("not confirmed: new entries are switched off"). When true, behaviour is unchanged.
export async function processItem(args) {
  if (args.newEntriesOn === false) args = { ...args, escalation: null };
  const first = await guarded(args);
  if (!(first.outcome === 'held' && first.retryable && args.escalation)) return finish({ ...first, retryable: false });
  const esc = args.escalation;
  (args.log || (() => {}))(`escalating: ${first.reason}`);
  const second = await guarded({ ...args, generator: esc.budget.wrap(esc.generator), validator: esc.budget.wrap(esc.validator || args.validator), referee: esc.budget.wrap(args.referee), escalated: true });
  return finish({ ...second, escalated: true, first_reason: first.reason });
}
// A held item is either retryable once (by the escalated pass) or escalated: no automatic step will publish it as its record stands.
function finish(r) {
  // A model-service failure is not a verdict on the item: it is tried again on the next run, so it is not marked escalated.
  if (r.outcome === 'held' && !r.service_error && (!r.retryable || r.escalated)) r.escalate = true;
  // Every final hold is reported (run report and Telegram) as a proposal, once; production has no reviewer to ask.
  if (r.escalate && !r.proposal) r.proposal = `${r.item_id}: held (${String(r.reason || '').slice(0, 160)}); not created`;
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
export function selectionOf(source, maxChars) {
  const sel = relevantSections(source, maxChars ? { maxChars } : undefined);
  if (sel.chunks.length) return sel;
  const p = markerPassages(source, maxChars ? { maxChars } : undefined);
  return p.chunks.length ? p : null;
}

async function processItemInner({ generator, validator, referee = null, item, raw, diff, entry = null, entries = [], today, runId, now = new Date(), maxRounds = MAX_ROUNDS, escalated = false, newEntriesOn = true, log = () => {} }) {
  // New entries switched off: no referee call is made on a new bill (its drafts can never publish).
  const unconfirmedOnly = newEntriesOn === false && diff.verdict === 'new_entry_candidate';
  if (unconfirmedOnly) referee = null;
  const operation = diff.verdict === 'new_entry_candidate' ? 'create' : 'update';
  const source = sourceText(raw, item.source);
  const held = (reason, extra = {}) => heldResult(item, operation, reason, extra);

  if (operation === 'create') {
    // Code first, before any AI is spent: a record that is not a bill (a resolution, a memorial, an amendment filed as its own record, a
    // placeholder title) and an item the tracker already has under another id or number are never written up.
    // A Congress resolution (S.Res., H.Res., Con.Res., J.Res.) is not a bill: never in D or F, no AI spent (round 3, audit item 6).
    if (item.source === 'congress_gov') { const refused = federalRefusals(item, raw); if (refused.length) return held(`not created: ${refused.join('; ')}`, { proposal: `${item.item_id}: not a bill (${refused[0]}); not created` }); }
    if (item.source === 'legiscan') { const refused = recordRefusals(raw); if (refused.length) return held(`not created: ${refused.join('; ')}`, { proposal: `${item.item_id}: not a bill (${refused[0]}); not created` }); }
    const dup = duplicateOf({ item, raw, idx: trackerIndex(entries) });
    if (dup && dup.possible) return held(`${dup.why}${dup.key ? ` (entry ${dup.key})` : ''}: not created`, { possible_duplicate: dup.key, proposal: `${item.item_id} may be a duplicate or update of entry ${dup.key}: ${dup.why}` });
    if (dup) return held(`${dup.why}${dup.key ? ` (entry ${dup.key})` : ''}: not created; the id belongs on that entry`, { duplicate_of: dup.key, proposal: `add ${item.item_id} to entry ${dup.key} (${dup.why})` });
    // A Congress bill whose related bills were not read: an identical tracked bill cannot be ruled out, so no AI is spent on it.
    const unread = relatedUnread(item, raw);
    // A failed fetch (often a transient network error) is not a verdict on the bill: held as a fetch error (service_error, so it is
    // never memoed or escalated; fetch_error, so it is not counted as a model-service failure) and read again on the next run.
    if (unread) return held(`${unread}; not created; read again next run`, { service_error: true, fetch_error: true });
    // A new bill whose text is not published (or could not be fetched): nothing can be described or checked, and its scope is never
    // judged from the title alone (NJ S4934 was ruled out on its title). It is held and read again when its record changes.
    const textMissing = raw.text_missing === true || ((item.source === 'congress_gov' || item.source === 'legiscan') && !String(raw.text || '').trim());
    // An amendment adopted since the text was printed whose words could not be read: the text may be out of date, so it is held and
    // read again (grabber/sources/legiscan.mjs withAmendments).
    // Any amendment adopted since the text was printed: held (independent review, 30 Oct 2026). The printed text still holds the words an
    // amendment struck, so a quote of them passes every code check, and which amendments were adopted is read from action history that
    // is not always exact. Read again when the record changes (a re-printed text includes the amendment).
    if (/ADOPTED AMENDMENT( NOT READ)?:/.test(String(raw.text || ''))) return held('an amendment was adopted since the bill text was printed; code cannot yet apply it to the text, so nothing is written until a version including it is printed', { proposal: `${item.item_id}: an adopted amendment is not yet in the printed text; not created` });
    if (textMissing) return held('the full text is not available yet (not published, or could not be fetched), so nothing can be verified and its scope is not judged from the title; read again next run', { text_missing: true, service_error: true, fetch_error: true });
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
  // A state bill no passage of which meets the criterion of any section its status allows (agents/rules.mjs SECTION_CRITERIA): the
  // pipeline cannot file it anywhere, so no AI is spent on it. Held (not read again until its record changes) and reported.
  if (operation === 'create' && item.source === 'legiscan' && sections && !sections.length) {
    const t = raw.bill && raw.bill.title;
    return held(`not created: no passage of the text meets the criterion of section ${derivedNow.allowed.join(', ')} (${derivedNow.allowed.map((s) => `${s}: ${SECTION_CRITERIA[s]}`).join('; ')})`, { no_section: true, proposal: `${item.item_id}${t ? ` ("${String(t).slice(0, 80)}")` : ''} meets no state section's criterion; not created` });
  }

  // A federal bill no passage of which meets section D's or F's criterion (agents/rules.mjs): it cannot be filed in either, so no AI is
  // spent on it. Held (read again only when its record changes) and reported, as for a state bill.
  // Round 4: F is not proved by code for a bill whose own title names one of F's OUT subjects (education, workforce, children, energy ...).
  const fedTitle = (raw.bill && raw.bill.title) || item.title;
  if (operation === 'create' && item.source === 'congress_gov' && !sectionPassage('D', source) && (!sectionPassage('F', source) || fTitleOut(fedTitle))) {
    return held(`not created: no passage of the text meets the criterion of section D or F${fTitleOut(fedTitle) ? ` (its title names a subject F excludes: "${String(fedTitle).slice(0, 80)}")` : ''} (D: ${SECTION_CRITERIA.D}; F: ${SECTION_CRITERIA.F})`, { no_section: true, proposal: `${item.item_id}${item.title ? ` ("${String(item.title).slice(0, 80)}")` : ''} meets neither federal section's criterion; not created` });
  }

  // A very long source in which no frontier-AI section or passage was found: whether it is in scope is judged on its opening. If both
  // readers (and the referee) say it is out of scope we are done; otherwise it is held and reported.
  if (operation === 'create' && source.length > TRIAGE_OVER && read === source) {
    const head = source.slice(0, TRIAGE_CHARS);
    const note = { kind: 'candidate', detail: `NOTE: SOURCE below is incomplete: it is cut off after its first ${TRIAGE_CHARS} characters because the full text is ${source.length} characters, and no frontier-AI term appears anywhere in the rest. Decide ONLY in_scope and scope_reason; leave "fields" empty.` };
    const g = await generatePatch({ llm: generator, item, source: head, entry, reasons: [...diff.reasons, note], operation, styleExamples: [], feedback: [], previousPatch: null, sections });
    if (g.patch && g.patch.in_scope === false) {
      const scopeClaim = [{ field: 'in_scope', claim: SCOPE_CLAIM }];
      let res; try { res = await validator.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: head, claims: scopeClaim }), responseSchema: VERDICT_SCHEMA, itemId: item.item_id }); } catch (e) { if (!(e instanceof LlmOutputError)) throw e; }
      const r = res && res.data && res.data.results && res.data.results[0];
      if (r && r.supported === false && (await refereeSays(referee, head, item.item_id, source)) !== true) return { item_id: item.item_id, outcome: 'out_of_scope', operation, attempts: 1, entry: null, patch: g.patch, verdicts, reason: `${g.patch.scope_reason} (judged on the first ${TRIAGE_CHARS} characters of a ${source.length}-character text in which no frontier-AI term appears)` };
    }
    return { ...held(`source too long for automatic processing (${source.length} characters), no frontier-AI section or term was found in it, and it may be in scope; held until its record changes`, { proposal: `${item.item_id}: a ${source.length}-character text with no frontier-AI term that the readers did not both rule out; not created` }), attempts: 1, patch: g.patch || null };
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
    // A compute threshold copied with its superscript lost ("10.26 computational operations"): the one unambiguous repair, 10^26 (any
    // other implausible figure is left for the numeric check to refuse; agents/checks.mjs thresholdNumberProblems).
    for (const k of ['mechanism', 'thresholds', 'penalties']) if (typeof patch.fields[k] === 'string') patch.fields[k] = normaliseExponents(patch.fields[k]);
    previousPatch = patch;

    // The Generator says "not about frontier AI": let the independent reader confirm before anything is dropped.
    if (operation === 'create' && patch.in_scope === false) {
      const scopeClaim = [{ field: 'in_scope', claim: SCOPE_CLAIM }];
      let res;
      try { res = await validator.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: read, claims: scopeClaim }), responseSchema: VERDICT_SCHEMA, itemId: item.item_id }); }
      catch (e) { if (!(e instanceof LlmOutputError)) throw e; }
      const r = res && res.data && res.data.results && res.data.results[0];
      // Both readers say out, or they disagree: the referee decides. Without a referee, both saying out drops it; a disagreement gets one firm retry.
      const ref = (await askReferee()).in;
      if (ref === false || (ref === null && r && r.supported === false)) return { item_id: item.item_id, outcome: 'out_of_scope', operation, attempts: attempt, entry: null, patch, verdicts, reason: patch.scope_reason + (ref === false ? ' (confirmed by the referee)' : '') };
      if (scopeRetries++ >= 1) return { ...held(`scope disagreement: the generator still says out of scope ("${patch.scope_reason}") after ${ref === true ? 'the referee ruled it in scope' : 'the independent reader said in scope'}`), attempts: attempt, patch, verdicts };
      feedback = [IN_SCOPE_NOW(sections)]; continue;
    }

    const asm = assembleEntry({ entry, patch, item, raw, today, runId, rounds: attempt, entries, now });
    // The same programme as a tracked entry of its state, under another bill (CT H.B. 5222 re-enacting P.A. 26-15's IVO pilot): never
    // created, and no more AI is spent on it. Held until its record changes and reported as a possible duplicate or update.
    // A refile under a new number (a later session) or a companion with no record link: its description is nearly a tracked entry's.
    if (operation === 'create' && asm.entry) {
      const p = refileOf(asm.entry, entries);
      if (p) return { ...held(`${p.why} (entry ${p.key}); not created`, { possible_duplicate: p.key, proposal: `${item.item_id} (${asm.entry.short_name}) may duplicate or update entry ${p.key}: ${p.why}` }), attempts: attempt, patch, verdicts };
    }
    if (operation === 'create' && asm.entry && asm.entry.state) {
      const p = programmeDuplicateOf(asm.entry, entries);
      if (p) return { ...held(`${p.why} (entry ${p.key}); not created`, { possible_duplicate: p.key, proposal: `${item.item_id} (${asm.entry.short_name}) may duplicate or update entry ${p.key}: ${p.why}` }), attempts: attempt, patch, verdicts };
    }
    const verdict = await validateDraft({ llm: validator, patch, before: entry, after: asm.entry, assembleProblems: asm.problems, source: item.source, sourceText: source, readText: read, entries, operation, itemId: item.item_id, run_id: runId, attempt });
    const objection = verdict.claims.find((c) => c.field === 'in_scope' && !c.supported);
    const settle = (quote) => { objection.supported = true; objection.evidence_quote = quote; delete objection.reason; verdict.passed = verdict.code_checks.every((c) => c.passed) && verdict.claims.every((c) => c.supported); };
    if (objection && QUOTE_FAILED.test(objection.reason || '')) {
      // The reader said "in scope" but its quote was not in the source: that is a failed quote, never an "out" verdict. One retry for an
      // exact quote, then the referee; neither proving it holds the item (and reports it), it is never ruled out on this path.
      const again = await exactScopeQuote(validator, read, item.item_id, source);
      if (again) settle(again.quote);
      else {
        const ref = await askReferee();
        if (ref.in === true) settle(ref.quote);
        else return { ...held(`the scope was not proved: the independent reader said in scope twice without a quote found in the source, and the referee ${ref.in === false ? `ruled it out ("${String(ref.reason || '').slice(0, 140)}")` : `did not confirm it with a quote${ref.why ? ` (${ref.why})` : referee ? '' : unconfirmedOnly ? ' (not asked: new entries are switched off)' : ' (no referee is configured)'}`}`, { proposal: `${item.item_id}: scope not proved (the readers' quotes were not in the source${ref.in === false ? '; the referee says out' : ''}); not created` }), attempts: attempt, patch, verdicts: [...verdicts, verdict] };
      }
    } else if (objection && referee) {
      // The reader objects to the scope of an item the generator wrote up: the referee decides, once per item.
      const ref = await askReferee();
      if (ref.in === false) return { item_id: item.item_id, outcome: 'out_of_scope', operation, attempts: attempt, entry: null, patch, verdicts: [...verdicts, verdict], reason: `${(objection.reason || 'out of scope').slice(0, 200)} (confirmed by the referee)` };
      if (ref.in === true) settle(ref.quote);
    }
    verdicts.push(verdict); last = { patch, asm, verdict };
    log(`attempt ${attempt}: ${verdict.passed ? 'passed' : 'rejected (' + complaints(verdict).length + ' problem(s))'}`);
    if (verdict.passed) {
      if (operation === 'create') {
        // The generator and the reader may be the same model: a new entry is published only when the referee (a different, stronger
        // model) also rules it in scope, with a quote code finds in the source. No referee, no usable answer, or "out": held and reported.
        // New entries switched off: the readers' draft is reported as a proposal, never as confirmed, and no referee is asked.
        if (unconfirmedOnly) return { ...held('the readers say in scope, but it is not confirmed: new entries are switched off, so the referee was not asked and nothing is created', { unconfirmed: true, proposal: `${item.item_id} (${asm.entry.short_name}, section ${asm.entry.section}): proposal from the readers, not confirmed: new entries are switched off; not created` }), attempts: attempt, patch, verdicts };
        const ref = await askReferee();
        if (ref.in !== true) return { ...held(ref.in === false ? `the referee rules it out of scope after both readers said in ("${String(ref.reason || '').slice(0, 160)}"); held until its record changes` : `the referee did not confirm the scope with a quote found in the source${ref.why ? ` (${ref.why})` : referee ? '' : ' (no referee is configured)'}`, { proposal: `${item.item_id}: the readers say in scope, the referee ${ref.in === false ? 'says out' : 'gave no quote'}; not created` }), attempts: attempt, patch, verdicts };
        asm.entry.evidence = [...(asm.entry.evidence || []), { field: 'in_scope', quote: ref.quote, source_url: item.source_url }];
        // A state entry's section is published only with the referee's quote meeting that section's own criterion (checked by code).
        // So is a federal D or F entry (round 3: the federal sections' criteria, agents/rules.mjs).
        if (SECTION_RULES[asm.entry.section] && (SECTION_RULES[asm.entry.section].level === 'state' || FEDERAL_CHECKED_SECTIONS.includes(asm.entry.section))) {
          const s = await refereeSection(referee, read, asm.entry.section, item.item_id, source);
          if (!s.ok) return { ...held(`section ${asm.entry.section} not proved: ${s.why}`, { proposal: `${item.item_id} (${asm.entry.short_name}): section ${asm.entry.section} not proved (${s.why}); not created` }), attempts: attempt, patch, verdicts };
          asm.entry.evidence.push({ field: 'section', quote: s.quote, source_url: item.source_url });
        }
      }
      // A new bill (federal or state) also gets its 13 duty answers, each proved on its own (agents/duties.mjs). An A or B entry (a
      // frontier law or bill) is never published without them: it is held (retried once by the escalated pass).
      if (operation === 'create' && (item.source === 'congress_gov' || item.source === 'legiscan') && DUTY_SECTIONS.includes(asm.entry.section)) {
        const d = await writeDuties({ generator, validator, entry: asm.entry, sourceText: source, readText: read, sourceUrl: item.source_url, itemId: item.item_id, now, log });
        if (d.duties) Object.assign(asm.entry, { duties: d.duties, duties_basis: d.duties_basis });
        // The duty schema (and the site) has no "unknown" answer: not_in_bill says the text is silent, which an excerpt cannot prove. An
        // unproved answer therefore holds the entry: retried once by the escalated pass, then held until the record changes (agents/run.mjs
        // remembers it by the record's hash, so it is not read again every run) and reported, naming the duties left unproved.
        else if (DUTY_REQUIRED_SECTIONS.includes(asm.entry.section)) return { ...held(`a section ${asm.entry.section} entry is not published without its duty answers, and they were not proved: ${d.reason}`, { retryable: !/every answer was not_in_bill/.test(d.reason || ''), proposal: `${item.item_id} (${asm.entry.short_name}, section ${asm.entry.section}): in scope, but duty answer(s) ${(d.dropped || []).join(', ') || '(all)'} could not be proved and the duty schema has no "not stated" answer; held until its record changes` }), attempts: attempt, patch, verdicts, duties: { added: false, rounds: d.rounds, dropped: d.dropped, reason: d.reason } };
        return { item_id: item.item_id, outcome: 'publishable', operation, attempts: attempt, entry: asm.entry, patch, verdicts, reason: null, duties: { added: !!d.duties, rounds: d.rounds, dropped: d.dropped, reason: d.reason } };
      }
      return { item_id: item.item_id, outcome: 'publishable', operation, attempts: attempt, entry: asm.entry, patch, verdicts, reason: null };
    }
    // The generator says "in scope" and the reader says "out" (twice): stop, do not keep arguing. Held and reported as a scope proposal.
    if (verdict.claims.some((c) => c.field === 'in_scope' && !c.supported) && ++scopeObjections >= 2) {
      const why = (verdict.claims.find((c) => c.field === 'in_scope').reason || '').slice(0, 160);
      return { ...held(`scope disagreement: the generator says in scope but the independent reader says out of scope ("${why}"); held until its record changes`, { proposal: `${item.item_id}: scope disagreement (generator in, reader out: "${why.slice(0, 100)}"); a scope rule for cases like this would settle it` }), attempts: attempt, patch, verdicts };
    }
    feedback = complaints(verdict);
  }
  return { ...held(`still failing after ${maxRounds} rounds: ${(feedback[0] || 'unusable answers').slice(0, 200)}`, { retryable: true }), attempts: maxRounds, patch: last && last.patch, verdicts };
}
