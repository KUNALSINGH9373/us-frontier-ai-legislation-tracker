// Regulations.gov API v4. Key: REGULATIONS_GOV_API_KEY, else DATA_GOV_API_KEY, else CONGRESS_API_KEY (all api.data.gov keys).
//   GET https://api.regulations.gov/v4/documents?filter[searchTerm]=...&filter[commentEndDate][ge]=...
// Documents with a comment period whose own title is about AI:
//   comment-period-open     dated the comment start day (Washington time), facts.comments_close
//   comment-period-closing  dated the comment end day, only once that day has come (never a future date)
// commentEndDate is an instant ("2026-10-14T03:59:59Z" = 11:59 pm on Oct 13 in Washington); dates are taken in America/New_York.
import { collect, get, isAI, sourceConfig, safely, iso, addDays, etDate, noKey } from './common.mjs';
import { buildIndex, matchText } from './match.mjs';

const API = 'https://api.regulations.gov/v4/documents';
export const SEARCHES = ['artificial intelligence', 'super intelligence'];
export const keyOf = (env = {}) => env.REGULATIONS_GOV_API_KEY || env.DATA_GOV_API_KEY || env.CONGRESS_API_KEY || null;

export async function fetchItems({ http, env = {}, since, state = {}, entries = [], now } = {}) {
  const key = keyOf(env);
  if (!key) return noKey();
  return safely(async () => {
    const retrievedAt = iso(now || new Date());
    const today = retrievedAt.slice(0, 10);
    // Comment periods that end on or after this day (a closing is reported for up to 14 days after it closes).
    const from = String(since || state.since || addDays(today, -14)).slice(0, 10);
    const c = collect('regulations_gov', { retrievedAt, hosts: sourceConfig('regulations_gov').hosts });
    const index = buildIndex(entries);
    const docs = new Map();
    for (const term of SEARCHES) {
      const q = new URLSearchParams({ 'filter[searchTerm]': term, 'filter[commentEndDate][ge]': from, 'page[size]': '250', sort: '-postedDate', api_key: key });
      const r = await get(http, `${API}?${q}`, { keys: [key] });
      if (!r.ok) { c.errors.push(r.error); continue; }
      for (const d of r.data.data || []) if (d?.id && d.attributes) docs.set(d.id, d);
    }
    for (const { id, attributes: a } of docs.values()) {
      if (a.withdrawn || !isAI(a.title)) continue;
      const end = etDate(a.commentEndDate), start = etDate(a.commentStartDate || a.postedDate);
      if (!end) continue;
      const facts = { title: a.title, agency: a.agencyId, document_type: a.documentType, docket: a.docketId, document_number: a.frDocNum, comments_close: end, comments_open: start };
      const base = { source_id: id, entry_id: matchText(index, a.title, 'US').entry_id, facts, url: `https://www.regulations.gov/document/${encodeURIComponent(id)}`, title: a.title };
      if (start) c.add({ ...base, class: 'comment-period-open', date: start });
      if (end <= today) c.add({ ...base, class: 'comment-period-closing', date: end });
    }
    return c.result({ state: { since: addDays(today, -14) } });
  });
}
