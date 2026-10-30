// LegiScan API (https://api.legiscan.com). State bills for all 50 states. Free tier: 30,000 queries a month, so every call counts.
// LegiScan is an aggregator: it is used to FIND changes. The legislature's own page (state_link) is what the site cites.
// The key has to go in the URL (the API has no header option); http.mjs scrubs it from every error and log line.
import { htmlToText, stripLineNumbering } from '../lib/text.mjs';
import { losingTally } from '../../news/strict.mjs';
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
const ENACTED = /\bchaptered\b|^\W*signed chap\.\s*\d+|\bsecretary of state\b[^.]*\bchapter \d+|(signed|approved) by (the )?governor|\bgovernor (approved|signed)\b|\bbecame law\b/i;
// A public act number (CT "Public Act 26-100", IL "Public Act . . . 104-0466") is assigned by the legislature's clerks, not by the
// governor's signature: CT numbered HB 5222 on May 19 and the governor signed it on June 2. It is never the signing (the governor's own
// action line is), so it is procedural.
const PUBLIC_ACT = /^\W*public act\b[\s.]*\d/i;
// Readings and the CT Legislative Commissioners' Office are routine steps, not passage: "Passed First Reading", "Reported Out of
// Legislative Commissioners' Office", "Filed with Legislative Commissioners' Office".
// (Hawaii's "Passed Second Reading ... and referred to the committee(s)" is a committee passage there and stays one.)
// Hawaii writes it "Pass First Reading" and "Introduced and Pass First Reading.", so "pass" and "passed" both match.
const ROUTINE_STEP = /\bpass(?:ed)? (?:on )?first reading\b|\bfirst reading,? pass(?:ed)?\b|\blegislative commissioners'? office\b/i;
// A carry-over to the next session ("Continued to next session", "Carried over to the next session") keeps the bill alive: an event of
// the stalled type, kept so the entry shows the bill was carried over.
const CARRY_OVER = /\bcontinued to (?:the )?next (?:regular )?session\b|\bcarr(?:y|ied)[- ]?over\b/i;
const kindOf = (kind, type, importance) => ({ kind, type, milestone: !!type, importance });
export function stateActionKind(action, isFirst = false) {
  const t = String(action || '').replace(/\s+/g, ' ').trim();
  if (/veto overrid|overrid\w* (the )?(governor'?s )?veto/i.test(t) && !/\b(fail\w*|sustain\w*|lost|not reached|not overridden|scheduled|filed|pending|motion|notice|planned|set for|to override|void\w*)\b/i.test(t) && !losingTally(t)) return kindOf('veto_override', 'Passed / advanced', 95);
  if (!/\bmotion\b/i.test(t) && VETO_SUSTAINED.test(t)) return kindOf('failed', 'Vetoed / failed / rescinded', 70);
  if (FINAL_VETO.test(t)) return kindOf('vetoed', 'Vetoed / failed / rescinded', 90);
  if (/agreed to by (the )?(house|senate|assembly)|^(?!.*\bnot concurred\b).*\bamendments? concurred in/i.test(t) && !/\bmotion\b/i.test(t) && !losingTally(t)) return kindOf('passed', 'Passed / advanced', 80);
  if (NOISE.test(t) || AMENDMENT.test(t) || PUBLIC_ACT.test(t) || ROUTINE_STEP.test(t)) return kindOf('procedural', null, 0);
  if (CARRY_OVER.test(t) && !/\bmotion\b/i.test(t)) return kindOf('carried_over', 'Referred / stalled / hearing', 25);
  // a veto of sections of a signed bill is not the bill's veto; a veto the same line overrides is the override's (review r10 #10)
  if (/\bsections?\s+[\w,\s-]{0,20}\bvetoed\b|\bsigned\b[^.]*\bvetoed\b|\bvetoed\b[^.]*\bsigned\b/i.test(t)) return kindOf('procedural', null, 0);
  if (/\bvetoed\b[^.]*\boverr(o|i)de\b/i.test(t)) return kindOf('veto_override', 'Passed / advanced', 95);
  // a voided vote, or a resolution's chapter (CA "Res. Chapter"), is no enactment and no passage (review r10 #11/#12)
  if (/\bvoid\w*|\bnullif\w*/i.test(t) || /\bres\.?\s*chapter\b/i.test(t)) return kindOf('procedural', null, 0);
  // "Passed for the day", an executive order, a staff member's signature: not the bill's passage or enactment (review r11 #8)
  if (/\bpassed (by )?for the day\b|\bexecutive order\b|\bchief of staff\b/i.test(t)) return kindOf('procedural', null, 0);
  if (VETOED.test(t)) return kindOf('vetoed', 'Vetoed / failed / rescinded', 90);
  // a failure the same line undoes ("Refused passage; reconsidered and passed", "Died in House; revived"), or one of an amendment
  // ("Indefinitely postponed amendment") is not the bill's failure (review r9 #5)
  if (/\breconsider\w*|\bvacat\w*|\breviv\w*|\breinstat\w*|\brestored\b|\bamendments?\b/i.test(t) && BILL_FAILED.test(t)) return kindOf('procedural', null, 0);
  // "Not signed by Governor", "Approved by Governor's office for signature": no signature (review r9 #3)
  if (/\bnot (signed|approved)\b|\bfor (signature|signing)\b|\bwithout (the )?(governor'?s )?signature\b(?!.*\bbecame law\b)/i.test(t) && !/\bbecame law\b|\bbecomes law\b/i.test(t)) return kindOf('procedural', null, 0);
  if (BILL_FAILED.test(t)) return kindOf('failed', 'Vetoed / failed / rescinded', 70);
  if (PROCEDURAL.test(t)) return kindOf('procedural', null, 0);
  if (ENACTED.test(t)) return kindOf('enacted', 'Signed / enacted', 100);
  if (/\bdo not pass\b|\bnot passed\b/i.test(t)) return kindOf('procedural', null, 0); // a minority report
  // A committee recommending against the bill is not its passage: ME/NH "Ought Not to Pass", MD "Unfavorable Report" (review r9 #1).
  // (A report "without recommendation" is not touched here: "Reported out without recommendation" stays an advance; news/classify.mjs
  // gives it no card.)
  // Passage or report wording that carries any negative is no passage: "Ought Not to Pass", "Unfavorable Report", "Recommended not to
  // pass", "Do Pass Failed", "Ought to pass report rejected", VA "Passed by indefinitely" (the committee setting the bill aside). One
  // general rule, not a list of idioms (review r9). The negative must be about the bill, not an amendment ("Passed Senate; House
  // amendment not recommended", "Passed House; Unfavorable report on amendment H-1").
  // Vote tallies are not negatives ("25 YES 12 NO 1 NOT VOTING", "voting no (4)", "No Amendments"): read without them.
  const words = t.replace(/\bnot voting\b|\bvoting (no|nay)\b|\bno amendments?\b|\b\d+\s*-?\s*(yes|yeas?|no|nays?|ayes?|n)\b|\b(yes|yeas?|no|nays?|ayes?)\b\s*[,:-]?\s*\(?\d+\)?/gi, ' ');
  // also a vote taken back or set aside ("vote rescinded", "expunged", "reconsidered", VA "Passed by temporarily", "declined to pass")
  // (review r6)
  const NEGATIVE = /\b(not|never|reject\w*|refus\w*|fail\w*|defeat\w*|unfavorabl\w*|indefinitely|rescind\w*|expung\w*|reconsider\w*|vacated?|temporarily|declin\w*|lost)\b/i;
  // a committee reporting the bill adversely, to study, or as dead or held is not its passage (review r7 #2)
  const OUTCOME_NOT_PASSED = /\b(advers\w*|contrary|study|ITL|ONTP|OTP-ND|laid over|dead|held|in error|erroneous\w*)\b/i;
  const NEGATIVE_AMENDMENT = /\bamendments?\b[^.;]{0,30}\b(unfavorabl\w*|not (recommended|adopted)|reject\w*|fail\w*|defeat\w*)|\b(unfavorabl\w*|not recommended|reject\w*|fail\w*|defeat\w*)\b[^.;]{0,30}\bamendments?\b/i;
  // the amendment clauses are read apart: "ought not to pass; amendment unfavorable" still negates the bill (review r6)
  const billWords = words.replace(new RegExp(NEGATIVE_AMENDMENT.source, 'gi'), ' ');
  if (/\bpass|\breport|\brecommend/i.test(words) && NEGATIVE.test(billWords)) return kindOf('procedural', null, 0);
  if (/\bpass|\breport/i.test(words) && !/\breferred to\b/i.test(t) && OUTCOME_NOT_PASSED.test(billWords)) return kindOf('procedural', null, 0);
  // not a passage yet, or not one at all: "may pass", "to be passed", "Passed: no", VA "Passed by" (passed by for the day), a vote
  // whose noes are not fewer than its ayes ("DO PASS (2-7)") (review r6)
  if (/\b(may|might|would|will|shall|could|(?<!ought )to) (be )?pass(ed)?\b|\bpassed\s*:\s*no\b|^\W*passed by\W*$|\bpassed by for the day\b/i.test(t) || (/\bpass|\breport|\brecommend/i.test(t) && losingTally(t))) return kindOf('procedural', null, 0);
  // "Ought to Pass" is a committee's report (ME/NH); the chamber adopting it ("Ought to Pass: Motion Adopted") is a motion, settled above.
  if (/\bpass(ed)?\b|do pass|reported (out|favorabl|from)|\benrolled\b|\bengrossed\b/i.test(t)) return kindOf('passed', 'Passed / advanced', !/^\W*passed (the )?(house|senate|assembly)\b/i.test(t) && /\b(committee|recommend\w*|do pass|reported|report)\b|\bought to pass\b/i.test(t) ? 60 : 80);
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
    },
    // An amendment's words (HTML / plain text only; a PDF amendment comes back as { text: null }).
    async amendment(amendmentId) {
      const a = (await call('getAmendment', { id: amendmentId })).amendment;
      const buf = Buffer.from(a.doc || '', 'base64');
      if (/html/i.test(a.mime)) return { text: stripLineNumbering(htmlToText(buf.toString('utf8'))), mime: a.mime, date: a.date, title: a.title };
      if (/text\/plain/i.test(a.mime)) return { text: stripLineNumbering(buf.toString('utf8')), mime: a.mime, date: a.date, title: a.title };
      return { text: null, mime: a.mime, date: a.date, title: a.title };
    }
  };
}

// Amendments adopted after the newest text version, so not yet printed in it (IL H.B. 3506: Committee Amendment No. 1 adopted in
// committee, the bill never re-printed). LegiScan's "adopted" flag lags, so the bill's own history counts too: an action saying that
// chamber's "Amendment No. N" was adopted, with no later action tabling, withdrawing or striking it. Oldest first.
export function adoptedAmendments(bill) {
  const v = latestText(bill), since = (v && v.date) || '';
  const history = bill.history || [];
  const numberOf = (a) => Number((/(\d+)\s*$/.exec(a.title || '') || [])[1]);
  const adoptedIn = (a) => {
    const n = numberOf(a);
    if (!n) return false;
    const re = new RegExp(`\\bamendment no\\.?\\s*0*${n}\\b`, 'i');
    let state = false;
    for (const h of history) {
      if ((h.chamber || '') !== (a.chamber || '') || !re.test(h.action || '')) continue;
      if (/\badopted\b/i.test(h.action) && !/\bnot adopted\b/i.test(h.action)) state = true;
      else if (/\b(tabled|withdrawn|stricken|lost|failed|reconsidered)\b/i.test(h.action)) state = false;
    }
    return state;
  };
  return (bill.amendments || []).filter((a) => a.amendment_id && (a.date || '') >= since && (Number(a.adopted) === 1 || adoptedIn(a)))
    .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
}

// The bill text with its adopted amendments after it, each under a header that says it changes the text above. Amendments whose words
// could not be read are named (so a reader knows the text may be out of date) rather than silently left out.
export function withAmendments(text, parts) {
  if (!parts || !parts.length) return text;
  return [text, ...parts.map((p) => p.text
    ? `\n\nADOPTED AMENDMENT: ${p.title || 'amendment'} (dated ${p.date || 'unknown'}). It changes the bill text above; where they differ, the text as amended by this amendment is the current version.\n${p.text}`
    : `\n\nADOPTED AMENDMENT NOT READ: ${p.title || 'amendment'} (dated ${p.date || 'unknown'}); its words were not available, so the bill text above may be out of date.`)].join('');
}

// The newest text version, preferring HTML over PDF when both exist for the same date.
export function latestText(bill) {
  const texts = (bill.texts || []).filter((t) => t.doc_id);
  const newest = texts.map((t) => t.date || '').sort().pop();
  const same = texts.filter((t) => (t.date || '') === newest);
  return same.find((t) => /html/i.test(t.mime)) || same.find((t) => !/pdf/i.test(t.mime)) || same[0] || null;
}
