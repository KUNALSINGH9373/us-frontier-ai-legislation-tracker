// The news measure of the gate (eval/gate.mjs): a recorded event set (eval/news-set/cases.json) replayed through the real event lane
// (news/run.mjs eventsStep: adapters, classifier, upsert, confirmation) and the real render (news/events.mjs renderNews) on the real news
// page. Each case lists the official records (fixtures/news/sources/), how many runs to replay, any extra independent records, and the
// exact items that must come out (event_key, title, body). Code only, no AI, no network.
//   wrong  = an item rendered that the case does not expect, or an expected one with a different title or body (a wrong or misleading item)
//   missed = an expected item not rendered (counted, not wrong). The gate needs wrong 0.
// A case format (one object per case in cases.json):
//   { id, note, runs: [{ now, run_id }], records: [{ fixture, source, source_id, entry_key, source_url, fetched_at, redate? }],
//     court_found: "<fixture>" | null, extra_items: [RawItem], expect: [{ event_key, title, body }] }
//   node eval/news-set.mjs [--no-write]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { eventsStep } from '../news/run.mjs';
import { emptyState, renderNews, upsertItems, markShown } from '../news/events.mjs';
import { checksHash } from './hash.mjs';
import { writeMeasureReport } from './gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..'), root = path.resolve(P, '..');
export const NEWS_SET = path.join(here, 'news-set', 'cases.json');
const FIX = path.join(P, 'fixtures', 'news', 'sources');
const j = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

export async function runCase(c, { news, entries }) {
  const state = emptyState();
  const records = (c.records || []).map((r) => {
    const raw = j(path.join(FIX, r.fixture));
    if (r.redate && raw.actions) raw.actions.forEach((a) => { a.actionDate = r.redate; });
    if (r.drop && raw.actions) raw.actions = raw.actions.filter((a) => !new RegExp(r.drop).test(a.text));
    return { source: r.source, source_id: r.source_id, entry_key: r.entry_key, source_url: r.source_url, fetched_at: r.fetched_at, raw };
  });
  const found = c.court_found ? j(path.join(FIX, c.court_found)).found : [];
  let page = news;
  for (const [i, run] of (c.runs || []).entries()) {
    const now = new Date(run.now);
    const recs = run.records === 'none' ? [] : run.drop ? records.map((r) => ({ ...r, raw: { ...r.raw, actions: (r.raw.actions || []).filter((a) => !new RegExp(run.drop).test(a.text)) } })) : records;
    await eventsStep({ state, records: recs, courtFound: i === 0 ? found : [], now, runId: run.run_id, sinceDays: c.since_days || 800 });
    if (run.extra_items) upsertItems(state, run.extra_items, { runId: run.run_id + '-x', now });
    if (run.publish) { const r = renderNews(page, state, entries, { at: now.toISOString() }); markShown(state, r.added, now.toISOString()); page = r.news; }
  }
  const last = new Date(c.runs[c.runs.length - 1].now).toISOString();
  return renderNews(page, state, entries, { at: last });
}

export async function runNewsSet({ cases, now = new Date() }) {
  const news = j(path.join(root, 'web', 'data', 'v2', 'news.json')), entries = j(path.join(root, 'web', 'data', 'v2', 'entries.json'));
  const rows = [];
  for (const c of cases) {
    let r, err = null;
    try { r = await runCase(c, { news, entries }); } catch (e) { err = e.message; }
    const got = err ? [] : r.news.items.filter((n) => n.event_key);
    const want = new Map((c.expect || []).map((x) => [x.event_key, x]));
    const extra = got.filter((n) => !want.has(n.event_key));
    const differs = got.filter((n) => want.has(n.event_key) && (n.title !== want.get(n.event_key).title || n.body !== want.get(n.event_key).body || (want.get(n.event_key).status && n.status !== want.get(n.event_key).status)));
    const missed = [...want.keys()].filter((k) => !got.some((n) => n.event_key === k));
    rows.push({ id: c.id, expect: want.size, got: got.length, wrong: extra.length + differs.length > 0, missed: missed.length > 0, extra: extra.map((n) => `${n.event_key}: ${n.title}`), differs: differs.map((n) => `${n.event_key}: ${n.title} | ${n.body}`), missing: missed, error: err });
  }
  return { measure: 'news', run_at: now.toISOString(), checks_hash: checksHash('news'), cases: rows.length, wrong: rows.filter((x) => x.wrong).length, missed: rows.filter((x) => x.missed).length, rows };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const set = j(NEWS_SET);
  const rep = await runNewsSet({ cases: set.cases });
  rep.rows.forEach((x) => console.log(`  ${x.wrong ? 'WRONG ' : x.missed ? 'missed' : 'ok    '} ${x.id.padEnd(30)} expect ${x.expect} got ${x.got}${x.error ? ` (error: ${x.error})` : ''}${[...x.extra, ...x.differs, ...x.missing].map((s) => '\n         ' + s).join('')}`));
  console.log(`news set: ${rep.cases} cases, ${rep.wrong} wrong, ${rep.missed} missed`);
  if (!process.argv.includes('--no-write')) console.log('wrote ' + writeMeasureReport(rep));
  process.exit(rep.wrong ? 1 : 0);
}
