// The whole chain in one command, as the 4-hourly schedule will run it:
//   grab (Congress.gov, Federal Register, LegiScan) -> compare -> AI step (agents) -> publish (Tier A) -> site check -> status.json -> report -> commit
//   node update.mjs [--dry-run] [--commit] [--source <congress_gov|federal_register|legiscan|all>] [--no-search] [--no-ai] [--no-notify] [--notify]
// --dry-run: fetch and compare, but save no state, write no site data and make no AI calls. --commit: one local git commit when the data
// changed (never pushes). A run that changes nothing rewrites only web/data/v2/status.json ("checked N minutes ago").
// Only one update runs at a time (data/update.lock). Exit code 1 on any failure; the site data is then left as it was.
// Every run, quiet or failed, ends with a run report (data/updates/<id>/run-report.json) and, when Telegram is configured, a message
// (--no-notify turns it off; a dry run sends one only with --notify). The AI step spends money: config/publish.json "ai_step" and the
// monthly cap in config/models.json bound it.
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { compareRun } from './compare/run.mjs';
import { publishRun } from './publish/run.mjs';
import { runAgents } from './agents/run.mjs';
import { makeValidator } from './schema/validate.mjs';
import { loadEnv } from './grabber/lib/env.mjs';
import { createLlmFactory } from './llm/make.mjs';
import { summarize } from './llm/spend.mjs';
import { newReport, sourceEntry, aiEntry, publishEntry, finalize, writeReport } from './report/build.mjs';
import { formatReport } from './report/format.mjs';
import { createTelegram, tokenFromEnv } from './notify/telegram.mjs';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(pipelineDir, '..');
const args = process.argv.slice(2), flag = (f) => args.includes(f), opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const dry = flag('--dry-run'), source = opt('--source') || 'all';
loadEnv(pipelineDir);
const dataDir = path.join(root, 'web', 'data', 'v2'), docsDir = path.join(root, 'docs', 'data', 'v2');
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const config = readJson(path.join(pipelineDir, 'config', 'publish.json'));
const models = readJson(path.join(pipelineDir, 'config', 'models.json'));
const SOURCES = source === 'all' ? ['congress_gov', 'federal_register', 'legiscan'] : [source];
const DATA_FILES = ['entries', 'news', 'site', 'changes'];

// Anything that looks like a key or token is removed from error text before it is saved or sent.
const secretValues = () => Object.entries(process.env).filter(([k, v]) => /(KEY|TOKEN|SECRET)/i.test(k) && v && v.length > 8).map(([, v]) => v);
const scrub = (t) => secretValues().reduce((s, v) => s.split(v).join('***'), String(t));

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
const rep = newReport({ id: 'update-' + stamp, now: startedAt, dry, sources: SOURCES });
const factory = createLlmFactory({ models, log: (m) => console.log('  ' + m) });
let step = 'start';

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
  step = 'grab';
  const grabArgs = ['grabber/run.mjs', '--source', source, ...(dry ? ['--dry-run'] : []), ...(flag('--no-search') ? ['--no-search'] : [])];
  console.log('> node ' + grabArgs.join(' '));
  const g = spawnSync(process.execPath, grabArgs, { cwd: pipelineDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(g.stdout || ''); process.stderr.write(g.stderr || '');
  if (g.error || g.status !== 0) {
    // The reason is the grabber's own last message (e.g. "CONGRESS_API_KEY is not set"), not Node's generic "Command failed".
    const last = String(g.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
    throw new Error(`the grabber stopped (exit ${g.status ?? '?'}): ${last || (g.error && g.error.message) || 'no message'}`);
  }
  const out = g.stdout;
  const runs = [...out.matchAll(/\brun (run-[0-9]{8}-[0-9]{4}-[0-9a-f]{4}):/g)].map((m) => m[1]);
  if (runs.length !== SOURCES.length) throw new Error(`expected ${SOURCES.length} run(s) from the grabber, got ${runs.length}`);
  const runDirOf = (id) => path.join(pipelineDir, 'data', 'runs', id);

  // ---- AI step: is it allowed this run? ----
  const ai = config.ai_step || { enabled: false };
  const aiOff = dry ? 'dry run (no AI calls are made)' : flag('--no-ai') ? 'turned off with --no-ai' : !ai.enabled ? 'turned off in config/publish.json' : !factory.hasKey ? `${factory.keyName} is not set` : factory.monthStatus().over ? 'the monthly AI cost cap is reached' : null;
  rep.ai.enabled = !aiOff; rep.ai.skipped_why = aiOff;

  // ---- 2. compare, 3. AI step, 4. publish: one run after another (each publish reads the data the previous one wrote) ----
  const published = [], summaries = [];
  for (const id of runs) {
    const runDir = runDirOf(id);
    step = 'compare';
    const entries = readJson(path.join(dataDir, 'entries.json'));
    const diff = compareRun({ runDir, entries });
    console.log(`compare ${id}: ${JSON.stringify(diff.summary)}`);
    const grab = readJson(path.join(runDir, 'grab-stats.json'), {});
    rep.sources.push(sourceEntry({ runDir, source: grab.source || SOURCES[runs.indexOf(id)] }));

    if (!aiOff && (diff.summary.material || diff.summary.new_entry_candidate)) {
      step = 'AI step';
      console.log(`agents ${id}: up to ${ai.max_items_per_run || 10} item(s)`);
      const s = await runAgents({ runDir, entries, config: models, factory, today: new Date().toISOString().slice(0, 10), maxItems: ai.max_items_per_run || 10, log: (m) => console.log('  ' + m) });
      rep.ai.runs.push(aiEntry({ runDir, results: s }));
      if (s.stopped_by_month_cap) rep.notes.push('the monthly AI cost cap was reached during this run; the rest waits until next month');
    }

    step = 'publish';
    const newsBefore = (readJson(path.join(dataDir, 'news.json'), { items: [] }).items || []).length;
    const r = publishRun({ runDir, dataDir, docsDir: config.copy_to_docs ? docsDir : null, dry, config });
    console.log(`publish ${id}: ${r.status}`);
    if (r.status === 'stopped') { process.stdout.write(r.summary); throw new Error(`publish stopped for ${id}; nothing from it was written`); }
    const newsAfter = r.result && r.result.data ? (r.result.data.news.items || []).length : newsBefore;
    rep.publish.runs.push(publishEntry({ result: r.result, newsBefore, newsAfter, status: r.status }));
    if (r.status === 'published' || r.status === 'dry-run') { if (r.result.touched.length) { published.push(id); summaries.push(r.summary); } }
  }
  const aiDrafts = rep.ai.runs.reduce((k, a) => k + a.publishable, 0);
  if (aiDrafts) rep.notes.push(`${aiDrafts} AI-drafted entr${aiDrafts === 1 ? 'y is' : 'ies are'} ready but not published: publishing new bills comes in the next build step`);

  // ---- 5. the site check: v1 and v2 still build the same model for every entry the pipeline has not changed ----
  if (published.length && !dry) {
    step = 'site check';
    try { execFileSync(process.execPath, [path.join(root, 'web', 'scripts', 'parity-v2.mjs')], { cwd: root, stdio: 'inherit' }); }
    catch { restore(); throw new Error('site check failed after publishing; the data was put back as it was'); }
  }

  // ---- 6. status.json: what readers see as "checked for updates ..." ----
  step = 'status';
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
  console.log(`${dry ? '[dry run] ' : ''}${published.length ? `${published.length} run(s) changed the data` : 'no data change'}; checked ${checkedKeys.length} tracked entries in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

  // ---- 7. commit (local only) ----
  if (flag('--commit') && !dry) {
    step = 'commit';
    const files = ['status', ...(published.length ? DATA_FILES : [])].flatMap((k) => [path.join(dataDir, k + '.json'), ...(config.copy_to_docs ? [path.join(docsDir, k + '.json')] : [])]).filter((f) => fs.existsSync(f));
    execFileSync('git', ['add', ...files], { cwd: root, stdio: 'inherit' });
    const msg = published.length ? `data: ${summaries.join('\n')}` : `status only: checked ${SOURCES.join(', ')} at ${now}, no change`;
    try { execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: root, input: msg, stdio: ['pipe', 'inherit', 'inherit'] }); console.log('committed (not pushed)'); }
    catch { console.log('nothing to commit'); }
  }
} catch (e) {
  rep.outcome = 'failed'; rep.failed_step = step; rep.error = scrub(e.message);
  console.error('FAILED: ' + rep.error);
  code = 1;
} finally {
  fs.rmSync(lock, { force: true });
}

// ---- the run report, and the message (even when the run failed) ----
try {
  const entries = readJson(path.join(dataDir, 'entries.json'), []);
  rep.names = Object.fromEntries(entries.filter((e) => rep.publish.runs.some((p) => p.entries_updated.some((u) => u.entry_key === e.key))).map((e) => [e.key, e.short_name]));
  const finished = new Date();
  finalize(rep, { now: finished, spend: summarize(factory.spend.between(startedAt, finished)), month: factory.monthStatus() });
  const file = writeReport(rep, path.join(pipelineDir, 'data', 'updates', rep.id));
  console.log(`run report: ${path.relative(root, file)}`);
  const text = formatReport(rep);
  const wantsNotify = !flag('--no-notify') && (!dry || flag('--notify')) && config.notify && config.notify.telegram !== false;
  if (!wantsNotify) console.log(`\n--- message (not sent: ${flag('--no-notify') ? '--no-notify' : dry ? 'dry run; add --notify to send' : 'turned off in config/publish.json'}) ---\n${text}\n---`);
  else if (!tokenFromEnv() || !process.env.TELEGRAM_CHAT_ID) console.log(`\n--- message (not sent: no Telegram token or chat id configured) ---\n${text}\n---`);
  else {
    try { const n = await createTelegram().send(text); console.log(`telegram: sent ${n} message${n === 1 ? '' : 's'}`); }
    catch (e) { console.error('telegram: could not send the report: ' + scrub(e.message)); console.log(`\n--- message (not delivered) ---\n${text}\n---`); }
  }
} catch (e) {
  console.error('could not write or send the run report: ' + scrub(e.message));
}
process.exit(code);
