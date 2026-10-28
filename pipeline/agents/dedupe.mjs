// Is a new item already in the tracker, under any name? Plain code, used before a new entry is created (publish/tier-b.mjs) and
// before any AI is spent on a candidate (agents/process-item.mjs). A match is never created: it is skipped or held.
// What counts as "already tracked":
//   - any record id an entry holds (Congress.gov, Federal Register, LegiScan), at any level (J and "none" entries included);
//   - a state bill number written anywhere in an entry (title, short name, status, mechanism, thresholds, events, sources), for the
//     entry's state, or for any state the entry names when it has none (J entries: "Texas TRAIGA (HB 149)", "NJ S 1802");
//   - LegiScan's own links between bills (sasts: same as, similar to, replaced by, crossfiled, carry over ...): a companion, an
//     other-chamber twin, an earlier session's version, or the bill an amendment was folded into;
//   - Congress.gov related bills marked "Identical bill" (raw.related_bills, when the grabber stored them);
//   - a state bill whose own text names a tracked bill of the same state ("If and only if Senate Bill 315 ... becomes law ... is amended").
import { billNumbersIn, normNumber } from '../grabber/sources/legiscan.mjs';

export const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico' };
const NAME_RE = new RegExp(`\\b(${Object.values(STATES).sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');
const CODE_RE = new RegExp(`(?<![A-Za-z.])(${Object.keys(STATES).join('|')})(?![A-Za-z])`, 'g');
const BY_NAME = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v, k]));

// The states an entry is about: its own, or every state its title and short name name.
export function statesOf(e) {
  if (e.state) return [e.state];
  if (e.level === 'federal') return [];
  const t = `${e.short_name || ''} ${e.title || ''}`, out = new Set();
  for (const m of t.matchAll(NAME_RE)) out.add(BY_NAME[m[1]]);
  for (const m of t.matchAll(CODE_RE)) out.add(m[1]);
  return [...out];
}

// Bill numbers in free text, in LegiScan's form ("SB189", "HB149", "S3228"): the grabber's reader, plus Colorado's year-numbered
// "SB 26-189" / "SB 24-205" and number ranges "SB 757–760".
export function numbersIn(text) {
  const t = String(text || ''), out = new Set(billNumbersIn(t));
  for (const m of t.matchAll(/(?<![A-Za-z.])([SH])\.?\s?B\.?\s?\d{2}-(\d{1,4})\b/g)) out.add(normNumber(`${m[1]}B${m[2]}`));
  for (const m of t.matchAll(/(?<![A-Za-z.])([SHA])\.?\s?([BF])?\.?\s?(\d{1,5})\s?[–-]\s?(\d{1,5})\b/g)) {
    const a = +m[3], b = +m[4];
    if (b > a && b - a <= 20) for (let k = a; k <= b; k++) out.add(normNumber(`${m[1]}${m[2] || ''}${k}`));
  }
  return [...out].filter(Boolean);
}

const entryText = (e) => [e.title, e.short_name, e.status_text, e.mechanism, e.thresholds, e.signed_text, e.effective_text,
  ...(e.events || []).map((v) => v.text), ...(e.sources || []).map((s) => `${s.label || ''} ${s.url || ''}`)].filter(Boolean).join(' \n ');
// Every "ST:NUMBER" an entry covers.
export const stateNumbersOf = (e) => { const st = statesOf(e); if (!st.length) return []; const ns = numbersIn(entryText(e)); return st.flatMap((s) => ns.map((n) => `${s}:${n}`)); };
// Every record an entry is tracked by, in the item_id form the grabber uses.
export const idsOf = (e) => { const x = (e.identifiers && e.identifiers.external) || {}; return [...(x.congress_gov || []).map((i) => 'congress_gov:' + i), ...(x.federal_register_doc ? ['federal_register:' + x.federal_register_doc] : []), ...(x.legiscan || []).map((i) => 'legiscan:' + i)]; };

// An index of the tracker, built once per run: { ids, numbers: Map("ST:NUM" -> entry key) }.
export function trackerIndex(entries, tracked = []) {
  const ids = new Map(), numbers = new Map();
  for (const e of entries) { idsOf(e).forEach((i) => ids.set(i, e.key)); stateNumbersOf(e).forEach((n) => numbers.has(n) || numbers.set(n, e.key)); }
  tracked.forEach((i) => ids.has(i) || ids.set(i, '(tracked list)'));
  return { ids, numbers, add(e) { idsOf(e).forEach((i) => ids.set(i, e.key)); stateNumbersOf(e).forEach((n) => numbers.has(n) || numbers.set(n, e.key)); } };
}

// "Senate Bill 315", "House Bill No. 1234", "Assembly Bill 12" in a bill's text -> "SB315", ...
const TEXT_BILL_RE = /\b(Senate|House|Assembly)\s+Bill\s+(?:No\.?\s*)?(\d{1,5})\b/g;
const CHAMBER = { Senate: 'S', House: 'H', Assembly: 'A' };
function textBillNumbers(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(TEXT_BILL_RE)) { out.add(`${CHAMBER[m[1]]}B${m[2]}`); out.add(`${CHAMBER[m[1]]}${m[2]}`); }
  return [...out];
}

// { key, why } for the tracked entry this item duplicates, or null. idx: trackerIndex(entries, tracked).
export function duplicateOf({ item, raw = {}, idx }) {
  if (idx.ids.has(item.item_id)) return { key: idx.ids.get(item.item_id), why: `already tracked (record ${item.item_id})` };
  if (item.source === 'legiscan' && raw.bill) {
    const b = raw.bill, st = b.state, own = normNumber(b.bill_number);
    if (own && idx.numbers.has(`${st}:${own}`)) return { key: idx.numbers.get(`${st}:${own}`), why: `already tracked (an entry covers ${st} ${own})` };
    for (const s of b.sasts || []) {
      const n = normNumber(s.sast_bill_number);
      if (s.sast_bill_id && idx.ids.has('legiscan:' + s.sast_bill_id)) return { key: idx.ids.get('legiscan:' + s.sast_bill_id), why: `LegiScan links it to a tracked bill (${s.type || 'related'} ${s.sast_bill_number})` };
      if (n && idx.numbers.has(`${st}:${n}`)) return { key: idx.numbers.get(`${st}:${n}`), why: `LegiScan links it to a tracked bill (${s.type || 'related'} ${st} ${n})` };
    }
    // Its history points at another bill ("See S3178", "Substituted by HB 12"): an amendment or substitute folded into that bill.
    for (const h of b.history || []) for (const n of numbersIn(h.action)) if (n !== own && idx.numbers.has(`${st}:${n}`) && /\b(see|substitut|replaced|amend|companion|identical|similar)/i.test(h.action)) return { key: idx.numbers.get(`${st}:${n}`), why: `its history points at a tracked bill ("${h.action}")` };
    // Its own text names a tracked bill of the same state (an amendment to it, or a bill that depends on it becoming law).
    for (const n of [...textBillNumbers(raw.text), ...numbersIn(String(raw.text || '').slice(0, 3000))]) if (n !== own && idx.numbers.has(`${st}:${normNumber(n)}`)) return { key: idx.numbers.get(`${st}:${normNumber(n)}`), why: `its text names a tracked bill (${st} ${normNumber(n)}); it may amend it or depend on it` };
  }
  if (item.source === 'congress_gov') {
    for (const r of raw.related_bills || raw.relatedBills?.relatedBills || []) {
      const identical = (r.relationshipDetails || []).some((d) => /identical/i.test(d.type || ''));
      const id = `congress_gov:${r.congress}/${String(r.type || '').toLowerCase()}/${r.number}`;
      if (identical && idx.ids.has(id)) return { key: idx.ids.get(id), why: `Congress.gov lists it as identical to a tracked bill (${id.slice(13)})` };
    }
  }
  return null;
}

// A Congress bill with related bills that were not read: an identical tracked bill cannot be ruled out, so it is not created.
export function relatedUnread(item, raw = {}) {
  if (item.source !== 'congress_gov') return null;
  const n = raw.bill && raw.bill.relatedBills && raw.bill.relatedBills.count;
  return n > 0 && !(raw.related_bills || (raw.relatedBills && raw.relatedBills.relatedBills)) ? `Congress.gov lists ${n} related bill(s) that were not read, so an identical tracked bill cannot be ruled out` : null;
}
