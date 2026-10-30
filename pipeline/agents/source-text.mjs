// Turns a saved raw source (a Congress.gov bill record or a Federal Register document) into the text a person would read,
// and checks quotes and numbers against it. This is the ground truth the Validator holds every claim to.

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

// Texts printed from PDFs lose superscripts: 10²⁶ arrives as "1026", "10�26" or "10ˆ26". Put the exponent back before anyone reads
// it, so the models, the reader and the quote checks all see "10^26". Only before a compute word, so a year or a count is never touched.
// PA H.B. 2800 prints it "1,026 integer or floating-point operations" (superscript lost, then a thousands comma added).
// A line number glued onto an amount ("at least $500,000,000.8 "Minor" means", IL H.B. 4705): the amount and its line's text are
// split, so the stray digit is never read as cents (a real amount has two cent digits and no capital or quote right after).
// That comma form needs a compute word after it (not "operations" alone), so a count such as "1,025 operations" is never changed.
export const repairExponents = (s) => String(s || '').replace(/\b10(?:�|ˆ|\^)?(2[0-9])(?=\s+(?:integer|floating|operations|computational|FLOP))/g, '10^$1')
  .replace(/\b1,0(2[0-9])(?=\s+(?:integer|floating|computational|FLOP))/g, '10^$1')
  .replace(/(\$\d{1,3}(?:,\d{3})+)\.(\d)(?=\s+["“A-Z(])/g, '$1. ');

export function sourceText(raw, source) { return repairExponents(rawSourceText(raw, source)); }

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

// Quotes are compared after the same light normalisation on both sides: case, whitespace, curly quotes and dashes.
export const norm = (s) => String(s || '').toLowerCase().replace(/[‘’‛]/g, "'").replace(/[“”„]/g, '"').replace(/[‐-―−]/g, '-').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
// Line-numbered texts (NY and MA print a line number every line: "a frontier 1136 developer's") and PDF hyphenation ("devel- oper",
// "floating - point") would make a faithful quote fail. As a second try both sides are compared without the printed line numbers and
// without hyphen spacing. Only numbers that form the line-number run are removed (consecutive integers, each 15 to 400 characters after
// the one before, at least 3 in a row), so a real figure in the text never disappears, and nothing else is loosened.
export function lineNumbers(text) {
  const t = String(text || ''), toks = [...t.matchAll(/(?<=^|\s)(\d{1,4})(?=\s)/g)].map((m) => ({ v: +m[1], i: m.index, len: m[1].length }));
  const last = new Map(), chain = new Array(toks.length).fill(1), prevOf = new Array(toks.length).fill(-1), keep = new Set();
  toks.forEach((k, j) => {
    const p = last.get(k.v - 1);
    if (p != null && k.i - toks[p].i >= 15 && k.i - toks[p].i <= 400) { chain[j] = chain[p] + 1; prevOf[j] = p; }
    last.set(k.v, j);
    if (chain[j] >= 3) for (let x = j; x >= 0 && !keep.has(x); x = prevOf[x]) keep.add(x);
  });
  return { positions: [...keep].map((j) => toks[j]).sort((a, b) => a.i - b.i), values: new Set([...keep].map((j) => toks[j].v)) };
}
const looseForm = (s) => norm(s).replace(/\s*-\s*/g, '').replace(/\s+/g, ' ');
const stripCache = new Map();
function strippedSource(text) {
  if (stripCache.has(text)) return stripCache.get(text);
  const { positions, values } = lineNumbers(text);
  let out = '', at = 0; for (const p of positions) { out += text.slice(at, p.i) + ' '; at = p.i + p.len; } out += text.slice(at);
  const r = { loose: looseForm(out), values };
  if (stripCache.size > 8) stripCache.clear(); stripCache.set(text, r);
  return r;
}
export const containsQuote = (text, quote) => {
  if (!quote) return false;
  if (norm(text).includes(norm(quote))) return true;
  const s = strippedSource(String(text || '')), q1 = looseForm(quote);
  if (q1.length < 8) return false;
  if (s.loose.includes(q1)) return true;
  // The quote copied the printed line numbers too: drop those numbers from it (only values that are line numbers in this text).
  const q2 = looseForm(String(quote).replace(/(?<=^|\s)(\d{1,4})(?=\s|$)/g, (m) => (s.values.has(+m) ? ' ' : m)));
  return q2 !== q1 && q2.length >= 8 && s.loose.includes(q2);
};

// A model's quote as proof, tidied the ways models commonly copy (round 9 field eval: three new bills held because the referee's one
// quote missed): wrapping quotation marks or a closing full stop added, or two exact passages joined by an ellipsis. Returns the words
// that are in the source (for an ellipsis, every part must be, each at least 20 characters, and the longest part is kept), else null.
export function provedQuote(text, quote) {
  const q = String(quote || '').trim();
  if (q.length < 8) return null;
  if (containsQuote(text, q)) return q;
  const bare = q.replace(/^["“'‘]+|["”'’]+$/g, '').replace(/[.;,]+$/, '').trim();
  if (bare !== q && bare.length >= 8 && containsQuote(text, bare)) return bare;
  const parts = bare.split(/\s*(?:\.\.\.|…|\[\.\.\.\])\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => p.length >= 20 && containsQuote(text, p))) return parts.reduce((a, b) => (b.length > a.length ? b : a));
  return null;
}

// Every run of digits in a piece of text (commas removed, superscript digits read as digits), for the "numbers must come from the source" check.
const SUP = { '²': '2', '³': '3', '¹': '1', '⁰': '0', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
// "10" then a lost exponent 20-29 right before a compute unit: only this form is unambiguous (no compute threshold is 10.26, 1026 or 1,026 ops).
export const COMPUTE_UNIT = String.raw`(?:integer|floating|computational|operations|FLOPs?\b)`;
export const LOST_EXPONENT = new RegExp(String.raw`\b(?:10[.,]?|1,0)(2\d)(?=\s+${COMPUTE_UNIT})`, 'gi');
export function digitRuns(text) {
  // "10²⁶", "10^26" and GPO's "10\26\" all read as the runs 10 and 26, so an exponent matches however it is printed.
  const t = String(text || '').replace(/[²³¹⁰⁴-⁹]+/g, (m) => '^' + [...m].map((c) => SUP[c]).join('')).replace(/(\d)\\(\d{1,3})\\/g, '$1^$2').replace(/(\d),(?=\d{3}\b)/g, '$1')
    // A superscript lost in the state's text ("10.26 computational operations", "1026 operations"): the bill's 10^26 (agents/checks.mjs).
    .replace(LOST_EXPONENT, '10^$1');
  return new Set(t.match(/\d+(?:\.\d+)?/g) || []);
}
