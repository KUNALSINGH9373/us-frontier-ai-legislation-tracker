// Federal Register API v1 (https://www.federalregister.gov/api/v1). No key needed.
// Covers executive orders, agency rules, proposed rules and notices (for example BIS export-control rules).
export const BASE = 'https://www.federalregister.gov/api/v1';
const FIELDS = ['document_number', 'title', 'type', 'publication_date', 'html_url', 'abstract', 'agency_names', 'executive_order_number', 'signing_date', 'effective_on', 'citation', 'raw_text_url'];

import { htmlToText } from '../lib/text.mjs';
export { htmlToText };

export function createFederalRegister(http) {
  const qs = (pairs) => pairs.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%5B/g, '[').replace(/%5D/g, ']')}`).join('&');
  return {
    // All documents in [from, to] (dates, YYYY-MM-DD) whose text matches one search term. Oldest first.
    async *searchDocuments({ from, to, term, perPage = 100 }) {
      for (let page = 1; ; page++) {
        const url = `${BASE}/documents.json?` + qs([
          ['conditions[publication_date][gte]', from], ['conditions[publication_date][lte]', to], ['conditions[term]', `"${term}"`], // quoted: an exact phrase, not any of its words
          ['order', 'oldest'], ['per_page', perPage], ['page', page], ...FIELDS.map((f) => ['fields[]', f])
        ]);
        const r = await http.getJson(url);
        for (const d of r.results || []) yield d;
        if (page >= (r.total_pages || 1) || !(r.results || []).length) return;
      }
    },
    // The document's plain text, so the Validator can check quotes against exactly what was published.
    async getText(doc) { return doc.raw_text_url ? htmlToText(await http.getText(doc.raw_text_url)) : null; }
  };
}

// Phrases that identify a tracked entry inside a Federal Register title or abstract: executive order numbers
// and any name in quotation marks in the entry's title.
export function watchPhrases(entry) {
  const text = `${entry.title} ${entry.short_name}`;
  const eo = new Set([...text.matchAll(/\b(?:EO|E\.O\.|Executive Order)\s*(?:No\.\s*)?(1\d{4})\b/gi)].map((m) => m[1]));
  const phrases = [...eo].flatMap((n) => [`executive order ${n}`, `eo ${n}`, `e.o. ${n}`]);
  for (const m of text.matchAll(/[“"]([^”"]{8,80})[”"]/g)) phrases.push(m[1].toLowerCase());
  return { eo, phrases };
}
