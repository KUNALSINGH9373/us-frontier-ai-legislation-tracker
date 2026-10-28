// Backtest of the duty checks the agents' duty step uses (agents/duties.mjs) against the duties already on the site, written in sessions.
//   node duties/backtest.mjs [--data <dir>]          (default web/data/v2; reads only, no AI, writes nothing)
// For every entry with duties: the stored text still has the hash in duties_basis, the whole set passes checkDuties as a session draft
// does, and each answer on its own passes checkAnswer, the per-answer gate an agent-written answer must clear. If the agents' gate
// rejected an answer the sessions wrote and the checker accepted, the two would disagree; this shows they do not.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkDuties, checkAnswer, loadText } from './check.mjs';
import { sha } from '../grabber/lib/run-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function backtest(entries, readText = loadText) {
  const rows = [];
  for (const e of entries.filter((x) => x.duties)) {
    const problems = [], b = e.duties_basis || {};
    let text = null;
    try { text = readText(e.key); } catch (err) { problems.push(err.message); }
    if (text != null) {
      if (b.sha256 && b.sha256 !== sha(text)) problems.push('the stored text has changed since the duties were written (hash differs)');
      checkDuties(e.duties, text, { sourceUrl: b.source_url }).forEach((p) => problems.push('set: ' + p));
      Object.entries(e.duties).forEach(([k, d]) => checkAnswer(k, d, text, { sourceUrl: b.source_url }).forEach((p) => problems.push('answer: ' + p)));
    }
    rows.push({ key: e.key, method: b.method || null, problems });
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), di = args.indexOf('--data');
  const dir = di >= 0 ? args[di + 1] : path.join(here, '..', '..', 'web', 'data', 'v2');
  const rows = backtest(JSON.parse(fs.readFileSync(path.join(dir, 'entries.json'), 'utf8')));
  rows.forEach((r) => console.log(r.problems.length ? `FAIL ${r.key}\n  ${r.problems.join('\n  ')}` : `ok   ${r.key} (${r.method})`));
  const bad = rows.filter((r) => r.problems.length).length;
  console.log(bad ? `${bad} of ${rows.length} FAILED` : `${rows.length} of ${rows.length} accepted by the checker and the per-answer gate`);
  process.exit(bad ? 1 : 0);
}
