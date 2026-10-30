// State legislatures (found through LegiScan) -> news RawItems, from the bill records the grabber already fetched this run (no API call
// of its own). The link is the legislature's own page (grabber/sources/legiscan.mjs officialUrl).
// records: [{ source: 'legiscan', source_id: '<bill_id>', entry_key, source_url, fetched_at, raw: { bill } }].
import { classifyState, chamberOf } from '../classify.mjs';
import { officialUrl } from '../../grabber/sources/legiscan.mjs';

import { actionId } from './action-id.mjs';
const clean =(t) => String(t || '').replace(/\s+/g, ' ').trim();

export function itemsFromRecord(rec) {
  const bill = (rec.raw && rec.raw.bill) || {}, state = bill.state;
  if (!state) return [];
  const number = bill.bill_number ? `${state} ${bill.bill_number}` : null, title = clean(bill.title) || null;
  const url = officialUrl(bill) || rec.source_url;
  return (bill.history || []).map((h, i) => {
    const text = clean(h.action);
    if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(h.date || '')) return null;
    const cls = classifyState(text, { jurisdiction: state, isFirst: i === 0, chamber: h.chamber });
    const chamber = chamberOf(text, h.chamber);
    const record = String(bill.bill_id || rec.source_id);
    return { source: 'legiscan', source_id: actionId(record, h.date, text), record, jurisdiction: state, entry_id: rec.entry_key || null, class: cls, date: h.date,
      facts: { action: text, ...(chamber ? { chamber } : {}), ...(number ? { number } : {}), ...(title ? { title } : {}) },
      url, title, retrieved_at: rec.fetched_at };
  }).filter(Boolean);
}

export async function fetchItems({ records = [] } = {}) {
  const recs = records.filter((r) => r.source === 'legiscan');
  const items = [], errors = [];
  for (const r of recs) { try { items.push(...itemsFromRecord(r)); } catch (e) { errors.push(`${r.source_id}: ${e.message}`); } }
  const newest = items.reduce((m, i) => (i.date > m ? i.date : m), '') || null;
  return { items, health: { ok: !errors.length, count: items.length, newest, errors }, fetched: recs.map((r) => ({ source: 'legiscan', record: String((r.raw && r.raw.bill && r.raw.bill.bill_id) || r.source_id) })) };
}
