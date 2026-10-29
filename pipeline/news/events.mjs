// The news event model (pipeline/news/CONTRACT.md). Only official structured records create events; a statement (a release: verbatim
// headline + link) only attaches to an event that already exists. Code only, no AI.
//   eventKey(x)                         `${jurisdiction}|${entry_id||'-'}|${class}|${date}` (+ `#<bill>` for a bill action with a number;
//                                       a scheduled hearing by its hearing day and committee, not the day seen)
//   checkItem(item, { now })            why a raw item is refused (bad shape, future date, date after retrieval, host not official), or null
//   upsertItems(state, items, opts)     new events, fact corrections, withdrawals (never a deletion), confirmations; returns what changed
//   (statements attach through news/attach.mjs attachStatements: one rule, several candidates are held)
//   renderNews(news, state, entries)    news.json with automated items appended alongside untouched hand-written items
//   checkNewsEvents({ before, after, state, entries, at })  the stop rules for that render
// State file: pipeline/state/news-events.json { _note, events: { key: Event } }.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EVENT_CLASSES } from './classify.mjs';
import { applyRun, showable, BILL_CLASSES } from './confirm.mjs';
import { longDate } from '../agents/derive.mjs';
import { templateFor, quoteOf } from './templates.mjs';
import { ownStageCode, billKey, displayNumber, skipsExecutive } from './factsheet.mjs';
import { newsKind } from '../publish/tier-a.mjs';
import { sourceConfig } from './sources/common.mjs';
import { guardClass } from './sources/openstates.mjs';

// Hosts an official record may link to. A raw item whose url is elsewhere is refused.
// Hosts an official record may link to, per source, from config/news-sources.json "structured" (review r3 #7: exact hosts, never a
// pattern): a host matches exactly or as a subdomain. State bill sources (LegiScan, Open States, NY Senate) use the state_legislature list.
const STATE_SOURCES = new Set(["legiscan", "openstates", "nysenate"]);
export function hostsFor(source) {
  const own = sourceConfig(source).hosts || [];
  return STATE_SOURCES.has(source) ? [...own, ...(sourceConfig("state_legislature").hosts || [])] : own;
}
export const hostOk = (h, source) => !!h && hostsFor(source).some((a) => h === a || h.endsWith("." + a));
const DAY = 864e5;
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } };
const dayGap = (a, b) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY;
const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const sortObj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortObj(o[k])])) : Array.isArray(o) ? o.map(sortObj) : o);
export const factsHash = (facts) => sha(sortObj(facts || {}));

// Which source is the official record when several give the same event first time: the body's own record before an aggregator.
export const OFFICIAL_ORDER = ['congress_gov', 'federal_register', 'whitehouse', 'courtlistener', 'nysenate', 'legiscan', 'openstates', 'govinfo'];
const rank = (s) => { const i = OFFICIAL_ORDER.indexOf(s); return i < 0 ? OFFICIAL_ORDER.length : i; };

// The key: jurisdiction|entry|class|date, except where the record has its own number, which is the same whatever date a source gives it
// (review r2 #4: the White House posting date, the Federal Register filing and signing dates are three dates for one order):
// executive orders and memos by EO number (or FR document number), agency documents by FR document number.
const EO_CLASSES = new Set(['executive-order', 'presidential-memo']);
const FR_CLASSES = new Set(['agency-rule-proposed', 'agency-rule-final', 'agency-guidance', 'comment-period-open', 'comment-period-closing']);
// A scheduled hearing (review r5 H1) is keyed by its hearing day and committee, never by the day it was seen (a new key every day let a
// carried copy mask a cancellation); without a hearing day, by the source's own id. A bill action with a number (review r5 M6) carries
// the normalised number: one entry may track several companion bills, and their same-day actions are separate events.
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const eventKey = (x) => {
  const f = x.facts || {};
  let id = EO_CLASSES.has(x.class) && f.eo_number ? `EO${f.eo_number}` : (EO_CLASSES.has(x.class) || FR_CLASSES.has(x.class)) && f.document_number ? `FR${f.document_number}` : x.date;
  if (x.class === 'hearing-scheduled') id = f.hearing_date ? `HD${f.hearing_date}${f.committee ? `@${slug(f.committee)}` : ''}` : `SRC${x.source || ''}:${x.source_id || x.date}`;
  const bk = BILL_CLASSES.has(x.class) ? billKey(f.number, x.jurisdiction) : null;
  return `${x.jurisdiction}|${x.entry_id || '-'}|${x.class}|${id}${bk ? `#${bk}` : ''}`;
};

// Chambers in one vocabulary (review r2 #5): Open States / NY Senate "upper"/"lower" -> Senate / House (Assembly where the lower house is
// called that), LegiScan "H"/"S"/"A" likewise.
const ASSEMBLY_STATES = new Set(['CA', 'NY', 'NV', 'NJ', 'WI']);
export function normChamber(c, jurisdiction) {
  if (c == null || c === '') return null;
  const t = String(c).trim().toLowerCase();
  if (['upper', 's', 'senate'].includes(t)) return 'Senate';
  if (['lower', 'h', 'house', 'a', 'assembly'].includes(t)) return ASSEMBLY_STATES.has(jurisdiction) ? 'Assembly' : 'House';
  if (t === 'legislature' || t === 'executive') return null;
  return String(c);
}

// Shape and vocabulary of one raw item, before anything else reads it. Returns { item } or { why } (refused). Never throws.
export function normalizeItem(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return { why: 'not an object' };
  if (typeof it.source !== 'string' || !it.source) return { why: 'no source' };
  if (it.source_id == null || (typeof it.source_id !== 'string' && typeof it.source_id !== 'number')) return { why: 'source_id is not a string' };
  if (it.class !== null && it.class !== undefined && typeof it.class !== 'string') return { why: 'class is not a string' };
  for (const f of ['jurisdiction', 'date', 'url', 'retrieved_at']) if (it[f] != null && typeof it[f] !== 'string') return { why: `${f} is not a string` };
  if (it.facts != null && (typeof it.facts !== 'object' || Array.isArray(it.facts))) return { why: 'facts is not an object' };
  // one FR document gives a rule and its comment-period events: each needs its own id (news/confirm.mjs matches an event by source_id)
  const source_id = String(it.source_id) + (it.source === 'federal_register' && /^comment-period-/.test(it.class || '') ? `#${it.class}` : '');
  // a public-inspection copy is the Federal Register's filing of a document it publishes later: never an event of its own (review r2 #4)
  if (/^pi:/.test(source_id) || (it.facts && it.facts.public_inspection)) return { why: 'public inspection copy: the published document is the record' };
  const facts = { ...(it.facts || {}) };
  if ('chamber' in facts) facts.chamber = normChamber(facts.chamber, it.jurisdiction);
  if (facts.public_law == null && typeof facts.action === 'string') { const m = /\bpublic law no:?\s*(\d+)-(\d+)/i.exec(facts.action); if (m) facts.public_law = `${m[1]}-${m[2]}`; }
  // review r6 #1: a resolution or constitutional amendment is never a law: its "became-law" (a chaptering) has no class, so no card
  let cls = it.class ?? null;
  if (cls === 'became-law' && facts.number && skipsExecutive(String(facts.number), it.jurisdiction)) cls = null;
  // review r7 M2/M3: the official words must agree with a withdrawal or concurrence label, whatever the source
  if (typeof facts.action === 'string') cls = guardClass(cls, facts.action);
  return { item: { ...it, source_id, class: cls, facts } };
}

// A White House posting of an order or memo carries no number: when a Federal Register document (this run or stored) has the same title,
// it takes that document's EO number and signing date, so the two are one event.
const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function linkWhiteHouse(items, state) {
  const fr = [...items, ...Object.values(state.events).filter(Boolean).map((e) => ({ ...e, source: (e.sources || []).find((s) => s.role === 'official')?.source }))]
    .filter((x) => x.source === 'federal_register' && EO_CLASSES.has(x.class) && x.facts && x.facts.title);
  return items.map((it) => {
    if (it.source !== 'whitehouse' || !EO_CLASSES.has(it.class) || (it.facts && it.facts.eo_number)) return it;
    const m = fr.find((x) => x.class === it.class && normTitle(x.facts.title) === normTitle(it.title || it.facts.title));
    if (!m) return it;
    return { ...it, date: m.facts.signing_date || m.date, facts: { ...it.facts, ...(m.facts.eo_number ? { eo_number: m.facts.eo_number } : {}), ...(m.facts.document_number ? { document_number: m.facts.document_number } : {}) } };
  });
}

export function emptyState() { return { _note: 'News events (news/events.mjs), from official records only. Never edit by hand; corrections are status changes, never deletions.', events: {} }; }
// An unreadable or malformed events file is moved aside (<file>.bad-<time>) and the run starts from an empty state: the news step never
// fails the run (review r2 #6). Entries that are not event objects are dropped. Returns the state; state.quarantined names the moved file.
export function loadEvents(file, { now = new Date() } = {}) {
  if (!file || !fs.existsSync(file)) return emptyState();
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); if (!s || typeof s !== 'object' || Array.isArray(s) || (s.events != null && (typeof s.events !== 'object' || Array.isArray(s.events)))) throw new Error('not an events file'); }
  catch (e) {
    const bad = `${file}.bad-${now.toISOString().replace(/[-:.]/g, '')}`;
    try { fs.renameSync(file, bad); } catch { /* left in place; overwritten on save */ }
    return { ...emptyState(), quarantined: bad, quarantine_why: String(e.message).slice(0, 200) };
  }
  const events = {};
  for (const [k, v] of Object.entries(s.events || {})) if (validEvent(v) && v.key === k) events[k] = v;
  const dropped = Object.keys(s.events || {}).length - Object.keys(events).length;
  return { ...emptyState(), ...s, events, ...(dropped ? { dropped_malformed: dropped } : {}) };
}
export const validEvent = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.key === 'string' && typeof v.jurisdiction === 'string' && typeof v.date === 'string'
  && Array.isArray(v.sources) && v.sources.every((s) => s && typeof s === 'object' && typeof s.source === 'string' && (typeof s.source_id === 'string' || typeof s.source_id === 'number'))
  && Array.isArray(v.history) && (v.class === null || typeof v.class === 'string') && v.facts && typeof v.facts === 'object';
export function saveEvents(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { quarantined, quarantine_why, dropped_malformed, ...keep } = state; // run notes, not state
  const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(keep, null, 1) + '\n'); fs.renameSync(t, file);
}

// A raw item the contract refuses, with why; null when it may be used.
export function checkItem(it, { now = new Date() } = {}) {
  if (!it || typeof it !== 'object') return 'not an object';
  for (const f of ['source', 'source_id', 'jurisdiction', 'date', 'url', 'retrieved_at']) if (!it[f]) return `no ${f}`;
  if (it.class !== null && !EVENT_CLASSES.includes(it.class)) return `class ${it.class} is not in the contract`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date) || Number.isNaN(Date.parse(it.date + 'T00:00:00Z'))) return `date ${it.date} is not YYYY-MM-DD`;
  const today = now.toISOString().slice(0, 10), got = String(it.retrieved_at).slice(0, 10);
  if (it.date > today) return `date ${it.date} is in the future`;
  if (dayGap(got, it.date) > 1) return `date ${it.date} is more than a day after retrieval (${got})`;
  const h = hostOf(it.url);
  if (!hostOk(h, it.source)) return `url host ${h} is not an official host of ${it.source}`;
  return null;
}

const officialSource = (it) => ({ role: 'official', source: it.source, source_id: it.source_id, ...(it.record ? { record: it.record } : {}), url: it.url, title: it.title || null, publisher: null, retrieved_at: it.retrieved_at, hash: sha({ facts: sortObj(it.facts || {}), url: it.url, title: it.title || null }) });
// Several items of one run with one key (two referrals on one day, a House and a Senate line for the same step): one event; the
// official words of each are kept in facts.actions, sorted, so the merged facts are the same every run.
function mergeGroup(items) {
  const xs = [...items].sort((a, b) => JSON.stringify(sortObj(a.facts)).localeCompare(JSON.stringify(sortObj(b.facts))) || a.source_id.localeCompare(b.source_id) || a.url.localeCompare(b.url));
  const first = xs[0];
  const actions = [...new Set(xs.map((x) => x.facts && x.facts.action).filter(Boolean))].sort();
  const facts = { ...first.facts, ...(actions.length > 1 ? { actions } : {}) };
  const seenSrc = new Set(), sources = [];
  for (const x of xs) { const k = `${x.source}|${x.source_id}|${x.url}`; if (!seenSrc.has(k)) { seenSrc.add(k); sources.push(officialSource(x)); } }
  return { first, facts, sources };
}

// state: loaded events; items: RawItem[] from the adapters this run. opts:
//   runId, now, since (YYYY-MM-DD: no new event older than this; existing ones are still corrected or withdrawn),
//   fetched: [{ source, record }] whose full record was read this run (an event of such a record that is no longer in it is withdrawn),
//   okSources: sources whose fetch was ok this run (news/confirm.mjs applyRun).
// This file creates events and records fact corrections; news/confirm.mjs applyRun owns confirmation (stable runs, independent
// confirmations, disagreements) and withdrawal (an item with facts.withdrawn). An event whose record was not read again this run (the
// grabber's cursor says the record did not change, or a docket read only for new entries) is carried into applyRun as unchanged.
// Returns { added, corrected, withdrawn, restored, confirmed, refused: [{ source, source_id, date, why }], report }.
export function upsertItems(state, items, { runId, now = new Date(), since = null, fetched = [], okSources = null } = {}) {
  const at = now.toISOString(), out = { added: [], corrected: [], withdrawn: [], restored: [], confirmed: [], refused: [], report: [] };
  // a stored entry that is not an event object is dropped (review r2 #6), never allowed to crash the step
  for (const [k, v] of Object.entries(state.events || {})) if (!validEvent(v) || v.key !== k) delete state.events[k];
  const groups = new Map(), good = [], norm = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const n = normalizeItem(raw);
    if (n.why) { out.refused.push({ source: raw && raw.source, source_id: raw && raw.source_id != null ? String(raw.source_id) : null, date: raw && raw.date, why: n.why }); continue; }
    norm.push(n.item);
  }
  // a bill action whose record gives no number joins the one numbered event of its entry/class/date (this run's or stored); with several
  // (companion bills) it keeps its own key: never guessed (review r5 M6). Numbered items are grouped first.
  const noNumber = (x) => BILL_CLASSES.has(x.class) && !billKey(x.facts && x.facts.number, x.jurisdiction);
  const keyOf = (it) => {
    const k = eventKey({ ...it, entry_id: it.entry_id || null });
    if (!noNumber(it) || it.class === 'hearing-scheduled') return k;
    const near = new Set([...groups.keys(), ...Object.keys(state.events)].filter((x) => x.startsWith(`${k}#`)));
    return near.size === 1 ? [...near][0] : k;
  };
  const checked = linkWhiteHouse(norm, state).filter((it0) => {
    const why = checkItem(it0, { now });
    if (why) out.refused.push({ source: it0.source, source_id: it0.source_id, date: it0.date, why });
    return !why;
  });
  for (const it0 of [...checked.filter((x) => !noNumber(x)), ...checked.filter(noNumber)]) {
    let it = it0;
    // confirmation-only records (govinfo) and statements never create or replace an event; they go to applyRun / attach.mjs only
    if (it.facts.role === 'confirmation' || it.facts.role === 'statement') { good.push(it); continue; }
    const k = keyOf(it);
    // a scheduled hearing seen again keeps the day it was first seen (review r5 H1): the record has not changed because a day passed
    if (it.class === 'hearing-scheduled' && state.events[k] && state.events[k].date !== it.date) it = { ...it, date: state.events[k].date };
    good.push(it);
    (groups.get(k) || groups.set(k, []).get(k)).push(it);
  }
  const present = new Set();
  for (const [key, g] of groups) {
    present.add(key);
    const ev = state.events[key];
    // one source is the event's official record (the existing one's, else by OFFICIAL_ORDER); records of other sources with the same key
    // only confirm or disagree (news/confirm.mjs), they never replace it
    const offSrc = ev ? (ev.sources.find((s) => s.role === 'official') || {}).source : [...new Set(g.map((x) => x.source))].sort((a, b) => rank(a) - rank(b))[0];
    const mine = g.filter((x) => x.source === offSrc);
    if (!mine.length) continue;
    const { first, facts, sources } = mergeGroup(mine), fh = factsHash(facts);
    if (!ev) {
      if (since && first.date < since) continue; // history before the window is never back-filled
      state.events[key] = { key, jurisdiction: first.jurisdiction, entry_id: first.entry_id || null, class: first.class, date: first.date, facts, sources,
        status: 'pending', confirmations: [], stable_runs: 0, first_seen: at, last_seen: at, facts_digest: fh,
        history: [{ at, change: 'created', from: null, to: 'pending' }], card: null };
      out.added.push(key);
      continue;
    }
    ev.last_seen = at;
    ev.sources = [...sources, ...ev.sources.filter((s) => s.role !== 'official')]; // statements and confirmations stay
    if (ev.status === 'withdrawn') {
      // back in the record: confirmed again by the same rules before the page changes; a card already shown stays as it is until then
      const to = 'pending';
      if (ev.shown) { ev.last_confirmed = { facts: ev.facts, facts_digest: ev.facts_digest, card: ev.card, status: 'withdrawn' }; ev.pending_correction = true; }
      ev.history.push({ at, change: 'back in the official record', from: 'withdrawn', to });
      ev.status = to; ev.stable_runs = 0; ev.facts = facts; ev.facts_digest = fh; ev.card = null;
      out.restored.push(key);
      continue;
    }
    if (ev.facts_digest !== fh) {
      ev.history.push({ at, change: 'facts', from: ev.facts, to: facts });
      // a changed official record goes through a new confirmation cycle (review r3 #1): the event is pending again, the page keeps the
      // last confirmed facts (last_confirmed) until the change is confirmed by the same rules as a new event; then it is 'corrected'
      if ((ev.status === 'confirmed' || ev.status === 'corrected') && !ev.last_confirmed) ev.last_confirmed = { facts: ev.facts, facts_digest: ev.facts_digest, card: ev.card, status: ev.status };
      if (ev.status === 'confirmed' || ev.status === 'corrected') { ev.history.push({ at, change: 'status', from: ev.status, to: 'pending', why: 'the official record changed: confirming the change' }); ev.status = 'pending'; ev.pending_correction = true; }
      ev.facts = facts; ev.facts_digest = fh; ev.card = null; ev.stable_runs = 0; delete ev.facts_hash;
    }
  }
  // The items applyRun compares each event's official record against: this run's, plus a carried copy for an event whose record was not
  // read again, plus a withdrawn marker for an event whose record was read in full and no longer shows it.
  const read = new Set(fetched.map((f) => `${f.source}|${f.record}`));
  const runItems = [...good];
  for (const ev of Object.values(state.events)) {
    if (present.has(ev.key) || ev.status === 'withdrawn') continue;
    const off = ev.sources.find((s) => s.role === 'official');
    if (!off) continue;
    const base = { source: off.source, source_id: off.source_id, jurisdiction: ev.jurisdiction, entry_id: ev.entry_id, class: ev.class, date: ev.date, url: off.url, title: off.title, retrieved_at: off.retrieved_at };
    // carried: a copy of what the event already says; a fresh item of the same record always wins over it (review r5 H1, confirm.mjs)
    if (off.record && read.has(`${off.source}|${off.record}`)) runItems.push({ ...base, facts: { ...ev.facts, withdrawn: true } });
    else runItems.push({ ...base, facts: ev.facts, carried: true });
  }
  const before = new Map(Object.values(state.events).map((e) => [e.key, e.status]));
  const r = applyRun(Object.values(state.events), runItems, { at, okSources });
  state.events = Object.fromEntries(r.events.map((e) => [e.key, e]));
  out.report = r.report;
  for (const e of r.events) {
    // a changed record now confirmed: corrected, and the page shows the new facts
    if (e.pending_correction && e.status === 'confirmed') {
      e.history.push({ at, change: 'status', from: 'confirmed', to: 'corrected', why: 'the change in the official record is confirmed' });
      e.status = 'corrected'; delete e.pending_correction; delete e.last_confirmed; out.corrected.push(e.key);
      continue;
    }
    if (e.pending_correction && e.status === 'withdrawn') { e.facts = e.last_confirmed.facts; e.facts_digest = e.last_confirmed.facts_digest; delete e.pending_correction; delete e.last_confirmed; } // the page keeps what it showed
    if (before.get(e.key) !== 'confirmed' && e.status === 'confirmed') out.confirmed.push(e.key);
    if (before.get(e.key) !== 'withdrawn' && e.status === 'withdrawn') { out.withdrawn.push(e.key); if (e.card && (e.card.written_by === 'ai' || e.card.written_by === 'bank')) e.card = null; }
  }
  return out;
}

// ---------- rendering ----------
// An event the page may show: a mapped class, a tracked entry, and confirmed or corrected; a withdrawn event only if it was shown before
// (it then stays, marked withdrawn).
export const visible = (ev) => !!ev.entry_id && (showable(ev) || ((ev.status === 'corrected' || ev.status === 'withdrawn' || ev.pending_correction) && !!ev.shown));

// The card: the writer's text (news/writer.mjs) when present, else the template. Template fields are always recomputed.
export function cardFor(ev, entry) {
  const t = templateFor(ev, entry);
  if (!t) return null;
  const c = ev.card || {};
  const ai = (c.written_by === 'ai' || c.written_by === 'bank') && c.headline && c.body && c.facts_hash === ev.facts_digest;
  return { headline: ai ? c.headline : t.headline, body: ai ? c.body : t.body, template_headline: t.headline, template_body: t.body, written_by: ai ? c.written_by : 'template', facts_hash: ev.facts_digest };
}

// Stores the template text on every event that has an entry (card.template_headline/template_body: news/writer.mjs falls back to them),
// and the code-computed milestone fact. An AI card stays only while its facts are current.
export function refreshCards(state, entries) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  for (const ev of Object.values(state.events)) {
    const entry = ev.entry_id && byKey.get(ev.entry_id);
    if (!entry || !ev.class) continue;
    const m = milestoneFor(ev, entries);
    if (m && ev.facts.milestone !== m) ev.facts = { ...ev.facts, milestone: m };
    const t = templateFor(ev, entry);
    if (!t) continue;
    const c = ev.card || {};
    const ai = (c.written_by === 'ai' || c.written_by === 'bank') && c.facts_hash === ev.facts_digest;
    ev.card = { headline: ai ? c.headline : t.headline, body: ai ? c.body : t.body, template_headline: t.headline, template_body: t.body, written_by: ai ? c.written_by : 'template', facts_hash: ai ? c.facts_hash : ev.facts_digest };
  }
}

// facts.milestone (contract): computed by code from tracker data only, never by AI. For a state law (became-law / executive-signature):
// "the Nth state" among states whose tracked entries in the same section are enacted, ordered by the enactment date in their events.
// null whenever any date is unknown (never guessed).
export function milestoneFor(ev, entries) {
  if (!['became-law', 'executive-signature'].includes(ev.class) || ev.jurisdiction === 'US') return null;
  const me = entries.find((e) => e.key === ev.entry_id);
  if (!me || !me.section || me.level !== 'state') return null;
  const firstBy = new Map();
  for (const e of entries.filter((x) => x.level === 'state' && x.section === me.section && x.status === 'enacted' && x.key !== me.key)) {
    const d = (e.events || []).filter((v) => v.type === 'Signed / enacted' && /^\d{4}-\d{2}-\d{2}$/.test(v.date)).map((v) => v.date).sort()[0];
    if (!d || !e.state) return null;
    if (!firstBy.has(e.state) || d < firstBy.get(e.state)) firstBy.set(e.state, d);
  }
  if (firstBy.has(ev.jurisdiction) && firstBy.get(ev.jurisdiction) <= ev.date) return null; // this state already had one
  const n = [...firstBy.values()].filter((d) => d < ev.date).length + 1;
  const ord = (k) => { const s = ['th', 'st', 'nd', 'rd'], v = k % 100; return k + (s[(v - 20) % 10] || s[v] || s[0]); };
  return `${ord(n)} state with an enacted law in this tracker section (${me.section})`;
}

const fmtDay = (iso) => iso.slice(0, 10);

// Equivalence groups (review r2 #3): one card per entry per group within a day either side; a later class in the group updates the card
// already on the page instead of adding one. The class with the higher rank is the one the card shows.
const GROUP = { 'executive-signature': ['law', 1], 'became-law': ['law', 2], 'concurrence': ['final', 1], 'enrolled': ['final', 2],
  'hearing-scheduled': ['hearing', 1], 'hearing-held': ['hearing', 2], 'comment-period-open': ['comment', 1], 'agency-rule-proposed': ['comment', 2] };
export function groupOf(ev) {
  const g = GROUP[ev.class];
  if (!g) return null;
  // law and final groups are per bill (review r7 L3): two bills under one entry get their own signature/law cards
  const bk = (g[0] === 'law' || g[0] === 'final') && ev.facts ? billKey(ev.facts.number, ev.jurisdiction) : null;
  return { name: g[0] === 'hearing' ? `hearing:${(ev.facts && ev.facts.hearing_date) || ev.date}` : `${g[0]}${bk ? `#${bk}` : ''}`, rank: g[1], exact: g[0] !== 'comment' }; // law and final: no date window (a chapter can follow the signature by weeks, review r3 #5)
}
export function sameGroup(a, b) {
  const ga = groupOf(a), gb = groupOf(b);
  if (!ga || !gb || ga.name !== gb.name || a.entry_id !== b.entry_id || a.jurisdiction !== b.jurisdiction) return false;
  return ga.exact || Math.abs(dayGap(a.date, b.date)) <= 1;
}
// The event a card shows: the owner, or the highest-ranked showable event merged into it. A withdrawn owner with a showable successor (the
// same action, re-dated or re-classed in the record: review r3 #2) shows the successor.
export function displayEvent(ev, state) {
  const merged = ((ev.merged || []).map((k) => state && state.events[k]).filter((e) => e && (showable(e) || e.status === 'corrected')));
  const pool = ev.status === 'withdrawn' && merged.length ? merged : [ev, ...merged];
  return pool.sort((a, b) => ((groupOf(b) || {}).rank || 0) - ((groupOf(a) || {}).rank || 0))[0];
}
// While a changed record is being confirmed, the card keeps the facts last confirmed (review r3 #1).
const shownView = (ev) => (ev.pending_correction && ev.last_confirmed ? { ...ev, facts: ev.last_confirmed.facts, facts_digest: ev.last_confirmed.facts_digest, card: ev.last_confirmed.card, status: ev.last_confirmed.status } : ev);
const CLASS_WORDS = (c) => String(c).replace(/-/g, ' ');

// The stage badge (review r6): only what the card's own event class proves by itself (news/factsheet.mjs ownStageCode), from the
// record's own number; never inferred from other events; omitted otherwise. No next step is ever rendered.
const stageField = (ev) => { const n = ev.facts && ev.facts.number ? displayNumber(String(ev.facts.number), ev.jurisdiction) : null; const s = ownStageCode(ev.class, ev.jurisdiction, n); return s ? { stage: s } : {}; };

// One news.json item for one event (backwards compatible; see the contract and the site agent's additions). With state, an event that
// owns merged events shows the highest-ranked of them, under its own event_key.
export function renderItem(owner, entry, { at, state = null } = {}) {
  // a merged event that cannot be written (review r6: e.g. a became-law whose law wording is not valid) leaves the card on its own event
  let disp = displayEvent(owner, state);
  if (disp !== owner && !cardFor(shownView(disp), entry)) disp = owner;
  const ev = shownView(disp);
  const card = cardFor(ev, entry);
  if (!card) return null;
  const off = ev.sources.find((s) => s.role === 'official');
  const statements = [owner, ...(disp === owner ? [] : [disp])].flatMap((e) => e.sources.filter((s) => s.role === 'statement')).map((s) => ({ t: s.title, u: s.url, publisher: s.publisher || null }));
  const quote = quoteOf(ev.facts).quote;
  const corr = ev.history.filter((h) => h.to === 'corrected' || h.to === 'withdrawn').pop();
  let check = card.written_by === 'bank' ? `From the official record (${off ? off.source : 'official'}), written by code from its fields with fixed wording.` : card.written_by === 'ai' ? `From the official record (${off ? off.source : 'official'}): written from its fields by the AI writer, every fact checked by code and a second reader.` : `From the official record (${off ? off.source : 'official'}), written by code from its fields; the official words are quoted as recorded.`;
  let note = null;
  // the record re-dated or re-classed the action this card was first published for: say exactly what changed
  const moved = owner.status === 'withdrawn' && disp !== owner && owner.shown;
  if (moved) {
    const at2 = fmtDay((owner.history.filter((h) => h.to === 'withdrawn').pop() || { at: disp.first_seen || '' }).at || '');
    const what = disp.date !== owner.date ? `now dates this ${longDate(disp.date)} (first published as ${longDate(owner.date)})` : disp.class !== owner.class ? `now records this as ${CLASS_WORDS(disp.class)} (first published as ${CLASS_WORDS(owner.class)})` : 'changed this action';
    check += ` Correction (${at2}): the official record ${what}.`;
    note = `Corrected: the official record ${what}.`;
  } else if (ev.status === 'corrected' && corr) { check += ` Correction (${fmtDay(corr.at)}): the official record changed after this item was first published; it now reads as above.`; note = 'Corrected from the official record.'; }
  else if (ev.status === 'withdrawn' && corr) { check += ` Correction (${fmtDay(corr.at)}): the official record no longer shows this action.`; note = 'The official record no longer shows this action.'; }
  if (disp.pending_correction && disp.last_confirmed) note = 'The official record has changed; the change is being confirmed and is not shown yet.';
  const status = moved ? 'corrected' : ev.status;
  const hist = disp === owner ? owner.history : [...owner.history, ...disp.history.map((h) => ({ ...h, change: `${disp.class}: ${h.change}` }))];
  return {
    date: ev.date, kind: ev.class.startsWith('court-') ? 'litigation' : newsKind(entry),
    title: status === 'withdrawn' ? `Withdrawn: ${card.headline}`.slice(0, 140) : card.headline, body: card.body,
    links: [{ t: `${entry.short_name || entry.title} — official record`, u: off.url }, ...statements.map((s) => ({ t: s.publisher ? `${s.publisher}: ${s.t}` : s.t, u: s.u }))],
    check, tracker: owner.entry_id, origin: 'automated',
    verification: { method: 'official-record', checked_at: at || ev.last_seen },
    evidence: [{ field: 'body', quote: quote.length >= 8 ? quote : String(off.title || quote), source_url: off.url }],
    event_key: owner.key, class: ev.class, status, jurisdiction: ev.jurisdiction, statements,
    ...stageField(ev),
    ...(ev.facts.comments_close ? { comments_close: ev.facts.comments_close } : {}),
    history: hist.map((h) => ({ at: h.at, change: h.change, ...(typeof h.from === 'string' || h.from === null ? { from: h.from } : {}), ...(typeof h.to === 'string' || h.to === null ? { to: h.to } : {}) })),
    ...(note ? { status_note: note } : {})
  };
}

// news: news.json as it is; state: events; entries: the entries list. Items without event_key are never touched, nor reordered.
// Items with event_key are re-rendered in place; new visible events are appended, except:
//   - an entry and date the page already covers another way (by hand, or Lane 1's official-action news);
//   - an event in the same equivalence group as a card already on the page (or added this run): merged into that card (review r2 #3);
//   - an event dated more than maxAgeDays before the run (the backlog when publishing is first switched on): timeline only (review r2 #11).
// Returns { news, added: [key], updated: [key], merged: [[key, into]], held: [{ key, why }], state (the events with this render's merges) }.
export function renderNews(news, stateIn, entries, { at, maxAgeDays = 14 } = {}) {
  // merges are made on a copy: the caller keeps them (r.state) only when the render is written
  const state = { ...stateIn, events: JSON.parse(JSON.stringify(stateIn.events)) };
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const out = { ...news, items: [] }, added = [], updated = [], held = [], merged = [];
  const today = (at || new Date().toISOString()).slice(0, 10);
  const owners = []; // events that own a card on the page (or added this run)
  for (const n of news.items) {
    if (!n.event_key) { out.items.push(n); continue; }
    const ev = state.events[n.event_key];
    if (ev) owners.push(ev);
    out.items.push(n);
  }
  // items written another way (by hand, or Lane 1's official-action news), by entry: an event within a day of one is not added (review r3 #4)
  const otherItems = news.items.filter((n) => !n.event_key && n.tracker);
  const nearOther = (ev) => otherItems.some((n) => n.tracker === ev.entry_id && Math.abs(dayGap(n.date, ev.date)) <= 1);
  const onPage = new Set(owners.map((e) => e.key));
  const evs = Object.values(state.events).filter((e) => visible(e) && !onPage.has(e.key) && e.status !== 'withdrawn')
    .sort((a, b) => a.date.localeCompare(b.date) || ((groupOf(a) || {}).rank || 0) - ((groupOf(b) || {}).rank || 0) || a.key.localeCompare(b.key));
  // a successor: the same action of the same record, re-dated or re-classed, after the card's own event was withdrawn (review r3 #2)
  const offOf = (e) => e.sources.find((s) => s.role === 'official') || {};
  const successorOf = (o, ev) => o.status === 'withdrawn' && o.shown && o.entry_id === ev.entry_id && o.jurisdiction === ev.jurisdiction && offOf(o).source === offOf(ev).source
    && ((offOf(o).record && offOf(o).record === offOf(ev).record) || offOf(o).source_id === offOf(ev).source_id || (o.superseded && ev[o.superseded.field] === o.superseded.to))
    && (o.class === ev.class || o.date === ev.date) && ev.first_seen >= (o.first_seen || '');
  for (const ev of evs) {
    const entry = byKey.get(ev.entry_id);
    if (!entry || entry.section === 'J') { held.push({ key: ev.key, why: 'not a tracked entry' }); continue; }
    const owner = owners.find((o) => o.key !== ev.key && (sameGroup(o, ev) || successorOf(o, ev)));
    if (owner) {
      if (!(owner.merged || []).includes(ev.key)) { owner.merged = [...(owner.merged || []), ev.key]; ev.merged_into = owner.key; }
      merged.push([ev.key, owner.key]); held.push({ key: ev.key, why: successorOf(owner, ev) ? 'the corrected form of a card on the page: merged into it' : `merged into the card for ${owner.class}` }); continue;
    }
    if ((ev.merged_into && state.events[ev.merged_into])) { held.push({ key: ev.key, why: 'merged into another card' }); continue; }
    if (dayGap(ev.date, today) > maxAgeDays) { held.push({ key: ev.key, why: `older than ${maxAgeDays} days: timeline only` }); continue; }
    if (nearOther(ev)) { held.push({ key: ev.key, why: 'the page already has an item on this entry within a day' }); continue; }
    // one card per entry and date, against every event card on the page, not only this run's (review r3 #6)
    const twin = owners.find((o) => o.key !== ev.key && o.entry_id === ev.entry_id && o.date === ev.date && o.status !== 'withdrawn');
    if (twin) { held.push({ key: ev.key, why: 'an event card on this entry and date is already on the page' }); continue; }
    const item = renderItem(ev, entry, { at, state });
    if (!item) { held.push({ key: ev.key, why: 'the template needs a fact the record does not give' }); continue; }
    out.items.push(item); added.push(ev.key); owners.push(ev);
  }
  // every event card on the page is re-rendered (after merges), in place
  out.items = out.items.map((n) => {
    if (!n.event_key) return n;
    const isNew = added.includes(n.event_key);
    if (isNew && !(state.events[n.event_key].merged || []).length) return n;
    const ev = state.events[n.event_key], entry = ev && byKey.get(ev.entry_id);
    const fresh = ev && entry ? renderItem(ev, entry, { at: n.verification && n.verification.checked_at, state }) : null;
    if (!fresh) { held.push({ key: n.event_key, why: 'event or entry missing: item left as it was' }); return n; }
    if (JSON.stringify(fresh) === JSON.stringify(n)) return n;
    fresh.verification.checked_at = at || fresh.verification.checked_at; if (!isNew) updated.push(ev.key);
    return fresh;
  });
  return { news: out, added, updated, merged, held, state };
}

// Marks rendered events as shown (after a successful write), so a later withdrawal stays on the page as a correction.
export function markShown(state, keys, at) { for (const k of keys) if (state.events[k] && !state.events[k].shown) state.events[k].shown = at; }

// The stop rules for an event render: hand-written and Lane 1 items exactly as before and in order; every automated event item exactly
// the render of its event; entries untouched; nothing removed.
export function checkNewsEvents({ before, after, state, entries, at }) {
  const problems = [];
  const plainB = before.news.items.filter((n) => !n.event_key), plainA = after.news.items.filter((n) => !n.event_key);
  if (JSON.stringify(plainB) !== JSON.stringify(plainA)) problems.push('news items not written by the event model changed');
  const keysB = before.news.items.filter((n) => n.event_key).map((n) => n.event_key), keysA = new Set(after.news.items.filter((n) => n.event_key).map((n) => n.event_key));
  keysB.filter((k) => !keysA.has(k)).forEach((k) => problems.push(`news item ${k} was removed (corrections never delete)`));
  const byKey = new Map(entries.map((e) => [e.key, e]));
  for (const n of after.news.items.filter((x) => x.event_key)) {
    const ev = state.events[n.event_key], entry = ev && byKey.get(ev.entry_id);
    if (!ev || !entry) { if (!keysB.includes(n.event_key)) problems.push(`news item ${n.event_key}: no such event or entry`); continue; }
    if (!visible(ev)) problems.push(`news item ${n.event_key}: event is ${ev.status}, not publishable`);
    const want = renderItem(ev, entry, { at: n.verification.checked_at, state });
    if (JSON.stringify(want) !== JSON.stringify(n)) problems.push(`news item ${n.event_key}: not the render of its event` + (process.env.DBGR ? JSON.stringify([want, n]) : ""));
    if (n.origin !== 'automated' || n.verification.method !== 'official-record') problems.push(`news item ${n.event_key}: not marked automated / official-record`);
    if (!n.links.some((l) => n.evidence.every((e) => e.source_url === l.u))) problems.push(`news item ${n.event_key}: evidence is not from its own linked record`);
  }
  if (JSON.stringify(before.entries) !== JSON.stringify(after.entries)) problems.push('entries changed: the news step may not change them');
  return problems;
}
