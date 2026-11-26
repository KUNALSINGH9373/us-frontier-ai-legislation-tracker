// End of a state session: a pending state bill dies when its two-year (or special) session ends without passing it. The date differs by
// state and LegiScan's "adjourned" flag alone is not enough (26 Nov 2026: LegiScan already lists New York's and Illinois's 2025-2026
// sessions as adjourned, but New York bills can pass until 31 Dec and Illinois often passes bills in its January lame-duck session).
// So a bill is marked only when LegiScan shows BOTH: its session adjourned (sine_die) and a newer regular session of that state that
// has convened (not prefile). Nothing is checked before the calendar year after the session's last year.
//
// Code only, no AI. Each bill's own LegiScan record is read first:
//   - a bill that passed both chambers, went to the governor, was signed or vetoed is left alone (its record decides; Tier A follows it);
//   - a record that cannot be read waits for the next run;
//   - otherwise the entry becomes "failed", with a status-text sentence quoting the record's last action as evidence.
// LegiScan queries are counted on the monthly counter (state/legiscan-usage.json) and never go past the monthly cap.
//   applySessionEnd({ data, tracked, sessions, bills, now, runId })   pure
//   sessionEndRun({ legiscan, tracked, dataDir, docsDir, config, lsConfig, usageFile, now, runId, dry, maxEntries, log })
import { statusFor } from '../agents/rules.mjs';
import { longDate } from '../agents/derive.mjs';
import { checkPublish, removeStale } from './guards.mjs';
import { advanceCutoff } from './tier-a.mjs';
import { loadData, writeData } from './run.mjs';
import { readUsage, addUsage } from '../grabber/run-legiscan.mjs';
import { HttpError, NetworkError, QuotaExceeded } from '../grabber/lib/http.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const LIVE = ['pending', 'stalled'];
// LegiScan bill status: 3 Enrolled (passed both chambers), 4 Passed (became law), 5 Vetoed. Any of them, or such an action, keeps the bill.
const KEPT_STATUS = new Set([3, 4, 5]);
export const TO_GOVERNOR = /\b(enrolled|to (the )?governor|governor'?s? (desk|action|signature)|signed by (the )?governor|approved by (the )?governor|chaptered|chapter \d+|vetoed|veto)\b/i;

// tracked: config/identifiers-legiscan.json "legiscan" block. The pending state bills it follows, with their sessions.
export function candidates(data, tracked) {
  return data.entries.filter((e) => e.level === 'state' && ['bill', 'auditor'].includes(e.type) && LIVE.includes(e.status) && tracked[e.key] && tracked[e.key].status !== 'rejected' && (tracked[e.key].bills || []).length);
}
// Due: every bill of the entry is in a session whose last year is over (a session can end no sooner than that).
export function due(data, tracked, now) {
  const year = new Date(now).getUTCFullYear();
  return candidates(data, tracked).filter((e) => tracked[e.key].bills.every((b) => Number(b.year_end) < year));
}
// The session that shows a bill's session is over: a newer regular session of the same state that has convened.
export const newerSession = (list, s) => list.find((x) => String(x.session_id) !== String(s.session_id) && !Number(x.special) && !Number(x.prefile) && Number(x.year_start) > Number(s.year_end));
export const sessionOver = (list, sessionId) => { const s = list.find((x) => String(x.session_id) === String(sessionId)); return s && Number(s.sine_die) === 1 ? newerSession(list, s) || null : null; };

// sessions: { state: [LegiScan session list] }; bills: { bill_id: LegiScan bill } for the bills read this run.
export function applySessionEnd({ data, tracked, sessions = {}, bills = {}, now, runId }) {
  const out = clone(data), runDate = new Date(now).toISOString().slice(0, 10), at = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const log = [], applied = [], skipped = [], touched = [], waiting = [];
  for (const e of due(out, tracked, now)) {
    const tb = tracked[e.key].bills;
    const over = tb.map((b) => (sessions[b.state] ? sessionOver(sessions[b.state], b.session_id) : undefined));
    if (over.some((x) => x === undefined)) { skipped.push({ entry_key: e.key, why: 'its session list was not read this run; tried again next run' }); continue; }
    if (over.some((x) => x === null)) { waiting.push(e.key); continue; } // the session is not over by LegiScan's record yet: nothing to report
    const recs = tb.map((b) => bills[b.bill_id]);
    if (recs.some((r) => !r)) { skipped.push({ entry_key: e.key, why: 'its LegiScan record was not read this run; tried again next run' }); continue; }
    const kept = recs.find((r) => KEPT_STATUS.has(Number(r.status)) || (r.history || []).some((h) => TO_GOVERNOR.test(h.action || '')));
    if (kept) { skipped.push({ entry_key: e.key, why: `${kept.state} ${kept.bill_number} passed both chambers or went to the governor; its record decides, not the end of the session` }); continue; }
    if (statusFor(e.section, 'failed') !== 'failed') { skipped.push({ entry_key: e.key, why: `section ${e.section} has no "failed" status by rule` }); continue; }
    // LegiScan lists history oldest first: on the same date, the one listed last is the latest.
    const last = recs.flatMap((r) => (r.history || []).map((h, i) => ({ ...h, i, url: r.state_link || r.url, bill: `${r.state} ${r.bill_number}` })).filter((h) => h.date && h.action)).sort((x, y) => x.date.localeCompare(y.date) || x.i - y.i).pop();
    if (!last) { skipped.push({ entry_key: e.key, why: 'its LegiScan record lists no actions' }); continue; }
    const s0 = (sessions[tb[0].state] || []).find((x) => String(x.session_id) === String(tb[0].session_id)), next = over[0];
    const said = `The ${s0.session_name} ended without the bill passing (LegiScan lists that session as adjourned and the ${next.session_name} as begun, checked ${longDate(runDate)}); the last action on the ${tb[0].state} Legislature's record is "${String(last.action).replace(/[\s.]+$/, '')}" (${longDate(last.date)}${tb.length > 1 ? `, ${last.bill}` : ''})`;
    if ((e.status_text || '').includes(`The ${s0.session_name} ended without the bill passing`)) continue;
    const before = { status: e.status, status_text: e.status_text };
    const kept2 = removeStale(e.status_text || '').replace(/[\s.;]+$/, '');
    e.status_text = kept2 ? `${kept2}. ${said}.` : `${said}.`;
    e.status = 'failed';
    (e.evidence = e.evidence || []).push({ field: 'status', quote: String(last.action), source_url: last.url });
    log.push({ entry_key: e.key, field: 'status', old: before.status, new: 'failed', date: runDate, run_id: runId, source_url: last.url, tier: 'A' });
    log.push({ entry_key: e.key, field: 'status_text', old: before.status_text, new: e.status_text, date: runDate, run_id: runId, source_url: last.url, tier: 'A' });
    if (!e.identifiers) e.identifiers = { session: tb[0].session_name, external: { legiscan: tb.map((x) => Number(x.bill_id)) } }; // a mixed entry must say how it is found
    if (e.origin === 'authored') { log.push({ entry_key: e.key, field: 'origin', old: 'authored', new: 'mixed', date: runDate, run_id: runId, source_url: last.url, tier: 'A' }); e.origin = 'mixed'; }
    e.verification = { method: 'agent', checked_at: at, run_id: runId, rounds: 0 };
    e.last_checked = runDate; e.last_changed = runDate;
    touched.push(e.key);
    applied.push({ entry_key: e.key, actions: [{ date: runDate, text: `The ${s0.session_name} ended without the bill passing` }], status: `${before.status} -> failed` });
  }
  if (touched.length) { advanceCutoff(out, runDate); out.changes.items.push(...log); }
  return { data: out, applied, skipped, touched, log, waiting };
}

// The step. legiscan: grabber/sources/legiscan.mjs createLegiScan(http, key). lsConfig: config/legiscan.json (monthly_cap).
export async function sessionEndRun({ legiscan, tracked, dataDir, docsDir = null, config = {}, lsConfig = {}, usageFile, now = new Date(), runId, dry = false, maxEntries = config.max_entries_changed_per_run ?? 15, log = () => {} }) {
  const runDate = new Date(now).toISOString().slice(0, 10);
  const before = loadData(dataDir), list = due(before, tracked, now);
  const sessions = {}, bills = {}, errors = [];
  let queries = 0;
  const cap = Number(lsConfig.monthly_cap || 10000), used = usageFile ? readUsage(usageFile, now).used : 0;
  const ask = async (fn) => { if (used + queries >= cap) throw new QuotaExceeded(cap); queries++; return fn(); };
  // the cut-off moving to the run date can change other entries too: those count toward the limit
  const moved = clone(before); advanceCutoff(moved, runDate);
  const dueKeys = new Set(list.map((e) => e.key));
  const byCutoff = moved.entries.filter((e, i) => !dueKeys.has(e.key) && JSON.stringify(e) !== JSON.stringify(before.entries[i])).length;
  let room = Math.max(0, Math.min(maxEntries, config.max_entries_changed_per_run ?? 15) - byCutoff);
  try {
    for (const st of [...new Set(list.flatMap((e) => tracked[e.key].bills.map((b) => b.state)))]) {
      try { sessions[st] = await ask(() => legiscan.sessions(st)); }
      catch (err) { if (err instanceof QuotaExceeded) throw err; if (!(err instanceof HttpError || err instanceof NetworkError) && !/^LegiScan /.test(err.message)) throw err; errors.push(`${st} sessions: ${String(err.message).slice(0, 120)}`); }
    }
    for (const e of list) {
      if (room <= 0) break;
      const tb = tracked[e.key].bills;
      if (!tb.every((b) => sessions[b.state] && sessionOver(sessions[b.state], b.session_id))) continue; // not over yet: no bill query
      try { for (const b of tb) bills[b.bill_id] = await ask(() => legiscan.bill(b.bill_id)); room--; }
      catch (err) { if (err instanceof QuotaExceeded) throw err; if (!(err instanceof HttpError || err instanceof NetworkError) && !/^LegiScan /.test(err.message)) throw err; errors.push(`${e.key}: ${String(err.message).slice(0, 120)}`); }
    }
  } catch (err) { if (!(err instanceof QuotaExceeded)) throw err; errors.push(`LegiScan's monthly limit (${cap}) is reached; the rest waits`); }
  if (usageFile && queries) addUsage(usageFile, now, queries); // a dry run's queries count too: LegiScan counts them
  const a = applySessionEnd({ data: before, tracked, sessions, bills, now, runId });
  const after = { ...a.data, relationships: before.relationships };
  const check = a.touched.length ? checkPublish({ before, after, runDate, maxEntries: config.max_entries_changed_per_run ?? 15 }) : { problems: [], changed: 0 };
  const L = [`End of state sessions ${runId} (${runDate}): ${list.length} pending state bill(s) whose session's last year is over, ${queries} LegiScan quer${queries === 1 ? 'y' : 'ies'}, ${a.touched.length} marked as died, ${a.waiting.length} still waiting for LegiScan to show the session over${dry ? ' [dry run, nothing written]' : ''}`];
  a.applied.forEach((x) => L.push(`- ${x.entry_key}: ${x.actions[0].text}`));
  a.skipped.filter((s) => !/not read this run/.test(s.why)).forEach((s) => L.push(`- not marked: ${s.entry_key}: ${s.why}`));
  errors.forEach((x) => L.push(`- not read: ${x}`));
  check.problems.forEach((p) => L.push(`- STOPPED: ${p}`));
  const summary = L.join('\n') + '\n';
  const base = { summary, result: a, check, errors, waiting: list.length, queries };
  if (check.problems.length) return { status: 'stopped', ...base };
  if (!dry && a.touched.length) { const keys = ['entries', 'news', 'site', 'changes']; writeData(dataDir, after, keys); if (docsDir) writeData(docsDir, after, keys); }
  if (list.length) log(summary.trim());
  return { status: a.touched.length ? (dry ? 'dry-run' : 'published') : 'quiet', ...base };
}
