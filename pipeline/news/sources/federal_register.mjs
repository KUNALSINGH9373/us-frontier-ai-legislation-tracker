// Federal Register (keyless). Official records of presidential documents, agency rules, guidance and comment periods about AI.
//   GET https://www.federalregister.gov/api/v1/documents.json   AI terms x AI-relevant agencies (rules, proposed rules, notices)
//   GET ...documents.json  type PRESDOCU x AI terms              executive orders and presidential memoranda
//   GET https://www.federalregister.gov/api/v1/public-inspection-documents/current.json   filed today, published later
// Only documents whose own title or abstract is about AI are kept (full-text hits on a passing mention are dropped).
// Classes: executive-order, presidential-memo, agency-rule-proposed, agency-rule-final, agency-guidance (guidance-like notices),
// comment-period-open (dated the publication day; facts.comments_close), comment-period-closing (dated comments_close_on, only once
// that day has come). Other AI notices are recorded with class null.
import { collect, get, isAI, plain, sourceConfig, safely, iso, addDays, etDate } from './common.mjs';
import { buildIndex, matchText, matchNumbers } from './match.mjs';

const BASE = 'https://www.federalregister.gov/api/v1';
export const TERMS = '"artificial intelligence" | "super intelligence" | "superintelligence" | "frontier model" | "frontier AI"';
export const AGENCIES = ['national-institute-of-standards-and-technology', 'commerce-department', 'science-and-technology-policy-office', 'federal-trade-commission',
  'management-and-budget-office', 'industry-and-security-bureau', 'national-telecommunications-and-information-administration', 'homeland-security-department',
  'defense-department', 'energy-department', 'justice-department', 'executive-office-of-the-president', 'federal-communications-commission',
  'national-science-foundation', 'general-services-administration', 'investment-security-office', 'copyright-office-library-of-congress'];
const FIELDS = ['title', 'type', 'subtype', 'abstract', 'document_number', 'html_url', 'publication_date', 'agencies', 'comments_close_on', 'docket_ids',
  'executive_order_number', 'signing_date', 'effective_on', 'action'];
const GUIDANCE = /\b(guidance|guidelines?|framework|best practices|key practices|profile|playbook|policy statement)\b/i;
const MAX_PAGES = 3;

export function docUrl(params) {
  const q = new URLSearchParams();
  q.set('per_page', '100'); q.set('order', 'newest');
  for (const [k, v] of params) q.append(k, v);
  for (const f of FIELDS) q.append('fields[]', f);
  return `${BASE}/documents.json?${q}`;
}

export function classify(doc) {
  const t = String(doc.type || '');
  if (t === 'Presidential Document') {
    const s = String(doc.subtype || '');
    if (/^Executive Order$/i.test(s)) return 'executive-order';
    if (/Memorand/i.test(s)) return 'presidential-memo';
    return null;
  }
  // a withdrawal, an extension or a reopening of a proposal is not a new proposal (review r10 #4)
  // nor is an advance notice, an inquiry or a request for comment (review r11 #2)
  if (t === 'Proposed Rule') return /\b(advance notice|ANPRM|notice of inquiry|request for (comments?|information)|considering|commence a rulemaking|withdraw\w*|extension|extend\w*|reopen\w*|correct\w*|delay\w*|termination|terminat\w*)\b/i.test(`${doc.action || ''} ${doc.title || ''} ${doc.abstract || ''}`) ? null : 'agency-rule-proposed';
  // a Rule that only corrects, delays, withdraws, stays or rescinds is not a new final rule (review r9 #1): no class, no card
  if (t === 'Rule') return /\b(interpretive|policy statement|enforcement discretion|guidance|correct\w*|technical amendment|delay\w*|withdraw\w*|stay\w*|rescind\w*|rescission|remov\w*|repeal\w*|extension|interim final|direct final)\b/i.test(`${doc.action || ''} ${doc.title || ''}`) ? null : 'agency-rule-final';
  // a request for information or a meeting asks or meets; it is not guidance (review r10 #5)
  if (t === 'Notice' && GUIDANCE.test(doc.title || '') && !/\b(request for information|RFI|request for comments?|meeting|workshop|listening session|webinar)\b/i.test(doc.title || '')) return 'agency-guidance';
  return null;
}

export async function fetchItems({ http, env = {}, since, state = {}, entries = [], now } = {}) {
  return safely(async () => {
    const retrievedAt = iso(now || new Date());
    const today = retrievedAt.slice(0, 10);
    const from = String(since || state.since || addDays(today, -14)).slice(0, 10);
    const cfg = sourceConfig('federal_register');
    const c = collect('federal_register', { retrievedAt, hosts: cfg.hosts });
    const index = buildIndex(entries);
    const docs = new Map();
    const queries = [
      [['conditions[publication_date][gte]', from], ['conditions[term]', TERMS], ...AGENCIES.map((a) => ['conditions[agencies][]', a]), ...['RULE', 'PRORULE', 'NOTICE'].map((t) => ['conditions[type][]', t])],
      [['conditions[publication_date][gte]', from], ['conditions[term]', TERMS], ['conditions[type][]', 'PRESDOCU']],
    ];
    for (const qp of queries) {
      let url = docUrl(qp);
      for (let page = 0; url && page < MAX_PAGES; page++) {
        const r = await get(http, url);
        if (!r.ok) { c.errors.push(r.error); break; }
        for (const d of r.data.results || []) if (d && d.document_number) docs.set(d.document_number, d);
        url = r.data.next_page_url || null;
      }
    }
    // A Federal Register correction (document number "C1-2026-12345") reprints a document with a printing fix: not a new action, and it
    // must not turn the original's card into a "corrected" one (review r9 B2).
    const isCorrection = (n) => /^[CR]\d-/i.test(String(n || '')); // a correction (C1-) or a republication (R1-) (review r8 #7)
    // A presidential document that revokes, amends or supersedes an order: matched by its words, it lands on the order it changes.
    // Public inspection filings may not carry the "Presidential Document" type, so the title's own words count too (review r6).
    const changesAnOrder = (d) => {
      const words = `${d.title} ${d.abstract || ''}`;
      const presidential = /presidential/i.test(String(d.type || '')) || /\b(executive order|proclamation|memorandum)\b/i.test(String(d.title || ''));
      return presidential && /\b(revok|amend|supersed|rescind|modif|terminat|replac|withdraw|suspend|revis|repeal|restor|reinstat|extend|continu)\w*/i.test(words);
    };
    for (const d of docs.values()) {
      if (!isAI(`${d.title} ${d.abstract || ''}`) || isCorrection(d.document_number)) continue;
      const agency = (d.agencies || []).map((a) => a.name || a.raw_name).filter(Boolean).join('; ');
      const eo = d.executive_order_number ? `Executive Order ${d.executive_order_number}` : '';
      // An order with its own number belongs only to the entry tracking that number. Matched by its words instead, an untracked order
      // that revokes or amends a tracked one ("Revoking Executive Order 14365") would show as "President signs" on that order's page
      // (review r9 B1): no entry, so no card (a lead at most).
      // The same for a presidential document without a number (memorandum, proclamation) that changes an order: on no entry (r9 C2).
      const entry_id = eo ? matchNumbers(index, eo, 'US') || null : changesAnOrder(d) ? null : matchText(index, `${d.title}. ${plain(d.abstract)}`, 'US').entry_id;
      const cls = classify(d);
      const facts = { title: d.title, document_number: d.document_number, agency, type: d.type, subtype: d.subtype, eo_number: d.executive_order_number,
        publication_date: d.publication_date, signing_date: d.signing_date, effective_on: d.effective_on, comments_close: d.comments_close_on,
        docket: (d.docket_ids || []).join('; ') };
      const date = (cls === 'executive-order' || cls === 'presidential-memo') && d.signing_date ? d.signing_date : d.publication_date;
      c.add({ source_id: d.document_number, entry_id, class: cls, date, facts, url: d.html_url, title: d.title });
      if (d.comments_close_on) {
        c.add({ source_id: d.document_number, entry_id, class: 'comment-period-open', date: d.publication_date, facts, url: d.html_url, title: d.title });
        if (d.comments_close_on <= today) c.add({ source_id: d.document_number, entry_id, class: 'comment-period-closing', date: d.comments_close_on, facts, url: d.html_url, title: d.title });
      }
    }
    // Public inspection: documents filed for publication on a later day. The filing day is the official date.
    const pi = await get(http, `${BASE}/public-inspection-documents/current.json`);
    if (!pi.ok) c.errors.push(pi.error);
    else for (const d of pi.data.results || []) {
      if (!d?.document_number || !isAI(d.title) || isCorrection(d.document_number)) continue;
      const cls = classify(d);
      // a filed order or memo that changes another order is on no entry, as above (public inspection has no order number) (r9 C2)
      c.add({ source_id: `pi:${d.document_number}`, entry_id: changesAnOrder(d) ? null : matchText(index, d.title, 'US').entry_id, class: cls, date: etDate(d.filed_at),
        facts: { title: d.title, document_number: d.document_number, agency: (d.agency_names || []).join('; '), type: d.type, public_inspection: true,
          publication_date: d.publication_date, docket: (d.docket_numbers || []).join('; ') },
        url: d.html_url, title: d.title });
    }
    return c.result({ state: { since: today } });
  });
}
