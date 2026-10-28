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
import { HttpError, NetworkError } from '../grabber/lib/http.mjs';

export const LIMITS = { title: 140, body: 700 };
export const MAX_RELEASE_CHARS = 40000;
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
  const ev = (d.evidence || []).filter((x) => x && x.quote);
  if (!ev.length) p.push('no evidence quote');
  ev.filter((x) => !containsQuote(release, x.quote)).forEach((x) => p.push(`evidence quote not in RELEASE: "${String(x.quote).slice(0, 60)}"`));
  ev.filter((x) => String(x.quote).trim().length < 8).forEach((x) => p.push(`evidence quote too short: "${x.quote}"`));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) p.push('no date (YYYY-MM-DD)');
  else {
    if (d.date > today) p.push(`date ${d.date} is in the future`);
    if (d.date !== lead.date && !dateSupported(d.date, release)) p.push(`date ${d.date} is neither in RELEASE nor the date the feed lists it under (${lead.date})`);
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
export async function draftNews({ lead, release, writer, checker, examples = [], today, runId, now = new Date(), maxRounds = 2, entryKind = null }) {
  if (!lead.primary) return { outcome: 'secondary', rounds: 0, problems: [], reason: 'press report: published only after an official source confirms it' };
  if (!release || release.length < 200) return { outcome: 'error', retry: true, rounds: 0, problems: [], reason: 'the release page had no readable text' };
  if (release.length > MAX_RELEASE_CHARS) release = release.slice(0, MAX_RELEASE_CHARS); // quotes and numbers are then checked against this opening only
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
      let res;
      try { res = await checker.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: release, claims }), itemId: `${itemId}:c${round}` }); }
      catch (e) { if (!(e instanceof LlmOutputError)) throw e; res = { data: { results: [] } }; problems.push(`the second reader gave an unusable answer (${e.message})`); }
      const byN = new Map(((res.data && res.data.results) || []).map((x) => [x.n, x]));
      claims.forEach((c, i) => {
        const x = byN.get(i + 1);
        if (!x) problems.push(`the second reader did not answer for the ${c.field}`);
        else if (x.supported !== true) problems.push(`the ${c.field} ("${c.claim.slice(0, 100)}") is not supported: ${String(x.reason || 'not in RELEASE').slice(0, 200)}`);
        else if (!containsQuote(release, x.quote)) problems.push(`the second reader's quote for the ${c.field} is not in RELEASE`);
      });
      if (!problems.length) return { outcome: 'drafted', rounds: round, problems: [], item: itemOf({ d, lead, runId, now, round, entryKind }) };
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
function itemOf({ d, lead, runId, now, round, entryKind }) {
  const [, m, day] = d.date.split('-').map(Number);
  return {
    date: d.date, kind: entryKind || lead.kind, title: String(d.title).trim(), body: String(d.body).trim(),
    links: [{ t: `${lead.publisher} release, ${SHORT[m - 1]} ${day}`, u: lead.release_url }],
    check: checkLine(lead.publisher),
    tracker: lead.tracker || null, origin: 'automated',
    verification: { method: 'agent', checked_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), run_id: runId, rounds: round },
    evidence: d.evidence.filter((x) => x && x.quote).map((x) => ({ field: 'body', quote: String(x.quote).trim(), source_url: lead.release_url }))
  };
}

// A drafted item that repeats one already on the page (same entry and date, or the same title) is not added.
export function duplicateOf(item, news) {
  return news.find((n) => (item.tracker && n.tracker === item.tracker && n.date === item.date) || norm(n.title) === norm(item.title) || (n.links || []).some((l) => l.u === item.links[0].u)) || null;
}
