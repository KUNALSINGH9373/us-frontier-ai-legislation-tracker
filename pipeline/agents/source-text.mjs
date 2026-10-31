// Turns a saved raw source (a Congress.gov bill record or a Federal Register document) into the text a person would read,
// and checks quotes and numbers against it. This is the ground truth the Validator holds every claim to.

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

import { cleanText, readerText, printingNoise, detectNumbering, digitRuns, norm, looseForm, mappedLoose, LOST_EXPONENT, COMPUTE_UNIT } from './text-norm.mjs';
// The text cleanup and number reading live in agents/text-norm.mjs (one module for every check); re-exported for existing callers.
export { cleanText, digitRuns, norm, LOST_EXPONENT, COMPUTE_UNIT };
export const repairExponents = cleanText;

export function sourceText(raw, source) { return cleanText(rawSourceText(raw, source)); }
// The cleaner copy the new-bills writer and reviewer read (agents/text-norm.mjs readerText).
export function readerSourceText(raw, source) { return readerText(rawSourceText(raw, source)); }

function rawSourceText(raw, source) {
  if (source === 'congress_gov') {
    const b = raw.bill || {}, out = [];
    out.push(`Title: ${b.title || ''}`, `Introduced: ${b.introducedDate || ''}`, `Origin: ${b.originChamber || ''}`);
    (b.sponsors || []).forEach((s) => out.push(`Sponsor: ${s.fullName || ''}`));
    if (b.latestAction) out.push(`Latest action: ${b.latestAction.actionDate} ${b.latestAction.text}`);
    (raw.actions || []).forEach((a) => out.push(`${a.actionDate}: ${a.text}${a.committees && a.committees.length ? ' (' + a.committees.map((c) => c.name).join(', ') + ')' : ''}`));
    (raw.summaries || []).forEach((s) => out.push(stripTags(s.text)));
    if (raw.text) out.push(raw.text);
    return out.join('\n');
  }
  if (source === 'federal_register') {
    const d = raw.document || {};
    return [`Title: ${d.title || ''}`, `Type: ${d.type || ''}`, `Published: ${d.publication_date || ''}`, d.signing_date ? `Signed: ${d.signing_date}` : '', d.executive_order_number ? `Executive Order ${d.executive_order_number}` : '',
      `Agencies: ${(d.agency_names || []).join(', ')}`, d.effective_on ? `Effective: ${d.effective_on}` : '', stripTags(d.abstract), raw.text || ''].filter(Boolean).join('\n');
  }
  if (source === 'legiscan') {
    // A state bill as the grabber stores it: LegiScan's record (title, description, history) and the bill's own text.
    const b = raw.bill || {};
    return [`Title: ${b.title || ''}`, `Bill: ${b.state || ''} ${b.bill_number || ''}`, b.description && b.description !== b.title ? `Description: ${b.description}` : '',
      ...(b.sponsors || []).map((s) => `Sponsor: ${s.name || ''}`), ...(b.history || []).map((h) => `${h.date}: ${h.action}`), raw.text || ''].filter(Boolean).join('\n');
  }
  throw new Error('no source reader for ' + source);
}

// Line-numbered texts (NY and MA print a line number every line: "a frontier 1136 developer's"; MN prints "3.29" at the start of
// every line) and PDF hyphenation ("devel- oper", "floating - point") would make a faithful quote fail. As a second try both sides are
// compared without the printed line numbers (agents/text-norm.mjs detectNumbering: only numbers in a line-number run, so a real figure
// never disappears) and without hyphen spacing. Nothing else is loosened.
export const lineNumbers = detectNumbering;
const stripCache = new Map();
function strippedSource(original) {
  if (stripCache.has(original)) return stripCache.get(original);
  // read line breaks as readerText does (a form feed starts a line, a carriage return is space), keeping every offset unchanged
  const text = original.replace(/\r/g, ' ').replace(/\f/g, '\n');
  const { positions, values, pageLines } = detectNumbering(text);
  // printing noise (page headers and footers, converter markers) is dropped too, so a quote taken from readerText still matches; a
  // header line covers any line number inside it, so the header span wins
  const noise = printingNoise(text);
  const inNoise = (p) => noise.some((n) => p.i < n.i + n.len && n.i < p.i + p.len);
  const remove = [...positions.filter((p) => !inNoise(p)), ...noise].sort((a, b) => a.i - b.i);
  const r = { ...mappedLoose(text, remove), values, pageLines };
  r.loose = r.s;
  if (stripCache.size > 8) stripCache.clear(); stripCache.set(original, r);
  return r;
}
// Every place `q` occurs in the loose source, as the original printed span.
function spansOf(text, s, q) {
  const out = [];
  for (let k = s.loose.indexOf(q); k >= 0 && out.length < 20; k = s.loose.indexOf(q, k + 1)) out.push(text.slice(s.m[k], s.m[k + q.length - 1] + 1));
  return out;
}
export const containsQuote = (text, quote) => {
  if (!quote) return false;
  if (norm(text).includes(norm(quote))) return true;
  text = String(text || '');
  const s = strippedSource(text), q1 = looseForm(quote);
  if (q1.length < 8) return false;
  if (s.loose.includes(q1)) return true;
  // The quote copied the printed line numbers too: drop those numbers from it (only values that are line numbers in this text). A
  // number dropped this way may also be a misquoted figure that happens to equal a line number, so the match only counts when every
  // figure of the quote is in the printed span it matched.
  const q2 = looseForm(String(quote).replace(/(?<=^|\s)(\d{1,3}\.\d{1,2})(?=\s|$)/g, (m) => (s.pageLines.has(m) ? ' ' : m)).replace(/(?<=^|\s)(\d{1,4})(?=\s|$)/g, (m) => (s.values.has(+m) ? ' ' : m)));
  if (q2 === q1 || q2.length < 8) return false;
  const figures = [...digitRuns(quote)];
  return spansOf(text, s, q2).some((span) => { const have = digitRuns(span); return figures.every((f) => have.has(f)); });
};

// A model's quote as proof, tidied the ways models commonly copy (round 9 field eval: three new bills held because the referee's one
// quote missed): wrapping quotation marks or a closing full stop added. Returns the words that are in the source, else null. Passages
// joined by an ellipsis are refused (independent review, 30 Oct 2026: real parts can be joined into a meaning the bill does not have);
// the caller asks once more for an exact quote instead.
export function provedQuote(text, quote) {
  const q = String(quote || '').trim();
  if (q.length < 8) return null;
  if (containsQuote(text, q)) return q;
  const bare = q.replace(/^["“'‘]+|["”'’]+$/g, '').replace(/[.;,]+$/, '').trim();
  if (bare !== q && bare.length >= 8 && containsQuote(text, bare)) return bare;
  return null;
}
