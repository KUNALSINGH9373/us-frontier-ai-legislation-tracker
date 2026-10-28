// Federal Register API v1 (https://www.federalregister.gov/api/v1). No key needed.
// Covers executive orders, agency rules, proposed rules and notices (for example BIS export-control rules).
export const BASE = 'https://www.federalregister.gov/api/v1';
const FIELDS = ['document_number', 'title', 'type', 'publication_date', 'html_url', 'abstract', 'agency_names', 'executive_order_number', 'signing_date', 'effective_on', 'citation', 'raw_text_url'];

import fs from 'fs';
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

// The scope's own search terms (config/scope.draft.json Congress and Federal Register terms, config/legiscan.json precise phrases).
// A quoted phrase that is one of them, or part of one, matches every document the search finds, so it never identifies an entry.
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(new URL(`../../config/${f}`, import.meta.url), 'utf8')); } catch { return {}; } };
const plain = (s) => String(s).toLowerCase().replace(/\\b|\\./g, '').replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
export const SCOPE_TERMS = (() => {
  const s = readJson('scope.draft.json'), l = readJson('legiscan.json'), fr = s.federal_register || {};
  return [...new Set([...(s.precise_terms || []), ...(fr.terms || []), ...(fr.screen_terms || []), ...(l.precise_phrases || [])].map(plain).filter(Boolean))];
})();

// What identifies a tracked entry inside a Federal Register title or abstract, taken from the entry's title only (a short name is
// the tracker's own shorthand, e.g. "Super Intelligence" for EO 14434): its executive order numbers, and a full title written in
// quotation marks, unless that phrase equals or is contained in a scope search term. A match needs the order number or that full title.
export function watchPhrases(entry, scopeTerms = SCOPE_TERMS) {
  const text = String(entry.title || '');
  const eo = new Set([...text.matchAll(/\b(?:EO|E\.O\.|Executive Order)\s*(?:No\.\s*)?(1\d{4})\b/gi)].map((m) => m[1]));
  const phrases = [...eo].flatMap((n) => [`executive order ${n}`, `eo ${n}`, `e.o. ${n}`]);
  const terms = scopeTerms.map(plain);
  for (const m of text.matchAll(/[“"]([^”"]{8,120})[”"]/g)) {
    const p = m[1].toLowerCase().trim(), q = plain(p);
    if (!terms.some((t) => t === q || t.includes(q))) phrases.push(p);
  }
  return { eo, phrases };
}
