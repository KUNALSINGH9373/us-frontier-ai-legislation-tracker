// The closed fact sheet a news card may be written from (news/writer.mjs). Plain code, no AI, no network.
// Built from one Event (news/CONTRACT.md) and its tracker entry (web/data/v2/entries.json). It holds only:
//   event     the official record's own facts (class, date, timing, chamber, committee, vote, agency, deadline, court, ...)
//   bill      identity: number, short title, jurisdiction
//   stage     where the measure stands after this event: only what the record shows happened (no next step is ever stated, review r5)
//   verified  the entry's reading fields that the field eval / self-correction keep checked (publish/guards.mjs READING_FIELDS:
//             mechanism, thresholds, penalties); only the first clause of the mechanism is carried, as a one-line summary
//   milestones facts.milestone strings an official record states ("first state law ..."); empty means "first/only/largest" is refused
// Nothing else: no press release text, no web page, no entry status_text (hand-written prose that is not field-checked).

import { STATE_NAMES, TERRITORIES, isUnicameral, executiveOf, namesExecutive, lawWordingAllowed, unicameralBody, upperOf, lowerOf, prefixOf, prefixInfo, billKey, displayNumber } from './jurisdictions.mjs';
// Jurisdiction names, chambers, executives and bill-number prefixes come from config/jurisdictions.json (news/jurisdictions.mjs).
// Territories (review r6 #7): no executive is named and no law claim is made except a became-law record with valid law wording (the table's
// news_executive_wording flag).
export { STATE_NAMES, TERRITORIES, isUnicameral, executiveOf, prefixOf, billKey, displayNumber };

// The event facts a card may use (contract facts keys). Anything else in facts is dropped.
export const EVENT_FACT_KEYS = ['chamber', 'committee', 'vote', 'agency', 'title', 'number', 'comments_close', 'deadline', 'document_number', 'court', 'docket', 'judge', 'nominee', 'position', 'location', 'time', 'executive', 'law_number', 'effective', 'hearing_date'];
const MAX_SUMMARY = 260;

// The chamber a bill started in, from its number's prefix. It no longer drives any wording (no next step is stated since review r5); kept
// for the bank matrix. Maine's LD (Legislative Document) does not say the chamber (review r5 M2): null, like any unknown prefix.
export function originOf(number, j) {
  const x = prefixInfo(number, j);
  if (!x) return null;
  if (isUnicameral(j)) return unicameralBody(j);
  return x.chamber === 'upper' ? upperOf(j) : x.chamber === 'lower' ? lowerOf(j) : null;
}
// Resolutions and memorials (review r4 #8, r5 L1): simple, concurrent and joint resolutions, memorials and constitutional amendments, by
// the table's prefix kinds. A resolution is never "signed into law".
export function isResolution(number, j) {
  const x = prefixInfo(number, j);
  return !!x && (x.kind === 'resolution' || x.kind === 'constitutional amendment');
}
// Constitutional amendments, per jurisdiction where the prefix is the state's own (review r5 M4): California ACA/SCA, New Jersey's ACR/SCR,
// Nebraska LRCA. A federal joint resolution may propose one, but its number does not say: not claimed either way.
export function isConstitutionalAmendment(number, j) {
  const x = prefixInfo(number, j);
  return !!x && x.kind === 'constitutional amendment';
}
// A measure that does not go to the executive (review r5 M4): every state resolution and memorial (joint resolutions and constitutional
// amendments included) and a federal simple or concurrent resolution. A federal joint resolution goes to the President. Such a measure
// never gets executive wording ("sent to the Governor", "signs", "into law").
export function skipsExecutive(number, j) {
  const x = prefixInfo(number, j);
  return !!x && x.skips_executive;
}
// A simple resolution (review r6 #5): one chamber's own resolution. It never passes "both chambers" and has no both-chambers stage.
export function isSimpleResolution(number, j) {
  const x = prefixInfo(number, j);
  return !!x && x.simple;
}
// "Into law" / "enacts" only for a known bill number that is not a resolution, where the jurisdiction allows law wording (review r4 #4, #8;
// r5: unknown number -> no).
export const lawWording = (number, j) => !!number && !!prefixOf(number, j) && lawWordingAllowed(j) && !isResolution(number, j) && !skipsExecutive(number, j);
const chamberName = (j, chamber) => {
  const c = String(chamber || '').toLowerCase();
  if (/senate|upper/.test(c)) return upperOf(j);
  if (/assembly/.test(c)) return /assembly/i.test(lowerOf(j)) ? lowerOf(j) : 'Assembly';
  if (/^legislature$|^council$/.test(c)) return unicameralBody(j) || 'Legislature'; // review r7 L2
  if (/house|lower/.test(c)) return lowerOf(j);
  return chamber ? String(chamber) : null;
};

// The stage a card may carry (review r6): only what its OWN event class proves by itself, never inferred from other events.
// executive-signature -> signed (not for a resolution or a territory); became-law -> law only with valid law wording; enrolled ->
// passed-both only in a two-chamber legislature for a known number that is not a simple resolution. Everything else: none (omitted).
export function ownStageCode(cls, j, number = null) {
  switch (cls) {
    case 'executive-signature': return number && !isResolution(number, j) && namesExecutive(j) ? 'signed' : null;
    case 'became-law': return lawWording(number, j) ? 'law' : null;
    case 'enrolled': return !isUnicameral(j) && number && prefixOf(number, j) && !isSimpleResolution(number, j) ? 'passed-both' : null;
    default: return null;
  }
}
// Where the measure stands, in words, after this event: only what the record shows happened (review r5: no next step is ever stated).
// Built from this event alone (review r6: nothing from other events); "both chambers" only for an enrolment that is not a simple resolution.
export function stageOf(cls, j, f = {}) {
  const ch = chamberName(j, f.chamber), skip = skipsExecutive(f.number, j) || !namesExecutive(j), exec = executiveOf(j);
  const both = isUnicameral(j) ? `Passed the ${unicameralBody(j)}` : 'Passed both chambers';
  switch (cls) {
    case 'introduction': return 'Introduced';
    case 'referral-committee': case 'hearing-scheduled': case 'hearing-held': return 'In committee';
    case 'committee-passage': return 'Passed committee';
    case 'committee-failure': return 'Failed in committee';
    case 'passage': return ch ? `Passed the ${ch}` : null;
    case 'failure': return ch ? `Failed in the ${ch}` : null;
    case 'amendment-passage': return 'Amended';
    case 'concurrence': return ch ? `Concurred in the ${ch}` : null;
    case 'enrolled': return isSimpleResolution(f.number, j) ? 'Enrolled' : both;
    case 'executive-receipt': return skip ? null : `Sent to ${exec}`;
    case 'executive-signature': return lawWording(f.number, j) && namesExecutive(j) ? 'Signed into law' : 'Signed';
    case 'became-law': return lawWording(f.number, j) ? 'Became law' : null; // review r6 #1: never for a resolution or amendment
    case 'executive-veto': return 'Vetoed';
    case 'veto-override-passage': return ch ? `Override vote passed the ${ch}` : null; // one chamber's vote is not the veto overridden (review r7 M1)
    case 'withdrawal': return 'Withdrawn';
    case 'carried-over': return 'Carried over';
    case 'new-text-version': return 'New text published';
    case 'crs-report': return 'CRS report published';
    case 'cbo-estimate': return 'CBO cost estimate published';
    case 'agency-rule-proposed': return 'Proposed rule';
    case 'comment-period-open': return 'Comment period open';
    case 'comment-period-closing': return 'Comment period closing';
    case 'agency-rule-final': return 'Final rule';
    case 'executive-order': return 'Executive order signed';
    case 'presidential-memo': return 'Presidential memorandum issued';
    case 'agency-guidance': return 'Guidance issued';
    case 'nomination': return 'Nomination received';
    case 'court-filing': return 'Filed in court';
    case 'court-ruling': return 'Court ruling';
    default: return null;
  }
}

// scheduled: the event has not happened yet (a scheduled hearing, a future date, a comment period that closes later); held otherwise.
// A hearing-scheduled event is dated the day it was first seen; the hearing day is facts.hearing_date (contract, 29 Oct).
export const timingOf = (ev, today) => {
  const day = ev.class === 'hearing-scheduled' && ev.facts && ev.facts.hearing_date ? ev.facts.hearing_date : ev.date;
  if (ev.class === 'hearing-scheduled') return !today || day >= today ? 'scheduled' : 'held';
  return ev.class === 'comment-period-closing' || (today && day > today) ? 'scheduled' : 'held';
};

// The bill's number: from the event facts, else the front of the entry's short name / title (up to the first word that is not a number).
const BILL_NO = /(?<![A-Za-z.])\b(?:H\.\s?R\.|S\.\s?B\.|H\.\s?B\.|A\.\s?B\.|S\.|A\.|H\.|SB|HB|AB|HF|SF|LB)\s?\d{1,5}(?:-[A-Z])?\b/g;
export function billNumbers(s) { return [...String(s || '').matchAll(BILL_NO)].map((m) => m[0]); }

// The first clause of the mechanism (to the first ";" or sentence end), section citations removed, at most MAX_SUMMARY characters.
// A clause that is a note on what was read, not what the measure does.
const READING_NOTE = /\b(?:text|complaint|analysis|bill) (?:\([^)]*\) )?read\b|\bnot read\b|\bread in part\b|\blinked\b/i;
// Sections whose mechanism describes a measure (bills, laws, orders, rules). Litigation (G.2) and the excluded list (J) carry the
// tracker's own commentary, so no summary is taken from them.
export const SUMMARY_SECTIONS = new Set(['A', 'B', 'B.2', 'C', 'D', 'E', 'F', 'G', 'G.3', 'H', 'I']);
export const DEAD_END = new Set(['withdrawal', 'failure', 'committee-failure', 'executive-veto']);
// A summary is quoted only when it reads as a whole sentence about what the measure does: it starts with a capital and with the measure as
// its subject (a verb such as "Requires", or "The bill/act/order ..."), has no parenthetical aside left once section references are
// removed, and no editorial or meta words ("earlier drafts", "said", "reportedly", "note", "see", "cf.", "tracker"). Otherwise null: the
// fact sheet then has no "What it does" (review r4: "(earlier drafts said 2027)", "IVO proposes which specific risks it will verify").
const META = /\b(earlier drafts?|drafts? said|said|says|reportedly|note[sd]?|see|cf\.?|tracker|we|our|unclear|apparently|seems?|arguably)\b/i;
const WHAT_IT_DOES = /^(?:(?:The|This) (?:bill|act|law|measure|order|resolution|rule|statute|proposal)\b|It\b|Would\b|(?:Requires|Prohibits|Creates|Establishes|Directs|Bans|Mandates|Imposes|Sets|Allows|Authorizes|Amends|Applies|Defines|Gives|Bars|Makes|Provides|Covers|Adds|Expands|Repeals|Preempts|Limits|Restricts|Orders|Instructs|Tasks|Requests|Calls|Codifies|Extends|Exempts|Protects|Funds)\b)/;
export function summaryUsable(s) {
  const t = String(s || '').trim();
  return t.length >= 40 && /^[A-Z]/.test(t) && WHAT_IT_DOES.test(t) && !/[()]/.test(t) && !META.test(t) && !READING_NOTE.test(t);
}
export function summaryOf(mechanism) {
  const parts = String(mechanism || '').split(/;\s|(?<=[a-z]{4}|\))\.\s+(?=[A-Z])/).map((x) => x.trim());
  const clean = (x) => x.replace(/\s*\((?:§|Sec\.?|Section)[^()]*(?:\([^()]*\)[^()]*)*\)/g, '').replace(/\s+/g, ' ').trim();
  let s = clean(parts.find((x) => summaryUsable(clean(x))) || '');
  if (s.length > MAX_SUMMARY) s = s.slice(0, s.lastIndexOf(' ', MAX_SUMMARY)).replace(/[,;:\s]+$/, '');
  return s || null;
}

// event: a contract Event; entry: its tracker entry (or null for a non-bill event with no entry). today: YYYY-MM-DD.
export function buildFactSheet(event, entry = null, { today = null } = {}) {
  const ev = event || {}, f = ev.facts || {}, j = ev.jurisdiction || (entry && (entry.state || (entry.level === 'federal' ? 'US' : null))) || 'US';
  const facts = {};
  for (const k of EVENT_FACT_KEYS) if (f[k] != null && f[k] !== '') facts[k] = k === 'vote' ? { yes: Number(f.vote.yes), no: Number(f.vote.no) } : String(f[k]);
  if (facts.vote && !(Number.isInteger(facts.vote.yes) && Number.isInteger(facts.vote.no))) delete facts.vote;
  if (facts.chamber) facts.chamber = chamberName(j, facts.chamber);
  const nums = billNumbers(f.number || '').concat(entry ? billNumbers(entry.short_name || '') : []);
  // the record's own number, shown without the jurisdiction prefix LegiScan adds ("CA AB1405" -> "AB 1405"); without one, the entry's
  // number only when the entry names exactly one bill (review r5 M6: "S. 1792 / H.R. 3460" never lends S. 1792 to a House action)
  const own = f.number ? displayNumber(String(f.number), j) : null, entryNums = [...new Set((entry ? billNumbers(entry.short_name || '') : []).map((x) => billKey(x, j)))];
  const number = own || (entryNums.length === 1 ? nums[0] || null : null), skip = skipsExecutive(number, j) || !namesExecutive(j);
  if (skip) delete facts.executive; // a measure that skips the executive is never said to be signed or vetoed by one (review r5 M4)
  const stage = stageOf(ev.class, j, { ...f, number, chamber: facts.chamber });
  const stage_code = ownStageCode(ev.class, j, number);
  return {
    // on_amendments: the official words say the concurrence is in amendments (review r7 M3a); only then may a card say so
    event: { class: ev.class, date: ev.date, timing: timingOf(ev, today), ...facts, ...(ev.class === 'concurrence' && [f.action, ...(Array.isArray(f.actions) ? f.actions : [])].some((x) => /\bamendments?\b/i.test(String(x || ''))) && !/conference report/i.test(String(f.action || '')) ? { on_amendments: true } : {}) },
    bill: {
      number,
      numbers: [...new Set(nums)],
      short_title: entry ? entry.short_name || null : (f.title ? String(f.title) : null),
      jurisdiction: j,
      jurisdiction_name: STATE_NAMES[j] || j,
      executive: skip ? null : executiveOf(j),
      resolution: isResolution(number, j),
      law_wording: lawWording(number, j) && namesExecutive(j), // "signed into law" / "enacts"
      became_law_ok: lawWording(number, j), // "became law", for a became-law record only (territories included)
      simple_resolution: isSimpleResolution(number, j)
    },
    stage, stage_code,
    // A measure that died (withdrawn, failed, vetoed) gets no summary: its mechanism is written in the present tense of a live bill.
    verified: entry && SUMMARY_SECTIONS.has(entry.section) && !DEAD_END.has(ev.class) ?{ summary: summaryOf(entry.mechanism) } : {},
    milestones: Array.isArray(f.milestone) ? f.milestone.map(String) : f.milestone ? [String(f.milestone)] : []
  };
}

// Every string in the sheet, joined: what the checks match names, numbers and dates against.
export function sheetText(sheet) {
  const out = [];
  const walk = (v) => { if (v == null) return; if (typeof v === 'object') Object.values(v).forEach(walk); else out.push(String(v)); };
  walk(sheet);
  return out.join(' \n ');
}
