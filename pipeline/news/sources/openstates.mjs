// Open States v3 adapter (news/CONTRACT.md "Raw item"). Reads only tracked state bills (config/identifiers-legiscan.json), incrementally
// (updated_since), capped per run and paced to 1 request per second (Open States allows about 500/day). No key -> no items, never throws.
//   GET {base}/bills?jurisdiction=ca&session=20252026&identifier=SB 53&include=actions&include=votes&updated_since=YYYY-MM-DD&apikey=K
//   GET {base}/events?jurisdiction=ca&bill=<ocd-bill id>&after=YYYY-MM-DD&apikey=K
// Action classifications are Open States' own vocabulary, mapped one-to-one onto the contract classes (no text guessing).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(HERE, '..', '..', 'config', 'news-sources.json');
export const IDS_PATH = path.join(HERE, '..', '..', 'config', 'identifiers-legiscan.json');
export function loadStructuredConfig(p = CONFIG_PATH) { try { return JSON.parse(fs.readFileSync(p, 'utf8')).structured || {}; } catch { return {}; } }

// Open States classification -> contract class. Order = priority when an action carries several classifications.
export const OS_CLASS = [
  ['became-law', 'became-law'], ['executive-veto-line-item', 'executive-veto'], ['executive-veto', 'executive-veto'],
  ['executive-signature', 'executive-signature'], ['veto-override-passage', 'veto-override-passage'], ['executive-receipt', 'executive-receipt'],
  ['enrolled', 'enrolled'], ['concurrence', 'concurrence'], ['passage', 'passage'], ['failure', 'failure'],
  ['amendment-passage', 'amendment-passage'], ['committee-passage', 'committee-passage'], ['committee-passage-favorable', 'committee-passage'],
  ['committee-passage-unfavorable', 'committee-passage'], ['committee-failure', 'committee-failure'], ['withdrawal', 'withdrawal'],
  ['carried-over', 'carried-over'], ['referral-committee', 'referral-committee'], ['introduction', 'introduction'], ['filing', 'introduction'],
];
const OS_MAP = new Map(OS_CLASS);
export function mapClassifications(list) {
  const set = new Set(list || []);
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
export function osSession(b) {
  if (b.os_session) return b.os_session;
  const m = /(\d{4})-(\d{4})/.exec(b.session_name || '');
  if (!m) return null;
  return b.state === 'CA' ? `${m[1]}${m[2]}` : m[1];
}

export function voteFacts(votes, date, chamber) {
  const v = (votes || []).find((x) => String(x.start_date || '').slice(0, 10) === date && (!chamber || !x.organization || x.organization.classification === chamber));
  if (!v) return null;
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
    if (cls === 'passage' || cls === 'failure' || cls === 'concurrence' || cls === 'veto-override-passage') { const v = voteFacts(bill.votes, date, chamber); if (v) facts.vote = v; }
    if (cls && cls.startsWith('committee') && a.related_entities) { const c = a.related_entities.find((e) => e.entity_type === 'organization'); if (c) facts.committee = c.name; }
    items.push({
      source: 'openstates', source_id: `${bill.id}|${a.order ?? i}`, jurisdiction: tracked.state, entry_id: tracked.entry_id, class: cls, date, facts,
      url: bill.openstates_url || `https://openstates.org/`, title: `${spaced(bill.identifier)}: ${a.description}`, retrieved_at: retrievedAt,
    });
  }
  return items;
}

// One Open States event -> hearing RawItem (or null). Past and held -> hearing-held on its date; upcoming -> hearing-scheduled dated the day it
// was seen (the contract forbids future dates; the hearing day goes in facts.hearing_date). Cancelled -> withdrawn record.
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

export async function fetchItems({ http, env = process.env, since = null, state = {}, entries = null, config = null, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const key = env && (env.OPENSTATES_API_KEY || env.PLURAL_API_KEY); // Open States is now Plural Policy; either name
  if (!key) return { items: [], health: { ok: false, count: 0, newest: null, errors: ['no key'] } };
  const cfg = { max_requests_per_run: 60, min_interval_ms: 1100, base: 'https://v3.openstates.org', ...((config || loadStructuredConfig()).openstates || {}) };
  let bills = entries;
  if (!bills) { try { bills = trackedBills(JSON.parse(fs.readFileSync(IDS_PATH, 'utf8'))); } catch { bills = []; } }
  const items = []; const errors = []; let used = 0; let truncated = false;
  const get = async (url) => {
    if (used >= cfg.max_requests_per_run) { truncated = true; return null; }
    if (used > 0 && cfg.min_interval_ms) await sleep(cfg.min_interval_ms);
    used++;
    try { return await http.getJson(url); } catch (e) { errors.push(String(e && e.message || e).split(key).join('***')); return null; }
  };
  for (const b of bills) {
    const retrieved = now().toISOString();
    const juris = b.state.toLowerCase();
    const res = await get(`${cfg.base}/bills?${q({ jurisdiction: juris, session: osSession(b), identifier: spaced(b.number), include: ['actions', 'votes'], updated_since: since ? String(since).slice(0, 10) : null, apikey: key })}`);
    if (!res) { if (truncated) break; continue; }
    const want = normNumber(b.number);
    for (const bill of res.results || []) {
      if (normNumber(bill.identifier) !== want) continue; // exact number only: SB 530 is never SB 53
      items.push(...billToItems(bill, b, retrieved));
      const evs = await get(`${cfg.base}/events?${q({ jurisdiction: juris, bill: bill.id, after: since ? String(since).slice(0, 10) : null, apikey: key })}`);
      if (!evs) { if (truncated) break; continue; }
      for (const ev of evs.results || []) { const it = eventToItem(ev, b, retrieved); if (it) items.push(it); }
    }
    if (truncated) break;
  }
  if (truncated) errors.push(`request cap ${cfg.max_requests_per_run} reached; remaining bills next run`);
  const newest = items.reduce((m, x) => (x.date > (m || '') ? x.date : m), null);
  return { items, health: { ok: errors.filter((e) => !e.startsWith('request cap')).length === 0, count: items.length, newest, errors, requests: used, truncated } };
}
export { OS_MAP };
