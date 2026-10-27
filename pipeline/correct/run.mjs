// The self-correction step: no person reviews published entries, so the pipeline re-reads them against the official text and fixes
// its own (and the author's) mistakes. Run by update.mjs after publishing, at most once a day; or by hand:
//   node correct/run.mjs [--dry-run] [--only <key,key>] [--max <n>] [--force]
// --dry-run: read texts and ask the models, but write nothing (no data, no state). --force: run even if it already ran today.
// Reads every tracked bill's text (Congress.gov, LegiScan: free), picks the entries to re-check (select.mjs), reviews them (review.mjs:
// reader, code checks, confirmer), applies what was confirmed (apply.mjs) and writes the data only if the publisher's stop rules pass.
// What it checked and when is kept in state/corrections.json (committed, so a scheduled run on another machine carries on from it).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHttp } from '../grabber/lib/http.mjs';
import { createCongress } from '../grabber/sources/congress.mjs';
import { createLegiScan } from '../grabber/sources/legiscan.mjs';
import { readUsage, addUsage } from '../grabber/run-legiscan.mjs';
import { sha } from '../grabber/lib/run-common.mjs';
import { BudgetExceeded } from '../llm/gemini.mjs';
import { loadData, writeData } from '../publish/run.mjs';
import { checkPublish } from '../publish/guards.mjs';
import { createEntryTexts } from './texts.mjs';
import { pickEntries, nextState } from './select.mjs';
import { reviewEntry } from './review.mjs';
import { applyCorrections } from './apply.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), pipelineDir = path.resolve(here, '..');
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
export const STATE_FILE = path.join(pipelineDir, 'state', 'corrections.json');
const DATA_KEYS = ['entries', 'news', 'site', 'changes'];

// Entries never re-read: section J (excluded bills, kept only to say why) and search-qualified "none located" findings.
const eligible = (e) => e.section !== 'J' && !(e.confidence && e.confidence.basis === 'search_negative');

// The free-API clients and the LegiScan monthly counter. Returns { texts, used(), done() }.
function liveTexts({ ic, il, log }) {
  const ck = process.env.CONGRESS_API_KEY, lk = process.env.LEGISCAN_API_KEY;
  const lsCfg = readJson(path.join(pipelineDir, 'config', 'legiscan.json'), {});
  const usageFile = path.join(pipelineDir, 'data', 'legiscan-usage.json'), now = new Date();
  const lsLeft = lk ? Math.max(0, Math.min(150, (lsCfg.monthly_cap || 0) - readUsage(usageFile, now).used)) : 0;
  const cgHttp = createHttp({ headers: { 'X-Api-Key': ck }, secrets: [ck], maxRequests: ck ? 300 : 0, log });
  const lsHttp = createHttp({ secrets: [lk], maxRequests: lsLeft, log });
  return {
    texts: createEntryTexts({ cg: createCongress(cgHttp), ls: createLegiScan(lsHttp, lk), ic: ck ? ic : {}, il: lk ? il : {}, cacheDir: path.join(pipelineDir, 'data', 'text-cache') }),
    used: () => ({ congress_gov: cgHttp.used(), legiscan: lsHttp.used() }),
    done: () => { if (lsHttp.used()) addUsage(usageFile, now, lsHttp.used()); }
  };
}

// factory: llm/make.mjs. aiOff: why AI may not run (null when it may). texts: test hook ({ textFor, sourceOf }).
// Returns the report section: { ran, skipped_why, status, checked, corrected, rejected, missing_text, waiting, requests, problems, summary }.
export async function correctRun({ dataDir, docsDir = null, stateFile = STATE_FILE, config, factory, aiOff = null, dry = false, today, now = new Date(), runId, only = null, max = null, force = false, texts = null, ic = null, il = null, log = () => {} }) {
  const cfg = config.self_correction || { enabled: false };
  const rep = { ran: false, skipped_why: null, status: 'quiet', checked: [], corrected: [], rejected: [], missing_text: [], waiting: 0, requests: null, problems: [], summary: '' };
  const state = readJson(stateFile, { _note: 'Self-correction state (correct/run.mjs): the text each entry was last checked against and the outcome. Do not edit by hand.', last_run: null, items: {} });
  if (!cfg.enabled) return { ...rep, skipped_why: 'turned off in config/publish.json' };
  if (aiOff) return { ...rep, skipped_why: aiOff };
  if (cfg.once_per_day && state.last_run === today && !force && !only) return { ...rep, skipped_why: 'already ran today' };
  rep.ran = true;

  ic = ic || readJson(path.join(pipelineDir, 'config', 'identifiers.json'), {}).congress_gov || {};
  il = il || readJson(path.join(pipelineDir, 'config', 'identifiers-legiscan.json'), {}).legiscan || {};
  const live = texts ? null : liveTexts({ ic, il, log });
  const tx = texts || live.texts;
  const before = loadData(dataDir);
  const todo = before.entries.filter((e) => eligible(e) && tx.sourceOf(e.key) && (!only || only.includes(e.key)));

  // 1. read every text (free): the hash tells which entries' bills changed
  const candidates = [];
  try {
    for (const e of todo) {
      const t = await tx.textFor(e.key);
      if (t && t.text) candidates.push({ key: e.key, entry: e, sha: sha(t.text), text: t.text, url: t.url });
      else rep.missing_text.push({ entry_key: e.key, why: (t && t.why) || 'no text' });
    }
  } finally { if (live) { live.done(); rep.requests = live.used(); } }

  // 2. pick, 3. review
  const { picked, waiting } = pickEntries({ candidates, state: only ? {} : state.items, today, max: max || cfg.max_entries_per_run || 3, recheckDays: cfg.recheck_after_days || 30, maxRetries: cfg.max_retries || 3 });
  rep.waiting = waiting;
  const reviewer = factory.make('reviewer'), confirmer = factory.make('confirmer');
  if (!reviewer || !confirmer) return { ...rep, skipped_why: `${factory.keyName} is not set` };
  const results = [], newState = {};
  let serviceErrors = 0;
  for (const c of picked) {
    let r;
    try { r = await reviewEntry({ reviewer, confirmer, entry: c.entry, text: c.text, url: c.url, otherBills: otherBills(c.key, ic, il), log }); }
    catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e;
      if (e.scope !== 'item') { rep.problems.push(`stopped: ${e.message}`); break; }
      r = { outcome: 'error', corrections: [], rejected: [], reason: e.message }; // this entry used its own budget; retried later
    }
    results.push({ key: c.key, ...r });
    newState[c.key] = nextState(state.items[c.key], { sha: c.sha, url: c.url, today, outcome: r.outcome, reason: r.reason || (r.rejected[0] && r.rejected[0].why) });
    rep.checked.push({ entry_key: c.key, why: c.why, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) });
    r.rejected.forEach((x) => rep.rejected.push({ entry_key: c.key, ...x }));
    serviceErrors = r.service_error ? serviceErrors + 1 : 0;
    if (serviceErrors >= 2) { rep.problems.push('stopped: the model service failed twice in a row'); break; }
  }

  // 4. apply, then the publisher's stop rules; any problem means nothing is written and the entries are retried
  const identifiersFor = (key) => (il[key] && il[key].status !== 'rejected' ? { session: il[key].bills[0].session_name, external: { legiscan: il[key].bills.map((b) => b.bill_id) } } : null);
  const a = applyCorrections({ data: before, results, runId, runDate: today, now, identifiersFor });
  if (a.log.length) {
    const after = { ...a.data, relationships: before.relationships };
    const check = checkPublish({ before, after, runDate: today, maxEntries: config.max_entries_changed_per_run, corrected: a.corrected });
    if (check.problems.length) {
      rep.status = 'stopped'; rep.problems.push(...check.problems.slice(0, 10));
      for (const k of Object.keys(a.corrected)) newState[k] = { ...newState[k], outcome: 'error', retry: true, reason: 'stop rule: ' + check.problems[0].slice(0, 200) };
    } else {
      rep.status = dry ? 'dry-run' : 'written';
      for (const r of results) for (const c of r.corrections) rep.corrected.push({ entry_key: r.key, field: c.field, kind: c.kind, problem: c.problem, old: c.old, new: c.new, quote: c.evidence[0], source_url: c.url });
      if (!dry) { writeData(dataDir, after, DATA_KEYS); if (docsDir) writeData(docsDir, after, DATA_KEYS); }
    }
  }
  // A hand-picked run (--only) records what it checked but does not count as the day's run.
  if (!dry) {
    if (!only) state.last_run = today;
    Object.assign(state.items, newState);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const t = stateFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(state, null, 1) + '\n'); fs.renameSync(t, stateFile);
  }
  rep.summary = summaryOf(rep);
  return rep;
}

// The entry's other bills (the text read is the first one's), for the reader's note.
function otherBills(key, ic, il) {
  return [...((ic[key] && ic[key].congress_gov) || []).slice(1), ...((il[key] && il[key].bills) || []).slice(1).map((b) => `${b.state || ''} ${b.number || b.bill_id}`.trim())];
}

function summaryOf(rep) {
  const L = [`Self-correction: ${rep.checked.length} entr${rep.checked.length === 1 ? 'y' : 'ies'} re-checked, ${rep.corrected.length} field${rep.corrected.length === 1 ? '' : 's'} corrected`];
  for (const c of rep.corrected) L.push(`- ${c.entry_key} ${c.field} (${c.kind}): ${c.problem}`);
  return L.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { loadEnv } = await import('../grabber/lib/env.mjs');
  const { createLlmFactory } = await import('../llm/make.mjs');
  const { summarize } = await import('../llm/spend.mjs');
  loadEnv(pipelineDir);
  const args = process.argv.slice(2), flag = (f) => args.includes(f), opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const root = path.resolve(pipelineDir, '..'), config = readJson(path.join(pipelineDir, 'config', 'publish.json'));
  const models = readJson(path.join(pipelineDir, 'config', 'models.json'));
  const factory = createLlmFactory({ models, log: (m) => console.log('  ' + m) });
  const started = new Date(), today = started.toISOString().slice(0, 10);
  const aiOff = !factory.hasKey ? `${factory.keyName} is not set` : factory.monthStatus().over ? 'the monthly AI cost cap is reached' : null;
  const r = await correctRun({ dataDir: path.join(root, 'web', 'data', 'v2'), docsDir: config.copy_to_docs ? path.join(root, 'docs', 'data', 'v2') : null, config, factory, aiOff, dry: flag('--dry-run'), today, now: started,
    runId: 'correct-' + started.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-'), only: opt('--only') ? opt('--only').split(',') : null, max: opt('--max') ? Number(opt('--max')) : null, force: flag('--force'), log: (m) => console.log('  ' + m) });
  if (r.skipped_why) console.log(`skipped: ${r.skipped_why}`);
  r.checked.forEach((c) => console.log(`${c.outcome.padEnd(9)} ${c.entry_key} (${c.why})${c.reason ? ': ' + c.reason : ''}`));
  r.corrected.forEach((c) => console.log(`\nCORRECTED ${c.entry_key} ${c.field} (${c.kind}): ${c.problem}\n  old: ${c.old}\n  new: ${c.new}\n  quote: "${c.quote}"`));
  r.rejected.forEach((x) => console.log(`not applied: ${x.entry_key} ${x.field}: ${x.why}`));
  r.missing_text.forEach((m) => console.log(`no text: ${m.entry_key}: ${m.why}`));
  r.problems.forEach((p) => console.log(`problem: ${p}`));
  const s = summarize(factory.spend.between(started, new Date()));
  console.log(`\n${r.status}${flag('--dry-run') ? ' (dry run: nothing written)' : ''}; ${r.waiting} waiting; queries ${JSON.stringify(r.requests)}; AI ${s.calls} call(s), $${s.cost_usd}`);
}
