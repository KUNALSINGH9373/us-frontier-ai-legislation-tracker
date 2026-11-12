// Writes reviewed page-field drafts (pagefields/run.mjs output) into the site data, web/data/v2 and its docs/ copy:
//   node pagefields/apply.mjs <drafts.json> [more drafts.json ...] [--dry-run] [--skip <key,key>]
// Each entry gets only the fields its draft kept, plus page_verification (the reviewer model and when). Before anything is written,
// the whole data set must pass the entry schema, the integrity rules (no new numbers, review recorded) and the site check
// (only the entries named here change; everything else builds exactly as before). Any problem: nothing is written.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadData, writeData } from '../publish/run.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { checkDraft } from './write.mjs';
import { kindOf, needsName, basisOf } from './layout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..', '..');
export const WRITTEN = ['display_name', 'summary_line', 'thirty_seconds', 'key_facts'];

// entries + one drafts file -> { entries, changed: [keys], refusedNow }. A drafts file holds one kind of result: page fields
// (run.mjs: fields), duties (duties-run.mjs: duties + duties_basis), lawsuit claims (claims-run.mjs: claims) or an executive checklist
// (exec-run.mjs: exec_checklist). For page fields, a field a draft did not keep is removed, so a re-run replaces the old one.
export function applyDrafts(entries, results, skip = []) {
  const changed = [], refusedNow = [];
  const out = entries.map((e) => {
    const r = results[e.key];
    if (!r || r.error || skip.includes(e.key)) return e;
    const n = { ...e }, stamp = { method: 'agent', checked_at: r.at, reviewer: r.reviewerModel || 'reviewer', basis_sha256: basisOf(e) };
    if (r.fields) {
      WRITTEN.forEach((f) => { delete n[f]; });
      // the drafts are checked again by today's code rules (a rule added after the draft was written still applies)
      const again = checkDraft({ entry: e, draft: { key_facts: {}, ...r.fields }, kind: kindOf(e), wantName: needsName(e) });
      Object.keys(again.problems).forEach((p) => refusedNow.push(`${e.key} ${p}: ${again.problems[p].join('; ')}`));
      Object.assign(n, again.fields);
      if (WRITTEN.some((f) => n[f] !== undefined)) n.page_verification = stamp;
    }
    if (r.duties && !e.duties) Object.assign(n, { duties: r.duties, duties_basis: r.duties_basis });
    if (r.claims) { n.claims = r.claims; n.page_verification ||= stamp; }
    if (r.exec_checklist) { n.exec_checklist = r.exec_checklist; n.page_verification ||= stamp; }
    if (![...WRITTEN, 'exec_checklist', 'claims'].some((f) => n[f] !== undefined)) delete n.page_verification;
    if (JSON.stringify(n) !== JSON.stringify(e)) changed.push(e.key);
    return n;
  });
  return { entries: out, changed, refusedNow };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2).filter((x, i, all) => !x.startsWith('--') && all[i - 1] !== '--skip'), dry = process.argv.includes('--dry-run');
  const si = process.argv.indexOf('--skip'), skip = si > 0 ? process.argv[si + 1].split(',') : [];
  if (!files.length) { console.error('usage: node pagefields/apply.mjs <drafts.json> [more drafts.json] [--dry-run] [--skip keys]'); process.exit(2); }
  const webDir = path.join(root, 'web', 'data', 'v2'), docsDir = path.join(root, 'docs', 'data', 'v2');
  const before = loadData(webDir);
  let entries = before.entries; const changedAll = new Set(), refusedAll = [];
  for (const f of files) { const r = applyDrafts(entries, JSON.parse(fs.readFileSync(f, 'utf8')).results, skip); entries = r.entries; r.changed.forEach((k) => changedAll.add(k)); refusedAll.push(...r.refusedNow); }
  const changed = [...changedAll], refusedNow = refusedAll;
  if (refusedNow.length) console.log(`left out by today's code rules (${refusedNow.length}):\n- ` + refusedNow.join('\n- '));
  const after = { ...before, entries };
  const v = makeValidator(), problems = [];
  entries.forEach((e) => v.check('entry', e).forEach((p) => problems.push(`${e.key}: ${p}`)));
  checkIntegrity(after).forEach((p) => problems.push('integrity: ' + p));
  const { siteCheck } = await import(pathToFileURL(path.join(root, 'web', 'scripts', 'site-check.mjs')).href);
  const sc = await siteCheck({ before, after, changed });
  sc.problems.forEach((p) => problems.push('site check: ' + p));
  console.log(`${changed.length} entr${changed.length === 1 ? 'y' : 'ies'} change${skip.length ? `; skipped ${skip.join(', ')}` : ''}`);
  if (problems.length) { console.log(`${problems.length} problem(s), nothing written:\n- ` + problems.slice(0, 40).join('\n- ')); process.exit(1); }
  if (dry) { console.log('dry run: all checks passed, nothing written'); process.exit(0); }
  writeData(webDir, after, ['entries']);
  fs.copyFileSync(path.join(webDir, 'entries.json'), path.join(docsDir, 'entries.json'));
  console.log('written to web/data/v2/entries.json and docs/data/v2/entries.json');
}
