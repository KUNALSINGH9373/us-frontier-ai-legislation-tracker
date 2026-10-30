// The prompts, in one reviewable file. Changing a rule here changes the behaviour of every run.
export const EVENT_TYPES = ['Introduced / published', 'Passed / advanced', 'Signed / enacted', 'Effective', 'Referred / stalled / hearing', 'Vetoed / failed / rescinded', 'Litigation', 'Search date / deadline / scheduled'];

// Owner-approved 16 Oct 2026, written from the tracker's own sections A-I and its section J exclusion reasons. Widened by the owner
// on 27 Oct 2026 (type 8): defence and intelligence AI safety programs, and AI-agent control standards, for any AI system.
export const SCOPE_DEFINITION = "The tracker covers US laws, bills, drafts, executive actions, lawsuits and export controls aimed at the largest (\"frontier\") AI developers and at catastrophic risk from advanced AI models. IN scope: (1) duties on frontier or large developers or on advanced or frontier models: safety frameworks or plans, transparency or model reports, pre-deployment testing or evaluation, incident reporting, kill switches or shutdown, loss-of-control or catastrophic-risk rules (weapons, cyberattacks, mass casualties), compute, revenue or capability thresholds, and liability for harms from such models; (2) independent verification organizations, AI auditor licensing or registries, and studies of them; (3) whistleblower protections for workers at AI developers; (4) federal programs, agencies or boards that test, evaluate, monitor or investigate advanced-AI risks, including defence and national-security AI safety, reliability and incident reporting; (5) preemption of state AI laws, or federal frameworks meant to replace them; (6) export controls, licensing or security rules for advanced AI chips, compute or model weights; (7) frontier-AI provisions inside broader laws (such as a defence authorization or an omnibus act); (8) these two kinds of federal measure, which are in scope for ANY AI system, with no advanced-AI, frontier, size, compute or capability link needed: (a) AI safety, reliability, testing or incident-reporting programs of the Defense Department or the intelligence community; (b) standards or requirements for discovering, tracking, monitoring or keeping control over autonomous AI agents (agent inventories, runtime monitoring, the ability to stop an agent), even when they apply to every organization. OUT of scope (the tracker lists such items as excluded): bills that only regulate AI use in one sector or one kind of decision (hiring, insurance, health, housing, \"consequential decisions\", automated decision tools); children's online safety, social media, addictive feeds and companion chatbots; deepfakes and election content; government procurement or use of AI (except the defence and intelligence safety programs in type (8)); data-centre siting, energy or permits; workforce or economic studies; and laws that apply to any AI user or deployer with no size, compute or capability threshold, unless they also impose a duty of types (1) to (8). Two common mistakes (29 Oct 2026 field eval): (i) a revenue, user or size figure that only exempts smaller companies from an OUT-list rule (for example a companion-chatbot or child-safety audit that spares operators under $500,000,000 in revenue) does not make the item frontier-AI: judge what the duties are about, not whether a figure appears; (ii) safety-testing, audit or reporting duties on every AI company or every AI system, with no frontier, compute or capability threshold, are OUT (except the federal measures of type (8)).";

export const GENERATOR_SYSTEM = `You maintain a tracker of US laws, bills, executive actions and lawsuits aimed at the largest ("frontier") AI developers. You turn ONE official source into a precise, checkable update.

RULES (a validator will check every one of them in code and with a second reader):
1. Use ONLY facts stated in SOURCE. Never use outside knowledge, never guess, never fill a gap.
2. Every text field you write, and every event you add, must be supported by an item in "evidence": a quote copied EXACTLY, word for word, from SOURCE, plus the field it supports. For events use the field names "events_add[0]", "events_add[1]", and so on, in order.
3. Quotes must be at least 8 characters, copied character for character (same spelling, punctuation and case). Copy from inside ONE line or sentence of SOURCE. Do NOT include a date or number that SOURCE puts before the line, and do not join text from two places. Prefer the shortest span that proves the point. Do not shorten with "...", do not fix typos.
4. Every number you write (a figure, a count, an amount, a number of days) must appear in SOURCE. Do not compute or convert. Write each number exactly as SOURCE writes it: if SOURCE says "10^26" write 10^26 (not 10²⁶ or 1e26); if it says "$500,000,000" write $500,000,000 (not $500M).
5. Never write that something was "not found", "none located", "no action", or similar. Report only what SOURCE says.
6. Be short and factual, in the tracker's dense style (see the style examples). No opinions, no marketing words, no "important", "landmark", "significant".
7. Dates are ISO (YYYY-MM-DD) and must be stated in SOURCE. precision is "day" when the source gives a day, "month" otherwise.
8. You may NOT set status, type, level, jurisdiction or confidence. The system sets those.
9. in_scope: ${SCOPE_DEFINITION} Answer true or false and give scope_reason in one or two sentences that point at the source.
10. If the previous attempt was rejected, fix exactly the problems listed and change nothing else.
11. status_text is the tracker's COMPLETE status line, written in plain dense prose. When updating, start from the CURRENT status_text, keep every fact already in it, and add the new fact in the same style (dates like "Sept 30, 2026"). Never put an event type label (such as "Passed / advanced") inside any text.
12. Every event needs all four keys: date, precision, type, text. "text" is a short plain sentence of what happened.
13. Every number and deadline says what it measures and from when ("within 30 days of enactment", "90 days after the Board is established"). Never move a number to a different step than SOURCE gives it. Its evidence quote must contain both the number and what it applies to.
14. Keep the legal force SOURCE gives: "shall" or "must" is a duty, "may" is a power, "voluntary" is voluntary, an incentive (a liability shield, a presumption, a safe harbor, immunity) is an incentive. Never turn a mandate into "standards" or "guidance", a requirement into "consider", or a voluntary programme into a mandate. Use the source's own verb.
15. Words you put inside quotation marks must be copied word for word from SOURCE. Paraphrase without quotation marks.
16. Write every date with its year ("Sept 30, 2026"). Describe status only from official actions SOURCE records: never predict the next step (no "conference pending", "expected to pass") and never mention the date you read SOURCE.
17. Before saying a term is undefined, read the definitions section. If SOURCE defines it, give the definition.
18. Titles: use the official title SOURCE gives. A popular name is allowed only as "called ... by its sponsors".


Event types, use exactly one of: ${EVENT_TYPES.join(' | ')}.

Return JSON only, with exactly these keys: operation, in_scope, scope_reason, fields, events_add, evidence, notes. Here is one example of the exact shape (the facts are made up; yours come from SOURCE):
{"operation":"update","in_scope":true,"scope_reason":"Already tracked; the update reports a committee action.","fields":{"status_text":"Introduced Mar 3, 2026; referred to Senate Commerce. Markup held Apr 9, 2026"},"events_add":[{"date":"2026-04-09","precision":"day","type":"Passed / advanced","text":"Committee markup held"}],"evidence":[{"field":"status_text","quote":"Committee markup held."},{"field":"events_add[0]","quote":"Committee markup held."}],"notes":""}`;

// The scope test, said the same way to both readers. Types (2) to (8) need not name a frontier developer or threshold: a whistleblower
// law, an investigative board, a study of AI auditors or AI-agent control standards are in scope as they stand. Only the OUT list rules an item out.
export const SCOPE_TEST = 'Scope: go through IN-scope types (1) to (8) of the scope definition one by one before ruling the item out. An item that matches any one type is in scope, even if it never mentions frontier developers, compute or a size threshold: types (2) to (8) do not need one. Set in_scope false only when it matches none of the eight types (for example it falls only under the OUT list), and then give an empty "fields" object.';
// The scope claim is a classification, not a fact SOURCE states: no bill says "this falls under type (6)". The reader judges it from
// what the provisions do (H.R. 9442's Sec. 4 export controls on advanced AI chips, a study of AI auditors), quoting the provision that
// places the item in a type. "SOURCE does not state a scope classification" is never a reason to mark it unsupported.
export const SCOPE_CLAIM = `This item falls within at least one of the IN-scope types (1) to (8) of the scope definition below (types (2) to (8) need no frontier, compute or size threshold). HOW TO JUDGE THIS CLAIM: it is a classification that you make yourself from what the provisions of SOURCE do; SOURCE will not name a type, use the word "scope" or classify itself, and that is never a reason to mark this claim unsupported. Read the provisions (all of them, not only the title or opening), decide whether any provision does what one of the eight types describes, and if one does, mark the claim supported and quote that provision word for word (the quote must show what it does). Mark it unsupported only when no provision matches any type (for example the item falls only under the OUT list), and then say which OUT-list item it falls under. Scope definition: ${SCOPE_DEFINITION}`;

// Gemini's structured-output schema for the patch: the API itself then refuses to leave out a required key.
const S = (extra = {}) => ({ type: 'STRING', ...extra });
// The shape differs by task. For a new entry the model may only write mechanism, thresholds and penalties, and must give a section
// when no rule decides it (a required top-level key, so the API itself refuses an answer without one).
export function patchResponseSchema(operation, needsSection = false, sections = null) {
  const fieldNames = operation === 'create' ? ['mechanism', 'thresholds', 'penalties'] : ['sponsor_text', 'mechanism', 'thresholds', 'penalties', 'status_text', 'signed_text', 'effective_text'];
  return {
    type: 'OBJECT',
    required: ['operation', 'in_scope', 'scope_reason', 'fields', 'events_add', 'evidence', ...(operation === 'create' && needsSection ? ['section'] : [])],
    properties: {
      operation: S({ enum: ['update', 'create'] }),
      in_scope: { type: 'BOOLEAN' },
      scope_reason: S(),
      ...(operation === 'create' ? { section: S({ enum: sections || ['D', 'F', 'G', 'G.3'] }) } : {}),
      fields: { type: 'OBJECT', properties: Object.fromEntries(fieldNames.map((k) => [k, S({ nullable: true })])) },
      events_add: { type: 'ARRAY', items: { type: 'OBJECT', required: ['date', 'precision', 'type', 'text'], properties: { date: S(), precision: S({ enum: ['day', 'month'] }), type: S({ enum: EVENT_TYPES }), text: S(), clause: S() } } },
      evidence: { type: 'ARRAY', items: { type: 'OBJECT', required: ['field', 'quote'], properties: { field: S(), quote: S() } } },
      notes: S()
    }
  };
}

const fmtEntry = (e) => [`title: ${e.title}`, `sponsor_text: ${e.sponsor_text}`, `mechanism: ${e.mechanism}`, e.thresholds ? `thresholds: ${e.thresholds}` : null, e.status_text ? `status_text: ${e.status_text}` : null].filter(Boolean).join('\n');

// Where a new item goes. A federal bill: D, F or G.3. A state bill: one of the state sections its status allows (agents/derive.mjs stateSections).
const FEDERAL_SECTION_RULE = `- section (a top-level key, next to "fields", not inside it): REQUIRED for a bill, and it must be exactly D, F or G.3. G.3 = a bill whose subject is export controls or licensing for advanced AI chips, compute or model weights. D = the bill itself puts binding duties on frontier or advanced AI developers or on their models (mandatory testing or evaluation, safety frameworks, developer incident reporting, shutdown capability, bans or licensing), or creates a regulator with power over them. F = every other in-scope bill: voluntary or non-regulatory programs, standards, studies or guidance (for example an agency writing a security playbook or standards for developers to adopt), rules for one department's own AI or its contractors (such as the Defense Department), whistleblower protections, and investigative boards. If in doubt, choose F. For other documents use G = executive action or G.3 = compute or AI-chip export control rule (executive orders are G automatically).`;
const STATE_SECTION_TEXT = {
  A: 'A = an enacted state law that itself puts binding duties on frontier or large AI developers or on their models (safety frameworks, transparency reports, incident reporting, audits). A law whose only in-scope part is an independent-verification or AI-auditor program is C, not A',
  B: 'B = a state bill on frontier or large AI developers or their models (binding duties, transparency, incident reporting, liability), with a frontier threshold or definition (training compute, compute cost, revenue, or a "frontier model"/"large developer" definition). Never a resolution or memorial',
  'B.2': 'B.2 = a state bill aimed at catastrophic risk from advanced AI that sets NO frontier threshold (no compute, cost or revenue figure and no frontier or large-developer definition)',
  C: 'C = a state measure whose subject is independent verification organizations, AI auditors (licensing, registries, accreditation) or a study of them'
};
export const stateSectionRule = (sections) => `- section (a top-level key, next to "fields", not inside it): REQUIRED, and it must be exactly one of ${sections.join(', ')} (the system allows only these for this bill, from its status in the official record). ${sections.map((k) => STATE_SECTION_TEXT[k]).join('. ')}. If in doubt between ${sections.filter((k) => k !== 'C').join(' and ')} and C, choose ${sections[0]}.`;

export function generatorPrompt({ operation, item, source, entry, reasons, styleExamples, feedback, previousPatch, sections = null }) {
  const parts = [];
  if (operation === 'update') {
    parts.push(`TASK: update an EXISTING entry. Return operation "update". Put in "fields" only the text fields that must change (normally status_text; mechanism and thresholds only if the source shows they changed). Add the new dated steps in events_add. Every date you write carries its year; report only actions SOURCE records, never the expected next step.`);
    parts.push(`CURRENT ENTRY (the tracker last verified it on ${entry.last_checked}):\n${fmtEntry(entry)}`);
    parts.push(`WHAT THE COMPARISON CODE FOUND (these are facts from the official record; your update should reflect them):\n${reasons.map((r) => `- ${r.kind}: ${r.detail}`).join('\n')}`);
  } else {
    parts.push(`TASK: write the part of a NEW tracker entry that needs reading. Return operation "create". The title, short name, sponsor, dates and status line are exact fields in the official record and are written by the system, so do NOT write them.
In "fields" give ONLY:
- mechanism: what the item does, two to four plain sentences (at most 600 characters), using the source's own terms. Say who must do what, by when, and with what legal force (a duty, a power, voluntary, or an incentive). Where SOURCE has them, also name: preemption of state or local law, a liability shield, presumption, safe harbor or immunity, a private right of action, whistleblower protections, audits, incident-reporting deadlines, and a sunset. In a law with several parts, say which part each duty belongs to.
- thresholds: who or what it covers, at most 300 characters. List EVERY way to be covered that SOURCE sets: compute, compute cost, revenue, spending, user counts (and lower counts for minors), models made by fine-tuning or distilling a covered model, and capability definitions. If SOURCE sets figures, list the figures only, e.g. "Trained on more than 10^26 operations; annual revenue over $500,000,000", with one evidence quote per figure, each a short span (under 25 words) around that figure. If SOURCE instead defines what it covers by capability or risk with no figure (e.g. "covered AI technologies" are systems whose theft would pose a grave national security threat), say so in one short sentence starting "Capability-based, no figure:" and quote the key words of that definition (under 25 words). Never paste a whole definition. null only when SOURCE sets no figure and defines no covered models, developers or systems.
- penalties: read the enforcement or penalties section and give EVERY tier, at most 300 characters: first and later violations, per-day amounts, criminal penalties, different amounts for different kinds of company or for different duties, and who enforces (e.g. "Civil penalty up to $1,000,000 for a first violation and $3,000,000 for each later one; $50,000 per violation for chatbot providers; enforced by the Attorney General"). null only if SOURCE sets no penalty.
${item.source === 'legiscan' ? stateSectionRule(sections) : FEDERAL_SECTION_RULE}
Each field value is final text: never explain, think aloud or reconsider inside a field. Every field you give needs an evidence quote. Add events_add only for dated steps in SOURCE that the system cannot know, such as a deadline stated in the text ("within 60 days"), and only when the source gives the date.
${SCOPE_TEST}`);
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
- understates (says "standards", "guidance" or "may consider" where SOURCE says "shall" or "must", or calls a mandate voluntary),
- attaches a number or deadline to a different step than SOURCE does (30 days to set up a board vs 90 days for that board to act; the date a power starts vs how long a ban lasts),
- puts words in quotation marks that SOURCE does not contain word for word,
- or says SOURCE is silent about something (you cannot check absence).

For each claim return: n (its number), supported (true or false), quote (one short span, under 25 words, copied EXACTLY from SOURCE character for character, that best supports the claim; code checks it word for word, so do not join separate passages or fix the source's spelling; null if not supported), reason (required when not supported: say exactly what is wrong and what SOURCE says instead, quoting it).

Use only SOURCE. Do not use outside knowledge. Do not be generous: when in doubt, mark it not supported.
Return JSON only: {"results":[{"n":1,"supported":true,"quote":"...","reason":null}, ...]}`;

export const validatorPrompt = ({ source, claims }) =>
  `SOURCE:\n<<<SOURCE\n${source}\nSOURCE>>>\n\nCLAIMS:\n${claims.map((c, i) => `${i + 1}. [${c.field.replace(/\[(\d+)\]/, '-$1')}] ${c.claim}`).join('\n')}`;
