// The Validator. Two independent layers:
//   1) plain-code checks (checks.mjs): schema, quotes found verbatim in the source, numbers and dates present in the source
//   2) an independent LLM pass that sees ONLY the source and a numbered list of claims, never the Generator's reasoning
// A draft passes only if every code check passes and every claim is supported.
import { VALIDATOR_SYSTEM, validatorPrompt, SCOPE_DEFINITION } from './prompts.mjs';
import { runChecks } from './checks.mjs';
import { containsQuote } from './source-text.mjs';
import { LlmOutputError } from '../llm/gemini.mjs';
import { makeValidator } from '../schema/validate.mjs';

const schema = makeValidator();
const TEXT = ['title', 'sponsor_text', 'mechanism', 'thresholds', 'penalties', 'status_text', 'signed_text', 'effective_text'];

// The claims the independent reader must check, derived by code from the patch.
export function buildClaims({ patch, operation }) {
  const claims = [];
  for (const f of TEXT) if (typeof patch.fields[f] === 'string' && patch.fields[f]) claims.push({ field: f, claim: patch.fields[f] });
  patch.events_add.forEach((e, i) => claims.push({ field: `events_add[${i}]`, claim: `On ${e.date} (${e.type}): ${e.text}` }));
  if (operation === 'create' && patch.in_scope) claims.push({ field: 'in_scope', claim: `This item regulates or directly concerns frontier / large-scale AI developers or models, as defined here: ${SCOPE_DEFINITION}` });
  return claims;
}

export async function validateDraft({ llm, patch, before, after, assembleProblems, source, sourceText, entries, operation, itemId, run_id, attempt }) {
  const code_checks = runChecks({ patch, before, after, assembleProblems, source, sourceText, entries, operation });
  const claims = [], verdict = { run_id, item_id: itemId, attempt, passed: false, code_checks, claims };
  const codePassed = code_checks.every((c) => c.passed);

  // Even when a code check failed, the independent reader still runs, so the Generator gets every complaint at once and not one per round.
  const list = after ? buildClaims({ patch, operation }) : [];
  if (list.length) {
    let res;
    try { res = await llm.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: sourceText, claims: list }), itemId }); }
    catch (e) {
      if (!(e instanceof LlmOutputError)) throw e;
      list.forEach((c) => claims.push({ field: c.field, claim: c.claim, supported: false, evidence_quote: null, reason: `the independent reader gave an unusable answer (${e.message}); treated as unsupported` }));
      return verdict;
    }
    const byN = new Map(((res.data && res.data.results) || []).map((r) => [r.n, r]));
    list.forEach((c, i) => {
      const r = byN.get(i + 1);
      if (!r) return claims.push({ field: c.field, claim: c.claim, supported: false, evidence_quote: null, reason: 'the independent reader did not answer for this claim' });
      let supported = r.supported === true, reason = r.reason || undefined;
      if (supported && !containsQuote(sourceText, r.quote)) { supported = false; reason = 'the reader marked it supported but its quote does not appear in the source'; }
      claims.push({ field: c.field, claim: c.claim, supported, evidence_quote: supported ? r.quote : (r.quote && containsQuote(sourceText, r.quote) ? r.quote : null), ...(supported ? {} : { reason: reason || 'not supported by the source' }) });
    });
  }
  verdict.passed = codePassed && claims.every((c) => c.supported);
  const errs = schema.check('verdict', verdict);
  if (errs.length) throw new Error('verdict failed its own schema: ' + errs.join('; '));
  return verdict;
}

// What the Generator is told to fix, from a failed verdict.
export function complaints(verdict) {
  return [
    ...verdict.code_checks.filter((c) => !c.passed).map((c) => `${c.name.replace(/_/g, ' ')}: ${c.detail || 'failed'}`),
    ...verdict.claims.filter((c) => !c.supported).map((c) => c.field === 'in_scope'
      ? `An independent reader judged this item OUT of scope for the tracker: ${c.reason} If you agree, set in_scope to false and leave "fields" and "events_add" empty.`
      : `claim about ${c.field} ("${c.claim.slice(0, 120)}") is not supported: ${c.reason}`)
  ];
}
