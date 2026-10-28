// The comparison step for state bills (LegiScan). Plain code, no AI; same verdicts as compare/congress.mjs.
//   material   a non-routine history action after the entry was last checked, or the bill became law / failed
//   minor      the record changed, but only routine steps (readings, amendments, cosponsors) or a companion bill moved
//   unchanged  nothing to do
// The raw record is what grabber/run-legiscan.mjs saved: { bill, derived: { status, events } }, where derived.events are
// the history actions grabber/sources/legiscan.mjs eventsFrom keeps (routine ones dropped).
import { datesMentioned } from './congress.mjs';
import { eventsFrom, stateActionKind } from '../grabber/sources/legiscan.mjs';

export function compareLegiScan({ item, raw, entry, billsOfEntry = 1 }) {
  const bill = raw.bill || {}, derived = raw.derived || {};
  if (!entry) return { item_id: item.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: `New state bill ${bill.state} ${bill.bill_number} "${bill.title}" is not in the tracker.` }] };
  const baseline = entry.last_checked, reasons = [], minor = [];
  const known = datesMentioned(entry.status_text, entry.events, +baseline.slice(0, 4));

  // The events are re-derived from the history with the current rules when it is there (a record saved by an older run carries the
  // older rules' events); same date: the most important action first.
  const events = Array.isArray(bill.history) ? eventsFrom(bill) : derived.events || [];
  const imp = (e) => stateActionKind(e.text).importance;
  events.filter((e) => e.date > baseline && !known.has(e.date))
    .sort((a, b) => a.date.localeCompare(b.date) || imp(b) - imp(a))
    .forEach((e) => reasons.push({ kind: 'new_action', detail: `${e.date}: ${bill.state} ${bill.bill_number}: ${e.text}`, api_value: e.text, our_value: entry.status_text || '' }));

  // Became law: one chaptered bill is enough. Failed: only when the entry is this one bill; an entry that covers a
  // House and a Senate version is not dead because one of them stopped (the other may be the vehicle).
  const s = derived.status;
  if (s === 'enacted' && entry.status !== 'enacted') reasons.push({ kind: 'status_change', detail: `${bill.state} ${bill.bill_number} is marked passed (law) on LegiScan; the tracker says "${entry.status}".`, api_value: 'enacted', our_value: entry.status });
  if (s === 'failed' && !['failed', 'enacted', 'excluded'].includes(entry.status)) {
    (billsOfEntry > 1 ? minor : reasons).push({ kind: billsOfEntry > 1 ? 'companion_status' : 'status_change', detail: `${bill.state} ${bill.bill_number} is marked failed or vetoed on LegiScan${billsOfEntry > 1 ? ` (one of ${billsOfEntry} bills in this entry)` : ''}; the tracker says "${entry.status}".`, api_value: 'failed', our_value: entry.status });
  }
  if (reasons.length) return { item_id: item.item_id, entry_key: entry.key, verdict: 'material', reasons };

  const routine = (bill.history || []).filter((h) => h.date > baseline).length;
  if (routine) minor.push({ kind: 'record_updated', detail: `${routine} routine step(s) on LegiScan since ${baseline} (readings, amendments, cosponsors); nothing the tracker states changed.` });
  return { item_id: item.item_id, entry_key: entry.key, verdict: minor.length ? 'minor' : 'unchanged', reasons: minor };
}
