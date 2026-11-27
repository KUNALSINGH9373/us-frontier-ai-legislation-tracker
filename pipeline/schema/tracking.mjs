// Every live bill on the site is followed by a grabber (26 Nov 2026: six bills added by hand were not, so their official updates were
// missed). A federal bill is followed through its entry's identifiers.external.congress_gov (grabber/run.mjs); a state bill through
// config/identifiers-legiscan.json (grabber/run-legiscan.mjs), and its entry carries the same ids.
//   checkTracking({ entries, legiscan })   -> problems (legiscan: the "legiscan" block of config/identifiers-legiscan.json)
//   node schema/tracking.mjs [dataDir]     exits 1 on a problem (PR check, .github/workflows/check.yml)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// A federal entry whose title names a bill ("H.R. 10981 — ...") must carry that bill's Congress.gov id: the grabber follows a bill, and
// the end-of-Congress step checks it, only through identifiers.external.congress_gov (26 Nov 2026: two bills added by hand without
// ids were not being followed). Only the title's head, before the dash, names the entry's own bills.
const BILL_TYPE = { 'H.R.': 'hr', 'S.': 's', 'H.J.Res.': 'hjres', 'S.J.Res.': 'sjres', 'H.Res.': 'hres', 'S.Res.': 'sres', 'H.Con.Res.': 'hconres', 'S.Con.Res.': 'sconres' };
const BILL_IN_TITLE = /(?<![A-Za-z.])(H\.R\.|S\.J\.Res\.|H\.J\.Res\.|S\.Con\.Res\.|H\.Con\.Res\.|S\.Res\.|H\.Res\.|S\.)\s?(\d+)(?!\d)/g;
export function billIdProblems(e) {
  if (e.level !== 'federal') return [];
  const head = String(e.title || '').split(/\s+—\s+/)[0];
  const ids = ((e.identifiers && e.identifiers.external && e.identifiers.external.congress_gov) || []).map((x) => String(x).split('/').slice(1).join('/'));
  return [...head.matchAll(BILL_IN_TITLE)].map((m) => `${BILL_TYPE[m[1]]}/${m[2]}`).filter((b) => !ids.includes(b)).map((b) => `${e.key}: its title names ${b.replace('/', ' ')} but identifiers.external.congress_gov does not list it (the bill is not followed)`);
}

const LIVE = ['pending', 'stalled'];
const lsIdsOf = (e) => ((e.identifiers && e.identifiers.external && e.identifiers.external.legiscan) || []).map(String).sort();

// A court case on the site whose CourtListener docket it cites must be read by the court-docket step (config/courts.json), or be listed
// in its _not_followed block with the reason (27 Nov 2026: the D.C. Circuit docket in Anthropic v. Department of War was cited but not
// followed, so its rulings were added by hand). courts: the parsed config/courts.json.
const CL_DOCKET = /courtlistener\.com\/docket\/(\d+)/g;
export function courtProblems(e, courts = {}) {
  if (e.type !== 'litigation') return [];
  const followed = new Set(Object.entries(courts).filter(([k]) => !k.startsWith('_')).map(([, c]) => String(c.docket_id)));
  const skipped = (courts._not_followed || {})[e.key];
  const cited = [...new Set([...JSON.stringify([e.sources, e.more_links, e.events, e.evidence]).matchAll(CL_DOCKET)].map((m) => m[1]))];
  return skipped ? [] : cited.filter((id) => !followed.has(id)).map((id) => `${e.key}: cites CourtListener docket ${id}, which config/courts.json does not follow (add it, or list the entry in _not_followed with the reason)`);
}

// announced: config/announced-bills.json "bills" (federal bills announced without a number: the end-of-Congress step checks them there).
export function checkTracking({ entries, legiscan = {}, announced = {}, courts = {} }) {
  const problems = [];
  for (const e of entries) {
    problems.push(...courtProblems(e, courts));
    if (e.level === 'federal') problems.push(...billIdProblems(e)); // a federal title that names a bill must carry its Congress.gov id
    if (e.level === 'federal' && e.type === 'bill' && LIVE.includes(e.status) && !((e.identifiers && e.identifiers.external && e.identifiers.external.congress_gov) || []).length && !announced[e.key]) problems.push(`${e.key}: a pending federal bill with no Congress.gov id and not in config/announced-bills.json (nothing follows it)`);
    if (e.level === 'state' && ['bill', 'auditor'].includes(e.type) && LIVE.includes(e.status)) {
      const c = legiscan[e.key], cfg = c && c.status !== 'rejected' ? (c.bills || []).map((b) => String(b.bill_id)).sort() : [];
      if (!cfg.length) problems.push(`${e.key}: a pending state bill not in config/identifiers-legiscan.json (the LegiScan grabber does not follow it)`);
      else if (cfg.join() !== lsIdsOf(e).join()) problems.push(`${e.key}: its identifiers.external.legiscan (${lsIdsOf(e).join(', ') || 'none'}) differ from config/identifiers-legiscan.json (${cfg.join(', ')})`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(process.argv[2] || path.join(here, '..', '..', 'web', 'data', 'v2'));
  const entries = JSON.parse(fs.readFileSync(path.join(dir, 'entries.json'), 'utf8'));
  const legiscan = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'identifiers-legiscan.json'), 'utf8')).legiscan || {};
  const announced = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'announced-bills.json'), 'utf8')).bills || {};
  const courts = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'courts.json'), 'utf8'));
  const p = checkTracking({ entries, legiscan, announced, courts });
  if (p.length) { console.log(p.join('\n')); process.exit(1); }
  console.log(`tracking: every pending bill and every cited court docket is followed (${entries.length} entries checked)`);
}
