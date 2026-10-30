import { limitFor } from './review.mjs';

// The self-correction prompts, in one reviewable file. The reader (config role "reviewer") re-reads a bill against the tracker's
// current entry and lists errors and omissions, each with a quote; the confirmer (role "confirmer", a stronger model) sees one
// proposed correction at a time and must agree before code applies it. Neither sees the other's reasoning.

// The answer shapes (llm/schema.mjs): the API returns exactly one answer of this shape and code checks it again.
const STR = (extra = {}) => ({ type: 'STRING', ...extra });
export const REVIEWER_SCHEMA = { type: 'OBJECT', required: ['corrections'], properties: { corrections: { type: 'ARRAY', items: { type: 'OBJECT', required: ['field', 'kind', 'problem', 'new_text', 'evidence'], properties: { field: STR(), kind: STR({ enum: ['error', 'omission'] }), problem: STR(), new_text: STR(), evidence: { type: 'ARRAY', items: { type: 'OBJECT', required: ['quote'], properties: { quote: STR() } } } } } } } };
export const CONFIRMER_SCHEMA = { type: 'OBJECT', required: ['confirmed', 'quote', 'reason'], properties: { confirmed: { type: 'BOOLEAN' }, quote: STR({ nullable: true }), reason: STR() } };

export const REVIEWER_SYSTEM = `You check one entry of a tracker of US laws and bills aimed at the largest ("frontier") AI developers against the bill's official text. The entry was written earlier, by a person or by software. Find what is WRONG or MISSING in it, and write the corrected field.

What counts:
- error: the field states something SOURCE contradicts: a wrong number, deadline, amount, actor, scope or legal force ("shall"/"must" is a duty, "may" is a power, "voluntary" is voluntary; a liability shield, presumption, safe harbor or immunity is an incentive), a number attached to the wrong step, or words in quotation marks that SOURCE does not contain.
- omission: something a reader of the tracker needs that SOURCE states and the field leaves out. mechanism: who must do what, by when; preemption; liability shields and immunity; a private right of action; whistleblower protections; audits; incident-report deadlines; a sunset. thresholds: EVERY way to be covered (compute, compute cost, revenue, spending, user counts, models derived from a covered model, capability definitions). penalties: every tier and who enforces.

Rules:
1. Use ONLY SOURCE. No outside knowledge. Do not report style, wording, length or order: only facts that are wrong or missing.
2. Do not remove a statement just because SOURCE does not mention it: the entry may also cover a companion bill or later events. Change only what SOURCE contradicts, and add only what SOURCE states. Keep every figure and every quoted defined term of the current text (code checks this); if one is wrong, mark the correction "error" and name the wrong figure or term in "problem".
   An "omission" only ADDS: its new_text must contain the current text word for word, in the same order, with your additions placed anywhere (code checks this and refuses an omission that drops, rewords or reorders any word). An "error" may change only the wrong part: every word it removes must be named in "problem"; everything else stays word for word.
3. new_text is the COMPLETE new value of the field: the current text with the correction made, every other fact kept as it was, in the same dense style. HARD LIMITS, checked by code (longer text is thrown away): the character limit given for each field under CURRENT ENTRY. Count before you answer. Fix the most important problem first; when space runs out, leave out minor detail of what you add, never a word the current text has.
4. Every fact you add or change needs an item in "evidence": a quote copied EXACTLY, word for word, from SOURCE (at least 8 characters, from inside one sentence, no "..."), containing the number or words that prove it. Code checks that every figure you add, and every "shall", "must", "may" or "voluntary" you add, is in one of your quotes.
5. Every number you write must appear in SOURCE or in the current text, written as SOURCE writes it (10^26, $500,000,000). Every date has its year ("Sept 30, 2026"). Never write that something is "not found", "none" or "undefined": read the definitions section. Never state what the bill does NOT contain ("no compute threshold is set", "does not define"): if SOURCE sets no figure, just leave figures out.
6. Only the fields listed under FIELDS YOU MAY CORRECT. At most one correction per field. If the entry is right, return an empty list: that is the expected answer for most entries.

Return JSON only: {"corrections":[{"field":"mechanism","kind":"error","problem":"one sentence: what is wrong or missing and what SOURCE says","new_text":"...","evidence":[{"quote":"..."}]}]}`;

export function reviewerPrompt({ entry, fields, source, url, otherBills = [], multiBill = otherBills.length > 0 }) {
  const cur = fields.map((f) => `${f} (now ${String(entry[f] || '').length} characters; yours at most ${limitFor(f, entry[f]) - 50}): ${entry[f] == null || entry[f] === '' ? '(empty)' : entry[f]}`).join('\n');
  return [
    `ENTRY: ${entry.title} (${entry.short_name}), section ${entry.section}, ${entry.jurisdiction}.`,
    multiBill ? `NOTE: this entry covers more than one bill${otherBills.length ? ` (also ${otherBills.join(", ")})` : ""}. SOURCE is the text of one bill only, so leave facts about the others alone: only "omission" corrections are allowed here (code refuses "error"), and nothing may be removed or changed: keep the current text intact and only add.` : null,
    `FIELDS YOU MAY CORRECT: ${fields.join(', ')}.${fields.includes('penalties') ? '' : ' (In this section penalties belong in the mechanism text.)'}`,
    `CURRENT ENTRY:\n${cur}`,
    `SOURCE (${url}):\n<<<SOURCE\n${source}\nSOURCE>>>`
  ].filter(Boolean).join('\n\n');
}

export const CONFIRMER_SYSTEM = `You are a strict fact-checker for a legal tracker. Someone proposes to replace the text of one field of a tracker entry. You are given SOURCE (the bill's official text), the CURRENT text, the PROPOSED text and the problem they say they found.

Confirm the proposal only if BOTH are true:
(a) the problem is real: the current text really is wrong, or really leaves out something SOURCE states that a reader needs;
(b) everything the proposed text changes or adds is stated in SOURCE: no detail SOURCE does not state, no overstatement ("requires" for "encourages"), no understatement ("guidance" for "shall"), no number moved to a different step, no words in quotation marks that SOURCE does not contain word for word.
Facts the current text already had and the proposal keeps unchanged are not yours to judge (the entry may cover a companion bill or later events).

Do not be generous: when in doubt, do not confirm. Use only SOURCE, no outside knowledge.
Return JSON only: {"confirmed":true,"quote":"one short span under 25 words copied EXACTLY from SOURCE that best proves the change","reason":"one sentence"}. A confirmation without a quote that SOURCE contains word for word is refused by code. When not confirmed, quote may be null and reason says exactly what is wrong.`;

export const confirmerPrompt = ({ source, field, current, proposed, problem }) =>
  `SOURCE:\n<<<SOURCE\n${source}\nSOURCE>>>\n\nFIELD: ${field}\nCURRENT: ${current == null || current === '' ? '(empty)' : current}\nPROPOSED: ${proposed}\nPROBLEM FOUND: ${problem}`;
