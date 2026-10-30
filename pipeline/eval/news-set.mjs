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
import { emptyState, renderNews, markShown } from '../news/events.mjs';
import { attachStatements } from '../news/attach.mjs';
import { makeStatementVerifier, checkAttachments } from '../news/statement-check.mjs';
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
    if (r.history && raw.bill) raw.bill.history = r.history; // a real LegiScan record with history lines taken from the stored action strings
    if (r.redate && raw.actions) raw.actions.forEach((a) => { a.actionDate = r.redate; });
    if (r.drop && raw.actions) raw.actions = raw.actions.filter((a) => !new RegExp(r.drop).test(a.text));
    return { source: r.source, source_id: r.source_id, entry_key: r.entry_key, source_url: r.source_url, fetched_at: r.fetched_at, raw, history2: r.history2 || null };
  });
  const found = c.court_found ? j(path.join(FIX, c.court_found)).found : [];
  let page = c.page_add ? { ...news, items: [...news.items, ...c.page_add] } : news; // page_add: items already on the page (Lane 1, by hand)
  for (const [i, run] of (c.runs || []).entries()) {
    const now = new Date(run.now);
    const base = run.history_add ? records.map((r) => (r.history2 ? { ...r, raw: { ...r.raw, bill: { ...r.raw.bill, history: r.history2 } } } : r)) : records; // the record read again with a later line
    if (run.redate) for (const r of base) for (const a of r.raw.actions || []) for (const x of run.redate) if (new RegExp(x.match).test(a.text)) a.actionDate = x.date; // the record re-dates an action
    const recs = run.records === 'none' ? [] : run.drop ? base.map((r) => ({ ...r, raw: { ...r.raw, actions: (r.raw.actions || []).filter((a) => !new RegExp(run.drop).test(a.text)) } })) : base;
    await eventsStep({ state, records: recs, courtFound: i === 0 ? found : [], now, runId: run.run_id, sinceDays: c.since_days || 800, items: run.extra_items || [] });
    if (run.statements) {
      // the AI statement check as production runs it: a case's recorded answers (ai_answers: headline -> answer), or no AI (nothing attaches)
      const llm = c.ai_answers ? { generate: async ({ prompt }) => ({ data: c.ai_answers[/^Headline: (.*)$/m.exec(prompt)[1]] || null }) } : null;
      const att = await checkAttachments(attachStatements(Object.values(state.events), run.statements, { allowHosts: c.allow_hosts || ['senate.gov', 'house.gov', 'ca.gov'] }), state.events, makeStatementVerifier(llm));
      for (const e of att.events) state.events[e.key] = e;
    }
    if (run.publish) { const r = renderNews(page, state, entries, { at: now.toISOString(), maxAgeDays: c.max_age_days ?? 100000 }); state.events = r.state.events; markShown(state, r.added, now.toISOString()); page = r.news; }
  }
  const last = new Date(c.runs[c.runs.length - 1].now).toISOString();
  return renderNews(page, state, entries, { at: last, maxAgeDays: c.max_age_days ?? 100000 });
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
    const differs = got.filter((n) => want.has(n.event_key) && (n.title !== want.get(n.event_key).title || n.body !== want.get(n.event_key).body || (want.get(n.event_key).status && n.status !== want.get(n.event_key).status) || (want.get(n.event_key).links && JSON.stringify(n.links.map((l) => l.u)) !== JSON.stringify(want.get(n.event_key).links)) || ('status_note' in want.get(n.event_key) && (n.status_note || null) !== want.get(n.event_key).status_note)));
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
