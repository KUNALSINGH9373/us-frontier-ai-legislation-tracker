// End of a Congress: every bill still pending when a Congress ends dies (it can no longer pass; a new Congress starts its bills over).
// The 119th Congress ends at noon on 3 January 2027, and each later one two years after (20th Amendment; lib/congress.mjs). This step
// runs on every update and does nothing until a tracked federal bill's Congress has ended, so nothing is ever marked early.
//
// Code only, no AI. Each bill's own Congress.gov record is read first:
//   - a bill whose record shows it went to the President (presented, signed, became law, vetoed) is left alone: a bill presented before
//     the end can still be signed after it, and Tier A follows its record;
//   - a record that cannot be read is tried again next run (nothing is written for that entry);
//   - otherwise the entry becomes "failed", with a dated event and a status-text sentence, quoting the record's last action as evidence.
// An entry with no Congress.gov id cannot be checked against its record: it is reported, never guessed.
//   applyCongressEnd({ data, records, now, runId })   pure: the new data, the change log, what was skipped and why
//   congressEndRun({ congress, dataDir, docsDir, config, now, runId, dry, maxEntries, log })   reads the records, checks, writes
import { congressOn, congressOfId, congressOfEntry, ordinal } from '../lib/congress.mjs';
import { parseBillId, billUrl } from '../grabber/sources/congress.mjs';
import { HttpError, NetworkError, QuotaExceeded } from '../grabber/lib/http.mjs';
import { statusFor } from '../agents/rules.mjs';
import { longDate } from '../agents/derive.mjs';
import { checkPublish, removeStale } from './guards.mjs';
import { advanceCutoff } from './tier-a.mjs';
import { loadData, writeData } from './run.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
// The first year of the 1st Congress; Congress n begins on 3 January of FIRST_YEAR + 2(n-1) and ends when Congress n+1 begins.
const FIRST_YEAR = 1789;
export const congressEndDate = (n) => `${FIRST_YEAR + 2 * n}-01-03`;
// A record action that means the bill reached the President: it is not dead at the end of the Congress until its record says so.
export const TO_PRESIDENT = /presented to (the )?president|signed by (the )?president|became public law|became private law|vetoed|pocket veto|to president/i;

// The federal bills a Congress end can apply to: introduced bills (not drafts), still pending or stalled.
export const candidates = (data) => data.entries.filter((e) => e.level === 'federal' && e.type === 'bill' && ['pending', 'stalled'].includes(e.status));
const idsOf = (e) => (e.identifiers && e.identifiers.external && e.identifiers.external.congress_gov) || [];

// records: { entry key: [{ id: '119/hr/9925', url, actions: [{ actionDate, text }] }] } for the entries whose records were read.
// A bill title about AI (a sponsor's bill that could be the announced one: never marked "not introduced" while one exists).
export const AI_TITLE = /artificial intelligence|\bA\.?I\.?\b|machine learning|algorithm|automated|autonomous|frontier|chatbot|deepfake|neural/i;
export const bioguideUrl = (id) => `https://bioguide.congress.gov/search/bio/${id}`;

// announced: config/announced-bills.json "bills"; sponsored: { entry key: [{ bioguide, name, record_name, bills: [{ congress, type, number,
// title, introducedDate }] }] } for the announced entries whose sponsors' lists were read this run.
export function applyCongressEnd({ data, records = {}, announced = {}, sponsored = {}, now, runId }) {
  const out = clone(data), current = congressOn(now), runDate = new Date(now).toISOString().slice(0, 10);
  const at = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const log = [], applied = [], skipped = [], touched = [];
  for (const e of candidates(out)) {
    const ids = idsOf(e), cs = ids.map(congressOfId).filter(Boolean);
    const congress = cs.length ? Math.max(...cs) : congressOfEntry(e);
    if (!congress || congress >= current) continue; // its Congress has not ended (or is unknown: see below)
    if (!ids.length) {
      const cfg = announced[e.key];
      if (!cfg) { skipped.push({ entry_key: e.key, why: `the ${ordinal(congress)} Congress has ended, but the entry has no Congress.gov id and is not in config/announced-bills.json, so its record cannot be checked` }); continue; }
      const sp = sponsored[e.key];
      if (!sp || sp.length !== cfg.sponsors.length) { skipped.push({ entry_key: e.key, why: 'its sponsors\' Congress.gov lists were not read this run; tried again next run' }); continue; }
      const c = Number(cfg.congress || congress);
      const maybe = sp.flatMap((x) => x.bills.filter((b) => Number(b.congress) === c && String(b.introducedDate || '') >= cfg.announced && AI_TITLE.test(b.title || '')).map((b) => `${b.type} ${b.number} "${b.title}" (${x.name})`));
      if (maybe.length) { skipped.push({ entry_key: e.key, why: `possibly introduced as ${maybe.slice(0, 3).join('; ')}: not marked; the bill needs its Congress.gov id` }); continue; }
      const ended = congressEndDate(c), name = `${ordinal(c)} Congress`;
      const text = `Not introduced before the end of the ${name} (${longDate(ended)})`;
      if (e.events.some((v) => v.text === text)) continue;
      const before = { status: e.status, status_text: e.status_text }, url = bioguideUrl(sp[0].bioguide);
      e.events.push({ date: ended, precision: 'day', type: 'Vetoed / failed / rescinded', text, clause: text, inferred_year: false, scheduled: false, source_url: url });
      e.events.sort((x, y) => x.date.localeCompare(y.date));
      const add = `${text}: none of the bills its sponsors (${sp.map((x) => x.name).join(', ')}) introduced in that Congress after it was announced on ${longDate(cfg.announced)} is about AI, on their Congress.gov sponsored-legislation lists (checked ${longDate(runDate)})`;
      const kept = removeStale(e.status_text || '').replace(/[\s.;]+$/, '');
      e.status_text = kept ? `${kept}. ${add}.` : `${add}.`;
      e.status = 'failed';
      (e.evidence = e.evidence || []).push(...sp.map((x) => ({ field: 'status', quote: x.record_name, source_url: bioguideUrl(x.bioguide) })));
      log.push({ entry_key: e.key, field: 'status', old: before.status, new: 'failed', date: runDate, run_id: runId, source_url: url, tier: 'A' });
      log.push({ entry_key: e.key, field: 'status_text', old: before.status_text, new: e.status_text, date: runDate, run_id: runId, source_url: url, tier: 'A' });
      if (!e.identifiers) e.identifiers = { session: name }; // a mixed entry must say how it is found: an announced bill has only its Congress
      if (e.origin === 'authored') { log.push({ entry_key: e.key, field: 'origin', old: 'authored', new: 'mixed', date: runDate, run_id: runId, source_url: url, tier: 'A' }); e.origin = 'mixed'; }
      e.verification = { method: 'agent', checked_at: at, run_id: runId, rounds: 0 };
      e.last_checked = runDate; e.last_changed = runDate;
      touched.push(e.key);
      applied.push({ entry_key: e.key, actions: [{ date: ended, text }], status: `${before.status} -> failed` });
      continue;
    }
    const recs = records[e.key];
    if (!recs || recs.length !== ids.length) { skipped.push({ entry_key: e.key, why: 'its Congress.gov record was not read this run; tried again next run' }); continue; }
    const went = recs.find((r) => r.actions.some((a) => TO_PRESIDENT.test(a.text || '')));
    if (went) { skipped.push({ entry_key: e.key, why: `${went.id} went to the President ("${went.actions.find((a) => TO_PRESIDENT.test(a.text)).text}"); its record decides, not the end of the Congress` }); continue; }
    if (statusFor(e.section, 'failed') !== 'failed') { skipped.push({ entry_key: e.key, why: `section ${e.section} has no "failed" status by rule` }); continue; }
    // The record's last action, as evidence that nothing after it moved the bill.
    // Congress.gov lists actions newest first: on the same date, the one listed first is the latest.
    const last = recs.flatMap((r) => r.actions.map((a, i) => ({ ...a, i, url: r.url, id: r.id })).filter((a) => a.actionDate && a.text)).sort((x, y) => x.actionDate.localeCompare(y.actionDate) || y.i - x.i).pop();
    if (!last) { skipped.push({ entry_key: e.key, why: 'its Congress.gov record lists no actions' }); continue; }
    const ended = congressEndDate(congress), name = `${ordinal(congress)} Congress`;
    const text = `Died at the end of the ${name} (${longDate(ended)}) without becoming law`;
    if (e.events.some((v) => v.text === text)) continue;
    const before = { status: e.status, status_text: e.status_text };
    e.events.push({ date: ended, precision: 'day', type: 'Vetoed / failed / rescinded', text, clause: text, inferred_year: false, scheduled: false, source_url: last.url });
    e.events.sort((x, y) => x.date.localeCompare(y.date));
    const add = `${text}; the last action on its Congress.gov record is "${last.text.replace(/[\s.]+$/, '')}" (${longDate(last.actionDate)})`;
    const kept = removeStale(e.status_text || '').replace(/[\s.;]+$/, '');
    e.status_text = kept ? `${kept}. ${add}.` : `${add}.`;
    e.status = 'failed';
    (e.evidence = e.evidence || []).push({ field: 'status', quote: last.text, source_url: last.url });
    log.push({ entry_key: e.key, field: 'status', old: before.status, new: 'failed', date: runDate, run_id: runId, source_url: last.url, tier: 'A' });
    log.push({ entry_key: e.key, field: 'status_text', old: before.status_text, new: e.status_text, date: runDate, run_id: runId, source_url: last.url, tier: 'A' });
    if (e.origin === 'authored') { log.push({ entry_key: e.key, field: 'origin', old: 'authored', new: 'mixed', date: runDate, run_id: runId, source_url: last.url, tier: 'A' }); e.origin = 'mixed'; }
    e.verification = { method: 'agent', checked_at: at, run_id: runId, rounds: 0 };
    e.last_checked = runDate; e.last_changed = runDate;
    touched.push(e.key);
    applied.push({ entry_key: e.key, actions: [{ date: ended, text }], status: `${before.status} -> failed` });
  }
  if (touched.length) { advanceCutoff(out, runDate); out.changes.items.push(...log); }
  return { data: out, applied, skipped, touched, log };
}

// The entries whose Congress has ended and still wait to be marked (the only ones whose records are read).
export function due(data, now) {
  const current = congressOn(now);
  return candidates(data).filter((e) => { const cs = idsOf(e).map(congressOfId).filter(Boolean); const c = cs.length ? Math.max(...cs) : congressOfEntry(e); return c && c < current; });
}

// The step. congress: grabber/sources/congress.mjs createCongress(http). maxEntries: how many entries this step may still change in
// this run (the run's per-run limit minus what earlier steps changed); the rest are marked on the next run.
export async function congressEndRun({ congress, dataDir, docsDir = null, config = {}, announced = {}, now = new Date(), runId, dry = false, maxEntries = config.max_entries_changed_per_run ?? 15, log = () => {} }) {
  const runDate = new Date(now).toISOString().slice(0, 10);
  const before = loadData(dataDir), waiting = due(before, now);
  const records = {}, sponsored = {}, errors = [];
  let read = 0;
  // Moving the cut-off to the run date can also change other entries (a scheduled event now in the past): those count toward the limit.
  const moved = clone(before); advanceCutoff(moved, runDate);
  const waitKeys = new Set(waiting.map((e) => e.key));
  const byCutoff = moved.entries.filter((e, i) => !waitKeys.has(e.key) && JSON.stringify(e) !== JSON.stringify(before.entries[i])).length;
  const room = Math.max(0, Math.min(maxEntries, (config.max_entries_changed_per_run ?? 15)) - byCutoff);
  for (const e of waiting.filter((x) => idsOf(x).length || announced[x.key]).slice(0, room)) {
    const recs = [];
    try {
      if (!idsOf(e).length) { // an announced bill: its sponsors' own lists
        const sp = [];
        for (const s of announced[e.key].sponsors) { const m = await congress.getMember(s.bioguide); sp.push({ bioguide: s.bioguide, name: s.name, record_name: m.directOrderName || m.invertedOrderName, bills: (await congress.getSponsored(s.bioguide)).map((b) => ({ congress: b.congress, type: b.type, number: b.number, title: b.title, introducedDate: b.introducedDate })) }); }
        sponsored[e.key] = sp; read++; continue;
      }
      for (const id of idsOf(e)) {
        const b = parseBillId(id);
        if (!b) throw new Error(`not a Congress.gov bill id: ${id}`);
        recs.push({ id, url: billUrl(b), actions: (await congress.getActions(b)).map((a) => ({ actionDate: a.actionDate, text: a.text })) });
      }
      records[e.key] = recs; read++;
    } catch (err) {
      if (err instanceof QuotaExceeded) { errors.push(`${e.key}: request budget reached; the rest waits for the next run`); break; }
      if (err instanceof HttpError || err instanceof NetworkError) { errors.push(`${e.key}: ${String(err.message).slice(0, 120)}`); continue; }
      throw err;
    }
  }
  const a = applyCongressEnd({ data: before, records, announced, sponsored, now, runId });
  const after = { ...a.data, relationships: before.relationships };
  const check = a.touched.length ? checkPublish({ before, after, runDate, maxEntries: config.max_entries_changed_per_run ?? 15 }) : { problems: [], changed: 0 };
  const left = waiting.length - a.touched.length;
  const L = [`End of Congress ${runId} (${runDate}): ${waiting.length} pending federal bill(s) from an ended Congress, ${read} record(s) read, ${a.touched.length} marked as died${left ? `, ${left} not marked this run` : ''}${dry ? ' [dry run, nothing written]' : ''}`];
  a.applied.forEach((x) => L.push(`- ${x.entry_key}: ${x.actions[0].text}`));
  a.skipped.filter((s) => !/not read this run/.test(s.why)).forEach((s) => L.push(`- not marked: ${s.entry_key}: ${s.why}`));
  errors.forEach((x) => L.push(`- record not read: ${x}`));
  check.problems.forEach((p) => L.push(`- STOPPED: ${p}`));
  const summary = L.join('\n') + '\n';
  const base = { summary, result: a, check, errors, waiting: waiting.length };
  if (check.problems.length) return { status: 'stopped', ...base };
  if (!dry && a.touched.length) { const keys = ['entries', 'news', 'site', 'changes']; writeData(dataDir, after, keys); if (docsDir) writeData(docsDir, after, keys); }
  if (waiting.length) log(summary.trim());
  return { status: a.touched.length ? (dry ? 'dry-run' : 'published') : 'quiet', ...base };
}
