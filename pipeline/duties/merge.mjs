// Folds checked duty drafts into web/data/v2/entries.json.
//   node duties/merge.mjs [--dry-run] [--data <dir>] [key ...]      (all drafts when no key is given)
// A draft is merged only if duties/check.mjs finds no problem and the whole entry still passes the entry schema.
// The entry gets `duties` and `duties_basis` (which text, its hash, when, method "session"); nothing else about the entry
// changes, so its own verification and the parity checks are untouched. docs/ is rebuilt later by web/scripts/publish-site.mjs.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkDraft, loadDraft, loadText, DRAFTS } from './check.mjs';
import { makeValidator } from '../schema/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export function mergeDrafts({ entries, keys, now = new Date() }) {
  const v = makeValidator(), done = [], failed = [];
  for (const key of keys) {
    const e = entries.find((x) => x.key === key);
    if (!e) { failed.push([key, ['no entry with this key']]); continue; }
    let problems;
    try {
      const draft = loadDraft(key), text = loadText(key);
      problems = checkDraft(draft, text);
      if (!problems.length) {
        if (!draft.basis) problems.push('draft has not been stamped (run duties/stamp.mjs)');
        else {
          const next = { ...e, duties: draft.duties, duties_basis: { ...draft.basis, method: 'session', checked_at: now.toISOString().replace(/\.\d+Z$/, 'Z') } };
          problems = v.check('entry', next).map((m) => 'entry schema: ' + m);
          if (!problems.length) { Object.assign(e, next); done.push(key); }
        }
      }
    } catch (err) { problems = [err.message]; }
    if (problems.length) failed.push([key, problems]);
  }
  return { done, failed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), dry = args.includes('--dry-run');
  const di = args.indexOf('--data'), dir = di >= 0 ? args[di + 1] : path.join(here, '..', '..', 'web', 'data', 'v2');
  const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--data');
  const keys = named.length ? named : fs.readdirSync(DRAFTS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const file = path.join(dir, 'entries.json'), entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { done, failed } = mergeDrafts({ entries, keys });
  failed.forEach(([k, p]) => console.log(`SKIP ${k}\n  ` + p.join('\n  ')));
  console.log(`${done.length} merged, ${failed.length} skipped${dry ? ' (dry run, nothing written)' : ''}`);
  if (!dry && done.length) { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(entries, null, 1)); fs.renameSync(t, file); }
  process.exit(failed.length ? 1 : 0);
}
