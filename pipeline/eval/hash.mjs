// The code a gate measure depends on. Every report carries checks_hash for its measure, and the gate (eval/gate.mjs) counts a report only
// while that hash matches the pipeline as it is now: any change that could change a measured outcome needs a new report.
// What is hashed (round 3, audit gate item 2): ALL of pipeline/ (code, prompts, config, case sets, eval gold and sources, fixtures, tests),
// except what a run writes: node_modules/, data/, out/, state/, eval/reports/, eval/report.md and .env files. config/publish.json is hashed
// without its auto_publish switches (turning a switch on must not make its own report stale). The relationships measure also hashes its
// inputs on the real network (web/data/v2/entries.json and relationships.json): a changed network needs a new links report.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const P = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', 'data', 'out', 'state', 'eval/reports', '.git']);
const SKIP_FILES = new Set(['eval/report.md']);
const skipFile = (rel) => SKIP_FILES.has(rel) || /(^|\/)\.env(\..*)?$/.test(rel) || /\.tmp$/.test(rel);

// Every file under root that can change a measured outcome, as sorted paths relative to root (forward slashes).
export function pipelineFiles(root = P) {
  const out = [];
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(r)) walk(path.join(dir, d.name), r); }
      else if (d.isFile() && !skipFile(r)) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

// Extra inputs per measure (paths relative to pipeline/), on top of every pipeline file.
export const MEASURE_INPUTS = {
  fields: [],
  new_entries: [],
  relationships: ['../web/data/v2/entries.json', '../web/data/v2/relationships.json'],
  news: []
};
export const MEASURE_FILES = MEASURE_INPUTS; // older name

const contentOf = (rel, p) => {
  if (!fs.existsSync(p)) return '(missing)';
  let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  if (rel === 'config/publish.json') { try { const j = JSON.parse(s); delete j.auto_publish; s = JSON.stringify(j); } catch { /* hashed as is */ } }
  return s;
};

// sha256 over the files' paths and contents (line endings normalised, so a checkout on Windows hashes like one on Linux).
export function checksHash(measure, root = P) {
  const extra = MEASURE_INPUTS[measure];
  if (!extra) throw new Error(`no such gate measure: ${measure}`);
  const h = crypto.createHash('sha256');
  h.update(`measure ${measure}\n`);
  for (const f of [...pipelineFiles(root), ...[...extra].sort()]) {
    h.update(f + '\n');
    h.update(contentOf(f, path.join(root, f)));
    h.update('\n\0');
  }
  return h.digest('hex');
}
export const currentHashes = (root = P) => Object.fromEntries(Object.keys(MEASURE_INPUTS).map((m) => [m, checksHash(m, root)]));
