// One news item from one primary lead: the official release is read, the writer (role "generator") drafts the title and body in
// the site's fixed style, code checks every quoted span and every number against the release, and a second reader (role
// "validator", which sees only the release and a numbered list of claims) must confirm each claim. Up to maxRounds rounds, with
// every complaint fed back word for word. A press (secondary) lead is never written: it is reported as a lead.
// Pure apart from the AI clients the caller passes in; nothing is written here.
import { WRITER_SYSTEM, writerPrompt } from './prompts.mjs';
import { VALIDATOR_SYSTEM, validatorPrompt, SCOPE_DEFINITION } from '../agents/prompts.mjs';
import { textProblems, foreignLetters, dateSupported } from '../agents/checks.mjs';
import { containsQuote, digitRuns, norm } from '../agents/source-text.mjs';
import { NEGATIVE_FINDING } from '../agents/rules.mjs';
import { longDate } from '../agents/derive.mjs';
import { LlmOutputError, InputTooLarge } from '../llm/gemini.mjs';
import { releaseDate, pressRepost, opinionPiece, linkKey } from './feeds.mjs';
import { releaseTracker, BILL_TEXT, numOf, billHit, billMentions } from './leads.mjs';
import { HttpError, NetworkError } from '../grabber/lib/http.mjs';

export const LIMITS = { title: 140, body: 700 };
export const MAX_RELEASE_CHARS = 40000;
// A release (and the item's date) may be at most this many days older than the date its feed lists it under: feeds re-list old
// releases (Rep. Liccardo's feed listed a Sept 16 release on Sept 25).
export const MAX_LISTING_LAG_DAYS = 7;
export const shiftDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const DEBRIS = /[{}]|['"][a-z_]{3,}['"]\s*:|```|\\n|\\u[0-9a-f]{4}/i;
// Every quoted span, straight or curly quotes, of 4 characters or more (shorter ones are scare quotes around a word).
const QUOTED = /["“]([^"“”]{4,})["”]/g;
export const checkLine = (publisher) => `From the official release (${publisher}), quotes checked by code.`;

// The release's own numbers, plus the numbers of the date the feed lists it under (the feed is the official body's own).
const allowedDigits = (release, lead) => new Set([...digitRuns(release), ...digitRuns(longDate(lead.date)), ...digitRuns(lead.date)]);

// Plain-code checks on one draft. Returns readable problems; empty means it may go to the second reader.
export function checkNewsDraft({ draft, release, lead, today }) {
  const p = [], d = draft || {};
  const title = String(d.title || '').trim(), body = String(d.body || '').trim();
  if (title.length < 5) p.push('no title');
  if (body.length < 20) p.push('no body');
  if (title.length > LIMITS.title) p.push(`title is ${title.length} characters, over ${LIMITS.title}`);
  if (body.length > LIMITS.body) p.push(`body is ${body.length} characters, over ${LIMITS.body}`);
  for (const [f, v] of [['title', title], ['body', body]]) {
    for (const m of v.matchAll(QUOTED)) if (!containsQuote(release, m[1])) p.push(`${f} puts words in quotation marks that RELEASE does not contain: "${m[1].slice(0, 60)}"`);
    textProblems(f, v, release).filter((x) => !/quotation marks/.test(x)).forEach((x) => p.push(x)); // quotations are checked above, more strictly
    if (DEBRIS.test(v)) p.push(`stray code or JSON syntax in the ${f}`);
    if (foreignLetters(v, release)) p.push(`letters RELEASE does not use in the ${f}`);
    if (NEGATIVE_FINDING.test(v)) p.push(`the ${f} states a search finding ("none located")`);
  }
  const ok = allowedDigits(release, lead), bad = [...digitRuns(`${title} ${body}`)].filter((n) => !ok.has(n));
  if (bad.length) p.push(`numbers not in RELEASE: ${bad.join(', ')}`);
  // Every date written in the item is the release's own (or the feed's listing date): a release dated one day may describe an event on another.
  for (const iso of datesIn(`${title} ${body}`)) if (iso !== lead.date && !dateSupported(iso, release)) p.push(`the date ${iso} written in the item is not in RELEASE`);
  p.push(...attributionProblems(`${title} ${body}`, release));
  const ev = (d.evidence || []).filter((x) => x && x.quote);
  if (!ev.length) p.push('no evidence quote');
  ev.filter((x) => !containsQuote(release, x.quote)).forEach((x) => p.push(`evidence quote not in RELEASE: "${String(x.quote).slice(0, 60)}"`));
  ev.filter((x) => String(x.quote).trim().length < 8).forEach((x) => p.push(`evidence quote too short: "${x.quote}"`));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) p.push('no date (YYYY-MM-DD)');
  else {
    if (d.date > today) p.push(`date ${d.date} is in the future`);
    if (d.date !== lead.date && !dateSupported(d.date, release)) p.push(`date ${d.date} is neither in RELEASE nor the date the feed lists it under (${lead.date})`);
    if (d.date < shiftDays(lead.date, -MAX_LISTING_LAG_DAYS)) p.push(`date ${d.date} is more than ${MAX_LISTING_LAG_DAYS} days before the date the feed lists it under (${lead.date}): old news, not written`);
  }
  return p;
}

// Dates written out in the item ("Sept 22, 2026", "September 22 2026"), as YYYY-MM-DD. A date without its year is textProblems' to refuse.
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;
export const datesIn = (s) => [...String(s || '').matchAll(DATE)].map((m) => `${m[3]}-${String(MON.indexOf(m[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`);

// Who said it. A quotation is given to the person RELEASE gives it to: the speaker's name must stand within NEAR characters of those words
// in RELEASE (the release may quote two members). "according to X" / "X reported" must name someone RELEASE names, so a press story is never
// passed off as the official body's statement.
const NEAR = 300;
const NAME = "((?:[A-Z][a-z'’-]+\\s+){0,2}[A-Z][a-z'’-]+)";
const TITLES = '(?:(?:Reps?|Sens?|Gov|Lt|Dr|Mr|Mrs|Ms)\\.\\s+|(?:Congress(?:man|woman)|Senator|Representative|Governor|Secretary|Director|Chair(?:man|woman)?)\\s+)?';
const VERB = '(?:said|says|added|stated|wrote|called|warned|urged|noted|declared)';
const SPEAKER_AFTER = new RegExp(`\\b${VERB}\\s+${TITLES}${NAME}`, 'g'), SPEAKER_BEFORE = new RegExp(`${NAME}\\s+${VERB}\\b`, 'g');
const SOURCED = new RegExp(`\\b[Aa]ccording to\\s+(?:the\\s+)?${TITLES}${NAME}|${NAME}\\s+(?:reported|reports)\\b`, 'g');
const NOT_NAMES = /^(?:The|It|He|She|They|This|That|Today|Rep|Reps|Sen|Sens|Congressman|Congresswoman|Senator|Representative|Governor|Secretary|Director|Chair|Chairman|Chairwoman|A|An|And|But)$/;
const surname = (n) => { const w = n.trim().split(/\s+/).filter((x) => !NOT_NAMES.test(x)); return w.length ? w[w.length - 1].replace(/['’]s$/, '') : null; };
export function attributionProblems(text, release) {
  const p = [], R = norm(release);
  for (const s of sentences(text)) {
    const quotes = [...s.matchAll(QUOTED)].map((m) => m[1]);
    const speakers = [...s.matchAll(SPEAKER_AFTER), ...s.matchAll(SPEAKER_BEFORE)].map((m) => surname(m[1])).filter(Boolean);
    for (const q of quotes) {
      const at = R.indexOf(norm(q));
      if (at < 0) continue; // an invented quotation is refused by the quotation check
      for (const who of speakers) {
        const near = R.slice(Math.max(0, at - NEAR), at + norm(q).length + NEAR);
        if (!new RegExp(`\\b${norm(who).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(near)) p.push(`the quotation "${q.slice(0, 50)}" is given to ${who}, but RELEASE does not name ${who} next to those words`);
      }
    }
    for (const m of s.matchAll(SOURCED)) {
      const who = surname(m[1] || m[2]);
      if (who && !R.includes(norm(who))) p.push(`the item attributes a statement to "${who}", whom RELEASE does not name: write only what the official release itself states`);
    }
  }
  return p;
}

// The claims the second reader checks: the title and each sentence of the body, split by code.
// A full stop after a title or an abbreviation ("Reps.", "Sen.", "U.S.", "H.R.", "Sept.") does not end a sentence.
const ABBREV = /(?:\b(?:Reps?|Sens?|Gov|Lt|Dr|Mr|Mrs|Ms|Jr|Sr|St|No|Nos|Inc|Co|Corp|vs|Dept|Jan|Feb|Aug|Sept?|Oct|Nov|Dec)|\b[A-Z](?:\.[A-Z])*)\.$/;
export function sentences(text) {
  const out = [];
  for (const piece of String(text || '').trim().split(/(?<=[.!?][”"]?)\s+(?=[A-Z“"])/)) {
    if (out.length && ABBREV.test(out[out.length - 1])) out[out.length - 1] += ' ' + piece; else out.push(piece);
  }
  return out.map((s) => s.trim()).filter((s) => s.length > 3);
}
export const claimsOf = (d) => [{ field: 'title', claim: String(d.title).trim() }, ...sentences(d.body).map((s, i) => ({ field: `body[${i}]`, claim: s }))];

// lead: from news/leads.mjs. release: the release text (feeds.mjs releaseText). writer, checker: AI clients. examples: news items to copy the style of.
// Returns { outcome: 'drafted' | 'not_newsworthy' | 'rejected' | 'waiting' | 'secondary' | 'error', item?, rounds, problems, reason }
// index: news/leads.mjs entryIndex of the tracked entries (the item's tracker comes only from the release itself, confirmed by the
// second reader). kindOf(key): the news kind for an entry. maxAgeDays: the feed window; a release dated before it is old news.
export async function draftNews({ lead, release, writer, checker, examples = [], today, runId, now = new Date(), maxRounds = 2, entryKind = null, index = [], kindOf = null, maxAgeDays = 14 }) {
  if (!lead.primary) return { outcome: 'secondary', rounds: 0, problems: [], reason: 'press report: published only after an official source confirms it' };
  if (!release || release.length < 200) return { outcome: 'error', retry: true, rounds: 0, problems: [], reason: 'the release page had no readable text' };
  if (pressRepost(release)) return { outcome: 'secondary', rounds: 0, problems: [], reason: 'a press story reposted on the official site (byline or "In The News"): a press lead, not the body\'s own release' };
  if (opinionPiece(release)) return { outcome: 'secondary', rounds: 0, problems: [], reason: 'an opinion piece (op-ed or column) on the official site: a lead, not the body\'s own release' };
  // Freshness from the release's own date, not only the feed's: a feed may re-list an old release.
  const own = releaseDate(release, lead.date);
  if (!own) return { outcome: 'rejected', rounds: 0, problems: [], reason: `the release states no date of its own (no date line or dateline, and no date in its opening within 2 days of the feed date ${lead.date}), so its freshness cannot be checked` };
  if (own > today) return { outcome: 'rejected', rounds: 0, problems: [], reason: `the release is dated ${own}, after today` };
  if (own < shiftDays(today, -maxAgeDays)) return { outcome: 'rejected', rounds: 0, problems: [], reason: `the release is dated ${own}, older than the ${maxAgeDays}-day window: old news` };
  if (own < shiftDays(lead.date, -MAX_LISTING_LAG_DAYS)) return { outcome: 'rejected', rounds: 0, problems: [], reason: `the release is dated ${own}, more than ${MAX_LISTING_LAG_DAYS} days before its feed listed it (${lead.date}): old news re-listed` };
  // A release longer than the limit is checked against its opening only; a claim not found there is refused, never passed or guessed.
  const cut = release.length > MAX_RELEASE_CHARS;
  if (cut) release = release.slice(0, MAX_RELEASE_CHARS);
  const CUT_REASON = `the release is longer than ${MAX_RELEASE_CHARS} characters and a claim was not found in the part read: refused rather than checked against a cut text`;
  // The tracked entry the release itself names, in its jurisdiction; the second reader must confirm the release is about it.
  // A bill event the release dates ("Today ... introduced H.R. 9917") must agree with the tracked entry's own record (audit N4).
  // A record that already shows the event on another date contradicts the release: refused. An event the record may simply not show
  // YET (record lag) is 'waiting': not marked seen, retried each run until the record shows it or the freshness window closes.
  const claims = eventClaims({ text: release, date: own, index, state: lead.state || null });
  const contra = claims.filter((c) => !c.lag);
  if (contra.length) return { outcome: 'rejected', rounds: 0, problems: contra.map((c) => c.text), reason: contra[0].text };
  if (claims.length) return { outcome: 'waiting', retry: true, waiting_for_record: true, release_date: own, rounds: 0, problems: claims.map((c) => c.text), reason: `waiting for the official record: ${claims[0].text.replace(/: refused$/, '')}; retried each run until the record shows it or the ${maxAgeDays}-day window closes` };
  const cand = index.length ? releaseTracker({ release, index, state: lead.state || null }) : null;
  const aboutClaim = cand ? { field: 'subject', claim: `This release is about ${cand.label}: its main subject is that bill (it announces, describes or acts on it), not a passing mention.` } : null;
  const itemId = 'news:' + lead.id;
  let feedback = [], problems = [];
  try {
    for (let round = 1; round <= maxRounds; round++) {
      let r;
      try { r = await writer.generate({ system: WRITER_SYSTEM, prompt: writerPrompt({ release, lead, scope: SCOPE_DEFINITION, examples, feedback }), itemId: `${itemId}:w${round}` }); }
      catch (e) { if (!(e instanceof LlmOutputError)) throw e; problems = [`the writer gave an unusable answer: ${e.message}`]; feedback = problems; continue; }
      const d = r.data || {};
      if (d.newsworthy === false) return { outcome: 'not_newsworthy', rounds: round, problems: [], reason: 'the writer found the release is not about frontier-AI law or policy' };
      problems = checkNewsDraft({ draft: d, release, lead, today });
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) problems.push(...eventDisagreements({ text: `${d.title || ''}. ${d.body || ''}`, date: d.date, index, state: lead.state || null, tracker: cand ? cand.key : null }));
      // The second reader runs even when code refused the draft, so the writer gets every complaint at once.
      const claims = claimsOf(d).filter((c) => c.claim);
      const asked = aboutClaim ? [...claims, aboutClaim] : claims;
      let res;
      try { res = await checker.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: release, claims: asked }), itemId: `${itemId}:c${round}` }); }
      catch (e) { if (!(e instanceof LlmOutputError)) throw e; res = { data: { results: [] } }; problems.push(`the second reader gave an unusable answer (${e.message})`); }
      const byN = new Map(((res.data && res.data.results) || []).map((x) => [x.n, x]));
      claims.forEach((c, i) => {
        const x = byN.get(i + 1);
        if (!x) problems.push(`the second reader did not answer for the ${c.field}`);
        else if (x.supported !== true) problems.push(`the ${c.field} ("${c.claim.slice(0, 100)}") is not supported: ${String(x.reason || 'not in RELEASE').slice(0, 200)}`);
        else if (!containsQuote(release, x.quote)) problems.push(`the second reader's quote for the ${c.field} is not in RELEASE`);
      });
      if (cut && problems.some((p) => /not in RELEASE|does not contain|not supported|is not in RELEASE/.test(p))) return { outcome: 'rejected', rounds: round, problems, reason: CUT_REASON };
      // The tracker: only when the second reader confirms, with a quote found in the release, that the release is about that entry.
      // A bill mentioned in passing, or no confident match, gives no tracker.
      const ab = aboutClaim ? byN.get(asked.length) : null;
      const tracker = ab && ab.supported === true && containsQuote(release, ab.quote) && String(ab.quote).trim().length >= 8 ? cand.key : null;
      if (!problems.length) return { outcome: 'drafted', rounds: round, problems: [], tracker_candidate: cand ? cand.key : null, item: itemOf({ d, lead, runId, now, round, entryKind: tracker && kindOf ? kindOf(tracker) : entryKind, tracker }) };
      feedback = problems;
    }
  } catch (e) {
    if (e instanceof InputTooLarge) return { outcome: 'error', rounds: 0, problems: [], reason: e.message };
    if (e instanceof HttpError || e instanceof NetworkError) return { outcome: 'error', retry: true, service_error: true, rounds: 0, problems: [], reason: `the model service failed: ${String(e.message).slice(0, 160)}` };
    throw e;
  }
  return { outcome: 'rejected', rounds: maxRounds, problems, reason: problems[0] };
}

const SHORT = ['Jan', 'Feb', 'March', 'April', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
// The news item, in the shape of the existing ones. Title, body and date are the checked draft; everything else is code's.
function itemOf({ d, lead, runId, now, round, entryKind, tracker }) {
  const [, m, day] = d.date.split('-').map(Number);
  return {
    date: d.date, kind: entryKind || lead.kind, title: String(d.title).trim(), body: String(d.body).trim(),
    links: [{ t: `${lead.publisher} release, ${SHORT[m - 1]} ${day}`, u: lead.release_url }],
    check: checkLine(lead.publisher),
    tracker: tracker || null, origin: 'automated',
    verification: { method: 'agent', checked_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), run_id: runId, rounds: round },
    evidence: d.evidence.filter((x) => x && x.quote).map((x) => ({ field: 'body', quote: String(x.quote).trim(), source_url: lead.release_url }))
  };
}

// What kind of event an item reports, from its own words (for telling one event reported twice from two events about one bill).
const EVENT_KINDS = [
  ['enacted', /\b(signed|signs|enacted|became law|public law)\b/i], ['vetoed', /\bveto/i], ['passed', /\b(passed|passes|approved by|adopted)\b/i],
  ['hearing', /\b(hearing|testif\w*|briefing)\b/i], ['committee', /\b(mark-?up|marked up|reported by|committee reports?)\b/i],
  ['litigation', /\b(sue[sd]?|lawsuit|court|petition|injunction|appeal\w*)\b/i], ['letter', /\b(letters?|urg\w+|demand\w*|ask\w*|call(?:s|ed)? on|press(?:es|ed)?)\b/i],
  ['introduced', /\b(introduc\w+|unveil\w*|announc\w+|fil(?:es|ed)|propos\w+|draft\w*|releas\w+)\b/i]
];
export const eventKind = (n) => { const t = `${n.title} ${n.body || ''}`; const k = EVENT_KINDS.find(([, re]) => re.test(t)); return k ? k[0] : 'other'; };
const STOP = new Set('that this with from have will would their they which about into after before over under than then there were been being also more most such other what when where while your these those them said says rep. reps. sen. sens. congressman congresswoman senator representative'.split(' '));
const words = (s) => new Set(norm(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
export const similarity = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of A) if (B.has(w)) n++; return n / (A.size + B.size - n); };
const dayGap = (a, b) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5;
export const DUP = { window_days: 7, title: 0.6, text: 0.5 };

// A drafted item that reports an event already on the page is not added. One event: the same release by any URL (canonicalised: http
// or https, www, trailing slash, tracking parameters); the same tracked entry within DUP.window_days days and the same event kind (a
// sponsor's release the day after the fixed-wording Lane 1 item); or a near-identical title or text (the same event from two feeds).
// news: every item on the page, the hand-written and Lane 1 ones included, plus this run's drafts.
// Also one event: reported in other words, with or without a tracker (audit N5a/N5b, N11: one 40-member letter released by two offices;
// a second release about a bill announcement already on the page): dates within DUP.event_days days and the same distinctive names,
// numbers, dates and bill numbers (sameEvent). When that is unclear the item is treated as a duplicate: it is reported, not published.
export function duplicateOf(item, news) {
  const mine = new Set((item.links || []).map((l) => linkKey(l.u))), kind = eventKind(item), text = `${item.title} ${item.body}`;
  return news.find((n) => norm(n.title) === norm(item.title)
    || (n.links || []).some((l) => mine.has(linkKey(l.u)))
    || (item.tracker && n.tracker === item.tracker && dayGap(n.date, item.date) <= DUP.window_days && eventKind(n) === kind)
    || similarity(n.title, item.title) >= DUP.title || similarity(`${n.title} ${n.body || ''}`, text) >= DUP.text
    || sameEvent(item, n)) || null;
}

// ---- one event, told by its distinctive entities ----
// Capitalised words too common to tell two events apart.
const COMMON_CAPS = new Set(('the a an and but or of in on at to for by with from as it its he she they we our this that these those today yesterday tomorrow ' +
  'rep reps sen sens senator senators representative representatives congressman congresswoman congressmen congresswomen congressmember congressmembers ' +
  'member members colleagues congress house senate department secretary act acts bill bills legislation ai a.i us u.s usa federal state states committee subcommittee ' +
  'chair chairman chairwoman ranking democrat democrats republican republicans democratic bipartisan president administration government office national ' +
  'american americans united america washington d.c dc d r i ca new release releases statement statements letter letters press frontier artificial intelligence ' +
  'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec ' +
  'monday tuesday wednesday thursday friday saturday sunday mr mrs ms dr gov governor attorney general').split(' '));
export const DUP_EVENT = { days: 3, same_kind: 3, any_kind: 0.6 };
// Each entity with its weight: a bill number (or, without one, a bill's "... Act" name), a written date other than the item's own, or a
// number ("40 members") counts 2; a distinctive capitalised name counts 1. A person written "Sam Liccardo" or "Ted W. Lieu" is one name
// (the surname); a longer run of capitals ("Bureau of Industry and Security") keeps each word.
export function eventEntities(n) {
  const m = new Map(), add = (k, w) => m.set(k, Math.max(m.get(k) || 0, w));
  let t = `${n.title || ''}. ${n.body || ''}`;
  for (const b of t.matchAll(BILL_TEXT)) add('bill:' + numOf(b[1] || b[2], b[3]), 2);
  t = t.replace(BILL_TEXT, ' ');
  const acts = [...t.matchAll(/(?:\b[A-Z][\w'’-]*\s+){1,7}Act\b/g)].map((x) => x[0].replace(/^(?:The|A|An|AI)\s+/, '').trim());
  if (![...m.keys()].length) acts.forEach((a) => add('act:' + norm(a), 2));
  t = t.replace(/(?:\b[A-Z][\w'’-]*\s+){1,7}Act\b/g, ' ');
  for (const iso of datesIn(t)) if (iso !== n.date) add('date:' + iso, 2);
  t = t.replace(DATE, ' ');
  for (const x of t.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)) { const v = x[0].replace(/,/g, ''); if (!/^(?:19|20)\d\d$/.test(v)) add('num:' + v, 2); }
  const keep = (w) => { const k = w.replace(/['’]s$/, '').replace(/\.$/, '').toLowerCase(); return k.length >= 2 && !COMMON_CAPS.has(k) ? k : null; };
  // Runs of capitalised words (a middle initial "W." stays inside the run), split at hyphens and dashes ("US–China").
  for (const run of t.matchAll(/\b[A-Z][A-Za-z'’.]*(?:\s+(?:[A-Z]\.\s+)?[A-Z][A-Za-z'’.]*)*|\b[A-Z][\w'’]*(?:[-–][A-Z][\w'’]*)+/g)) {
    const words = run[0].split(/\s+|[-–]/).filter((w) => !/^[A-Z]\.$/.test(w)).map(keep).filter(Boolean);
    (words.length === 2 && /\s/.test(run[0]) && !/[-–]/.test(run[0]) ? [words[1]] : words).forEach((k) => add('name:' + k, 1));
  }
  return m;
}
// Two items report one event: dated within DUP_EVENT.days days, and their shared entities weigh DUP_EVENT.same_kind or more when they
// report the same (known) kind of event, or make up DUP_EVENT.any_kind of all their entities by weight, whatever the kind.
export function sameEvent(a, b) {
  if (!a.date || !b.date || dayGap(a.date, b.date) > DUP_EVENT.days) return false;
  const A = eventEntities(a), B = eventEntities(b);
  let shared = 0, total = 0;
  for (const [k, w] of A) { total += w; if (B.has(k)) shared += Math.min(w, B.get(k)); }
  for (const [k, w] of B) if (!A.has(k)) total += w;
  if (!shared) return false;
  const ka = eventKind(a);
  return (ka !== 'other' && ka === eventKind(b) && shared >= DUP_EVENT.same_kind) || shared / total >= DUP_EVENT.any_kind;
}

// ---- a bill event the text dates must agree with the tracked entry's record ----
// "Today ... introduced H.R. 9917" in a release dated Oct 25, when the record shows the bill introduced on July 23, is refused (audit N4).
// A dated statement of an event (introduced, passed, signed, referred or heard, vetoed) about a tracked bill, named by its number in
// the entry's jurisdiction or by its name, must match an event of the same kind in the entry's record within EVENT_AGREE_DAYS days.
// A statement with no date of its own ("introduced by Reps. ..." as a description) is not a dated event and is not tested.
export const EVENT_AGREE_DAYS = 3;
const EVENT_VERBS = [
  ['Introduced / published', 'introduced|introduces|re-?introduced|filed|unveiled|unveils'],
  ['Passed / advanced', 'passed|passes|approved|approves|adopted|adopts|advanced|advances'],
  ['Signed / enacted', 'signed|signs|enacted|enacts'],
  ['Referred / stalled / hearing', 'referred|marked up|held a hearing on|holds a hearing on'],
  ['Vetoed / failed / rescinded', 'vetoed|vetoes']
];
const VERBS = EVENT_VERBS.map((v) => v[1]).join('|');
const kindOfVerb = (v) => (EVENT_VERBS.find(([, re]) => new RegExp(`^(?:${re})$`, 'i').test(v.trim())) || [null])[0];
const BILL_OBJ = BILL_TEXT.source.replace(/\((?!\?)/g, '(?:');
const ACTIVE_BILL = new RegExp(`\\b(${VERBS})\\s+(?:(?:the|a|an|bipartisan)\\s+|[A-Z][\\w'’.-]*,?\\s+){0,8}?\\(?(${BILL_OBJ})`, 'g');
const ACTIVE_NAME = new RegExp(`\\b(${VERBS})\\s+(?:the\\s+|bipartisan\\s+)*((?:[A-Z][\\w'’-]*\\s+){1,7}Act)\\b`, 'g');
const PASSIVE_BILL = new RegExp(`(${BILL_OBJ})\\)?(?:,\\s+(?:the\\s+)?(?:[A-Z][\\w'’-]*\\s+){0,7}Act,)?\\s+(?:(?:was|were|has been|have been|had been|is|is being)\\s+(?:formally\\s+|officially\\s+|unanimously\\s+)?(${VERBS})|(passed|cleared)\\s+the\\b)`, 'g');
const FUTURE = /\b(?:will|would|to|plans? to|intends? to|expects? to)\s+(?:\w+\s+)?$/i;
export const eventDisagreements = (args) => eventClaims(args).map((c) => c.text);
// Each disagreement with whether it may be RECORD LAG (audit R13, 29 Oct 2026: a committee mark-up announced the day it happened is
// not yet in the record): the record has no event of that kind dated on or after the claimed date (less the agreement days), and for
// a kind that happens once to a bill (introduction, signing, veto) no such event at all. A record that already shows the event on
// another date contradicts the text (lag false: refused for good).
const ONCE = new Set(["Introduced / published", "Signed / enacted", "Vetoed / failed / rescinded"]);
export function eventClaims({ text, date, index = [], state = null }) {
  if (!index.length || !date) return [];
  const p = [], seen = new Set();
  // The state the whole text gives each bill number ("Nevada Assembly Bill 1405 (AB 1405)" keeps Nevada where a later sentence writes
  // "AB 1405" bare), so a sentence is never read against another state's entry; a number given two states is left unmatched.
  const stOf = new Map();
  for (const b of billMentions(text)) if (b.state) stOf.set(b.num, stOf.has(b.num) && stOf.get(b.num) !== b.state ? '?' : b.state);
  for (const s of sentences(String(text || '').replace(/\n+/g, ' '))) {
    const written = [...new Set(datesIn(s))], when = written.length ? written : /\b(?:today|this morning|tonight)\b/i.test(s) ? [date] : /\byesterday\b/i.test(s) ? [shiftDays(date, -1)] : [];
    if (!when.length) continue;
    const claims = [];
    const entriesOf = (tok) => { const want = [...tok.matchAll(BILL_TEXT)].map((b) => numOf(b[1] || b[2], b[3])); const ms = billMentions(s).filter((x) => want.includes(x.num)).map((x) => (x.state ? x : { ...x, state: stOf.get(x.num) || null })); return index.filter((x) => billHit(x, ms, state)); };
    for (const m of s.matchAll(ACTIVE_BILL)) if (!FUTURE.test(s.slice(0, m.index))) claims.push({ verb: m[1], label: m[2], entries: entriesOf(m[2]) });
    for (const m of s.matchAll(PASSIVE_BILL)) claims.push({ verb: m[2] || m[3], label: m[1], entries: entriesOf(m[1]) });
    for (const m of s.matchAll(ACTIVE_NAME)) if (!FUTURE.test(s.slice(0, m.index))) { const nm = norm(m[2].replace(/^(?:H\.?R|S)\.?\s+/, '')); claims.push({ verb: m[1], label: m[2].trim(), entries: index.filter((x) => (x.jur === 'US' || state === x.jur) && x.names.some((n) => nm.endsWith(norm(n)))) }); }
    for (const c of claims) {
      const kind = kindOfVerb(c.verb);
      if (!kind) continue;
      for (const x of c.entries) {
        const agree = when.some((d) => (x.events || []).some((v) => v.type === kind && dayGap(v.date, d) <= EVENT_AGREE_DAYS));
        const key = `${x.key}|${kind}|${when.join(',')}`;
        if (!agree && !seen.has(key)) {
          seen.add(key);
          const rec = (x.events || []).filter((v) => v.type === kind).map((v) => v.date);
          const first = [...when].sort()[0], lag = ONCE.has(kind) ? !rec.length : !rec.some((d) => d >= shiftDays(first, -EVENT_AGREE_DAYS));
          p.push({ entry: x.key, kind, when, lag, text: `the text says ${c.label} was ${c.verb.toLowerCase()} on ${when.join(' or ')}, but the tracked entry ${x.key} records no "${kind}" event within ${EVENT_AGREE_DAYS} days of that (its record: ${rec.length ? rec.join(', ') : 'none of that kind'}): refused` });
        }
      }
    }
  }
  return p;
}
