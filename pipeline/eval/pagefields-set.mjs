// The page-fields measure (gate switch auto_publish.page_fields): code only, free, deterministic. It replays the checks every written
// page field must pass (pagefields/write.mjs checkDraft and applyVerdicts) over a fixed case set (eval/pagefields-set/cases.json):
//   good  drafts the production writer and reviewer wrote and a person reviewed against the record (11-12 Nov 2026): must pass
//   bad   the same drafts with one planted fault (an invented number, words about the record, two sentences, a pending bill as law,
//         a key fact or name not copied from the record, a formal "An Act ..." name, an entry-describing opening, markup): must be refused
//   review  recorded reviewer verdicts: a "misleading" or "wrong" verdict, or an "ok" without a quote found in the record, must drop the field
// wrong = a bad case that passed or a review case that kept its field; errors = a good case refused. The gate counts a report only at zero
// of both, over the whole set, made by the current code.
//   node eval/pagefields-set.mjs [--write]      (--write saves the report to eval/reports/)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkDraft, applyVerdicts } from '../pagefields/write.mjs';
import { entryText } from '../pagefields/layout.mjs';
import { checksHash } from './hash.mjs';
import { writeMeasureReport } from './gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PAGEFIELDS_SET = path.join(here, 'pagefields-set', 'cases.json');

// The field a case is about passed (good/bad) or was kept (review).
function outcome(c) {
  if (c.kind === 'review') { const a = applyVerdicts({ fields: c.fields, verdicts: c.verdicts, text: entryText(c.entry) }); return !!a.keep[c.field.split('.')[0]]; }
  const r = checkDraft({ entry: c.entry, draft: { key_facts: {}, ...c.draft }, kind: c.layout, wantName: !!c.want_name });
  const [top, sub] = c.field.split('.');
  return top === 'key_facts' ? !!(r.fields.key_facts && r.fields.key_facts[sub]) : !!r.fields[top];
}

export function runPageFieldsSet({ cases }) {
  let wrong = 0, errors = 0;
  const failures = [];
  for (const c of cases) {
    const passed = outcome(c);
    if (c.kind === 'good' && !passed) { errors++; failures.push(`refused a good draft: ${c.id}`); }
    if (c.kind !== 'good' && passed) { wrong++; failures.push(`let through: ${c.id}`); }
  }
  return { measure: 'page_fields', run_at: new Date().toISOString(), cases: cases.length, wrong, errors, partial: false, failures: failures.slice(0, 20), checks_hash: checksHash('page_fields'),
    by_kind: Object.fromEntries(['good', 'bad', 'review'].map((k) => [k, cases.filter((c) => c.kind === k).length])) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rep = runPageFieldsSet({ cases: JSON.parse(fs.readFileSync(PAGEFIELDS_SET, 'utf8')).cases });
  console.log(`page fields: ${rep.cases} cases (${rep.by_kind.good} good, ${rep.by_kind.bad} bad, ${rep.by_kind.review} review); ${rep.wrong} wrong, ${rep.errors} errors`);
  rep.failures.forEach((f) => console.log('  ' + f));
  if (process.argv.includes('--write')) console.log('report: ' + writeMeasureReport(rep));
  process.exit(rep.wrong || rep.errors ? 1 : 0);
}
