// The whole chain in one command, as the 4-hourly schedule will run it:
//   grab (Congress.gov, Federal Register, LegiScan) -> compare -> publish (Tier A) -> site check -> status.json -> commit
//   node update.mjs [--dry-run] [--commit] [--source <congress_gov|federal_register|legiscan|all>] [--no-search]
// --dry-run: fetch and compare, but save no state and write no site data. --commit: one local git commit when the data
// changed (never pushes). A run that changes nothing rewrites only web/data/v2/status.json ("checked N minutes ago").
// Only one update runs at a time (data/update.lock). Exit code 1 on any failure; the site data is then left as it was.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { compareRun } from './compare/run.mjs';
import { publishRun } from './publish/run.mjs';
import { makeValidator } from './schema/validate.mjs';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(pipelineDir, '..');
const args = process.argv.slice(2), flag = (f) => args.includes(f), opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const dry = flag('--dry-run'), source = opt('--source') || 'all';
const dataDir = path.join(root, 'web', 'data', 'v2'), docsDir = path.join(root, 'docs', 'data', 'v2');
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const config = readJson(path.join(pipelineDir, 'config', 'publish.json'));
const SOURCES = source === 'all' ? ['congress_gov', 'federal_register', 'legiscan'] : [source];
const DATA_FILES = ['entries', 'news', 'site', 'changes'];

// ---- one run at a time ----
const lock = path.join(pipelineDir, 'data', 'update.lock');
if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 6 * 3600e3) { console.error(`another update is running (${lock}); waiting for the next run`); process.exit(1); }
fs.mkdirSync(path.dirname(lock), { recursive: true });
fs.writeFileSync(lock, String(process.pid));
const snapshot = Object.fromEntries(DATA_FILES.map((k) => [k, fs.existsSync(path.join(dataDir, k + '.json')) ? fs.readFileSync(path.join(dataDir, k + '.json')) : null]));
const restore = () => { for (const [k, b] of Object.entries(snapshot)) for (const d of [dataDir, ...(config.copy_to_docs ? [docsDir] : [])]) { const f = path.join(d, k + '.json'); if (b) fs.writeFileSync(f, b); else if (fs.existsSync(f)) fs.rmSync(f); } };

let code = 0;
try {
  // ---- 1. grab ----
  const started = new Date();
  const grabArgs = ['grabber/run.mjs', '--source', source, ...(dry ? ['--dry-run'] : []), ...(flag('--no-search') ? ['--no-search'] : [])];
  console.log('> node ' + grabArgs.join(' '));
  const out = execFileSync(process.execPath, grabArgs, { cwd: pipelineDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(out);
  const runs = [...out.matchAll(/\brun (run-[0-9]{8}-[0-9]{4}-[0-9a-f]{4}):/g)].map((m) => m[1]);
  if (runs.length !== SOURCES.length) throw new Error(`expected ${SOURCES.length} run(s) from the grabber, got ${runs.length}`);

  // ---- 2. compare and 3. publish, one run after another (each publish reads the data the previous one wrote) ----
  const published = [], summaries = [];
  for (const id of runs) {
    const runDir = path.join(pipelineDir, 'data', 'runs', id);
    const entries = readJson(path.join(dataDir, 'entries.json'));
    const diff = compareRun({ runDir, entries });
    console.log(`compare ${id}: ${JSON.stringify(diff.summary)}`);
    const r = publishRun({ runDir, dataDir, docsDir: config.copy_to_docs ? docsDir : null, dry, config });
    console.log(`publish ${id}: ${r.status}`);
    if (r.status === 'stopped') { process.stdout.write(r.summary); throw new Error(`publish stopped for ${id}; nothing from it was written`); }
    if (r.status === 'published' || r.status === 'dry-run') { if (r.result.touched.length) { published.push(id); summaries.push(r.summary); } }
  }

  // ---- 4. the site check: v1 and v2 still build the same model for every entry the pipeline has not changed ----
  if (published.length && !dry) {
    try { execFileSync(process.execPath, [path.join(root, 'web', 'scripts', 'parity-v2.mjs')], { cwd: root, stdio: 'inherit' }); }
    catch { restore(); throw new Error('site check failed after publishing; the data was put back as it was'); }
  }

  // ---- 5. status.json: what readers see as "checked for updates ..." ----
  const ids = readJson(path.join(pipelineDir, 'config', 'identifiers.json'), {}).congress_gov || {};
  const ls = readJson(path.join(pipelineDir, 'config', 'identifiers-legiscan.json'), {}).legiscan || {};
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const checkedKeys = [...(SOURCES.includes('congress_gov') ? Object.keys(ids) : []), ...(SOURCES.includes('legiscan') ? Object.keys(ls) : [])];
  const prev = readJson(path.join(dataDir, 'status.json'), { checked: {} });
  const changes = readJson(path.join(dataDir, 'changes.json'), { items: [] }).items;
  const site = readJson(path.join(dataDir, 'site.json'));
  const status = {
    last_checked: now, sources: SOURCES, run_ids: runs, outcome: 'ok',
    last_change: changes.length ? changes[changes.length - 1].date : site.updates_through,
    checked: { ...prev.checked, ...Object.fromEntries(checkedKeys.map((k) => [k, now])) }
  };
  const errs = makeValidator().check('status', status);
  if (errs.length) throw new Error('status.json failed its schema: ' + errs.join('; '));
  if (!dry) for (const d of [dataDir, ...(config.copy_to_docs ? [docsDir] : [])]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'status.json'), JSON.stringify(status, null, 1)); }
  console.log(`${dry ? '[dry run] ' : ''}${published.length ? `${published.length} run(s) changed the data` : 'no data change'}; checked ${checkedKeys.length} tracked entries in ${((Date.now() - started) / 1000).toFixed(0)}s`);

  // ---- 6. commit (local only) ----
  if (flag('--commit') && !dry) {
    const files = ['status', ...(published.length ? DATA_FILES : [])].flatMap((k) => [path.join(dataDir, k + '.json'), ...(config.copy_to_docs ? [path.join(docsDir, k + '.json')] : [])]).filter((f) => fs.existsSync(f));
    execFileSync('git', ['add', ...files], { cwd: root, stdio: 'inherit' });
    const msg = published.length ? `data: ${summaries.join('\n')}` : `status only: checked ${SOURCES.join(', ')} at ${now}, no change`;
    try { execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: root, input: msg, stdio: ['pipe', 'inherit', 'inherit'] }); console.log('committed (not pushed)'); }
    catch { console.log('nothing to commit'); }
  }
} catch (e) {
  console.error('FAILED: ' + e.message);
  code = 1;
} finally {
  fs.rmSync(lock, { force: true });
}
process.exit(code);
