// The closed fact sheet a news card may be written from (news/writer.mjs). Plain code, no AI, no network.
// Built from one Event (news/CONTRACT.md) and its tracker entry (web/data/v2/entries.json). It holds only:
//   event     the official record's own facts (class, date, timing, chamber, committee, vote, agency, deadline, court, ...)
//   bill      identity: number, short title, jurisdiction
//   stage     where the measure stands after this event: only what the record shows happened (no next step is ever stated, review r5)
//   verified  the entry's reading fields that the field eval / self-correction keep checked (publish/guards.mjs READING_FIELDS:
//             mechanism, thresholds, penalties); only the first clause of the mechanism is carried, as a one-line summary
//   milestones facts.milestone strings an official record states ("first state law ..."); empty means "first/only/largest" is refused
// Nothing else: no press release text, no web page, no entry status_text (hand-written prose that is not field-checked).

export const STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', US: 'United States' };

// The event facts a card may use (contract facts keys). Anything else in facts is dropped.
export const EVENT_FACT_KEYS = ['chamber', 'committee', 'vote', 'agency', 'title', 'number', 'comments_close', 'deadline', 'document_number', 'court', 'docket', 'judge', 'nominee', 'position', 'location', 'time', 'executive', 'law_number', 'effective', 'hearing_date'];
const MAX_SUMMARY = 260;

// Chambers by jurisdiction, and who acts on a passed measure.
const LOWER = { CA: 'Assembly', NY: 'Assembly', NV: 'Assembly', WI: 'Assembly', NJ: 'General Assembly' };
const lowerOf = (j) => j === 'US' ? 'House' : LOWER[j] || 'House';
const UNICAMERAL = new Set(['NE', 'DC']);
export const isUnicameral = (j) => UNICAMERAL.has(j);
// Who acts on a passed measure: the President, the Mayor of the District of Columbia, else the Governor (review r4 #4).
export const executiveOf = (j) => (j === 'US' ? 'the President' : j === 'DC' ? 'the Mayor' : 'the Governor');

// The letters before a bill number's digits, upper case, without dots or spaces ("H.Con.Res. 5" -> HCONRES, "KS HR6023" -> HR, "CA ACA 1"
// -> ACA). The jurisdiction's own prefix ("CA SB 53", LegiScan) is dropped. null when there is no number.
export function prefixOf(number, j) {
  let t = String(number || '').trim();
  if (j && t.toUpperCase().startsWith(`${j} `) && /^[A-Z]{2} +[A-Za-z]/.test(t)) t = t.slice(j.length + 1);
  const m = /^\s*([A-Za-z][A-Za-z.\s]{0,12}?)\s*\.?\s*\d/.exec(t);
  return m ? m[1].replace(/[.\s]/g, '').toUpperCase() : null;
}
// The chamber a bill started in, from its number's prefix. It no longer drives any wording (no next step is stated since review r5); kept
// for the bank matrix. Maine's LD (Legislative Document) does not say the chamber (review r5 M2): null, like any unknown prefix.
export function originOf(number, j) {
  const p = prefixOf(number, j);
  if (!p) return null;
  if (UNICAMERAL.has(j)) return j === 'NE' ? 'Legislature' : 'Council';
  if (/^(S|SB|SF|SJR|SCR|SR|SJ|SC|SM|SP|SJRES|SCONRES|SRES|SCA)$/.test(p)) return 'Senate';
  if (/^(H|HR|HB|HF|HJR|HCR|HJ|HC|HM|HP|HJRES|HCONRES|HRES|A|AB|AJR|ACR|AR|ACA)$/.test(p)) return lowerOf(j);
  return null;
}
// Resolutions and memorials (review r4 #8, r5 L1): simple, concurrent and joint resolutions in every spelling states use (HR/SR/AR,
// HCR/SCR/ACR, HJR/SJR/AJR, Montana's HJ/SJ, HC/SC, memorials HM/SM/AM, HRES/SRES, Nebraska's LR, DC's PR/CER), plus constitutional
// amendments. A resolution is never "signed into law".
const RESOLUTION_PREFIX = /^(HR|SR|AR|R|HRES|SRES|ARES|HCR|SCR|ACR|HCONRES|SCONRES|HC|SC|HJR|SJR|AJR|HJRES|SJRES|HJ|SJ|HM|SM|AM|HMR|SMR|HJM|SJM|HCM|SCM|LR|LRCA|PR|CER|HCA|SCA|ACA|HJRCA|SJRCA)$/;
// Constitutional amendments, per jurisdiction where the prefix is the state's own (review r5 M4): California ACA/SCA, New Jersey's
// ACR/SCR (concurrent resolutions proposing amendments), Nebraska LRCA; elsewhere the common HCA/SCA/ACA/HJRCA/SJRCA. A state joint
// resolution often is one too, which is why every state resolution skips the executive (skipsExecutive).
const CONSTITUTIONAL = { CA: /^(ACA|SCA)$/, NJ: /^(ACR|SCR)$/, NE: /^LRCA$/ };
const CONSTITUTIONAL_ANY = /^(HCA|SCA|ACA|HJRCA|SJRCA|LRCA)$/;
export function isResolution(number, j) {
  const p = prefixOf(number, j);
  if (!p) return false;
  if (j === 'US') return /RES$/.test(p);
  return RESOLUTION_PREFIX.test(p);
}
export function isConstitutionalAmendment(number, j) {
  const p = prefixOf(number, j);
  if (!p || j === 'US') return false; // a federal joint resolution may propose one, but its number does not say: not claimed either way
  return !!((CONSTITUTIONAL[j] && CONSTITUTIONAL[j].test(p)) || CONSTITUTIONAL_ANY.test(p));
}
// A measure that does not go to the executive (review r5 M4): every state resolution and memorial (joint resolutions and constitutional
// amendments included) and a federal simple or concurrent resolution (H.Res, S.Res, H.Con.Res, S.Con.Res). A federal joint resolution
// goes to the President. Such a measure never gets executive wording ("sent to the Governor", "signs", "into law").
export function skipsExecutive(number, j) {
  const p = prefixOf(number, j);
  if (!p) return false;
  if (j === 'US') return /^(HRES|SRES|HCONRES|SCONRES)$/.test(p);
  return isResolution(number, j) || isConstitutionalAmendment(number, j);
}
// "Into law" / "enacts" only for a known bill number that is not a resolution, outside DC (review r4 #4, #8; r5: unknown number -> no).
export const lawWording = (number, j) => !!number && !!prefixOf(number, j) && j !== 'DC' && !isResolution(number, j) && !skipsExecutive(number, j);
const chamberName = (j, chamber) => {
  const c = String(chamber || '').toLowerCase();
  if (/senate|upper/.test(c)) return 'Senate';
  if (/assembly/.test(c)) return LOWER[j] || 'Assembly';
  if (/house|lower/.test(c)) return lowerOf(j);
  return chamber ? String(chamber) : null;
};

// The stage code an event proves by itself (review r5): only what its own class records. A concurrence or a veto-override vote does not
// prove both chambers passed; enrolment, receipt by the executive, signature and becoming law do. A failure proves no stage.
export function ownStageCode(cls, j, number = null) {
  switch (cls) {
    case 'introduction': return 'introduced';
    case 'referral-committee': case 'hearing-scheduled': case 'hearing-held': case 'committee-passage': case 'committee-failure': return 'committee';
    case 'passage': case 'concurrence': return 'passed-chamber';
    case 'enrolled': case 'executive-receipt': return 'passed-both';
    case 'executive-signature': return lawWording(number, j) ? 'law' : 'passed-both';
    case 'became-law': return isResolution(number, j) ? 'passed-both' : 'law';
    default: return null;
  }
}
export const STAGE_RANK = { introduced: 0, committee: 1, 'passed-chamber': 2, 'passed-both': 3, law: 4 };
// The bill number events are compared on (review r5 M6): letters and digits only, the jurisdiction prefix and leading zeros dropped, a
// trailing print letter (NY "A6453B") dropped. null when there is none.
export function billKey(number, j) {
  let t = String(number || '').trim();
  if (!t) return null;
  if (j && t.toUpperCase().startsWith(`${j} `) && /^[A-Z]{2} +[A-Za-z]/.test(t)) t = t.slice(j.length + 1);
  const n = t.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]+)0+(?=\d)/, '$1').replace(/^([A-Z]+\d+)[A-Z]$/, '$1');
  return /^[A-Z]+\d+$/.test(n) ? n : null;
}
// A record's number as a card shows it: the jurisdiction prefix dropped and a space before the digits ("CA AB1405" -> "AB 1405"); any
// other spelling ("H.R. 3460", "S. 1405", "B 26-0123") is kept as the record gives it.
export function displayNumber(number, j) {
  let t = String(number || '').trim();
  if (j && t.toUpperCase().startsWith(`${j} `) && /^[A-Z]{2} +[A-Za-z]/.test(t)) t = t.slice(j.length + 1).trim();
  return /^[A-Z]+\d+[A-Z]?$/.test(t) ? t.replace(/^([A-Z]+)(\d)/, '$1 $2') : t;
}
// The stage the record proves for an event (review r5): the highest stage among this entry's own confirmed events up to the event's date,
// of the same bill when both give a number. "passed-both" also when confirmed passage/concurrence events exist for both chambers of a
// two-chamber legislature. null when nothing proves one. events: Event[]; confirmed(e) decides which count (the event itself always does).
export function provenStage(ev, events, confirmed = () => true) {
  if (!ev || !ev.entry_id) return null;
  const j = ev.jurisdiction, mine = billKey(ev.facts && ev.facts.number, j);
  const same = (e) => e === ev || (ev.key && e.key === ev.key);
  const pool = (events || []).filter((e) => e && !same(e) && e.entry_id === ev.entry_id && e.jurisdiction === j && e.date <= ev.date && confirmed(e)
    && !(mine && billKey(e.facts && e.facts.number, j) && billKey(e.facts && e.facts.number, j) !== mine));
  pool.push(ev);
  let best = null;
  for (const e of pool) { const c = ownStageCode(e.class, j, e.facts && e.facts.number); if (c && (best == null || STAGE_RANK[c] > STAGE_RANK[best])) best = c; }
  if (!UNICAMERAL.has(j) && (best == null || STAGE_RANK[best] < STAGE_RANK['passed-both'])) {
    const ch = new Set(pool.filter((e) => e.class === 'passage' || e.class === 'concurrence').map((e) => chamberName(j, e.facts && e.facts.chamber)).filter(Boolean));
    if (ch.has('Senate') && [...ch].some((c) => c !== 'Senate')) best = 'passed-both';
  }
  return best;
}

// Where the measure stands, in words, after this event: only what the record shows happened (review r5: no next step is ever stated).
// proven: the stage code provenStage gives; "passed both chambers" is written only when it is 'passed-both' or 'law' or the class proves it.
export function stageOf(cls, j, f = {}, proven = null) {
  const ch = chamberName(j, f.chamber), skip = skipsExecutive(f.number, j), exec = executiveOf(j);
  const bothProved = cls === 'enrolled' || proven === 'passed-both' || proven === 'law';
  const both = UNICAMERAL.has(j) ? (j === 'NE' ? 'Passed the Legislature' : 'Passed the Council') : 'Passed both chambers';
  switch (cls) {
    case 'introduction': return 'Introduced';
    case 'referral-committee': case 'hearing-scheduled': case 'hearing-held': return 'In committee';
    case 'committee-passage': return 'Passed committee';
    case 'committee-failure': return 'Failed in committee';
    case 'passage': return ch ? `Passed the ${ch}` : null;
    case 'failure': return ch ? `Failed in the ${ch}` : null;
    case 'amendment-passage': return 'Amended';
    case 'concurrence': return bothProved ? both : ch ? `Concurred in the ${ch}` : null;
    case 'enrolled': return both;
    case 'executive-receipt': return skip ? null : `Sent to ${exec}`;
    case 'executive-signature': return lawWording(f.number, j) ? 'Signed into law' : 'Signed';
    case 'became-law': return 'Became law'; // the record's own words for this class
    case 'executive-veto': return 'Vetoed';
    case 'veto-override-passage': return ch ? `Veto overridden in the ${ch}` : null;
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
export function buildFactSheet(event, entry = null, { today = null, proven = null } = {}) {
  const ev = event || {}, f = ev.facts || {}, j = ev.jurisdiction || (entry && (entry.state || (entry.level === 'federal' ? 'US' : null))) || 'US';
  const facts = {};
  for (const k of EVENT_FACT_KEYS) if (f[k] != null && f[k] !== '') facts[k] = k === 'vote' ? { yes: Number(f.vote.yes), no: Number(f.vote.no) } : String(f[k]);
  if (facts.vote && !(Number.isInteger(facts.vote.yes) && Number.isInteger(facts.vote.no))) delete facts.vote;
  if (facts.chamber) facts.chamber = chamberName(j, facts.chamber);
  const nums = billNumbers(f.number || '').concat(entry ? billNumbers(entry.short_name || '') : []);
  // the record's own number, shown without the jurisdiction prefix LegiScan adds ("CA AB1405" -> "AB 1405"); without one, the entry's
  // number only when the entry names exactly one bill (review r5 M6: "S. 1792 / H.R. 3460" never lends S. 1792 to a House action)
  const own = f.number ? displayNumber(String(f.number), j) : null, entryNums = [...new Set((entry ? billNumbers(entry.short_name || '') : []).map((x) => billKey(x, j)))];
  const number = own || (entryNums.length === 1 ? nums[0] || null : null), skip = skipsExecutive(number, j);
  if (skip) delete facts.executive; // a measure that skips the executive is never said to be signed or vetoed by one (review r5 M4)
  const stage = stageOf(ev.class, j, { ...f, number, chamber: facts.chamber }, proven);
  const ownCode = ownStageCode(ev.class, j, number);
  const stage_code = proven && (!ownCode || STAGE_RANK[proven] >= STAGE_RANK[ownCode]) ? proven : ownCode;
  return {
    event: { class: ev.class, date: ev.date, timing: timingOf(ev, today), ...facts },
    bill: {
      number,
      numbers: [...new Set(nums)],
      short_title: entry ? entry.short_name || null : (f.title ? String(f.title) : null),
      jurisdiction: j,
      jurisdiction_name: STATE_NAMES[j] || j,
      executive: skip ? null : executiveOf(j),
      resolution: isResolution(number, j),
      law_wording: lawWording(number, j)
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
