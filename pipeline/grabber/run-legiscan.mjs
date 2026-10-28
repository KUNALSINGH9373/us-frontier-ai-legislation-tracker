// The LegiScan Grabber. Plain code plus one cheap AI title check. Same contract as the Congress.gov and Federal Register ones:
// finds what changed since the last successful run, saves the raw record, writes a change set.
//
// Built to MISS NOTHING in scope while spending as few of the free tier's 30,000 monthly queries as possible:
//   - tracked bills: ONE getMasterListRaw per open session (change_hash for every bill in it); getBill only for bills whose hash changed
//   - new bills: two bulk full-text searches per run (getSearchRaw: up to 2,000 hits per query, so nothing is cut off by a page limit)
//       precise: frontier wording ("frontier model", compute thresholds, ...). Every hit is a candidate; no title screen.
//       wide:    every bill whose text says "artificial intelligence". Titles of bills not seen before go to the AI intent check
//                (grabber/intent.mjs); only a confident "no" is dropped. A failed AI call drops nothing.
//   - a bill judged "no" is remembered (state/legiscan-seen.json) and re-checked only if it changed and 30 days have passed
//   - bill text only for candidates (HTML, or PDF read by grabber/lib/pdf.mjs), never for tracked updates
//   - a per-run budget and a monthly cap, counted in state/legiscan-usage.json (written even when a run fails)
// Caps only DELAY work: anything not reached in a run is not marked seen and is picked up by the next run.
import fs from 'fs';
import path from 'path';
import { createLegiScan, normNumber, billNumbersIn, officialUrl, latestText, trackerStatus, eventsFrom } from './sources/legiscan.mjs';
import { QuotaExceeded, HttpError, NetworkError } from './lib/http.mjs';
import { isoZ, makeRunId, saveRaw, writeChangeset } from './lib/run-common.mjs';
import { LEGISCAN_USAGE_FILE } from './lib/state.mjs';
export { LEGISCAN_USAGE_FILE };
import { pdfToText } from './lib/pdf.mjs';
import { classifyTitles, fetchIt } from './intent.mjs';

export const LS_CUTOFF = '2026-09-29T00:00:00Z';
const MAX_TEXT = 1_500_000;
const RESCREEN_DAYS = 30;

// Words in a bill's text that show frontier-AI content. Only a FLAG for the agents; nothing is dropped on it.
export const FRONTIER_MARKERS = [/frontier (ai|artificial intelligence|model|developer)/i, /foundation model/i, /10\s*\^?\s*(26|25)|10\s*to the\s*(26|25)/i, /floating[- ]point operations|integer or floating/i, /large developer/i, /critical (harm|safety incident)/i, /catastrophic risk/i, /independent verification organi[sz]ation/i, /kill switch|full shutdown/i, /safety and security protocol|frontier ai framework/i, /\b(ai|artificial intelligence) safety\b/i, /superintelligen|artificial general intelligence/i, /risk mitigation organi[sz]ation/i];
export const frontierMarkers = (text) => (text ? FRONTIER_MARKERS.filter((r) => r.test(text)).map((r) => (text.match(r) || [''])[0].toLowerCase()) : []);

// ---------- monthly usage counter ----------
const month = (now) => isoZ(now).slice(0, 7);
export function readUsage(file, now) {
  const u = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  return u && u.month === month(now) ? u : { month: month(now), used: 0, runs: 0 };
}
export function addUsage(file, now, n) {
  const u = readUsage(file, now);
  const next = { ...u, used: u.used + n, runs: u.runs + 1, updated_at: isoZ(new Date()) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 1) + '\n');
  return next;
}

// tracked: config/identifiers-legiscan.json "legiscan" block -> [{ entry_key, bill_id, number, state, session_id, year_end }]
export const trackedBills = (ids) => Object.entries((ids && ids.legiscan) || {})
  .filter(([, v]) => v.status !== 'rejected')
  .flatMap(([key, v]) => (v.bills || []).map((b) => ({ entry_key: key, ...b })));

export const preciseQuery = (cfg) => cfg.precise_phrases.map((p) => `"${p}"`).join(' OR ');

// official: grabber/sources/official.mjs (bill text from the state's own site, no LegiScan query). only: which candidates to fetch this run
// ("precise", "yes", "maybe"), so a catch-up can go in priority order.
export async function runLegiScan({ http, apiKey, llm = null, official = null, only = null, state, seen = {}, ids, entries = [], cfg, outDir, now = new Date(), bills = [], noSearch = false, dryRun = false, log = () => {} }) {
  const ls = createLegiScan(http, apiKey);
  const runId = makeRunId(now);
  const block = structuredClone(state.sources.legiscan || { last_success: LS_CUTOFF, cursor: null, hashes: {} });
  block.hashes = block.hashes || {};
  const nextSeen = structuredClone(seen);
  const tracked = trackedBills(ids);
  const trackedById = new Map(tracked.map((t) => [String(t.bill_id), t]));
  // Every state bill number the tracker already has an entry for, including failed ones that are not watched: never a "new" bill.
  const known = new Set(entries.filter((e) => e.level === 'state' && e.state).flatMap((e) => billNumbersIn(`${e.title} ${e.short_name} ${e.sponsor_text || ''}`).map((n) => `${e.state}:${n}`)));
  const billCache = new Map();
  const getBill = async (id) => { if (!billCache.has(String(id))) billCache.set(String(id), await ls.bill(id)); return billCache.get(String(id)); };

  const items = [], screenedOut = [];
  const stats = { sessions_checked: 0, sessions_skipped_closed: 0, tracked_changed: 0, tracked_unchanged: 0, tracked_missing: 0,
    precise_hits: 0, wide_hits: 0, new_to_screen: 0, title_pages: 0, intent_yes: 0, intent_maybe: 0, intent_no: 0, intent_fallback: 0,
    known_entry: 0, other_jurisdiction: 0, held_by_only: 0, text_from_official: 0, already_seen: 0, waiting_for_next_run: 0, candidates: 0, text_from_pdf: 0, text_missing: 0, frontier_marked: 0 };
  let truncated = false;
  const read = new Set(); // tracked bill ids read this run (status.json "checked" counts only these)

  async function readText(bill) {
    const v = latestText(bill);
    if (!v) return { text: null, meta: null };
    // 1. the legislature's own copy: no LegiScan query, and it is the official source
    if (official && v.state_link) {
      try {
        const t = await official.text(v.state_link);
        const meta = { doc_id: v.doc_id, date: v.date, type: v.type, mime: t.mime, state_link: v.state_link, from: 'official' };
        if (t.bytes) { meta.saved_file = saveRaw({ outDir, runId, source: 'legiscan', name: `${bill.state}-${bill.bill_number}-${bill.bill_id}.pdf`, text: t.bytes }).rel; meta.pdf = t.pdf; }
        if (t.text) { stats.text_from_official++; if (t.bytes) stats.text_from_pdf++; return { text: t.text, meta }; }
        log(`official text for ${bill.state} ${bill.bill_number} unreadable (${t.pdf && t.pdf.reason}); trying LegiScan's copy`);
      } catch (e) { log(`official site failed for ${bill.state} ${bill.bill_number}: ${String(e.message).slice(0, 80)}; trying LegiScan's copy`); }
      if (!cfg.text_fallback_legiscan) return { text: null, meta: { doc_id: v.doc_id, state_link: v.state_link, from: 'official', reason: 'official copy failed; LegiScan fallback is off' } };
    }
    // 2. LegiScan's copy (one query)
    try {
      const t = await ls.text(v.doc_id);
      const meta = { doc_id: v.doc_id, date: t.date, type: t.type, mime: t.mime, state_link: v.state_link || null, from: 'legiscan' };
      if (t.text != null) return { text: t.text, meta };
      if (t.bytes) {
        meta.saved_file = saveRaw({ outDir, runId, source: 'legiscan', name: `${bill.state}-${bill.bill_number}-${bill.bill_id}.pdf`, text: t.bytes }).rel; // the exact file the words came from
        const p = /pdf/i.test(t.mime) ? await pdfToText(t.bytes) : { text: null, reason: 'unsupported format ' + t.mime };
        meta.pdf = { pages: p.pages || null, truncated: !!p.truncated, reason: p.reason || null, warnings: p.warnings || [] };
        if (p.text) { stats.text_from_pdf++; return { text: p.text, meta }; }
      }
      return { text: null, meta };
    } catch (e) { if (!(e instanceof HttpError || e instanceof NetworkError)) throw e; log(`no text for ${bill.bill_id}: ${String(e.message).slice(0, 80)}`); return { text: null, meta: null }; }
  }

  async function collect(billId, reason, entryKey, hit) {
    const bill = await getBill(billId);
    let extra = {};
    if (reason === 'discovery') {
      const { text, meta } = await readText(bill);
      if (text == null) stats.text_missing++;
      const markers = frontierMarkers(text);
      if (markers.length) stats.frontier_marked++;
      extra = { text: text ? text.slice(0, MAX_TEXT) : null, text_truncated: !!text && text.length > MAX_TEXT, text_missing: text == null, text_version: meta, frontier_markers: markers };
    }
    const raw = JSON.stringify({ id: String(billId), search_hit: hit || null, bill, derived: { status: trackerStatus(bill.status), events: eventsFrom(bill) }, ...extra }, null, 1);
    const saved = saveRaw({ outDir, runId, source: 'legiscan', name: `${bill.state}-${bill.bill_number}-${billId}.json`, text: raw });
    items.push({
      item_id: `legiscan:${billId}`, source: 'legiscan', source_id: String(billId), entry_key: entryKey || null,
      change: entryKey ? 'changed' : 'new', reason, source_url: officialUrl(bill), fetched_at: isoZ(new Date()),
      raw_hash: saved.hash, raw_path: saved.rel, title: `${bill.state} ${bill.bill_number}: ${bill.title}`
    });
    block.hashes[String(billId)] = bill.change_hash;
  }

  // A bill we decided not to fetch (no / known / other jurisdiction). Remembered so it costs nothing next run.
  const remember = (id, hash, rec) => { nextSeen[id] = { ...rec, hash, checked_at: isoZ(now) }; };
  const skipSeen = (id, hash) => {
    const s = seen[id];
    if (!s) return false;
    if (s.verdict !== 'no') return true; // known entry / other jurisdiction: a fact, never re-checked
    return s.hash === hash || (+now - Date.parse(s.checked_at)) < RESCREEN_DAYS * 864e5;
  };

  try {
    if (bills.length) {
      for (const id of bills) await collect(id, 'reconcile', trackedById.get(String(id)) && trackedById.get(String(id)).entry_key);
    } else {
      // 1. tracked bills: one master list per open session
      const sessions = new Map();
      for (const t of tracked) { if (!sessions.has(t.session_id)) sessions.set(t.session_id, []); sessions.get(t.session_id).push(t); }
      for (const [sid, list] of sessions) {
        const closed = (t) => (t.year_end ? t.year_end < now.getUTCFullYear() : t.session_open === false); // a session whose last year is over cannot change
        if (list.every(closed)) { stats.sessions_skipped_closed++; stats.tracked_unchanged += list.length; list.forEach((t) => read.add(String(t.bill_id))); continue; }
        const ml = await ls.masterListRaw(sid); stats.sessions_checked++;
        const hash = new Map(ml.bills.map((b) => [String(b.bill_id), b.change_hash]));
        for (const t of list) {
          const h = hash.get(String(t.bill_id));
          if (!h) { stats.tracked_missing++; log(`tracked bill ${t.state} ${t.number} (${t.bill_id}) is not in session ${sid}'s master list`); continue; }
          if (block.hashes[String(t.bill_id)] === h) { stats.tracked_unchanged++; read.add(String(t.bill_id)); continue; }
          await collect(t.bill_id, 'updated_since_cursor', t.entry_key); stats.tracked_changed++; read.add(String(t.bill_id));
        }
      }

      if (!noSearch) {
        // 2. two bulk searches: every hit, no page limit
        const precise = await ls.searchRaw({ query: preciseQuery(cfg) });
        const wide = await ls.searchRaw({ query: cfg.wide_query });
        stats.precise_hits = precise.length; stats.wide_hits = wide.length;
        const hits = new Map();
        for (const h of wide) hits.set(String(h.bill_id), { ...h, precise: false });
        for (const h of precise) hits.set(String(h.bill_id), { ...h, precise: true });

        // 3. what is new to us
        const todo = [];
        for (const [id, h] of hits) {
          if (trackedById.has(id)) continue;
          if (block.hashes[id] === h.change_hash || skipSeen(id, h.change_hash)) { stats.already_seen++; continue; }
          todo.push(h);
        }
        stats.new_to_screen = todo.length;

        // 4. titles for the wide hits (the bulk search has none): one getBill each when few, else the titled search pages (50 a query)
        const info = new Map();
        const needTitle = todo.filter((h) => !h.precise);
        if (needTitle.length && needTitle.length <= cfg.title_by_bill_max) {
          for (const h of needTitle) { const b = await getBill(h.bill_id); info.set(String(h.bill_id), { title: b.title, state: b.state, number: b.bill_number }); }
        } else if (needTitle.length) {
          const want = new Set(needTitle.map((h) => String(h.bill_id)));
          for (let page = 1; want.size && page <= cfg.title_pages_per_run; page++) {
            const r = await ls.search({ query: cfg.wide_query, page }); stats.title_pages++;
            for (const x of r.results) if (want.delete(String(x.bill_id))) info.set(String(x.bill_id), { title: x.title, state: x.state, number: x.bill_number });
            if (!r.summary || page >= Number(r.summary.page_total)) break;
          }
          stats.waiting_for_next_run += want.size; // titles not reached this run: left unseen, so the next run continues
        }

        // 5. known entries and other jurisdictions are settled without the model
        const toJudge = [];
        for (const h of needTitle) {
          const id = String(h.bill_id), x = info.get(id);
          if (!x) continue;
          if (cfg.exclude_states.includes(x.state)) { stats.other_jurisdiction++; remember(id, h.change_hash, { verdict: 'other_jurisdiction', ...x }); continue; }
          if (known.has(`${x.state}:${normNumber(x.number)}`)) { stats.known_entry++; remember(id, h.change_hash, { verdict: 'known_entry', ...x }); continue; }
          toJudge.push({ id, ...x, hit: h });
        }

        // 6. the AI intent check on the titles
        const verdicts = toJudge.length ? await classifyTitles({ llm, items: toJudge, log }) : new Map();
        const queue = todo.filter((h) => h.precise).map((h) => ({ h, why: 'precise' }));
        for (const j of toJudge) {
          const v = verdicts.get(j.id);
          stats['intent_' + v.verdict]++; if (v.by === 'fallback') stats.intent_fallback++;
          if (fetchIt(v)) queue.push({ h: j.hit, why: v.verdict, v, x: j });
          else { remember(j.id, j.hit.change_hash, { verdict: 'no', reason: v.reason, title: j.title, state: j.state, number: j.number }); screenedOut.push({ bill_id: +j.id, state: j.state, number: j.number, title: j.title, reason: v.reason }); }
        }

        // 7. fetch candidates: precise first, then "yes", then "maybe", most relevant first; the rest wait for the next run
        const rank = { precise: 0, yes: 1, maybe: 2 };
        queue.sort((a, b) => rank[a.why] - rank[b.why] || b.h.relevance - a.h.relevance);
        if (only) { const keep = queue.filter((q) => only.includes(q.why)); stats.held_by_only = queue.length - keep.length; queue.length = 0; queue.push(...keep); } // held ones stay unseen
        let taken = 0;
        for (const [i, q] of queue.entries()) {
          if (taken >= cfg.max_candidates_per_run) { stats.waiting_for_next_run += queue.length - i; truncated = true; break; }
          const id = String(q.h.bill_id);
          if (q.why === 'precise') { // precise hits have no title yet: settle known entries and other jurisdictions from the bill itself
            const b = await getBill(id), x = { title: b.title, state: b.state, number: b.bill_number };
            if (cfg.exclude_states.includes(b.state)) { stats.other_jurisdiction++; remember(id, q.h.change_hash, { verdict: 'other_jurisdiction', ...x }); continue; }
            if (known.has(`${b.state}:${normNumber(b.bill_number)}`)) { stats.known_entry++; remember(id, q.h.change_hash, { verdict: 'known_entry', ...x }); continue; }
          }
          await collect(id, 'discovery', null, { search: q.why === 'precise' ? 'precise' : 'wide', relevance: q.h.relevance, intent: q.v ? { verdict: q.v.verdict, reason: q.v.reason, by: q.v.by } : null });
          stats.candidates++; taken++;
        }
      }
    }
  } catch (e) {
    if (e instanceof QuotaExceeded) { truncated = true; log(`stopped early: ${e.message}`); }
    else throw Object.assign(e, { partial: { runId, items, stats } });
  }

  // Bills the AI check dropped are listed next to the change set, with its reason, so nothing disappears silently.
  const changeset = writeChangeset({ outDir, runId, items });
  if (screenedOut.length) fs.writeFileSync(path.join(outDir, runId, 'legiscan-screened-out.json'), JSON.stringify(screenedOut, null, 1) + '\n');
  const next = { ...state, sources: { ...state.sources, legiscan: { ...block, last_success: isoZ(new Date()), cursor: null, quota: { period: 'run', used: http.used(), limit: http.maxRequests } } } };
  // The entries whose tracked bills were all read (an entry with two bills counts only when both were).
  const checkedKeys = [...new Set(tracked.map((t) => t.entry_key))].filter((k) => tracked.filter((t) => t.entry_key === k).every((t) => read.has(String(t.bill_id))));
  return { runId, changeset, stats, truncated, requests: http.used(), nextState: next, nextSeen, screenedOut, checked: checkedKeys, saved: !dryRun };
}
