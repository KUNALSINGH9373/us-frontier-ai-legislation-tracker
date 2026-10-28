// Turns a saved raw source (a Congress.gov bill record or a Federal Register document) into the text a person would read,
// and checks quotes and numbers against it. This is the ground truth the Validator holds every claim to.

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

// Texts printed from PDFs lose superscripts: 10²⁶ arrives as "1026", "10�26" or "10ˆ26". Put the exponent back before anyone reads
// it, so the models, the reader and the quote checks all see "10^26". Only before a compute word, so a year or a count is never touched.
export const repairExponents = (s) => String(s || '').replace(/\b10(?:�|ˆ|\^)?(2[0-9])(?=\s+(?:integer|floating|operations|computational|FLOP))/g, '10^$1');

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
export const containsQuote = (text, quote) => !!quote && norm(text).includes(norm(quote));

// Every run of digits in a piece of text (commas removed, superscript digits read as digits), for the "numbers must come from the source" check.
const SUP = { '²': '2', '³': '3', '¹': '1', '⁰': '0', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
export function digitRuns(text) {
  // "10²⁶", "10^26" and GPO's "10\26\" all read as the runs 10 and 26, so an exponent matches however it is printed.
  const t = String(text || '').replace(/[²³¹⁰⁴-⁹]+/g, (m) => '^' + [...m].map((c) => SUP[c]).join('')).replace(/(\d)\\(\d{1,3})\\/g, '$1^$2').replace(/(\d),(?=\d{3}\b)/g, '$1');
  return new Set(t.match(/\d+(?:\.\d+)?/g) || []);
}
