// Fetches the official text of every bill in the accuracy test set and records what was fetched.
//   node eval/fetch-texts.mjs [--only <key,key>] [--no-cache]
// Texts go to data/eval/texts/<entry key>.txt (git-ignored; public records, re-fetched on demand). eval/sources.json
// (committed) records, for each entry, which bill text was used, its official URL, length and SHA-256, so a later
// run can tell when a text changed. Federal: Congress.gov (newest text version). State: LegiScan's newest text
// version, HTML preferred, PDFs read by grabber/lib/pdf.mjs; reuses data/text-cache when present.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from '../grabber/lib/env.mjs';
import { createHttp } from '../grabber/lib/http.mjs';
import { createCongress, parseBillId, billUrl } from '../grabber/sources/congress.mjs';
import { createLegiScan, latestText, normNumber, officialUrl } from '../grabber/sources/legiscan.mjs';
import { pdfToText } from '../grabber/lib/pdf.mjs';
import { stripLineNumbering } from '../grabber/lib/text.mjs';
import { sha } from '../grabber/lib/run-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');
loadEnv(P);
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const entries = readJson(path.join(P, '..', 'web', 'data', 'v2', 'entries.json'));
const ic = readJson(path.join(P, 'config', 'identifiers.json')).congress_gov;
const il = readJson(path.join(P, 'config', 'identifiers-legiscan.json')).legiscan;
// Excluded entries (section J) give the scope test its "no" answers. Bill numbers from the entries; looked up by session.
const J_BILLS = {
  'pa-h-b-2705': ['PA', 'HB2705'], 'texas-traiga-hb-149': ['TX', 'HB149'], 'washington-sb-5395': ['WA', 'SB5395'],
  'ca-sb-1119-adam-s-law-and-sb-867': ['CA', 'SB1119'], 'nj-s-1802': ['NJ', 'S1802'],
  'ny-s10642-a11560-responsible-data-center-development-act-and': ['NY', 'S10642'], 'mi-sb-757-760-kids-over-clicks': ['MI', 'SB757']
};
const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1].split(',') : null; })();
const outDir = path.join(P, 'data', 'eval', 'texts'), cacheDir = path.join(P, 'data', 'text-cache');
fs.mkdirSync(outDir, { recursive: true });
const manifestFile = path.join(here, 'sources.json');
const manifest = readJson(manifestFile, { _note: '', items: {} });
manifest._note = 'Which official text each test-set entry was scored against. Written by eval/fetch-texts.mjs; the texts themselves are in data/eval/texts/ (git-ignored).';

const ck = process.env.CONGRESS_API_KEY, lk = process.env.LEGISCAN_API_KEY;
const cg = createCongress(createHttp({ headers: { 'X-Api-Key': ck }, secrets: [ck], maxRequests: 200 }));
const ls = createLegiScan(createHttp({ secrets: [lk], maxRequests: 150 }), lk);

async function stateText(billId) {
  const bill = await ls.bill(billId), v = latestText(bill);
  if (!v) return { text: null, why: 'no text version on LegiScan', bill };
  const cache = path.join(cacheDir, `${billId}-${v.doc_id}.txt`);
  // --no-cache: re-read from LegiScan (the cache holds text as an older reader produced it)
  if (fs.existsSync(cache) && !process.argv.includes('--no-cache')) return { text: stripLineNumbering(fs.readFileSync(cache, 'utf8')), bill, version: v };
  const t = await ls.text(v.doc_id);
  if (t.text != null) return { text: t.text, bill, version: v };
  const p = /pdf/i.test(t.mime) ? await pdfToText(t.bytes) : { text: null, reason: 'unsupported format ' + t.mime };
  return { text: p.text, why: p.reason, bill, version: v, pdf_warnings: (p.warnings || []).map((w) => `${w.found} may be ${w.reads_as}`) };
}
const sessionCache = new Map();
async function findStateBill(state, number) {
  if (!sessionCache.has(state)) sessionCache.set(state, (await ls.sessions(state)).filter((s) => !s.special).sort((a, b) => b.year_end - a.year_end).slice(0, 2));
  for (const s of sessionCache.get(state)) {
    const m = await ls.masterList(s.session_id);
    const hit = m.bills.find((b) => normNumber(b.number) === number);
    if (hit) return hit.bill_id;
  }
  return null;
}

let ok = 0, missing = 0;
for (const e of entries.filter((x) => x.origin === 'authored' && (!only || only.includes(x.key)))) {
  let rec = null;
  try {
    if (ic[e.key] && ic[e.key].congress_gov && ic[e.key].congress_gov.length) {
      const id = ic[e.key].congress_gov[0], b = parseBillId(id);
      const text = await cg.getText(b);
      rec = { kind: 'congress_gov', bill: id, url: billUrl(b) + '/text', text, why: text ? null : 'no text published on Congress.gov yet' };
    } else if (il[e.key] || J_BILLS[e.key]) {
      // A multi-bill entry is scored on its first mapped bill (the vehicle the tracker describes first).
      const id = il[e.key] ? il[e.key].bills[0].bill_id : await findStateBill(...J_BILLS[e.key]);
      if (!id) { rec = { kind: 'legiscan', text: null, why: `${J_BILLS[e.key].join(' ')} not found in the two newest sessions` }; }
      else { const s = await stateText(id); rec = { kind: 'legiscan', bill: `${s.bill.state} ${s.bill.bill_number} (${id})`, url: officialUrl(s.bill), text: s.text, why: s.text ? null : s.why, pdf_warnings: s.pdf_warnings }; }
    } else continue; // drafts, executive actions, lawsuits: no bill text API (yet)
  } catch (err) { rec = { kind: '?', text: null, why: 'fetch failed: ' + String(err.message).slice(0, 120) }; }
  if (rec.text) { fs.writeFileSync(path.join(outDir, e.key + '.txt'), rec.text); ok++; } else missing++;
  manifest.items[e.key] = { kind: rec.kind, bill: rec.bill || null, url: rec.url || null, chars: rec.text ? rec.text.length : 0, sha256: rec.text ? sha(rec.text) : null, fetched: new Date().toISOString().slice(0, 10), ...(rec.why ? { missing: rec.why } : {}), ...(rec.pdf_warnings && rec.pdf_warnings.length ? { pdf_warnings: rec.pdf_warnings } : {}) };
  console.log(`${rec.text ? 'ok  ' : 'MISS'} ${e.key}${rec.text ? ` (${rec.text.length} chars)` : ': ' + rec.why}`);
}
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
console.log(`${ok} texts fetched, ${missing} missing; manifest eval/sources.json`);
