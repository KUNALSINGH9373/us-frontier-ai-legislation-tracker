// Deterministic news card wording (decision after review round 3, 29 Oct 2026): hand-written variants per event class, with slots
// filled only from the closed fact sheet (news/factsheet.mjs). No AI. A variant is eligible only when every slot it uses is present
// and its condition holds (a vote, no votes against, scheduled vs held). The choice is a hash of the event key, so a card never
// changes wording between runs and neighbouring cards differ.
// Body = one event sentence + "What it does: <the sheet's verified summary, verbatim>." (when the sheet has one) + the stage the record
// proves ("Status: ..."), when there is one. No next step, ever (review r5): no variant says what comes next ("heads to", "goes to",
// "awaits", "next", "will"). Every variant is reviewed by hand for accuracy: no implication beyond its class (passage never implies law,
// receipt never implies signature, committee never implies the floor, a concurrence never implies both chambers passed).
import crypto from 'crypto';
import { isUnicameral } from './factsheet.mjs';

const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const longDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}` : null; };
const longDates = (s) => String(s).replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (x) => longDate(x));
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

// "the" before a body's full name (the Bureau of Industry and Security, the U.S. District Court ...), not before an acronym (NIST).
const the = (name) => /^the\s/i.test(name) || /^[A-Z0-9&.-]+$/.test(name) ? name : `the ${name}`;

// Conditions a variant may require besides its slots.
const VOTE = (s) => !!s.event.vote;
const UNANIMOUS = (s) => !!s.event.vote && s.event.vote.no === 0 && s.event.vote.yes > 0;
const SPLIT = (s) => !!s.event.vote && s.event.vote.no > 0;
const SCHEDULED = (s) => s.event.timing === 'scheduled';
const HELD = (s) => s.event.timing !== 'scheduled';
// review r4: two chambers only where there are two (#3); 'into law' / 'enacts' only for a known bill number that is not a resolution or
// constitutional amendment, outside DC (#4, #8; r5 M4, L1) — the fact sheet's bill.law_wording (news/factsheet.mjs lawWording)
const BI = (s) => !isUnicameral(s.bill.jurisdiction);
const LAW = (s) => s.bill.law_wording === true;
// review r6: "becomes law" only with valid law wording (never a resolution, amendment or unknown number); "both chambers" never for a
// simple resolution
const BECAME = (s) => s.bill.became_law_ok === true;
const BI2 = (s) => BI(s) && !s.bill.simple_resolution;

// The slots a fact sheet supplies (null = absent).
export function slotsOf(s) {
  const e = s.event || {}, b = s.bill || {}, us = b.jurisdiction === 'US';
  return {
    bill: b.number || b.short_title || null,
    state: !us && b.jurisdiction_name && b.jurisdiction_name !== b.jurisdiction ? b.jurisdiction_name : null,
    chamber: e.chamber || null,
    committee: e.committee ? String(e.committee).replace(/^the\s+/i, '') : null, // templates write 'the {committee}' (review r4 #8)
    yes: e.vote ? String(e.vote.yes) : null,
    no: e.vote ? String(e.vote.no) : null,
    date: longDate(e.date),
    hearing_date: e.class === 'hearing-scheduled' ? longDate(e.hearing_date || e.date) : null,
    agency: e.agency ? the(e.agency) : null,
    comments_close: longDate(e.comments_close) || null,
    signer: b.executive && e.executive && !/^the /i.test(e.executive) ? e.executive : null,
    exec: b.executive ? cap(b.executive) : null, // null for a measure that skips the executive (review r5 M4)
    exec_l: b.executive || null,
    law_number: e.law_number || null,
    court: e.court ? the(e.court) : null,
    title: e.title || null,
    nominee: e.nominee || null,
    position: e.position || null,
    stage: s.stage || null
  };
}

// v: [template, condition?]. Headlines (H) and event sentences (B) per class.
const v = (t, when = null) => ({ t, when });
export const BANK = {
  introduction: {
    H: [v('{bill} introduced in the {state} {chamber}'), v('{bill} introduced in the {chamber}'), v('{state} {chamber}: {bill} introduced'), v('{bill} filed in the {chamber}'), v('{bill} introduced'), v('{bill} introduced on {date}')],
    B: [v('{bill} was introduced in the {chamber} on {date}.'), v('On {date}, {bill} was introduced in the {state} {chamber}.'), v('{bill} was filed in the {chamber} on {date}.'), v('{bill} was introduced on {date}.')]
  },
  'referral-committee': {
    H: [v('{bill} referred to the {committee}'), v('{bill} referred to committee'), v('{committee} receives {bill}'), v('{bill} referred to a {state} committee')],
    B: [v('{bill} was referred to the {committee} on {date}.'), v('On {date}, {bill} was referred to the {committee}.'), v('{bill} was referred to committee on {date}.')]
  },
  'hearing-scheduled': {
    H: [v('{committee} to hold hearing on {bill}', SCHEDULED), v('Hearing scheduled on {bill}', SCHEDULED), v('{bill} scheduled for a hearing on {hearing_date}', SCHEDULED), v('{committee} schedules hearing on {bill}', SCHEDULED), v('Hearing on {bill} set for {hearing_date}', SCHEDULED)],
    B: [v('The {committee} is scheduled to hold a hearing on {bill} on {hearing_date}.', SCHEDULED), v('A hearing on {bill} is scheduled before the {committee} on {hearing_date}.', SCHEDULED), v('{bill} is scheduled for a hearing on {hearing_date}.', SCHEDULED)]
  },
  'hearing-held': {
    H: [v('{committee} holds hearing on {bill}', HELD), v('Hearing held on {bill}', HELD), v('{bill} heard in the {committee}', HELD), v('{bill} gets a hearing in the {committee}', HELD), v('{state} committee holds hearing on {bill}', HELD)],
    B: [v('The {committee} held a hearing on {bill} on {date}.', HELD), v('On {date}, the {committee} heard {bill}.', HELD), v('{bill} was heard in committee on {date}.', HELD), v('A hearing on {bill} was held on {date}.', HELD)]
  },
  'committee-passage': {
    H: [v('{committee} advances {bill}'), v('{committee} approves {bill}, {yes}-{no}', VOTE), v('{bill} clears the {committee}'), v('{bill} advances out of committee'), v('{committee} unanimously approves {bill}', UNANIMOUS), v('{bill} approved in committee, {yes}-{no}', VOTE)],
    B: [v('The {committee} approved {bill} on {date} by a vote of {yes}-{no}.', VOTE), v('On {date}, the {committee} voted {yes}-{no} to advance {bill}.', VOTE), v('The {committee} advanced {bill} on {date}.'), v('{bill} was approved in committee on {date}.'), v('The {committee} approved {bill} unanimously, {yes}-{no}, on {date}.', UNANIMOUS)]
  },
  'committee-failure': {
    H: [v('{bill} fails in the {committee}'), v('{committee} rejects {bill}'), v('{bill} fails in committee'), v('{committee} rejects {bill}, {yes}-{no}', VOTE)],
    B: [v('The {committee} rejected {bill} on {date}.'), v('{bill} failed in the {committee} on {date} by a vote of {yes}-{no}.', VOTE), v('On {date}, {bill} failed in committee.')]
  },
  passage: {
    H: [v('{state} {chamber} passes {bill}'), v('{state} {chamber} passes {bill}, {yes}-{no}', VOTE), v('{bill} passes the {chamber}'), v('{chamber} approves {bill}, {yes}-{no}', VOTE), v('{state} {chamber} unanimously passes {bill}', UNANIMOUS), v('{bill} clears the {state} {chamber}'), v('{bill} passes the {chamber}, {yes}-{no}', VOTE)],
    B: [v('The {chamber} passed {bill} on {date}.'), v('The {chamber} passed {bill} by a vote of {yes}-{no} on {date}.', VOTE), v('On {date}, the {state} {chamber} approved {bill}, {yes}-{no}.', VOTE), v('{bill} passed the {chamber} on {date}.'), v('The {chamber} passed {bill} unanimously, {yes}-{no}, on {date}.', UNANIMOUS)]
  },
  failure: {
    H: [v('{bill} fails in the {chamber}'), v('{state} {chamber} rejects {bill}'), v('{chamber} rejects {bill}, {yes}-{no}', VOTE), v('{bill} fails in the {state} {chamber}')],
    B: [v('{bill} failed in the {chamber} on {date}.'), v('The {chamber} rejected {bill} on {date} by a vote of {yes}-{no}.', VOTE), v('On {date}, the {state} {chamber} rejected {bill}.')]
  },
  'amendment-passage': {
    H: [v('{chamber} amends {bill}'), v('Amendment adopted to {bill}'), v('{bill} amended in the {chamber}'), v('{bill} amended')],
    B: [v('The {chamber} adopted an amendment to {bill} on {date}.'), v('{bill} was amended on {date}.'), v('An amendment to {bill} was adopted on {date}.')]
  },
  concurrence: {
    // a concurrence alone never says both chambers passed (review r5: the stage line says so only when the record proves it)
    H: [v('{state} {chamber} concurs on {bill}'), v('{chamber} concurs on {bill}, {yes}-{no}', VOTE), v('{bill}: {chamber} concurs'), v('{chamber} concurs in amendments to {bill}')],
    B: [v('The {chamber} concurred in {bill} on {date}.'), v('The {chamber} voted {yes}-{no} on {date} to concur in {bill}.', VOTE), v('The {chamber} concurred in amendments to {bill} on {date}.')]
  },
  enrolled: {
    H: [v('{bill} enrolled'), v('{bill} enrolled after passing both chambers', BI2), v('{state} {bill} enrolled'), v('{bill} enrolled on {date}')],
    B: [v('{bill} was enrolled on {date}.'), v('On {date}, {bill} was enrolled after passing both chambers.', BI2), v('{bill} was enrolled on {date}, having passed both chambers.', BI2)]
  },
  'executive-receipt': {
    H: [v('{bill} sent to {exec_l}'), v('{bill} presented to {exec_l}'), v('{bill} delivered to {exec_l}'), v('{state} {bill} sent to {exec_l}')],
    B: [v('{bill} was sent to {exec_l} on {date}.'), v('On {date}, {bill} was presented to {exec_l}.'), v('{bill} was delivered to {exec_l} on {date}.')]
  },
  'executive-signature': {
    H: [v('{signer} signs {bill}'), v('{bill} signed into law', LAW), v('{bill} signed'), v('{bill} signed into law as {law_number}', LAW), v('{state} enacts {bill}', LAW), v('{signer} signs {bill} into law', LAW)],
    B: [v('{signer} signed {bill} on {date}.'), v('{bill} was signed into law on {date}.', LAW), v('On {date}, {signer} signed {bill} into law.', LAW), v('{bill} was signed into law on {date} as {law_number}.', LAW), v('{bill} was signed on {date}.')]
  },
  'became-law': {
    H: [v('{bill} becomes law', BECAME), v('{bill} becomes law as {law_number}', BECAME), v('{bill} became law on {date}', BECAME), v('{state} {bill} becomes law', BECAME)],
    B: [v('{bill} became law on {date}.', BECAME), v('On {date}, {bill} became law.', BECAME), v('{bill} became law as {law_number} on {date}.', BECAME)]
  },
  'executive-veto': {
    H: [v('{signer} vetoes {bill}'), v('{bill} vetoed'), v('{state} {bill} vetoed'), v('{bill} vetoed on {date}')],
    B: [v('{signer} vetoed {bill} on {date}.'), v('{bill} was vetoed on {date}.'), v('On {date}, {bill} was vetoed.')]
  },
  'veto-override-passage': {
    H: [v('{chamber} votes to override veto of {bill}'), v('{chamber} votes {yes}-{no} to override veto of {bill}', VOTE), v('Veto override vote on {bill} passes the {chamber}'), v('{bill}: {chamber} votes to override veto')],
    B: [v('The {chamber} voted {yes}-{no} on {date} to override the veto of {bill}.', VOTE), v('On {date}, the {chamber} voted to override the veto of {bill}.'), v('{bill}: the {chamber} voted on {date} to override the veto.')]
  },
  withdrawal: {
    H: [v('{bill} withdrawn'), v('{bill} withdrawn in the {chamber}'), v('{state} {bill} withdrawn'), v('{bill} withdrawn on {date}')],
    B: [v('{bill} was withdrawn on {date}.'), v('On {date}, {bill} was withdrawn in the {chamber}.'), v('{bill} was withdrawn from consideration on {date}.')]
  },
  'carried-over': {
    H: [v('{bill} carried over'), v('{state} {bill} carried over'), v('{bill} carried over on {date}'), v('{bill} carried over in the {chamber}')],
    B: [v('{bill} was carried over on {date}.'), v('On {date}, {bill} was carried over.'), v('{bill} was carried over in the {chamber} on {date}.')]
  },
  'new-text-version': {
    H: [v('New text of {bill} published'), v('{bill}: new version published'), v('New version of {bill} released'), v('New text version of {bill} published')],
    B: [v('A new text version of {bill} was published on {date}.'), v('On {date}, a new version of {bill} was published.'), v('{bill} has a new text version, published on {date}.')]
  },
  'crs-report': {
    H: [v('CRS report on {bill}'), v('CRS publishes report on {bill}'), v('CRS report published on {bill}'), v('New CRS report on {bill}')],
    B: [v('A CRS report on {bill} was published on {date}.'), v('On {date}, CRS published a report on {bill}.'), v('CRS released a report on {bill} on {date}.')]
  },
  'cbo-estimate': {
    H: [v('CBO cost estimate for {bill}'), v('CBO publishes cost estimate for {bill}'), v('CBO estimate published for {bill}'), v('{bill}: CBO cost estimate')],
    B: [v('CBO published a cost estimate for {bill} on {date}.'), v('A CBO cost estimate for {bill} was published on {date}.'), v('On {date}, CBO published a cost estimate for {bill}.')]
  },
  'executive-order': {
    H: [v('{signer} signs {bill}'), v('{bill} signed'), v('{bill} issued'), v('{bill}: {title}')],
    B: [v('{signer} signed {bill} on {date}.'), v('{bill} was signed on {date}.'), v('On {date}, {signer} signed {bill}.'), v('{bill} was issued on {date}.')]
  },
  'presidential-memo': {
    H: [v('{bill} issued'), v('Presidential memorandum issued: {title}'), v('{signer} issues {bill}'), v('{signer} issues memorandum: {title}')],
    B: [v('{signer} issued {bill} on {date}.'), v('{bill} was issued on {date}.'), v('On {date}, {signer} issued {bill}.'), v('A presidential memorandum was issued on {date}: {title}.')]
  },
  'agency-guidance': {
    H: [v('{agency} issues guidance'), v('Guidance from {agency}: {title}'), v('{agency} guidance: {title}'), v('{agency} publishes guidance')],
    B: [v('{agency} issued guidance on {date}.'), v('On {date}, {agency} published guidance: {title}.'), v('On {date}, {agency} issued guidance.')]
  },
  'agency-rule-proposed': {
    H: [v('{agency} proposes rule: {title}'), v('{agency} proposes a rule'), v('Proposed rule from {agency}'), v('{agency} publishes proposed rule')],
    B: [v('{agency} published a proposed rule on {date}.'), v('On {date}, {agency} proposed a rule: {title}.'), v('A proposed rule from {agency} was published on {date}.')]
  },
  'agency-rule-final': {
    H: [v('{agency} issues final rule'), v('{agency} final rule: {title}'), v('Final rule published by {agency}'), v('{agency} publishes final rule: {title}')],
    B: [v('{agency} published a final rule on {date}.'), v('On {date}, {agency} issued a final rule on {title}.'), v('A final rule from {agency} was published on {date}.')]
  },
  'comment-period-open': {
    H: [v('Comment period opens on {title}'), v('{agency} opens comment period'), v('Public comments open on {title}'), v('{agency} opens comments on {title}')],
    B: [v('{agency} opened a public comment period on {date}.'), v('A public comment period on {title} opened on {date}.'), v('On {date}, {agency} opened public comments on {title}.')]
  },
  'comment-period-closing': {
    H: [v('Comments on {title} due by {comments_close}', SCHEDULED), v('Comment period on {title} closes {comments_close}', SCHEDULED), v('{agency} comment period closes {comments_close}', SCHEDULED), v('Comment deadline {comments_close} for {title}', SCHEDULED)],
    B: [v('The public comment period on {title} is scheduled to close on {comments_close}.', SCHEDULED), v('Comments to {agency} are scheduled to close on {comments_close}.', SCHEDULED), v('Public comments to {agency} on {title} are scheduled to close on {comments_close}.', SCHEDULED)]
  },
  nomination: {
    H: [v('{nominee} nominated as {position}'), v('{signer} nominates {nominee}'), v('Nomination of {nominee} received'), v('{signer} nominates {nominee} as {position}')],
    B: [v('The nomination of {nominee} as {position} by {signer} was received on {date}.'), v('The nomination of {nominee} for {position} was received on {date}.'), v('On {date}, the nomination of {nominee} was received.')]
  },
  'court-filing': {
    H: [v('Filing in {title} at {court}'), v('New filing in {title}'), v('{title}: filing in {court}'), v('{title}: new court filing')],
    B: [v('A filing was made in {title} in {court} on {date}.'), v('On {date}, a filing was entered in {title} in {court}.'), v('A filing was made in {title} on {date}.')]
  },
  'court-ruling': {
    H: [v('Court rules in {title}'), v('{court} issues ruling in {title}'), v('Ruling in {title}'), v('{title}: court issues ruling')],
    B: [v('{court} issued a ruling in {title} on {date}.'), v('On {date}, a ruling was issued in {title}.'), v('A ruling was issued in {title} on {date}.')]
  }
};
export const STAGE_LINE = 'Status: {stage}.';
export const SUMMARY_LINE = 'What it does: {summary}.';
// The label (review r4 #6): a measure in force 'does'; a live bill 'would do'.
const IN_FORCE = new Set(['executive-signature', 'became-law', 'executive-order', 'presidential-memo', 'agency-rule-final', 'agency-guidance']);
const BILLISH = new Set(['introduction', 'referral-committee', 'hearing-scheduled', 'hearing-held', 'committee-passage', 'passage', 'amendment-passage', 'concurrence', 'enrolled', 'executive-receipt', 'veto-override-passage', 'carried-over', 'new-text-version', 'crs-report', 'cbo-estimate']);
// review r6 #6: a resolution or constitutional amendment: 'What it would do'
export const summaryLabel = (cls, resolution = false) => (resolution ? 'What it would do' : IN_FORCE.has(cls) ? 'What it does' : BILLISH.has(cls) ? 'What the bill would do' : 'What it would do');

const SLOT = /\{([a-z_]+)\}/g;
// The variant rendered with the slots, or null when a slot is missing or its condition fails.
export function render(variant, slots, sheet) {
  if (variant.when && !variant.when(sheet)) return null;
  let missing = false;
  const out = variant.t.replace(SLOT, (_, k) => { const x = slots[k]; if (x == null || x === '') { missing = true; return ''; } return x; });
  return missing ? null : cap(out.replace(/\s+/g, ' ').trim());
}

export const hashIndex = (key, salt, n) => n ? parseInt(crypto.createHash('sha256').update(`${salt}|${key}`).digest('hex').slice(0, 8), 16) % n : 0;
// All eligible renderings of one list, starting from the hashed position (rotation keeps the order deterministic).
export function eligible(list, slots, sheet, key, salt) {
  const r = list.map((x) => render(x, slots, sheet)).filter(Boolean);
  const i = hashIndex(key, salt, r.length);
  return [...r.slice(i), ...r.slice(0, i)];
}

export const MAX_BODY = 400;
// The summary is quoted only when it is a whole clause: not cut at the length limit (the factsheet cuts at MAX_SUMMARY), its brackets
// and quotation marks balanced, and not ending on a conjunction or an abbreviation.
export function wholeClause(s) {
  const t = String(s || '').trim();
  if (t.length < 40 || t.length >= 255) return false;
  const count = (re) => (t.match(re) || []).length;
  if (count(/\(/g) !== count(/\)/g) || count(/"/g) % 2 || count(/[“]/g) !== count(/[”]/g)) return false;
  return !/\b(?:and|or|but|the|a|an|of|to|incl|including|with|for|by|in|e\.g|i\.e|etc)\.?$/i.test(t) && !/[,:;—–-]$/.test(t);
}
export const summaryLine = (sheet) => sheet.verified && sheet.verified.summary && wholeClause(sheet.verified.summary) ? `${summaryLabel(sheet.event && sheet.event.class, !!(sheet.bill && (sheet.bill.resolution || sheet.bill.number && /^(ACA|SCA|HCA|LRCA)/i.test(sheet.bill.number))))}: ${String(sheet.verified.summary).replace(/[\s.;:,]+$/, '')}.` : null;
// Cards from rendered headlines H and event sentences B. Each card has `check`: the bank's own words (headline + event sentence + the
// stage line), which must pass checkCard; the summary line is the sheet's verified text verbatim, inserted after the check and dropped
// when the body would pass MAX_BODY characters. With a summary the stage line is left out (as before: the body stays short).
export function cardsFrom(sheet, H, B) {
  const s = slotsOf(sheet), stage = s.stage ? render({ t: STAGE_LINE }, s, sheet) : null;
  const sum = summaryLine(sheet), out = [];
  for (const b of B) for (const h of H) {
    const core = [b, stage].filter(Boolean), full = sum ? [b, sum] : core;
    const body = full.join(' ').length <= MAX_BODY ? full.join(' ') : core.join(' ');
    out.push({ headline: h, body, check: { headline: h, body: core.join(' ') } });
  }
  return out;
}
// Every candidate card for a sheet, in the hashed preference order. The caller takes the first whose check passes.
export function candidates(sheet, key) {
  const bank = BANK[sheet.event && sheet.event.class];
  if (!bank) return [];
  const s = slotsOf(sheet);
  return cardsFrom(sheet, eligible(bank.H, s, sheet, key, 'h'), eligible(bank.B, s, sheet, key, 'b'));
}
// The most neutral card (review r5 M5: the template fallback): the shortest eligible headline and event sentence, in bank order on a tie,
// no hashing. [] when no variant fits.
export function neutralCandidates(sheet) {
  const bank = BANK[sheet.event && sheet.event.class];
  if (!bank) return [];
  const s = slotsOf(sheet);
  const order = (list) => list.map((x, i) => [render(x, s, sheet), i]).filter(([r]) => r).sort((a, b) => a[0].length - b[0].length || a[1] - b[1]).map(([r]) => r);
  return cardsFrom(sheet, order(bank.H), order(bank.B));
}
