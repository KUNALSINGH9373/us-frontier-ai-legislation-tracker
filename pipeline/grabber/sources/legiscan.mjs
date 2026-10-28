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

// A history action -> { kind, type, milestone, importance }: the tracker's event type, or type null (milestone false) when it is routine
// or procedural (readings, prints, amendments, substitutes, motions, withdrawals from a committee or calendar, tabling). Failure, veto
// and enactment are anchored to the bill itself: "Amendment No. 2 failed", "Motion to reconsider failed", "Amend Tabled A2" are
// procedural; "Failed passage", "Died in committee", "Indefinitely postponed", "Vetoed by Governor" are failures. "Chapter N" counts as
// enactment only with "chaptered" / "Secretary of State" (or a governor's approval). importance orders actions on one date (highest first).
// Checked against every history action in the stored LegiScan records (grabber/test-legiscan.mjs). Order matters: the first rule that fits wins.
const NOISE = /passed by for the day|amendments? (read and )?adopted|substitute (printed|agreed|rejected)|committee substitute|may be (acted|heard)|^bill text|fiscal (impact|note)|^from printer|signed by (the )?(president|speaker)|^acts of assembly chapter text|line veto|\bline[- ]item veto|\bitem veto|\bpartial(ly)? veto|\bveto(ed)? in part\b|\bhearings? (was |is |has been )?(cancel+ed|postponed|deferred)\b|\b(cancel+ed|postponed|deferred)\b[^.]{0,40}\bhearing/i;
// A final failure the text itself states: a pocket veto, or a veto the legislature sustained (an override that failed). "Returned
// without signature" is not one: in some states a bill the governor neither signs nor vetoes becomes law.
const FINAL_VETO = /\bpocket[- ]veto(ed)?\b/i;
const VETO_SUSTAINED = /\bveto (was |is )?sustained\b|\bsustain(ed|s)? (the )?(governor'?s )?veto\b|\b(veto )?overrid\w*[^.]{0,40}\bfailed\b|\bfailed to override\b/i;
// An action whose subject is an amendment, a substitute or a conference: never the bill's own failure or passage.
const AMENDMENT = /^\W*((house|senate|assembly)\s+)?((committee|floor)\s+)?(amend(ment)?s?|am\.|substitute|ss\s+[a-z]\b)|\bamendment (no\.\s*)?[a-z]{0,3}\s?\d|\b(AM|MO|HA|SA|FA)\s?\d{1,5}\b|\bamendment\(?s?\)? (failed|tabled|withdrawn|stricken|rejected|offered)\b|\boffered (&|and) withdrawn\b|\bamendment by (rep|sen)\w*\.? |^\W*proposal of amendment\b|\bconferees?\b|\bconcur in [hs] com sub\b/i;
const BILL_FAILED = /^(?!.*\b(motion to|moved to|committee report)\b).*(\bfailed (to pass|passage|of passage)\b|\brefused passage\b|\bfailed in (the )?(senate|house|assembly)\b|\bdie[ds]? in\b|^\W*died\b|\bindefinitely postponed\b|\bpostponed? indefinitely\b|\binexpedient to legislate\b|\benacting clause stricken\b|\bfile for bills not passed\b)/i;
const VETOED = /\bvetoed\b(?!.*overrid)|^\W*veto(ed)? by (the )?governor\b/i;
const PROCEDURAL = /\bmotion\b|\bmoved to\b|\breconsider\w*|\bwithdrawn\b|\brecommit\w*|\blaid on the table\b|\btabled\b(?! for the calendar)|\bremoved from table\b|\bdischarge\b|\brules? suspended\b/i;
const ENACTED = /\bchaptered\b|^\W*signed chap\.\s*\d+|\bsecretary of state\b[^.]*\bchapter \d+|(signed|approved) by (the )?governor|\bgovernor (approved|signed)\b|\bbecame law\b|\bpublic act[\s.]*\d/i;
const kindOf = (kind, type, importance) => ({ kind, type, milestone: !!type, importance });
export function stateActionKind(action, isFirst = false) {
  const t = String(action || '').replace(/\s+/g, ' ').trim();
  if (/veto overrid|overrid\w* (the )?(governor'?s )?veto/i.test(t) && !/\b(failed|sustained)\b/i.test(t)) return kindOf('veto_override', 'Passed / advanced', 95);
  if (!/\bmotion\b/i.test(t) && VETO_SUSTAINED.test(t)) return kindOf('failed', 'Vetoed / failed / rescinded', 70);
  if (FINAL_VETO.test(t)) return kindOf('vetoed', 'Vetoed / failed / rescinded', 90);
  if (/agreed to by (the )?(house|senate|assembly)|^(?!.*\bnot concurred\b).*\bamendments? concurred in/i.test(t) && !/\bmotion\b/i.test(t)) return kindOf('passed', 'Passed / advanced', 80);
  if (NOISE.test(t) || AMENDMENT.test(t)) return kindOf('procedural', null, 0);
  if (VETOED.test(t)) return kindOf('vetoed', 'Vetoed / failed / rescinded', 90);
  if (BILL_FAILED.test(t)) return kindOf('failed', 'Vetoed / failed / rescinded', 70);
  if (PROCEDURAL.test(t)) return kindOf('procedural', null, 0);
  if (ENACTED.test(t)) return kindOf('enacted', 'Signed / enacted', 100);
  if (/\bdo not pass\b|\bnot passed\b/i.test(t)) return kindOf('procedural', null, 0); // a minority report
  if (/\bpass(ed)?\b|do pass|reported (out|favorabl|from)|\benrolled\b|\bengrossed\b/i.test(t)) return kindOf('passed', 'Passed / advanced', /\b(committee|recommend\w*|do pass|reported|report)\b/i.test(t) ? 60 : 80);
  if (isFirst || /\bintroduced\b|\bprefiled\b/i.test(t)) return kindOf('introduced', 'Introduced / published', 30);
  if (/hearing|held under submission/i.test(t)) return kindOf('hearing', 'Referred / stalled / hearing', 40);
  if (/referred|committee/i.test(t)) return kindOf('referred', 'Referred / stalled / hearing', 20);
  return kindOf('procedural', null, 0);
}
export const eventType = (action, isFirst = false) => stateActionKind(action, isFirst).type;

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
