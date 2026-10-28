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
// entries are left out and held in state/held-items.json (retried every run for a day, then daily, from a fresh copy, and reported every
// run; dropped with a report line after HELD_DAYS), and the rest is promoted. A stop on a per-run limit alone holds the entries over it
// (lowest ranked first out) and promotes the rest; they go out on later runs. A stop that names nothing it refused promotes nothing, as
// any other failure. Nothing held advances any state for it: entries put back take their links, news, court-docket, self-correction
// and news-seen state with them, and a held grabber item's hash and cursor are forgotten so it is fetched again.
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
import { runAgents, MEMO_FILE as AGENT_MEMO_FILE } from './agents/run.mjs';
import { correctRun, summaryOf as correctSummary } from './correct/run.mjs';
import { linkRun, summaryOf as linksSummaryOf } from './links/run.mjs';
import { courtsRun } from './publish/courts.mjs';
import { createRateLimiter } from './grabber/sources/courtlistener.mjs';
import { createHttp } from './grabber/lib/http.mjs';
import { newsRun, summaryOf as newsSummary } from './news/run.mjs';
import { makeValidator } from './schema/validate.mjs';
import { loadEnv } from './grabber/lib/env.mjs';
import { STATE_DIR, WORK_DIR, PROMOTED_STATE, LEGISCAN_USAGE_FILE, LEDGER_DIR, forgetItem } from './grabber/lib/state.mjs';
import { actionRank } from './publish/tier-a.mjs';
import { createStaging, plan, promote, rollback } from './lib/staging.mjs';
import { createLlmFactory } from './llm/make.mjs';
import { summarize } from './llm/spend.mjs';
import { newReport, sourceEntry, aiEntry, publishEntry, finalize, writeReport } from './report/build.mjs';
import { formatReport } from './report/format.mjs';
import { formatHtml } from './report/html.mjs';
import { createTelegram, tokenFromEnv } from './notify/telegram.mjs';
import { gatedPublishConfig, readGateInputs } from './eval/gate.mjs';
import { loadActorIds } from './links/records.mjs';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(pipelineDir, '..');
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
// The site data files a run may change. status.json is written every run but committed alone at most once a day.
export const DATA_FILES = ['entries', 'news', 'site', 'changes', 'relationships'];
export const ALL_SOURCES = ['congress_gov', 'federal_register', 'legiscan'];

// The raw records behind the entries a run touched: { entry_key: [{ item_id, source, raw }] }, read from each publish run's change set
// (an item published from a held replay carries no raw file and is left out). Unreadable records are skipped, never fatal.
export function runRecords(itemsByKey, keys) {
  const out = {};
  for (const key of keys) for (const x of itemsByKey[key] || []) {
    try {
      if (!x.runDir) continue;
      const cs = readJson(path.join(x.runDir, 'changeset.json'), { items: [] }), it = cs.items.find((i) => i.item_id === x.item_id);
      if (!it || !it.raw_path) continue;
      (out[key] = out[key] || []).push({ item_id: x.item_id, source: it.source, raw: JSON.parse(fs.readFileSync(path.join(x.runDir, it.raw_path), 'utf8')) });
    } catch { /* a missing or unreadable record only costs the links step that record */ }
  }
  return out;
}

// The gate (eval/gate.mjs gatedPublishConfig) over the publish config. With no model config the gate cannot be read: every switch is off.
export function applyGate(config, models, inputs = null) {
  if (!config || !config.auto_publish) return { config, gate: null, off: [] };
  if (!models || !(models.anthropic || models.roles)) {
    const out = JSON.parse(JSON.stringify(config)), off = Object.keys(out.auto_publish).filter((f) => out.auto_publish[f]).map((field) => ({ field, why: 'no model config, so the gate cannot be read' }));
    off.forEach((x) => (out.auto_publish[x.field] = false));
    return { config: out, gate: null, off };
  }
  // A bug in the gate (or its inputs) never crashes the run before the report: every switch is off this run, with why.
  try {
    return gatedPublishConfig({ config, models, ...(inputs || readGateInputs()) });
  } catch (err) {
    const out = JSON.parse(JSON.stringify(config)), why = `the gate could not be read (${String(err && err.message || err).slice(0, 200)}), so every switch is off`;
    const off = Object.keys(out.auto_publish).filter((f) => out.auto_publish[f]).map((field) => ({ field, why }));
    off.forEach((x) => (out.auto_publish[x.field] = false));
    return { config: out, gate: null, off };
  }
}

export const defaultPaths = () => ({
  pipelineDir, root, dataDir: path.join(root, 'web', 'data', 'v2'), docsDir: path.join(root, 'docs', 'data', 'v2'),
  idsFile: IDENTIFIERS_FILE, lsIdsFile: LEGISCAN_IDS_FILE, stateDir: STATE_DIR, workDir: WORK_DIR
});

// Items a stop rule refused (state/held-items.json, promoted with the run): { items: { "<step>:<item id or entry key>": { item_id?,
// entry_key?, step, reason, first_seen, last_tried, tries, replay? } } }. The run leaves them out and publishes the rest; a held item is
// tried again every run for its first day, then once a day, and leaves the list when it passes. A grabber item is retried from a fresh
// copy: when it is held, its hash (and cursor) in the staged grabber state is forgotten (grabber/lib/state.mjs forgetItem), so the next
// grab fetches it again. replay: the stored item (change-set item, diff, raw record, the AI result for a new entry); it is published
// alone only while it is less than a day old (REPLAY_FRESH), never as current facts days later. An item fetched again with nothing left
// to publish leaves the list; anything still held HELD_DAYS after it was first seen is dropped, with a line in the run report.
export const HELD_FILE = 'held-items.json';
export const HELD_DAYS = 14;
const REPLAY_FRESH = 86400e3;
export const heldDue = (h, now) => +now - Date.parse(h.first_seen) < 86400e3 || String(h.last_tried).slice(0, 10) < now.toISOString().slice(0, 10);
const heldId = (h) => `${h.step}:${h.item_id || h.entry_key || 'step'}`;
const safe = (id) => id.replace(/[^A-Za-z0-9._-]+/g, '-'); // the file name agents/run.mjs gives each result
// The places where publish/guards.mjs and schema/integrity.mjs put the entry key (or item id) a problem is about, after any "schema: " or
// "integrity: " prefix. Only these count: a key that appears elsewhere (inside quoted action text, a quote, a title) names nothing.
const POSITIONS = [
  /^(?:new )?entry (\S+?): /, // schema: entry KEY: ..., new entry KEY: ...
  /^deleted entry: (\S+)$/,
  /^duplicate entry key: (\S+)$/,
  /^(\S+?)(?: events\[\d+\])?: (?:not a real date|out of order|scheduled flag|last_changed is after|last_checked is after)/, // integrity, per entry
  /: no such entry (\S+)$/, // integrity: relationship node, news item, milestone, comparison matrix
  /^comparison row "[^"]*": (\S+) is not a column$/,
  /^stored source changed since it was fetched: (\S+)$/
];
// "... on KEY" closing the problem is the key of one that quotes text before it (existing event edited: <text> on KEY); a " on X:" inside
// that text is never read. Otherwise the key follows the first " on ", ended by ": " or " (" (deleted event on KEY: <text>, new event on
// KEY (<date> <text>) ...).
const namesIn = (problem, want) => {
  const p = String(problem).replace(/^(?:schema|integrity): /, ''), out = POSITIONS.map((re) => re.exec(p)).filter(Boolean).map((m) => m[1]);
  const end = / on (\S+)$/.exec(p), first = / on (\S+?)(?=: | \()/.exec(p);
  return [...out, ...(end && want.has(end[1]) ? [end[1]] : first ? [first[1]] : [])];
};
// Which of `names` (entry keys, item ids) each problem names, read only from those positions. A problem that names none is unexplained:
// the run then stops as before.
export function namedIn(problems, names) {
  const named = new Map(), unexplained = [], want = new Set(names);
  for (const p of problems) {
    const hit = [...new Set(namesIn(p, want).filter((k) => want.has(k)))];
    if (!hit.length) unexplained.push(p);
    hit.forEach((k) => { if (!named.has(k)) named.set(k, p); });
  }
  return { named, unexplained };
}
// A per-run limit (publish/guards.mjs checkPublish) names no entry: which entries wait is decided by overLimit below.
export const isLimit = (p) => /^\d+ (entries would change|new entries), over the limit of \d+ per run$/.test(String(p));
// The entries over a per-run limit: the changed (and the new) entries in a stable order, most important new event first (the action
// classifiers' scale: enacted 100 ... hearing 40, introduced 30, referred 20, procedural 0), then by key; the first maxEntries changed
// and maxNew new entries go out, the rest wait for a later run.
export function overLimit({ before, after, maxEntries, maxNew = 0 }) {
  const old = new Map(before.entries.map((e) => [e.key, e])), evKey = (v) => `${v.date}|${v.type}|${v.text}`;
  const rank = (o, e) => { const had = new Set(((o && o.events) || []).map(evKey)); return Math.max(0, ...(e.events || []).filter((v) => !had.has(evKey(v))).map((v) => actionRank(v.text, e.level === 'state' ? 'legiscan' : 'congress_gov'))); };
  const order = (list) => list.map((e) => ({ key: e.key, r: rank(old.get(e.key), e) })).sort((a, b) => b.r - a.r || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((x) => x.key);
  const changed = after.entries.filter((e) => old.has(e.key) && JSON.stringify(old.get(e.key)) !== JSON.stringify(e)), added = after.entries.filter((e) => !old.has(e.key));
  return [...order(changed).slice(maxEntries), ...order(added).slice(maxNew)];
}
// One item of a grabber run, kept so it can be published again later on its own.
function replayOf(runDir, id) {
  const cs = readJson(path.join(runDir, 'changeset.json'), { items: [] }), item = cs.items.find((i) => i.item_id === id);
  if (!item || !item.raw_path || !fs.existsSync(path.join(runDir, item.raw_path))) return null;
  const df = readJson(path.join(runDir, 'diff.json'), { items: [] }), res = readJson(path.join(runDir, 'results.json'));
  const r = res && res.items.find((i) => i.item_id === id), rf = path.join(runDir, 'results', safe(id) + '.json');
  return { run_id: cs.run_id, item, diff: df.items.find((d) => d.item_id === id) || null, raw: fs.readFileSync(path.join(runDir, item.raw_path), 'utf8'), result: r && fs.existsSync(rf) ? { summary: r, draft: readJson(rf) } : null };
}
// A step's summary without the entries a check put back: their lines ("- KEY ..." with the indented lines under it) go, the publish
// header counts what is left, and one line names what is held. Used for the commit message, which must not claim a reverted change.
export function trimSummary(text, gone) {
  const out = [];
  let skipping = false;
  for (const ln of String(text).split('\n')) {
    const m = /^- (?:NEW )?(\S+?)(?=[\s:]|$)/.exec(ln);
    if (m) skipping = gone.has(m[1]); else if (!/^ {2,}\S/.test(ln)) skipping = false;
    if (!skipping) out.push(ln);
  }
  const end = out.indexOf('', 2), block = out.slice(2, end < 0 ? out.length : end), n = block.filter((x) => /^- NEW /.test(x)).length, u = block.filter((x) => /^- /.test(x)).length - n;
  out[0] = out[0].replace(/: \d+ entr(?:y|ies) updated from official records(?:, \d+ new entr(?:y|ies) added)?/, `: ${u} entr${u === 1 ? 'y' : 'ies'} updated from official records${n ? `, ${n} new entr${n === 1 ? 'y' : 'ies'} added` : ''}`);
  while (out.length && out[out.length - 1] === '') out.pop();
  return [...out, '', `Held by a stop rule, not published this run: ${[...gone].join(', ')}`, ''].join('\n');
}
// A stored item is published alone only while it is fresh (fetched less than a day before this run).
const freshReplay = (r, now) => !!(r && r.item && Date.parse(r.item.fetched_at) > +now - REPLAY_FRESH);
// A one-item run folder from a stored item, dated today, under this run's id (the change log then points at a run that exists).
function writeReplay(dir, r, generatedAt, runId) {
  fs.rmSync(dir, { recursive: true, force: true });
  const w = (f, x) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), typeof x === 'string' ? x : JSON.stringify(x, null, 1)); };
  w('changeset.json', { run_id: runId, generated_at: generatedAt, items: [r.item] });
  w('diff.json', { items: r.diff ? [r.diff] : [] });
  w(r.item.raw_path, r.raw);
  if (r.result) { w('results.json', { items: [r.result.summary] }); w(path.join('results', safe(r.item.item_id) + '.json'), r.result.draft); }
  return dir;
}
// Puts entries back as they were at the start of the run (a new one is removed), with their news items and change-log records from this
// run, and the links this run added that touch them (an edge to or from one of their nodes; a node added for one of them, and a node
// added this run that no edge uses any more). Their state goes back too, so nothing is remembered as done for them: the court-docket
// state (the docket is read again), their self-correction record (state/corrections.json), and, when the news step drafted an item about
// one of them, the leads it marked drafted this run (state/news-seen.json; the release is drafted again). start(name): a state file's
// bytes at run start. Returns the relationship node keys of those entries (the links allowance leaves out every edge touching them).
function revertEntries({ S, before, keys, start, newsTrackers = new Set() }) {
  const cur = loadData(S.v2), set = new Set(keys), was = new Map(before.entries.map((e) => [e.key, e]));
  cur.entries = cur.entries.flatMap((e) => (!set.has(e.key) ? [e] : was.has(e.key) ? [JSON.parse(JSON.stringify(was.get(e.key)))] : []));
  const ut = cur.site.updates_through;
  cur.entries.filter((e) => set.has(e.key)).forEach((e) => e.events.forEach((v) => { if (v.scheduled !== undefined || v.date > ut) v.scheduled = v.date > ut; }));
  const oldNews = new Set(before.news.items.map((x) => JSON.stringify(x)));
  cur.news.items = cur.news.items.filter((x) => oldNews.has(JSON.stringify(x)) || !set.has(x.tracker));
  const n0 = (before.changes.items || []).length;
  cur.changes.items = [...cur.changes.items.slice(0, n0), ...cur.changes.items.slice(n0).filter((x) => !set.has(x.entry_key))];
  const rel = cur.relationships, e0 = before.relationships.edges.length, relWas = JSON.stringify(rel);
  const gone = new Set(Object.entries(rel.nodes).filter(([, n]) => n.kind === 'entry' && set.has(n.entry_key)).map(([k]) => k));
  rel.edges = [...rel.edges.slice(0, e0), ...rel.edges.slice(e0).filter((x) => !gone.has(x.from) && !gone.has(x.to))];
  const used = new Set(rel.edges.flatMap((x) => [x.from, x.to]));
  Object.keys(rel.nodes).filter((k) => !before.relationships.nodes[k] && (gone.has(k) || !used.has(k))).forEach((k) => delete rel.nodes[k]);
  writeData(S.v2, cur, ['entries', 'news', 'changes', ...(JSON.stringify(rel) !== relWas ? ['relationships'] : [])]);
  for (const f of Object.values(S.ids)) {
    const ids = readJson(f);
    if (!ids) continue;
    let hit = false;
    for (const list of Object.values(ids)) if (list && typeof list === 'object') for (const k of keys) if (!was.has(k) && list[k]) { delete list[k]; hit = true; }
    if (hit) fs.writeFileSync(f, JSON.stringify(ids, null, 1) + '\n');
  }
  const startJson = (name, d) => { const b = start(name); return b ? JSON.parse(b.toString('utf8')) : d; };
  const cf = S.stateFile('courts-state.json');
  if (fs.existsSync(cf)) {
    const st = readJson(cf), old = startJson('courts-state.json', { dockets: {} });
    for (const [id, d] of Object.entries(st.dockets || {})) if (set.has(d.entry_key)) { if (old.dockets && old.dockets[id]) st.dockets[id] = old.dockets[id]; else delete st.dockets[id]; }
    fs.writeFileSync(cf, JSON.stringify(st, null, 1) + '\n');
  }
  const kf = S.stateFile('corrections.json');
  if (fs.existsSync(kf)) {
    const st = readJson(kf), old = startJson('corrections.json', { items: {} });
    if (st.items && keys.some((k) => JSON.stringify(st.items[k]) !== JSON.stringify((old.items || {})[k]))) {
      for (const k of keys) { if (old.items && old.items[k] !== undefined) st.items[k] = old.items[k]; else delete st.items[k]; }
      fs.writeFileSync(kf, JSON.stringify(st, null, 1) + '\n');
    }
  }
  const nf = S.stateFile('news-seen.json');
  if (keys.some((k) => newsTrackers.has(k)) && fs.existsSync(nf)) {
    // the news report does not say which lead an item came from: every lead marked drafted this run goes back (a release drafted again
    // that was published is found as a duplicate)
    const st = readJson(nf), old = startJson('news-seen.json', { items: {} });
    for (const [k, v] of Object.entries(st.items || {})) if (v && v.outcome === 'drafted' && JSON.stringify(v) !== JSON.stringify((old.items || {})[k])) { if (old.items && old.items[k] !== undefined) st.items[k] = old.items[k]; else delete st.items[k]; }
    fs.writeFileSync(nf, JSON.stringify(st, null, 1) + '\n');
  }
  return gone;
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
export async function runUpdate({ P = defaultPaths(), config: publishConfig, models, factory, flags = {}, env = process.env, now = () => new Date(), deps = {}, log = (m) => console.log(m), logErr = (m) => console.error(m) } = {}) {
  const dry = !!flags.dry, source = flags.source || 'all';
  const SOURCES = source === 'all' ? ALL_SOURCES : [source];
  const startedAt = now();
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const rep = newReport({ id: 'update-' + stamp, now: startedAt, dry, sources: SOURCES });
  // ---- the accuracy gate, enforced: an auto_publish switch (new entries, relationships, news, the reading fields) is used only when the
  // latest full test-set report for the production model meets eval_bar (eval/gate.mjs); otherwise it is OFF for this run, and why is
  // written in the run report. config/publish.json itself is never changed.
  const { config, gate: gateNow, off: gatedOff } = applyGate(publishConfig, models, deps.gateInputs);
  rep.gate = { model: gateNow ? gateNow.model : null, report: gateNow ? gateNow.report : null, off: gatedOff };
  gatedOff.forEach((x) => rep.notes.push(`auto_publish.${x.field} is on in config/publish.json but treated as OFF this run: ${x.why}`));
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
    S = createStaging({ dir: path.join(P.workDir, 'staging', rep.id), dataDir: P.dataDir, docsDir: config.copy_to_docs ? P.docsDir : null, idsFiles: { ids: P.idsFile, lsIds: P.lsIdsFile }, stateDir: P.stateDir, stateFiles: [...PROMOTED_STATE, HELD_FILE, AGENT_MEMO_FILE], dataFiles: [...DATA_FILES, 'status'] });
    const before = loadData(S.v2); // the data as it was at the start: the final check compares the whole run with it
    // ---- held items: what a stop rule refused on earlier runs, and what it refuses now ----
    const held = readJson(S.stateFile(HELD_FILE), { items: {} }); held.items = held.items || {};
    const heldNow = [], tried = new Set(), isDue = (h) => heldDue(h, startedAt);
    // A held grabber item is fetched again by the next grab (its hash and cursor forgotten in the staged state, promoted with the run).
    // Before it is due, a held item is not fetched again every run (a new bill would be re-read by the AI step 6 times a day): its hash
    // and cursor are forgotten only by the last run before it is due (the next run, config.run_interval_hours later, finds it due).
    const dueNext = (h) => isDue(h) || heldDue(h, new Date(+startedAt + (config.run_interval_hours ?? 4) * 3600e3));
    const forget = (h) => { if (h.item_id) forgetItem(S.stateDir, { item_id: h.item_id, raw: h.replay ? h.replay.raw : null, change: h.replay && h.replay.item ? h.replay.item.change : null, title: h.replay && h.replay.item ? h.replay.item.title : null, today }); };
    // Expired items (held.expired: { "<item id>": { step, raw_hash, date } }): an item refused again with the same raw hash it expired
    // with is left out without being held, forgotten or reported again (reported once, at expiry); a changed record is a new item.
    held.expired = held.expired || {};
    const hold = (x, reason) => {
      const exp = x.item_id && held.expired[x.item_id], hash = x.replay && x.replay.item ? x.replay.item.raw_hash || null : null;
      if (exp && exp.raw_hash && hash === exp.raw_hash) return null;
      if (exp) delete held.expired[x.item_id];
      const same = Object.entries(held.items).filter(([, h]) => (x.item_id ? h.item_id === x.item_id : !h.item_id && h.entry_key === x.entry_key && h.step === x.step));
      const prev = same.map(([, h]) => h).sort((a, b) => a.first_seen.localeCompare(b.first_seen))[0];
      same.forEach(([id]) => delete held.items[id]);
      const replay = x.replay || (prev && prev.replay) || null;
      const h = { ...(x.item_id ? { item_id: x.item_id } : {}), ...(x.entry_key ? { entry_key: x.entry_key } : {}), step: x.step, reason: String(reason).slice(0, 300), first_seen: prev ? prev.first_seen : stamped, last_tried: stamped, tries: (prev ? prev.tries : 0) + 1, ...(replay ? { replay } : {}) };
      held.items[heldId(h)] = h; heldNow.push(h);
      forget(h);
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
    const partKeys = []; // per published step: the entries it changed (null: not tied to entries); a reverted entry is taken out of it
    const seenFresh = new Set();
    // One publish result into the report and the run's lists.
    const recordPublish = (r, label, newsBefore, src) => {
      const newsAfter = r.result && r.result.data ? (r.result.data.news.items || []).length : newsBefore;
      rep.publish.runs.push(publishEntry({ result: r.result, newsBefore, newsAfter, status: r.status }));
      if (r.status === 'published' || r.status === 'dry-run') { if (r.result.touched.length || r.result.added.length) { published.push(label); summaries.push(r.summary); partKeys.push([...r.result.touched, ...r.result.added.map((x) => x.entry_key)]); } }
      // only what was published (or would be, in a dry run) counts as new or as an item's entry
      const promoted = r.status === 'published' || r.status === 'dry-run';
      if (promoted && r.result && r.result.added) newKeys.push(...r.result.added.map((x) => x.entry_key));
      if (promoted && r.result) [...(r.result.applied || []), ...(r.result.added || [])].forEach((a) => (itemsByKey[a.entry_key] = itemsByKey[a.entry_key] || []).push({ item_id: a.item_id, ...src }));
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
        const s = await (deps.runAgents || runAgents)({ runDir, entries, config: models, factory, today, maxItems: ai.max_items_per_run || 10, memoFile: S.stateFile(AGENT_MEMO_FILE), newEntriesOn: !!(config.auto_publish && config.auto_publish.new_entries), log: (m) => log('  ' + m) });
        // newEntriesOn: the GATED switch. Off, no new entry can publish, so the escalated pass and the referee's scope/section confirmation
        // are skipped; a draft the readers pass is reported below as a proposal, "not confirmed: new entries are switched off".
        // Items held for good are reported once each, as proposals (production has no reviewer); they are not read again until their record changes.
        (s.proposals || []).forEach((p) => rep.notes.push(`proposal (held, not created): ${p}`));
        if (s.not_reread) rep.notes.push(`AI step: ${s.not_reread} held item(s) not read again (record unchanged)`);
        rep.ai.runs.push(aiEntry({ runDir, results: s }));
        if (s.stopped_by_month_cap) rep.notes.push('the monthly AI cost cap was reached during this run; the rest waits until next month');
      }

      step = 'publish';
      const newsBefore = (readJson(path.join(S.v2, 'news.json'), { items: [] }).items || []).length;
      // A held item that comes again with something to publish: the fresh copy replaces the stored one; before it is due it is left out.
      const runDiff = readJson(path.join(runDir, 'diff.json'), { items: [] }).items, runResults = readJson(path.join(runDir, 'results.json'), { items: [] }).items || [];
      const runItems = new Set([...runDiff.filter((d) => d.verdict === 'material').map((d) => d.item_id), ...runResults.filter((i) => i.outcome === 'publishable').map((i) => i.item_id)]);
      runItems.forEach((x) => seenFresh.add(x));
      // A held item fetched again with nothing left to publish (compare finds no material change, or the AI step read the new bill and
      // did not find it publishable) leaves the list. A new bill the AI step did not read this run waits on, and is fetched again.
      for (const [hid, h] of Object.entries(held.items).filter(([, x]) => x.item_id && !runItems.has(x.item_id) && !heldNow.includes(x))) {
        const d = runDiff.find((x) => x.item_id === h.item_id);
        if (!d) continue;
        seenFresh.add(h.item_id);
        if (d.verdict === 'new_entry_candidate' && !runResults.some((x) => x.item_id === h.item_id)) { h.replay = replayOf(runDir, h.item_id) || h.replay; if (dueNext(h)) forget(h); continue; }
        delete held.items[hid];
        rep.notes.push(`held item ${h.item_id} (${h.step}) was fetched again and has nothing left to publish (${d.verdict === 'new_entry_candidate' ? 'the AI step did not find it publishable' : 'no material change'}); no longer held`);
      }
      const waiting = Object.values(held.items).filter((h) => h.item_id && runItems.has(h.item_id));
      // not due yet: left out, its fresh copy stored, and fetched again by the grab of the run it is due in (forgotten the run before)
      waiting.filter((h) => !isDue(h)).forEach((h) => { const rp = replayOf(runDir, h.item_id); if (rp) h.replay = rp; if (dueNext(h)) forget(h); });
      const skip = waiting.filter((h) => !isDue(h)).map((h) => h.item_id);
      waiting.filter(isDue).forEach((h) => tried.add(heldId(h)));
      let r;
      // A stop names the entries (or items) it refused: those items are held and the rest of the run is published without them. A stop
      // on a per-run limit alone holds the items of the entries over it (overLimit); they go out on a later run.
      for (let round = 0; ; round++) {
        r = (deps.publishRun || publishRun)({ runDir, dataDir: S.v2, docsDir: null, dry, config, idsFile: S.ids.ids, lsIdsFile: S.ids.lsIds, skip: [...skip] });
        log(`publish ${id}: ${r.status}${skip.length ? ` (${skip.length} held item(s) left out)` : ''}`);
        if (r.status !== 'stopped') break;
        const diffItems = runDiff.filter((d) => !skip.includes(d.item_id) && d.verdict === 'material');
        const cands = [...diffItems.map((d) => ({ item_id: d.item_id, entry_key: d.entry_key })), ...((r.result && r.result.added) || []).map((a) => ({ item_id: a.item_id, entry_key: a.entry_key }))];
        const problems = (r.check && r.check.problems) || [], limits = problems.filter(isLimit);
        const { named, unexplained } = namedIn(problems.filter((p) => !isLimit(p)), [...new Set(cands.flatMap((c) => [c.item_id, c.entry_key]))]);
        let off = cands.filter((c) => named.has(c.item_id) || named.has(c.entry_key)), stepName = 'publish';
        if (!named.size && !unexplained.length && limits.length && r.result && r.result.data) {
          const over = new Set(overLimit({ before: loadData(S.v2), after: r.result.data, maxEntries: config.max_entries_changed_per_run, maxNew: config.max_new_entries_per_run ?? 0 }));
          off = cands.filter((c) => over.has(c.entry_key)); stepName = 'limit';
          off.forEach((c) => named.set(c.entry_key, limits[0]));
        }
        if (!named.size || unexplained.length || !off.length || round >= 5) { log(r.summary); throw new Error(`publish stopped for ${id}; nothing from this run was promoted`); }
        off.forEach((c) => { if (skip.includes(c.item_id)) return; hold({ ...c, step: stepName, replay: replayOf(runDir, c.item_id) }, named.get(c.item_id) || named.get(c.entry_key)); skip.push(c.item_id); });
      }
      recordPublish(r, id, newsBefore, { runDir });
    }

    // ---- 4'. held items due for another try that no grabber run brought again: each published alone from its stored copy while that
    // copy is less than a day old; an older one (or none) is not used: the item waits for the grab to fetch it again (forgotten when held)
    // held items not due this run but due on the next one, which no grab brought this run: forgotten now, so the next grab fetches them
    Object.values(held.items).filter((x) => x.item_id && !isDue(x) && dueNext(x) && !seenFresh.has(x.item_id) && !heldNow.includes(x)).forEach(forget);
    for (const [hid, h] of Object.entries(held.items).filter(([, x]) => x.item_id && isDue(x) && !seenFresh.has(x.item_id) && !heldNow.includes(x))) {
      if (!freshReplay(h.replay, startedAt)) { forget(h); continue; }
      step = 'publish (held items)';
      tried.add(hid);
      const newsBefore = (readJson(path.join(S.v2, 'news.json'), { items: [] }).items || []).length;
      let r;
      try { r = (deps.publishRun || publishRun)({ runDir: writeReplay(path.join(S.dir, 'held', safe(h.item_id)), h.replay, stamped, rep.id), dataDir: S.v2, docsDir: null, dry, config, idsFile: S.ids.ids, lsIdsFile: S.ids.lsIds }); }
      catch (e) { r = { status: 'stopped', check: { problems: [e.message] } }; }
      log(`publish held ${h.item_id}: ${r.status}`);
      if (r.status === 'stopped') { hold(h, ((r.check && r.check.problems) || [])[0] || 'stopped again'); continue; }
      if (r.status === 'quiet') rep.notes.push(`held item ${h.item_id} (${h.step}) retried: nothing left to publish${r.result && r.result.skipped && r.result.skipped.length ? ` (${r.result.skipped.map((s) => s.why).join('; ').slice(0, 200)})` : ''}; no longer held`);
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
          const problems = (k.check && k.check.problems) || [], limits = problems.filter(isLimit), caseKeys = Object.keys(cases).filter((x) => !x.startsWith('_'));
          const { named, unexplained } = namedIn(problems.filter((p) => !isLimit(p)), caseKeys);
          // a per-run limit alone: the cases over it wait (held like a refused case, read again on a later run)
          if (!named.size && !unexplained.length && limits.length && k.result && k.result.data) overLimit({ before: loadData(S.v2), after: k.result.data, maxEntries: config.max_entries_changed_per_run, maxNew: 0 }).filter((x) => caseKeys.includes(x)).forEach((x) => named.set(x, limits[0]));
          if (!named.size || unexplained.length || round >= 3) { log(k.summary); throw new Error('court-docket publish stopped; nothing from this run was promoted'); }
          named.forEach((reason, key) => { hold({ entry_key: key, step: 'court dockets' }, reason); skipKeys.push(key); });
        }
        heldCases.filter((h) => isDue(h) && (k.read || []).some((x) => x.entry_key === h.entry_key)).forEach((h) => tried.add(heldId(h)));
        k.errors.forEach((x) => rep.notes.push(`court docket not read: ${x}`));
        (k.read || []).forEach((x) => { checked[x.entry_key] = stamped; });
        const newsAfter = k.result.data ? (k.result.data.news.items || []).length : newsBefore;
        if (k.result.touched.length) { rep.publish.runs.push(publishEntry({ result: { ...k.result, added: [] }, newsBefore, newsAfter, status: k.status })); published.push('court dockets'); summaries.push(k.summary); partKeys.push([...k.result.touched]); }
      }
    }

    // ---- 4b. self-correction: once a day, re-read tracked bills and fix confirmed errors and omissions in the reading fields ----
    step = 'self-correction';
    const c = await (deps.correctRun || correctRun)({ dataDir: S.v2, docsDir: null, stateFile: S.stateFile('corrections.json'), config, factory, aiOff: capOff(), dry, today, now: startedAt, runId: rep.id, log: (m) => log('  ' + m) });
    rep.corrections = c;
    log(`self-correction: ${c.skipped_why ? 'skipped (' + c.skipped_why + ')' : `${c.checked.length} checked, ${c.corrected.length} field(s) corrected, ${c.status}`}`);
    if (c.status === 'written') { published.push('self-correction'); summaries.push(c.summary); partKeys.push((c.corrected || []).map((x) => x.entry_key)); }
    const corrected = {};
    if (c.status === 'written') (c.corrected || []).forEach((x) => { (corrected[x.entry_key] = corrected[x.entry_key] || []).includes(x.field) || corrected[x.entry_key].push(x.field); });

    // ---- 4c. links: propose links for the entries this run added or changed (code only); added only when auto_publish.relationships is on ----
    step = 'links';
    const touchedKeys = [...new Set([...rep.publish.runs.flatMap((p) => [...p.entries_updated, ...p.entries_added].map((u) => u.entry_key)), ...(c.corrected || []).map((x) => x.entry_key)])];
    // records: the official records this run read for those entries (sponsors by Congress.gov bioguideId / LegiScan people_id);
    // created: the entries Tier B created this run. Extra keys are harmless to a linkRun that does not read them yet.
    const records = runRecords(itemsByKey, touchedKeys), created = [...newKeys];
    const l = await (deps.linkRun || linkRun)({ dataDir: S.v2, docsDir: null, changed: touchedKeys, config, runDate: today, maxEntries: config.max_entries_changed_per_run, dry, records, created, log: (m) => log('  ' + m) });
    rep.links = l;
    log(`links: ${l.proposed.length} proposed, ${l.applied.length} added (${l.status})`);
    if (l.status === 'stopped') rep.notes.push('links were not added (a stop rule failed: ' + l.problems[0] + ')');
    if (l.status === 'written' && l.applied.length) { published.push('links'); summaries.push(l.summary); partKeys.push(null); }

    // ---- 4d. news: feed leads, and items written from official releases (added only when auto_publish.news is on) ----
    step = 'news';
    const nw = await (deps.newsRun || newsRun)({ dataDir: S.v2, docsDir: null, seenFile: S.stateFile('news-seen.json'), config, factory, aiOff: capOff(), dry, today, now: startedAt, runId: rep.id, log: (m) => log('  ' + m) });
    rep.news = nw;
    log(`news: ${nw.skipped_why ? 'skipped (' + nw.skipped_why + ')' : `${nw.leads.length} lead(s), ${nw.drafted.length} drafted, ${nw.status}`}`);
    if (nw.status === 'written') { published.push('news'); summaries.push(nw.summary); partKeys.push((nw.drafted || []).every((d) => d.tracker) ? nw.drafted.map((d) => d.tracker) : null); }

    // ---- 5. status.json: what readers see as "checked for updates ..." (only the entries really read this run). Written after the
    // final check, so it never shows a change (or a check of an entry) the final check put back.
    const writeStatus = () => {
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
    };
    if (dry) writeStatus();

    if (!dry) {
      // ---- 6. the final check: the whole run against the data at its start, with the union of what each step was allowed to change ----
      step = 'final check';
      // The links allowance is what the links step itself applied (its edges, in order, and only the nodes those edges need), never
      // whatever the data happens to hold: an edge another step appended is refused.
      const brief = (e) => [e.from, e.to, e.type, e.label].join('|');
      let linksOn = l.status === 'written' && l.applied.length > 0;
      // relationship nodes of entries put back: no edge this run added to or from them is allowed (revertEntries removed those edges)
      const goneNodes = new Set(), keep = (e) => !goneNodes.has(e.from) && !goneNodes.has(e.to);
      const linksAllowance = (after) => {
        if (!linksOn) return null;
        const tail = after.relationships.edges.slice(before.relationships.edges.length), applied = l.applied.filter(keep);
        const edges = l.added ? l.added.edges.filter(keep) : tail.length === applied.length && tail.every((e, i) => brief(e) === brief(applied[i])) ? tail : applied;
        const ends = new Set(edges.flatMap((e) => [e.from, e.to]));
        // records, created and actorIds: what the links step proved its record-proved sponsor edges against (guards.mjs checkLinks needs them)
        const proof = l.proof || { records, created, actorIds: loadActorIds() };
        return { records: proof.records, created: proof.created, actorIds: proof.actorIds, texts: proof.texts, edges, nodes: l.added ? Object.fromEntries(Object.entries(l.added.nodes).filter(([key]) => !goneNodes.has(key))) : Object.fromEntries(Object.entries(after.relationships.nodes).filter(([key]) => !before.relationships.nodes[key] && ends.has(key))) };
      };
      // Entries put back are taken out of everything that would still claim them: the commit message, the report, the status checks.
      const reverted = new Set();
      const dropKeys = (keys) => {
        keys.forEach((k) => { reverted.add(k); delete corrected[k]; delete checked[k]; const ni = newKeys.indexOf(k); if (ni >= 0) newKeys.splice(ni, 1); });
        rep.publish.runs.forEach((pr) => { pr.entries_updated = pr.entries_updated.filter((u) => !reverted.has(u.entry_key)); pr.entries_added = pr.entries_added.filter((u) => !reverted.has(u.entry_key)); });
        if (rep.corrections && rep.corrections.corrected) rep.corrections = { ...rep.corrections, corrected: rep.corrections.corrected.filter((x) => !reverted.has(x.entry_key)) };
        (nw.drafted || []).forEach((d) => { if (reverted.has(d.tracker)) d.written = false; });
        for (let i = published.length - 1; i >= 0; i--) {
          const pk = partKeys[i];
          if (published[i] === 'news' || published[i] === 'self-correction') continue; // rebuilt below from what is still promoted
          if (!pk || !pk.some((k) => reverted.has(k))) continue;
          if (pk.every((k) => reverted.has(k))) { published.splice(i, 1); summaries.splice(i, 1); partKeys.splice(i, 1); }
          else summaries[i] = trimSummary(summaries[i], new Set(pk.filter((k) => reverted.has(k))));
        }
        // news and self-correction: their summaries are rebuilt from the items still written / the corrections not put back
        const rebuild = (label, text) => { const i = published.indexOf(label); if (i < 0) return; if (text) summaries[i] = text; else { published.splice(i, 1); summaries.splice(i, 1); partKeys.splice(i, 1); } };
        if (c.status === 'written') { const left = rep.corrections.corrected; rebuild('self-correction', left.length ? correctSummary({ ...rep.corrections, corrected: left }) : null); }
        if (nw.status === 'written') rebuild('news', (nw.drafted || []).some((d) => d.written) ? newsSummary(nw) : null);
        if (linksOn && !linksAllowance(loadData(S.v2)).edges.length) {
          linksOn = false; rep.links = { ...l, status: 'held', applied: [] };
          const i = published.indexOf('links'); if (i >= 0) { published.splice(i, 1); summaries.splice(i, 1); partKeys.splice(i, 1); }
        } else if (linksOn) {
          // a partial revert: the report lists only the edges still promoted, and the links summary is rebuilt from them
          const still = l.applied.filter(keep);
          if (still.length !== l.applied.length) { rep.links = { ...rep.links, applied: still }; const i = published.indexOf('links'); if (i >= 0) summaries[i] = linksSummaryOf({ ...rep.links, applied: still }); }
        }
      };
      // Entries put back and held: each item that changed them is held (retried from a fresh copy), or the entry itself when no item did.
      const holdEntries = (named, stepName) => {
        revertEntries({ S, before, keys: [...named.keys()], start: (f) => S.start.get(path.join(P.stateDir, f)), newsTrackers: new Set((nw.drafted || []).filter((d) => d.written).map((d) => d.tracker)) }).forEach((k) => goneNodes.add(k));
        named.forEach((reason, key) => {
          const items = itemsByKey[key] || [];
          if (items.length) items.forEach((x) => hold({ item_id: x.item_id, entry_key: key, step: stepName, replay: x.replay || (x.runDir && replayOf(x.runDir, x.item_id)) }, reason));
          else hold({ entry_key: key, step: stepName }, reason);
        });
        dropKeys([...named.keys()]);
      };
      // A problem that names entries holds those entries (put back as they were; their items retried later); a problem in the link
      // network holds the links step (the network put back). A per-run limit alone holds the entries over it (overLimit). Anything
      // else is unexplained and nothing is promoted.
      for (let round = 0; ; round++) {
        const after = loadData(S.v2);
        const check = checkPublish({ before, after, runDate: today, maxEntries: config.max_entries_changed_per_run, maxNew: config.max_new_entries_per_run ?? 0, newKeys, corrected, links: linksAllowance(after) });
        if (!check.problems.length) break;
        const linkProblems = check.problems.filter((p) => /^(relationships changed|added link)/.test(p)), limits = check.problems.filter(isLimit);
        const keys = [...new Set([...before.entries, ...after.entries].map((e) => e.key))];
        const { named, unexplained } = namedIn(check.problems.filter((p) => !linkProblems.includes(p) && !isLimit(p)), keys);
        const over = !named.size && !linkProblems.length && limits.length ? overLimit({ before, after, maxEntries: config.max_entries_changed_per_run, maxNew: config.max_new_entries_per_run ?? 0 }) : [];
        if (unexplained.length || (!named.size && !linkProblems.length && !over.length) || round >= 4) { rep.final_check = check.problems.slice(0, 20); throw new Error(`the final check over the whole run failed (${check.problems.length} problem(s)): ${check.problems.slice(0, 3).join('; ')}`); }
        if (linkProblems.length) {
          writeData(S.v2, before, ['relationships']);
          hold({ step: 'links' }, linkProblems[0]);
          linksOn = false; rep.links = { ...l, status: 'held', applied: [] };
          const i = published.indexOf('links'); if (i >= 0) { published.splice(i, 1); summaries.splice(i, 1); partKeys.splice(i, 1); }
        }
        if (named.size) holdEntries(named, 'final check');
        else if (over.length) holdEntries(new Map(over.map((k) => [k, limits[0]])), 'limit');
      }
      writeStatus();
      // Held items tried again this run that no check refused leave the list; an entry or step held by the final check (or a limit)
      // leaves it once a run that was due to retry it passes.
      Object.entries(held.items).filter(([id, h]) => !heldNow.includes(h) && (tried.has(id) || (['final check', 'links', 'limit'].includes(h.step) && !h.item_id && isDue(h)))).forEach(([id]) => delete held.items[id]);
      // Nothing stays held for ever: an item still held HELD_DAYS after it was first seen is dropped, and the report says so.
      Object.entries(held.items).filter(([, h]) => +startedAt - Date.parse(h.first_seen) >= HELD_DAYS * 86400e3).forEach(([id, h]) => {
        delete held.items[id];
        const hash = h.replay && h.replay.item ? h.replay.item.raw_hash || null : null;
        if (h.item_id) held.expired[h.item_id] = { step: h.step, raw_hash: hash, date: today };
        const then = !h.item_id ? 'it is not retried again'
          : hash ? `while its source record stays unchanged (raw hash ${hash.slice(0, 12)}) it is left out of every run without being held or reported again; if the record changes it is treated as a new item`
          : 'no stored copy, so the next time it is fetched it is treated as a new item';
        rep.notes.push(`held item ${h.item_id || h.entry_key || h.step} (${h.step}) expired, needs attention: still not published ${HELD_DAYS} days after it was first held (${h.first_seen.slice(0, 10)}, ${h.tries} tr${h.tries === 1 ? 'y' : 'ies'}); dropped from the held list in state/held-items.json${h.item_id ? ' and recorded there as expired' : ''}; ${then}. Last reason: ${h.reason}`);
      });
      // expiry markers are kept a year, then forgotten
      Object.entries(held.expired).filter(([, m]) => +startedAt - Date.parse(m.date) >= 365 * 86400e3).forEach(([id]) => delete held.expired[id]);
      if (!Object.keys(held.expired).length) delete held.expired;
      if (Object.keys(held.items).length || held.expired || fs.existsSync(S.stateFile(HELD_FILE))) fs.writeFileSync(S.stateFile(HELD_FILE), JSON.stringify(held, null, 1) + '\n');
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
