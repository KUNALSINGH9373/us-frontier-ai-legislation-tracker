// Template text for a news event, per class (pipeline/news/CONTRACT.md). Plain and factual, built from the event's official facts and the
// tracked entry's own names only; the official words are quoted verbatim. No AI. Returns null when a fact the wording needs is missing
// (the event is then held, never guessed): e.g. a chamber passage whose record does not say which chamber.
import { longDate } from '../agents/derive.mjs';

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().replace(/(?<!\b[a-z]\.[a-z])\.$/i, '');
export const LIMITS = { headline: 140, body: 700 };

// Who keeps the record, in the body's opening words.
export function recordName(event) {
  const s = event.sources && event.sources.find((x) => x.role === 'official');
  const src = s ? s.source : null;
  if (src === 'congress_gov') return 'Congress.gov';
  if (src === 'legiscan') return `The ${event.jurisdiction} Legislature's record`; // "... shows this action"
  if (src === 'federal_register') return 'The Federal Register';
  if (src === 'whitehouse') return 'The White House';
  if (src === 'openstates' || src === 'nysenate') return `The ${event.jurisdiction} Legislature's record`;
  if (src === 'cbo') return 'The Congressional Budget Office';
  if (src === 'courtlistener') return `The court docket${event.facts.court ? ` (${event.facts.court})` : ''}`;
  return 'The official record';
}
const exec = (event) => (event.jurisdiction === 'US' ? 'President' : 'Governor');

// class -> (short name, facts, event) -> headline, or null when a needed fact is missing
const HEADLINE = {
  'introduction': (n, f) => `${n} introduced${f.chamber ? ` in the ${f.chamber}` : ''}`,
  'referral-committee': (n) => `${n} referred to committee`,
  'hearing-scheduled': (n) => `Hearing scheduled on ${n}`,
  'hearing-held': (n) => `Hearing held on ${n}`,
  'committee-passage': (n) => `${n} advances from committee`,
  'committee-failure': (n) => `${n} fails in committee`,
  'passage': (n, f) => (f.chamber ? `${n} passes the ${f.chamber}` : null),
  'failure': (n, f) => `${n} fails${f.chamber ? ` in the ${f.chamber}` : ''}`,
  'amendment-passage': (n, f) => (f.chamber ? `${f.chamber} adopts an amendment to ${n}` : null),
  'concurrence': (n) => `${n}: both chambers agree on the text`,
  'enrolled': (n) => `${n} enrolled`,
  'executive-receipt': (n, f, e) => `${n} sent to the ${exec(e)}`,
  'executive-signature': (n, f, e) => `${exec(e)} signs ${n}`,
  'executive-veto': (n, f, e) => `${exec(e)} vetoes ${n}`,
  'became-law': (n) => `${n} becomes law`,
  'veto-override-passage': (n, f) => (f.chamber ? `${f.chamber} votes to override the veto of ${n}` : `Vote to override the veto of ${n}`),
  'withdrawal': (n) => `${n} withdrawn`,
  'carried-over': (n) => `${n} carried over to the next session`,
  'new-text-version': (n) => `New text of ${n} published`,
  'crs-report': (n) => `Congressional Research Service report on ${n}`,
  'cbo-estimate': (n) => `CBO cost estimate for ${n}`,
  'executive-order': (n, f) => (f.eo_number ? `President signs Executive Order ${f.eo_number}` : null),
  'presidential-memo': () => 'President issues a memorandum',
  'agency-rule-proposed': (n, f) => (f.agency ? `${f.agency} proposes a rule` : null),
  'agency-rule-final': (n, f) => (f.agency ? `${f.agency} issues a final rule` : null),
  'agency-guidance': (n, f) => (f.agency ? `${f.agency} issues guidance` : null),
  'comment-period-open': (n, f) => (f.agency && f.comments_close ? `Comments open until ${longDate(f.comments_close)} on a ${f.agency} proposal` : null),
  'comment-period-closing': (n, f) => (f.agency ? `Comment period closes on a ${f.agency} proposal` : null),
  'court-filing': (n, f) => (f.label ? `${n}: ${f.label}` : null),
  'court-ruling': (n, f) => (f.label ? `${n}: ${f.label}` : null)
};

// event: an Event; entry: the tracked entry (short_name, title). -> { headline, body } or null
export function templateFor(event, entry) {
  if (!event || !event.class || !entry) return null;
  const f = event.facts || {}, h = HEADLINE[event.class];
  if (!h) return null;
  const headline = h(entry.short_name || entry.title, f, event);
  const { quote, excerpt } = quoteOf(f);
  if (!headline || quote.length < 8) return null;
  const vote = f.vote && Number.isInteger(f.vote.yes) && Number.isInteger(f.vote.no) ? ` The recorded vote was ${f.vote.yes} to ${f.vote.no}.` : '';
  const body = `${recordName(event)} shows this action on ${entry.title}${f.number ? ` (${f.number})` : ''} on ${longDate(event.date)}: "${quote}"${excerpt ? ' (opening words of the entry)' : ''}.${vote}`;
  if (body.length > LIMITS.body) return null; // a quote is never cut mid-way: an entry that cannot be quoted whole enough is held
  return { headline: cut(headline, LIMITS.headline), body };
}

// The official words to quote: the whole action, or, when it is long (a court order), its opening sentences up to QUOTE_MAX characters,
// ended at a sentence boundary and marked as an excerpt. Always a verbatim span of the record (the evidence quote).
export const QUOTE_MAX = 320;
export function quoteOf(f) {
  const all = clean(f.action || f.text || f.title || '');
  if (all.length <= QUOTE_MAX) return { quote: all, excerpt: false };
  const raw = String(f.action || f.text || f.title || '').replace(/\s+/g, ' ').trim();
  let end = -1;
  for (const m of raw.matchAll(/[.;](?=\s)/g)) { if (m.index + 1 > QUOTE_MAX) break; end = m.index; }
  if (end < 20) return { quote: all, excerpt: false }; // no sentence boundary early enough: the body check above holds it
  return { quote: raw.slice(0, end), excerpt: true };
}

// The site's stage badge (contract addition): introduced | committee | passed-chamber | passed-both | law, or null (omitted).
const STAGE = {
  'introduction': 'introduced', 'referral-committee': 'committee', 'hearing-scheduled': 'committee', 'hearing-held': 'committee', 'committee-passage': 'committee',
  'passage': 'passed-chamber', 'concurrence': 'passed-both', 'enrolled': 'passed-both', 'executive-receipt': 'passed-both', 'became-law': 'law'
};
export const stageOf = (event) => STAGE[event.class] || null;
// What comes next, only where it follows from the class alone.
export function nextOf(event) {
  if (event.class === 'executive-receipt') return `The ${exec(event)} signs or vetoes it`;
  if (event.class === 'enrolled') return `Sent to the ${exec(event)}`;
  return null;
}
