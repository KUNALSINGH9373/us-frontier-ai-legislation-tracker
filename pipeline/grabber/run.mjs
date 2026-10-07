// The Grabber. Plain code, no AI. Finds what changed in Congress.gov since the last successful run
// and writes a change set (plus the raw source text) for the Generator and Validator.
//
//   node grabber/run.mjs                      normal scheduled run (changes since the saved cursor)
//   node grabber/run.mjs --dry-run            do everything except save state
//   node grabber/run.mjs --bill 119/hr/9925   fetch one or more specific bills (repeatable); used for reconciliation
//   node grabber/run.mjs --since 2026-09-29T00:00:00Z --max-requests 300
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './lib/env.mjs';
import { createHttp, QuotaExceeded, HttpError, NetworkError } from './lib/http.mjs';
import { readState, writeState } from './lib/state.mjs';
import { createCongress, billId, billUrl, parseBillId } from './sources/congress.mjs';
import { makeScreen } from './screen.mjs';
import { runFederalRegister, FR_CUTOFF } from './run-federal-register.mjs';
import { sha, isoZ, makeRunId, saveRaw, writeChangeset } from './lib/run-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');
export const DATA_CUTOFF = '2026-09-29T00:00:00Z'; // the tracker's last verified date: nothing before this is re-examined
const hashOf = (b) => sha(JSON.stringify([b.updateDate, b.updateDateIncludingText, b.latestAction && b.latestAction.actionDate, b.latestAction && b.latestAction.text]));
const safeName = (id) => id.replace(/\//g, '-');
const MAX_TEXT = 1_500_000; // characters of bill text kept

// entries: v2 entries (to match bills we already track). scope: the screen config. now: Date.
export async function runCongress({ http, state, entries = [], scope, outDir, now = new Date(), since, bills = [], dryRun = false, log = () => {} }) {
  const congress = createCongress(http);
  const screen = makeScreen(scope);
  const runId = makeRunId(now);
  const block = structuredClone(state.sources.congress_gov || { last_success: DATA_CUTOFF, cursor: DATA_CUTOFF, hashes: {} }); // a copy: the saved state only changes when the whole run succeeds
  block.hashes = block.hashes || {};
  const from = since || block.cursor || DATA_CUTOFF;
  const to = isoZ(+now - 2 * 60 * 1000); // 2 min margin so a bill updated mid-run is never skipped
  const tracked = new Map(entries.flatMap((e) => ((e.identifiers && e.identifiers.external && e.identifiers.external.congress_gov) || []).map((id) => [id, e.key]))); // a bill id -> the entry that covers it

  const items = [], stats = { listed: 0, tracked_changed: 0, candidates: 0, screened_out: 0, unchanged: 0, over_candidate_cap: 0, errors: 0 };
  let lastProcessed = null, truncated = false, candidatesTaken = 0;

  async function collect(ref, reason, entryKey, listItem) {
    const id = billId(ref);
    const [detail, actions, summaries] = [await congress.getBill(ref), await congress.getActions(ref), await congress.getSummaries(ref)];
    // A new candidate needs the bill's own words so that what we write about it can be checked; a tracked bill's update only needs its actions.
    let text = null, textMissing = false;
    if (reason === 'discovery') {
      try { text = await congress.getText(ref); } catch (e) { if (!(e instanceof HttpError || e instanceof NetworkError)) throw e; textMissing = true; log(`no bill text for ${id}: ${String(e.message).slice(0, 80)}`); }
      if (text == null) textMissing = true;
    }
    const raw = JSON.stringify({ id, list_item: listItem || null, bill: detail, actions, summaries, ...(reason === 'discovery' ? { text: text ? text.slice(0, MAX_TEXT) : null, text_truncated: !!text && text.length > MAX_TEXT, text_missing: textMissing } : {}) }, null, 1);
    const saved = saveRaw({ outDir, runId, source: 'congress_gov', name: safeName(id) + '.json', text: raw });
    items.push({
      item_id: `congress_gov:${id}`, source: 'congress_gov', source_id: id, entry_key: entryKey || null,
      change: entryKey ? 'changed' : 'new', reason, source_url: billUrl(ref), fetched_at: isoZ(new Date()),
      raw_hash: saved.hash, raw_path: saved.rel, title: detail && detail.title
    });
    block.hashes[id] = hashOf(detail);
  }

  try {
    if (bills.length) {
      for (const id of bills) { const ref = parseBillId(id); if (!ref) throw new Error(`not a bill id: ${id}`); await collect(ref, 'reconcile', tracked.get(id)); }
    } else {
      for await (const b of congress.listUpdated({ from, to })) {
        stats.listed++;
        const ref = { congress: b.congress, type: String(b.type).toLowerCase(), number: b.number }, id = billId(ref);
        const newHash = hashOf(b);
        if (tracked.has(id)) {
          if (block.hashes[id] === newHash) { stats.unchanged++; }
          else { await collect(ref, 'updated_since_cursor', tracked.get(id), b); stats.tracked_changed++; }
        } else if (screen(b.title)) {
          if (block.hashes[id] === newHash) { stats.unchanged++; }
          else if (candidatesTaken >= scope.max_candidates_per_run) { stats.over_candidate_cap++; truncated = true; break; }
          else { await collect(ref, 'discovery', null, b); stats.candidates++; candidatesTaken++; }
        } else stats.screened_out++;
        lastProcessed = b.updateDate;
      }
    }
  } catch (e) {
    if (e instanceof QuotaExceeded) { truncated = true; log(`stopped early: ${e.message}`); }
    else { stats.errors++; throw Object.assign(e, { partial: { runId, items, stats } }); }
  }

  // The cursor moves forward only as far as we really got.
  const cursor = bills.length ? block.cursor : truncated && lastProcessed ? isoZ(lastProcessed) : to;
  const changeset = writeChangeset({ outDir, runId, items });

  const next = { ...state, sources: { ...state.sources, congress_gov: { ...block, last_success: isoZ(new Date()), cursor, quota: { period: 'run', used: http.used(), limit: http.maxRequests } } } };
  return { runId, changeset, stats, truncated, cursor, requests: http.used(), nextState: next, saved: !dryRun };
}

// ---------- command line ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
  const multi = (n) => args.flatMap((a, i) => (a === '--' + n ? [args[i + 1]] : []));
  const env = loadEnv(pipelineDir);
  const source = opt('source') || 'congress_gov';
  if (!['congress_gov', 'federal_register', 'all'].includes(source)) { console.error('--source must be congress_gov, federal_register or all'); process.exit(2); }
  const dryRun = args.includes('--dry-run');
  const stateFile = path.join(pipelineDir, 'data', 'state.json'), outDir = path.join(pipelineDir, 'data', 'runs');
  const entriesFile = path.join(pipelineDir, 'out', 'entries.v2.json');
  const entries = fs.existsSync(entriesFile) ? JSON.parse(fs.readFileSync(entriesFile, 'utf8')) : [];
  const scope = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'scope.draft.json'), 'utf8'));
  let state = readState(stateFile);
  const maxRequests = Number(opt('max-requests')) || 400;
  const report = (name, r) => console.log(`${name} run ${r.runId}: ${r.changeset.items.length} item(s) in the change set; ${JSON.stringify(r.stats)}; ${r.requests} request(s); ${r.truncated ? 'STOPPED EARLY (resumes next run); ' : ''}cursor ${r.cursor}${dryRun ? '; state NOT saved' : '; state saved'}`);
  try {
    if (source === 'congress_gov' || source === 'all') {
      const key = process.env.CONGRESS_API_KEY;
      if (!key) { console.error('CONGRESS_API_KEY is not set (looked for a .env file upward from pipeline/; found: ' + (env.path || 'none') + ')'); process.exit(2); }
      console.log(`congress.gov: ${multi('bill').length ? 'specific bills ' + multi('bill').join(', ') : 'changes since ' + (opt('since') || (state.sources.congress_gov && state.sources.congress_gov.cursor) || DATA_CUTOFF)}${dryRun ? ' (dry run)' : ''}`);
      const http = createHttp({ headers: { 'X-Api-Key': key }, secrets: [key], maxRequests, log: (m) => console.log('  ' + m) });
      const r = await runCongress({ http, state, entries, scope, outDir, since: opt('since'), bills: multi('bill'), dryRun, log: (m) => console.log('  ' + m) });
      report('congress.gov', r); if (!dryRun) { writeState(stateFile, r.nextState); state = r.nextState; }
    }
    if (source === 'federal_register' || source === 'all') {
      console.log(`federal register: ${multi('doc').length ? 'specific documents ' + multi('doc').join(', ') : 'documents since ' + (opt('since') || (state.sources.federal_register && state.sources.federal_register.cursor) || FR_CUTOFF)}${dryRun ? ' (dry run)' : ''}`);
      const http = createHttp({ maxRequests, log: (m) => console.log('  ' + m) });
      const r = await runFederalRegister({ http, state, entries, scope, outDir, since: opt('since'), docs: multi('doc'), dryRun, log: (m) => console.log('  ' + m) });
      report('federal register', r); if (!dryRun) writeState(stateFile, r.nextState);
    }
  } catch (e) {
    console.error('FAILED: ' + e.message + ' (state not saved, the next run starts from the same point)');
    process.exit(1);
  }
}
