// The press measure (gate switch auto_publish.press): code only, free, deterministic, over eval/press-set/cases.json:
//   code    candidate stories with one planted fault (not an allowed outlet, a link off the outlet's site, dated in the future or too old,
//           no date, markup, already listed): checkPress must refuse each; a clean one must pass
//   review  the reviewer's recorded answers on real and written headlines (out/press-review-test.mjs, 12 Nov 2026, checked by a person):
//           the keep rule (about this entry and not misleading) must give the expected result
// wrong = a fault let through or a refusal the record expects kept the other way; the gate counts a report only at zero, over the
// whole set, by the current code.
//   node eval/press-set.mjs [--write]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkPress } from '../news/press.mjs';
import { checksHash } from './hash.mjs';
import { writeMeasureReport } from './gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PRESS_SET = path.join(here, 'press-set', 'cases.json');
export const keepOf = (v) => v.about_entry === 'yes' && v.misleading === 'no';

export function runPressSet({ cases }) {
  let wrong = 0;
  const failures = [];
  for (const c of cases) {
    const got = c.kind === 'code' ? (checkPress({ lead: c.lead, entry: c.entry, today: c.today, maxAgeDays: 14 }).length ? 'refuse' : 'keep') : keepOf(c.verdict) ? 'keep' : 'refuse';
    if (got !== c.expect) { wrong++; failures.push(`${c.id}: expected ${c.expect}, got ${got}`); }
  }
  return { measure: 'press', run_at: new Date().toISOString(), cases: cases.length, wrong, errors: 0, partial: false, failures, checks_hash: checksHash('press') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rep = runPressSet({ cases: JSON.parse(fs.readFileSync(PRESS_SET, 'utf8')).cases });
  console.log(`press: ${rep.cases} cases; ${rep.wrong} wrong`);
  rep.failures.forEach((f) => console.log('  ' + f));
  if (process.argv.includes('--write')) console.log('report: ' + writeMeasureReport(rep));
  process.exit(rep.wrong ? 1 : 0);
}
