// The news card writer (news/CONTRACT.md: "the AI may only rewrite a closed fact sheet, checked by code, with a template fallback").
// 1. The writer (role "generator") writes a headline and a 2-3 sentence body from the fact sheet only (news/factsheet.mjs).
// 2. Code checks the card (checkCard): every number, date, money figure, vote, bill number and proper name must be in the fact sheet;
//    no forbidden claim (superlative without a milestone fact, prediction beyond the code-given next step, causal or evaluative words,
//    "unanimous" on a vote with any no); the tense agrees with the event's timing (scheduled vs held).
// 3. A second reader (role "validator") answers {faithful, added_or_overstated}; it must be faithful with an empty list.
// Up to maxRounds rounds, each refusal fed back word for word; otherwise the template card (written_by 'template').
// Never throws: an API failure, a budget stop or bad JSON means the template card.
import { buildFactSheet, sheetText, billNumbers, STATE_NAMES } from './factsheet.mjs';
import { CARD_WRITER_SYSTEM, cardWriterPrompt, CARD_READER_SYSTEM, cardReaderPrompt } from './writer-prompts.mjs';
import { digitRuns } from '../agents/source-text.mjs';
import { sentences, datesIn } from './text.mjs';

export const CARD_LIMITS = { headline: 90, body: 400, sentencesMin: 2, sentencesMax: 3 };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_RE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?(?:\s+(\d{1,2})(?!\d))?/g;
const MONTH_WORD = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)$/;
const monthNo = (m) => MONTHS.findIndex((x) => x.startsWith(m.slice(0, 3).toLowerCase())) + 1;
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text, w) => new RegExp(`(^|[^a-z0-9])${esc(w.toLowerCase())}([^a-z0-9]|$)`).test(text.toLowerCase());
const normBill = (s) => s.replace(/[\s.]/g, '').toUpperCase();

// Words that are refused unless the fact sheet itself uses them (evaluative, causal, predictive). Superlatives need a milestone fact.
export const SUPERLATIVE = /\b(first|only|largest|biggest|sole|unprecedented|landmark|historic|historical|groundbreaking|pioneering|most|strongest|toughest|broadest|never before)\b/gi;
export const EVALUATIVE = /\b(major|significant|sweeping|key|crucial|important|controversial|contentious|ambitious|strict|tough|robust|bipartisan|partisan|narrow(?:ly)?|overwhelming(?:ly)?|comfortabl[ey]|decisive(?:ly)?|easily|swiftly|quickly|finally|surpris\w*|notabl[ey]|closely watched|high-profile|aggressive|popular|embattled|hotly|fierce|heated|dramatic\w*|massive|huge|watershed|milestone|breakthrough|victory|win|defeat|blow|setback|rebuke|praised|criticized|criticised|welcomed|slammed)\b/gi;
export const CAUSAL = /\b(because|due to|as a result|in response|prompt(?:ed|ing)|amid|thanks to|leading to|triggered|sparked|so that|in a bid|reaction|backlash|critics|supporters|advocates|opponents|proponents|pressure|aims? to|aimed|seeks? to|intended to|in order to|motivated|concerns?|fears?|worries)\b/gi;
export const PREDICTIVE = /\b(likely|unlikely|expected|expects?|poised|could|might|soon|eventually|pav(?:es|ed|ing) the way|clears? the way|on track|headed for|chances?|probably|set to become|is set to pass|will (?:likely|probably|become law|pass|be signed|take effect))\b/gi;
export const UNANIMOUS = /\b(unanimous(?:ly)?|without (?:opposition|dissent|objection)|no (?:opposition|dissent)|every member|all members|no one (?:voted|opposed))\b/gi;
export const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozen|half|twice|double|triple|single)\b/gi;
const WEEKDAY = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/;
const HELD_WORDS = /\b(held|heard|took place|convened|met|testified|was heard|were heard|discussed|examined|took up|considered)\b/i;
const SCHEDULED_WORDS = /\b(scheduled|will|set to|set for|upcoming|plans to|is to)\b/i;
const FUTURE_IN_HELD = /\b(scheduled|upcoming|set to|set for|plans to|is to hold)\b/i;
const NEXT_WORDS = /\b(will|next|heads? to|moves? to|goes to|now goes|awaits?|awaiting|pending before)\b/i;

// Capitalized words a card may use without the sheet naming them: function words that start sentences, and generic nouns.
const COMMON = new Set(('the a an it its this that these those on in at by for with under after before from to of and or as its ' +
  'bill bills act measure law legislation lawmakers legislators committee committees hearing vote votes rule order report court comments ' +
  'state states federal new under public text version amendment amendments chamber floor proposal resolution members member ' +
  'judge referred introduced passed signed vetoed approved filed withdrawn sent senators representatives sponsors also both now next ' +
  'there their his her when while once if').split(' '));
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
    const nx = all.match(NEXT_WORDS); if (nx && !sheet.next) p.push(`"${nx[1]}" states a next step, but the fact sheet gives none`);
  }
  return [...new Set(p)];
}

// The card from the event's own template, or one built from the sheet if the event has none.
export function templateCard(event, sheet) {
  const t = (event && event.card) || {};
  if (t.template_headline && t.template_body) return { headline: t.template_headline, body: t.template_body };
  const b = sheet.bill || {}, name = b.short_title || b.number || 'Measure';
  return { headline: `${name}: ${String(sheet.stage || (sheet.event && sheet.event.class) || 'update')}`.slice(0, CARD_LIMITS.headline), body: `${name} (${b.jurisdiction_name || b.jurisdiction}). Recorded ${sheet.event && sheet.event.date}.${sheet.next ? ` Next: ${sheet.next}.` : ''}` };
}

const shapeOk = (d) => d && typeof d.headline === 'string' && typeof d.body === 'string';

// event: contract Event; entry: tracker entry (or null); writer, reader: AI clients ({ generate({system, prompt, itemId}) }).
// Returns { card: { headline, body, template_headline, template_body, written_by }, sheet, rounds, problems, reason }. Never throws.
export async function writeCard({ event, entry = null, sheet = null, writer, reader, today = null, maxRounds = 2, log = () => {} }) {
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
