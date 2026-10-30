// Confirmation rules (news/CONTRACT.md "Event"). Pure functions over events and this run's RawItems; nothing here reads the network.
// An event is confirmed when an independent source listed in CONFIRMERS for its class/jurisdiction/official source has a record with the same
// jurisdiction + entry + class and a date within +-1 day (time zones), agreeing on the vote when both give one. When no independent source
// exists for that class, the official record alone confirms it after appearing unchanged in 2 consecutive runs. Any disagreement (other date,
// a conflicting class on the same day, a different vote) keeps it pending, is reported, and is never shown. Withdrawn/corrected official
// records never delete: status changes and a history entry is added.
import crypto from 'crypto';
import { billKey } from './factsheet.mjs';

export const BILL_CLASSES = new Set(['introduction', 'referral-committee', 'hearing-scheduled', 'hearing-held', 'committee-passage', 'committee-failure', 'passage', 'failure', 'amendment-passage', 'concurrence', 'enrolled', 'executive-receipt', 'executive-signature', 'executive-veto', 'became-law', 'veto-override-passage', 'withdrawal', 'carried-over', 'new-text-version', 'crs-report', 'cbo-estimate']);
const STATE_LEG = ['openstates', 'nysenate', 'state_legislature', 'legiscan'];
// Classes govinfo publishes for federal bills: bill text versions (BILLS), enrolled text, public laws (PLAW).
export const GOVINFO_CLASSES = new Set(['introduction', 'new-text-version', 'enrolled', 'became-law']);
export const STABLE_RUNS = 2;

// -> list of sources that can independently confirm an event whose official source is `official`. [] = none: 2 stable runs.
export function confirmersFor({ jurisdiction, class: cls }, official) {
  if (!cls) return [];
  if (BILL_CLASSES.has(cls) && jurisdiction && jurisdiction !== 'US') {
    if (cls === 'crs-report' || cls === 'cbo-estimate') return [];
    // LegiScan and Open States both copy the legislature's own site, so they are not truly independent (review r3 #9). Where the state's
    // own legislature API is read (New York: nysenate), it is the confirmer for the aggregators, and they confirm it.
    if (jurisdiction === 'NY') return official === 'nysenate' ? ['legiscan', 'openstates', 'state_legislature'] : ['nysenate'];
    return STATE_LEG.filter((s) => s !== official && s !== 'nysenate');
  }
  if (BILL_CLASSES.has(cls) && jurisdiction === 'US') {
    if (official === 'congress_gov' && GOVINFO_CLASSES.has(cls)) return ['govinfo'];
    if (official === 'govinfo' && GOVINFO_CLASSES.has(cls)) return ['congress_gov'];
    return [];
  }
  if (cls === 'executive-order' || cls === 'presidential-memo') return official === 'whitehouse' ? ['federal_register'] : [];
  return [];
}

// The table, for the report and docs.
export function confirmationTable() {
  return [
    { scope: 'state bill classes (CA, NY, ...)', official: 'legiscan', confirmed_by: 'openstates | nysenate (NY only) | state_legislature, same class, date +-1 day, same vote' },
    { scope: 'state bill classes', official: 'openstates | nysenate', confirmed_by: 'any other of legiscan / openstates / nysenate / state_legislature' },
    { scope: 'federal bill: introduction, new-text-version, enrolled, became-law', official: 'congress_gov', confirmed_by: 'govinfo (and the reverse)' },
    { scope: 'federal bill: other classes, crs-report, cbo-estimate', official: 'congress_gov / crs / cbo', confirmed_by: `none: official record unchanged in ${STABLE_RUNS} consecutive runs` },
    { scope: 'executive-order, presidential-memo', official: 'whitehouse', confirmed_by: 'federal_register (same class, date +-1)' },
    { scope: 'executive-order, presidential-memo', official: 'federal_register', confirmed_by: `none: ${STABLE_RUNS} stable runs (FR is itself the official record)` },
    { scope: 'agency rules/guidance, comment periods, nominations, court filings/rulings', official: 'federal_register / regulations_gov / courtlistener / agency', confirmed_by: `none: ${STABLE_RUNS} stable runs` },
  ];
}

const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
export const CONFLICT = [['passage', 'failure'], ['committee-passage', 'committee-failure'], ['executive-signature', 'executive-veto'], ['became-law', 'executive-veto']];
const conflicts = (a, b) => CONFLICT.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
const voteKey = (v) => (v && v.yes != null && v.no != null ? `${v.yes}-${v.no}` : null);
// Facts hash used for "unchanged": class, date and the official fields that matter (vote, chamber, committee, number).
export function factsHash(e) {
  const f = e.facts || {};
  return crypto.createHash('sha256').update(JSON.stringify([e.class, e.date, f.chamber || null, voteKey(f.vote), f.committee || null, f.number || null, f.document_number || null])).digest('hex').slice(0, 16);
}
const officialOf = (e) => (e.sources || []).find((s) => s.role === 'official') || {};

// Compare one event with one independent item: 'agree' | {conflict:'date'|'class'|'vote', ...} | null (unrelated).
export function compare(event, item) {
  if (item.facts && item.facts.withdrawn) return null; // a withdrawn record confirms nothing
  if (item.jurisdiction !== event.jurisdiction || (item.entry_id || null) !== (event.entry_id || null)) return null;
  if (event.facts && event.facts.chamber && item.facts && item.facts.chamber && event.facts.chamber !== item.facts.chamber) return null;
  // companion bills under one entry (review r5 M6): two numbers that differ are two bills, never a confirmation or a conflict
  const na = billKey(event.facts && event.facts.number, event.jurisdiction), nb = billKey(item.facts && item.facts.number, item.jurisdiction);
  if (na && nb && na !== nb) return null;
  // a scheduled hearing is dated the day each source first saw it: compared on its hearing day (review r5 H1)
  if (event.class === 'hearing-scheduled' && item.class === 'hearing-scheduled' && event.facts && event.facts.hearing_date && item.facts && item.facts.hearing_date) {
    return event.facts.hearing_date === item.facts.hearing_date ? 'agree' : { conflict: 'hearing_date', theirs: item.facts.hearing_date, ours: event.facts.hearing_date, source: item.source };
  }
  // a public law is matched on its number, not its date: govinfo's dateIssued is days after the enactment Congress.gov records (review r2 #9)
  if (event.class === 'became-law' && item.class === 'became-law' && event.facts && event.facts.public_law && item.facts && item.facts.public_law) {
    return event.facts.public_law === item.facts.public_law ? 'agree' : { conflict: 'public_law', theirs: item.facts.public_law, ours: event.facts.public_law, source: item.source };
  }
  const near = Math.abs(dayDiff(item.date, event.date)) <= 1;
  if (item.class === event.class) {
    if (!near) return { conflict: 'date', theirs: item.date, ours: event.date, source: item.source };
    const a = voteKey(event.facts && event.facts.vote); const b = voteKey(item.facts && item.facts.vote);
    if (a && b && a !== b) return { conflict: 'vote', theirs: b, ours: a, source: item.source };
    return 'agree';
  }
  if (near && conflicts(item.class, event.class)) return { conflict: 'class', theirs: item.class, ours: event.class, source: item.source };
  return null;
}

// Apply one run. events: Event[] (from events.mjs); items: every RawItem seen this run (all sources); okSources: sources whose fetch was ok
// this run (a record missing from a broken source proves nothing). Returns { events (new array, inputs untouched), report: [...] }.
export function applyRun(events, items, { at = new Date().toISOString(), okSources = null } = {}) {
  const report = [];
  // A fresh item of a record always wins over a carried copy (news/events.mjs `carried`: what a stored event already said); a cancellation
  // (facts.withdrawn) wins over both, whatever key its event has (review r5 H1).
  const byOfficialId = new Map();
  for (const it of items) {
    const k = `${it.source}|${it.source_id}`, had = byOfficialId.get(k);
    if (!had || (had.carried && !it.carried) || (it.facts && it.facts.withdrawn && !(had.facts && had.facts.withdrawn))) byOfficialId.set(k, it);
  }
  const out = events.map((ev0) => {
    const ev = { ...ev0, sources: [...(ev0.sources || [])], confirmations: [...(ev0.confirmations || [])], history: [...(ev0.history || [])], disagreements: [] };
    if (ev.status === 'withdrawn') return ev; // a corrected event is still checked: it can be withdrawn, disputed or confirmed again (review r3 #1)
    const off = officialOf(ev);
    const cur = byOfficialId.get(`${off.source}|${off.source_id}`);
    // Official record withdrawn, or now says another date/class: never delete, mark it.
    if (cur && cur.facts && cur.facts.withdrawn) {
      ev.history.push({ at, change: 'withdrawn', from: ev.status, to: 'withdrawn' }); ev.status = 'withdrawn';
      report.push({ key: ev.key, kind: 'withdrawn', source: off.source }); return ev;
    }
    if (cur && (cur.date !== ev.date || cur.class !== ev.class)) {
      const field = cur.date !== ev.date ? 'date' : 'class';
      // the record now gives another date or class: this event is superseded (withdrawn, with what changed); the new date or class is its own
      // event, which news/events.mjs renders into the same card with a note saying what changed (review r3 #2)
      ev.history.push({ at, change: field, from: ev[field], to: cur[field] }); ev.history.push({ at, change: 'status', from: ev.status, to: 'withdrawn', why: `superseded: the record now gives ${field} ${cur[field]}` }); ev.status = 'withdrawn'; ev.superseded = { field, to: cur[field] };
      report.push({ key: ev.key, kind: 'superseded', field, from: ev0[field], to: cur[field], source: off.source }); return ev;
    }
    // Stable-run counter: official record present and unchanged this run.
    const h = factsHash(ev);
    if (cur && factsHash(cur) === h) { ev.stable_runs = (ev.facts_hash === h ? (ev.stable_runs || 0) : 0) + 1; ev.facts_hash = h; }
    else if (!cur && (!okSources || okSources.includes(off.source))) { ev.stable_runs = 0; }

    const allowed = confirmersFor(ev, off.source);
    const agreedNow = new Set();
    for (const it of items) {
      if (!allowed.includes(it.source) || it.source === off.source) continue;
      const r = compare(ev, it);
      if (r === 'agree') {
        agreedNow.add(it.source);
        if (!ev.confirmations.includes(it.source)) ev.confirmations.push(it.source);
        if (!ev.sources.some((s) => s.source === it.source && s.source_id === it.source_id)) ev.sources.push({ role: 'confirmation', source: it.source, source_id: it.source_id, url: it.url, title: it.title, publisher: null, retrieved_at: it.retrieved_at, hash: factsHash(it) });
      } else if (r) ev.disagreements.push(r);
    }
    // Same-class record on another date only counts as a disagreement when no record of that source agrees (bills can be referred twice).
    ev.disagreements = ev.disagreements.filter((d) => d.conflict !== 'date' || !agreedNow.has(d.source));
    let next;
    if (ev.disagreements.length) next = 'pending';
    else if (allowed.length) next = ev.confirmations.some((c) => allowed.includes(c)) ? 'confirmed' : 'pending';
    else next = (ev.stable_runs || 0) >= STABLE_RUNS ? 'confirmed' : 'pending';
    if (ev.disagreements.length) report.push({ key: ev.key, kind: 'disagreement', details: ev.disagreements });
    if (ev.status === 'corrected' && next === 'confirmed') next = 'corrected'; // re-confirmed after a correction: stays corrected
    if (next !== ev.status) { ev.history.push({ at, change: 'status', from: ev.status, to: next }); if (next === 'confirmed') report.push({ key: ev.key, kind: 'confirmed', by: allowed.length ? ev.confirmations : `${STABLE_RUNS} stable runs` }); }
    ev.status = next;
    if (!ev.disagreements.length) delete ev.disagreements;
    return ev;
  });
  return { events: out, report };
}

// Only confirmed events may be shown.
export const showable = (e) => e.status === 'confirmed' && e.class != null && !(e.disagreements && e.disagreements.length);
