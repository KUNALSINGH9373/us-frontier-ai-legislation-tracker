// GovInfo (GPO) collections API. Key: GOVINFO_API_KEY, else DATA_GOV_API_KEY, else CONGRESS_API_KEY (all api.data.gov keys).
//   GET https://api.govinfo.gov/collections/PLAW/{since}  -> for each recent law, GET /related/{packageId}/BILLS: the bill versions
//       name the bill in code (BILLS-119hr4307enr). became-law (facts.role 'confirmation') when that bill is a tracked entry.
//   GET https://api.govinfo.gov/collections/BILLS/{since} -> new-text-version when the package is a version of a tracked bill.
// Bill numbers come from package ids only, never from titles.
import { collect, get, sourceConfig, safely, iso, addDays, noKey } from './common.mjs';
import { buildIndex, matchBill } from './match.mjs';

const API = 'https://api.govinfo.gov';
export const MAX_LAWS = 20, MAX_PAGES = 5;
export const keyOf = (env = {}) => env.GOVINFO_API_KEY || env.DATA_GOV_API_KEY || env.CONGRESS_API_KEY || null;
// "BILLS-119hr4307enr" -> { congress: 119, type: 'HR', number: '4307', version: 'enr' }
export function parseBillPackage(id) {
  const m = /^BILLS-(\d{2,3})(hr|s|hres|sres|hjres|sjres|hconres|sconres)(\d+)([a-z]+)$/.exec(String(id || ''));
  return m ? { congress: +m[1], type: m[2].toUpperCase(), number: m[3], version: m[4] } : null;
}
const label = (b) => `${b.type === 'HR' ? 'H.R.' : b.type === 'S' ? 'S.' : b.type} ${b.number}`;

export async function fetchItems({ http, env = {}, since, state = {}, entries = [], now } = {}) {
  const key = keyOf(env);
  if (!key) return noKey();
  return safely(async () => {
    const retrievedAt = iso(now || new Date());
    const today = retrievedAt.slice(0, 10);
    const from = String(since || state.since || addDays(today, -7)).slice(0, 10);
    const c = collect('govinfo', { retrievedAt, hosts: sourceConfig('govinfo').hosts });
    const index = buildIndex(entries);
    const keys = [key];
    const k = `api_key=${encodeURIComponent(key)}`;
    const pages = async (coll) => {
      const out = []; let url = `${API}/collections/${coll}/${from}T00:00:00Z?pageSize=100&offsetMark=*&${k}`;
      for (let p = 0; url && p < MAX_PAGES; p++) {
        const r = await get(http, url, { keys });
        if (!r.ok) { c.errors.push(r.error); break; }
        out.push(...(r.data.packages || []));
        url = r.data.nextPage ? `${r.data.nextPage}${r.data.nextPage.includes('api_key=') ? '' : `&${k}`}` : null;
      }
      return out;
    };

    // Public laws: only laws issued in the last 60 days (the collection also returns old laws whose record was touched).
    const laws = (await pages('PLAW')).filter((p) => p.dateIssued >= addDays(today, -60)).slice(0, MAX_LAWS);
    for (const law of laws) {
      const r = await get(http, `${API}/related/${encodeURIComponent(law.packageId)}/BILLS?${k}`, { keys });
      if (!r.ok) { c.errors.push(r.error); continue; }
      const bills = (r.data.results || []).map((x) => parseBillPackage(x.packageId)).filter(Boolean);
      const hits = [...new Set(bills.map((b) => matchBill(index, { jurisdiction: 'US', ...b })).filter(Boolean))];
      if (hits.length !== 1) continue;
      const b = bills.find((x) => matchBill(index, { jurisdiction: 'US', ...x }) === hits[0]);
      const m = /^PLAW-(\d+)publ(\d+)$/.exec(law.packageId);
      c.add({ source_id: law.packageId, entry_id: hits[0], class: 'became-law', date: law.dateIssued,
        facts: { role: 'confirmation', title: law.title, public_law: m ? `${m[1]}-${m[2]}` : null, number: label(b), congress: b.congress },
        url: `https://www.govinfo.gov/app/details/${law.packageId}`, title: law.title });
    }

    // Bill text versions.
    for (const p of await pages('BILLS')) {
      const b = parseBillPackage(p.packageId);
      if (!b) continue;
      const entry_id = matchBill(index, { jurisdiction: 'US', ...b });
      if (!entry_id) continue;
      // the introduced text (ih/is) is the first text, and a reprint (rds/rfs/pcs/rcs ...) repeats one: no class (review r13 #4)
      c.add({ source_id: p.packageId, entry_id, class: /^(i[hs]|r[df][hs]|pc[hs]|rc[hs]|rch|rcs)$/i.test(String(b.version || '')) ? null : 'new-text-version', date: p.dateIssued,
        facts: { title: p.title, number: label(b), congress: b.congress, version: b.version },
        url: `https://www.govinfo.gov/app/details/${p.packageId}`, title: p.title });
    }
    return c.result({ state: { since: addDays(today, -2) } });
  });
}
