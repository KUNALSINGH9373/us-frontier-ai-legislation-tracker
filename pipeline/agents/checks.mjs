// The Validator's plain-code checks. Each returns { name, passed, detail }. Code cannot be talked into agreeing,
// so these catch the most dangerous mistakes (an invented quote, number or date) with no AI involved.
import { makeValidator } from '../schema/validate.mjs';
import { containsQuote, digitRuns, norm } from './source-text.mjs';
import { SECTION_RULES, NEGATIVE_FINDING } from './rules.mjs';

const validator = makeValidator();
// Fields that state facts from the source and so need an evidence quote. short_name and section are labels and a classification, not facts the source states.
export const FACT_FIELDS = ['title', 'sponsor_text', 'mechanism', 'thresholds', 'penalties', 'status_text', 'signed_text', 'effective_text'];
const TEXT_FIELDS = ['title', 'short_name', 'sponsor_text', 'mechanism', 'thresholds', 'penalties', 'status_text', 'signed_text', 'effective_text'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// A date is supported when the source states it as a field or writes it out ("September 29, 2026", "Sept. 29, 2026").
export function dateSupported(date, text) {
  if (norm(text).includes(date)) return true;
  const [y, m, d] = date.split('-').map(Number), mon = MONTHS[m - 1];
  const re = new RegExp(`\\b${mon.slice(0, 3)}[a-z]*\\.?\\s+0?${d}\\b,?\\s*${y}`, 'i');
  return re.test(text);
}

export function runChecks({ patch, before, after, assembleProblems, source, sourceText, entries = [], operation }) {
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

  const tooLong = Object.entries(patch.fields).filter(([f, v]) => typeof v === 'string' && v.length > (f === 'mechanism' ? 700 : 500)).map(([f, v]) => `${f} is ${v.length} characters`);
  add('field_lengths', tooLong.length === 0, tooLong.length ? `too long: ${tooLong.join(', ')}. Keep to one to three short sentences.` : '');

  // A model sometimes leaks the JSON it is writing into a text field (a stray brace, a quoted key, '","'). Real prose never contains these.
  const DEBRIS = /[{}]|['"][a-z_]{3,}['"]\s*:|['"],\s*['"]|```|\\n|\\u[0-9a-f]{4}/i;
  const dirty = Object.entries(patch.fields).filter(([, v]) => typeof v === 'string' && DEBRIS.test(v)).map(([f, v]) => `${f} (…${v.slice(Math.max(0, v.search(DEBRIS) - 15), v.search(DEBRIS) + 25)}…)`);
  add('clean_text', dirty.length === 0, dirty.length ? `stray code or JSON syntax in the text of: ${dirty.join('; ')}. Write plain prose only.` : '');

  const negatives = Object.entries(patch.fields).filter(([, v]) => typeof v === 'string' && NEGATIVE_FINDING.test(v)).map(([f]) => f);
  add('no_negative_findings', negatives.length === 0, negatives.length ? `a "none located" style claim in ${negatives.join(', ')}; only a person may write those` : '');

  add('in_scope_is_explained', patch.in_scope === false || patch.scope_reason.length >= 10);
  return checks;
}
