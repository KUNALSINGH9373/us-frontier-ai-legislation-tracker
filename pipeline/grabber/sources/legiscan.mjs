// LegiScan API (https://api.legiscan.com). State bills for all 50 states. Free tier: 30,000 queries a month, so every call counts.
// LegiScan is an aggregator: it is used to FIND changes. The legislature's own page (state_link) is what the site cites.
// The key has to go in the URL (the API has no header option); http.mjs scrubs it from every error and log line.
import { htmlToText, stripLineNumbering } from '../lib/text.mjs';
export const BASE = 'https://api.legiscan.com/';

// LegiScan numbers bills like "SB53", "AB1405", "S10373", "HF4532", "S0358". Ours are "S.B. 53", "S.10373", "H.F. 4532".
// Normalised form: letters upper-cased, punctuation and spaces dropped, leading zeros removed: "SB53", "S358".
export const normNumber = (s) => { const m = /^([A-Z]+)0*(\d+)$/.exec(String(s).toUpperCase().replace(/[^A-Z0-9]/g, '')); return m ? m[1] + m[2] : null; };

// Bill numbers written in an entry's title / short name. "P.A. 104-0538" (a public act) and "A.G. File No." are not bills.
const NUM_RE = /(?<![A-Za-z.])(?<!P\.)([SHA])\.?\s?([BF])?\.?\s?(\d{1,5})\b(?!-\d)/g;
export const billNumbersIn = (text) => [...new Set([...String(text).matchAll(NUM_RE)].map((m) => normNumber(m[1] + (m[2] || '') + m[3])).filter(Boolean))];

// LegiScan status codes (bill.status) -> the tracker's status. "stalled" is a judgement the code never makes.
export const STATUS = { 1: 'Introduced', 2: 'Engrossed', 3: 'Enrolled', 4: 'Passed', 5: 'Vetoed', 6: 'Failed' };
export const trackerStatus = (code) => (code === 4 ? 'enacted' : code === 5 || code === 6 ? 'failed' : 'pending');

// A history action -> one of the tracker's event types, or null when it is routine (readings, prints, amendments, substitutes).
// Checked against real CA, LA, NY and VA histories (fixtures/legiscan/bills.json). Order matters: the first rule that fits wins.
const NOISE = /passed by for the day|amendments? (read and )?adopted|substitute (printed|agreed|rejected)|committee substitute|may be (acted|heard)|^bill text|fiscal (impact|note)|^from printer|signed by (the )?(president|speaker)/i;
export function eventType(action, isFirst = false) {
  const t = String(action || '');
  if (/\bveto(ed)?\b(?!.*overrid)|\bfailed\b|\bdied\b|\bwithdrawn\b|indefinitely postponed|\btabled\b/i.test(t)) return 'Vetoed / failed / rescinded';
  if (/chaptered|(signed|approved) by (the )?governor|became law|public act \d|chapter \d+/i.test(t)) return 'Signed / enacted';
  if (/agreed to by (the )?(house|senate|assembly)|amendments? concurred in|veto overrid/i.test(t)) return 'Passed / advanced';
  if (NOISE.test(t)) return null;
  if (/\bpass(ed)?\b|do pass|reported (out|favorabl|from)|\benrolled\b|\bengrossed\b/i.test(t)) return 'Passed / advanced';
  if (isFirst || /\bintroduced\b|\bprefiled\b/i.test(t)) return 'Introduced / published';
  if (/referred|hearing|committee|held under submission/i.test(t)) return 'Referred / stalled / hearing';
  return null;
}

// Every non-routine history action as a tracker event. Dates are LegiScan's "YYYY-MM-DD".
export const eventsFrom = (bill) => (bill.history || [])
  .map((h, i) => ({ date: h.date, precision: 'day', type: eventType(h.action, i === 0), text: String(h.action).trim(), chamber: h.chamber }))
  .filter((e) => e.type && /^\d{4}-\d{2}-\d{2}$/.test(e.date));

// The official page to cite (the legislature's own), with LegiScan as the second source.
export const officialUrl = (bill) => bill.state_link || bill.url;

export function createLegiScan(http, key) {
  const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  async function call(op, params = {}) {
    const r = await http.getJson(`${BASE}?${q({ key, op, ...params })}`);
    if (!r || r.status !== 'OK') throw new Error(`LegiScan ${op} returned ${r && r.status}: ${JSON.stringify((r && r.alert) || '').slice(0, 160)}`);
    return r;
  }
  // LegiScan returns lists as objects keyed "0", "1", ... next to a "session" or "summary" key.
  const rows = (o) => Object.entries(o || {}).filter(([k]) => /^\d+$/.test(k)).map(([, v]) => v);

  return {
    async sessions(state) { return (await call('getSessionList', { state })).sessions || []; },
    // bill_id -> { number, change_hash, title, ... } for one session. One query, whatever the size of the session.
    async masterList(sessionId) { const r = await call('getMasterList', { id: sessionId }); return { session: r.masterlist.session, bills: rows(r.masterlist) }; },
    // Same, without titles: the cheapest way to see which bills changed.
    async masterListRaw(sessionId) { const r = await call('getMasterListRaw', { id: sessionId }); return { session: r.masterlist.session, bills: rows(r.masterlist) }; },
    async bill(billId) { return (await call('getBill', { id: billId })).bill; },
    // One search page (50 results with titles). year 2 = current sessions only.
    async search({ query, state = 'ALL', year = 2, page = 1 }) { const r = await call('getSearch', { state, query, year, page }); return { summary: r.searchresult.summary, results: rows(r.searchresult) }; },
    // Every hit of a full-text search as { relevance, bill_id, change_hash }: up to 2,000 per query, so nothing is cut off.
    async searchRaw({ query, state = 'ALL', year = 2 }) {
      const all = [];
      for (let page = 1; ; page++) {
        const r = (await call('getSearchRaw', { state, query, year, page })).searchresult;
        all.push(...(r.results || []));
        if (!r.summary || page >= Number(r.summary.page_total || 1)) return all;
      }
    },
    // A text version's words. HTML / plain text are decoded; anything else (usually PDF) comes back as { text: null, mime }.
    async text(docId) {
      const t = (await call('getBillText', { id: docId })).text;
      const buf = Buffer.from(t.doc || '', 'base64');
      if (/html/i.test(t.mime)) return { text: stripLineNumbering(htmlToText(buf.toString('utf8'))), mime: t.mime, date: t.date, type: t.type };
      if (/text\/plain/i.test(t.mime)) return { text: stripLineNumbering(buf.toString('utf8')), mime: t.mime, date: t.date, type: t.type };
      return { text: null, mime: t.mime, date: t.date, type: t.type, bytes: buf };
    }
  };
}

// The newest text version, preferring HTML over PDF when both exist for the same date.
export function latestText(bill) {
  const texts = (bill.texts || []).filter((t) => t.doc_id);
  const newest = texts.map((t) => t.date || '').sort().pop();
  const same = texts.filter((t) => (t.date || '') === newest);
  return same.find((t) => /html/i.test(t.mime)) || same.find((t) => !/pdf/i.test(t.mime)) || same[0] || null;
}
