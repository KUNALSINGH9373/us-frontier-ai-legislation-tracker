// The relationships measure of the gate (eval/gate.mjs): the links backtest on the real network (both ways: each entry with its links
// removed, and as a new bill with its node removed) AND the links synthetic suite (links/test.mjs: scripted models, quotes, the validator,
// the stop rules) must both be at zero wrong. Code only, no AI. Writes eval/reports/<date>-links.json with the current checks_hash.
//   node eval/links-measure.mjs [--data <dir>] [--no-write]
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { backtest, errorsOf } from '../links/backtest.mjs';
import { loadRunRecords } from '../links/records.mjs';
import { checksHash } from './hash.mjs';
import { writeMeasureReport } from './gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');

// suite: { passed, failed } from the synthetic suite's last line ("links: N passed, M failed"); null when it could not be run or read.
// records: the official records the runs stored for the entries (links/records.mjs loadRunRecords), so record-proved sponsor links (the
// only kind ever applied) are proposed and scored; wrong applied (record-proved) edges are counted on their own and must be 0.
export function linksMeasure({ entries, relationships, suite, records = {}, now = new Date() }) {
  const b = backtest({ entries, relationships, records }), fresh = backtest({ entries, relationships, asNew: true, records });
  const appliedWrong = b.applied.wrong.length + fresh.applied.wrong.length, appliedProposals = b.applied.proposals + fresh.applied.proposals;
  const backtestErrors = errorsOf(b) + errorsOf(fresh) + b.applied.wrong.filter((w) => w.why === 'conflict').length + fresh.applied.wrong.filter((w) => w.why === 'conflict').length, suiteFailed = suite ? suite.failed : 1;
  return {
    measure: 'links', run_at: now.toISOString(), checks_hash: checksHash('relationships'),
    cases: b.proposals + fresh.proposals + (suite ? suite.passed + suite.failed : 0),
    wrong: backtestErrors + suiteFailed, applied_wrong: appliedWrong, applied_proposals: appliedProposals, records_entries: Object.keys(records).length, errors: suite ? 0 : 1,
    backtest_errors: backtestErrors, backtest: { proposals: b.proposals, recovered: b.recovered.size, edges: b.edges, as_new_proposals: fresh.proposals },
    suite_passed: suite ? suite.passed : 0, suite_failed: suiteFailed, suite_note: suite ? null : 'the links synthetic suite could not be run or its result read'
  };
}
export function runSuite() {
  const r = spawnSync(process.execPath, ['--import', './lib/test-cleanup.mjs', 'links/test.mjs'], { cwd: P, encoding: 'utf8', maxBuffer: 64 << 20 });
  const m = /links: (\d+) passed, (\d+) failed/.exec(String(r.stdout || ''));
  return m ? { passed: +m[1], failed: +m[2] } : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), i2 = args.indexOf('--runs'), i = args.indexOf('--data'), dir = i >= 0 ? args[i + 1] : path.join(P, '..', 'web', 'data', 'v2');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const rep = linksMeasure({ entries: read('entries.json'), relationships: read('relationships.json'), suite: runSuite(), records: loadRunRecords(i2 >= 0 ? args[i2 + 1] : path.join(P, 'data', 'runs'), read('entries.json')) });
  console.log(`links measure: ${rep.cases} cases, ${rep.wrong} wrong (backtest ${rep.backtest_errors}, synthetic suite ${rep.suite_failed} failed of ${rep.suite_passed + rep.suite_failed})`);
  if (!args.includes('--no-write')) console.log('wrote ' + writeMeasureReport(rep));
  process.exit(rep.wrong ? 1 : 0);
}
