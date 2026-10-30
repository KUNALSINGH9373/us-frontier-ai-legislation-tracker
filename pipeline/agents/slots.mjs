// Slot-based writing of a new entry's reading fields (owner, 30 Oct 2026). The Generator no longer writes mechanism, thresholds and
// penalties as free paragraphs: it fills one slot per fact, each with its own word-for-word quote, and code writes the three fields
// from the slots in a fixed order (so a tier cannot be left out unseen, and the length is set by code, not by the model). The fields and
// their evidence then go through every existing check, the independent reader and the publish guards unchanged.
//
// slots = {
//   mechanism:  [{ kind, text, quote }]             kind: MECHANISM_KINDS; text: one plain sentence
//   thresholds: [{ kind, applies_to, text, quote }]  kind: THRESHOLD_KINDS; applies_to: the defined term it sets ("Frontier model")
//   penalties:  [{ kind, applies_to, text, quote, enforced_by, enforced_by_quote }]  kind: PENALTY_KINDS; applies_to: who or which duty
//               the amount is for; enforced_by: who enforces THAT tier (tiers can differ: the Attorney General for fines, an agency
//               for a per-day amount; one enforcer for all tiers was refused by the reader on 4 bills in the 30 Oct re-test)
// }
import { containsQuote } from './source-text.mjs';

export const MECHANISM_KINDS = ['duty', 'power', 'voluntary', 'incentive', 'program', 'preemption', 'liability', 'private_right', 'whistleblower', 'audit', 'incident_reporting', 'sunset', 'other'];
// No harm definitions (owner, 30 Oct 2026): what a bill guards against is not who it covers, and condensing a harm definition lost its
// qualifiers in both paid re-tests (IL SB 315, IL SB 3312).
export const THRESHOLD_KINDS = ['compute', 'compute_cost', 'revenue', 'users', 'derived_models', 'capability'];
export const PENALTY_KINDS = ['civil', 'per_day', 'criminal', 'damages', 'other'];
// agents/checks.mjs field_lengths. Raised by the owner on 30 Oct 2026 so a complete list of tiers fits (mechanism: the site's 90th percentile).
export const FIELD_LIMITS = { mechanism: 1300, thresholds: 1000, penalties: 600 };

const S = (extra = {}) => ({ type: 'STRING', ...extra });
const item = (kinds, withAppliesTo, extra = {}) => ({ type: 'OBJECT', required: ['kind', 'text', 'quote'], properties: { kind: S({ enum: kinds }), ...(withAppliesTo ? { applies_to: S({ nullable: true }) } : {}), text: S(), quote: S(), ...extra } });
export const SLOTS_SCHEMA = {
  type: 'OBJECT',
  required: ['mechanism', 'thresholds', 'penalties'],
  properties: {
    mechanism: { type: 'ARRAY', items: item(MECHANISM_KINDS, false) },
    thresholds: { type: 'ARRAY', items: item(THRESHOLD_KINDS, true) },
    penalties: { type: 'ARRAY', items: item(PENALTY_KINDS, true, { enforced_by: S({ nullable: true }), enforced_by_quote: S({ nullable: true }) }) }
  }
};

export const SLOTS_INSTRUCTIONS = `In "slots" (a top-level key; leave "fields" and "evidence" empty: the system writes them from your slots) give one item per fact, each with a "quote": a short span (under 25 words) copied EXACTLY, character for character, from SOURCE that states that fact. Every number in "text" must appear in its quote, written as SOURCE writes it (10^26, $500,000,000). "text" is final wording: never explain or reconsider inside it.
- mechanism: what the item does. One item per duty, power or program, in SOURCE's order, each "text" ONE plain sentence (under 160 characters) saying who must or may do what, by when, using SOURCE's own terms and legal force ("must" only for a duty; "may" for a power; say "voluntary" or "incentive" when it is). kind: duty, power, voluntary, incentive or program. Then one item for each of these that SOURCE has: preemption of state or local law (preemption), a liability shield, presumption, safe harbor or immunity (liability), a private right of action (private_right), whistleblower protections (whistleblower), audits (audit), an incident-reporting deadline (incident_reporting), a sunset (sunset); other for anything else that matters. In a law with several parts, say in the sentence which part a duty belongs to. At most 8 items: merge minor duties of the same actor.
- thresholds: who or what it covers. One item per way to be covered that SOURCE sets: compute (training compute), compute_cost, revenue, users (and lower counts for minors), derived_models (models made by fine-tuning or distilling a covered model), capability (a capability or risk definition with no figure). Never put the definition of the harm or risk the item guards against ("critical harm", "catastrophic risk", deaths or damage figures) in thresholds: that is not who it covers. "applies_to" is the defined term the figure sets, in SOURCE's words ("Frontier model", "Large frontier developer", "Covered chatbot"), or null. "text" is the figure and what it measures only, without repeating applies_to, e.g. "trained on more than 10^26 integer or floating-point operations" or "annual gross revenue over $500,000,000 with affiliates". Every tier is its own item. [] only when SOURCE sets no figure and defines no covered models, developers or systems.
- penalties: read the enforcement or penalties section and give EVERY tier as its own item: first and later violations, per-day amounts (per_day), criminal penalties (criminal), damages a person may recover (damages), different amounts for different kinds of company or different duties (put that in "applies_to", e.g. "Large chatbot provider" or "Later violations"). "text" is the amount and what it is for, e.g. "civil penalty up to $1,000,000 per violation". "enforced_by" is who enforces or recovers THAT tier as SOURCE says for it (e.g. "the Attorney General", "the Agency after notice and hearing"), with "enforced_by_quote" copied exactly from SOURCE; tiers often have different enforcers, so never copy one tier's enforcer to another; null when SOURCE names none for that tier. [] only if SOURCE sets no penalty.
Shape: "slots": {"mechanism":[{"kind":"duty","text":"...","quote":"..."}],"thresholds":[{"kind":"compute","applies_to":"Frontier model","text":"...","quote":"..."}],"penalties":[{"kind":"civil","applies_to":null,"text":"...","quote":"...","enforced_by":"...","enforced_by_quote":"..."}]}`;

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s) => { const t = cap(clean(s).replace(/[;,:\s]+$/, '')); return /[.!?]$/.test(t) ? t : `${t}.`; };
const phrase = (s) => clean(s).replace(/[.;,:\s]+$/, '');
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && clean(x.text)) : []);
const order = (kinds) => (a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind);

// Groups items by applies_to (first appearance order, after sorting by kind) into "Term: a; b." or "a; b." pieces.
function grouped(items) {
  const groups = new Map();
  for (const x of items) {
    const k = clean(x.applies_to); if (!groups.has(k)) groups.set(k, []);
    // "Developer: Developer: trained …" (30 Oct re-test): a text that repeats its own term drops it
    const t = k && phrase(x.text).toLowerCase().startsWith(phrase(k).toLowerCase()) ? phrase(x.text).slice(phrase(k).length).replace(/^\s*[:,-]?\s*/, '') : phrase(x.text);
    groups.get(k).push(`${t}${x.tier || ''}`);
  }
  return [...groups].map(([k, texts]) => (k ? `${cap(phrase(k))}: ${texts.join('; ')}` : cap(texts.join('; '))));
}

// slots -> { fields: { mechanism, thresholds, penalties }, evidence: [{ field, quote }], problems: [string] }
export function renderSlots(slots) {
  const problems = [];
  if (!slots || typeof slots !== 'object') return { fields: {}, evidence: [], problems: ['your answer has no "slots" object: give mechanism, thresholds and penalties as slots'] };
  const mech = list(slots.mechanism), thr = list(slots.thresholds), pen = list(slots.penalties);
  for (const [name, xs, kinds] of [['mechanism', mech, MECHANISM_KINDS], ['thresholds', thr, THRESHOLD_KINDS], ['penalties', pen, PENALTY_KINDS]]) {
    xs.forEach((x, i) => {
      if (!kinds.includes(x.kind)) x.kind = kinds.includes('other') ? 'other' : kinds[kinds.length - 1];
      if (!clean(x.quote)) problems.push(`${name} slot ${i + 1} ("${phrase(x.text).slice(0, 60)}") has no quote: copy the words of SOURCE that state it`);
    });
  }
  const fields = {}, evidence = [];
  if (mech.length) {
    // duties, powers and programs in SOURCE's order first, then the features in a fixed order
    const core = mech.filter((x) => MECHANISM_KINDS.indexOf(x.kind) <= MECHANISM_KINDS.indexOf('program'));
    const rest = mech.filter((x) => !core.includes(x)).sort(order(MECHANISM_KINDS));
    fields.mechanism = [...core, ...rest].map((x) => sentence(x.text)).join(' ');
    mech.forEach((x) => clean(x.quote) && evidence.push({ field: 'mechanism', quote: clean(x.quote) }));
  }
  if (thr.length) {
    const sorted = [...thr].sort(order(THRESHOLD_KINDS));
    const figureless = sorted.every((x) => x.kind === 'capability');
    fields.thresholds = figureless ? `Capability-based, no figure: ${phrase(sorted.map((x) => phrase(x.text)).join('; '))}.` : `${grouped(sorted).join('. ')}.`;
    thr.forEach((x) => clean(x.quote) && evidence.push({ field: 'thresholds', quote: clean(x.quote) }));
  }
  if (pen.length) {
    // Each tier carries its own enforcer. One enforcer named by every tier is said once at the end; otherwise each tier says its own.
    const by = (x) => phrase(x.enforced_by || '').replace(/^(?:enforced|recovered) by\s+/i, '');
    const sorted = [...pen].sort(order(PENALTY_KINDS)), named = sorted.map(by);
    const shared = named.every((e) => e && e.toLowerCase() === named[0].toLowerCase()) ? named[0] : null;
    const tiers = sorted.map((x) => ({ ...x, tier: !shared && by(x) ? `, enforced by ${by(x)}` : '' }));
    fields.penalties = `${grouped(tiers).join('; ')}${shared ? `; enforced by ${shared}` : ''}.`;
    pen.forEach((x, i) => {
      if (clean(x.quote)) evidence.push({ field: 'penalties', quote: clean(x.quote) });
      if (by(x)) { if (clean(x.enforced_by_quote)) evidence.push({ field: 'penalties', quote: clean(x.enforced_by_quote) }); else problems.push(`penalties slot ${i + 1} names who enforces it ("${by(x)}") without enforced_by_quote: copy the words of SOURCE that say so`); }
    });
  }
  for (const [f, v] of Object.entries(fields)) if (v.length > FIELD_LIMITS[f]) problems.push(`${f} written from your slots is ${v.length} characters (limit ${FIELD_LIMITS[f]}): shorten the "text" of its slots (fewer words each, merge minor duties of the same actor); do not drop a threshold tier or a penalty`);
  return { fields, evidence, problems };
}

// Coverage: figures SOURCE sets in a coverage sentence that no slot of that kind reports. A sentence must name who is covered (a
// definition or a developer, provider, operator, company or person) for its figure to count, so a revenue figure in findings is not
// demanded. Returns readable problems (each with an excerpt of SOURCE) for the Generator's next round; on the last round the item is held.
const WHO = /\bmeans\b|\bdefin|\bdeveloper|\bprovider|\boperator|\bcompan|\bperson\b|\bentity|\baffiliates?\b|\bcovered\b/i;
const SIGNALS = [
  { kind: 'compute', field: 'thresholds', re: /10\s?\^\s?2\d\s+(?:integer|floating|operations|computational|FLOP)/i, needsWho: false },
  { kind: 'compute_cost', field: 'thresholds', re: /\bcomput[a-z]*\b[^.;]{0,80}\bcosts?\b[^.;]{0,40}\$\s?\d|\$\s?\d[\d,]*(?:\s+(?:million|billion))?[^.;]{0,40}\b(?:in\s+)?comput[a-z]*\s+(?:cost|power)/i, needsWho: true },
  { kind: 'revenue', field: 'thresholds', re: /\brevenues?\b[^.;]{0,100}\$\s?\d|\$\s?\d[\d,]*(?:\s+(?:million|billion))?[^.;]{0,60}\brevenues?\b/i, needsWho: true },
  { kind: 'users', field: 'thresholds', re: /\b\d{1,3}(?:,\d{3})+\s+(?:(?:monthly|daily|weekly|annual)\s+)?(?:active\s+)?users\b/i, needsWho: false },
  { kind: 'penalty', field: 'penalties', re: /\bcivil penalt(?:y|ies)\b[^.;]{0,120}\$\s?\d|\$\s?\d[\d,]*[^.;]{0,40}\bper (?:violation|day)\b|\bcriminal penalt|\bguilty of a (?:misdemeanor|felony)/i, needsWho: false }
];
const NEGATED = /\b(?:shall|may|must) not (?:be )?(?:assessed|imposed|apply|applied)\b|\bno (?:civil|criminal) penalty\b/i;
function sentenceAround(text, i, len) {
  const start = Math.max(text.lastIndexOf('.', i) + 1, i - 300), end = Math.min((text.indexOf('.', i + len) + 1) || text.length, i + len + 300);
  return text.slice(start, end);
}
export function coverageProblems(slots, sourceText) {
  if (!slots || typeof slots !== 'object') return [];
  const text = String(sourceText || ''), out = [];
  const have = (kind) => (kind === 'penalty' ? list(slots.penalties).length > 0 : list(slots.thresholds).some((x) => x.kind === kind));
  for (const s of SIGNALS) {
    if (have(s.kind)) continue;
    const re = new RegExp(s.re.source, 'gi');
    for (const m of text.matchAll(re)) {
      const around = sentenceAround(text, m.index, m[0].length);
      if (s.needsWho && !WHO.test(around)) continue;
      // "the criminal penalties provided in the Whistleblower Act shall not be assessed" (IL H.B. 3506) sets no penalty
      if (s.kind === 'penalty' && NEGATED.test(text.slice(m.index, m.index + m[0].length + 120).split(/[.;]/)[0])) continue;
      const excerpt = clean(text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 60));
      out.push(s.kind === 'penalty'
        ? `SOURCE sets a penalty ("…${excerpt}…") but your penalties slots are empty: read the enforcement section and give every tier`
        : `SOURCE sets a ${s.kind.replace('_', ' ')} figure in a coverage sentence ("…${excerpt}…") but no thresholds slot has kind ${s.kind}: add it with its quote and applies_to`);
      break;
    }
  }
  return out;
}

// Every slot quote must be in SOURCE (the evidence check also refuses it; this names the slot, for a better retry message).
export function slotQuoteProblems(slots, sourceText) {
  if (!slots || typeof slots !== 'object') return [];
  const out = [];
  for (const name of ['mechanism', 'thresholds', 'penalties']) list(slots[name]).forEach((x, i) => { if (clean(x.quote) && !containsQuote(sourceText, x.quote)) out.push(`${name} slot ${i + 1} ("${phrase(x.text).slice(0, 60)}"): its quote is not in SOURCE word for word; copy it exactly`); });
  return out;
}
