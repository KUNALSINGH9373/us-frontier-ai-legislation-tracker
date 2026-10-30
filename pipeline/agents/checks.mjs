// The Validator's plain-code checks. Each returns { name, passed, detail }. Code cannot be talked into agreeing,
// so these catch the most dangerous mistakes (an invented quote, number or date) with no AI involved.
import { makeValidator } from '../schema/validate.mjs';
import { containsQuote } from './source-text.mjs';
import { digitRuns, norm, LOST_EXPONENT_IN_VALUE as LOST_EXPONENT, exponentOf, COMPUTE_UNIT, ENCODING_DEBRIS, GLUED_AMOUNT } from './text-norm.mjs';
import { SECTION_RULES, NEGATIVE_FINDING } from './rules.mjs';
import { FIELD_LIMITS, coverageProblems, slotQuoteProblems } from './slots.mjs';

const validator = makeValidator();
// Fields that state facts from the source and so need an evidence quote. short_name and section are labels and a classification, not facts the source states.
export const FACT_FIELDS = ['title', 'sponsor_text', 'mechanism', 'thresholds', 'penalties', 'status_text', 'signed_text', 'effective_text'];
const TEXT_FIELDS = ['title', 'short_name', 'sponsor_text', 'mechanism', 'thresholds', 'penalties', 'status_text', 'signed_text', 'effective_text'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Letters outside Latin script (plus Latin accents) that the source itself never uses: returns them, empty when clean.
export function foreignLetters(value, source) {
  const seen = new Set(String(source || ''));
  return [...String(value || '')].filter((c) => /\p{L}/u.test(c) && !/\p{Script=Latin}/u.test(c) && !seen.has(c)).join('');
}

// A date is supported when the source states it as a field or writes it out ("September 29, 2026", "Sept. 29, 2026").
export function dateSupported(date, text) {
  if (norm(text).includes(date)) return true;
  const [y, m, d] = date.split('-').map(Number), mon = MONTHS[m - 1];
  const re = new RegExp(`\\b${mon.slice(0, 3)}[a-z]*\\.?\\s+0?${d}\\b,?\\s*${y}`, 'i');
  return re.test(text);
}

// Rules learned from the 27 Oct 2026 review of all entries. Each returns readable problems for one text field.
// 10²⁶ printed as "1026 integer", "10.26 computational" or "10�26" (agents/text-norm.mjs LOST_EXPONENT), or a superscript's encoding debris on its own.
const GARBLED = new RegExp(`${LOST_EXPONENT.source}|${ENCODING_DEBRIS.source}`, 'i');
const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?';
// A month and day with no year after it (ranges such as "Sept 3–16, 2026" and "Sept 3–Oct 1, 2026" count as having one).
const NO_YEAR = new RegExp(`\\b${MONTH}\\s+\\d{1,2}\\b(?!(?:\\s*[–-]\\s*(?:${MONTH}\\s+)?\\d{1,2})?,?\\s*\\d{4})`);
const UNDEFINED = /\bnot (?:established|defined|specified|stated)\b[^.;]{0,40}\b(?:sources?|text)\b/i;
// A line number glued onto an amount ("$500,000,000.8", IL H.B. 4705): an amount never has a single cent digit (agents/text-norm.mjs).
const GLUED_DIGIT = GLUED_AMOUNT;
const QUOTED = /[“"]([^”"]{8,})[”"]/g;
// Compute thresholds must parse to a plausible magnitude (AZ H.B. 4098 was published with "10.26 computational operations", a lost 10^26):
// "10^N operations" needs N from 20 to 30, and a number written out before a compute unit needs at least 10^20. Returns readable problems.
const POWER = new RegExp(String.raw`\b10\s?\^\s?(\d{1,3})(?=\s+${COMPUTE_UNIT})`, 'gi');
const PLAIN = new RegExp(String.raw`(?<![\d^.,]|\^\s)(\d[\d,]*(?:\.\d+)?)(?:\s+(?:billion|million|trillion))?(?=\s+${COMPUTE_UNIT})`, 'gi');
export function thresholdNumberProblems(field, value) {
  const v = String(value || ''), out = [];
  for (const m of v.matchAll(new RegExp(LOST_EXPONENT.source, 'gi'))) out.push(`${field} has a lost exponent ("${m[0]}" before a compute unit): the bill's threshold is 10^${exponentOf(m)}; write it as 10^${exponentOf(m)}`);
  for (const m of v.matchAll(POWER)) if (+m[1] < 20 || +m[1] > 30) out.push(`${field} gives a compute threshold of 10^${m[1]} operations, which is not a plausible training-compute threshold`);
  for (const m of v.matchAll(PLAIN)) {
    if (new RegExp(LOST_EXPONENT.source, 'i').test(v.slice(m.index, m.index + m[0].length + 30))) continue; // reported above
    const n = Number(m[1].replace(/,/g, '')) * ({ billion: 1e9, million: 1e6, trillion: 1e12 }[(/(billion|million|trillion)/i.exec(m[0]) || [])[1]?.toLowerCase()] || 1);
    if (n < 1e20) out.push(`${field} gives a compute threshold of ${m[0].trim()} operations, which is not a plausible magnitude (write the bill's power of ten, e.g. 10^26)`);
  }
  return out;
}
// The one unambiguous repair: "10.26" / "1026" right before a compute unit is 10^26. Anything else implausible is left as it is (and held).
export const normaliseExponents = (value) => (typeof value === 'string' ? value.replace(new RegExp(LOST_EXPONENT.source, 'gi'), (...m) => `10^${exponentOf(m)}`) : value);

export function textProblems(field, value, sourceText) {
  const v = String(value || ''), out = [];
  if (GARBLED.test(v)) out.push(`${field} has a garbled exponent ("${(v.match(GARBLED) || [''])[0]}"): write 10^26, not 1026`);
  thresholdNumberProblems(field, v).filter((p) => !(GARBLED.test(v) && /lost exponent/.test(p))).forEach((p) => out.push(p));
  const glued = v.match(GLUED_DIGIT);
  if (glued) out.push(`${field} has a stray digit after an amount ("${glued[0]}"): that is a printed line number, not cents; write the amount without it`);
  const d = v.match(NO_YEAR);
  if (d) out.push(`${field} gives a date without its year ("${d[0]}"): write every date with its year, e.g. "Sept 30, 2026"`);
  if (UNDEFINED.test(v)) out.push(`${field} says a term is not established or defined: read the definitions section and give the definition, or leave the field out`);
  for (const m of v.matchAll(QUOTED)) if (!containsQuote(sourceText, m[1])) out.push(`${field} puts words in quotation marks that SOURCE does not contain: "${m[1].slice(0, 60)}". Quote word for word, or drop the quotation marks`);
  return out;
}

// readText: what the models read (a long bill's frontier sections); coverage is judged on it, every quote and number on sourceText.
export function runChecks({ patch, before, after, assembleProblems, source, sourceText, readText = sourceText, entries = [], operation }) {
  const checks = [], add = (name, passed, detail = '') => checks.push({ name, passed, ...(detail ? { detail } : {}) });
  add('assembled', assembleProblems.length === 0, assembleProblems.join('; '));
  if (!after) return checks;

  const errs = validator.check('entry', after);
  add('entry_schema', errs.length === 0, errs.slice(0, 4).join('; '));

  const missing = patch.evidence.filter((e) => !containsQuote(sourceText, e.quote));
  add('evidence_quotes_are_in_the_source', missing.length === 0, missing.map((e) => `"${e.quote.slice(0, 60)}" (for ${e.field}) is not in the source`).join('; '));

  const changedFields = [...Object.keys(patch.fields).filter((f) => FACT_FIELDS.includes(f) && patch.fields[f]), ...patch.events_add.map((_, i) => `events_add[${i}]`)];
  const uncovered = changedFields.filter((f) => !patch.evidence.some((e) => e.field === f));
  add('every_change_has_evidence', uncovered.length === 0, uncovered.length ? `no evidence quote for: ${uncovered.join(', ')}` : '');

  // Numbers: every figure in newly written text must appear in the source (or in the text it replaces).
  const prev = digitRuns(before ? TEXT_FIELDS.map((f) => before[f]).join(' ') : '');
  const src = digitRuns(sourceText);
  const bad = [];
  for (const [f, v] of Object.entries(patch.fields)) {
    if (typeof v !== 'string' || !TEXT_FIELDS.includes(f)) continue;
    for (const n of digitRuns(v)) if (n.length > 1 && !src.has(n) && !prev.has(n)) bad.push(`${n} (in ${f})`);
  }
  for (const [i, e] of patch.events_add.entries()) for (const n of digitRuns(e.text)) if (n.length > 1 && !src.has(n) && !prev.has(n)) bad.push(`${n} (in events_add[${i}])`);
  add('numbers_come_from_the_source', bad.length === 0, bad.length ? `not found in the source: ${bad.join(', ')}` : '');

  const badDates = patch.events_add.filter((e) => !dateSupported(e.date, sourceText));
  add('event_dates_are_in_the_source', badDates.length === 0, badDates.map((e) => `${e.date} is not stated in the source`).join('; '));

  if (operation === 'create') {
    // Sponsor, title, dates and status come straight from the official record (derive.mjs), so there is nothing for the model to get wrong there.
    const rule = SECTION_RULES[after.section];
    add('section_matches_type_and_level', !!rule && after.type === rule.type && (rule.level === null || after.level === rule.level), `${after.section} / ${after.type} / ${after.level}`);
    add('key_is_unique', !entries.some((e) => e.key === after.key), after.key);
  }

  const tooLong = Object.entries(patch.fields).filter(([f, v]) => typeof v === 'string' && v.length > (FIELD_LIMITS[f] || 500)).map(([f, v]) => `${f} is ${v.length} characters`);
  add('field_lengths', tooLong.length === 0, tooLong.length ? `too long: ${tooLong.join(', ')}. ${patch.slots !== undefined ? 'Shorten the text of each slot; do not drop a threshold tier or a penalty.' : 'Keep to one to three short sentences.'}` : '');

  // A new entry written from slots (agents/slots.mjs): every slot has an exact quote, and no figure SOURCE sets in a coverage sentence
  // (compute, compute cost, revenue, users, a penalty) is missing from the slots.
  if (patch.slots !== undefined && patch.in_scope !== false) {
    const sp = [...(patch.slotProblems || []), ...slotQuoteProblems(patch.slots, sourceText), ...coverageProblems(patch.slots, readText)];
    add('slots_complete', sp.length === 0, sp.join('; '));
  }

  // A model sometimes leaks the JSON it is writing into a text field (a stray brace, a quoted key, '","'). Real prose never contains these.
  const DEBRIS = /[{}]|['"][a-z_]{3,}['"]\s*:|['"],\s*['"]|```|\\n|\\u[0-9a-f]{4}/i;
  const dirty = Object.entries(patch.fields).filter(([, v]) => typeof v === 'string' && DEBRIS.test(v)).map(([f, v]) => `${f} (…${v.slice(Math.max(0, v.search(DEBRIS) - 15), v.search(DEBRIS) + 25)}…)`);
  add('clean_text', dirty.length === 0, dirty.length ? `stray code or JSON syntax in the text of: ${dirty.join('; ')}. Write plain prose only.` : '');

  // Letters from a writing system the source does not use (a model once ended a field with Bengali text) are noise.
  const foreign = Object.entries(patch.fields).filter(([, v]) => typeof v === 'string' && foreignLetters(v, sourceText).length).map(([f, v]) => `${f} ("${foreignLetters(v, sourceText).slice(0, 12)}")`);
  add('no_foreign_text', foreign.length === 0, foreign.length ? `letters that do not occur in the source in: ${foreign.join('; ')}. Write in the source's language only.` : '');

  const negatives = Object.entries(patch.fields).filter(([, v]) => typeof v === 'string' && NEGATIVE_FINDING.test(v)).map(([f]) => f);
  add('no_negative_findings', negatives.length === 0, negatives.length ? `a "none located" style claim in ${negatives.join(', ')}; only a person may write those` : '');

  const rules = Object.entries(patch.fields).filter(([f, v]) => typeof v === 'string' && TEXT_FIELDS.includes(f)).flatMap(([f, v]) => textProblems(f, v, sourceText));
  add('text_rules', rules.length === 0, rules.join('; '));

  add('in_scope_is_explained', patch.in_scope === false || patch.scope_reason.length >= 10);
  return checks;
}
