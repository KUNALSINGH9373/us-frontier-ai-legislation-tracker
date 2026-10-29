// Official action strings -> news event classes (pipeline/news/CONTRACT.md). Code only, no AI.
// Built on Lane 1's own action typing, so the two lanes never disagree about what an action is:
//   Congress.gov  compare/congress.mjs actionKind        (checked against every stored Congress.gov action, compare/test.mjs)
//   state bills   grabber/sources/legiscan.mjs stateActionKind (checked against every stored LegiScan history step, grabber/test-legiscan.mjs)
//   court dockets grabber/sources/courtlistener.mjs classifyEntry
// Lane 1's kind decides whether an action is a step at all; this file only splits a step into the finer contract class. A step Lane 1
// calls procedural stays null here, with the few exceptions the contract names that Lane 1 has no milestone for (an executive receipt:
// "Presented to President", "Enrolled and presented to the Governor"). Anything this file cannot place is null: recorded, never shown.
// Per-jurisdiction rules (JURISDICTION_RULES) come first, for wordings one legislature uses in its own sense.
import { actionKind } from '../compare/congress.mjs';
import { stateActionKind } from '../grabber/sources/legiscan.mjs';
import { classifyEntry } from '../grabber/sources/courtlistener.mjs';

export const BILL_CLASSES = ['introduction', 'referral-committee', 'hearing-scheduled', 'hearing-held', 'committee-passage', 'committee-failure', 'passage', 'failure', 'amendment-passage', 'concurrence', 'enrolled', 'executive-receipt', 'executive-signature', 'executive-veto', 'became-law', 'veto-override-passage', 'withdrawal', 'carried-over', 'new-text-version', 'crs-report', 'cbo-estimate'];
export const NON_BILL_CLASSES = ['executive-order', 'presidential-memo', 'agency-rule-proposed', 'agency-rule-final', 'agency-guidance', 'comment-period-open', 'comment-period-closing', 'nomination', 'court-filing', 'court-ruling'];
export const EVENT_CLASSES = [...BILL_CLASSES, ...NON_BILL_CLASSES];

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const CHAMBER_WORD = { H: 'House', S: 'Senate', A: 'Assembly' };
// The chamber an action names, in its own words ("Passed Senate", "In Assembly. Read third time. Passed."), or null.
export function chamberOf(text, hint = null) {
  const t = clean(text);
  // the chamber that opens the action acts ("Senate concurs in House amendments": the Senate); "in House amendments" names the other
  // chamber's amendments, never the actor (review r5: found replaying the news set)
  const m = /^\W*(house|senate|assembly)\b(?! amendments?\b)/i.exec(t) || /\b(?:passed|failed(?: passage)? in|failed in|in|by) (?:the )?(house|senate|assembly)\b(?! amendments?\b)/i.exec(t) || /\b(house|senate|assembly) (?:floor|passage|vote|agreed|concurred|adopted)\b/i.exec(t);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return hint && CHAMBER_WORD[hint] ? CHAMBER_WORD[hint] : null;
}

// ---------- Congress.gov ----------
const PRESENTED_TO_PRESIDENT = /^\W*presented to (the )?president\b/i;
// action: a Congress.gov action ({ text, sourceSystem, type }) or its text. Returns the class or null.
export function classifyCongress(action) {
  const text = clean(typeof action === 'string' ? action : action && action.text);
  if (!text) return null;
  if (PRESENTED_TO_PRESIDENT.test(text)) return 'executive-receipt';
  const k = actionKind(text);
  switch (k.kind) {
    case 'enacted': return /became public law/i.test(text) ? 'became-law' : 'executive-signature';
    case 'veto_override': return 'veto-override-passage';
    case 'vetoed': return 'executive-veto';
    case 'failed_passage': return /over (the )?veto|objections of the president|veto overrid/i.test(text) ? null : 'failure'; // a failed override: the veto stands, already its own event
    case 'cleared': return k.importance === 85 ? 'concurrence' : null; // the clerk's "Cleared for White House." repeats the vote that cleared it
    case 'passed': return 'passage';
    case 'reported': case 'forwarded': return 'committee-passage';
    case 'hearing': return 'hearing-held';
    case 'introduced': return 'introduction';
    case 'referred': return 'referral-committee';
    default: return null; // procedural, and markup (a session, not an outcome: its result is the "ordered to be reported" line)
  }
}

// ---------- state legislatures (LegiScan history) ----------
// A legislature's own wording, first. Each rule: [regex, class]. Checked against the stored history steps (fixtures/news/action-strings.json).
export const JURISDICTION_RULES = {
  // California: the Secretary of State's chapter number is the bill becoming law; "Approved by the Governor" is the signature.
  CA: [[/^\W*chaptered by secretary of state\b/i, 'became-law'], [/^\W*approved by (the )?governor\b/i, 'executive-signature']],
  // New York: "SIGNED CHAP.123" is the governor's signature, which makes it a chapter of law that day.
  NY: [[/^\W*signed chap\.\s*\d+/i, 'executive-signature'], [/^\W*delivered to governor\b/i, 'executive-receipt']],
  // Hawaii: "Passed Second Reading ... and referred to the committee(s)" is a committee passage there (Lane 1 agrees).
  HI: [[/\bpass(?:ed)? second reading\b[^.]*\breferred to\b/i, 'committee-passage']]
};
const TO_GOVERNOR = /\b(presented|delivered|sent|transmitted|forwarded) to (the )?governor\b|\bto governor\b/i;
const CHAPTERED = /\bchaptered\b|\bsecretary of state\b[^.]*\bchapter \d+|\bbecame law\b|\bbecomes law without\b/i;
const GOV_SIGNED = /(signed|approved) by (the )?governor|\bgovernor (approved|signed)\b|^\W*signed chap\.\s*\d+/i;
const CONCUR = /\bagreed to by (the )?(house|senate|assembly)|\bamendments? concurred in\b|\bconcurred in\b/i;
const HEARING_SET = /\b(hearing (is |was )?(set|scheduled|noticed)|set for (public )?hearing|scheduled for (a )?(public )?hearing|has scheduled a (public )?hearing|notice of (public )?hearing)\b|^\W*hearing \d{1,2}\/\d{1,2}\b/i;
// A line-item or partial veto is not the bill's veto; a cancelled or postponed hearing is no hearing; a "committee" line that names no
// referral (a conference committee meeting) is no referral.
const NOT_WHOLE = /\bline[- ]?items?\b|\bspecific (line )?items?\b|\bin part\b|\bpartial\b/i, CANCELLED = /\bcancel+ed\b|\bpostponed\b|\bdeferred\b/i;
const REFERRAL = /\b(re-?)?refer(red|ral)?\b|\bto (the )?committee\b|\bsent to\b|\bto com(\.|mittee)/i;
// text: the history step; ctx: { jurisdiction, isFirst, chamber (LegiScan "H"/"S"/"A") }. Returns the class or null.
export function classifyState(text, ctx = {}) {
  const t = clean(text);
  if (!t) return null;
  const k = stateActionKind(t, !!ctx.isFirst);
  // a chamber agreeing to the other chamber's amendments, in the present tense ("Senate concurs in House amendments"): Lane 1 has no milestone
  // for this wording, the contract has a class (review r2 #8)
  if (/^\W*(house|senate|assembly) concurs? in (the )?(house|senate|assembly) amendments?\b/i.test(t) && !/\b(not|motion|refuses?)\b/i.test(t)) return 'concurrence';
  if (!k.type && !TO_GOVERNOR.test(t)) return null; // Lane 1 calls it routine or procedural: so does the news lane
  for (const [re, c] of JURISDICTION_RULES[ctx.jurisdiction] || []) if (re.test(t)) return c;
  if (TO_GOVERNOR.test(t) && !/\bmotion\b/i.test(t) && !['enacted', 'vetoed', 'veto_override', 'failed'].includes(k.kind)) return 'executive-receipt';
  if (/\brec(ommended|ommends)? for pass(age)?\b/i.test(t) && k.kind !== 'failed') return 'committee-passage'; // TN: a committee's recommendation
  switch (k.kind) {
    case 'veto_override': return 'veto-override-passage';
    case 'vetoed': return NOT_WHOLE.test(t) ? null : 'executive-veto';
    case 'failed': return /\b(sustain|overrid)/i.test(t) ? null : /committee|\bheld in\b|\binexpedient\b/i.test(t) ? 'committee-failure' : 'failure';
    case 'enacted': return NOT_WHOLE.test(t) ? null : CHAPTERED.test(t) ? 'became-law' : GOV_SIGNED.test(t) ? 'executive-signature' : null; // line items: not the bill
    case 'carried_over': return 'carried-over';
    case 'introduced': return 'introduction';
    case 'referred': return REFERRAL.test(t) && !/\boffice of (legislative|fiscal)\b|\bassigned\b/i.test(t) ? 'referral-committee' : null;
    case 'hearing': return /held under submission/i.test(t) || CANCELLED.test(t) ? null : HEARING_SET.test(t) ? 'hearing-scheduled' : /\bhearings? (was |were )?(held|conducted|completed)\b|\bheard\b/i.test(t) ? 'hearing-held' : null;
    case 'passed':
      if (CONCUR.test(t)) return 'concurrence';
      if (/\benrolled\b/i.test(t) && !/\bpass/i.test(t)) return 'enrolled';
      // a second reading or first consideration is a step on the floor, not the chamber's passage (Hawaii's committee-passage wording is
      // caught by JURISDICTION_RULES above)
      const committeeReport = /^\W*(\w+ )?(reported|report|the committee)\b|\brecommend|\bdo pass\b/i.test(t) && !/^\W*report adopted\b/i.test(t);
      if (!committeeReport && /\b(second|2nd) reading\b|\bpassed 2nd\b|\b(first|second) consideration\b|\bcommittee of the whole\b/i.test(t) && !/\b(third|3rd|final) read(ing)?s?\b(?! calendar)/i.test(t)) return null;
      if (/\bengross|\benroll/i.test(t) && !/\bpass|\bfavorabl/i.test(t)) return /\benrolled\b/i.test(t) ? 'enrolled' : null; // a clerk's step, not a vote
      // not a vote on the bill: moved to the next reading or to engrossment, a first reading, a request, a refusal, a companion's chapter
      if (/\bpassed to (third|3rd|engross)|\bpassed (1st|first) reading\b|\brequests? that\b|\brefused to pass\b|\bpassed over\b|^\W*chapter no\b/i.test(t)) return null;
      if (/\bpassed (third|3rd|final) reading\b|\b(third|3rd) read(ing)?\b[^.]{0,20}\bpassed\b/i.test(t)) return 'passage';
      if (/\bconf(erence)?\.? (committee )?report\b/i.test(t)) return 'passage'; // the chamber adopts the conference report: a floor vote
      if (k.importance === 60) return 'committee-passage';
      if (/\bengrossed\b/i.test(t) && !/\bpass/i.test(t)) return null; // a clerk's step, not a vote
      return 'passage';
    default: return null;
  }
}

// ---------- court dockets ----------
// A docket entry (CourtListener) -> 'court-ruling' | 'court-filing' | null. Only what Lane 1 already calls material and newsworthy.
export function classifyCourt(entry) {
  const c = classifyEntry(entry);
  if (!c || !c.news) return null;
  if (c.kind === 'appeal') return 'court-filing';
  if (c.kind === 'judgment' || c.kind === 'order') return 'court-ruling';
  return null;
}

// One entry point: source -> class or null.
export function classifyAction(source, text, ctx = {}) {
  if (source === 'congress_gov') return classifyCongress(text);
  if (source === 'legiscan') return classifyState(text, ctx);
  return null;
}
