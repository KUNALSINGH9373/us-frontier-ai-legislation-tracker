// Congress.gov -> news RawItems, from the bill records the grabber already fetched this run (no API call of its own).
// records: [{ source: 'congress_gov', source_id: '119/hr/3460', entry_key, source_url, fetched_at, raw }] (news/run.mjs runRecords).
import { classifyCongress, chamberOf } from '../classify.mjs';

const TYPE = { HR: 'H.R.', S: 'S.', HRES: 'H.Res.', SRES: 'S.Res.', HJRES: 'H.J.Res.', SJRES: 'S.J.Res.', HCONRES: 'H.Con.Res.', SCONRES: 'S.Con.Res.' };
import { actionId } from './action-id.mjs';
const clean =(t) => String(t || '').replace(/\s+/g, ' ').trim();
const SYSTEM_CHAMBER = { 'House floor actions': 'House', 'Senate': 'Senate' };

export function itemsFromRecord(rec) {
  const raw = rec.raw || {}, bill = raw.bill || {}, li = raw.list_item || {};
  const type = String(bill.type || li.type || '').toUpperCase(), num = bill.number || li.number;
  const number = TYPE[type] && num ? `${TYPE[type]} ${num}` : null;
  const title = clean(bill.title || li.title) || null;
  return (raw.actions || []).filter((a) => a && a.text && /^\d{4}-\d{2}-\d{2}$/.test(a.actionDate || '')).map((a) => {
    const text = clean(a.text), cls = classifyCongress(a);
    const chamber = chamberOf(text) || (cls === 'passage' || cls === 'failure' ? SYSTEM_CHAMBER[a.sourceSystem && a.sourceSystem.name] || null : null) || (cls === 'introduction' ? (/house/i.test(text) ? 'House' : /senate/i.test(text) ? 'Senate' : null) : null);
    const committee = a.committees && a.committees[0] && a.committees[0].name ? a.committees[0].name : null;
    return { source: 'congress_gov', source_id: actionId(rec.source_id, a.actionDate, text), record: rec.source_id, jurisdiction: 'US', entry_id: rec.entry_key || null, class: cls, date: a.actionDate,
      facts: { action: text, ...(chamber ? { chamber } : {}), ...(committee ? { committee } : {}), ...(number ? { number } : {}), ...(title ? { title } : {}) },
      url: rec.source_url, title, retrieved_at: rec.fetched_at };
  });
}

export async function fetchItems({ records = [] } = {}) {
  const recs = records.filter((r) => r.source === 'congress_gov');
  const items = [], errors = [];
  for (const r of recs) { try { items.push(...itemsFromRecord(r)); } catch (e) { errors.push(`${r.source_id}: ${e.message}`); } }
  const newest = items.reduce((m, i) => (i.date > m ? i.date : m), '') || null;
  return { items, health: { ok: !errors.length, count: items.length, newest, errors }, fetched: recs.map((r) => ({ source: 'congress_gov', record: r.source_id })) };
}
