// The weekly completeness check (26 Nov 2026). Every other check measures whether what the site publishes is right; none asked whether
// something happened that the site does not have, so nine developments (a federal bill, a state AG lawsuit, a Commerce rule, a governor's
// recommendations ...) went missing for up to ten days, found only by a person searching by hand. This runs that search.
//
// A reader with Claude's server-side web search lists US frontier-AI policy developments of the last DAYS days, each with its official
// page. Code then keeps only items whose page came back from a search in this same call (an item with a link the searches never returned is
// dropped: no invented developments), dated inside the window, and not already on the site (a link an entry or news item has, a tracked
// bill number, or the same headline). What is left goes into the open-leads register (news/open-leads.mjs) marked from_audit: raised on the
// run report's Watch list at once, until the site covers it. Nothing is ever published from it. Never throws.
import { canonicalUrl } from '../news/attach.mjs';
import { buildIndex, matchText } from '../news/sources/match.mjs';

export const DAYS = 10, MAX_SEARCHES = 10;

export const AUDIT_SYSTEM = `You find developments for a tracker of US frontier-AI policy. In scope: bills, laws and resolutions on frontier or advanced AI (safety frameworks, incident reporting, evaluations, compute, chips and export controls, model weights, catastrophic risk, preemption of state AI laws), executive orders, agency rules and official actions on them, official proposals or drafts by legislators, governors or attorneys general, court cases about frontier AI developers or these laws, and government requests to AI developers. Out of scope: AI business news, product launches, research results, opinion, and AI used for unrelated purposes (policing, hiring, deepfakes, children's chatbots) unless the item is itself about frontier-AI rules.
Search the web well (official sites: congress.gov, federalregister.gov, state legislature and governor and attorney general sites, court dockets; and news reports). List only real developments you found in the search results, each dated inside the window, with the official page if there is one, else the news report you found.
End your answer with a JSON array, and nothing after it, of objects: {"title": short headline, "date": "YYYY-MM-DD", "kind": "federal bill" | "state bill" | "executive" | "rule" | "litigation" | "proposal" | "request", "jurisdiction": "US" or a two-letter state code, "bill_number": the bill number or null, "url": the page you found it on}.`;

const lastJsonArray = (text) => {
  const s = String(text || ''), i = s.lastIndexOf('[');
  for (let k = i; k >= 0; k = s.lastIndexOf('[', k - 1)) { try { const v = JSON.parse(s.slice(k, s.lastIndexOf(']') + 1)); if (Array.isArray(v)) return v; } catch { /* earlier bracket */ } }
  return null;
};
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const daysBefore = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);

// Whether the site already has the item: a link an entry or news item carries, a tracked bill named in it, or a news item's headline.
export function onSite(item, { entries, news, index = buildIndex(entries) }) {
  const urls = new Set([...(news.items || []).flatMap((n) => (n.links || []).map((l) => canonicalUrl(l.u))), ...entries.flatMap((e) => [...(e.sources || []).map((s) => s.url), ...(e.more_links || []).map((l) => l.u)].filter(Boolean).map(canonicalUrl))]);
  if (item.url && urls.has(canonicalUrl(item.url))) return 'its page is already linked';
  const jur = /^[A-Z]{2}$/.test(String(item.jurisdiction || '')) ? item.jurisdiction : 'US';
  if (item.bill_number) { const m = matchText(index, String(item.bill_number), jur); if (m.entry_id && m.by === 'number') return `the bill is tracked (${m.entry_id})`; }
  const t = norm(item.title);
  if (t.length >= 20 && (news.items || []).some((n) => norm(n.title) === t)) return 'a news item has the same headline';
  return null;
}

// client: a role client with search() (llm/anthropic.mjs). Returns { ran, searches, found, kept, missing: [leads], dropped: [{ item, why }], why }.
export async function completenessCheck({ client, entries, news, today, days = DAYS, maxSearches = MAX_SEARCHES, log = () => {} }) {
  const out = { ran: false, searches: 0, found: 0, missing: [], dropped: [], why: null };
  if (!client || typeof client.search !== 'function') { out.why = 'no AI reader with web search available'; return out; }
  const from = daysBefore(today, days);
  let r;
  try { r = await client.search({ system: AUDIT_SYSTEM, prompt: `Today is ${today}. Find every in-scope development from ${from} to ${today}.`, itemId: `completeness:${today}`, maxUses: maxSearches }); }
  catch (e) { out.why = String(e && e.message || e).slice(0, 200); log(`completeness check failed: ${out.why}`); return out; }
  out.ran = true; out.searches = r.searches || 0;
  const items = lastJsonArray(r.text);
  if (!items) { out.why = 'the reader gave no JSON list'; return out; }
  out.found = items.length;
  const searched = new Set((r.searchedUrls || []).map(canonicalUrl)), index = buildIndex(entries);
  for (const it of items) {
    const why = !it || !it.url || !it.title ? 'no title or link'
      : !searched.has(canonicalUrl(it.url)) ? 'its link was not among this call\'s search results'
      : !/^\d{4}-\d{2}-\d{2}$/.test(String(it.date || '')) || it.date < from || it.date > today ? `dated outside ${from} to ${today}`
      : onSite(it, { entries, news, index });
    if (why) { out.dropped.push({ title: it && it.title, url: it && it.url, why }); continue; }
    out.missing.push({ key: canonicalUrl(it.url), title: String(it.title).slice(0, 200), link: it.url, publisher: 'weekly completeness check', date: it.date, request_flag: false, from_audit: true, kind: it.kind || null, jurisdiction: it.jurisdiction || null });
  }
  return out;
}
