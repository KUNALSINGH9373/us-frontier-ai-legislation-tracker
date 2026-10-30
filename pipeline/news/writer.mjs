// The news card writer (news/CONTRACT.md: "the AI may only rewrite a closed fact sheet, checked by code, with a template fallback").
// 1. The writer (role "generator") writes a headline and a 2-3 sentence body from the fact sheet only (news/factsheet.mjs).
// 2. Code checks the card (checkCard): every number, date, money figure, vote, bill number and proper name must be in the fact sheet;
//    no forbidden claim (superlative without a milestone fact, any prediction or next step (review r5: none is ever stated), causal or evaluative words,
//    "unanimous" on a vote with any no); the tense agrees with the event's timing (scheduled vs held).
// 3. A second reader (role "validator") answers {faithful, added_or_overstated}; it must be faithful with an empty list.
// Up to maxRounds rounds, each refusal fed back word for word; otherwise the template card (written_by 'template').
// Never throws: an API failure, a budget stop or bad JSON means the template card.
import { buildFactSheet, sheetText, billNumbers, STATE_NAMES, isUnicameral } from './factsheet.mjs';
import { CARD_WRITER_SYSTEM, cardWriterPrompt, CARD_READER_SYSTEM, cardReaderPrompt } from './writer-prompts.mjs';
import { digitRuns } from '../agents/source-text.mjs';
import { readFileSync } from 'fs';
import { candidates } from './phrasebank.mjs';
import { sentences, datesIn, MONTH_NAMES } from './text.mjs';
import { SUPERLATIVE, EVALUATIVE, CAUSAL, PREDICTIVE, COLOUR, TITLE_NAME, AFTER_TITLE_OK, COMMON } from './lexicon.mjs';

export const CARD_LIMITS = { headline: 90, body: 400, sentencesMin: 2, sentencesMax: 3 };

const MON_RE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?![a-z])\.?(?:\s+(\d{1,2})(?!\d))?/g; // (?![a-z]): "Mayor" is not May (review r5 M5)
const MONTH_WORD = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)$/;
const MONTHS = MONTH_NAMES.map((m) => m.toLowerCase());
const monthNo = (m) => MONTHS.findIndex((x) => x.startsWith(m.slice(0, 3).toLowerCase())) + 1;
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text, w) => new RegExp(`(^|[^a-z0-9])${esc(w.toLowerCase())}([^a-z0-9]|$)`).test(text.toLowerCase());
const normBill = (s) => s.replace(/[\s.]/g, '').toUpperCase();

// Words that are refused unless the fact sheet itself uses them (evaluative, causal, predictive), and the other word lists: news/lexicon.mjs
// (config/news-lexicon.json). Superlatives need a milestone fact.
export { SUPERLATIVE, EVALUATIVE, CAUSAL, PREDICTIVE, COLOUR };
export const UNANIMOUS = /\b(unanimous(?:ly)?|without (?:opposition|dissent|objection)|no (?:opposition|dissent)|every member|all members|no one (?:voted|opposed))\b/gi;
export const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen|half|twice|double|triple|single)\b/gi;
const WEEKDAY = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/;
const HELD_WORDS = /\b(held|heard|took place|convened|met|testified|was heard|were heard|discussed|examined|took up|considered)\b/i;
const SCHEDULED_WORDS = /\b(scheduled|will|set to|set for|upcoming|plans to|is to)\b/i;
const FUTURE_IN_HELD = /\b(scheduled|upcoming|set to|set for|plans to|is to hold)\b/i;
const NEXT_WORDS = /\b(will|next|heads? to|headed to|moves? to|goes to|now goes|awaits?|awaiting|pending before|transmittal|consideration (?:in|by))\b/i;

// Capitalized words a card may use without the sheet naming them (COMMON, news/lexicon.mjs): function words that start sentences, and generic nouns.
// Writing about the fact sheet instead of the event, and a chamber said to introduce a bill (its members do).
const META = /\b(fact sheet|verified|summary|is listed|listed as|listed at|stage is|its stage|no further step|set out|recorded as|the record)\b/i;
const CHAMBER_INTRODUCED = /\b(?:Senate|House|Assembly|chamber|Legislature|Congress) (?:has )?introduc(?:ed|es|ing)\b/i;

// Numbers, months and days the sheet allows: every digit run of its text, plus each ISO date's year, month and day.
function sheetAllowed(sheet) {
  const text = sheetText(sheet), nums = digitRuns(text), dates = [];
  for (const m of text.matchAll(ISO)) { dates.push({ y: +m[1], m: +m[2], d: +m[3], iso: m[0] }); nums.add(String(+m[1])); nums.add(String(+m[2])); nums.add(String(+m[3])); }
  // months and days written in words in the sheet ("comments close on November 3, 2026")
  for (const iso of datesIn(text)) { const [y, mo, d] = iso.split('-').map(Number); dates.push({ y, m: mo, d, iso }); }
  return { text, nums, dates };
}

// The jurisdiction words a card may use for its institutions (the executive, the legislature and its chambers).
function institutionWords(sheet) {
  const j = sheet.bill && sheet.bill.jurisdiction, w = new Set();
  if (j === 'US') ['congress', 'u.s.', 'us', 'united', 'states', 'house', 'senate', 'president', 'representatives', 'federal'].forEach((x) => w.add(x));
  else ['legislature', 'lawmakers', 'governor', 'state', 'general', 'assembly', 'house', 'senate'].forEach((x) => w.add(x));
  if (j && STATE_NAMES[j]) STATE_NAMES[j].toLowerCase().split(' ').forEach((x) => w.add(x));
  return w;
}

// Plain-code checks on one card against its fact sheet. Returns readable problems; empty means it may go to the second reader.
export function checkCard(card, sheet) {
  const p = [], c = card || {};
  const headline = typeof c.headline === 'string' ? c.headline.trim() : '', body = typeof c.body === 'string' ? c.body.trim() : '';
  if (headline.length < 10) p.push('no headline');
  if (body.length < 20) p.push('no body');
  if (headline.length > CARD_LIMITS.headline) p.push(`headline is ${headline.length} characters, over ${CARD_LIMITS.headline}`);
  if (body.length > CARD_LIMITS.body) p.push(`body is ${body.length} characters, over ${CARD_LIMITS.body}`);
  const n = sentences(body).length;
  if (body && (n < CARD_LIMITS.sentencesMin || n > CARD_LIMITS.sentencesMax)) p.push(`body has ${n} sentences; write ${CARD_LIMITS.sentencesMin} or ${CARD_LIMITS.sentencesMax}`);
  if (p.length && (!headline || !body)) return p;
  const all = `${headline}\n${body}`, lower = all.toLowerCase();
  const { text, nums, dates } = sheetAllowed(sheet), S = text.toLowerCase();
  const milestones = (sheet.milestones || []).join(' ').toLowerCase();
  const ev = sheet.event || {}, vote = ev.vote || null;

  // numbers, money, dates
  const badNums = [...digitRuns(all)].filter((x) => !nums.has(x) && !nums.has(String(Number(x))));
  if (badNums.length) p.push(`numbers not in the fact sheet: ${badNums.join(', ')}`);
  if (/\$/.test(all) && !/\$/.test(text)) p.push('a money figure, but the fact sheet has none');
  for (const m of all.matchAll(NUMBER_WORDS)) if (!hasWord(S, m[1])) p.push(`a number in words ("${m[1]}") that the fact sheet does not use; give figures only as the fact sheet does`);
  for (const iso of datesIn(all)) if (!dates.some((d) => d.iso === iso)) p.push(`the date ${iso} is not in the fact sheet`);
  for (const m of all.matchAll(ISO)) if (!dates.some((d) => d.iso === m[0])) p.push(`the date ${m[0]} is not in the fact sheet`);
  for (const m of all.matchAll(MON_RE)) {
    if (m[1] === 'May' && !m[2] && !/\bMay\s+\d/.test(m[0])) { if (!dates.some((d) => d.m === 5)) p.push('"may" used: no predictions or permissions'); continue; }
    const mo = monthNo(m[1]);
    if (!dates.some((d) => d.m === mo && (!m[2] || d.d === Number(m[2])))) p.push(`"${m[0].trim()}" is not a date in the fact sheet`);
  }
  if (WEEKDAY.test(all)) p.push('a weekday is named; the fact sheet gives no weekdays');

  // votes: exactly the recorded tally, in order; "unanimous" only with no votes against
  for (const m of all.matchAll(/\b(\d{1,3})\s*(?:-|–|—|to)\s*(\d{1,3})\b/g)) {
    // a number pair the sheet itself writes (P.A. 26-15, Initiative 25-0034) is not a tally unless the card calls it one
    const sentence = sentences(all.replace(/\n/g, '. ')).find((s) => s.includes(m[0])) || all;
    if (S.includes(m[0].toLowerCase()) && !/vot|tally|roll/i.test(sentence) && !(vote && Number(m[1]) === vote.yes)) continue;
    const looksVote = vote && (Number(m[1]) === vote.yes || Number(m[2]) === vote.no || /vot|tally|roll/i.test(all));
    if (looksVote && !(vote && Number(m[1]) === vote.yes && Number(m[2]) === vote.no)) p.push(`the tally ${m[0]} is not the recorded vote${vote ? ` (${vote.yes}-${vote.no})` : ''}`);
    else if (!vote && /vot/i.test(all) && !S.includes(m[0].toLowerCase())) p.push(`a tally ${m[0]} but the fact sheet records no vote`);
  }
  for (const m of all.matchAll(UNANIMOUS)) if (!(vote && vote.no === 0)) p.push(`"${m[1]}" but the recorded vote ${vote ? `has ${vote.no} against` : 'is not in the fact sheet'}`);

  // bill numbers
  const sheetBills = new Set(billNumbers(text).map(normBill));
  for (const b of billNumbers(all)) if (!sheetBills.has(normBill(b))) p.push(`bill number ${b} is not in the fact sheet`);

  // proper names: each capitalized word (not a month, not part of a bill number) must be in the fact sheet
  const inst = institutionWords(sheet), allowedRaw = all.replace(/\b(?:H\.\s?R\.|S\.\s?B\.|H\.\s?B\.|A\.\s?B\.|S\.|A\.|H\.)\s?\d+/g, ' ');
  const names = new Set();
  for (const m of allowedRaw.matchAll(/\b([a-z]*[A-Z][A-Za-z.&'’-]*[A-Za-z])/g)) {
    const w = m[1].replace(/['’]s$/, '').replace(/\.$/, ''), lw = w.toLowerCase();
    if (COMMON.has(lw) || inst.has(lw) || MONTH_WORD.test(w) || hasWord(S, lw)) continue;
    names.add(w);
  }
  if (names.size) p.push(`names or terms not in the fact sheet: ${[...names].slice(0, 6).join(', ')}`);

  // forbidden claims
  for (const m of all.matchAll(SUPERLATIVE)) if (!milestones.includes(m[1].toLowerCase())) p.push(`"${m[1]}" claims a milestone the fact sheet does not state`);
  for (const [re, what] of [[EVALUATIVE, 'an evaluative word'], [CAUSAL, 'a cause, motive or reaction'], [PREDICTIVE, 'a prediction']]) {
    for (const m of all.matchAll(re)) if (!hasWord(S, m[1])) p.push(`"${m[1]}" is ${what} the fact sheet does not state`);
  }
  if (/\bmay\b/.test(all)) p.push('"may" is a prediction or permission the fact sheet does not state');
  const meta = all.match(META); if (meta) p.push(`"${meta[1]}" writes about the fact sheet, not the event`);
  if (CHAMBER_INTRODUCED.test(all)) p.push('a chamber does not introduce a bill; write that the bill was introduced in it');
  for (const m of all.matchAll(/["“”]([^"“”]{2,})["“”]/g)) if (!S.includes(m[1].toLowerCase())) p.push(`quotation marks around words the fact sheet does not contain: "${m[1].slice(0, 40)}"`);
  if (/['‘’]([^'‘’]{4,})['‘’]/.test(all.replace(/\b\w+['’]s\b/g, '').replace(/\b\w+['’]\w+\b/g, ''))) p.push('quotation marks are not allowed');

  // tense against the event's timing, and the only future step allowed
  // a scheduled hearing is written with its hearing day (facts.hearing_date), never the day it was first seen
  if (ev.class === 'hearing-scheduled' && ev.hearing_date) {
    const written = new Set(datesIn(all));
    if (!written.has(ev.hearing_date)) p.push(`the hearing day ${ev.hearing_date} is not given`);
    if (ev.date !== ev.hearing_date && written.has(ev.date)) p.push(`${ev.date} is the day the hearing was first listed, not the hearing day (${ev.hearing_date})`);
  }
  if (ev.timing === 'scheduled') {
    const h = lower.match(HELD_WORDS); if (h) p.push(`"${h[1]}" writes a scheduled event as if it had happened`);
    if (!SCHEDULED_WORDS.test(all)) p.push('the event is scheduled, but the card does not say it is upcoming');
  } else {
    const f = all.match(FUTURE_IN_HELD); if (f && !hasWord(S, f[1])) p.push(`"${f[1]}" writes an event that happened as if it were still to come`);
    const nx = all.match(NEXT_WORDS); if (nx) p.push(`"${nx[1]}" states a next step; a card states only what the record shows happened`);
  }
  outcomeProblems(headline, body, sheet).forEach((x) => p.push(x));
  return [...new Set(p)];
}

// ---------- outcome, chamber, time and name whitelist (review of 29 Oct) ----------
// Each class may state only its own outcome: the card must contain the class's outcome phrase, and no outcome phrase of another class.
const PASSAGE_CLASSES = new Set(['passage', 'committee-passage', 'concurrence', 'amendment-passage', 'veto-override-passage', 'enrolled', 'executive-receipt', 'executive-signature', 'became-law']);
const FAILURE_CLASSES = new Set(['failure', 'committee-failure', 'withdrawal']);
const BOTH_CLASSES = new Set(['concurrence', 'enrolled', 'executive-receipt', 'executive-signature', 'became-law', 'executive-veto', 'veto-override-passage']);
const SIGN_CLASSES = new Set(['executive-signature', 'became-law', 'executive-order', 'presidential-memo']);
const VETO_CLASSES = new Set(['executive-veto', 'veto-override-passage']);
export const REQUIRED_OUTCOME = {
  introduction: /\b(introduc\w*|filed)\b/i, 'referral-committee': /\brefer\w*\b/i, 'hearing-scheduled': /\bhearing\b/i, 'hearing-held': /\b(hearing|heard)\b/i,
  'committee-passage': /\b(pass(?:ed|es)?|approv\w*|advanc\w*|ordered|reported)\b/i, 'committee-failure': /\b(fail\w*|reject\w*|voted down)\b/i,
  passage: /\b(pass(?:ed|es)?|approv\w*)\b/i, failure: /\b(fail\w*|reject\w*|defeat\w*|voted down)\b/i, 'amendment-passage': /\bamend\w*\b/i,
  concurrence: /\bconcurr?\w*\b/i, enrolled: /\benroll\w*\b/i, 'executive-receipt': /\b(sent|presented|delivered|transmitted)\b/i,
  'executive-signature': /\b(sign\w*|approv\w*)\b/i, 'became-law': /\b(became law|law)\b/i, 'executive-veto': /\bveto\w*\b/i, 'veto-override-passage': /\boverr?(?:ide|ode|idden)\b/i,
  withdrawal: /\bwithdr\w*\b/i, 'executive-order': /\b(sign\w*|issu\w*)\b/i, 'court-filing': /\bfil\w*\b/i, 'court-ruling': /\b(rul\w*|decid\w*|order\w*)\b/i,
  'agency-rule-final': /\bfinal rule\b/i, 'agency-rule-proposed': /\bpropos\w*\b/i, nomination: /\bnominat\w*\b/i
};
const SIGN_WORDS = /\b(sign(?:s|ed|ing)?|into law|(?:is |are )?now (?:a )?law|became (?:a )?law|becomes (?:a )?law|enact(?:s|ed|ment|ing)?|chaptered|public act)\b/i;
const VETO_WORDS = /\bveto(?:es|ed|ing)?\b/i;
const SEND_WORDS = /\b(sent|sends|send|delivered|presented|transmitted|forwarded)\b[^.]{0,60}\b(governor|president|desk)\b|\b(?:governor|president)['’]s desk\b/i;
const FAIL_WORDS = /\b(reject\w*|fail(?:s|ed|ing)?|did not pass|does not pass|not passed|defeat\w*|voted down|killed|died|blocked|stalled|tabled)\b/i;
const PASS_WORDS = /\b(pass(?:ed|es)|approv(?:ed|es)|adopt(?:ed|s)|advanc(?:ed|es)|clear(?:ed|s))\b/i;
const OUTCOME_VERB = /\b(pass(?:ed|es)?|approv\w*|adopt\w*|advanc\w*|clear(?:ed|s)?|vot\w*|reject\w*|fail\w*|concurr?\w*|defeat\w*|overr?(?:ide|ode)\w*|enact\w*)\b/i;
const CHAMBER_WORD = /\b(general assembly|senate|house|assembly|legislature|congress|lawmakers|legislators|both chambers|both houses)\b/gi;
const BOTH_WORDS = new Set(['legislature', 'congress', 'lawmakers', 'legislators', 'both chambers', 'both houses']);
export const RELATIVE_TIME = /\b(yesterday|today|tonight|tomorrow|(?:last|this|next|past|coming) (?:week|month|year|session|weekend)|earlier|later this|recently|lately|ago|soon|this (?:morning|afternoon|evening)|just)\b/i;
// Titles before a person's name (TITLE_NAME, AFTER_TITLE_OK, news/lexicon.mjs): the word after one must be in the sheet (case does not matter).
// Officials and sponsors the tracker names anywhere: any of these in a card (any case) must be in its sheet.
let LEXICON = null;
const KNOWN_OFFICIALS = 'newsom pritzker hochul trump biden vance harris murphy healey whitmer shapiro lamont youngkin spanberger polis kotek hobbs sherrill mamdani adams wiener bores gounardes padilla schiff schumer thune cruz klobuchar cantwell hawley blumenthal warner schatz kim bennet welch cotton liccardo kiley lieu obernolte beyer peters'.split(' ');
export function nameLexicon() {
  if (LEXICON) return LEXICON;
  LEXICON = new Set(KNOWN_OFFICIALS);
  try {
    const f = new URL('../../web/data/v2/entries.json', import.meta.url), d = JSON.parse(readFileSync(f, 'utf8'));
    // surnames only: "Wiener (D", "Sen. Scott Wiener", "Rep. Lieu"
    const NAME_RES = [/\b([A-Z][a-z'’-]{2,})\s*\((?:[DRI]\b|[DRI]-)/g, /\b(?:Sen|Rep|Asm|Gov|Del|Senator|Representative|Assemblymember)\.?\s+(?:[A-Z][a-z.]+\s+){0,2}([A-Z][a-z'’-]{2,})/g];
    for (const e of Array.isArray(d) ? d : d.entries) for (const re of NAME_RES) for (const m of String(e.sponsor_text || '').matchAll(re)) LEXICON.add(m[1].toLowerCase());
  } catch { /* the fixed list alone */ }
  for (const w of ['senate', 'house', 'assembly', 'state', 'district', 'rep', 'reps', 'sens', 'cosponsors', 'sponsor', 'sponsors', 'with', 'from', 'joint', 'committee', 'members', 'introduced', 'bill']) LEXICON.delete(w);
  return LEXICON;
}

export function outcomeProblems(headline, body, sheet) {
  const p = [], all = `${headline}\n${body}`, S = sheetText(sheet).toLowerCase(), ev = sheet.event || {}, cls = ev.class;
  const b = sheet.bill || {};
  // review r6 #5: a simple resolution never passes "both chambers"
  const both = !b.simple_resolution && (BOTH_CLASSES.has(cls) || sheet.stage_code === 'passed-both');
  // review r6 #1: law words only where the law wording is valid ("became law" for a became-law record; "into law"/"enact" for a signed bill)
  const lawOk = cls === 'became-law' ? b.became_law_ok === true : b.law_wording === true;
  const lw = all.match(/\b(becomes? law|became law|into law|now law|enact(?:s|ed|ment|ing)?)\b/i);
  if (lw && !lawOk && !['executive-order', 'presidential-memo'].includes(cls)) p.push(`"${lw[1]}" claims a law, but this measure's law wording is not valid (resolution, amendment, territory or unknown number)`);
  const req = REQUIRED_OUTCOME[cls];
  if (req && !req.test(all)) p.push(`the card does not state the event's own outcome (${cls})`);
  const sw = all.match(SIGN_WORDS); if (sw && !SIGN_CLASSES.has(cls)) p.push(`"${sw[1]}" states a signing or enactment, but the event is ${cls}`);
  const vw = all.match(VETO_WORDS); if (vw && !VETO_CLASSES.has(cls)) p.push(`"${vw[0]}" states a veto, but the event is ${cls}`);
  const sd = all.match(SEND_WORDS); if (sd && cls !== 'executive-receipt') p.push(`"${sd[0].slice(0, 40)}" states the bill was sent to the executive, but the event is ${cls}`);
  const fw = all.match(FAIL_WORDS); if (fw && PASSAGE_CLASSES.has(cls)) p.push(`"${fw[1]}" states the opposite outcome of ${cls}`);
  const pw = all.match(PASS_WORDS); if (pw && FAILURE_CLASSES.has(cls)) p.push(`"${pw[1]}" states the opposite outcome of ${cls}`);
  // chambers: in a sentence stating an outcome, only the event's own chamber (or its committee's) may appear; the whole legislature only
  // for an event after both chambers passed
  const own = new Set([ev.chamber, ev.committee].filter(Boolean).flatMap((x) => [...String(x).toLowerCase().matchAll(CHAMBER_WORD)].map((m) => m[1])));
  for (const s of [headline, ...sentences(body)]) {
    for (const m of s.matchAll(CHAMBER_WORD)) {
      const w = m[1].toLowerCase();
      if (BOTH_WORDS.has(w)) { if (own.has(w) && isUnicameral(b.jurisdiction)) continue; // a unicameral legislature is its own chamber
        if (!both && (OUTCOME_VERB.test(s) || /both/.test(w))) p.push(`"${m[1]}" states an act of the whole legislature, but the event is ${cls}${ev.chamber ? ` in the ${ev.chamber}` : ''}`); continue; }
      if (OUTCOME_VERB.test(s) && !own.has(w) && !(w === 'assembly' && own.has('general assembly'))) p.push(`"${m[1]}" in a sentence stating the outcome, but the event is ${ev.chamber ? `in the ${ev.chamber}` : 'not a chamber action'}`);
    }
  }
  const rt = all.match(RELATIVE_TIME); if (rt) p.push(`"${rt[1]}" is a relative time; give the date from the fact sheet`);
  for (const m of all.matchAll(COLOUR)) if (!hasWord(S, m[1])) p.push(`"${m[1]}" adds procedural detail the fact sheet does not state`);
  for (const m of all.matchAll(TITLE_NAME)) if (!AFTER_TITLE_OK.test(m[1]) && !hasWord(S, m[1])) p.push(`"${m[0]}" names someone the fact sheet does not name`);
  const lex = nameLexicon();
  for (const m of all.matchAll(/\b([A-Za-z][a-z'’-]{3,})\b/g)) { const w = m[1].toLowerCase().replace(/['’]s$/, ''); if (lex.has(w) && !hasWord(S, w)) p.push(`"${m[1]}" names someone the fact sheet does not name`); }
  return p;
}

// The card from the event's own template, or one built from the sheet if the event has none.
export function templateCard(event, sheet) {
  const t = (event && event.card) || {};
  if (t.template_headline && t.template_body) return { headline: t.template_headline, body: t.template_body };
  const b = sheet.bill || {}, name = b.short_title || b.number || 'Measure';
  return { headline: `${name}: ${String(sheet.stage || (sheet.event && sheet.event.class) || 'update')}`.slice(0, CARD_LIMITS.headline), body: `${name} (${b.jurisdiction_name || b.jurisdiction}). Recorded ${sheet.event && sheet.event.date}.` };
}

const shapeOk = (d) => d && typeof d.headline === 'string' && typeof d.body === 'string';

// event: contract Event; entry: tracker entry (or null); writer, reader: AI clients ({ generate({system, prompt, itemId}) }).
// Returns { card: { headline, body, template_headline, template_body, written_by }, sheet, rounds, problems, reason }. Never throws.
// The phrase-bank card (news/phrasebank.mjs): the first deterministic candidate that passes checkCard; the template when none does.
export function bankCard({ event, entry = null, sheet = null, today = null }) {
  let fs = sheet, tpl;
  try {
    fs = fs || buildFactSheet(event, entry, { today }); tpl = templateCard(event, fs);
    const key = (event && event.key) || JSON.stringify(fs.event);
    let tried = 0;
    for (const c of candidates(fs, key)) {
      if (++tried > 400) break;
      if (!checkCard(c.check, fs).length && c.body.length <= CARD_LIMITS.body) return { card: { headline: c.headline, body: c.body, template_headline: tpl.headline, template_body: tpl.body, written_by: 'bank' }, sheet: fs, rounds: 0, problems: [], reason: null };
    }
    return { card: { headline: tpl.headline, body: tpl.body, template_headline: tpl.headline, template_body: tpl.body, written_by: 'template' }, sheet: fs, rounds: 0, problems: [], reason: tried ? 'no phrase-bank candidate passed the checks' : 'no phrase-bank variant fits this event' };
  } catch (e) {
    const t = tpl || (event && event.card) || {};
    return { card: { headline: t.headline || t.template_headline || null, body: t.body || t.template_body || null, template_headline: t.headline || t.template_headline || null, template_body: t.body || t.template_body || null, written_by: 'template' }, sheet: fs, rounds: 0, problems: [], reason: `phrase bank failed: ${e.message}` };
  }
}
export const aiWriterOn = (config) => !!(config && config.news && config.news.ai_writer === true);

// The card for an event. config/publish.json news.ai_writer (default false) picks the writer: false = the phrase bank (no AI, the
// AI path below is not reachable); true = the free AI writer, checked by code and a second reader. Never throws.
export async function writeCard({ config = null, ...args }) {
  if (!aiWriterOn(config)) return bankCard(args);
  return writeCardAI(args);
}

async function writeCardAI({ event, entry = null, sheet = null, writer, reader, today = null, maxRounds = 2, log = () => {} }) {
  let fs = sheet, tpl;
  try { fs = fs || buildFactSheet(event, entry, { today }); tpl = templateCard(event, fs); }
  catch (e) { const t = (event && event.card) || {}; return { card: { headline: t.template_headline || null, body: t.template_body || null, template_headline: t.template_headline || null, template_body: t.template_body || null, written_by: 'template' }, sheet: fs, rounds: 0, problems: [], reason: `fact sheet failed: ${e.message}` }; }
  const out = (written_by, c, rounds, problems, reason) => ({ card: { headline: c.headline, body: c.body, template_headline: tpl.headline, template_body: tpl.body, written_by }, sheet: fs, rounds, problems, reason });
  if (!writer || !reader) return out('template', tpl, 0, [], 'no AI client');
  const itemId = event && event.key ? `news-card:${event.key}` : undefined;
  let complaints = [], rounds = 0;
  try {
    for (rounds = 1; rounds <= maxRounds; rounds++) {
      const g = await writer.generate({ system: CARD_WRITER_SYSTEM, prompt: cardWriterPrompt(fs, complaints), itemId });
      const d = g && g.data;
      if (!shapeOk(d)) { complaints = ['answer as JSON {"headline": string, "body": string}']; continue; }
      const draft = { headline: d.headline.trim(), body: d.body.trim() };
      const p = checkCard(draft, fs);
      if (p.length) { complaints = p; log(`round ${rounds}: code refused: ${p.join('; ')}`); continue; }
      const r = await reader.generate({ system: CARD_READER_SYSTEM, prompt: cardReaderPrompt(fs, draft), itemId });
      const v = (r && r.data) || {};
      const list = Array.isArray(v.added_or_overstated) ? v.added_or_overstated.map(String).filter((x) => x.trim()) : null;
      if (v.faithful === true && list && list.length === 0) return out('ai', draft, rounds, [], null);
      complaints = list && list.length ? list.map((x) => `the second reader: ${x}`) : ['the second reader did not confirm the card as faithful'];
      log(`round ${rounds}: reader refused: ${complaints.join('; ')}`);
    }
    return out('template', tpl, maxRounds, complaints, 'not confirmed within the rounds');
  } catch (e) {
    return out('template', tpl, rounds, complaints, `AI step failed: ${e && e.name ? e.name + ': ' : ''}${e && e.message}`);
  }
}
