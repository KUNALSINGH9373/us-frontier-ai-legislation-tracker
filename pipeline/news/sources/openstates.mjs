// Open States v3 adapter (news/CONTRACT.md "Raw item"). Reads only tracked state bills (config/identifiers-legiscan.json), incrementally
// (updated_since), capped per run and paced to 1 request per second (Open States allows about 500/day). No key -> no items, never throws.
//   GET {base}/bills?jurisdiction=ca&session=20252026&identifier=SB 53&include=actions&include=votes&updated_since=YYYY-MM-DD (key in the X-API-KEY header)
//   GET {base}/events?jurisdiction=ca&bill=<ocd-bill id>&after=YYYY-MM-DD (same header)
// Action classifications are Open States' own vocabulary, mapped one-to-one onto the contract classes (no text guessing).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getJsonAny, isBillList } from './common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(HERE, '..', '..', 'config', 'news-sources.json');
export const IDS_PATH = path.join(HERE, '..', '..', 'config', 'identifiers-legiscan.json');
export function loadStructuredConfig(p = CONFIG_PATH) { try { return JSON.parse(fs.readFileSync(p, 'utf8')).structured || {}; } catch { return {}; } }

// Open States classification -> contract class. Order = priority when an action carries several classifications.
export const OS_CLASS = [
  ['became-law', 'became-law'], ['executive-veto', 'executive-veto'],
  ['executive-signature', 'executive-signature'], ['veto-override-passage', 'veto-override-passage'], ['executive-receipt', 'executive-receipt'],
  ['enrolled', 'enrolled'], ['concurrence', 'concurrence'], ['passage', 'passage'], ['failure', 'failure'],
  ['amendment-passage', 'amendment-passage'], ['committee-passage', 'committee-passage'], ['committee-passage-favorable', 'committee-passage'],
  ['committee-failure', 'committee-failure'], ['withdrawal', 'withdrawal'],
  ['carried-over', 'carried-over'], ['introduction', 'introduction'], ['filing', 'introduction'], ['referral-committee', 'referral-committee'],
];
const OS_MAP = new Map(OS_CLASS);
export function mapClassifications(list) {
  const set = new Set(list || []);
  if (set.has('executive-veto-line-item') || set.has('committee-passage-unfavorable')) return null; // not the bill's veto or passage (live check)
  for (const [k, v] of OS_CLASS) if (set.has(k)) return v;
  return null; // reading-1, reading-2, amendment-introduction, ... : recorded with class null, never shown
}
export const CHAMBER = { upper: 'upper', lower: 'lower', legislature: 'legislature', executive: 'executive' };

// YYYY-MM-DD accepted only if it is not after retrieval + 1 day (contract: reject future dates).
export function acceptDate(d, retrievedAt) {
  const day = String(d || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const limit = new Date(Date.parse(retrievedAt) + 86400000).toISOString().slice(0, 10);
  return day <= limit ? day : null;
}
export const normNumber = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]+)0+(?=\d)/, '$1');
const spaced = (n) => normNumber(n).replace(/^([A-Z]+)(\d+)$/, '$1 $2');

// Tracked state bills from config/identifiers-legiscan.json -> [{ entry_id, state, number, session_name, official_url }]
export function trackedBills(ids, { state = null } = {}) {
  const out = [];
  for (const [key, rec] of Object.entries((ids && ids.legiscan) || {})) {
    if (rec.status === 'rejected') continue;
    for (const b of rec.bills || []) if (b.state && b.state !== 'US' && (!state || b.state === state) && b.session_open !== false) out.push({ entry_id: key, state: b.state, number: b.number, session_name: b.session_name, official_url: b.official_url });
  }
  return out;
}
// "2025-2026 Regular Session" -> "20252026" (Open States session ids for CA); other states use the first year. Overridable per bill: os_session.
// Live check (29 Oct 2026): CA's id is "20252026"; other states' ids differ from LegiScan's session names (NY "2025-2026" returned
// nothing as "2025", NJ nothing as "2026"), so only CA is queried by session; elsewhere the bill is found by number and the session is
// checked on the result (sessionMatches). Overridable per bill: os_session.
export function osSession(b) {
  if (b.os_session) return b.os_session;
  const m = /(\d{4})-(\d{4})/.exec(b.session_name || '');
  return m && b.state === 'CA' ? `${m[1]}${m[2]}` : null;
}
// The Open States session for a session name: the one whose identifier or name shares the name's first year (or both years), or its
// ordinal ("104th General Assembly" -> "104th"). null when none or several match.
export function pickSession(list, sessionName) {
  const n = String(sessionName || ''), years = n.match(/\d{4}/g) || [], ord = (n.match(/\b(\d{2,3})(?:st|nd|rd|th)\b/) || [])[1];
  const hit = (x) => { const t = `${x.identifier} ${x.name}`; return years.length ? years.every((y) => t.includes(y)) || (years.length === 1 && t.includes(years[0])) : ord ? String(x.identifier).replace(/\D/g, '') === ord || new RegExp(`\\b${ord}(st|nd|rd|th)\\b`).test(t) : false; };
  let m = (list || []).filter(hit);
  if (m.length > 1 && years.length) { const both = m.filter((x) => years.every((y) => `${x.identifier} ${x.name}`.includes(y))); if (both.length) m = both; }
  if (m.length > 1) { const reg = m.filter((x) => /regular/i.test(x.name) && !/special|extraordinary/i.test(x.name)); if (reg.length === 1) m = reg; }
  return m.length === 1 ? m[0].identifier : null;
}
// A result's session agrees with the tracked bill's session name: a shared year ("2025-2026" ~ "2025"), or the same ordinal ("104th
// General Assembly" ~ "104th"). With nothing to compare, only a single result is taken.
export function sessionMatches(osSessionId, sessionName, results = 1) {
  const a = String(osSessionId || ''), n = String(sessionName || '');
  const years = n.match(/\d{4}/g) || [], ord = (n.match(/\b(\d{2,3})(?:st|nd|rd|th)\b/) || [])[1];
  if (years.length) return years.some((y) => a.includes(y)) || (/^(\d{4})(\d{4})$/.test(a) && years.includes(a.slice(0, 4)));
  if (ord) return a.replace(/\D/g, '') === ord;
  return results === 1;
}

// The roll call for a floor action: the same chamber, within a day (Open States stamps votes in UTC: a Sacramento evening vote is dated the
// next day), a floor motion (third reading, passage, concurrence, override), and exactly one such vote; otherwise no vote is stated
// (live check, 29 Oct 2026: the date-only match missed CA's Assembly passage of SB 53 and could pick a committee vote).
const FLOOR_MOTION = /\b(third reading|3rd reading|final passage|passage|concurrence|concur|override|final reading)\b/i;
// Review r5 L2: a vote with no organization, or another chamber's, is never used (and an action with no chamber gets no vote); the vote's
// result must agree with the action (pass for a passage, concurrence or override; fail for a failure); otherwise no vote is stated.
const RESULT_OK = { passage: /^pass/i, concurrence: /^pass/i, 'veto-override-passage': /^pass/i, failure: /^fail/i };
export function voteFacts(votes, date, chamber, cls = null) {
  if (!chamber) return null;
  const near = (d) => Math.abs((Date.parse(String(d).slice(0, 10)) - Date.parse(date)) / 864e5) <= 1;
  const c0 = (votes || []).filter((x) => near(x.start_date) && x.organization && x.organization.classification === chamber && FLOOR_MOTION.test(x.motion_text || ''));
  if (c0.length !== 1) return null;
  const v = c0[0];
  if (cls && RESULT_OK[cls] && !RESULT_OK[cls].test(String(v.result || ''))) return null;
  const c = (o) => ((v.counts || []).find((k) => k.option === o) || {}).value;
  return { yes: c('yes') ?? null, no: c('no') ?? null, result: v.result || null };
}

// One Open States bill record -> RawItems (pure).
export function billToItems(bill, tracked, retrievedAt) {
  const items = [];
  for (const [i, a] of (bill.actions || []).entries()) {
    const date = acceptDate(a.date, retrievedAt);
    if (!date) continue;
    const cls = mapClassifications(a.classification);
    const chamber = CHAMBER[a.organization && a.organization.classification] || null;
    const facts = { chamber, number: spaced(bill.identifier), title: bill.title, action: a.description, os_classification: a.classification || [] };
    if (cls === 'passage' || cls === 'failure' || cls === 'concurrence' || cls === 'veto-override-passage') { const v = voteFacts(bill.votes, date, chamber, cls); if (v) facts.vote = v; }
    if (cls && cls.startsWith('committee') && a.related_entities) { const c = a.related_entities.find((e) => e.entity_type === 'organization'); if (c) facts.committee = c.name; }
    items.push({
      source: 'openstates', source_id: `${bill.id}|${a.order ?? i}`, jurisdiction: tracked.state, entry_id: tracked.entry_id, class: cls, date, facts,
      url: bill.openstates_url || `https://openstates.org/`, title: `${spaced(bill.identifier)}: ${a.description}`, retrieved_at: retrievedAt,
    });
  }
  return items;
}

// One Open States event -> hearing RawItem (or null). Past and held -> hearing-held on its date; upcoming -> hearing-scheduled dated the day it
// was seen (the contract forbids future dates; the hearing day goes in facts.hearing_date). Cancelled -> withdrawn record. The event key is
// the hearing day + committee (news/events.mjs eventKey, review r5 H1), and a re-seen hearing keeps its first-seen date, so the seen day
// never makes a new event and a cancellation (same source_id) withdraws the one event.
// An event's agenda names the bill: a related entity whose bill id is this bill's, or whose name is its identifier.
export function agendaNames(ev, bill) {
  const want = normNumber(bill.identifier);
  return (ev.agenda || []).some((a) => (a.related_entities || []).some((r) => (r.entity_type === 'bill' || r.bill || r.bill_id) && ((r.bill && r.bill.id === bill.id) || r.bill_id === bill.id || (normNumber(r.name || (r.bill && r.bill.identifier) || '') === want && !!r.bill && r.bill.session === bill.session))));
}
export function eventToItem(ev, tracked, retrievedAt) {
  const start = String(ev.start_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const today = retrievedAt.slice(0, 10);
  const status = ev.status || 'tentative';
  const base = { source: 'openstates', jurisdiction: tracked.state, entry_id: tracked.entry_id, url: ev.openstates_url || 'https://openstates.org/', title: ev.name, retrieved_at: retrievedAt };
  const facts = { hearing_date: start, committee: (ev.participants || []).map((p) => p.name).find(Boolean) || null, location: ev.location && ev.location.name || null, event_status: status };
  if (status === 'cancelled') return { ...base, source_id: `${ev.id}|hearing-scheduled`, class: 'hearing-scheduled', date: today, facts: { ...facts, withdrawn: true } };
  if (start <= today && status === 'passed') return { ...base, source_id: `${ev.id}|hearing-held`, class: 'hearing-held', date: start, facts };
  if (start >= today) return { ...base, source_id: `${ev.id}|hearing-scheduled`, class: 'hearing-scheduled', date: today, facts };
  return null;
}

const q = (o) => Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// Open States allows about 500 requests a day (review F3): requests are counted per UTC day in the adapter state, and the adapter stops at
// daily_cap (400) whatever the per-run cap.
export const DAILY_CAP = 400;
export async function fetchItems({ http, env = process.env, since = null, state = {}, entries = null, config = null, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const nowFn = typeof now === 'function' ? now : () => (now instanceof Date ? now : new Date(now));
  const key = env && (env.OPENSTATES_API_KEY || env.PLURAL_API_KEY); // Open States is now Plural Policy; either name
  if (!key) return { items: [], health: { ok: false, count: 0, newest: null, errors: ['no key'] } };
  const cfg = { max_requests_per_run: 60, min_interval_ms: 1100, base: 'https://v3.openstates.org', ...((config || loadStructuredConfig()).openstates || {}) };
  let bills = isBillList(entries) ? entries : null;
  if (!bills) { try { bills = trackedBills(JSON.parse(fs.readFileSync(IDS_PATH, 'utf8'))); } catch { bills = []; } }
  const items = []; const errors = []; let used = 0; let truncated = false;
  const day = nowFn().toISOString().slice(0, 10), q0 = state && state.quota && state.quota.day === day ? state.quota.used || 0 : 0, dailyCap = cfg.daily_cap ?? DAILY_CAP;
  let dailyHit = false;
  const get = async (url) => {
    if (q0 + used >= dailyCap) { truncated = true; dailyHit = true; return null; }
    if (used >= cfg.max_requests_per_run) { truncated = true; return null; }
    if (used > 0 && cfg.min_interval_ms) await sleep(cfg.min_interval_ms);
    used++;
    for (let attempt = 0; ; attempt++) {
      try { return await getJsonAny(http, url, { 'X-API-KEY': key }); }
      catch (e) {
        // rate limited (HTTP 429): wait and try once more; anything else is recorded (key scrubbed)
        if (attempt === 0 && /HTTP 429/.test(String(e && e.message))) { await sleep(cfg.retry_after_ms ?? 15000); continue; }
        errors.push(String(e && e.message || e).split(key).join('***')); return null;
      }
    }
  };
  // Open States' session ids are its own (NJ "222", NY "2025-2026", CA "20252026", MA "194th"): read once per state from
  // /jurisdictions/{st}?include=legislative_sessions and kept in the adapter state, then matched to the tracked bill's session name.
  const sessions = { ...((state && state.sessions) || {}) };
  const sessionFor = async (b) => {
    if (b.os_session) return b.os_session;
    const juris = b.state.toLowerCase();
    if (!sessions[juris]) {
      const j = await get(`${cfg.base}/jurisdictions/${juris}?${q({ include: 'legislative_sessions' })}`);
      if (!j) return undefined;
      sessions[juris] = (j.legislative_sessions || []).map((x) => ({ identifier: x.identifier, name: x.name }));
    }
    return pickSession(sessions[juris], b.session_name);
  };
  for (const b of bills) {
    const retrieved = nowFn().toISOString();
    const juris = b.state.toLowerCase();
    const session = await sessionFor(b);
    if (session === undefined) { if (truncated) break; continue; }
    // no session matched: the bill is looked up by number alone and taken only when exactly one result has that number
    const res = await get(`${cfg.base}/bills?${q({ jurisdiction: juris, session, identifier: spaced(b.number), include: ['actions', 'votes'], updated_since: since ? String(since).slice(0, 10) : null })}`);
    if (!res) { if (truncated) break; continue; }
    const want = normNumber(b.number);
    for (const bill of res.results || []) {
      if (normNumber(bill.identifier) !== want) continue; // exact number only: SB 530 is never SB 53
      if (!session && (res.results || []).filter((x) => normNumber(x.identifier) === want).length !== 1) continue; // several sessions with this number and no session to tell them apart
      items.push(...billToItems(bill, b, retrieved));
      const evs = await get(`${cfg.base}/events?${q({ jurisdiction: juris, bill: bill.id, include: 'agenda', after: since ? String(since).slice(0, 10) : null })}`);
      if (!evs) { if (truncated) break; continue; }
      // the API does not filter events by ?bill= (live check, 29 Oct 2026: every bill got the whole jurisdiction's calendar): an event is
      // used only when its own agenda names this bill
      for (const ev of (evs.results || []).filter((e) => agendaNames(e, bill))) { const it = eventToItem(ev, b, retrieved); if (it) items.push(it); }
    }
    if (truncated) break;
  }
  if (truncated) errors.push(dailyHit ? `request cap: daily cap ${dailyCap} reached for ${day}; remaining bills next run` : `request cap ${cfg.max_requests_per_run} reached; remaining bills next run`);
  const newest = items.reduce((m, x) => (x.date > (m || '') ? x.date : m), null);
  return { items, health: { ok: errors.filter((e) => !e.startsWith('request cap')).length === 0, count: items.length, newest, errors, requests: used, truncated }, state: { sessions, quota: { day, used: q0 + used } } };
}
export { OS_MAP };
