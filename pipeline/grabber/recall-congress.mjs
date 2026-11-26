// The recall test for Congress.gov discovery: if every federal bill already on the site were brand new today, would the Grabber catch it?
//   node grabber/recall-congress.mjs      writes out/recall-congress.md; exits 1 if any bill would be missed
// The bills: every Congress.gov id on the site's federal entries (web/data/v2/entries.json) and every bill found outside the pipeline
// (config/recall-outside.json). Each bill's list title and official title are read from the Congress.gov API, and each bill is screened
// the way a run screens a new bill: the list title first, then the official title when the list title is only a short name; then the
// real AI intent check (paid, a few cents). A bill whose titles cannot be read counts as missed, never left out.
// (26 Nov 2026: the list used to come from config/identifiers.json, which has no titles for bills added by hand and no rows at all for
// bills the pipeline added, so 4 bills were scored on an empty title and pipeline-added bills were never tested.)
// The bar is 100%. Re-run it after any change to config/scope.draft.json, grabber/intent.mjs or the screener model.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './lib/env.mjs';
import { createHttp } from './lib/http.mjs';
import { makeScreen } from './screen.mjs';
import { isShortName } from './run.mjs';
import { createCongress, parseBillId } from './sources/congress.mjs';
import { classifyTitles, fetchIt, INTENT_PROMPT_VERSION } from './intent.mjs';
import { createLlmFactory, roleModel } from '../llm/make.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');

// The bills to test: [{ key, id }] from the site's federal entries, then the outside bills not already among them.
export function siteBills(entries, outside = []) {
  const out = [];
  for (const e of entries) if (e.level === 'federal') for (const id of (e.identifiers && e.identifiers.external && e.identifiers.external.congress_gov) || []) if (!out.some((r) => r.id === id)) out.push({ key: e.key, id });
  for (const b of outside) if (!out.some((r) => r.id === b.id)) out.push({ key: '(found outside the pipeline)', id: b.id, list_title: b.list_title, official_title: b.official_title });
  return out;
}

// Each bill's two titles from Congress.gov (a title already given, from recall-outside.json, is kept). A read that fails leaves it null.
export async function withTitles(bills, congress) {
  for (const b of bills) {
    const ref = parseBillId(b.id);
    if (!ref) { b.error = 'not a Congress.gov id'; continue; }
    try {
      if (!b.list_title) b.list_title = (await congress.getBill(ref)).title || null;
      if (!b.official_title) b.official_title = await congress.getOfficialTitle(ref);
    } catch (e) { b.error = String(e.message).slice(0, 100); }
  }
  return bills;
}

// bills: [{ key, id, list_title, official_title }]. The title the screen reads is the one a run would read.
export async function recallCongress({ llm, bills, scope }) {
  const precise = makeScreen({ title_terms: scope.precise_terms }), wide = makeScreen(scope);
  const rows = bills.map((b) => {
    const listHit = !!b.list_title && (precise(b.list_title) || wide(b.list_title));
    const title = !b.list_title ? b.official_title || null : listHit || !isShortName(b.list_title) || !b.official_title ? b.list_title : b.official_title;
    return { key: b.key, id: b.id, title, via: title && title === b.official_title && title !== b.list_title ? 'official title' : 'list title', error: b.error || null };
  });
  for (const r of rows) r.gate = !r.title ? 'unread' : precise(r.title) ? 'precise' : wide(r.title) ? 'wide' : 'none';
  const v = await classifyTitles({ llm, items: rows.filter((r) => r.gate === 'wide').map((r) => ({ id: r.id, title: r.title })) });
  for (const r of rows) {
    r.intent = r.gate === 'wide' ? v.get(r.id) : null;
    r.result = r.gate === 'unread' ? `MISSED (titles not read${r.error ? ': ' + r.error : ''})` : r.gate === 'precise' ? 'caught (precise)' : r.gate === 'none' ? 'MISSED (no word matched)' : fetchIt(r.intent) ? `caught (wide, ${r.intent.verdict})` : 'MISSED (intent "no")';
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadEnv(pipelineDir);
  const read = (f) => JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', f), 'utf8'));
  const models = read('models.json');
  const factory = createLlmFactory({ models });
  if (!factory.hasKey) { console.error(`${factory.keyName} is not set`); process.exit(2); }
  const key = process.env.CONGRESS_API_KEY;
  if (!key) { console.error('CONGRESS_API_KEY is not set'); process.exit(2); }
  const congress = createCongress(createHttp({ headers: { 'X-Api-Key': key }, secrets: [key], maxRequests: 400 }));
  const entries = JSON.parse(fs.readFileSync(path.join(pipelineDir, '..', 'web', 'data', 'v2', 'entries.json'), 'utf8'));
  const bills = await withTitles(siteBills(entries, read('recall-outside.json').bills), congress);
  const rows = await recallCongress({ llm: factory.make('screener'), bills, scope: read('scope.draft.json') });
  const missed = rows.filter((r) => /MISSED/.test(r.result));
  fs.writeFileSync(path.join(pipelineDir, 'out', 'recall-congress.md'), [`# Congress.gov recall test (${new Date().toISOString().slice(0, 10)}, ${INTENT_PROMPT_VERSION}, ${roleModel(models, 'screener')})`, '',
    `Every federal bill on the site, and every bill found outside the pipeline (config/recall-outside.json), treated as if it were new today, titles read from Congress.gov. **Caught ${rows.length - missed.length} / ${rows.length}; missed ${missed.length}.**`, '',
    '| Bill | Title the screen reads | Read from | Result | Intent reason |', '| --- | --- | --- | --- | --- |', ...rows.map((r) => `| ${r.id} | ${r.title || '(none)'} | ${r.via} | ${/MISSED/.test(r.result) ? '**' + r.result + '**' : r.result} | ${r.intent ? r.intent.reason : ''} |`)].join('\n') + '\n');
  console.log(`congress recall: caught ${rows.length - missed.length}/${rows.length}`);
  for (const r of rows.filter((r) => /MISSED/.test(r.result) || r.gate === 'wide')) console.log(`  ${r.result.padEnd(22)} ${r.id} ${r.title || ''}${r.intent ? ' — ' + r.intent.reason : ''}`);
  process.exit(missed.length ? 1 : 0);
}
