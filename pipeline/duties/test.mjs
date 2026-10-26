// Tests for the duty schema and the duty checker. No network, no model.
//   node duties/test.mjs
import { checkDuties, checkDraft, wordNumbers } from './check.mjs';
import { makeValidator } from '../schema/validate.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const URL = 'https://example.gov/bill/1';
const TEXT = 'SEC. 4. A large developer shall publish a frontier AI framework. SEC. 5. A developer shall report a critical safety incident within fifteen days, or within 24 hours if there is an imminent risk of death. SEC. 6. A violation is subject to a civil penalty of up to $1,000,000 per violation. "Frontier model" means a model trained using greater than 10^26 integer or floating-point operations.';
const none = { value: 'not_in_bill', summary: 'The bill does not address this.' };
const base = () => ({
  framework: { value: 'yes', summary: 'Large developers must publish a frontier AI framework.', section: 'Sec. 4', quote: 'A large developer shall publish a frontier AI framework', source_url: URL },
  transparency_report: clone(none),
  incident_reporting: { value: 'yes', summary: 'Critical safety incidents must be reported within 15 days.', section: 'Sec. 5', quote: 'shall report a critical safety incident within fifteen days', source_url: URL },
  imminent_risk_reporting: { value: 'yes', summary: 'Within 24 hours when there is imminent risk of death.', section: 'Sec. 5', quote: 'within 24 hours if there is an imminent risk of death', source_url: URL },
  third_party_audit: clone(none), whistleblower: clone(none), registration: clone(none), shutdown: clone(none),
  compute_threshold: { value: 'yes', summary: 'Models trained on more than 10^26 operations.', section: 'Sec. 6', quote: 'greater than 10^26 integer or floating-point operations', source_url: URL },
  revenue_threshold: clone(none), harm_threshold: clone(none),
  penalties: { value: 'yes', summary: 'Civil penalty of up to $1,000,000 per violation.', section: 'Sec. 6', quote: 'a civil penalty of up to $1,000,000 per violation', source_url: URL },
  effective_date: clone(none)
});
const check = (d) => checkDuties(d, TEXT, { sourceUrl: URL });

ok('number words read as numbers (twenty-four, fifteen, one hundred)', [...wordNumbers('twenty-four hours, fifteen days, one hundred')].sort().join() === '100,15,24,4,1,20'.split(',').sort().join() || ['24', '15', '100'].every((n) => wordNumbers('twenty-four hours, fifteen days, one hundred').has(n)));
ok('a faithful set of duties passes', check(base()).length === 0, check(base()).join('; '));
ok('a number spelled out in the text may be written as digits (fifteen -> 15)', !check(base()).some((p) => /number 15/.test(p)));
{ const d = base(); delete d.shutdown; ok('a missing duty is rejected (all 13 must be answered)', check(d).some((p) => /format/.test(p) && /shutdown/.test(p))); }
{ const d = base(); d.extra = clone(none); ok('an unknown duty is rejected', check(d).some((p) => /format/.test(p))); }
{ const d = base(); d.framework.quote = 'A large developer must publish a safety plan'; ok('a quote not in the text is caught', check(d).some((p) => /framework: the quote is not in the official text/.test(p))); }
{ const d = base(); d.incident_reporting.summary = 'Incidents must be reported within 30 days.'; ok('an invented number in a summary is caught', check(d).some((p) => /incident_reporting: the summary has the number 30/.test(p))); }
{ const d = base(); d.penalties.quote = 'a civil penalty of up to $2,000,000 per violation'; ok('a quote with a wrong number is caught twice (words and figures)', check(d).filter((p) => /penalties/.test(p)).length >= 2); }
{ const d = base(); d.framework.section = 'Sec. 44'; ok('a section number not in the text is caught', check(d).some((p) => /section "Sec\. 44"/.test(p))); }
{ const d = base(); d.framework.source_url = 'https://example.gov/other'; ok('a source URL other than the stored text is caught', check(d).some((p) => /source_url/.test(p))); }
{ const d = base(); d.framework.value = 'no'; delete d.framework.quote; ok('yes / partial / no without a quote is rejected', check(d).some((p) => /format/.test(p))); }
{ const d = base(); d.whistleblower = { ...none, quote: 'A developer shall report a critical safety incident' }; ok('not_in_bill with a quote is rejected (no claim without a source, no source without a claim)', check(d).some((p) => /format/.test(p))); }
{ const d = base(); d.framework.summary = 'Developers must publish a framework খেলতে.'; ok('letters from a foreign script are caught', check(d).some((p) => /script/.test(p))); }
{ const d = base(); d.framework.quote = 'A  LARGE developer shall publish\na frontier AI framework'; ok('case and whitespace differences in a quote are fine', check(d).length === 0, check(d).join('; ')); }
{ ok('a draft whose text changed since it was read is flagged', checkDraft({ key: 'x', source_url: URL, basis: { sha256: 'a'.repeat(64) }, duties: base() }, TEXT).some((p) => /hash differs/.test(p))); }
{ const v = makeValidator(), d = base(); ok('the duties shape is part of the entry schema', v.check('duties', d).length === 0 && v.check('duties', { ...d, penalties: { value: 'maybe', summary: 'x y z' } }).length > 0); }

console.log(`duties: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
