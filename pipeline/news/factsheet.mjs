// The closed fact sheet a news card may be written from (news/writer.mjs). Plain code, no AI, no network.
// Built from one Event (news/CONTRACT.md) and its tracker entry (web/data/v2/entries.json). It holds only:
//   event     the official record's own facts (class, date, timing, chamber, committee, vote, agency, deadline, court, ...)
//   bill      identity: number, short title, jurisdiction
//   stage     where the measure stands after this event, and next: the one next step code derives from the class (never the AI's guess)
//   verified  the entry's reading fields that the field eval / self-correction keep checked (publish/guards.mjs READING_FIELDS:
//             mechanism, thresholds, penalties); only the first clause of the mechanism is carried, as a one-line summary
//   milestones facts.milestone strings an official record states ("first state law ..."); empty means "first/only/largest" is refused
// Nothing else: no press release text, no web page, no entry status_text (hand-written prose that is not field-checked).

export const STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', US: 'United States' };

// The event facts a card may use (contract facts keys). Anything else in facts is dropped.
export const EVENT_FACT_KEYS = ['chamber', 'committee', 'vote', 'agency', 'title', 'number', 'comments_close', 'deadline', 'document_number', 'court', 'docket', 'judge', 'nominee', 'position', 'location', 'time', 'executive', 'law_number', 'effective', 'hearing_date'];
// Contract "Decisions 29 Oct": news items carry stage as one of these codes.
export const STAGE_CODE = { introduction: 'introduced', 'referral-committee': 'committee', 'hearing-scheduled': 'committee', 'hearing-held': 'committee', 'committee-passage': 'committee', 'committee-failure': 'committee', passage: 'passed-chamber', failure: 'passed-chamber', 'amendment-passage': null, concurrence: 'passed-both', enrolled: 'passed-both', 'executive-receipt': 'passed-both', 'executive-veto': 'passed-both', 'veto-override-passage': 'passed-both', 'executive-signature': 'law', 'became-law': 'law' };
const MAX_SUMMARY = 260;

// Chambers by jurisdiction: the other chamber after a passage, and who signs.
const LOWER = { CA: 'Assembly', NY: 'Assembly', NV: 'Assembly', WI: 'Assembly', NJ: 'General Assembly' };
const lowerOf = (j) => j === 'US' ? 'House' : LOWER[j] || 'House';
const upperOf = () => 'Senate';
const UNICAMERAL = new Set(['NE', 'DC']);
export const isUnicameral = (j) => UNICAMERAL.has(j);
// Who acts on a passed measure: the President, the Mayor of the District of Columbia, else the Governor (review r4 #4).
export const executiveOf = (j) => (j === 'US' ? 'the President' : j === 'DC' ? 'the Mayor' : 'the Governor');
// The chamber a bill started in, from its number's prefix (review r4 #1): AB / A. / HB / H.R. / HF / HJR ... -> the lower chamber; SB / S. /
// SF / SJR ... -> the Senate; Nebraska's LB and DC's B -> the one chamber. null when the prefix does not say.
export function originOf(number, j) {
  const m = /^\s*([A-Za-z][A-Za-z.\s]{0,6}?)\s*\.?\s*\d/.exec(String(number || '').replace(/^[A-Z]{2}\s+(?=[A-Z])/, (x) => (j && x.trim() === j ? '' : x)));
  if (!m) return null;
  const p = m[1].replace(/[.\s]/g, '').toUpperCase();
  if (UNICAMERAL.has(j)) return j === 'NE' ? 'Legislature' : 'Council';
  if (/^(S|SB|SF|SJR|SCR|SR|SJ|SC|SM|SP|SJRES|SCONRES|SRES)$/.test(p)) return 'Senate';
  if (/^(H|HR|HB|HF|HJR|HCR|HJ|HC|HM|HP|HJRES|HCONRES|HRES|A|AB|AJR|ACR|AR|LD)$/.test(p)) return lowerOf(j);
  return null;
}
// A resolution is not "signed into law" (review r4 #8).
export function isResolution(number, j) {
  const t = String(number || "").trim();
  if (j === "US" || /^(H|S)\.\s?(J\.\s?|Con\.\s?)?Res/i.test(t)) return /\bRes\b/i.test(t);
  const u = (j && t.startsWith(`${j} `) ? t.slice(j.length + 1) : t).replace(/[.\s]/g, "").toUpperCase(); // "KS HR6023" -> HR6023
  return /^(HR|SR|AR|HJR|SJR|AJR|HCR|SCR|ACR|HRES|SRES|R)\d/.test(u);
}
const otherChamber = (j, chamber) => {
  if (UNICAMERAL.has(j)) return null;
  const c = String(chamber || '').toLowerCase();
  if (/senate|upper/.test(c)) return lowerOf(j);
  if (/house|assembly|lower/.test(c)) return upperOf(j);
  return null;
};
const chamberName = (j, chamber) => {
  const c = String(chamber || '').toLowerCase();
  if (/senate|upper/.test(c)) return 'Senate';
  if (/assembly/.test(c)) return LOWER[j] || 'Assembly';
  if (/house|lower/.test(c)) return lowerOf(j);
  return chamber ? String(chamber) : null;
};

// Stage after the event and the one next step code may state (null when there is no fixed next step).
export function stageAndNext(cls, j, f = {}) {
  const ch = chamberName(j, f.chamber), other = otherChamber(j, f.chamber), exec = executiveOf(j), committee = f.committee || 'committee';
  const origin = originOf(f.number, j), both = UNICAMERAL.has(j) ? (j === 'NE' ? 'Passed the Legislature' : 'Passed the Council') : 'Passed both chambers';
  switch (cls) {
    case 'introduction': return { stage: 'Introduced', next: f.committee ? `consideration by the ${f.committee}` : 'referral to a committee' };
    case 'referral-committee': return { stage: 'In committee', next: `consideration by the ${committee}` };
    case 'hearing-scheduled': return { stage: 'In committee', next: null };
    case 'hearing-held': return { stage: 'In committee', next: null };
    // a committee may re-refer as often as send to the floor (review r4 #2): no fixed next step
    case 'committee-passage': return { stage: 'Passed committee', next: null };
    case 'committee-failure': return { stage: 'Failed in committee', next: null };
    // the other chamber is next only when this chamber is the one the bill started in (review r4 #1); a second-chamber passage, or an
    // unknown origin, states no next step
    case 'passage': return { stage: ch ? `Passed the ${ch}` : 'Passed one chamber', next: other && origin && ch === origin ? `consideration in the ${other}` : null };
    case 'failure': return { stage: ch ? `Failed in the ${ch}` : 'Failed a floor vote', next: null };
    case 'amendment-passage': return { stage: 'Amended', next: null };
    case 'concurrence': return { stage: both, next: `transmittal to ${exec}` };
    case 'enrolled': return { stage: both, next: `transmittal to ${exec}` };
    case 'executive-receipt': return { stage: `Sent to ${exec}`, next: `action by ${exec}` };
    case 'executive-signature': return { stage: j === 'DC' || isResolution(f.number, j) ? 'Signed' : 'Signed into law', next: null }; // a resolution or a DC act is not 'into law'
    case 'became-law': return { stage: 'Law', next: null };
    case 'executive-veto': return { stage: 'Vetoed', next: null };
    case 'veto-override-passage': return { stage: ch ? `Veto overridden in the ${ch}` : 'Veto overridden', next: null };
    case 'withdrawal': return { stage: 'Withdrawn', next: null };
    case 'carried-over': return { stage: 'Carried over', next: null };
    case 'new-text-version': return { stage: 'New text published', next: null };
    case 'crs-report': return { stage: 'CRS report published', next: null };
    case 'cbo-estimate': return { stage: 'CBO cost estimate published', next: null };
    case 'agency-rule-proposed': return { stage: 'Proposed rule', next: f.comments_close ? `public comments close on ${f.comments_close}` : null };
    case 'comment-period-open': return { stage: 'Comment period open', next: f.comments_close ? `public comments close on ${f.comments_close}` : null };
    case 'comment-period-closing': return { stage: 'Comment period closing', next: null };
    case 'agency-rule-final': return { stage: 'Final rule', next: f.effective ? `the rule takes effect on ${f.effective}` : null };
    case 'executive-order': return { stage: 'Executive order signed', next: null };
    case 'presidential-memo': return { stage: 'Presidential memorandum issued', next: null };
    case 'agency-guidance': return { stage: 'Guidance issued', next: null };
    case 'nomination': return { stage: 'Nomination received', next: null };
    case 'court-filing': return { stage: 'Filed in court', next: null };
    case 'court-ruling': return { stage: 'Court ruling', next: null };
    default: return { stage: null, next: null };
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
  const { stage, next } = stageAndNext(ev.class, j, { ...f, number: f.number || nums[0] || null, chamber: facts.chamber });
  return {
    event: { class: ev.class, date: ev.date, timing: timingOf(ev, today), ...facts },
    bill: {
      number: f.number ? String(f.number) : nums[0] || null,
      numbers: [...new Set(nums)],
      short_title: entry ? entry.short_name || null : (f.title ? String(f.title) : null),
      jurisdiction: j,
      jurisdiction_name: STATE_NAMES[j] || j,
      executive: executiveOf(j)
    },
    stage, stage_code: STAGE_CODE[ev.class] || null, next,
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
