// Court dockets (CourtListener) -> news RawItems, from the docket entries the court step (publish/courts.mjs courtsRun) already read this
// run (no API call of its own). found: [{ entry_key, docket_id, court, entry }] (courtsRun's "found": the material entries).
import { classifyCourt } from '../classify.mjs';
import { classifyEntry, docketUrl } from '../../grabber/sources/courtlistener.mjs';

export function itemsFromFound(f, retrievedAt) {
  const x = f.entry || {}, c = classifyEntry(x);
  if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(x.date_filed || '')) return null;
  return { source: 'courtlistener', source_id: String(x.id ?? `${f.docket_id}-${x.entry_number}`), jurisdiction: 'US', entry_id: f.entry_key || null, class: classifyCourt(x), date: x.date_filed,
    facts: { action: c.full, label: c.label, ...(f.court ? { court: f.court } : {}), docket: String(f.docket_id), ...(x.entry_number != null ? { entry_number: x.entry_number } : {}) },
    url: docketUrl(f.docket_id), title: c.label, retrieved_at: retrievedAt };
}

export async function fetchItems({ found = [], now = new Date() } = {}) {
  const items = found.map((f) => itemsFromFound(f, now.toISOString())).filter(Boolean);
  const newest = items.reduce((m, i) => (i.date > m ? i.date : m), '') || null;
  // a docket is read only for its new entries, never in full: nothing here can prove an event gone, so fetched is empty
  return { items, health: { ok: true, count: items.length, newest, errors: [] }, fetched: [] };
}
