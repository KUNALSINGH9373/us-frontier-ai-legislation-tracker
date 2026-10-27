// Tier A: official facts, written by code. For every "material" item on a tracked entry this applies only what the
// official record states exactly: new dated actions (as events and in the status text), a status the record proves
// (became law, vetoed) and the checked / changed dates. It never touches mechanism, thresholds, penalties or any other
// reading field; those are Tier B (AI, behind the accuracy gate). No AI is used here.
// Pure: takes the current data and a run, returns new data plus the change log. Writing and stop rules are elsewhere.
import { longDate, eventFor } from '../agents/derive.mjs';
import { datesMentioned } from '../compare/congress.mjs';
import { eventType as stateEventType } from '../grabber/sources/legiscan.mjs';

const FULL_MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const clone = (x) => JSON.parse(JSON.stringify(x));
const SOURCE_NAME = { congress_gov: 'Congress.gov', federal_register: 'the Federal Register' };
// State bills: the legislature's own record (found through LegiScan; the link is the legislature's page).
const sourceName = (item, e) => SOURCE_NAME[item.source] || (item.source === 'legiscan' ? `${e.state || 'state'} Legislature` : item.source);
// Only these reason kinds are facts Tier A may write. Anything else is reported and left for a person or Tier B.
const TIER_A = { congress_gov: ['new_action', 'status_change'], legiscan: ['new_action', 'status_change'] };

export const newsKind = (e) => (e.level === 'state' ? 'state' : e.section === 'G.2' ? 'litigation' : /^G/.test(e.section) && e.section !== 'G.3' ? 'executive' : 'federal');
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().replace(/(?<!\b[a-z]\.[a-z])\.$/i, ''); // keep "4 p.m."
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// "2026-09-30: Committee on ... Hearings held."  ->  { date, text }
// "2026-04-16: TN HB1898: Passed House"  ->  { date, text: the official words, label: with the bill number when given }
const actionOf = (reason) => { const m = /^(\d{4}-\d{2}-\d{2}):\s*(.+)$/s.exec(reason.detail || ''); return m ? { date: m[1], text: clean(reason.api_value || m[2]), label: clean(m[2]) } : null; };
// The stored record is JSON, so quotes and slashes in the action text are escaped there.
const inRaw = (raw, t) => raw.includes(t) || raw.includes(JSON.stringify(t).slice(1, -1));

export function applyTierA({ data, diff, changeset, readRaw, runId, runDate, config = {}, identifiersFor = () => null }) {
  const out = { entries: clone(data.entries), news: clone(data.news), site: clone(data.site), changes: clone(data.changes || { items: [] }) };
  const byKey = new Map(out.entries.map((e) => [e.key, e]));
  const itemById = new Map(changeset.items.map((i) => [i.item_id, i]));
  const applied = [], skipped = [], log = [], touched = new Set();
  const at = runDate + 'T00:00:00Z';
  // "Future" means after the later of the run date and the data's own cut-off (an older run can be replayed onto newer data).
  const cutoff = runDate > data.site.updates_through ? runDate : data.site.updates_through;

  for (const d of diff.items) {
    if (d.verdict !== 'material') { if (d.verdict === 'new_entry_candidate') skipped.push({ item_id: d.item_id, why: 'new entry candidate: not created in Tier A' }); continue; }
    const item = itemById.get(d.item_id), e = byKey.get(d.entry_key);
    if (!item || !e) { skipped.push({ item_id: d.item_id, why: 'no matching change-set item or entry (matched by key)' }); continue; }
    const allowed = TIER_A[item.source] || [];
    const raw = readRaw(item); // the exact text fetched at grab time; its hash was checked by the caller
    const name = sourceName(item, e);
    const before = { status: e.status, status_text: e.status_text, events: e.events.length };
    const notes = [];

    for (const r of d.reasons) {
      if (!allowed.includes(r.kind)) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: `${r.kind} is not a Tier A fact: ${r.detail}` }); continue; }
      if (r.kind === 'new_action') {
        const a = actionOf(r);
        if (!a) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: 'new action without a readable date' }); continue; }
        if (!inRaw(raw, a.text)) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: `action text not found in the stored record: ${a.text}` }); continue; }
        const type = item.source === 'legiscan' ? stateEventType(a.text) : eventFor({ text: a.text }); // each source's own rules
        if (type && !e.events.some((v) => v.date === a.date && v.type === type)) {
          e.events.push({ date: a.date, precision: 'day', type, text: cut(a.label, 200), clause: a.text, scheduled: a.date > cutoff, source_url: item.source_url });
          log.push({ entry_key: e.key, field: 'events', old: null, new: { date: a.date, type, text: a.text }, date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' });
        }
        const add = `${a.label} (${longDate(a.date)}, ${name})`;
        // Already said, perhaps in the author's own words: the status text names that date.
        const said = (e.status_text || '').includes(a.text) || datesMentioned(e.status_text, [], +(e.last_checked || runDate).slice(0, 4)).has(a.date);
        if (!said) {
          const old = e.status_text;
          e.status_text = old ? `${old.replace(/[\s.;]+$/, '')}; ${add}` : add;
          log.push({ entry_key: e.key, field: 'status_text', old, new: e.status_text, date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' });
        }
        (e.evidence = e.evidence || []).push({ field: 'events', quote: a.text, source_url: item.source_url });
        notes.push({ date: a.date, text: a.label, quote: a.text });
      }
      if (r.kind === 'status_change') {
        const next = ['enacted', 'failed'].includes(r.api_value) ? r.api_value : null; // compare/congress.mjs statusFromAction
        if (next && next !== e.status) {
          log.push({ entry_key: e.key, field: 'status', old: e.status, new: next, date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' });
          e.status = next;
          (e.evidence = e.evidence || []).push({ field: 'status', quote: clean(r.detail), source_url: item.source_url });
        }
      }
    }

    const changed = e.status !== before.status || e.status_text !== before.status_text || e.events.length !== before.events;
    if (!changed) continue;
    e.events.sort((x, y) => x.date.localeCompare(y.date));
    if (!e.identifiers && identifiersFor(e.key)) e.identifiers = identifiersFor(e.key); // a mixed entry must say how it is found
    if (e.origin === 'authored') { log.push({ entry_key: e.key, field: 'origin', old: 'authored', new: 'mixed', date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' }); e.origin = 'mixed'; }
    e.verification = { method: 'agent', checked_at: at, run_id: runId, rounds: 0 };
    e.last_checked = runDate; e.last_changed = runDate;
    touched.add(e.key);
    applied.push({ item_id: d.item_id, entry_key: e.key, actions: notes, status: e.status !== before.status ? `${before.status} -> ${e.status}` : null });

    if (config.news_from_official_actions !== false) for (const n of notes.filter((x) => !out.news.items.some((y) => y.tracker === e.key && y.date === x.date))) {
      out.news.items.push({
        date: n.date, kind: newsKind(e), title: cut(`${e.short_name}: ${n.text}`, 140),
        body: `${name} records this action on ${e.title}: "${n.text}" (${longDate(n.date)}).`,
        links: [{ t: `${e.short_name} on ${name}`, u: item.source_url }],
        check: `From the official record (${name}), copied word for word by code; no AI was used.`,
        tracker: e.key, origin: 'automated', verification: { method: 'agent', checked_at: at, run_id: runId, rounds: 0 },
        evidence: [{ field: 'body', quote: n.quote || n.text, source_url: item.source_url }]
      });
    }
  }

  if (touched.size) { advanceCutoff(out, runDate); out.changes.items.push(...log); }
  return { data: out, applied, skipped, touched: [...touched], log };
}

// The cut-off moves to the run date, so every event's "scheduled" flag is recomputed against it.
export function advanceCutoff(out, runDate) {
  if (runDate > out.site.updates_through) out.site.updates_through = runDate;
  for (const e of out.entries) for (const v of e.events) if (v.scheduled !== undefined || v.date > out.site.updates_through) v.scheduled = v.date > out.site.updates_through;
  out.news.items.sort((a, b) => a.date.localeCompare(b.date));
  const [y, m, dd] = out.site.updates_through.split('-').map(Number);
  out.news.asof = `${FULL_MONTH[m - 1]} ${dd}, ${y}`; // never moves back when an older run is replayed
}
