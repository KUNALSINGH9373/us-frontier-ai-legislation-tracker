// The backup schedule's decision (lib/backup-due.mjs): run only when no update run succeeded in the last 3 hours; run when unsure.
//   node lib/test-backup-due.mjs
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { backupDue } from './backup-due.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const NOW = new Date('2026-11-26T06:47:00Z');
const run = (at, conclusion = 'success') => ({ id: 1, conclusion, status: 'completed', created_at: at, updated_at: at });

ok('the 04:17 run succeeded (at 04:31): the 06:47 backup does not run', backupDue({ runs: { workflow_runs: [run('2026-11-26T04:31:00Z')] }, now: NOW }).run === false);
ok('the last success was the 00:17 run: the backup runs', backupDue({ runs: { workflow_runs: [run('2026-11-26T00:33:00Z')] }, now: NOW }).run === true);
ok('a failed run does not count as a success', backupDue({ runs: { workflow_runs: [run('2026-11-26T04:31:00Z', 'failure'), run('2026-11-26T00:33:00Z')] }, now: NOW }).run === true);
ok('the newest success counts whatever the order', backupDue({ runs: { workflow_runs: [run('2026-11-25T20:30:00Z'), run('2026-11-26T05:00:00Z')] }, now: NOW }).run === false);
ok('no success on record: run', backupDue({ runs: { workflow_runs: [] }, now: NOW }).run === true);
ok('an unreadable record: run (one run too many is harmless)', backupDue({ runs: null, now: NOW }).run === true && backupDue({ runs: { message: 'Bad credentials' }, now: NOW }).run === true);
ok('the reason is said', /succeeded 2\.3 h ago/.test(backupDue({ runs: { workflow_runs: [run('2026-11-26T04:31:00Z')] }, now: NOW }).why));
// the command line the workflow calls: reads GitHub's answer on stdin, prints run=true|false
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fresh = new Date(Date.now() - 3600e3).toISOString();
  const r = spawnSync(process.execPath, [path.join(here, 'backup-due.mjs'), '-'], { input: JSON.stringify({ workflow_runs: [run(fresh)] }), encoding: 'utf8' });
  ok('the command prints run=false after a success an hour ago', r.status === 0 && r.stdout.trim() === 'run=false', r.stdout + r.stderr);
  const bad = spawnSync(process.execPath, [path.join(here, 'backup-due.mjs'), '-'], { input: 'not json', encoding: 'utf8' });
  ok('the command prints run=true on an unreadable answer', bad.status === 0 && bad.stdout.trim() === 'run=true');
}
console.log(`backup schedule: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
