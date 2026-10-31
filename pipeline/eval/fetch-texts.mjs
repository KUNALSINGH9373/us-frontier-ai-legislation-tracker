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
import { stateNumbersOf } from '../agents/dedupe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');
loadEnv(P);
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const entries = readJson(path.join(P, '..', 'web', 'data', 'v2', 'entries.json'));
const ic = readJson(path.join(P, 'config', 'identifiers.json')).congress_gov;
const il = readJson(path.join(P, 'config', 'identifiers-legiscan.json')).legiscan;
// Bills the tracker lists but does not follow (excluded section J entries, failed state bills with no LegiScan mapping) give the scope
// test its "no" answers and the duty backfill its texts. Each is looked up by its first bill number, read from the entry the same way
// agents/dedupe.mjs reads bill numbers (stateNumbersOf), so no list is kept by hand.
const mapped = (e) => (ic[e.key] && (ic[e.key].congress_gov || []).length) || il[e.key];
const isStateBill = (e) => e.section === 'J' || (e.level === 'state' && ['bill', 'auditor'].includes(e.type));
const J_BILLS = Object.fromEntries(entries.filter((e) => e.origin === 'authored' && !mapped(e) && isStateBill(e))
  .map((e) => [e.key, stateNumbersOf(e)[0]]).filter(([, n]) => n).map(([k, n]) => [k, n.split(':')]));
const only = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1].split(',') : null; })();
const outDir = path.join(P, 'data', 'eval', 'texts'), cacheDir = path.join(P, 'data', 'text-cache');
fs.mkdirSync(outDir, { recursive: true });
const manifestFile = path.join(here, 'sources.json');
const manifest = readJson(manifestFile, { _note: '', items: {} });
manifest._note = 'Which official text each test-set entry was scored against. Written by eval/fetch-texts.mjs; the texts themselves are in data/eval/texts/ (git-ignored).';

const ck = process.env.CONGRESS_API_KEY, lk = process.env.LEGISCAN_API_KEY;
const cg = createCongress(createHttp({ headers: { 'X-Api-Key': ck }, secrets: [ck], maxRequests: 200 }));
const ls = createLegiScan(createHttp({ secrets: [lk], maxRequests: 150 }), lk);

const texts = createEntryTexts({ cg, ls, ic, il, cacheDir, extra: J_BILLS, noCache: process.argv.includes("--no-cache"), repair: false, withAdopted: true });

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
