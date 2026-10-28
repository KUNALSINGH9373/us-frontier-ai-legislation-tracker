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
import { releaseDate, pressRepost, linkKey } from './feeds.mjs';
import { releaseTracker } from './leads.mjs';
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
// Returns { outcome: 'drafted' | 'not_newsworthy' | 'rejected' | 'secondary' | 'error', item?, rounds, problems, reason }
// index: news/leads.mjs entryIndex of the tracked entries (the item's tracker comes only from the release itself, confirmed by the
// second reader). kindOf(key): the news kind for an entry. maxAgeDays: the feed window; a release dated before it is old news.
export async function draftNews({ lead, release, writer, checker, examples = [], today, runId, now = new Date(), maxRounds = 2, entryKind = null, index = [], kindOf = null, maxAgeDays = 14 }) {
  if (!lead.primary) return { outcome: 'secondary', rounds: 0, problems: [], reason: 'press report: published only after an official source confirms it' };
  if (!release || release.length < 200) return { outcome: 'error', retry: true, rounds: 0, problems: [], reason: 'the release page had no readable text' };
  if (pressRepost(release)) return { outcome: 'secondary', rounds: 0, problems: [], reason: 'a press story reposted on the official site (byline or "In The News"): a press lead, not the body\'s own release' };
  // Freshness from the release's own date, not only the feed's: a feed may re-list an old release.
  const own = releaseDate(release);
  if (!own) return { outcome: 'rejected', rounds: 0, problems: [], reason: 'the release states no date of its own, so its freshness cannot be checked' };
  if (own > today) return { outcome: 'rejected', rounds: 0, problems: [], reason: `the release is dated ${own}, after today` };
  if (own < shiftDays(today, -maxAgeDays)) return { outcome: 'rejected', rounds: 0, problems: [], reason: `the release is dated ${own}, older than the ${maxAgeDays}-day window: old news` };
  if (own < shiftDays(lead.date, -MAX_LISTING_LAG_DAYS)) return { outcome: 'rejected', rounds: 0, problems: [], reason: `the release is dated ${own}, more than ${MAX_LISTING_LAG_DAYS} days before its feed listed it (${lead.date}): old news re-listed` };
  // A release longer than the limit is checked against its opening only; a claim not found there is refused, never passed or guessed.
  const cut = release.length > MAX_RELEASE_CHARS;
  if (cut) release = release.slice(0, MAX_RELEASE_CHARS);
  const CUT_REASON = `the release is longer than ${MAX_RELEASE_CHARS} characters and a claim was not found in the part read: refused rather than checked against a cut text`;
  // The tracked entry the release itself names, in its jurisdiction; the second reader must confirm the release is about it.
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
export function duplicateOf(item, news) {
  const mine = new Set((item.links || []).map((l) => linkKey(l.u))), kind = eventKind(item), text = `${item.title} ${item.body}`;
  return news.find((n) => norm(n.title) === norm(item.title)
    || (n.links || []).some((l) => mine.has(linkKey(l.u)))
    || (item.tracker && n.tracker === item.tracker && dayGap(n.date, item.date) <= DUP.window_days && eventKind(n) === kind)
    || similarity(n.title, item.title) >= DUP.title || similarity(`${n.title} ${n.body || ''}`, text) >= DUP.text) || null;
}
