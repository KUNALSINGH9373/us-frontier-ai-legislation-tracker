// Reads a change set, compares every item with the tracker, writes diff.json next to it.
//   node compare/run.mjs                       the newest run in data/runs
//   node compare/run.mjs data/runs/<run id>    a specific run
//   ... --entries <file>                        compare against another copy of the data (default web/data/v2/entries.json)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareCongress } from './congress.mjs';
import { compareFederalRegister } from './federal-register.mjs';
import { compareLegiScan } from './legiscan.mjs';
import { makeValidator } from '../schema/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');

export function compareRun({ runDir, entries }) {
  const changeset = JSON.parse(fs.readFileSync(path.join(runDir, 'changeset.json'), 'utf8'));
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const v = makeValidator();
  // How many LegiScan bills each state entry covers (a House and a Senate version, companions), from config.
  const idFile = path.join(pipelineDir, 'config', 'identifiers-legiscan.json');
  const lsIds = fs.existsSync(idFile) ? JSON.parse(fs.readFileSync(idFile, 'utf8')).legiscan || {} : {};
  const legiscanBills = (entry) => (entry && lsIds[entry.key] ? lsIds[entry.key].bills.length : 1);
  const diffs = changeset.items.map((item) => {
    const compare = { congress_gov: compareCongress, federal_register: compareFederalRegister, legiscan: (o) => compareLegiScan({ ...o, billsOfEntry: legiscanBills(o.entry) }) }[item.source];
    if (!compare) throw new Error(`no comparer for source ${item.source}`);
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, item.raw_path), 'utf8'));
    const d = compare({ item, raw, entry: item.entry_key ? byKey.get(item.entry_key) : null });
    const errs = v.check('diff', d);
    if (errs.length) throw new Error(`diff for ${item.item_id} failed its schema: ${errs.join('; ')}`);
    return d;
  });
  const summary = diffs.reduce((n, d) => ({ ...n, [d.verdict]: (n[d.verdict] || 0) + 1 }), {});
  const out = { run_id: changeset.run_id, summary, items: diffs };
  fs.writeFileSync(path.join(runDir, 'diff.json'), JSON.stringify(out, null, 1) + '\n');
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const runsDir = path.join(pipelineDir, 'data', 'runs');
  const args = process.argv.slice(2), ei = args.indexOf('--entries'), pos = args.filter((a, i) => !a.startsWith('--') && i !== ei + 1);
  const runDir = pos[0] ? path.resolve(pos[0]) : path.join(runsDir, fs.readdirSync(runsDir).filter((r) => fs.existsSync(path.join(runsDir, r, 'changeset.json'))).sort().pop());
  // The live site data (v1 is frozen; the publisher writes web/data/v2). --entries <file> compares against another copy.
  const entries = JSON.parse(fs.readFileSync(ei >= 0 ? path.resolve(args[ei + 1]) : path.join(pipelineDir, '..', 'web', 'data', 'v2', 'entries.json'), 'utf8'));
  const r = compareRun({ runDir, entries });
  console.log(`${r.run_id}: ${JSON.stringify(r.summary)}`);
  r.items.filter((d) => d.verdict !== 'unchanged').forEach((d) => console.log(`  [${d.verdict}] ${d.item_id} ${d.entry_key || '(new)'}\n      ` + d.reasons.map((x) => `${x.kind}: ${x.detail}`).join('\n      ')));
}
