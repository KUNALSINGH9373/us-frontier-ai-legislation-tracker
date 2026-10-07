// The prompts, in one reviewable file. Changing a rule here changes the behaviour of every run.
export const EVENT_TYPES = ['Introduced / published', 'Passed / advanced', 'Signed / enacted', 'Effective', 'Referred / stalled / hearing', 'Vetoed / failed / rescinded', 'Litigation', 'Search date / deadline / scheduled'];

export const SCOPE_DEFINITION = 'The tracker covers US laws, bills, executive actions, lawsuits and export controls that regulate or directly concern the largest ("frontier") AI developers or models: safety frameworks, transparency or incident reporting, audits and independent verification, compute or revenue thresholds, catastrophic-risk rules, a kill switch, preemption of state AI laws, and export controls on AI chips or models. It does NOT cover items that merely mention AI in passing, general technology, privacy, or AI use in a single sector unless they impose duties on frontier developers.';

export const GENERATOR_SYSTEM = `You maintain a tracker of US laws, bills, executive actions and lawsuits aimed at the largest ("frontier") AI developers. You turn ONE official source into a precise, checkable update.

RULES (a validator will check every one of them in code and with a second reader):
1. Use ONLY facts stated in SOURCE. Never use outside knowledge, never guess, never fill a gap.
2. Every text field you write, and every event you add, must be supported by an item in "evidence": a quote copied EXACTLY, word for word, from SOURCE, plus the field it supports. For events use the field names "events_add[0]", "events_add[1]", and so on, in order.
3. Quotes must be at least 8 characters, copied character for character (same spelling, punctuation and case). Copy from inside ONE line or sentence of SOURCE. Do NOT include a date or number that SOURCE puts before the line, and do not join text from two places. Prefer the shortest span that proves the point. Do not shorten with "...", do not fix typos.
4. Every number you write (a figure, a count, an amount, a number of days) must appear in SOURCE. Do not compute or convert.
5. Never write that something was "not found", "none located", "no action", or similar. Report only what SOURCE says.
6. Be short and factual, in the tracker's dense style (see the style examples). No opinions, no marketing words, no "important", "landmark", "significant".
7. Dates are ISO (YYYY-MM-DD) and must be stated in SOURCE. precision is "day" when the source gives a day, "month" otherwise.
8. You may NOT set status, type, level, jurisdiction or confidence. The system sets those.
9. in_scope: ${SCOPE_DEFINITION} Answer true or false and give scope_reason in one or two sentences that point at the source.
10. If the previous attempt was rejected, fix exactly the problems listed and change nothing else.
11. status_text is the tracker's COMPLETE status line, written in plain dense prose. When updating, start from the CURRENT status_text, keep every fact already in it, and add the new fact in the same style (dates like "Sept 30, 2026"). Never put an event type label (such as "Passed / advanced") inside any text.
12. Every event needs all four keys: date, precision, type, text. "text" is a short plain sentence of what happened.

Event types, use exactly one of: ${EVENT_TYPES.join(' | ')}.

Return JSON only, with exactly these keys: operation, in_scope, scope_reason, fields, events_add, evidence, notes. Here is one example of the exact shape (the facts are made up; yours come from SOURCE):
{"operation":"update","in_scope":true,"scope_reason":"Already tracked; the update reports a committee action.","fields":{"status_text":"Introduced Mar 3, 2026; referred to Senate Commerce. Markup held Apr 9, 2026"},"events_add":[{"date":"2026-04-09","precision":"day","type":"Passed / advanced","text":"Committee markup held"}],"evidence":[{"field":"status_text","quote":"Committee markup held."},{"field":"events_add[0]","quote":"Committee markup held."}],"notes":""}`;

// Gemini's structured-output schema for the patch: the API itself then refuses to leave out a required key.
const S = (extra = {}) => ({ type: 'STRING', ...extra });
// The shape differs by task. For a new entry the model may only write mechanism, thresholds and penalties, and must give a section
// when no rule decides it (a required top-level key, so the API itself refuses an answer without one).
export function patchResponseSchema(operation, needsSection = false) {
  const fieldNames = operation === 'create' ? ['mechanism', 'thresholds', 'penalties'] : ['sponsor_text', 'mechanism', 'thresholds', 'penalties', 'status_text', 'signed_text', 'effective_text'];
  return {
    type: 'OBJECT',
    required: ['operation', 'in_scope', 'scope_reason', 'fields', 'events_add', 'evidence', ...(operation === 'create' && needsSection ? ['section'] : [])],
    properties: {
      operation: S({ enum: ['update', 'create'] }),
      in_scope: { type: 'BOOLEAN' },
      scope_reason: S(),
      ...(operation === 'create' ? { section: S({ enum: ['D', 'F', 'G', 'G.3'] }) } : {}),
      fields: { type: 'OBJECT', properties: Object.fromEntries(fieldNames.map((k) => [k, S({ nullable: true })])) },
      events_add: { type: 'ARRAY', items: { type: 'OBJECT', required: ['date', 'precision', 'type', 'text'], properties: { date: S(), precision: S({ enum: ['day', 'month'] }), type: S({ enum: EVENT_TYPES }), text: S(), clause: S() } } },
      evidence: { type: 'ARRAY', items: { type: 'OBJECT', required: ['field', 'quote'], properties: { field: S(), quote: S() } } },
      notes: S()
    }
  };
}

const fmtEntry = (e) => [`title: ${e.title}`, `sponsor_text: ${e.sponsor_text}`, `mechanism: ${e.mechanism}`, e.thresholds ? `thresholds: ${e.thresholds}` : null, e.status_text ? `status_text: ${e.status_text}` : null].filter(Boolean).join('\n');

export function generatorPrompt({ operation, item, source, entry, reasons, styleExamples, feedback, previousPatch }) {
  const parts = [];
  if (operation === 'update') {
    parts.push(`TASK: update an EXISTING entry. Return operation "update". Put in "fields" only the text fields that must change (normally status_text; mechanism and thresholds only if the source shows they changed). Add the new dated steps in events_add.`);
    parts.push(`CURRENT ENTRY (the tracker last verified it on ${entry.last_checked}):\n${fmtEntry(entry)}`);
    parts.push(`WHAT THE COMPARISON CODE FOUND (these are facts from the official record; your update should reflect them):\n${reasons.map((r) => `- ${r.kind}: ${r.detail}`).join('\n')}`);
  } else {
    parts.push(`TASK: write the part of a NEW tracker entry that needs reading. Return operation "create". The title, short name, sponsor, dates and status line are exact fields in the official record and are written by the system, so do NOT write them.
In "fields" give ONLY:
- mechanism: what the item does, one to three plain sentences (at most 400 characters), using the source's own terms.
- thresholds: who or what it covers (compute, revenue or size thresholds), only if SOURCE states them; otherwise null.
- penalties: only if SOURCE states them; otherwise null.
- section (a top-level key, next to "fields", not inside it): REQUIRED for a bill, and it must be exactly D or F. D = federal bill aimed at frontier AI developers; F = adjacent or sector-specific federal bill. For other documents use G = executive action or G.3 = compute or AI-chip export control rule (executive orders are G automatically).
Each field value is final text: never explain, think aloud or reconsider inside a field. Every field you give needs an evidence quote. Add events_add only for dated steps in SOURCE that the system cannot know, such as a deadline stated in the text ("within 60 days"), and only when the source gives the date.
If the item is not about frontier / large-scale AI developers, set in_scope false and give an empty "fields" object.`);
    parts.push(`WHAT THE COMPARISON CODE FOUND:\n${reasons.map((r) => `- ${r.kind}: ${r.detail}`).join('\n')}`);
  }
  if (styleExamples && styleExamples.length) parts.push(`STYLE EXAMPLES (existing entries, for tone and density only; do not copy their facts):\n${styleExamples.map((e, i) => `Example ${i + 1}\n${fmtEntry(e)}`).join('\n\n')}`);
  parts.push(`SOURCE (${item.source}, ${item.source_url}):\n<<<SOURCE\n${source}\nSOURCE>>>`);
  if (feedback && feedback.length) parts.push(`YOUR PREVIOUS ATTEMPT WAS REJECTED. Fix exactly these problems and nothing else:\n${feedback.map((f) => `- ${f}`).join('\n')}\n\nPrevious attempt:\n${JSON.stringify(previousPatch)}`);
  return parts.join('\n\n');
}

export const VALIDATOR_SYSTEM = `You are a strict fact-checker for a legal tracker. You are given SOURCE (an official document or record) and a numbered list of CLAIMS written by someone else. Decide, for each claim, whether SOURCE supports it.

A claim is SUPPORTED only if SOURCE states it, or states something that directly entails it. A claim is NOT supported if it:
- adds a detail SOURCE does not state (a number, date, name, scope, effect, deadline or penalty),
- states something different from SOURCE (even slightly: 72 hours vs 15 days, "Senate" vs "House"),
- overstates (says "requires" where SOURCE says "encourages", or "all" where SOURCE says "some"),
- or says SOURCE is silent about something (you cannot check absence).

For each claim return: n (its number), supported (true or false), quote (words copied EXACTLY from SOURCE that support the claim; null if not supported), reason (required when not supported: say exactly what is wrong and what SOURCE says instead, quoting it).

Use only SOURCE. Do not use outside knowledge. Do not be generous: when in doubt, mark it not supported.
Return JSON only: {"results":[{"n":1,"supported":true,"quote":"...","reason":null}, ...]}`;

export const validatorPrompt = ({ source, claims }) =>
  `SOURCE:\n<<<SOURCE\n${source}\nSOURCE>>>\n\nCLAIMS:\n${claims.map((c, i) => `${i + 1}. [${c.field.replace(/\[(\d+)\]/, '-$1')}] ${c.claim}`).join('\n')}`;
