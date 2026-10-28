// The recall test for LegiScan discovery: if every state bill already on the site were brand new today, would the Grabber catch it?
//   node grabber/recall-legiscan.mjs      writes out/recall-legiscan.md; exits 1 if any bill in a current session would be missed
// A bill counts as CAUGHT when the precise search finds it, or the wide search finds it and the AI intent check does not say "no".
// The bar is 100%. Re-run it after any change to config/legiscan.json, grabber/intent.mjs or the screener model.
// Cost: 3 bulk searches + one session list and master list per state needed (about 25 LegiScan queries) + a few small model calls.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './lib/env.mjs';
import { createHttp } from './lib/http.mjs';
import { createLegiScan, normNumber, billNumbersIn } from './sources/legiscan.mjs';
import { preciseQuery, readUsage, addUsage, LEGISCAN_USAGE_FILE } from './run-legiscan.mjs';
import { classifyTitles, fetchIt, INTENT_PROMPT_VERSION } from './intent.mjs';
import { createLlmFactory, roleModel } from '../llm/make.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');

// Every state bill the tracker covers, whatever its status (failed ones too: a failed bill re-filed next session must be caught).
export const recallSet = (entries) => entries
  .filter((e) => e.level === 'state' && e.state && !['executive', 'litigation'].includes(e.type))
  .flatMap((e) => billNumbersIn(`${e.title} ${e.short_name}`).map((n) => ({ entry_key: e.key, state: e.state, number: n, short_name: e.short_name })));

export async function recall({ ls, llm, entries, ids, cfg, log = () => {} }) {
  const set = recallSet(entries);
  // LegiScan ids: from the identifier map, else from the state's 2025+ session master lists
  const idOf = new Map();
  for (const v of Object.values(ids.legiscan || {})) for (const b of v.bills || []) idOf.set(`${b.state}:${normNumber(b.number)}`, { bill_id: b.bill_id, title: null, session: b.session_name });
  const lists = new Map();
  for (const st of [...new Set(set.filter((x) => !idOf.has(`${x.state}:${x.number}`)).map((x) => x.state))]) {
    for (const s of (await ls.sessions(st)).filter((s) => s.year_end >= 2025)) {
      const ml = await ls.masterList(s.session_id);
      for (const b of ml.bills) { const k = `${st}:${normNumber(b.number)}`; if (!idOf.has(k)) idOf.set(k, { bill_id: b.bill_id, title: b.title, session: s.session_name }); }
      lists.set(s.session_id, ml);
    }
  }
  const precise = new Map((await ls.searchRaw({ query: preciseQuery(cfg) })).map((h) => [String(h.bill_id), h]));
  const wide = new Map((await ls.searchRaw({ query: cfg.wide_query })).map((h) => [String(h.bill_id), h]));

  const rows = [];
  for (const x of set) {
    const m = idOf.get(`${x.state}:${x.number}`);
    const id = m && String(m.bill_id);
    rows.push({ ...x, bill_id: id || null, session: m && m.session, title: m && m.title, precise: !!(id && precise.has(id)), wide: !!(id && wide.has(id)) });
  }
  // titles for wide-only bills, then the real intent check on them, exactly as the Grabber would
  for (const r of rows.filter((r) => r.wide && !r.precise && !r.title)) r.title = (await ls.bill(r.bill_id)).title;
  const judge = rows.filter((r) => r.wide && !r.precise);
  const v = await classifyTitles({ llm, items: judge.map((r) => ({ id: r.bill_id, title: r.title, state: r.state, number: r.number })), log });
  for (const r of rows) {
    r.intent = r.precise ? null : r.wide ? v.get(r.bill_id) : null;
    r.result = !r.bill_id ? 'not on LegiScan' : r.precise ? 'caught (precise)' : r.wide && fetchIt(r.intent) ? `caught (wide, ${r.intent.verdict})` : r.wide ? 'MISSED (intent "no")' : 'not in current-session search';
  }
  return rows;
}

// Section J: bills the tracker deliberately excludes. They SHOULD come back "no"; a "maybe" only costs a few queries.
export async function negatives({ llm, entries }) {
  const j = entries.filter((e) => e.section === 'J');
  const v = await classifyTitles({ llm, items: j.map((e, i) => ({ id: 'J' + i, title: e.title })) });
  return j.map((e, i) => ({ title: e.title, ...v.get('J' + i) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadEnv(pipelineDir);
  const key = process.env.LEGISCAN_API_KEY;
  if (!key) { console.error('LEGISCAN_API_KEY is needed'); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'legiscan.json'), 'utf8'));
  const models = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'models.json'), 'utf8'));
  const ids = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'identifiers-legiscan.json'), 'utf8'));
  const entries = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'out', 'entries.v2.json'), 'utf8'));
  const usageFile = LEGISCAN_USAGE_FILE, now = new Date();
  const http = createHttp({ secrets: [key], maxRequests: Math.min(80, cfg.monthly_cap - readUsage(usageFile, now).used), log: (m) => console.log('  ' + m) });
  const factory = createLlmFactory({ models });
  if (!factory.hasKey) { console.error(`${factory.keyName} is not set`); process.exit(2); }
  const llm = factory.make('screener');
  let rows, neg;
  try { rows = await recall({ ls: createLegiScan(http, key), llm, entries, ids, cfg, log: (m) => console.log('  ' + m) }); neg = await negatives({ llm, entries }); }
  finally { const u = addUsage(usageFile, now, http.used()); console.log(`legiscan queries: ${http.used()}; this month ${u.used}/${cfg.monthly_cap}`); }
  const missed = rows.filter((r) => /MISSED/.test(r.result));
  const outOfWindow = rows.filter((r) => /not in current|not on LegiScan/.test(r.result));
  const md = [`# LegiScan recall test (${now.toISOString().slice(0, 10)}, ${INTENT_PROMPT_VERSION}, ${roleModel(models, 'screener')})`, '',
    `Every state bill on the site, treated as if it were new today. **Caught ${rows.filter((r) => /caught/.test(r.result)).length} / ${rows.length - outOfWindow.length}** bills in current sessions; **missed ${missed.length}**. ${outOfWindow.length} are outside the current-session search (older sessions), so discovery does not apply to them; they are listed for completeness.`, '',
    '| Entry | Bill | LegiScan id | Session | Title on LegiScan | Result | Intent reason |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.short_name} | ${r.state} ${r.number} | ${r.bill_id || ''} | ${r.session || ''} | ${String(r.title || '').replace(/\|/g, '/').slice(0, 90)} | ${/MISSED/.test(r.result) ? '**' + r.result + '**' : r.result} | ${r.intent ? r.intent.reason : ''} |`),
    '', '## Negative set (section J: deliberately excluded)', '', 'These should come back "no". A "maybe" or "yes" is not a failure (it only costs a fetch); the agents\' scope step excludes them later.', '',
    '| Title | Verdict | Reason |', '| --- | --- | --- |', ...neg.map((n) => `| ${n.title.replace(/\|/g, '/').slice(0, 100)} | ${n.verdict} | ${n.reason} |`)].join('\n') + '\n';
  fs.writeFileSync(path.join(pipelineDir, 'out', 'recall-legiscan.md'), md);
  console.log(`recall: caught ${rows.filter((r) => /caught/.test(r.result)).length}, missed ${missed.length}, outside current sessions ${outOfWindow.length}; negatives: ${neg.filter((n) => n.verdict === 'no').length}/${neg.length} "no"`);
  for (const r of [...missed, ...outOfWindow]) console.log(`  ${r.result}: ${r.state} ${r.number} (${r.short_name}) ${r.session || ''}`);
  process.exit(missed.length ? 1 : 0);
}
