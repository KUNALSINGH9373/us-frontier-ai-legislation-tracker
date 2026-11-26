// The backup schedule (.github/workflows/update.yml): GitHub sometimes drops or delays a scheduled run, and a run can fail. A second
// schedule, 2.5 hours after each regular one, runs the update only when no update run has succeeded in the last `hours` hours.
// The last success is GitHub's own record of the workflow's runs (status.json is not: with no data change it is committed at most once a
// day). When that record cannot be read, the backup runs (one run too many is harmless: runs never overlap; a missed day is not).
//   backupDue({ runs, now, hours })    runs: GitHub's "list workflow runs" answer (status=success); -> { run, why }
//   node lib/backup-due.mjs <runs.json|-> [hours]   prints run=true|false and the reason (stdin with "-")
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export function backupDue({ runs, now = new Date(), hours = 3 }) {
  const list = runs && Array.isArray(runs.workflow_runs) ? runs.workflow_runs : null;
  if (!list) return { run: true, why: 'the record of past runs could not be read' };
  const ok = list.filter((r) => r && r.conclusion === 'success' && Number.isFinite(Date.parse(r.updated_at || r.created_at)))
    .map((r) => Date.parse(r.updated_at || r.created_at)).sort((a, b) => b - a)[0];
  if (!ok) return { run: true, why: 'no successful update run on record' };
  const age = (+new Date(now) - ok) / 36e5;
  return age < hours ? { run: false, why: `an update run succeeded ${age.toFixed(1)} h ago` } : { run: true, why: `the last successful update run was ${age.toFixed(1)} h ago` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const src = process.argv[2] || '-', hours = Number(process.argv[3] || 3);
  let runs = null;
  try { runs = JSON.parse(src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8')); } catch { runs = null; }
  const d = backupDue({ runs, hours });
  console.log(`run=${d.run}`);
  console.error(d.why);
}
