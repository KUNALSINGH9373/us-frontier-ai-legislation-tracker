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
import { createCongress } from '../grabber/sources/congress.mjs';
import { createLegiScan } from '../grabber/sources/legiscan.mjs';
import { createEntryTexts } from '../correct/texts.mjs';
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
  'ny-s10642-a11560-responsible-data-center-development-act-and': ['NY', 'S10642'], 'mi-sb-757-760-kids-over-clicks': ['MI', 'SB757'],
  // Failed state bills the tracker lists but does not follow (no LegiScan mapping); fetched for the duty backfill.
  'tn-hb-1898-sb-2171': ['TN', 'HB1898'], 'ut-hb-286': ['UT', 'HB286'], 'la-sb-474': ['LA', 'SB474'], 'ny-s-10701-terminator-act-withdrawn': ['NY', 'S10701']
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

const texts = createEntryTexts({ cg, ls, ic, il, cacheDir, extra: J_BILLS, noCache: process.argv.includes('--no-cache'), repair: false });

let ok = 0, missing = 0;
for (const e of entries.filter((x) => x.origin === 'authored' && (!only || only.includes(x.key)))) {
  const rec = await texts.textFor(e.key);
  if (!rec) continue; // drafts, executive actions, lawsuits: no bill text API (yet)
  if (rec.text) { fs.writeFileSync(path.join(outDir, e.key + '.txt'), rec.text); ok++; } else missing++;
  manifest.items[e.key] = { kind: rec.kind, bill: rec.bill || null, url: rec.url || null, chars: rec.text ? rec.text.length : 0, sha256: rec.text ? sha(rec.text) : null, fetched: new Date().toISOString().slice(0, 10), ...(rec.why ? { missing: rec.why } : {}), ...(rec.pdf_warnings && rec.pdf_warnings.length ? { pdf_warnings: rec.pdf_warnings } : {}) };
  console.log(`${rec.text ? 'ok  ' : 'MISS'} ${e.key}${rec.text ? ` (${rec.text.length} chars)` : ': ' + rec.why}`);
}
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
console.log(`${ok} texts fetched, ${missing} missing; manifest eval/sources.json`);
