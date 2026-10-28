// The recall test for Congress.gov discovery: if every federal bill already on the site were brand new today, would the Grabber catch it?
//   node grabber/recall-congress.mjs      writes out/recall-congress.md; exits 1 if any bill would be missed
// Uses the official titles saved in config/identifiers.json (no Congress.gov requests) and the real AI intent check.
// The bar is 100%. Re-run it after any change to config/scope.draft.json, grabber/intent.mjs or the screener model.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './lib/env.mjs';
import { createHttp } from './lib/http.mjs';
import { makeScreen } from './screen.mjs';
import { classifyTitles, fetchIt, INTENT_PROMPT_VERSION } from './intent.mjs';
import { createLlmFactory, roleModel } from '../llm/make.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');

export async function recallCongress({ llm, ids, scope }) {
  const precise = makeScreen({ title_terms: scope.precise_terms }), wide = makeScreen(scope);
  const rows = Object.entries(ids.congress_gov).flatMap(([key, v]) => v.checks.filter((c) => c.found).map((c) => ({ key, id: c.id, title: c.api_title })));
  for (const r of rows) r.gate = precise(r.title) ? 'precise' : wide(r.title) ? 'wide' : 'none';
  const v = await classifyTitles({ llm, items: rows.filter((r) => r.gate === 'wide').map((r) => ({ id: r.id, title: r.title })) });
  for (const r of rows) {
    r.intent = r.gate === 'wide' ? v.get(r.id) : null;
    r.result = r.gate === 'precise' ? 'caught (precise)' : r.gate === 'none' ? 'MISSED (no word matched)' : fetchIt(r.intent) ? `caught (wide, ${r.intent.verdict})` : 'MISSED (intent "no")';
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadEnv(pipelineDir);
  const read = (f) => JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', f), 'utf8'));
  const models = read('models.json');
  const factory = createLlmFactory({ models });
  if (!factory.hasKey) { console.error(`${factory.keyName} is not set`); process.exit(2); }
  const llm = factory.make('screener');
  const rows = await recallCongress({ llm, ids: read('identifiers.json'), scope: read('scope.draft.json') });
  const missed = rows.filter((r) => /MISSED/.test(r.result));
  fs.writeFileSync(path.join(pipelineDir, 'out', 'recall-congress.md'), [`# Congress.gov recall test (${new Date().toISOString().slice(0, 10)}, ${INTENT_PROMPT_VERSION}, ${roleModel(models, 'screener')})`, '',
    `Every federal bill on the site, treated as if it were new today. **Caught ${rows.length - missed.length} / ${rows.length}; missed ${missed.length}.**`, '',
    '| Bill | Official title | Result | Intent reason |', '| --- | --- | --- | --- |', ...rows.map((r) => `| ${r.id} | ${r.title} | ${/MISSED/.test(r.result) ? '**' + r.result + '**' : r.result} | ${r.intent ? r.intent.reason : ''} |`)].join('\n') + '\n');
  console.log(`congress recall: caught ${rows.length - missed.length}/${rows.length}`);
  for (const r of rows.filter((r) => r.gate === 'wide')) console.log(`  ${r.result.padEnd(22)} ${r.title} — ${r.intent.reason}`);
  process.exit(missed.length ? 1 : 0);
}
