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
// other_figure and no_threshold added after the independent fact-check (30 Oct 2026): chip specifications and "any developer" coverage
// were published under "Capability-based, no figure".
export const THRESHOLD_KINDS = ['compute', 'derived_models', 'compute_cost', 'revenue', 'users', 'other_figure', 'capability', 'no_threshold'];
export const PENALTY_KINDS = ['civil', 'per_day', 'criminal', 'damages', 'other'];
// agents/checks.mjs field_lengths. Raised by the owner on 30 Oct 2026 so a complete list of tiers fits (mechanism: the site's 90th percentile).
export const FIELD_LIMITS = { mechanism: 1300, thresholds: 1300, penalties: 600 }; // thresholds 1300: owner, 30 Oct 2026 (chip definitions with 5-6 specifications)

const S = (extra = {}) => ({ type: 'STRING', ...extra });
const item = (kinds, withAppliesTo, extra = {}) => ({ type: 'OBJECT', required: ['kind', 'text', 'quote'], properties: { kind: S({ enum: kinds }), ...(withAppliesTo ? { applies_to: S({ nullable: true }) } : {}), text: S(), quote: S(), ...extra } });
export const SLOTS_SCHEMA = {
  type: 'OBJECT',
  required: ['mechanism', 'thresholds', 'penalties'],
  properties: {
    mechanism: { type: 'ARRAY', items: item(MECHANISM_KINDS, false) },
    thresholds: { type: 'ARRAY', items: item(THRESHOLD_KINDS, true, { combine: S({ nullable: true, enum: ['or', 'and'] }) }) },
    penalties: { type: 'ARRAY', items: item(PENALTY_KINDS, true, { enforced_by: S({ nullable: true }), enforced_by_quote: S({ nullable: true }) }) }
  }
};

export const SLOTS_INSTRUCTIONS = `In "slots" (a top-level key; leave "fields" and "evidence" empty: the system writes them from your slots) give one item per fact, each with a "quote": a short span (under 25 words) copied EXACTLY, character for character, from SOURCE that states that fact. Every number in "text" must appear in its quote, written as SOURCE writes it (10^26, $500,000,000). "text" is final wording: never explain or reconsider inside it.
- mechanism: what the item does. One item per duty, power or program, in SOURCE's order, each "text" ONE plain sentence (under 160 characters) saying who must or may do what, by when, using SOURCE's own terms and legal force ("must" only for a duty; "may" for a power; say "voluntary" or "incentive" when it is). kind: duty, power, voluntary, incentive or program. Then one item for each of these that SOURCE has: preemption of state or local law (preemption), a liability shield, presumption, safe harbor or immunity (liability), a private right of action (private_right), whistleblower protections (whistleblower), audits (audit), an incident-reporting deadline (incident_reporting), a sunset (sunset); other for anything else that matters. In a law with several parts, say in the sentence which part a duty belongs to. At most 8 items: merge minor duties of the same actor.
- thresholds: who or what it covers. One item per way to be covered that SOURCE sets: compute (training compute), compute_cost, revenue, users (and lower counts for minors), derived_models (models made by fine-tuning or distilling a covered model), other_figure (any other figure that decides coverage, such as a chip performance or memory specification), capability (a capability or risk definition with no figure: name EVERY alternative the definition lists, briefly, never only one of them), no_threshold (SOURCE covers everyone in a class with no size, figure or capability test, e.g. "any person that has trained an AI model"). When a defined term is met by either of two tests, say so with "combine": "or" on its items; when all tests are needed, "combine": "and". Never put the definition of the harm or risk the item guards against ("critical harm", "catastrophic risk", deaths or damage figures) in thresholds: that is not who it covers. "applies_to" is the defined term the figure sets, in SOURCE's words ("Frontier model", "Large frontier developer", "Covered chatbot"), or null. "text" is the figure and what it measures only, without repeating applies_to, e.g. "trained on more than 10^26 integer or floating-point operations" or "annual gross revenue over $500,000,000 with affiliates". Every tier and every test is its own item: never put two tests in one "text" (no semicolons), e.g. a chip definition met by any one of four specifications is four items with "combine": "or". [] only when SOURCE sets no figure and defines no covered models, developers or systems.
- penalties: read the enforcement or penalties section and give EVERY tier as its own item: first and later violations, per-day amounts (per_day), criminal penalties (criminal), damages a person may recover (damages), different amounts for different kinds of company or different duties (put that in "applies_to", e.g. "Large chatbot provider" or "Later violations"). "text" is the amount and what it is for, e.g. "civil penalty up to $1,000,000 per violation". "enforced_by" is who enforces or recovers THAT tier as SOURCE says for it (e.g. "the Attorney General", "the Agency after notice and hearing"); read the WHOLE enforcement section first, because a later subsection often says who recovers every penalty (e.g. "shall be recovered in a civil action brought exclusively by the Attorney General"), and name both when both act (e.g. "imposed by the Agency after notice and hearing and recovered by the Attorney General"); give it with "enforced_by_quote" copied exactly from SOURCE; tiers often have different enforcers, so never copy one tier's enforcer to another; null when SOURCE names none for that tier. [] only if SOURCE sets no penalty.
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
    // whole words only: "Developers with revenue..." under "Developer" keeps its text
    const t = k && phrase(x.text).toLowerCase().startsWith(phrase(k).toLowerCase()) && /^\s*[:,-]/.test(phrase(x.text).slice(phrase(k).length)) ? phrase(x.text).slice(phrase(k).length).replace(/^\s*[:,-]?\s*/, '') : phrase(x.text);
    groups.get(k).push({ t: `${t}${x.tier || ''}`, test: TESTS.includes(x.kind) });
  }
  // "combine" on a term's items: either test suffices ("or") or all are needed ("and"); said in words, never left to a semicolon
  // (independent fact-check: IL SB 3444's "10^26 ...; compute cost over $100,000,000" hid that either test is enough).
  const joinerOf = new Map();
  for (const x of items) { const k = clean(x.applies_to); if (x.combine === 'or' || x.combine === 'and') joinerOf.set(k, x.combine); }
  return [...groups].map(([k, parts]) => {
    // the joiner goes only between two tests; a qualifier of a test ("including later fine-tuning") follows with a semicolon
    const j = joinerOf.get(k);
    const body = parts.map((p, i) => (i === 0 ? p.t : `${p.test && j && parts.slice(0, i).some((q) => q.test) ? (j === 'or' ? '; or ' : '; and ') : '; '}${p.t}`)).join('');
    return k ? `${cap(phrase(k))}: ${body}` : cap(body);
  });
}
// the kinds that are tests of coverage on their own (derived_models qualifies a compute test; capability and no_threshold stand alone)
// capability counts too when it sits next to a figure (second review: "10^26 operations; capable of ..." hid either-or).
const TESTS = ['compute', 'compute_cost', 'revenue', 'users', 'other_figure', 'capability'];
// A group whose items carry both "or" and "and" cannot be said as a flat list ("(A and B) or C"): sent back, never flattened.
export const conflictingCombine = (items) => [...new Set(items.map((x) => clean(x.applies_to)))].filter((k) => new Set(items.filter((x) => clean(x.applies_to) === k && (x.combine === 'or' || x.combine === 'and')).map((x) => x.combine)).size > 1);

// slots -> { fields: { mechanism, thresholds, penalties }, evidence: [{ field, quote }], problems: [string] }
export function renderSlots(slots) {
  const problems = [];
  if (!slots || typeof slots !== 'object') return { fields: {}, evidence: [], problems: ['your answer has no "slots" object: give mechanism, thresholds and penalties as slots'] };
  const mech = list(slots.mechanism), thr = list(slots.thresholds), pen = list(slots.penalties);
  for (const [name, xs, kinds] of [['mechanism', mech, MECHANISM_KINDS], ['thresholds', thr, THRESHOLD_KINDS], ['penalties', pen, PENALTY_KINDS]]) {
    xs.forEach((x, i) => {
      // An unknown kind is sent back, never guessed (a compute figure guessed as "capability" was published as "no figure").
      if (!kinds.includes(x.kind)) { problems.push(`${name} slot ${i + 1} has kind "${x.kind}", which is not one of ${kinds.join(', ')}`); x.kind = kinds.includes('other') ? 'other' : null; }
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
    const figureless = sorted.every((x) => x.kind === 'capability'), open = sorted.every((x) => x.kind === 'no_threshold');
    if (sorted.some((x) => ['capability', 'no_threshold'].includes(x.kind) && /\d/.test(x.text))) problems.push('a capability or no_threshold slot gives a figure: put each figure in a slot of its own kind (compute, compute_cost, revenue, users, other_figure)');
    // One test per slot (targeted re-test, 30 Oct 2026: IL SB 3444 and MI HB 4668 put two tests in one slot, so "or" / "and" was lost)
    sorted.forEach((x) => { if (TESTS.includes(x.kind) && /;/.test(x.text)) problems.push(`thresholds slot "${phrase(x.text).slice(0, 70)}" holds more than one test: give each test its own slot, and say with "combine" whether either is enough ("or") or all are needed ("and")`); });
    if (sorted.some((x) => x.kind === 'no_threshold') && !open) problems.push('a no_threshold slot sits next to threshold slots: no_threshold is only for a bill that covers everyone in a class with no test');
    // a group with several tests and no "combine" is sent back: either-or and all-of read the same with a semicolon
    const multi = [...new Set(sorted.map((x) => clean(x.applies_to)))].filter((k) => sorted.filter((x) => clean(x.applies_to) === k && TESTS.includes(x.kind)).length > 1 && !sorted.some((x) => clean(x.applies_to) === k && (x.combine === 'or' || x.combine === 'and')));
    for (const k of multi) problems.push(`thresholds for "${k || 'the item'}" give several tests without "combine": say whether either one is enough ("or") or all are needed ("and")`);
    for (const k of conflictingCombine(sorted)) problems.push(`thresholds for "${k || 'the item'}" mix "or" and "and": a nested test such as "(A and B) or C" cannot be written as one list; give the tests for each defined term with one "combine" only`);
    fields.thresholds = figureless ? `Capability-based, no figure: ${phrase(sorted.map((x) => phrase(x.text)).join('; '))}.`
      : open ? `No threshold: covers ${phrase(sorted.map((x) => phrase(x.text)).join('; ')).replace(/^covers\s+/i, '')}.`
        : `${grouped(sorted).join('. ')}.`;
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
// Spelled-out dollar amounts: "five thousand dollars", "one million dollars", "twenty-five thousand dollars", "two hundred fifty thousand dollars".
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SPELLED = /\b((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)[\s-]+)+)dollars\b/gi;
function spelledValue(words) {
  let total = 0, cur = 0;
  for (const w of words.toLowerCase().split(/[\s-]+/).filter(Boolean)) {
    if (WORDS[w] != null) cur += WORDS[w];
    else if (w === 'hundred') cur = (cur || 1) * 100;
    else { const m = { thousand: 1e3, million: 1e6, billion: 1e9 }[w]; if (!m) return null; total += (cur || 1) * m; cur = 0; }
  }
  return String(total + cur || '') || null;
}
const NEGATED =/\b(?:shall|may|must) not (?:be )?(?:assessed|imposed|apply|applied)\b|\bno (?:civil|criminal) penalty\b/i;
function sentenceAround(text, i, len) {
  const start = Math.max(text.lastIndexOf('.', i) + 1, i - 300), end = Math.min((text.indexOf('.', i + len) + 1) || text.length, i + len + 300);
  return text.slice(start, end);
}
export function coverageProblems(slots, sourceText) {
  if (!slots || typeof slots !== 'object') return [];
  const text = String(sourceText || ''), out = [];
  const have = (kind) => (kind === 'penalty' ? list(slots.penalties).length > 0 : list(slots.thresholds).some((x) => x.kind === kind));
  // Every dollar amount of a matched sentence must be in some slot of that field (independent review, 30 Oct 2026: one slot of a kind
  // used to satisfy the check, so a second tier, a per-day amount or a criminal fine could be dropped unseen).
  // amounts compared by value: "$1 million" = "$1,000,000", "$5,000,000.00" = "$5,000,000"
  const valueOf = (a) => String(Math.round(Number(a.replace(/[$,\s]|million|billion/gi, '')) * (/billion/i.test(a) ? 1e9 : /million/i.test(a) ? 1e6 : 1)));
  const given = (field) => new Set((list(slots[field]).map((x) => clean(x.text)).join(' ').match(/\d[\d,]*(?:\.\d+)?(?:\s+(?:million|billion))?/gi) || []).map(valueOf));
  // "$10,000", "$1 million" and spelled-out "five thousand dollars" / "one million dollars" (second review: state codes spell them out)
  const amountsIn = (s) => [
    ...(s.match(/\$\s?\d[\d,]*(?:\.\d+)?(?:\s+(?:million|billion))?/gi) || []).map((a) => ({ a: a.trim(), n: valueOf(a) })),
    ...[...s.matchAll(SPELLED)].map((m) => ({ a: m[0].trim(), n: spelledValue(m[1]) })).filter((x) => x.n)
  ];
  for (const s of SIGNALS) {
    const re = new RegExp(s.re.source, 'gi'), field = s.kind === 'penalty' ? 'penalties' : 'thresholds', seen = new Set();
    for (const m of text.matchAll(re)) {
      const around = sentenceAround(text, m.index, m[0].length);
      if (s.needsWho && !WHO.test(around)) continue;
      // "the criminal penalties provided in the Whistleblower Act shall not be assessed" (IL H.B. 3506) sets no penalty
      if (s.kind === 'penalty' && NEGATED.test(text.slice(m.index, m.index + m[0].length + 120).split(/[.;]/)[0])) continue;
      const excerpt = clean(text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 60));
      if (!have(s.kind)) {
        out.push(s.kind === 'penalty'
          ? `SOURCE sets a penalty ("…${excerpt}…") but your penalties slots are empty: read the enforcement section and give every tier`
          : `SOURCE sets a ${s.kind.replace('_', ' ')} figure in a coverage sentence ("…${excerpt}…") but no thresholds slot has kind ${s.kind}: add it with its quote and applies_to`);
        break;
      }
      // the match can end inside an amount ("...civil penalty of not more than $5"): the amounts are read to the end of its clause
      // to the end of its sentence (a second tier often follows: "...not to exceed $10,000 for a first violation, and not to exceed
      // $50,000 for each subsequent violation"), at most 400 characters
      const clause = text.slice(m.index, m.index + m[0].length + 400).split(/\.(?=\s+[A-Z(“"])/)[0];
      const missing = amountsIn(clause).filter((x) => !given(field).has(x.n) && !seen.has(x.n));
      for (const x of missing) { seen.add(x.n); out.push(`SOURCE sets ${x.a} ("…${excerpt}…") but no ${field} slot gives it: give every tier as its own slot`); }
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
