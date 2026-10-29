// Template text for a news event (pipeline/news/CONTRACT.md), the fallback when no phrase-bank card passes. No AI.
// Since review r5 (M5) the headline is a thin call into the phrase bank (news/phrasebank.mjs neutralCandidates): its most neutral variant,
// built from the same closed fact sheet (news/factsheet.mjs), so the same rules hold here as there: the Mayor in DC, no "both chambers" in
// Nebraska or DC, a resolution or constitutional amendment never "sent to the Governor" or "signed into law", no next step ever.
// The body quotes the official words verbatim. Returns null when no variant fits or a needed fact is missing (the event is then held,
// never guessed): e.g. a chamber passage whose record does not say which chamber.
import { longDate } from '../agents/derive.mjs';
import { buildFactSheet } from './factsheet.mjs';
import { neutralCandidates } from './phrasebank.mjs';
import { checkCard } from './writer.mjs';

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

// The phrase bank's most neutral headline for the event whose own check passes, or null.
export function neutralHeadline(event, entry) {
  let sheet;
  try { sheet = buildFactSheet(event, entry); } catch { return null; }
  for (const c of neutralCandidates(sheet)) if (!checkCard(c.check, sheet).length) return c.headline;
  return null;
}

// Non-bill classes (federal executive, agency and court records) keep their own fixed headlines, which name no chamber or governor; a
// bill class always goes through the phrase bank.
const NON_BILL = {
  'executive-order': (n, f) => (f.eo_number ? `President signs Executive Order ${f.eo_number}` : null),
  'presidential-memo': () => 'President issues a memorandum',
  'agency-rule-proposed': (n, f) => (f.agency ? `${f.agency} proposes a rule` : null),
  'agency-rule-final': (n, f) => (f.agency ? `${f.agency} issues a final rule` : null),
  'agency-guidance': (n, f) => (f.agency ? `${f.agency} issues guidance` : null),
  'comment-period-open': (n, f) => (f.agency && f.comments_close ? `Comments open until ${longDate(f.comments_close)} on a ${f.agency} proposal` : null),
  'court-filing': (n, f) => (f.label ? `${n}: ${f.label}` : null),
  'court-ruling': (n, f) => (f.label ? `${n}: ${f.label}` : null)
};

// event: an Event; entry: the tracked entry (short_name, title). -> { headline, body } or null
export function templateFor(event, entry) {
  if (!event || !event.class || !entry) return null;
  const f = event.facts || {};
  const own = NON_BILL[event.class];
  const headline = own ? own(entry.short_name || entry.title, f) : neutralHeadline(event, entry);
  const { quote, excerpt } = quoteOf(f);
  if (!headline || headline.length > LIMITS.headline || quote.length < 8) return null;
  const vote = f.vote && Number.isInteger(f.vote.yes) && Number.isInteger(f.vote.no) ? ` The recorded vote was ${f.vote.yes} to ${f.vote.no}.` : '';
  const body = `${recordName(event)} shows this action on ${entry.title}${f.number ? ` (${f.number})` : ''} on ${longDate(event.date)}: "${quote}"${excerpt ? ' (opening words of the entry)' : ''}.${vote}`;
  if (body.length > LIMITS.body) return null; // a quote is never cut mid-way: an entry that cannot be quoted whole enough is held
  return { headline, body };
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
