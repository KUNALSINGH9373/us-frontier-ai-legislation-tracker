// The closed fact sheet a news card may be written from (news/writer.mjs). Plain code, no AI, no network.
// Built from one Event (news/CONTRACT.md) and its tracker entry (web/data/v2/entries.json). It holds only:
//   event     the official record's own facts (class, date, timing, chamber, committee, vote, agency, deadline, court, ...)
//   bill      identity: number, short title, jurisdiction
//   stage     where the measure stands after this event: only what the record shows happened (no next step is ever stated, review r5)
//   verified  the entry's reading fields that the field eval / self-correction keep checked (publish/guards.mjs READING_FIELDS:
//             mechanism, thresholds, penalties); only the first clause of the mechanism is carried, as a one-line summary
//   milestones facts.milestone strings an official record states ("first state law ..."); empty means "first/only/largest" is refused
// Nothing else: no press release text, no web page, no entry status_text (hand-written prose that is not field-checked).

export const STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', AS: 'American Samoa', MP: 'Northern Mariana Islands', US: 'United States' };
// Territories (review r6 #7): no executive is named and no law claim is made except a became-law record with valid law wording.
export const TERRITORIES = new Set(['PR', 'GU', 'VI', 'AS', 'MP']);

// The event facts a card may use (contract facts keys). Anything else in facts is dropped.
export const EVENT_FACT_KEYS = ['chamber', 'committee', 'vote', 'agency', 'title', 'number', 'comments_close', 'deadline', 'document_number', 'court', 'docket', 'judge', 'nominee', 'position', 'location', 'time', 'executive', 'law_number', 'effective', 'hearing_date'];
const MAX_SUMMARY = 260;

// Chambers by jurisdiction, and who acts on a passed measure.
const LOWER = { CA: 'Assembly', NY: 'Assembly', NV: 'Assembly', WI: 'Assembly', NJ: 'General Assembly' };
const lowerOf = (j) => j === 'US' ? 'House' : LOWER[j] || 'House';
const UNICAMERAL = new Set(['NE', 'DC', 'GU', 'VI']);
export const isUnicameral = (j) => UNICAMERAL.has(j);
// Who acts on a passed measure: the President, the Mayor of the District of Columbia, else the Governor (review r4 #4).
export const executiveOf = (j) => (TERRITORIES.has(j) ? null : j === 'US' ? 'the President' : j === 'DC' ? 'the Mayor' : 'the Governor');

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
  if (UNICAMERAL.has(j)) return j === 'DC' ? 'Council' : 'Legislature';
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
// A simple resolution (review r6 #5): one chamber's own resolution (HR/SR/AR/R/HRES/SRES/ARES in a state, H.Res/S.Res federally). It never
// passes "both chambers" and has no both-chambers stage.
export function isSimpleResolution(number, j) {
  const p = prefixOf(number, j);
  if (!p) return false;
  if (j === 'US') return /^(HRES|SRES)$/.test(p);
  return /^(HR|SR|AR|R|HRES|SRES|ARES)$/.test(p);
}
// "Into law" / "enacts" only for a known bill number that is not a resolution, outside DC (review r4 #4, #8; r5: unknown number -> no).
export const lawWording = (number, j) => !!number && !!prefixOf(number, j) && j !== 'DC' && !isResolution(number, j) && !skipsExecutive(number, j);
const chamberName = (j, chamber) => {
  const c = String(chamber || '').toLowerCase();
  if (/senate|upper/.test(c)) return 'Senate';
  if (/assembly/.test(c)) return LOWER[j] || 'Assembly';
  if (/^legislature$|^council$/.test(c)) return j === 'DC' ? 'Council' : 'Legislature'; // review r7 L2
  if (/house|lower/.test(c)) return lowerOf(j);
  return chamber ? String(chamber) : null;
};

// The stage a card may carry (review r6): only what its OWN event class proves by itself, never inferred from other events.
// executive-signature -> signed (not for a resolution or a territory); became-law -> law only with valid law wording; enrolled ->
// passed-both only in a two-chamber legislature for a known number that is not a simple resolution. Everything else: none (omitted).
export function ownStageCode(cls, j, number = null) {
  switch (cls) {
    case 'executive-signature': return number && !isResolution(number, j) && !TERRITORIES.has(j) ? 'signed' : null;
    case 'became-law': return lawWording(number, j) ? 'law' : null;
    case 'enrolled': return !UNICAMERAL.has(j) && number && prefixOf(number, j) && !isSimpleResolution(number, j) ? 'passed-both' : null;
    default: return null;
  }
}
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
// Where the measure stands, in words, after this event: only what the record shows happened (review r5: no next step is ever stated).
// Built from this event alone (review r6: nothing from other events); "both chambers" only for an enrolment that is not a simple resolution.
export function stageOf(cls, j, f = {}) {
  const ch = chamberName(j, f.chamber), skip = skipsExecutive(f.number, j) || TERRITORIES.has(j), exec = executiveOf(j);
  const both = UNICAMERAL.has(j) ? (j === 'NE' ? 'Passed the Legislature' : 'Passed the Council') : 'Passed both chambers';
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
    case 'executive-signature': return lawWording(f.number, j) && !TERRITORIES.has(j) ? 'Signed into law' : 'Signed';
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
  const number = own || (entryNums.length === 1 ? nums[0] || null : null), skip = skipsExecutive(number, j) || TERRITORIES.has(j);
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
      law_wording: lawWording(number, j) && !TERRITORIES.has(j), // "signed into law" / "enacts"
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
