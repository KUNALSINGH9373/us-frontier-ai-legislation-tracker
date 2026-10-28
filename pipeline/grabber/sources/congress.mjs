// Congress.gov API v3 (https://api.congress.gov/v3). Free key, about 5,000 requests per hour.
// The key goes in the X-Api-Key header so it never appears in a URL or a log.
import { htmlToText } from '../lib/text.mjs';
export const BASE = 'https://api.congress.gov/v3';

// "119/hr/9925" <-> { congress, type, number }
export const parseBillId = (id) => { const m = /^(\d+)\/([a-z]+)\/(\d+)$/.exec(id); return m ? { congress: m[1], type: m[2], number: m[3] } : null; };
export const billId = (b) => `${b.congress}/${String(b.type).toLowerCase()}/${b.number}`;
export const billUrl = (b) => `https://www.congress.gov/bill/${b.congress}th-congress/${({ hr: 'house-bill', s: 'senate-bill', hjres: 'house-joint-resolution', sjres: 'senate-joint-resolution', hres: 'house-resolution', sres: 'senate-resolution', hconres: 'house-concurrent-resolution', sconres: 'senate-concurrent-resolution' })[String(b.type).toLowerCase()] || 'bill'}/${b.number}`;

// One Congress.gov related bill as the raw record stores it (agents/dedupe.mjs reads it; relationshipDetails is kept under its API name).
export const relatedBill = (r) => ({ congress: r.congress, type: String(r.type || '').toLowerCase(), number: r.number, title: r.title || null,
  relationshipDetails: (r.relationshipDetails || []).map((d) => ({ type: d.type || null, identifiedBy: d.identifiedBy || null })) });

export function createCongress(http) {
  const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2B/g, '+')}`).join('&');
  const get = (path, params = {}) => http.getJson(`${BASE}${path}?${q({ format: 'json', ...params })}`);

  return {
    // Bills updated in [from, to], oldest first, so a cut-off run can resume exactly where it stopped.
    // congress: keep only bills of that Congress (both paths), so the two paths give the same stream.
    // The date filter (fromDateTime) is sometimes down (HTTP 503 for days) while the plain list works. After the normal retries
    // a 5xx on the filtered list switches to the fallback: the plain list, newest first, paged until a bill is older than `from`,
    // then replayed oldest first. Bills the filtered list already gave are not given twice. onFallback is told once, with why.
    async *listUpdated({ from, to, pageSize = 250, congress = null, onFallback = () => {} }) {
      const keep = (b) => congress == null || String(b.congress) === String(congress);
      const given = new Set(), idOf = (b) => billId({ congress: b.congress, type: b.type, number: b.number });
      let failed = null;
      for (let offset = 0; ; offset += pageSize) {
        let r;
        try { r = await get('/bill', { fromDateTime: from, toDateTime: to, sort: 'updateDate+asc', limit: pageSize, offset }); }
        catch (e) { if (e && e.name === 'HttpError' && e.status >= 500) { failed = e; break; } throw e; }
        const bills = r.bills || [];
        for (const b of bills.filter(keep)) { given.add(idOf(b)); yield b; }
        const total = r.pagination && r.pagination.count;
        if (bills.length < pageSize || (total != null && offset + pageSize >= total)) return;
      }
      // ---- fallback: the plain list, sorted by update date, newest first ----
      const found = new Map(); // bill id -> list item; the first (newest) sighting wins when a bill moves up the list mid-paging
      let pages = 0;
      for (let offset = 0; ; offset += pageSize) {
        const r = await get('/bill', { sort: 'updateDate+desc', limit: pageSize, offset }); pages++;
        const bills = r.bills || [];
        let older = false;
        for (const b of bills) {
          if (!b.updateDate || b.updateDate < from) { older = true; continue; }
          if (b.updateDate > to || !keep(b) || found.has(idOf(b))) continue;
          found.set(idOf(b), b);
        }
        if (older || bills.length < pageSize) break;
      }
      onFallback({ reason: `the date-filtered list failed (${failed.message})`, pages, bills: found.size });
      // the same order as the filtered list: oldest first (a stable sort keeps the API's order within one timestamp)
      for (const b of [...found.values()].sort((x, y) => x.updateDate.localeCompare(y.updateDate))) if (!given.has(idOf(b))) yield b;
    },
    async getBill({ congress, type, number }) { return (await get(`/bill/${congress}/${type}/${number}`)).bill; },
    async getActions({ congress, type, number }) {
      const all = [];
      for (let offset = 0; ; offset += 250) {
        const r = await get(`/bill/${congress}/${type}/${number}/actions`, { limit: 250, offset });
        all.push(...(r.actions || []));
        if ((r.actions || []).length < 250) return all;
      }
    },
    // Congress.gov's related bills, reduced to what dedupe needs: [{ congress, type, number, title, relationships: [{ type, identifiedBy }] }]
    // (type: "Identical bill", "Related bill", "Procedurally-related", ...). Every page is read, so "count" and the list always agree.
    async getRelatedBills({ congress, type, number }) {
      const all = [];
      for (let offset = 0; ; offset += 250) {
        const r = await get(`/bill/${congress}/${type}/${number}/relatedbills`, { limit: 250, offset });
        all.push(...(r.relatedBills || []));
        if ((r.relatedBills || []).length < 250) break;
      }
      return all.map(relatedBill);
    },
    async getSummaries({ congress, type, number }) { return (await get(`/bill/${congress}/${type}/${number}/summaries`)).summaries || []; },
    // Whether any text version with a formatted text has been published yet (one cheap call; the text itself is not fetched).
    async hasText({ congress, type, number }) {
      const versions = (await get(`/bill/${congress}/${type}/${number}/text`)).textVersions || [];
      return versions.some((v) => (v.formats || []).some((x) => /Formatted Text/i.test(x.type)));
    },
    // The bill's own words: the newest text version, as plain text. Null when no text has been published yet.
    async getText({ congress, type, number }) {
      const versions = (await get(`/bill/${congress}/${type}/${number}/text`)).textVersions || [];
      const latest = versions.filter((v) => v.date).sort((x, y) => y.date.localeCompare(x.date))[0] || versions[0];
      const f = latest && (latest.formats || []).find((x) => /Formatted Text/i.test(x.type));
      // GPO's formatted text marks a superscript with backslashes ("10\26\" is 10 to the 26th): written as 10^26.
      // Some prints render it "10-26"; only before "integer / floating-point operations", where it cannot be a range.
      return f ? htmlToText(await http.getText(f.url)).replace(/(\d)\\(\d{1,3})\\/g, '$1^$2').replace(/\b10-(\d{2})(?=\s+(?:integer|or floating|floating))/g, '10^$1') : null;
    }
  };
}
