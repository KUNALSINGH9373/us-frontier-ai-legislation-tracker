// Court dockets as Tier A facts. For each tracked federal case in config/courts.json (entry key -> { court, docket_id }), read the
// docket entries filed since the last run from CourtListener, keep the material ones (orders, judgments, notices of appeal, minute
// orders setting deadlines, withdrawals; see grabber/sources/courtlistener.mjs) and write each as a "Litigation" event in the court's
// own words. Orders, judgments and appeals also get a fixed-wording news item and a line in the status text. No AI is used.
// The same stop rules as every publish (publish/guards.mjs): any problem and nothing is written; the docket state is then not moved,
// so the next run reads the same entries again.
//   update.mjs calls courtsRun() when config/publish.json "courts": { "enabled": true }.
import fs from 'fs';
import path from 'path';
import { longDate } from '../agents/derive.mjs';
import { datesMentioned } from '../compare/congress.mjs';
import { advanceCutoff } from './tier-a.mjs';
import { checkPublish } from './guards.mjs';
import { loadData, writeData } from './run.mjs';
import { createCourtListener, classifyEntry, docketUrl } from '../grabber/sources/courtlistener.mjs';
import { QuotaExceeded, HttpError, NetworkError } from '../grabber/lib/http.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const SOURCE = 'court docket via CourtListener';

// found: [{ entry_key, docket_id, court, entry (a CourtListener docket entry) }]. Pure: returns new data plus the change log.
export function applyCourts({ data, found, runDate, runId, config = {} }) {
  const out = { entries: clone(data.entries), news: clone(data.news), site: clone(data.site), changes: clone(data.changes || { items: [] }) };
  const byKey = new Map(out.entries.map((e) => [e.key, e]));
  const applied = [], skipped = [], log = [], touched = new Set();
  const at = runDate + 'T00:00:00Z', cutoff = runDate > data.site.updates_through ? runDate : data.site.updates_through;
  const notes = new Map(); // entry key -> [{ date, text }]

  for (const f of found) {
    const e = byKey.get(f.entry_key), c = classifyEntry(f.entry);
    if (!e) { skipped.push({ entry_key: f.entry_key, why: 'no such entry (config/courts.json)' }); continue; }
    if (!c) continue; // routine
    const date = f.entry.date_filed, url = docketUrl(f.docket_id), n = f.entry.entry_number;
    // Already on the entry: the same words, the same docket number, or a person's own account of that day's ruling.
    const dup = e.events.some((v) => v.date === date && v.type === 'Litigation' && (v.text === cut(c.text, 200) || (n != null && new RegExp(`\\bDkt\\.? ?${n}\\b`).test(v.text + ' ' + (v.clause || ''))) || !/courtlistener\.com/.test(v.source_url || '')));
    if (dup) { skipped.push({ entry_key: e.key, why: `docket entry ${n ?? f.entry.id} (${date}) is already on the entry` }); continue; }
    const quote = c.full; // the whole docket text: a quote is never cut
    e.events.push({ date, precision: 'day', type: 'Litigation', text: cut(c.text, 200), clause: c.full, scheduled: date > cutoff, source_url: url });
    log.push({ entry_key: e.key, field: 'events', old: null, new: { date, type: 'Litigation', text: c.full }, date: runDate, run_id: runId, source_url: url, tier: 'A' });
    (e.evidence = e.evidence || []).push({ field: 'events', quote, source_url: url });
    if (c.news) {
      const add = `${c.label}${n != null ? ` (Dkt. ${n})` : ''} (${longDate(date)}, ${SOURCE})`;
      const said = datesMentioned(e.status_text, [], +(e.last_checked || runDate).slice(0, 4)).has(date);
      if (!said) {
        const old = e.status_text;
        e.status_text = old ? `${old.replace(/[\s.;]+$/, '')}; ${add}` : add;
        log.push({ entry_key: e.key, field: 'status_text', old, new: e.status_text, date: runDate, run_id: runId, source_url: url, tier: 'A' });
      }
      if (config.news_from_official_actions !== false && !out.news.items.some((y) => y.tracker === e.key && y.date === date)) {
        out.news.items.push({
          date, kind: 'litigation', title: cut(`${e.short_name}: ${c.label}`, 140),
          body: `The court docket (${f.court}) records this entry in ${e.title} on ${longDate(date)}: "${c.full}".`,
          links: [{ t: `${e.short_name} docket on CourtListener`, u: url }],
          check: 'From the court docket (CourtListener), copied word for word by code; no AI was used.',
          tracker: e.key, origin: 'automated', verification: { method: 'agent', checked_at: at, run_id: runId, rounds: 0 },
          evidence: [{ field: 'body', quote, source_url: url }]
        });
      }
    }
    if (!e.identifiers) e.identifiers = { external: { courtlistener_docket: String(f.docket_id) } }; // a mixed entry must say how it is found
    if (e.origin === 'authored') { log.push({ entry_key: e.key, field: 'origin', old: 'authored', new: 'mixed', date: runDate, run_id: runId, source_url: url, tier: 'A' }); e.origin = 'mixed'; }
    e.verification = { method: 'agent', checked_at: at, run_id: runId, rounds: 0 };
    e.last_checked = runDate; e.last_changed = runDate;
    e.events.sort((x, y) => x.date.localeCompare(y.date));
    touched.add(e.key);
    (notes.get(e.key) || notes.set(e.key, []).get(e.key)).push({ date, text: `${c.label}: ${cut(c.text, 160)}` });
  }
  for (const [k, a] of notes) applied.push({ item_id: `courtlistener:${found.find((f) => f.entry_key === k).docket_id}`, entry_key: k, actions: a, status: null });
  if (touched.size) { advanceCutoff(out, runDate); out.changes.items.push(...log); }
  return { data: out, applied, skipped, touched: [...touched], log };
}

// The step. cases: config/courts.json; stateFile: data/courts-state.json ({ dockets: { id: { last_date, seen: { entry id: date } } } }).
// A docket never read before starts from its entry's last_checked date (what the entry already says is not read again).
export async function courtsRun({ http, limiter, cases, dataDir, docsDir = null, stateFile, config = {}, runId, now = new Date(), dry = false, maxPages = 10, log = () => {} }) {
  const runDate = now.toISOString().slice(0, 10);
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { dockets: {} };
  const next = clone(state); next.dockets = next.dockets || {};
  const before = loadData(dataDir), byKey = new Map(before.entries.map((e) => [e.key, e]));
  const cl = createCourtListener(http, { limiter });
  const found = [], errors = [], read = [];
  for (const [key, c] of Object.entries(cases).filter(([k]) => !k.startsWith('_'))) {
    const id = String(c.docket_id), st = state.dockets && state.dockets[id];
    const since = (st && st.last_date) || (byKey.get(key) && byKey.get(key).last_checked) || runDate;
    let r;
    try { r = await cl.newEntries({ docketId: id, since, seen: st ? Object.keys(st.seen || {}) : [], maxPages }); }
    catch (e) {
      if (e instanceof QuotaExceeded) { errors.push(`${key}: request budget reached; the rest waits for the next run`); break; }
      if (e instanceof HttpError || e instanceof NetworkError) { errors.push(`${key}: ${String(e.message).slice(0, 120)}`); continue; }
      throw e;
    }
    read.push({ entry_key: key, docket_id: id, since, new_entries: r.entries.length, complete: r.complete });
    r.entries.forEach((x) => found.push({ entry_key: key, docket_id: id, court: c.court, entry: x }));
    // Next time: from the newest date seen, skipping the entries of that date already read. A docket not read to `since` (too many
    // new entries for maxPages) keeps its date, so the older ones are read next run; the ones read now are remembered.
    const seen = { ...((st && st.seen) || {}) };
    r.entries.forEach((x) => { seen[x.id] = x.date_filed; });
    const last = r.complete ? [since, ...r.entries.map((x) => x.date_filed)].sort().pop() : since;
    next.dockets[id] = { entry_key: key, last_date: last, seen: Object.fromEntries(Object.entries(seen).filter(([, d]) => d >= last)), checked_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z') };
  }
  const material = found.filter((f) => classifyEntry(f.entry));
  const a = applyCourts({ data: before, found: material, runDate, runId, config });
  const after = { ...a.data, relationships: before.relationships };
  const check = a.touched.length ? checkPublish({ before, after, runDate, maxEntries: config.max_entries_changed_per_run ?? 15 }) : { problems: [], changed: 0 };
  const L = [`Court dockets ${runId} (${runDate}): ${read.length} docket(s) read, ${found.length} new docket entr${found.length === 1 ? 'y' : 'ies'}, ${material.length} material, ${a.touched.length} entr${a.touched.length === 1 ? 'y' : 'ies'} updated${dry ? ' [dry run, nothing written]' : ''}`];
  a.applied.forEach((x) => { L.push(`- ${x.entry_key}`); x.actions.forEach((y) => L.push(`    ${y.date}: ${y.text}`)); });
  errors.forEach((x) => L.push(`- not read: ${x}`));
  check.problems.forEach((p) => L.push(`- STOPPED: ${p}`));
  const summary = L.join('\n') + '\n';
  if (check.problems.length) return { status: 'stopped', summary, result: a, check, read, errors, requests: http.used() };
  if (!dry) {
    if (a.touched.length) { const keys = ['entries', 'news', 'site', 'changes']; writeData(dataDir, after, keys); if (docsDir) writeData(docsDir, after, keys); }
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const t = stateFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(next, null, 1) + '\n'); fs.renameSync(t, stateFile);
  }
  log(summary.trim());
  return { status: a.touched.length ? (dry ? 'dry-run' : 'published') : 'quiet', summary, result: a, check, read, errors, requests: http.used(), nextState: next };
}
