// Congress.gov API v3 (https://api.congress.gov/v3). Free key, about 5,000 requests per hour.
// The key goes in the X-Api-Key header so it never appears in a URL or a log.
import { htmlToText } from '../lib/text.mjs';
export const BASE = 'https://api.congress.gov/v3';

// "119/hr/9925" <-> { congress, type, number }
export const parseBillId = (id) => { const m = /^(\d+)\/([a-z]+)\/(\d+)$/.exec(id); return m ? { congress: m[1], type: m[2], number: m[3] } : null; };
export const billId = (b) => `${b.congress}/${String(b.type).toLowerCase()}/${b.number}`;
export const billUrl = (b) => `https://www.congress.gov/bill/${b.congress}th-congress/${({ hr: 'house-bill', s: 'senate-bill', hjres: 'house-joint-resolution', sjres: 'senate-joint-resolution', hres: 'house-resolution', sres: 'senate-resolution', hconres: 'house-concurrent-resolution', sconres: 'senate-concurrent-resolution' })[String(b.type).toLowerCase()] || 'bill'}/${b.number}`;

export function createCongress(http) {
  const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2B/g, '+')}`).join('&');
  const get = (path, params = {}) => http.getJson(`${BASE}${path}?${q({ format: 'json', ...params })}`);

  return {
    // Bills updated in [from, to], oldest first, so a cut-off run can resume exactly where it stopped.
    async *listUpdated({ from, to, pageSize = 250 }) {
      for (let offset = 0; ; offset += pageSize) {
        const r = await get('/bill', { fromDateTime: from, toDateTime: to, sort: 'updateDate+asc', limit: pageSize, offset });
        const bills = r.bills || [];
        for (const b of bills) yield b;
        const total = r.pagination && r.pagination.count;
        if (bills.length < pageSize || (total != null && offset + pageSize >= total)) return;
      }
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
    async getSummaries({ congress, type, number }) { return (await get(`/bill/${congress}/${type}/${number}/summaries`)).summaries || []; },
    // The bill's own words: the newest text version, as plain text. Null when no text has been published yet.
    async getText({ congress, type, number }) {
      const versions = (await get(`/bill/${congress}/${type}/${number}/text`)).textVersions || [];
      const latest = versions.filter((v) => v.date).sort((x, y) => y.date.localeCompare(x.date))[0] || versions[0];
      const f = latest && (latest.formats || []).find((x) => /Formatted Text/i.test(x.type));
      return f ? htmlToText(await http.getText(f.url)) : null;
    }
  };
}
