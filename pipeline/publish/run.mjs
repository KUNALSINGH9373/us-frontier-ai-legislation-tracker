// The publisher: turns one pipeline run into updated site data. Tier A: official facts on tracked entries, written by code.
// Tier B: new entries the agents drafted and checked (results/*.json), behind the auto_publish.new_entries switch.
//   node publish/run.mjs [run folder] [--dry-run] [--commit] [--data <dir>] [--no-docs]
// Reads the run's changeset.json, diff.json and (when the AI step ran) results.json, and the current web/data/v2/*.json. Writes
// web/data/v2/{entries,news,site,changes}.json (and the same files to docs/data/v2/, which the live site serves), plus
// publish-summary.md in the run folder. A new Congress bill is also added to config/identifiers.json, so later runs keep it current.
// --commit makes one git commit with the summary as its message (never pushes). A quiet run writes nothing.
// Any stop rule (publish/guards.mjs) failing means nothing is written and the exit code is 1.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { sha } from '../grabber/lib/run-common.mjs';
import { applyTierA } from './tier-a.mjs';
import { applyTierB } from './tier-b.mjs';
import { checkPublish } from './guards.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..'), root = path.resolve(pipelineDir, '..');
const readJson = (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback);
const DATA = ['entries', 'news', 'site', 'relationships'];
export const IDENTIFIERS_FILE = path.join(pipelineDir, 'config', 'identifiers.json');
const safe = (id) => id.replace(/[^A-Za-z0-9._-]+/g, '-'); // the file name agents/run.mjs gives each result

// The agents' new-entry drafts for this run: only those marked publishable, read from their own result files.
function loadDrafts(runDir) {
  const s = readJson(path.join(runDir, 'results.json'));
  if (!s) return [];
  return s.items.filter((i) => i.outcome === 'publishable').map((i) => readJson(path.join(runDir, 'results', safe(i.item_id) + '.json'))).filter((r) => r && r.operation === 'create');
}

// A new Congress bill joins the tracked list, marked as added by the pipeline (map-ids.mjs proposes, a person confirms; this one is
// already checked). Written only after the data is written.
function trackNewBills(file, added, entries, runId) {
  const ids = readJson(file, { congress_gov: {} }), byKey = new Map(entries.map((e) => [e.key, e]));
  for (const a of added) {
    const e = byKey.get(a.entry_key), cg = e && e.identifiers && e.identifiers.external && e.identifiers.external.congress_gov;
    if (cg && cg.length && !ids.congress_gov[e.key]) ids.congress_gov[e.key] = { congress_gov: cg, status: 'confirmed', entry_id: e.id, short_name: e.short_name, added_by: 'pipeline', run_id: runId };
  }
  const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(ids, null, 1) + '\n'); fs.renameSync(t, file);
}

export function loadData(dir) {
  const d = Object.fromEntries(DATA.map((k) => [k, readJson(path.join(dir, k + '.json'))]));
  d.changes = readJson(path.join(dir, 'changes.json'), { items: [] });
  return d;
}

// Writes each file to a temp name first, then renames, so a crash never leaves half a file.
export function writeData(dir, data, keys) {
  fs.mkdirSync(dir, { recursive: true });
  for (const k of keys) { const f = path.join(dir, k + '.json'), t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(data[k], null, 1)); fs.renameSync(t, f); }
}

function summaryOf({ runId, runDate, result, check, dry }) {
  const n = result.added.length;
  const L = [`Publish ${runId} (${runDate}): ${result.touched.length} entr${result.touched.length === 1 ? 'y' : 'ies'} updated from official records${n ? `, ${n} new entr${n === 1 ? 'y' : 'ies'} added` : ''}${dry ? ' [dry run, nothing written]' : ''}`, ''];
  for (const a of result.applied) {
    L.push(`- ${a.entry_key}${a.status ? ` (status ${a.status})` : ''}`);
    a.actions.forEach((x) => L.push(`    ${x.date}: ${x.text}`));
  }
  for (const a of result.added) L.push(`- NEW ${a.entry_key} (section ${a.section}, from ${a.item_id})`);
  if (result.skipped.length) { L.push('', 'Not applied (not proved, not allowed, or waiting):'); result.skipped.forEach((s) => L.push(`- ${s.entry_key || s.item_id}: ${s.why}`)); }
  if (check && check.problems.length) { L.push('', 'STOPPED, nothing written:'); check.problems.forEach((p) => L.push(`- ${p}`)); }
  L.push('', 'Tier A: events, status, status text and dates, copied by code from the official record. No AI-written text.');
  if (n) L.push('Tier B: new entries. Facts from the record written by code; what the bill does (and thresholds and penalties where stated) written by the AI, each with a quote code found word for word in the record.');
  return L.join('\n') + '\n';
}

// idsFile: where new Congress bills are recorded as tracked (config/identifiers.json; tests pass their own, or null to skip).
export function publishRun({ runDir, dataDir, docsDir, dry = false, config, idsFile = null }) {
  const changeset = readJson(path.join(runDir, 'changeset.json'));
  const diff = readJson(path.join(runDir, 'diff.json'));
  if (!changeset || !diff) throw new Error(`run folder needs changeset.json and diff.json: ${runDir}`);
  const runId = changeset.run_id, runDate = changeset.generated_at.slice(0, 10);
  const before = loadData(dataDir);

  // Stop rule 5: the stored source text must be exactly what was fetched (its hash was saved at grab time).
  const drafts = loadDrafts(runDir);
  const hashes = [], material = new Set([...diff.items.filter((d) => d.verdict === 'material').map((d) => d.item_id), ...drafts.map((r) => r.item_id)]);
  const readRaw = (item) => fs.readFileSync(path.join(runDir, item.raw_path), 'utf8');
  for (const item of changeset.items.filter((i) => material.has(i.item_id))) {
    const f = path.join(runDir, item.raw_path);
    hashes.push({ item_id: item.item_id, ok: fs.existsSync(f) && sha(fs.readFileSync(f, 'utf8')) === item.raw_hash });
  }

  const lsFile = path.join(pipelineDir, 'config', 'identifiers-legiscan.json');
  const ls = fs.existsSync(lsFile) ? JSON.parse(fs.readFileSync(lsFile, 'utf8')).legiscan || {} : {};
  const identifiersFor = (key) => (ls[key] && ls[key].status !== 'rejected' ? { session: ls[key].bills[0].session_name, external: { legiscan: ls[key].bills.map((b) => b.bill_id) } } : null);
  const a = applyTierA({ data: before, diff, changeset, readRaw, runId, runDate, config, identifiersFor });
  const itemById = new Map(changeset.items.map((i) => [i.item_id, i]));
  // A draft whose stored record changed since it was fetched is not used (the run stops below, stop rule 5).
  const b = applyTierB({ data: a.data, drafts: drafts.filter((r) => hashes.find((h) => h.item_id === r.item_id)?.ok), itemById, readRaw: (item) => JSON.parse(readRaw(item)), runId, runDate, config });
  const result = { ...a, data: b.data, added: b.added, skipped: [...a.skipped, ...b.skipped], log: [...a.log, ...b.log] };
  const after = { ...result.data, relationships: before.relationships };
  const changedAny = result.touched.length || result.added.length;
  const check = changedAny || hashes.some((h) => !h.ok) ? checkPublish({ before, after, runDate, maxEntries: config.max_entries_changed_per_run, maxNew: config.max_new_entries_per_run ?? 0, newKeys: result.added.map((x) => x.entry_key), rawHashOk: hashes }) : { problems: [], changed: 0 };
  const summary = summaryOf({ runId, runDate, result, check, dry });
  fs.writeFileSync(path.join(runDir, 'publish-summary.md'), summary);
  if (check.problems.length) return { status: 'stopped', summary, result, check };
  if (!changedAny) return { status: 'quiet', summary, result, check };
  if (!dry) {
    const keys = ['entries', 'news', 'site', 'changes'];
    writeData(dataDir, after, keys);
    if (docsDir) writeData(docsDir, after, keys);
    if (idsFile && result.added.length) trackNewBills(idsFile, result.added, after.entries, runId);
  }
  return { status: dry ? 'dry-run' : 'published', summary, result, check, after };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), flag = (f) => args.includes(f), opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const runsDir = path.join(pipelineDir, 'data', 'runs');
  const pos = args.filter((a, i) => !a.startsWith('--') && !['--data'].includes(args[i - 1]));
  const runDir = pos[0] ? path.resolve(pos[0]) : path.join(runsDir, fs.readdirSync(runsDir).filter((r) => fs.existsSync(path.join(runsDir, r, 'diff.json'))).sort().pop());
  const config = readJson(path.join(pipelineDir, 'config', 'publish.json'));
  const dataDir = path.resolve(opt('--data') || path.join(root, 'web', 'data', 'v2'));
  const docsDir = !flag('--no-docs') && !opt('--data') && config.copy_to_docs ? path.join(root, 'docs', 'data', 'v2') : null;
  const idsFile = opt('--data') ? null : IDENTIFIERS_FILE; // a test data folder never changes the real tracked list
  const r = publishRun({ runDir, dataDir, docsDir, dry: flag('--dry-run'), config, idsFile });
  process.stdout.write(r.summary);
  if (r.status === 'stopped') process.exit(1);
  if (r.status === 'published' && flag('--commit')) {
    const files = ['entries', 'news', 'site', 'changes'].flatMap((k) => [path.join(dataDir, k + '.json'), ...(docsDir ? [path.join(docsDir, k + '.json')] : [])]).concat(idsFile && r.result.added.length ? [idsFile] : []);
    execFileSync('git', ['add', ...files], { cwd: root, stdio: 'inherit' });
    execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: root, input: `data: ${r.summary}`, stdio: ['pipe', 'inherit', 'inherit'] });
    console.log('committed (not pushed)');
  }
}
