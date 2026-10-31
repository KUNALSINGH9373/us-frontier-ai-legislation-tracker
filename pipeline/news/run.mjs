// The news step: events from official records, and leads from feeds. Run by update.mjs after self-correction; or by hand:
//   node news/run.mjs [--dry-run]            (by hand there are no grabber records: only leads, and the events already stored)
// 1. events (news/events.mjs): the official records this run already fetched (Congress.gov and LegiScan bill records from the grabber's
//    run folders, CourtListener docket entries from the court step) become RawItems (news/sources/*.mjs), classified by code
//    (news/classify.mjs), upserted into state/news-events.json and confirmed or withdrawn by news/confirm.mjs. No new API calls.
// 2. leads (news/leads.mjs): feeds in config/news-sources.json, last N days, not already on the page or seen before, AI headline screen.
//    A primary (official) lead may only attach to an existing event as a statement (news/attach.mjs: verbatim headline + link); press
//    leads and unattached ones are listed in the Telegram report as "News leads". Nothing is ever written from a release page.
// 3. config/publish.json auto_publish.news: off -> events are computed, stored and reported, nothing is written to news.json; on -> the
//    showable events are rendered into news.json (news/events.mjs renderNews) and must pass checkNewsEvents and checkPublish.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHttp, HttpError } from '../grabber/lib/http.mjs';
import { NEWS_SEEN_FILE, STATE_DIR } from '../grabber/lib/state.mjs';
import { loadData, writeData } from '../publish/run.mjs';
import { checkPublish } from '../publish/guards.mjs';
import { findLeads } from './leads.mjs';
import { robotsAllows } from './feeds.mjs';
import { loadEvents, saveEvents, upsertItems, renderNews, checkNewsEvents, markShown, visible, refreshCards } from './events.mjs';
import { attachStatements, allowHostsFrom, canonicalUrl } from './attach.mjs';
import { makeStatementVerifier, checkAttachments } from './statement-check.mjs';
import { updateHealth, alerts, loadHealth, saveHealth } from './health.mjs';
import * as congressGov from './sources/congress_gov.mjs';
import * as legiscan from './sources/legiscan.mjs';
import * as courtlistener from './sources/courtlistener.mjs';
import * as openstates from './sources/openstates.mjs';
import * as nysenate from './sources/nysenate.mjs';
import * as govinfo from './sources/govinfo.mjs';
import * as federalRegister from './sources/federal_register.mjs';
import * as whitehouse from './sources/whitehouse.mjs';
import * as regulationsGov from './sources/regulations_gov.mjs';
import * as congressExtra from './sources/congress_extra.mjs';
import * as nist from './sources/nist.mjs';
import * as cbo from './sources/cbo.mjs';
import * as caAg from './sources/ca_ag.mjs';
import { defaultHttp, sourceConfig, structuredSources, NEWS_FETCH_TIMEOUT_MS, NEWS_TIMING, redact } from './sources/common.mjs';
import { writeCard, bankCard, aiWriterOn } from './writer.mjs';
import { daysBefore } from './text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), pipelineDir = path.resolve(here, '..');
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
export const SEEN_FILE = NEWS_SEEN_FILE;
export const EVENTS_FILE = path.join(STATE_DIR, 'news-events.json');
export const HEALTH_FILE = path.join(STATE_DIR, 'news-health.json');
export const SOURCES_FILE = path.join(pipelineDir, 'config', 'news-sources.json');
const KEEP_DAYS = NEWS_TIMING.keep_days, EVENT_DAYS = NEWS_TIMING.event_days;
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } };

// Reading feeds the polite way: our own honest name, robots.txt obeyed, a site that refuses us is not read.
// Returns { get(url) -> text, used(), allowed(url) }. fetchImpl is a test hook.
export function createReader({ userAgent, fetchImpl, log = () => {}, maxRequests = 80 }) {
  const http = createHttp({ userAgent, maxRequests, retries: 1, timeoutMs: NEWS_FETCH_TIMEOUT_MS, log, ...(fetchImpl ? { fetchImpl } : {}) });
  const robots = new Map();
  async function allowed(url) {
    const u = new URL(url);
    if (!robots.has(u.origin)) {
      let rule;
      try { rule = await http.getText(u.origin + '/robots.txt', { headers: { Accept: 'text/plain, */*;q=0.5' } }); }
      catch (e) { rule = e instanceof HttpError && [404, 410].includes(e.status) ? '' : null; } // no robots.txt: allowed; refused or unreachable: not read
      robots.set(u.origin, rule);
    }
    const r = robots.get(u.origin);
    return r !== null && robotsAllows(r, u.pathname + u.search);
  }
  return {
    allowed,
    used: () => http.used(),
    async get(url, accept) {
      if (!(await allowed(url))) throw new Error(`${host(url)} does not allow automated reading of this page (robots.txt), or refused robots.txt`);
      return http.getText(url, { headers: { Accept: accept } });
    }
  };
}

// The official records the grabber stored this run: every change-set item on a tracked entry (entry_key set by the grabber's code
// match) with its raw record. runDirs: the grabber's run folders. Unreadable records are skipped, never fatal.
export function recordsFromRuns(runDirs = []) {
  const out = [];
  for (const runDir of runDirs) {
    const cs = readJson(path.join(runDir, 'changeset.json'), { items: [] });
    for (const it of cs.items || []) {
      if (!it.raw_path || !['congress_gov', 'legiscan'].includes(it.source)) continue;
      try { out.push({ source: it.source, source_id: it.source_id, entry_key: it.entry_key || null, source_url: it.source_url, fetched_at: it.fetched_at, raw: JSON.parse(fs.readFileSync(path.join(runDir, it.raw_path), 'utf8')) }); }
      catch { /* a missing record costs only its events this run */ }
    }
  }
  return out;
}

// The event lane alone (no feeds, no AI): adapters -> upsert -> confirm. Exported for the eval (eval/news-set.mjs) and tests.
// Lane 1 safety (review F2): the network adapters share one time budget (budgetMs, default 6 min, config news.time_budget_ms). Each runs
// with a deadline: past it, its transport refuses further calls and its pacing sleeps end at once, and the step moves on with what it has
// (health 'truncated'); the remaining adapters are not run. An adapter whose transport fails 3 times in a row is stopped. A source read
// within its cadence_hours (config/news-sources.json "structured"; lastFetch from news-health.json) is not read again this run.
// Never throws. clock: ms now (tests).
// The limits: config/news-sources.json "timing".
export const NEWS_BUDGET_MS = NEWS_TIMING.budget_ms;
export const LEADS_BUDGET_MS = NEWS_TIMING.leads_budget_ms; // the feeds' share of the total, at most
const LEADS_MAX_PART = NEWS_TIMING.leads_max_part; // and never more than this part of the total
const CADENCE_SLACK_MS = NEWS_TIMING.cadence_slack_ms; // a 24 h source read at 06:00 is due again at the 06:00 run the next day
function guardedHttp(http, { deadline, clock, onStop }) {
  let consecutive = 0, stopped = null;
  const stop = (why) => { if (!stopped) { stopped = why; onStop(why); } };
  const check = () => { if (!stopped && clock() >= deadline) stop('time budget reached'); if (stopped) throw new Error(`news step: ${stopped}; not read this run`); };
  const fail = () => { if (++consecutive >= 3) stop('3 consecutive errors'); };
  const wrap = (fn) => async (...a) => {
    check();
    try { const r = await fn(...a); if (r && typeof r.status === 'number' && (r.status >= 400 || r.status === 0)) fail(); else consecutive = 0; return r; }
    catch (e) { fail(); throw e; }
  };
  const g = typeof http === 'function' ? wrap(http) : http;
  if (http && typeof http === 'object') for (const k of Object.keys(http)) if (typeof http[k] === 'function') g[k] = wrap(http[k].bind(http));
  return { http: g, stopped: () => stopped, sleep: (ms) => new Promise((r) => setTimeout(r, stopped ? 0 : Math.max(0, Math.min(ms, deadline - clock())))) };
}

export async function eventsStep({ state, records = [], courtFound = [], now = new Date(), runId = null, sinceDays = EVENT_DAYS, today = now.toISOString().slice(0, 10), extra = [], http = null, env = {}, entries = [], items: given = [], budgetMs = NEWS_BUDGET_MS, lastFetch = {}, cadenceOf = (n) => sourceConfig(n).cadence_hours ?? null, shareOf = (n) => (sourceConfig(n).run || {}).budget_share ?? 1, clock = () => Date.now() }) {
  const results = {}, itemsBy = {}, fetched = [], all = [], statements = [];
  const since = daysBefore(today, sinceDays);
  state.adapters = state.adapters || {};
  const runs = [['congress_gov', congressGov, { records }], ['legiscan', legiscan, { records }], ['courtlistener', courtlistener, { found: courtFound, now }],
    ...extra.map(([name, mod]) => [name, mod, { http, env, since, state: state.adapters[name] || {}, entries, now }])];
  // local: the sources read from the records the run already has (config run.records), not over the network
  const deadline = clock() + budgetMs, local = new Set(structuredSources().filter(([, c]) => c.run && c.run.records).map(([n]) => n));
  let outOfTime = false;
  for (const [name, mod, args] of runs) {
    let r;
    if (!local.has(name)) {
      const cad = cadenceOf(name), last = lastFetch[name] ? Date.parse(lastFetch[name]) : NaN;
      // a source that stopped partway through its list (a cursor past the start) carries on next run, whatever its cadence
      const unfinished = !!(state.adapters[name] && state.adapters[name].cursor);
      if (cad && !unfinished && Number.isFinite(last) && now.getTime() - last < cad * 3600e3 - CADENCE_SLACK_MS) { results[name] = { ok: true, skipped: 'cadence', count: 0, newest: null, errors: [] }; itemsBy[name] = []; continue; }
      if (outOfTime || clock() >= deadline) { outOfTime = true; results[name] = { ok: true, truncated: true, count: 0, newest: null, errors: ['time budget reached; not read this run'] }; itemsBy[name] = []; continue; }
      let why = null;
      // the adapter's own share of the budget (config run.budget_share), never past the shared deadline
      const mine = Math.min(deadline, clock() + shareOf(name) * budgetMs);
      const g = guardedHttp(args.http, { deadline: mine, clock, onStop: (w) => { why = w; } });
      let timer;
      const timeout = new Promise((res) => { timer = setTimeout(() => res({ timedOut: true }), Math.max(0, mine - clock())); });
      try {
        r = await Promise.race([mod.fetchItems({ ...args, http: g.http, sleep: g.sleep, deadline: mine - NEWS_FETCH_TIMEOUT_MS, clock }), timeout]);
      } catch (e) { r = { items: [], health: { ok: false, count: 0, newest: null, errors: [redact(String(e.message || e))] }, fetched: [] }; }
      finally { clearTimeout(timer); }
      if (r && r.timedOut) { why = why || 'time budget reached'; r = { items: [], health: { ok: true, count: 0, newest: null, errors: [] }, fetched: [] }; }
      if (why) {
        r.health = { ...(r.health || {}), truncated: true, ok: why !== '3 consecutive errors' && (r.health ? r.health.ok !== false || (r.health.errors || []).every((x) => /not read this run|request cap/.test(x)) : true), errors: [...((r.health && r.health.errors) || []).filter((x) => !/not read this run/.test(x)).slice(0, 5), `stopped: ${why}`] };
        if (why === 'time budget reached' && clock() >= deadline) outOfTime = true; // its own share used up: the next source still runs
      }
    } else {
      try { r = await mod.fetchItems(args); } catch (e) { r = { items: [], health: { ok: false, count: 0, newest: null, errors: [String(e.message || e)] }, fetched: [] }; }
    }
    if (r.state) state.adapters[name] = r.state;
    const items = r.items || [];
    results[name] = r.health; itemsBy[name] = items; fetched.push(...(r.fetched || []));
    for (const it of items) (it && it.facts && it.facts.role === 'statement' ? statements : all).push(it);
  }
  // items handed in directly (the eval's recorded records of other sources)
  for (const it of given) (it && it.facts && it.facts.role === 'statement' ? statements : all).push(it);
  const okSources = Object.entries(results).filter(([, h]) => h && h.ok).map(([n]) => n);
  const up = upsertItems(state, all, { runId, now, since, fetched, okSources });
  if (entries.length) refreshCards(state, entries);
  return { up, results, itemsBy, items: all, statements };
}

// The structured official sources other than the records the run already has (network; each needs its own key where noted). Run only
// when the caller passes env (update.mjs does; tests and hand runs without env read none).
// Order and share of the time budget: config/news-sources.json run.order and run.budget_share. The quick sources first, each with a
// quarter of the budget at most; NY Senate (half) and Open States (paced to Plural's free-tier rate, several minutes; what is left) last, so a
// slow source can never starve the others (local live run, 30 Oct 2026: Open States used it all and nothing after it was read).
const ADAPTER_MODULES = { federal_register: federalRegister, whitehouse, govinfo, regulations_gov: regulationsGov, congress_extra: congressExtra, nist, cbo, ca_ag: caAg, nysenate, openstates };
const orderOf = (n) => (sourceConfig(n).run || {}).order ?? Infinity;
export const EXTRA_ADAPTERS = Object.entries(ADAPTER_MODULES).sort((a, b) => orderOf(a[0]) - orderOf(b[0]));

// The card writer (news/writer.mjs, roles generator + validator) for showable events whose card is still the template; a card that fails
// any check stays the template. Only when news publishing is on and AI may run. Returns how many cards the AI wrote.
export async function writeCards({ state, entries, keys, factory, today, max = 5, config = null, log = () => {} }) {
  // news.ai_writer false (default): the phrase bank (news/phrasebank.mjs), code only, every card; the AI path below is not reached
  if (!aiWriterOn(config)) {
    const byKey = new Map(entries.map((e) => [e.key, e]));
    let written = 0, tried = 0;
    for (const k of keys) {
      const ev = state.events[k];
      if (!ev || !ev.card || (ev.card.written_by === 'bank' && ev.card.facts_hash === ev.facts_digest)) continue;
      if (tried >= max) break; // max_cards_per_run applies to the bank too (review r4)
      tried++;
      const r = bankCard({ event: ev, entry: byKey.get(ev.entry_id) || null, today });
      if (r.card && r.card.written_by === 'bank') { ev.card = { ...r.card, facts_hash: ev.facts_digest }; written++; }
    }
    return { written, tried, mode: 'bank' };
  }
  let writer = null, reader = null;
  try { writer = factory.make('generator'); reader = factory.make('validator'); } catch { return { written: 0, tried: 0 }; }
  if (!writer || !reader) return { written: 0, tried: 0 };
  const byKey = new Map(entries.map((e) => [e.key, e]));
  let written = 0, tried = 0;
  for (const k of keys) {
    const ev = state.events[k];
    if (!ev || !ev.card || ev.card.written_by === 'ai' || tried >= max) continue;
    tried++;
    const r = await writeCard({ config, event: ev, entry: byKey.get(ev.entry_id) || null, writer, reader, today, log });
    if (r.card && r.card.written_by === 'ai') { ev.card = { ...r.card, facts_hash: ev.facts_digest }; written++; }
  }
  return { written, tried };
}

// config: config/publish.json. sources: config/news-sources.json. factory: llm/make.mjs (the headline screener only). aiOff: why AI may
// not run (null when it may). runDirs: the grabber's run folders this run; courtFound: courtsRun's "found". reader: test hook.
// Returns the report section (see report/build.mjs).
// The news step never throws (review r2 #6): any error is a stopped news report, so it can never fail the rest of the run.
export async function newsRun(opts) {
  try { return await newsRunInner(opts); }
  catch (e) {
    const config = (opts && opts.config) || {};
    const rep = { ran: true, skipped_why: null, status: 'stopped', publishing: !!(config.auto_publish && config.auto_publish.news), feeds_checked: 0, feeds_failed: [], leads: [], drafted: [], screened_out: 0, duplicates: 0, waiting: 0, waiting_record: [], requests: 0,
      problems: [`the news step failed and wrote nothing: ${String((e && e.message) || e).slice(0, 300)}`], summary: '', events: { added: [], confirmed: [], corrected: [], withdrawn: [], refused: [], pending: 0, showable: 0, statements: 0, held: [], report: [], alerts: [] } };
    rep.summary = summaryOf(rep);
    return rep;
  }
}

async function newsRunInner({ dataDir, docsDir = null, seenFile = SEEN_FILE, eventsFile = EVENTS_FILE, healthFile = HEALTH_FILE, config, sources = readJson(SOURCES_FILE, { sources: [] }), factory, aiOff = null, dry = false, today, now = new Date(), runId, reader = null, runDirs = [], records = null, courtFound = [], env = null, http = null, adapters = EXTRA_ADAPTERS, log = () => {}, clock = () => Date.now() }) {
  const cfg = config.news_leads || { enabled: false };
  const rep = { ran: true, skipped_why: null, status: 'quiet', publishing: !!(config.auto_publish && config.auto_publish.news), feeds_checked: 0, feeds_failed: [], leads: [], drafted: [], screened_out: 0, duplicates: 0, waiting: 0, waiting_record: [], requests: 0, problems: [], summary: '',
    events: { added: [], confirmed: [], corrected: [], withdrawn: [], refused: [], pending: 0, showable: 0, statements: 0, held: [], report: [], alerts: [] } };
  const before = loadData(dataDir);
  const state = loadEvents(eventsFile, { now });
  if (state.quarantined) rep.problems.push(`news events file unreadable (${state.quarantine_why}); moved to ${path.basename(state.quarantined)} and started empty`);
  if (state.dropped_malformed) rep.problems.push(`${state.dropped_malformed} malformed stored event(s) dropped`);

  // 1. events from the official records this run already has
  const recs = records || recordsFromRuns(runDirs);
  // one time budget for the whole news step (review F2, r7 L1): the structured adapters get the total less the leads' share; the leads
  // (feeds) get what is left, at most LEADS_BUDGET_MS, under the same deadline
  const totalMs = (config.news && config.news.time_budget_ms) || NEWS_BUDGET_MS, stepStart = clock(), stepDeadline = stepStart + totalMs;
  const prevHealth = loadHealth(healthFile), lastFetch = Object.fromEntries(Object.entries(prevHealth.sources || {}).map(([n, s]) => [n, s.last_fetch || null]));
  const ev = await eventsStep({ state, records: recs, courtFound, now, runId, today, entries: before.entries, env: env || {}, extra: env ? adapters : [], http: env ? (http || defaultHttp({ timeoutMs: NEWS_FETCH_TIMEOUT_MS })) : null, lastFetch, budgetMs: Math.max(0, totalMs - Math.min(LEADS_BUDGET_MS, Math.floor(totalMs / LEADS_MAX_PART))), clock });
  Object.assign(rep.events, { added: ev.up.added, confirmed: ev.up.confirmed, corrected: ev.up.corrected, withdrawn: ev.up.withdrawn, refused: ev.up.refused.slice(0, 20), report: ev.up.report.slice(0, 50) });
  const health = updateHealth(prevHealth, ev.results, { now, items: ev.itemsBy });
  rep.events.alerts = alerts(health, { now, config: { congress_gov: { cadence_hours: 24 * 30 }, legiscan: { cadence_hours: 24 * 30 }, courtlistener: { cadence_hours: 24 * 30 } } }).filter((a) => !/stale|zero items/.test(a)); // these sources are read only when they changed

  // statements from the structured statement sources (NIST, CBO, CA AG feeds): attach to an event or stay a lead
  // A statement attaches only when code proposes it AND the AI check agrees (news/statement-check.mjs). The AI runs only while news
  // publishing is on; without it nothing attaches (every statement stays a lead).
  let verifier = null;
  if (!aiOff && factory && rep.publishing) { try { verifier = makeStatementVerifier(factory.make('validator'), { log }); } catch { verifier = null; } }
  if (ev.statements.length) {
    const att = await checkAttachments(attachStatements(Object.values(state.events), ev.statements, { allowHosts: [...new Set(ev.statements.flatMap((s) => sourceConfig(s.source).hosts || []))] }), state.events, verifier, (state.statement_checks ||= {})); // hosts from config, never from the statements
    for (const e of att.events) { const old = state.events[e.key]; if (e.sources.length !== old.sources.length) rep.events.statements += e.sources.length - old.sources.length; state.events[e.key] = e; }
    // dropped (host not allowlisted, empty title) are reported too, not lost; duplicates were reported when first seen (review r8 #8a)
    for (const d of att.dropped.filter((x) => x.why !== 'duplicate' && x.item)) rep.leads.push({ title: d.item.title || '(no title)', publisher: (d.item.facts && d.item.facts.publisher) || d.item.source, link: d.item.url, date: d.item.date, primary: false, tracker: d.item.entry_id || null, note: `statement not used: ${d.why}` });
    // a statement the AI refused on an earlier run was reported then: not again every run (review r9 #7)
    const refusedBefore = (u) => Object.entries(state.statement_checks || {}).some(([k, v]) => k.startsWith(`${u}|`) && !v.ok && v.at < today);
    for (const l of [...att.leads, ...att.timeline.map((t) => t.item)].filter((x) => !refusedBefore(x.url))) rep.leads.push({ title: l.title, publisher: (l.facts && l.facts.publisher) || l.source, link: l.url, date: l.date, primary: true, tracker: l.entry_id || null, note: 'official statement: no official event it could attach to' });
  }

  // 2. leads; a primary lead may attach to an event as a statement
  let mark = {};
  const seen = readJson(seenFile, { _note: 'News leads already seen (news/run.mjs), by link. Do not edit by hand.', items: {} });
  if (cfg.enabled) {
    const rd = reader || createReader({ userAgent: sources.user_agent, log });
    // the AI headline screener runs only while news publishing is on (review r7 L1): leads are pointers, nothing is shown from them
    const screener = aiOff || !factory || !rep.publishing ? null : factory.make('screener');
    const leadsDeadline = Math.min(stepDeadline, clock() + LEADS_BUDGET_MS);
    const fetchFeed = (u, accept) => { if (clock() >= leadsDeadline) return Promise.reject(new Error('news step: time budget reached; not read this run')); return rd.get(u, accept || 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8'); };
    let lt;
    const late = new Promise((res) => { lt = setTimeout(() => res(null), Math.max(0, leadsDeadline - clock())); });
    let found;
    try { found = await Promise.race([findLeads({ sources: sources.sources, fetchFeed, news: before.news.items, seen: seen.items, entries: before.entries, screener, today, maxAgeDays: cfg.max_age_days || 14, log }), late]); }
    catch (e) { found = null; rep.problems.push(`news leads failed: ${redact(String(e && e.message || e)).slice(0, 200)}`); }
    finally { clearTimeout(lt); }
    if (!found) { rep.leads_truncated = true; found = { feeds: [], screened_out: [], duplicates: [], seen_add: {}, leads: [] }; }
    rep.feeds_checked = found.feeds.length; rep.feeds_failed = found.feeds.filter((f) => !f.ok).map((f) => ({ id: f.id, why: f.why }));
    rep.screened_out = found.screened_out.length; rep.duplicates = found.duplicates.length;
    mark = { ...found.seen_add };
    const byKey = new Map(before.entries.map((e) => [e.key, e]));
    const jurOf = (k) => { const e = byKey.get(k); return e ? (e.level === 'state' ? e.state || null : 'US') : null; };
    const statements = found.leads.filter((l) => l.primary && l.tracker).map((l) => ({ source: 'release', source_id: l.key, jurisdiction: jurOf(l.tracker), entry_id: l.tracker, class: null, date: l.date, facts: { role: 'statement', publisher: l.publisher }, url: l.release_url, title: l.title, retrieved_at: now.toISOString() }));
    const att = await checkAttachments(attachStatements(Object.values(state.events), statements, { allowHosts: allowHostsFrom(sources) }), state.events, verifier, (state.statement_checks ||= {}));
    const attachedUrls = new Set();
    for (const e of att.events) { const old = state.events[e.key]; if (e.sources.length !== old.sources.length) e.sources.slice(old.sources.length).forEach((s) => attachedUrls.add(s.url)); state.events[e.key] = e; }
    rep.events.statements += attachedUrls.size;
    for (const l of found.leads) {
      const attached = l.primary && attachedUrls.has(canonicalUrl(l.release_url));
      if (!attached) rep.leads.push({ title: l.title, publisher: l.publisher, link: l.link, date: l.date, primary: l.primary, tracker: l.tracker, note: l.primary ? 'official release: no official event it could attach to (shown only as a statement on an event)' : 'press report: never published; a pointer only' });
      mark[l.key] = { first_seen: today, outcome: attached ? 'statement' : 'lead', title: l.title };
    }
    rep.requests = rd.used();
  }

  // 3. the card writer for showable events (only when publishing is on and AI may run), then render and the stop rules
  // The phrase bank (news.ai_writer false) is code only: it runs whenever publishing is on, AI or not.
  if (rep.publishing && !dry && (!aiWriterOn(config) || (!aiOff && factory))) {
    // only events the render may still add or keep current: confirmed, within the 14-day window (the same window as renderNews)
    const since = daysBefore(today, EVENT_DAYS);
    const keys = Object.values(state.events).filter((e) => visible(e) && e.status === 'confirmed' && e.date >= since).map((e) => e.key).sort();
    const w = await writeCards({ state, entries: before.entries, keys, factory, today, config, max: (config.news_writer && config.news_writer.max_cards_per_run) ?? 5, log });
    rep.events.cards_written = w.written; rep.events.cards_tried = w.tried;
  }
  const evs = Object.values(state.events);
  rep.events.pending = evs.filter((e) => e.status === 'pending' && e.class).length;
  rep.events.showable = evs.filter(visible).length;
  const at = now.toISOString();
  const r = renderNews(before.news, state, before.entries, { at });
  rep.events.held = r.held.slice(0, 20);
  const byKey = new Map(r.news.items.filter((n) => n.event_key).map((n) => [n.event_key, n]));
  for (const k of [...r.added, ...r.updated]) { const n = byKey.get(k); rep.drafted.push({ title: n.title, publisher: n.links[0] ? host(n.links[0].u) : null, link: n.links[0] && n.links[0].u, date: n.date, tracker: n.tracker, event_key: k, class: n.class, update: r.updated.includes(k), written: false }); }
  if (rep.drafted.length && rep.publishing) {
    const after = { ...before, news: r.news };
    const problems = [...checkPublish({ before, after, runDate: today, maxEntries: config.max_entries_changed_per_run }).problems, ...checkNewsEvents({ before, after, state: r.state, entries: before.entries, at })];
    if (problems.length) { rep.status = 'stopped'; rep.problems.push(...problems.slice(0, 10)); }
    else {
      rep.status = dry ? 'dry-run' : 'written';
      rep.drafted.forEach((d) => { d.written = !dry; });
      if (!dry) { writeData(dataDir, after, ['news']); if (docsDir) writeData(docsDir, after, ['news']); state.events = r.state.events; markShown(state, r.added, at); }
    }
  } else if (rep.drafted.length || rep.leads.length || rep.events.added.length || rep.events.confirmed.length) rep.status = 'reported';

  if (!dry) {
    saveEvents(eventsFile, state);
    fs.mkdirSync(path.dirname(healthFile), { recursive: true }); saveHealth(healthFile, health, Object.entries(env || process.env).filter(([k]) => /KEY|TOKEN|SECRET/i.test(k)).map(([, v]) => v));
    for (const [k, v] of Object.entries(mark)) seen.items[k] = { ...(seen.items[k] || {}), ...v, first_seen: (seen.items[k] && seen.items[k].first_seen) || v.first_seen, last_seen: today };
    const cut = daysBefore(today, KEEP_DAYS);
    for (const [k, v] of Object.entries(seen.items)) if ((v.last_seen || v.first_seen) < cut) delete seen.items[k];
    if (cfg.enabled) { fs.mkdirSync(path.dirname(seenFile), { recursive: true }); const t = seenFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(seen, null, 1) + '\n'); fs.renameSync(t, seenFile); }
  }
  rep.summary = summaryOf(rep);
  return rep;
}

// Exported: update.mjs rebuilds it after the final check puts items back (written: false), so the commit message counts what is promoted.
export function summaryOf(rep) {
  const n = rep.drafted.filter((d) => d.written).length, e = rep.events || { added: [], confirmed: [] };
  const L = [`News: ${(e.added || []).length} new official event${(e.added || []).length === 1 ? '' : 's'}, ${(e.confirmed || []).length} confirmed, ${rep.drafted.length} item${rep.drafted.length === 1 ? '' : 's'} ready from official records, ${n} published; ${rep.leads.length} lead${rep.leads.length === 1 ? '' : 's'}`];
  rep.drafted.filter((d) => d.written).forEach((d) => L.push(`- ${d.date} ${d.title} (${d.publisher})`));
  return L.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { loadEnv } = await import('../grabber/lib/env.mjs');
  const { createLlmFactory } = await import('../llm/make.mjs');
  loadEnv(pipelineDir);
  const args = process.argv.slice(2), flag = (f) => args.includes(f);
  const root = path.resolve(pipelineDir, '..'), config = readJson(path.join(pipelineDir, 'config', 'publish.json'));
  const factory = createLlmFactory({ models: readJson(path.join(pipelineDir, 'config', 'models.json')), log: (m) => console.log('  ' + m) });
  const dry = flag('--dry-run'), started = new Date();
  const aiOff = dry ? 'dry run (no AI calls are made)' : !factory.hasKey ? `${factory.keyName} is not set` : factory.monthStatus().over ? 'the monthly AI cost cap is reached' : null;
  const r = await newsRun({ dataDir: path.join(root, 'web', 'data', 'v2'), docsDir: config.copy_to_docs ? path.join(root, 'docs', 'data', 'v2') : null, config, factory, aiOff, dry, today: started.toISOString().slice(0, 10), now: started,
    runId: 'news-' + started.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-'), log: (m) => console.log('  ' + m) });
  r.feeds_failed.forEach((f) => console.log(`feed failed: ${f.id}: ${f.why}`));
  r.leads.forEach((l) => console.log(`LEAD ${l.date} ${l.publisher}: ${l.title}\n  ${l.link}\n  ${l.note}`));
  r.drafted.forEach((d) => console.log(`EVENT ${d.date} ${d.title}${d.written ? ' (published)' : ''}`));
  r.problems.forEach((p) => console.log(`problem: ${p}`));
  console.log(`\n${r.status}; ${r.events.added.length} new events, ${r.events.pending} pending, ${r.events.showable} showable; ${r.feeds_checked} feeds, ${r.requests} requests`);
}
