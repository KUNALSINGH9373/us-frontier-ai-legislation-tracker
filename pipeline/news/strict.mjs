// Strict shapes for state news cards (decided 29 Oct 2026 after review round 6: rules that say "a passage unless an exception matches"
// never converge, because real wording varies without end). A state action becomes a news event only when its WHOLE text has a known
// shape for the class news/classify.mjs gave it. Anything else is no card: unfamiliar wording means a missed card, never a wrong one.
// How a text is checked:
//   1. a vote line that did not carry (noes not fewer than ayes) is never a passing class (losingTally)
//   2. vote tallies, dates, page and journal references are cut (ANYWHERE, then TAIL from the end)
//   3. what is left (the core) must match one shape of its class in full (SHAPES), case-insensitive
//   4. a name slot (@NAME@: a committee or a committee code) may hold only name words, never an action word (ACTION_WORD)
// Classes not listed in SHAPES (introduction, referral, hearing-scheduled) keep news/classify.mjs's rules: they make no outcome claim.
import { VOTE_WORDS } from './lexicon.mjs';
import { MONTH_NAMES } from './text.mjs';

const N = String.raw`\d+`;
const NAME = String.raw`[\w&,:'./() -]{1,110}?`;
// a word that would change what the action says: never allowed inside a name slot
export const ACTION_WORD = /\b(pass\w*|fail\w*|reject\w*|defeat\w*|not|no|never|refus\w*|declin\w*|rescind\w*|reconsider\w*|expung\w*|lost|loses?|temporar\w*|tabled?|withdr[ae]w\w*|recommit\w*|postpon\w*|defer\w*|strick\w*|strike|kill\w*|veto\w*|overrid\w*|sustain\w*|motion|vote|voted|votes|voting|indefinite\w*|unfavorabl\w*|inexpedient|may|might|would|will|shall|expected|scheduled|pending|if|unless|without|disagree\w*|nonconcur\w*|recommend\w*|report\w*|refer\w*|amend\w*|reading|read|adopt\w*|concur\w*|agreed|approv\w*|sign\w*|enroll\w*|engross\w*|governor|chapter\w*)\b/i;

// vote lines and asides that can sit anywhere in an action (the tally itself is checked by losingTally)
const ANYWHERE = [
  /\((ayes|vote|\d+-y)\b[^)]*\)/gi, /\((january|february|march|april|may|june|july|august|september|october|november|december) \d+\)/gi,
  /\(\d+-\d+(-\d+)?\)/g, /\(voice vote\)/gi, /\(\d+[a-z]?\.\d+[a-z]?\)/gi,
  /;\s*yeas?,\s*\d+;\s*nays?,\s*\d+(;\s*absent,\s*\d+)?(;\s*excused,?\s*\d*)?\.?/gi,
  /\.?\s*the votes (were|in [a-z/]+ were|of the [a-z ]+ were) as follows:.*$/i, /\.?\s*ayes, \d+\b.*$/i,
  /\s+with (none|(representative|senator)\(s\) [^;]*?) voting aye with reservations.*$/i,
  /\s*(with recommendation: )?to consent calendar\.?/gi, /\s*re-referred to com\. on .*$/i,
];
const TAIL = [
  String.raw`\(?ayes:?\s*${N}\.?,?\s*(noes|nays):?\s*${N}\.?(,?\s*(page|pnv|present):?\s*${N}\.?)?\)?`,
  String.raw`(ayes|yeas):?\s*${N}\.?,?\s*(noes|nays):?\s*${N}\.?(,?\s*pnv\s*${N})?`,
  String.raw`\(?${N}-y\s+${N}-n(\s+${N}-a)?\)?`,
  String.raw`yeas?,?\s*${N},?\s*nays?,?\s*${N}(;\s*absent,\s*${N};\s*excused,\s*${N})?`,
  String.raw`yea:\s*${N}\s+nay:\s*${N}`, String.raw`y:${N}\s+n:${N}`,
  String.raw`\(?${N}-${N}(-${N})?\)?`, String.raw`${N}/${N}/${N}`,
  String.raw`votes:\s*${N}\s+yes(\s+${N}\s+(no|absent|not voting|vacant))*`,
  String.raw`ayes:\s*${N}\s+noes:\s*${N}\s+present:\s*${N}`,
  String.raw`[hs]\.j\.\s*${N}`, String.raw`(house|senate) (journal|calendar)\s+${N}\s+p\.\s*${N}`,
  String.raw`(on\s+)?((monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+${N},?(\s+${N})?`,
  String.raw`at\s+${N}(:${N})?\s+[ap]\.m\.`, String.raw`\(effective\s+${N}/${N}/${N}\)`,
  String.raw`\(vote\s+${N}-${N};\s*consent calendar\)`, String.raw`voice vote`,
];
const TAIL_RE = new RegExp(String.raw`[\s.;,:-]*(?:${TAIL.join('|')})[\s.;,:-]*$`, 'i');

const MONTHS = new RegExp(`^(${MONTH_NAMES.join('|')})$`, 'i');
const UNDO = /^(void\w*|nullif\w*|invalid\w*|ruled|order|again|retaken|retake|redo|cancel\w*|annul\w*|revers\w*|overturn\w*)$/i;
export function rollCallOnly(piece) {
  const toks = String(piece).split(/[^A-Za-z'-]+/).filter(Boolean);
  // names are allowed only in a member list ("Representative(s) Cochran, Garcia"): anywhere else a capitalized word could be
  // "(Vote Voided)" or "Ruled Out of Order" (review r8 #2)
  const memberList = /\b(representative|senator)\(s\)/i.test(piece);
  return toks.every((w) => VOTE_WORDS.has(w.toLowerCase()) || MONTHS.test(w) || ((memberList ? /^[A-Z]/.test(w) : /^([A-Z]{1,5}|[A-Za-z])$/.test(w)) && !ACTION_WORD.test(w) && !UNDO.test(w)));
  // (outside a member list only a single letter or a short all-caps committee code, "APPR", "JUD", "G.O.")
}
export function coreOf(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  // a piece is cut only when it is a roll call or a date: vote words, numbers and names (capitalized, never an action word). "(vote
  // rescinded)" is not, so it stays and the shape fails.
  for (const re of ANYWHERE) t = t.replace(re, (m) => (rollCallOnly(m) ? ' ' : m)).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 12; i++) { const s = t.replace(TAIL_RE, '').trim(); if (s === t) break; t = s; }
  return t.replace(/[\s.;,:-]+$/, '').trim();
}

// A vote line where the noes are not fewer than the ayes: the motion did not carry, whatever the words say.
const PASSING = new Set(['passage', 'committee-passage', 'concurrence', 'veto-override-passage']);
export function losingTally(text) {
  const t = String(text || '');
  const pairs = [
    /\b(?:ayes?|yeas?|yes|y|for)\b[:,]?\s*(\d+)[.,;]?\s*(?:noes|nays?|no|n|against)\b[:,]?\s*(\d+)/gi,
    /\b(\d+)-y\s+(\d+)-n\b/gi, /\b(\d+)y-(\d+)n\b/gi, /\byeas?\s*(\d+)\s*-\s*nays?\s*(\d+)/gi, /\by-(\d+),?\s+n-(\d+)\b/gi, /\b(\d+)\s+yes\s+(\d+)\s+no\b/gi,
    /\((\d+)-(\d+)(?:-\d+)?\)/g, /;\s*(\d+)-(\d+)-\d+\s*$/g,
    // MA "2 YEAS to 148 NAYS"; Hawaii "Ayes, 10; ... 15 No(es)" / "Noes, 15" (review r12 #5/#6)
    /\b(\d+)\s*yeas?\s+to\s+(\d+)\s*nays?\b/gi, /\bayes,\s*(\d+);.*?\b(\d+)\s*no\(es\)/gi, /\bayes,\s*(\d+);.*?\bnoes,\s*(\d+)/gi,
    /\b(?:passed|do pass)\b[^()]*?\b(\d+)-(\d+)(?:-\d+)?\b/gi,
    // the number before the word ("3 yeas 6 nays", "(0 yeas, 90 nays)"), "17 to 18", a bare "2-7" anywhere, "40/55/0" after a pass
    // or report word (review r7 #3)
    /\b(\d+)\s*(?:ayes?|yeas?|yes|y|for)\b[\s,;.]*(\d+)\s*(?:noes|nays?|no|n|against)\b/gi, /\b(\d+) to (\d+)\b/gi,
    /(?<![\d/.-])(\d+)-(\d+)(?:-\d+)?(?![\d/-])/g, /\b(?:pass\w*|report\w*)\b[^()]*?(?<![\d/])(\d+)\/(\d+)(?:\/\d{1,3})?(?![\d/])/gi, // not a date ("02/04/2026")
  ];
  for (const re of pairs) for (const m of t.matchAll(re)) if (+m[2] >= +m[1]) return true;
  // Hawaii's House line counts only the noes ("voting no (40)"): a majority of its 51 members is a loss (review r12 #6)
  // noes and excused together: an excused member is no aye (review r13 #3)
  const exc = /\b(\d+) excused\b|\bexcused \((\d+)\)/i.exec(t), ex = exc ? +(exc[1] || exc[2]) : 0;
  for (const m of t.matchAll(/\bvoting no \((\d+)\)/gi)) if (+m[1] + ex >= 26) return true;
  return false;
}

const CH = '(house|senate|assembly)';
const HI_VOTES = '';
export const SHAPES = {
  'passage': [
    'read third time\\. (urgency clause adopted\\. )?passed\\.?( ordered to the (senate|assembly)\\.?)?',
    `${CH} third reading passed( - no amendments)?`,
    `${CH} passed as amended by ${CH} amendment schedule [a-z]`,
    `passed by ${CH}\\. votes:?`, `passed by (the )?${CH}`,
    '(cs )?passed( as amended)?( by conference committee report)?', 'passed - amended',
    `${CH} passed/adopted by substitute`,
    `(report adopted; )?passed (third|final) reading(, as amended \\([a-z]{2} \\d+\\)| as amended in [a-z]{2} \\d+)?${HI_VOTES}`,
    `passed ${CH}`, `passed ${CH} (as amended|with substitute)( block vote)?`,
    `read third time in full( as amended)? -- passed`,
    'third reading( - short debate)? - passed',
    `(${CH} )?(emergency )?final action - (substitute )?passed( as amended)?`,
    'passed to be engrossed( - \\d+ yeas to \\d+ nays \\(see yea and nay no\\. \\d+ \\))?', 'read third and passed to be engrossed',
    // (not MD "Passed Enrolled", an enrolment step, nor MO "Truly Agreed To and Finally Passed", the whole legislature's status: review r12)
    'third reading passed', '([hs] )?third read and passed( \\([hs]\\))?',
    'conf report passed \\d*(st|nd|rd|th)?', 'passed \\d*(st|nd|rd|th|third) reading', 'passed on final reading',
    `passed ${CH} \\(passed both houses\\)`, `passed (by|in) the ${CH}( of representatives)?`,
    `passed (h|s|house|senate)\\.?(,? as am\\.)?(,? as amended)?(,? ayes \\d+,? nays \\d+(,? pnv \\d+)?)?`,
    '(third reading, )?measure( and emergency)? passed', 'passed (h|s)\\.,? as am\\.?',
    // Utah: a passage only when the third reading is among the readings passed (review r7 #4)
    `(house|senate)/ passed (\\d(st|nd) & )?3rd readings?(/ suspension)? in (clerk of the house|senate secretary|senate president|(senate|house) comm - floor)`, // Utah's own offices (review r8 #9)
    `read (third|\\d*rd) time (and|&) passed( in concurrence( with proposal of amendment)?)?`,
    'senate message: passed in concurrence( with proposal of amendment)?',
    `read third time and passed ${CH}`, 'passed final passage', 'third reading, passed',
  ],
  'failure': [
    // only a recorded floor vote that failed: an end-of-session disposition ("died in Senate", "Indefinitely postponed", Utah's file
    // for bills not passed, "Died in Messages") took no vote, and the card would say "rejects" (review r8 #3)
    'read third time\\. refused passage', 'second reading, failed to pass', 'inexpedient to legislate: motion adopted',
  ],
  // a committee's recorded vote only: "died in committee" is a deadline, not a vote (review r10 #2)
  'committee-failure': [`(house|senate) committee on @NAME@ postpone indefinitely`],
  'committee-passage': [
    `from committee: (amend, and )?do pass( as amended)?( and re-refer to com\\. on [a-z.& ]{2,40}?)?( \\(ayes \\d+\\. noes \\d+\\.\\))?( \\(\\w+ \\d+\\))?`,
    `from committee: do pass and re-refer to com\\. on [a-z.& ]{2,40}?`,
    `from committee: (amend, and )?do pass as amended\\.?`,
    `reported out of committee \\(@NAME@\\) in ${CH} with \\d+ (favorable|on its merits)(, \\d+ (favorable|on its merits))*`,
    `passed second reading as amended in [a-z]{2} \\d+ and referred to the committee\\(s\\) on [a-z/]{2,20}${HI_VOTES}`,
    `report adopted; passed second reading, as amended \\([a-z]{2} \\d+\\) and referred to [a-z/]{2,20}`,
    `reported from [a-z/]{2,20} \\(stand\\. com\\. rep\\. no\\. [\\d-]+\\)(,| with| as amended in [a-z]{2} \\d+,?)?( recommending| recommendation of)? (passage on (second|third) reading|referral to [a-z/]{2,20})(,? as amended \\([a-z]{2} \\d+\\))?( and referral to [a-z/]{2,20})?`,
    `reported from conference committee (\\(conf\\.? com\\. rep\\. no\\. [\\d-]+\\) )?as amended (in )?\\(?cd \\d+\\)?( \\(conf\\. com\\. rep\\. no\\. [\\d-]+\\))?`,
    `the (conference committee|committee(\\(s\\))? on [a-z/]{2,20}) recommend(s|\\(s\\))? that the measure be passed, (with amendments|unamended)${HI_VOTES}`,
    'reported out of committee with do pass recommendation[,;] filed for second reading',
    `do pass( as amended)?( / short debate)? @NAME@; \\d+-\\d+-\\d+`, `do pass( as amended)?( / short debate)? @NAME@`,
    `(house|senate) committee report recommending (substitute )?bill be passed by committee on @NAME@`,
    'reported favorably( as substituted)?',
    `(bill )?reported favorably by committee and referred to the (joint )?committee on @NAME@`,
    `committee recommended (bill )?ought to pass and referred to the committee on @NAME@`,
    `reported from the committee on @NAME@`,
    // Missouri: the committee's vote ("Voted Do Pass") is the event; its later report ("Reported Do Pass", "Reported from S ...") would be a
    // second card on the report date (review r12 #3)
    `(hcs |hs |scs )?voted do pass( \\([hs]\\)| [hs] @NAME@)?( - ayes: \\d+ noes: \\d+ present: \\d+)?`,
    'reported back amended, do pass, amendment placed on calendar( \\d+)*',
    'committee report: ought to pass( \\d+/\\d+/\\d+)?( \\(vote \\d+-\\d+; consent calendar\\))?', 'ought to pass',
    `reported from senate committee with amendments, \\d+(st|nd|rd|th) reading`, `reported out of assembly committee, \\d+(st|nd|rd|th) reading`,
    `reported out of asm\\. comm\\. with amendments, and referred to @NAME@ committee`,
    `[a-z]{2,5}: reported by committee with do pass recommendation( with amendment\\(s\\))?`,
    `cr; do pass @NAME@ committee`, `reported do pass as amended @NAME@ committee; cr filed`,
    'recommendation: do pass( with amendments)?, be printed [a-z]-engrossed, and be referred to [a-z ]{2,40} by prior reference',
    `rec\\.? for pass(\\.|age)?;? ref\\.? to @NAME@ committee`,
    `recommended for passage( with amendment/s)?, refer to @NAME@ committee( ayes \\d+, nays \\d+ pnv \\d+)?`,
    `reported from @NAME@( with (substitute|amendment\\(s\\)))?( and (re)?referred to @NAME@)?`,
    `reported favorably by (senator|representative) [a-z' -]{2,30} for committee on @NAME@`,
    `[a-z]{2,5} - majority; (\\d+(st|nd|rd|th) substitute bill be substituted, do pass|do pass with amendment|do pass \\d+(st|nd|rd|th) substitute bill proposed by @NAME@)`,
    `passed second reading,? as amended \\(sd \\d+\\) and referred to [a-z/]{2,20}`,
  ],
  'concurrence': [
    `${CH} amendments concurred in\\.?( ordered to engrossing and enrolling| to engrossing and enrolling)?`,
    `${CH} concurs in ${CH} amendments?(\\(s\\))?(-reported)?`,
    `(conference report|senate substitute) agreed to by ${CH}`,
  ],
  'enrolled': ['ordered engrossed, then enrolled', 'ordered enrolled', `enrolled, to ${CH}`, 'enrolled and ready for signatures', 'reported enrolled', 'enrolled',
    'reported duly enrolled @NAME@'],
  'executive-receipt': [
    'enrolled and presented to the governor', 'sent to (the )?governor', 'transmitted by secretary of the state to governor',
    'signed by officers and presented to governor', 'enrolled to governor', 'transmitted to governor( for action)?',
    'reported correctly enrolled, signed by speaker and president, and sent to governor',
    'reported signed by the speaker & ordered delivered to governor', `(${CH} )?enrolled and presented to governor`,
    'delivered to (the )?governor', 'presented to governor', `(house|senate)/ to governor in executive branch - governor`,
    'enrolled bill communicated to governor',
  ],
  'executive-signature': [
    'approved by (the )?governor( ?- ?chapter \\d+)?', 'governor signed', 'signed by (the )?governor( - chapter \\d+)?', 'governor approved',
    `${CH} approved by governor`, 'signed chap\\.? ?\\d*', "governor signed in lieutenant governor's office for filing",
    'house message: governor approved bill', 'signed by governor - chapter \\d+ - mar\\.?',
  ],
  'became-law': ['chaptered by secretary of state(\\. | - )?(chapter \\d+, )?statutes of \\d{4}', 'chaptered by secretary of state'],
  'executive-veto': ['vetoed by (the )?governor', 'governor vetoed'],
  'veto-override-passage': [`veto overridden( by ${CH})?`, `${CH} overrode (the )?governor's veto`, `passed over (the )?governor's veto`],
  'carried-over': ['carried over to \\d{4} regular session', 'title printed\\. carryover bill', `continued to next session in @NAME@`],
  'hearing-held': [`hearing conducted [hs] @NAME@`, 'public hearing (completed|held)( \\([hs]\\))?', '(public )?hearings? (was |were )?held'],
};

// each shape compiled with its name slots as named groups (n1, n2 ...)
const COMPILED = Object.fromEntries(Object.entries(SHAPES).map(([c, list]) => [c, list.map((src) => {
  const parts = src.split('@NAME@');
  return new RegExp('^(?:' + parts.map((p, i) => (i ? `(?<n${i}>${NAME})` : '') + p).join('') + ')$', 'i');
})]));

export const STRICT_CLASSES = new Set(Object.keys(SHAPES));
// true when the text has a known shape for this class (or the class is not one the strict shapes cover)
export function provenState(cls, text) {
  if (!STRICT_CLASSES.has(cls)) return true;
  if (PASSING.has(cls) && losingTally(text)) return false;
  const core = coreOf(text);
  for (const re of COMPILED[cls]) {
    const m = re.exec(core);
    if (m && Object.values(m.groups || {}).every((g) => g === undefined || nameOnly(g))) return true;
  }
  return false;
}

// A name slot holds a committee's name or code: capitalized words, codes and connectors only. Never an action word, a number (a
// tally), a lowercase word ("adversely", "(adverse)", "sent to study") or an outcome word or code (ITL, ONTP, OTP-ND, Interim Study,
// dead, held, laid over) (review r7 #2).
const CONNECTORS = new Set(['and', 'of', 'the', 'on', 'for', '&']);
const OUTCOME_WORDS = /^(itl|ontp|otp|nd|ought|study|interim|dead|held|hold|laid|over|adverse\w*|contrary|continued|killed|died|tabled|fails?|failed|whole)$/i; // "Committee of the Whole" is the floor (review r10 #3)
export function nameOnly(g) {
  if (ACTION_WORD.test(g) || /\d/.test(g)) return false;
  const toks = String(g).split(/[^A-Za-z&'.]+/).map((w) => w.replace(/^[.']+|[.']+$/g, '')).filter(Boolean);
  return toks.length > 0 && toks.every((w) => !OUTCOME_WORDS.test(w) && (CONNECTORS.has(w.toLowerCase()) || /^[A-Z&]/.test(w)));
}
