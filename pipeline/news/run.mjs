// The news step: leads from feeds, and news items written from official releases. Run by update.mjs after self-correction; or by hand:
//   node news/run.mjs [--dry-run]
// 1. leads (news/leads.mjs): feeds in config/news-sources.json, last N days, not already on the page or seen before, AI headline screen
// 2. primary leads only: the official release is read and an item drafted and checked (news/write.mjs)
// 3. config/publish.json auto_publish.news: off -> drafted items are reported, not written; on -> added to news.json (never an edit
//    or a deletion: publish/guards.mjs checkPublish and checkNewsAdded must pass, or nothing is written)
// Press (secondary) leads are never published; the Telegram report lists them as "News leads".
// What was seen is kept in state/news-seen.json, so a headline is reported once.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHttp, HttpError } from '../grabber/lib/http.mjs';
import { NEWS_SEEN_FILE } from '../grabber/lib/state.mjs';
import { BudgetExceeded } from '../llm/gemini.mjs';
import { loadData, writeData } from '../publish/run.mjs';
import { checkPublish, checkNewsAdded } from '../publish/guards.mjs';
import { newsKind } from '../publish/tier-a.mjs';
import { findLeads, entryIndex, NEWS_TERMS } from './leads.mjs';
import { robotsAllows } from './feeds.mjs';
import { createRenderer, BrowserUnavailable, RedirectRefused, PageFailed } from './render.mjs';
import { draftNews, duplicateOf, checkLine, shiftDays } from './write.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), pipelineDir = path.resolve(here, '..');
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
export const SEEN_FILE = NEWS_SEEN_FILE;
export const SOURCES_FILE = path.join(pipelineDir, 'config', 'news-sources.json');
const MAX_TRIES = 3, KEEP_DAYS = 120;
const host = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } };

// Reading feeds and release pages the polite way: our own honest name, robots.txt obeyed, a site that refuses us is not read.
// Returns { get(url) -> text, used() }. fetchImpl is a test hook.
export function createReader({ userAgent, fetchImpl, log = () => {}, maxRequests = 80 }) {
  const http = createHttp({ userAgent, maxRequests, retries: 1, timeoutMs: 20000, log, ...(fetchImpl ? { fetchImpl } : {}) });
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

// Style examples for the writer: the most recent hand-checked items about a tracked entry.
// They calibrate what counts as news as well as the style, so they cover the kinds of item the site publishes: the latest bill items,
// the latest letters and demands by members, and the latest agency or executive actions.
const LETTER = /\b(letter|urg\w+|demand\w*|ask\w*|call(?:s|ed)? on)\b/i;
export function examplesFrom(news) {
  const hand = news.filter((n) => n.origin !== 'automated' && n.title && n.body), pick = [];
  const take = (xs, k) => xs.slice(-k).forEach((n) => { if (!pick.includes(n)) pick.push(n); });
  take(hand.filter((n) => n.tracker), 3);
  take(hand.filter((n) => !n.tracker && n.kind === 'federal' && LETTER.test(n.title)), 2);
  take(hand.filter((n) => n.kind === 'executive'), 1);
  return pick.sort((a, b) => a.date.localeCompare(b.date)).map((n) => ({ date: n.date, title: n.title, body: n.body }));
}
// An AI-safety release on a member's own feed that the writer calls "not newsworthy" gets one second opinion (role "referee") before it
// is marked seen: a 107-member AI-safety letter was once refused and lost for good.
const AI_SAFETY = /\b(safety|safeguards?|catastroph\w*|kill switch|rogue|frontier|super ?intelligen\w*|existential|guardrails?|risks?)\b/i;
const aiSafety = (l, release) => { const t = `${l.title} ${l.summary || ''} ${String(release || '').slice(0, 4000)}`; return NEWS_TERMS.test(t) && AI_SAFETY.test(t); };

// config: config/publish.json. sources: config/news-sources.json. factory: llm/make.mjs. aiOff: why AI may not run (null when it may).
// reader: test hook ({ get(url, accept), used(), allowed(url) }). renderer: test hook (news/render.mjs createRenderer: render(url) ->
// { text, finalUrl }, close()); by default a headless browser that may only end up on a primary feed's host. Returns the report section (see report/build.mjs).
export async function newsRun({ dataDir, docsDir = null, seenFile = SEEN_FILE, config, sources = readJson(SOURCES_FILE, { sources: [] }), factory, aiOff = null, dry = false, today, now = new Date(), runId, reader = null, renderer = null, log = () => {} }) {
  const cfg = config.news_leads || { enabled: false };
  const rep = { ran: false, skipped_why: null, status: 'quiet', publishing: !!(config.auto_publish && config.auto_publish.news), feeds_checked: 0, feeds_failed: [], leads: [], drafted: [], screened_out: 0, duplicates: 0, waiting: 0, waiting_record: [], requests: 0, problems: [], summary: '' };
  if (!cfg.enabled) return { ...rep, skipped_why: 'turned off in config/publish.json' };
  rep.ran = true;
  const seen = readJson(seenFile, { _note: 'News leads already seen (news/run.mjs), by link. Do not edit by hand.', items: {} });
  const rd = reader || createReader({ userAgent: sources.user_agent, log });
  const before = loadData(dataDir);
  // official release pages are read in a headless browser, visible text only (news/render.mjs); they may end up (after redirects) only on
  // the host of a primary feed in config/news-sources.json
  const officialHosts = sources.sources.filter((s) => s.primary).map((s) => host(s.url)).filter(Boolean);
  const rend = typeof renderer === 'function' ? renderer(rd) : renderer || createRenderer({ allowHosts: officialHosts, userAgent: sources.user_agent, allowed: (u) => (rd.allowed ? rd.allowed(u) : true), log });
  let browserDown = null;
  const screener = aiOff ? null : factory.make('screener');

  // 1. leads
  const found = await findLeads({ sources: sources.sources, fetchFeed: (u, accept) => rd.get(u, accept || 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8'), news: before.news.items, seen: seen.items, entries: before.entries, screener, today, maxAgeDays: cfg.max_age_days || 14, log });
  rep.feeds_checked = found.feeds.length; rep.feeds_failed = found.feeds.filter((f) => !f.ok).map((f) => ({ id: f.id, why: f.why }));
  rep.screened_out = found.screened_out.length; rep.duplicates = found.duplicates.length;
  const mark = { ...found.seen_add };
  const lead = (l, note) => rep.leads.push({ title: l.title, publisher: l.publisher, link: l.link, date: l.date, primary: l.primary, tracker: l.tracker, note });

  // 2. primary leads become drafts; press leads are reported
  const writer = aiOff ? null : factory.make('generator'), checker = aiOff ? null : factory.make('validator');
  const byKey = new Map(before.entries.map((e) => [e.key, e]));
  const index = entryIndex(before.entries), kindOf = (k) => (byKey.get(k) ? newsKind(byKey.get(k)) : null);
  const feedHost = new Map(sources.sources.map((s) => [s.id, host(s.url)]));
  const items = [], max = cfg.max_drafts_per_run ?? 3;
  let drafts = 0, serviceErrors = 0;
  try {
  for (const l of found.leads) {
    if (!l.primary) { lead(l, 'press report: published only after an official source confirms it'); mark[l.key] = { first_seen: today, outcome: 'lead', title: l.title }; continue; }
    if (host(l.release_url) !== feedHost.get(l.source_id)) { lead(l, 'the release is not on the official site of its feed'); mark[l.key] = { first_seen: today, outcome: 'lead', title: l.title }; continue; }
    if (!writer || !checker) { lead(l, `official release, not drafted: ${aiOff || factory.keyName + ' is not set'}`); continue; } // drafted on a later run
    if (drafts >= max) { rep.waiting++; continue; } // not marked seen: the next run carries on
    // no browser: the release cannot be read the way a reader sees it, so it is held (not marked seen) and the next run tries again
    if (browserDown) { lead(l, `official release, held: ${browserDown}`); continue; }
    drafts++;
    let r;
    try {
      let page;
      try { page = await rend.render(l.release_url); }
      catch (e) {
        if (e instanceof BrowserUnavailable) { browserDown = e.message; rep.problems.push(`news held: ${e.message}`); drafts--; lead(l, `official release, held: ${e.message}`); continue; }
        if (e instanceof RedirectRefused) throw Object.assign(new Error(`the release could not be read: ${e.message}`), { refused: true });
        if (e instanceof PageFailed) throw Object.assign(new Error(`the release could not be read: ${e.message}`), { fetchFailed: true });
        throw Object.assign(new Error(`the release could not be read: ${e.message}`), { fetchFailed: true });
      }
      const release = page.text;
      if (!release) throw Object.assign(new Error('the release could not be read: no visible text on the page'), { fetchFailed: true });
      const args = { lead: l, release, writer, checker, examples: examplesFrom(before.news.items), today, runId, now, maxRounds: cfg.max_rounds || 2, index, kindOf, maxAgeDays: cfg.max_age_days || 14 };
      r = await draftNews(args);
      if (r.outcome === 'not_newsworthy' && l.sponsor && aiSafety(l, release)) {
        let referee = null; try { referee = factory.make('referee'); } catch { referee = null; } // a configuration without the role: no second opinion
        if (referee) r = { ...(await draftNews({ ...args, writer: referee })), refereed: true };
        else r = { outcome: 'error', retry: true, rounds: r.rounds, problems: [], reason: 'an AI-safety release called not newsworthy, and no second opinion (role referee) was available: retried later' };
      }
    } catch (e) {
      if (e instanceof BudgetExceeded) { rep.problems.push(`stopped: ${e.message}`); if (e.scope !== 'item') break; r = { outcome: 'error', retry: true, reason: e.message }; }
      else if (e.refused || e.fetchFailed) r = { outcome: 'error', retry: true, reason: e.message };
      else if (/robots\.txt|HTTP \d|request budget|fetch|network|abort/i.test(e.message)) r = { outcome: 'error', retry: true, reason: `the release could not be read: ${e.message}` };
      else throw e;
    }
    const tries = ((seen.items[l.key] && seen.items[l.key].tries) || 0) + 1;
    const wasWaiting = !!(seen.items[l.key] && seen.items[l.key].outcome === 'waiting_for_record');
    if (r.outcome === 'waiting') {
      // record lag: no AI was used, so it does not count against the drafts per run; kept for retry (no try limit) until the record
      // shows the event or the freshness window closes
      drafts--;
      rep.waiting_record.push({ title: l.title, publisher: l.publisher, link: l.release_url, release_date: r.release_date, reason: r.reason });
      mark[l.key] = { first_seen: today, outcome: 'waiting_for_record', title: l.title, release_date: r.release_date, tries, retry: true };
      continue;
    }
    if (wasWaiting && r.outcome === 'rejected') {
      lead(l, `dropped: waited for the official record to show the event the release reports; now refused: ${r.reason}`);
      mark[l.key] = { first_seen: today, outcome: 'dropped_waiting', title: l.title, tries };
      continue;
    }
    if (r.outcome === 'drafted') {
      const dup = duplicateOf(r.item, [...before.news.items, ...items]);
      if (dup) { rep.duplicates++; mark[l.key] = { first_seen: today, outcome: 'duplicate', title: l.title }; continue; }
      items.push(r.item);
      rep.drafted.push({ title: r.item.title, publisher: l.publisher, link: l.release_url, date: r.item.date, tracker: r.item.tracker, rounds: r.rounds, written: false, item: r.item });
      mark[l.key] = { first_seen: today, outcome: 'drafted', title: l.title };
    } else if (r.outcome === 'not_newsworthy') {
      rep.screened_out++; mark[l.key] = { first_seen: today, outcome: 'not_newsworthy', title: l.title, ...(r.refereed ? { refereed: true } : {}) };
    } else {
      lead(l, r.outcome === 'rejected' ? `draft refused: ${r.reason}` : r.reason);
      mark[l.key] = { first_seen: today, outcome: r.outcome, title: l.title, tries, ...(r.retry && tries < MAX_TRIES ? { retry: true } : {}) };
    }
    serviceErrors = r.service_error ? serviceErrors + 1 : 0;
    if (serviceErrors >= 2) { rep.problems.push('stopped: the model service failed twice in a row'); break; }
  }
  } finally { if (!renderer) await rend.close(); }
  rep.requests = rd.used();
  // a release still waiting for the record when its freshness window has closed (it no longer comes back from its feed): dropped, with
  // a report line
  const windowStart = shiftDays(today, -(cfg.max_age_days || 14));
  for (const [k, v] of Object.entries(seen.items)) {
    if (v.outcome !== 'waiting_for_record' || mark[k] || !(v.release_date < windowStart)) continue;
    rep.leads.push({ title: v.title, publisher: null, link: k, date: v.release_date, primary: true, tracker: null, note: `dropped: the official record did not show the event the release reports within the ${cfg.max_age_days || 14}-day window` });
    mark[k] = { ...v, outcome: 'dropped_waiting', retry: false };
  }

  // 3. the switch, then the stop rules; any problem means nothing is written and the drafts are retried
  if (items.length && rep.publishing) {
    const after = { ...before, news: { ...before.news, items: [...before.news.items, ...items].sort((a, b) => a.date.localeCompare(b.date)) } };
    const publisherOf = new Map(rep.drafted.map((d) => [JSON.stringify(d.item), d.publisher]));
    const problems = [...checkPublish({ before, after, runDate: today, maxEntries: config.max_entries_changed_per_run }).problems, ...checkNewsAdded({ before, after, expected: items, checkLine: (n) => checkLine(publisherOf.get(JSON.stringify(n))) })];
    if (problems.length) {
      rep.status = 'stopped'; rep.problems.push(...problems.slice(0, 10));
      for (const [k, v] of Object.entries(mark)) if (v.outcome === 'drafted') mark[k] = { ...v, outcome: 'error', retry: true };
    } else {
      rep.status = dry ? 'dry-run' : 'written';
      rep.drafted.forEach((d) => { d.written = !dry; });
      if (!dry) { writeData(dataDir, after, ['news']); if (docsDir) writeData(docsDir, after, ['news']); }
    }
  } else if (items.length) rep.status = 'reported';
  else if (rep.leads.length) rep.status = 'reported';
  rep.drafted.forEach((d) => { delete d.item; });

  if (!dry) {
    for (const [k, v] of Object.entries(mark)) seen.items[k] = { ...(seen.items[k] || {}), ...v, first_seen: (seen.items[k] && seen.items[k].first_seen) || v.first_seen, last_seen: today };
    const cut = new Date(Date.parse(today + 'T00:00:00Z') - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
    for (const [k, v] of Object.entries(seen.items)) if ((v.last_seen || v.first_seen) < cut) delete seen.items[k]; // older than any feed window
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    const t = seenFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(seen, null, 1) + '\n'); fs.renameSync(t, seenFile);
  }
  rep.summary = summaryOf(rep);
  return rep;
}

// Exported: update.mjs rebuilds it after the final check puts items back (written: false), so the commit message counts what is promoted.
export function summaryOf(rep) {
  const n = rep.drafted.filter((d) => d.written).length;
  const L = [`News: ${rep.leads.length} lead${rep.leads.length === 1 ? '' : 's'}, ${rep.drafted.length} item${rep.drafted.length === 1 ? '' : 's'} drafted from official releases, ${n} published`];
  rep.drafted.filter((d) => d.written).forEach((d) => L.push(`- ${d.date} ${d.title} (${d.publisher})`));
  (rep.waiting_record || []).forEach((w) => L.push(`- waiting for the official record (retried next run): ${w.release_date} ${w.title} (${w.publisher})`));
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
  if (r.skipped_why) console.log(`skipped: ${r.skipped_why}`);
  r.feeds_failed.forEach((f) => console.log(`feed failed: ${f.id}: ${f.why}`));
  r.leads.forEach((l) => console.log(`LEAD ${l.date} ${l.publisher}: ${l.title}\n  ${l.link}\n  ${l.note}`));
  r.drafted.forEach((d) => console.log(`DRAFTED ${d.date} ${d.publisher}: ${d.title}${d.written ? ' (published)' : ''}`));
  r.problems.forEach((p) => console.log(`problem: ${p}`));
  console.log(`\n${r.status}; ${r.feeds_checked} feeds, ${r.screened_out} screened out, ${r.duplicates} duplicates, ${r.waiting} waiting, ${r.requests} requests`);
}
