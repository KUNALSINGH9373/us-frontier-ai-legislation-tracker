// The whole chain in one command, as the 4-hourly schedule will run it:
//   grab (Congress.gov, Federal Register, LegiScan) -> compare -> AI step (agents) -> publish (Tier A, then Tier B new entries) -> court dockets
//   -> self-correction -> links -> news -> status.json -> final checks -> site check -> promote -> report -> commit
//   node update.mjs [--dry-run] [--commit] [--source <congress_gov|federal_register|legiscan|all>] [--no-search] [--no-ai] [--no-notify] [--notify]
// Every step writes to a staging copy (data/staging/<run id>/: the site data, the tracked-bill lists and the run-to-run state). After
// the last step the whole run is checked once against the data as it was at the start (publish/guards.mjs, with the union of what each
// step was allowed to change, and the per-run limit over the whole run), then the site check (web/scripts/parity-v2.mjs) reads the staged
// data. Only then is everything promoted at once: the same bytes to web/data/v2 and docs/data/v2, the lists to config/, the state to
// state/. Any failure anywhere leaves every one of those files as it was (the LegiScan usage counter and the AI ledger in state/ count
// what was really spent, so they are written at once).
// A stop that names what it refused (a source's publish, the court dockets, the final check) does not stop the run: those items or
// entries are left out and held in state/held-items.json (retried every run for a day, then daily, and reported every run), and the rest
// is promoted. A stop that names nothing it refused promotes nothing, as any other failure.
// --dry-run: fetch and compare, but promote nothing and make no AI calls. --commit: one local git commit when anything changed (never
// pushes): the data files, their docs copies, the tracked-bill lists and state/. status.json alone ("checked N minutes ago") is
// committed at most once a day. Only one update runs at a time (data/update.lock). Exit code 1 on any failure, including a git failure.
// Every run, quiet or failed, ends with a run report (data/updates/<id>/run-report.json) and, when Telegram is configured, a message
// (--no-notify turns it off; a dry run sends one only with --notify). The AI step spends money: config/publish.json "ai_step" and the
// monthly cap in config/models.json bound it.
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { compareRun } from './compare/run.mjs';
import { publishRun, loadData, writeData, IDENTIFIERS_FILE, LEGISCAN_IDS_FILE } from './publish/run.mjs';
import { checkPublish } from './publish/guards.mjs';
import { runAgents } from './agents/run.mjs';
import { correctRun } from './correct/run.mjs';
import { linkRun } from './links/run.mjs';
import { courtsRun } from './publish/courts.mjs';
import { createRateLimiter } from './grabber/sources/courtlistener.mjs';
import { createHttp } from './grabber/lib/http.mjs';
import { newsRun } from './news/run.mjs';
import { makeValidator } from './schema/validate.mjs';
import { loadEnv } from './grabber/lib/env.mjs';
import { STATE_DIR, WORK_DIR, PROMOTED_STATE, LEGISCAN_USAGE_FILE, LEDGER_DIR } from './grabber/lib/state.mjs';
import { createStaging, plan, promote, rollback } from './lib/staging.mjs';
import { createLlmFactory } from './llm/make.mjs';
import { summarize } from './llm/spend.mjs';
import { newReport, sourceEntry, aiEntry, publishEntry, finalize, writeReport } from './report/build.mjs';
import { formatReport } from './report/format.mjs';
import { formatHtml } from './report/html.mjs';
import { createTelegram, tokenFromEnv } from './notify/telegram.mjs';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(pipelineDir, '..');
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
// The site data files a run may change. status.json is written every run but committed alone at most once a day.
export const DATA_FILES = ['entries', 'news', 'site', 'changes', 'relationships'];
export const ALL_SOURCES = ['congress_gov', 'federal_register', 'legiscan'];

export const defaultPaths = () => ({
  pipelineDir, root, dataDir: path.join(root, 'web', 'data', 'v2'), docsDir: path.join(root, 'docs', 'data', 'v2'),
  idsFile: IDENTIFIERS_FILE, lsIdsFile: LEGISCAN_IDS_FILE, stateDir: STATE_DIR, workDir: WORK_DIR
});

// Items a stop rule refused (state/held-items.json, promoted with the run): { items: { "<step>:<item id or entry key>": { item_id?,
// entry_key?, step, reason, first_seen, last_tried, tries, replay? } } }. The run leaves them out and publishes the rest; a held item is
// tried again every run for its first day, then once a day, and leaves the list when it passes. replay: the stored item (change-set
// item, diff, raw record, the AI result for a new entry), because the grabber will not fetch an unchanged item again.
export const HELD_FILE = 'held-items.json';
export const heldDue = (h, now) => +now - Date.parse(h.first_seen) < 86400e3 || String(h.last_tried).slice(0, 10) < now.toISOString().slice(0, 10);
const heldId = (h) => `${h.step}:${h.item_id || h.entry_key || 'step'}`;
const safe = (id) => id.replace(/[^A-Za-z0-9._-]+/g, '-'); // the file name agents/run.mjs gives each result
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Which of `names` (entry keys, item ids) each problem names. A problem that names none is unexplained: the run then stops as before.
export function namedIn(problems, names) {
  const named = new Map(), unexplained = [];
  for (const p of problems) {
    const hit = names.filter((k) => new RegExp(`(^|[^A-Za-z0-9_-])${escRe(k)}([^A-Za-z0-9_-]|$)`).test(p));
    if (!hit.length) unexplained.push(p);
    hit.forEach((k) => { if (!named.has(k)) named.set(k, p); });
  }
  return { named, unexplained };
}
// One item of a grabber run, kept so it can be published again later on its own.
function replayOf(runDir, id) {
  const cs = readJson(path.join(runDir, 'changeset.json'), { items: [] }), item = cs.items.find((i) => i.item_id === id);
  if (!item || !item.raw_path || !fs.existsSync(path.join(runDir, item.raw_path))) return null;
  const df = readJson(path.join(runDir, 'diff.json'), { items: [] }), res = readJson(path.join(runDir, 'results.json'));
  const r = res && res.items.find((i) => i.item_id === id), rf = path.join(runDir, 'results', safe(id) + '.json');
  return { run_id: cs.run_id, item, diff: df.items.find((d) => d.item_id === id) || null, raw: fs.readFileSync(path.join(runDir, item.raw_path), 'utf8'), result: r && fs.existsSync(rf) ? { summary: r, draft: readJson(rf) } : null };
}
// A one-item run folder from a stored item, dated today.
function writeReplay(dir, r, generatedAt) {
  fs.rmSync(dir, { recursive: true, force: true });
  const w = (f, x) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), typeof x === 'string' ? x : JSON.stringify(x, null, 1)); };
  w('changeset.json', { run_id: r.run_id, generated_at: generatedAt, items: [r.item] });
  w('diff.json', { items: r.diff ? [r.diff] : [] });
  w(r.item.raw_path, r.raw);
  if (r.result) { w('results.json', { items: [r.result.summary] }); w(path.join('results', safe(r.item.item_id) + '.json'), r.result.draft); }
  return dir;
}
// Puts entries back as they were at the start of the run (a new one is removed), with their news items and change-log records from this
// run; the court-docket state of those entries goes back too, so the docket is read again.
function revertEntries({ S, before, keys, courtsStart }) {
  const cur = loadData(S.v2), set = new Set(keys), was = new Map(before.entries.map((e) => [e.key, e]));
  cur.entries = cur.entries.flatMap((e) => (!set.has(e.key) ? [e] : was.has(e.key) ? [JSON.parse(JSON.stringify(was.get(e.key)))] : []));
  const ut = cur.site.updates_through;
  cur.entries.filter((e) => set.has(e.key)).forEach((e) => e.events.forEach((v) => { if (v.scheduled !== undefined || v.date > ut) v.scheduled = v.date > ut; }));
  const oldNews = new Set(before.news.items.map((x) => JSON.stringify(x)));
  cur.news.items = cur.news.items.filter((x) => oldNews.has(JSON.stringify(x)) || !set.has(x.tracker));
  const n0 = (before.changes.items || []).length;
  cur.changes.items = [...cur.changes.items.slice(0, n0), ...cur.changes.items.slice(n0).filter((x) => !set.has(x.entry_key))];
  writeData(S.v2, cur, ['entries', 'news', 'changes']);
  for (const f of Object.values(S.ids)) {
    const ids = readJson(f);
    if (!ids) continue;
    let hit = false;
    for (const list of Object.values(ids)) if (list && typeof list === 'object') for (const k of keys) if (!was.has(k) && list[k]) { delete list[k]; hit = true; }
    if (hit) fs.writeFileSync(f, JSON.stringify(ids, null, 1) + '\n');
  }
  const cf = S.stateFile('courts-state.json');
  if (fs.existsSync(cf)) {
    const st = readJson(cf), old = courtsStart ? JSON.parse(courtsStart.toString('utf8')) : { dockets: {} };
    for (const [id, d] of Object.entries(st.dockets || {})) if (set.has(d.entry_key)) { if (old.dockets && old.dockets[id]) st.dockets[id] = old.dockets[id]; else delete st.dockets[id]; }
    fs.writeFileSync(cf, JSON.stringify(st, null, 1) + '\n');
  }
}

// Anything that looks like a key or token is removed from error text before it is saved or sent.
const secretValues = (env) => Object.entries(env).filter(([k, v]) => /(KEY|TOKEN|SECRET)/i.test(k) && v && v.length > 8).map(([, v]) => v);
export const scrubWith = (env) => (t) => secretValues(env).reduce((s, v) => s.split(v).join('***'), String(t));

// The grabber, as its own process. It reads and writes the run-to-run state in the staging folder (--state-dir), never the real one.
function spawnGrab({ P, source, dry, noSearch, stateDir, log }) {
  const grabArgs = ['grabber/run.mjs', '--source', source, '--state-dir', stateDir, ...(dry ? ['--dry-run'] : []), ...(noSearch ? ['--no-search'] : [])];
  log('> node ' + grabArgs.join(' '));
  const g = spawnSync(process.execPath, grabArgs, { cwd: P.pipelineDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(g.stdout || ''); process.stderr.write(g.stderr || '');
  if (g.error || g.status !== 0) {
    // The reason is the grabber's own last message (e.g. "CONGRESS_API_KEY is not set"), not Node's generic "Command failed".
    const last = String(g.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
    throw new Error(`the grabber stopped (exit ${g.status ?? '?'}): ${last || (g.error && g.error.message) || 'no message'}`);
  }
  return [...g.stdout.matchAll(/\brun (run-[0-9]{8}-[0-9]{4}-[0-9a-f]{4}):/g)].map((m) => m[1]);
}

// git in the repository; returns { status, stdout } so "nothing staged" (exit 1 of diff --quiet) is told apart from a real failure.
function runGit(args, { cwd, input } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8' });
  if (r.error) throw new Error(`git ${args[0]} could not run: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const defaultParity = (P) => (v2dir) => execFileSync(process.execPath, [path.join(P.root, 'web', 'scripts', 'parity-v2.mjs'), v2dir], { cwd: P.root, stdio: 'inherit' });

// The commit. Stages the full list (data files and their docs copies, the tracked-bill lists, state/), commits when anything is staged.
// status.json goes in with a data or state change, or alone at most once a day. Any git failure throws.
export function commitRun({ P, git, config, dataChanged, today, summaries, sources, now, log }) {
  const ok = (r, what) => { if (r.status !== 0) throw new Error(`git ${what} failed (exit ${r.status}): ${(r.stderr || '').trim().slice(0, 300)}`); return r; };
  const dirs = [P.dataDir, ...(config.copy_to_docs ? [P.docsDir] : [])];
  const data = DATA_FILES.flatMap((k) => dirs.map((d) => path.join(d, k + '.json')));
  const status = dirs.map((d) => path.join(d, 'status.json'));
  const rel = (f) => path.relative(P.root, f).split(path.sep).join('/');
  ok(git(['add', '--', ...[...data, P.idsFile, P.lsIdsFile].filter((f) => fs.existsSync(f)).map(rel), rel(P.stateDir)], { cwd: P.root }), 'add');
  const staged = (files) => { const r = git(['diff', '--cached', '--quiet', '--', ...files], { cwd: P.root }); if (r.status > 1) ok(r, 'diff --cached'); return r.status === 1; };
  const anything = staged([]);
  // status.json alone: once a day (each status commit redeploys the site)
  const lastStatus = ok(git(['log', '-1', '--format=%cs', '--', rel(status[0])], { cwd: P.root }), 'log').stdout.trim();
  if (anything || lastStatus !== today) ok(git(['add', '--', ...status.filter((f) => fs.existsSync(f)).map(rel)], { cwd: P.root }), 'add');
  if (!staged([])) { log('nothing to commit'); return { committed: false }; }
  const msg = dataChanged ? `data: ${summaries.join('\n')}` : anything ? `state: checked ${sources.join(', ')} at ${now}, no data change` : `status only: checked ${sources.join(', ')} at ${now}, no change`;
  ok(git(['commit', '-q', '-F', '-'], { cwd: P.root, input: msg }), 'commit');
  log('committed (not pushed)');
  return { committed: true, message: msg };
}

// After a failed run only the spend counters are committed (the LegiScan usage and the AI ledger record money and queries really used).
function commitCounters({ P, git, usageFile, ledgerDir, log }) {
  const rel = (f) => path.relative(P.root, f).split(path.sep).join('/');
  const files = [usageFile, ledgerDir].filter((f) => fs.existsSync(f)).map(rel);
  if (!files.length) return;
  const a = git(['add', '--', ...files], { cwd: P.root });
  if (a.status !== 0) throw new Error(`git add failed (exit ${a.status})`);
  const d = git(['diff', '--cached', '--quiet', '--', ...files], { cwd: P.root });
  if (d.status === 0) return;
  if (d.status > 1) throw new Error(`git diff --cached failed (exit ${d.status})`);
  const c = git(['commit', '-q', '-F', '-', '--', ...files], { cwd: P.root, input: 'state: LegiScan usage and AI spend after a failed run' });
  if (c.status !== 0) throw new Error(`git commit failed (exit ${c.status})`);
  log('committed the spend counters (not pushed)');
}

// One update run. Returns { code, rep }. deps replaces any step (tests run the whole chain on fixtures with no network).
export async function runUpdate({ P = defaultPaths(), config, models, factory, flags = {}, env = process.env, now = () => new Date(), deps = {}, log = (m) => console.log(m), logErr = (m) => console.error(m) } = {}) {
  const dry = !!flags.dry, source = flags.source || 'all';
  const SOURCES = source === 'all' ? ALL_SOURCES : [source];
  const startedAt = now();
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const rep = newReport({ id: 'update-' + stamp, now: startedAt, dry, sources: SOURCES });
  const scrub = scrubWith(env), today = startedAt.toISOString().slice(0, 10);
  const git = deps.git || runGit, parity = deps.parity || defaultParity(P);
  const usageFile = path.join(P.stateDir, path.basename(LEGISCAN_USAGE_FILE)), ledgerDir = path.join(P.stateDir, path.basename(LEDGER_DIR));
  const validateStatus = deps.validateStatus || ((s) => makeValidator().check('status', s));
  let step = 'start', code = 0, S = null;
  const stamped = startedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');

  // ---- one run at a time ----
  const lock = path.join(P.workDir, 'update.lock');
  if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 6 * 3600e3) { logErr(`another update is running (${lock}); waiting for the next run`); return { code: 1, rep: null }; }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));

  try {
    // ---- 0. the staging copy: every step below writes here, nothing else ----
    step = 'staging';
    S = createStaging({ dir: path.join(P.workDir, 'staging', rep.id), dataDir: P.dataDir, docsDir: config.copy_to_docs ? P.docsDir : null, idsFiles: { ids: P.idsFile, lsIds: P.lsIdsFile }, stateDir: P.stateDir, stateFiles: [...PROMOTED_STATE, HELD_FILE], dataFiles: [...DATA_FILES, 'status'] });
    const before = loadData(S.v2); // the data as it was at the start: the final check compares the whole run with it
    // ---- held items: what a stop rule refused on earlier runs, and what it refuses now ----
    const held = readJson(S.stateFile(HELD_FILE), { items: {} }); held.items = held.items || {};
    const heldNow = [], tried = new Set(), isDue = (h) => heldDue(h, startedAt);
    const hold = (x, reason) => {
      const same = Object.entries(held.items).filter(([, h]) => (x.item_id ? h.item_id === x.item_id : !h.item_id && h.entry_key === x.entry_key && h.step === x.step));
      const prev = same.map(([, h]) => h).sort((a, b) => a.first_seen.localeCompare(b.first_seen))[0];
      same.forEach(([id]) => delete held.items[id]);
      const replay = x.replay || (prev && prev.replay) || null;
      const h = { ...(x.item_id ? { item_id: x.item_id } : {}), ...(x.entry_key ? { entry_key: x.entry_key } : {}), step: x.step, reason: String(reason).slice(0, 300), first_seen: prev ? prev.first_seen : stamped, last_tried: stamped, tries: (prev ? prev.tries : 0) + 1, ...(replay ? { replay } : {}) };
      held.items[heldId(h)] = h; heldNow.push(h);
      return h;
    };
    const itemsByKey = {}; // entry key -> the publish items that changed it this run ({ item_id, runDir } or { item_id, replay })

    // ---- 1. grab ----
    step = 'grab';
    const runs = await (deps.grab || ((o) => spawnGrab(o)))({ P, source, dry, noSearch: !!flags.noSearch, stateDir: S.stateDir, log });
    if (runs.length !== SOURCES.length) throw new Error(`expected ${SOURCES.length} run(s) from the grabber, got ${runs.length}`);
    const runDirOf = (id) => path.join(P.workDir, 'runs', id);

    // ---- AI step: is it allowed this run? ----
    const ai = config.ai_step || { enabled: false };
    const aiOff = dry ? 'dry run (no AI calls are made)' : flags.noAi ? 'turned off with --no-ai' : !ai.enabled ? 'turned off in config/publish.json' : !factory.hasKey ? `${factory.keyName} is not set` : factory.monthStatus().over ? 'the monthly AI cost cap is reached' : null;
    rep.ai.enabled = !aiOff; rep.ai.skipped_why = aiOff;
    const capOff = () => aiOff || (factory.monthStatus().over ? 'the monthly AI cost cap is reached' : null);

    // ---- 2. compare, 3. AI step, 4. publish: one run after another (each publish reads the staged data the previous one wrote) ----
    const published = [], summaries = [], newKeys = [], checked = {};
    const seenFresh = new Set();
    // One publish result into the report and the run's lists.
    const recordPublish = (r, label, newsBefore, src) => {
      const newsAfter = r.result && r.result.data ? (r.result.data.news.items || []).length : newsBefore;
      rep.publish.runs.push(publishEntry({ result: r.result, newsBefore, newsAfter, status: r.status }));
      if (r.status === 'published' || r.status === 'dry-run') { if (r.result.touched.length || r.result.added.length) { published.push(label); summaries.push(r.summary); } }
      if (r.result && r.result.added) newKeys.push(...r.result.added.map((x) => x.entry_key));
      if (r.result) [...(r.result.applied || []), ...(r.result.added || [])].forEach((a) => (itemsByKey[a.entry_key] = itemsByKey[a.entry_key] || []).push({ item_id: a.item_id, ...src }));
    };
    for (const id of runs) {
      const runDir = runDirOf(id);
      step = 'compare';
      const entries = readJson(path.join(S.v2, 'entries.json'));
      const diff = (deps.compareRun || compareRun)({ runDir, entries });
      log(`compare ${id}: ${JSON.stringify(diff.summary)}`);
      const grab = readJson(path.join(runDir, 'grab-stats.json'), {});
      rep.sources.push(sourceEntry({ runDir, source: grab.source || SOURCES[runs.indexOf(id)] }));
      if (grab.stats && grab.stats.list_fallback) rep.notes.push(`Congress.gov's date-filtered list was down; fallback used (the plain list, newest first, ${grab.stats.fallback_pages} page(s))`);
      if (grab.skipped_why) rep.notes.push(`${grab.source || 'a source'} skipped: ${grab.skipped_why}`);
      (grab.checked_keys || []).forEach((k) => { checked[k] = stamped; }); // only the tracked entries read without error this run

      if (!aiOff && (diff.summary.material || diff.summary.new_entry_candidate)) {
        step = 'AI step';
        log(`agents ${id}: up to ${ai.max_items_per_run || 10} item(s)`);
        const s = await (deps.runAgents || runAgents)({ runDir, entries, config: models, factory, today, maxItems: ai.max_items_per_run || 10, log: (m) => log('  ' + m) });
        rep.ai.runs.push(aiEntry({ runDir, results: s }));
        if (s.stopped_by_month_cap) rep.notes.push('the monthly AI cost cap was reached during this run; the rest waits until next month');
      }

      step = 'publish';
      const newsBefore = (readJson(path.join(S.v2, 'news.json'), { items: [] }).items || []).length;
      // A held item that comes again with something to publish: the fresh copy replaces the stored one; before it is due it is left out.
      const runItems = new Set([...readJson(path.join(runDir, 'diff.json'), { items: [] }).items.filter((d) => d.verdict === 'material').map((d) => d.item_id), ...(readJson(path.join(runDir, 'results.json'), { items: [] }).items || []).filter((i) => i.outcome === 'publishable').map((i) => i.item_id)]);
      runItems.forEach((x) => seenFresh.add(x));
      const waiting = Object.values(held.items).filter((h) => h.item_id && runItems.has(h.item_id));
      waiting.filter((h) => !isDue(h)).forEach((h) => { const rp = replayOf(runDir, h.item_id); if (rp) h.replay = rp; });
      const skip = waiting.filter((h) => !isDue(h)).map((h) => h.item_id);
      waiting.filter(isDue).forEach((h) => tried.add(heldId(h)));
      let r;
      // A stop names the entries (or items) it refused: those items are held and the rest of the run is published without them.
      for (let round = 0; ; round++) {
        r = (deps.publishRun || publishRun)({ runDir, dataDir: S.v2, docsDir: null, dry, config, idsFile: S.ids.ids, lsIdsFile: S.ids.lsIds, skip: [...skip] });
        log(`publish ${id}: ${r.status}${skip.length ? ` (${skip.length} held item(s) left out)` : ''}`);
        if (r.status !== 'stopped') break;
        const diffItems = readJson(path.join(runDir, 'diff.json'), { items: [] }).items.filter((d) => !skip.includes(d.item_id) && d.verdict === 'material');
        const cands = [...diffItems.map((d) => ({ item_id: d.item_id, entry_key: d.entry_key })), ...((r.result && r.result.added) || []).map((a) => ({ item_id: a.item_id, entry_key: a.entry_key }))];
        const { named, unexplained } = namedIn((r.check && r.check.problems) || [], [...new Set(cands.flatMap((c) => [c.item_id, c.entry_key]))]);
        const off = cands.filter((c) => named.has(c.item_id) || named.has(c.entry_key));
        if (!named.size || unexplained.length || !off.length || round >= 5) { log(r.summary); throw new Error(`publish stopped for ${id}; nothing from this run was promoted`); }
        off.forEach((c) => { if (skip.includes(c.item_id)) return; hold({ ...c, step: 'publish', replay: replayOf(runDir, c.item_id) }, named.get(c.item_id) || named.get(c.entry_key)); skip.push(c.item_id); });
      }
      recordPublish(r, id, newsBefore, { runDir });
    }

    // ---- 4'. held items due for another try that no grabber run brought again: each published alone from its stored copy ----
    for (const [hid, h] of Object.entries(held.items).filter(([, x]) => x.item_id && x.replay && isDue(x) && !seenFresh.has(x.item_id) && !heldNow.includes(x))) {
      step = 'publish (held items)';
      tried.add(hid);
      const newsBefore = (readJson(path.join(S.v2, 'news.json'), { items: [] }).items || []).length;
      let r;
      try { r = (deps.publishRun || publishRun)({ runDir: writeReplay(path.join(S.dir, 'held', safe(h.item_id)), h.replay, stamped), dataDir: S.v2, docsDir: null, dry, config, idsFile: S.ids.ids, lsIdsFile: S.ids.lsIds }); }
      catch (e) { r = { status: 'stopped', check: { problems: [e.message] } }; }
      log(`publish held ${h.item_id}: ${r.status}`);
      if (r.status === 'stopped') { hold(h, ((r.check && r.check.problems) || [])[0] || 'stopped again'); continue; }
      recordPublish(r, 'held ' + h.item_id, newsBefore, { replay: h.replay });
    }

    // ---- 4a. court dockets: material entries on the tracked federal cases (config/courts.json), as Tier A facts ----
    if (config.courts && config.courts.enabled) {
      step = 'court dockets';
      const token = env.COURTLISTENER_API_TOKEN;
      if (!token) rep.notes.push('court dockets not checked: COURTLISTENER_API_TOKEN is not set');
      else {
        const http = deps.courtsHttp || createHttp({ headers: { Authorization: 'Token ' + token }, secrets: [token], maxRequests: config.courts.max_requests_per_run || 12, log: (m) => log('  ' + m) });
        const newsBefore = (readJson(path.join(S.v2, 'news.json'), { items: [] }).items || []).length;
        const allCases = readJson(path.join(P.pipelineDir, 'config', 'courts.json'), {}), limiter = createRateLimiter({ perMinute: 5 });
        const heldCases = Object.values(held.items).filter((h) => h.step === 'court dockets');
        const skipKeys = heldCases.filter((h) => !isDue(h)).map((h) => h.entry_key);
        let k;
        // A stop names the cases it refused: those are held (their docket state stays, so they are read again) and the rest is read again.
        for (let round = 0; ; round++) {
          const cases = Object.fromEntries(Object.entries(allCases).filter(([key]) => !skipKeys.includes(key)));
          k = await (deps.courtsRun || courtsRun)({ http, limiter, cases, dataDir: S.v2, docsDir: null, stateFile: S.stateFile('courts-state.json'), config, runId: rep.id, now: startedAt, dry, log: (m) => log('  ' + m) });
          log(`court dockets: ${k.status}; ${k.requests} request(s)${skipKeys.length ? ` (${skipKeys.length} held case(s) left out)` : ''}`);
          if (k.status !== 'stopped') break;
          const { named, unexplained } = namedIn((k.check && k.check.problems) || [], Object.keys(cases).filter((x) => !x.startsWith('_')));
          if (!named.size || unexplained.length || round >= 3) { log(k.summary); throw new Error('court-docket publish stopped; nothing from this run was promoted'); }
          named.forEach((reason, key) => { hold({ entry_key: key, step: 'court dockets' }, reason); skipKeys.push(key); });
        }
        heldCases.filter((h) => isDue(h) && (k.read || []).some((x) => x.entry_key === h.entry_key)).forEach((h) => tried.add(heldId(h)));
        k.errors.forEach((x) => rep.notes.push(`court docket not read: ${x}`));
        (k.read || []).forEach((x) => { checked[x.entry_key] = stamped; });
        const newsAfter = k.result.data ? (k.result.data.news.items || []).length : newsBefore;
        if (k.result.touched.length) { rep.publish.runs.push(publishEntry({ result: { ...k.result, added: [] }, newsBefore, newsAfter, status: k.status })); published.push('court dockets'); summaries.push(k.summary); }
      }
    }

    // ---- 4b. self-correction: once a day, re-read tracked bills and fix confirmed errors and omissions in the reading fields ----
    step = 'self-correction';
    const c = await (deps.correctRun || correctRun)({ dataDir: S.v2, docsDir: null, stateFile: S.stateFile('corrections.json'), config, factory, aiOff: capOff(), dry, today, now: startedAt, runId: rep.id, log: (m) => log('  ' + m) });
    rep.corrections = c;
    log(`self-correction: ${c.skipped_why ? 'skipped (' + c.skipped_why + ')' : `${c.checked.length} checked, ${c.corrected.length} field(s) corrected, ${c.status}`}`);
    if (c.status === 'written') { published.push('self-correction'); summaries.push(c.summary); }
    const corrected = {};
    if (c.status === 'written') (c.corrected || []).forEach((x) => { (corrected[x.entry_key] = corrected[x.entry_key] || []).includes(x.field) || corrected[x.entry_key].push(x.field); });

    // ---- 4c. links: propose links for the entries this run added or changed (code only); added only when auto_publish.relationships is on ----
    step = 'links';
    const touchedKeys = [...new Set([...rep.publish.runs.flatMap((p) => [...p.entries_updated, ...p.entries_added].map((u) => u.entry_key)), ...(c.corrected || []).map((x) => x.entry_key)])];
    const l = await (deps.linkRun || linkRun)({ dataDir: S.v2, docsDir: null, changed: touchedKeys, config, runDate: today, maxEntries: config.max_entries_changed_per_run, dry, log: (m) => log('  ' + m) });
    rep.links = l;
    log(`links: ${l.proposed.length} proposed, ${l.applied.length} added (${l.status})`);
    if (l.status === 'stopped') rep.notes.push('links were not added (a stop rule failed: ' + l.problems[0] + ')');
    if (l.status === 'written' && l.applied.length) { published.push('links'); summaries.push(l.summary); }

    // ---- 4d. news: feed leads, and items written from official releases (added only when auto_publish.news is on) ----
    step = 'news';
    const nw = await (deps.newsRun || newsRun)({ dataDir: S.v2, docsDir: null, seenFile: S.stateFile('news-seen.json'), config, factory, aiOff: capOff(), dry, today, now: startedAt, runId: rep.id, log: (m) => log('  ' + m) });
    rep.news = nw;
    log(`news: ${nw.skipped_why ? 'skipped (' + nw.skipped_why + ')' : `${nw.leads.length} lead(s), ${nw.drafted.length} drafted, ${nw.status}`}`);
    if (nw.status === 'written') { published.push('news'); summaries.push(nw.summary); }

    // ---- 5. status.json: what readers see as "checked for updates ..." (only the entries really read this run) ----
    step = 'status';
    const prev = readJson(path.join(S.v2, 'status.json'), { checked: {} });
    const changes = readJson(path.join(S.v2, 'changes.json'), { items: [] }).items;
    const site = readJson(path.join(S.v2, 'site.json'));
    const status = {
      last_checked: stamped, sources: SOURCES, run_ids: runs, outcome: 'ok',
      last_change: changes.length ? changes[changes.length - 1].date : site.updates_through,
      checked: { ...prev.checked, ...checked }
    };
    const errs = validateStatus(status);
    if (errs.length) throw new Error('status.json failed its schema: ' + errs.join('; '));
    fs.writeFileSync(path.join(S.v2, 'status.json'), JSON.stringify(status, null, 1));
    log(`${dry ? '[dry run] ' : ''}${published.length ? `${published.length} step(s) changed the data` : 'no data change'}; checked ${Object.keys(checked).length} tracked entries in ${((+now() - +startedAt) / 1000).toFixed(0)}s`);

    if (!dry) {
      // ---- 6. the final check: the whole run against the data at its start, with the union of what each step was allowed to change ----
      step = 'final check';
      // The links allowance is what the links step itself applied (its edges, in order, and only the nodes those edges need), never
      // whatever the data happens to hold: an edge another step appended is refused.
      const brief = (e) => [e.from, e.to, e.type, e.label].join('|');
      let linksOn = l.status === 'written' && l.applied.length > 0;
      const linksAllowance = (after) => {
        if (!linksOn) return null;
        const tail = after.relationships.edges.slice(before.relationships.edges.length);
        const edges = l.added ? l.added.edges : tail.length === l.applied.length && tail.every((e, i) => brief(e) === brief(l.applied[i])) ? tail : l.applied;
        const ends = new Set(edges.flatMap((e) => [e.from, e.to]));
        return { edges, nodes: l.added ? l.added.nodes : Object.fromEntries(Object.entries(after.relationships.nodes).filter(([key]) => !before.relationships.nodes[key] && ends.has(key))) };
      };
      // A problem that names entries holds those entries (put back as they were; their items retried later); a problem in the link
      // network holds the links step (the network put back). Anything else is unexplained and nothing is promoted.
      for (let round = 0; ; round++) {
        const after = loadData(S.v2);
        const check = checkPublish({ before, after, runDate: today, maxEntries: config.max_entries_changed_per_run, maxNew: config.max_new_entries_per_run ?? 0, newKeys, corrected, links: linksAllowance(after) });
        if (!check.problems.length) break;
        const linkProblems = check.problems.filter((p) => /^(relationships changed|added link)/.test(p));
        const keys = [...new Set([...before.entries, ...after.entries].map((e) => e.key))];
        const { named, unexplained } = namedIn(check.problems.filter((p) => !linkProblems.includes(p)), keys);
        if (unexplained.length || (!named.size && !linkProblems.length) || round >= 3) { rep.final_check = check.problems.slice(0, 20); throw new Error(`the final check over the whole run failed (${check.problems.length} problem(s)): ${check.problems.slice(0, 3).join('; ')}`); }
        if (linkProblems.length) {
          writeData(S.v2, before, ['relationships']);
          hold({ step: 'links' }, linkProblems[0]);
          linksOn = false; rep.links = { ...l, status: 'held', applied: [] };
          const i = published.indexOf('links'); if (i >= 0) { published.splice(i, 1); summaries.splice(i, 1); }
        }
        if (named.size) {
          revertEntries({ S, before, keys: [...named.keys()], courtsStart: S.start.get(path.join(P.stateDir, 'courts-state.json')) });
          named.forEach((reason, key) => {
            delete corrected[key];
            const ni = newKeys.indexOf(key); if (ni >= 0) newKeys.splice(ni, 1);
            const items = itemsByKey[key] || [];
            if (items.length) items.forEach((x) => hold({ item_id: x.item_id, entry_key: key, step: 'final check', replay: x.replay || (x.runDir && replayOf(x.runDir, x.item_id)) }, reason));
            else hold({ entry_key: key, step: 'final check' }, reason);
            rep.publish.runs.forEach((pr) => { pr.entries_updated = pr.entries_updated.filter((u) => u.entry_key !== key); pr.entries_added = pr.entries_added.filter((u) => u.entry_key !== key); });
          });
        }
      }
      // Held items tried again this run that no check refused leave the list; an entry or step held by the final check leaves it once a
      // run that was due to retry it passes.
      Object.entries(held.items).filter(([id, h]) => !heldNow.includes(h) && (tried.has(id) || (['final check', 'links'].includes(h.step) && !h.item_id && isDue(h)))).forEach(([id]) => delete held.items[id]);
      if (Object.keys(held.items).length || fs.existsSync(S.stateFile(HELD_FILE))) fs.writeFileSync(S.stateFile(HELD_FILE), JSON.stringify(held, null, 1) + '\n');
      rep.stops = Object.values(held.items).map(({ replay, ...h }) => h);
      if (heldNow.length) rep.notes.push(`${heldNow.length} item(s) refused by a stop rule and held (state/held-items.json): ${heldNow.map((h) => `${h.item_id || h.entry_key || h.step} at ${h.step}`).join(', ')}; everything else was promoted`);

      // ---- 7. the site check on the staged data: v1 and v2 still build the same model for every entry the pipeline has not changed ----
      if (published.length) {
        step = 'site check';
        try { parity(S.v2); } catch (e) { throw new Error('site check failed on the staged data; nothing was promoted'); }
      }

      // ---- 8. promote: everything at once, or nothing ----
      step = 'promote';
      const p = plan(S);
      if (p.problems.length) throw new Error('nothing promoted: ' + p.problems.slice(0, 3).join('; '));
      const written = promote(p.writes, deps.io);
      // web and docs must hold the same bytes; if not, every promoted file goes back to the bytes it had before the promotion
      if (config.copy_to_docs) for (const f of [...DATA_FILES, 'status'].map((x) => x + '.json').filter((x) => fs.existsSync(path.join(S.v2, x)))) {
        const w = path.join(P.dataDir, f), d = path.join(P.docsDir, f);
        if (!fs.existsSync(w) || !fs.existsSync(d) || !(deps.readBack || fs.readFileSync)(w).equals(fs.readFileSync(d))) { rollback(p.writes); throw new Error(`after promotion web and docs differ in ${f}; every promoted file was put back`); }
      }
      rep.promoted = written.map((f) => path.relative(P.root, f).split(path.sep).join('/'));
      log(`promoted ${written.length} file(s)`);

      // ---- 9. commit (local only) ----
      if (flags.commit) {
        step = 'commit';
        commitRun({ P, git, config, dataChanged: published.length > 0, today, summaries, sources: SOURCES, now: stamped, log });
      }
    }
  } catch (e) {
    rep.outcome = 'failed'; rep.failed_step = step; rep.error = scrub(e.message);
    logErr('FAILED: ' + rep.error);
    code = 1;
    if (flags.commit && !dry) { try { commitCounters({ P, git, usageFile, ledgerDir, log }); } catch (e2) { logErr('could not commit the spend counters: ' + scrub(e2.message)); } }
  } finally {
    fs.rmSync(lock, { force: true });
  }

  // ---- the run report (even when the run failed) ----
  try {
    const entries = readJson(path.join(S && code === 0 ? P.dataDir : (S ? S.v2 : P.dataDir), 'entries.json'), []);
    rep.names = Object.fromEntries(entries.filter((e) => rep.publish.runs.some((p) => [...p.entries_updated, ...p.entries_added].some((u) => u.entry_key === e.key)) || (rep.corrections && rep.corrections.corrected.some((x) => x.entry_key === e.key))).map((e) => [e.key, e.short_name]));
    const finished = now();
    finalize(rep, { now: finished, spend: summarize(factory.spend.between(startedAt, finished)), month: factory.monthStatus() });
    // Items a stop rule holds go at the top of the "on hold" list (and so into the Telegram message), every run until they pass.
    if (rep.stops && rep.stops.length) rep.held = [...rep.stops.map((h) => ({ item_id: h.item_id || h.entry_key || h.step, reason: `stopped at ${h.step} (${h.tries} tr${h.tries === 1 ? 'y' : 'ies'} since ${h.first_seen.slice(0, 10)}): ${h.reason}`, kind: 'stop', title: h.entry_key || null })), ...rep.held];
    const file = writeReport(rep, path.join(P.workDir, 'updates', rep.id));
    log(`run report: ${path.relative(P.root, file)}`);
  } catch (e) {
    logErr('could not write the run report: ' + scrub(e.message));
  }
  if (S) fs.rmSync(S.dir, { recursive: true, force: true });
  return { code, rep };
}

// ---------- command line ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), flag = (f) => args.includes(f), opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const dry = flag('--dry-run');
  loadEnv(pipelineDir);
  const config = readJson(path.join(pipelineDir, 'config', 'publish.json'));
  const models = readJson(path.join(pipelineDir, 'config', 'models.json'));
  const factory = createLlmFactory({ models, log: (m) => console.log('  ' + m) });
  const { code, rep } = await runUpdate({ config, models, factory, flags: { dry, source: opt('--source') || 'all', commit: flag('--commit'), noSearch: flag('--no-search'), noAi: flag('--no-ai') } });
  // ---- the message (even when the run failed) ----
  if (rep) {
    const scrub = scrubWith(process.env);
    try {
      const text = formatReport(rep);
      const wantsNotify = !flag('--no-notify') && (!dry || flag('--notify')) && config.notify && config.notify.telegram !== false;
      if (!wantsNotify) console.log(`\n--- message (not sent: ${flag('--no-notify') ? '--no-notify' : dry ? 'dry run; add --notify to send' : 'turned off in config/publish.json'}) ---\n${text}\n---`);
      else if (!tokenFromEnv() || !process.env.TELEGRAM_CHAT_ID) console.log(`\n--- message (not sent: no Telegram token or chat id configured) ---\n${text}\n---`);
      else {
        const tg = createTelegram(), pretty = formatHtml(rep);
        try { const n = await tg.send(pretty.text, { html: true, silent: pretty.silent }); console.log(`telegram: sent ${n} message${n === 1 ? '' : 's'}${pretty.silent ? ' (silent)' : ''}`); }
        catch (e) {
          // Telegram refused the formatted version (or the network dipped): the plain-text report always goes out, so no report is lost.
          console.error('telegram: formatted report not delivered (' + scrub(e.message) + '); trying plain text');
          try { const n = await tg.send(text); console.log(`telegram: sent ${n} plain message${n === 1 ? '' : 's'}`); }
          catch (e2) { console.error('telegram: could not send the report: ' + scrub(e2.message)); console.log(`\n--- message (not delivered) ---\n${text}\n---`); }
        }
      }
    } catch (e) {
      console.error('could not send the run report: ' + scrub(e.message));
    }
  }
  process.exit(code);
}
