// The relationships measure of the gate (eval/gate.mjs): the links backtest on the real network (both ways: each entry with its links
// removed, and as a new bill with its node removed) AND the links synthetic suite (links/test.mjs: scripted models, quotes, the validator,
// the stop rules) must both be at zero wrong. Code only, no AI. Writes eval/reports/<date>-links.json with the current checks_hash.
//   node eval/links-measure.mjs [--data <dir>] [--no-write]
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { backtest, errorsOf } from '../links/backtest.mjs';
import { checksHash } from './hash.mjs';
import { writeMeasureReport } from './gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');

// suite: { passed, failed } from the synthetic suite's last line ("links: N passed, M failed"); null when it could not be run or read.
export function linksMeasure({ entries, relationships, suite, now = new Date() }) {
  const b = backtest({ entries, relationships }), fresh = backtest({ entries, relationships, asNew: true });
  const backtestErrors = errorsOf(b) + errorsOf(fresh), suiteFailed = suite ? suite.failed : 1;
  return {
    measure: 'links', run_at: now.toISOString(), checks_hash: checksHash('relationships'),
    cases: b.proposals + fresh.proposals + (suite ? suite.passed + suite.failed : 0),
    wrong: backtestErrors + suiteFailed, errors: suite ? 0 : 1,
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
  const args = process.argv.slice(2), i = args.indexOf('--data'), dir = i >= 0 ? args[i + 1] : path.join(P, '..', 'web', 'data', 'v2');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const rep = linksMeasure({ entries: read('entries.json'), relationships: read('relationships.json'), suite: runSuite() });
  console.log(`links measure: ${rep.cases} cases, ${rep.wrong} wrong (backtest ${rep.backtest_errors}, synthetic suite ${rep.suite_failed} failed of ${rep.suite_passed + rep.suite_failed})`);
  if (!args.includes('--no-write')) console.log('wrote ' + writeMeasureReport(rep));
  process.exit(rep.wrong ? 1 : 0);
}
