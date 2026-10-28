// The Generator: reads one source and proposes a patch. It never sets status, type, level or confidence.
import { GENERATOR_SYSTEM, generatorPrompt, patchResponseSchema } from './prompts.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { LlmOutputError } from '../llm/gemini.mjs';

const validator = makeValidator();
const EVIDENCE_FIELDS = /^(title|sponsor_text|mechanism|thresholds|penalties|status_text|signed_text|effective_text|events_add\[\d+\])$/;
const PATCH_KEYS = new Set(['operation', 'in_scope', 'scope_reason', 'fields', 'events_add', 'evidence', 'notes', 'section']); // schema/pipeline.schema.json "patch"

// Models label things loosely. This maps the common variants onto the names the checks use, and drops evidence for items
// that are not facts from the source ("scope_reason", "section"), so a harmless label never fails a round.
export function normalisePatch(patch) {
  // An extra top-level key (a model's own "reasoning" or "summary") carries nothing the checks use: dropped, not a failed round.
  for (const k of Object.keys(patch)) if (!PATCH_KEYS.has(k)) delete patch[k];
  patch.events_add = patch.events_add || []; patch.evidence = patch.evidence || []; patch.fields = patch.fields || {};
  // A model often fills a field it was told to skip with null or "". That means "no value", not an error.
  for (const k of ['title', 'short_name', 'section', 'sponsor_text', 'mechanism']) if (patch.fields[k] == null || patch.fields[k] === '') delete patch.fields[k];
  if (patch.section && !patch.fields.section) patch.fields.section = patch.section;
  delete patch.section;
  patch.evidence = patch.evidence.map((e) => ({ ...e, field: normField(e.field) })).filter((e) => EVIDENCE_FIELDS.test(e.field));
  return patch;
}

// "fields.mechanism", "fields['mechanism']", "events_add.0", "events_add-0"  ->  "mechanism", "mechanism", "events_add[0]", "events_add[0]"
export function normField(f) {
  let s = String(f || '').trim();
  const m = /^fields(?:\.|\[\s*['"]?)(.+?)['"]?\]?$/.exec(s);
  if (m) s = m[1];
  return s.replace(/^events_add[.-](\d+)$/, 'events_add[$1]');
}

// Returns { patch, problems }. problems is non-empty when the model's answer was not a valid patch (the loop treats that as a failed attempt).
export async function generatePatch({ llm, item, source, entry, reasons, operation, styleExamples, feedback, previousPatch, needsSection = false, sections = null }) {
  const prompt = generatorPrompt({ operation, item, source, entry, reasons, styleExamples, feedback, previousPatch, sections });
  let res;
  try { res = await llm.generate({ system: GENERATOR_SYSTEM, prompt, itemId: item.item_id, responseSchema: patchResponseSchema(operation, needsSection, sections) }); }
  catch (e) {
    if (e instanceof LlmOutputError) return { patch: null, problems: [`your answer was unusable: ${e.message}.${/max_tokens/i.test(e.message) ? ' It was far too long. Keep every field to one to three short sentences and do not explain, think aloud or reconsider inside a field.' : ''}`], usage: null };
    throw e;
  }
  const patch = res.data;
  if (patch && patch.operation && patch.operation !== operation) return { patch: null, problems: [`operation must be "${operation}"`], usage: res.usage };
  if (patch && typeof patch === 'object') normalisePatch(patch);
  const errs = validator.check('patch', patch);
  if (errs.length) return { patch: null, problems: errs.slice(0, 5).map((e) => `your JSON does not match the required shape: ${e}`), usage: res.usage };
  return { patch, problems: [], usage: res.usage };
}
