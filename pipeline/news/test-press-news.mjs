// Press-based news (news/press-news.mjs, eval/press-news-set.mjs) with fake models on real headlines (eval/press-news-set/cases.json) and the
// frozen site data of 26 Nov 2026. No network, no AI.
//   node news/test-press-news.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { approvedOutlet, officialSource, candidate, qualifies, itemProblems, groupLeads, writePressItem, pressItem, runPressNewsStep, pressCandidates } from './press-news.mjs';
import { scoreItem } from '../eval/press-news-set.mjs';
import { gate } from '../eval/gate.mjs';
import { watchLines } from '../report/format.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { loadData } from '../publish/run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const CASES = JSON.parse(fs.readFileSync(path.join(here, '..', 'eval', 'press-news-set', 'cases.json'), 'utf8')).cases;
const caseOf = (id) => CASES.find((c) => c.id === id);
const fake = (answers) => ({ calls: [], async generate(req) { this.calls.push(req); const a = answers.shift(); if (a instanceof Error) throw a; return { data: typeof a === 'function' ? a(req) : a }; } });
const loop = caseOf('chip-loophole'), [nyt, wapo, wapo2, ind] = loop.leads;

// ---------- 1. who counts ----------
ok('approved outlets on their own sites count; The Independent does not', approvedOutlet(nyt) === 'The New York Times' && approvedOutlet(wapo) === 'The Washington Post' && !approvedOutlet(ind));
ok('an approved name on another site does not count', !approvedOutlet({ ...nyt, link: 'https://nytimes.example.com/x' }) && !approvedOutlet({ ...nyt, link: 'http://www.nytimes.com/x' }));
const ca = caseOf('ca-sues-openai').leads;
ok('an official release (.gov, primary) is official; a press story is not', officialSource(ca[1]) && !officialSource(ca[0]) && !officialSource({ ...ca[1], primary: false }));
ok('an AI lab page never counts', !candidate({ publisher: 'OpenAI', link: 'https://openai.com/index/x', primary: true, title: 'x' }));

// ---------- 2. the qualifying rule ----------
ok('two independent approved outlets qualify (press)', qualifies([nyt, wapo]).basis === 'press');
ok('two stories of one outlet do not', !qualifies([wapo, wapo2]).ok);
ok('Wired and Ars Technica (one owner) do not', !qualifies([{ publisher: 'Wired', link: 'https://www.wired.com/a' }, { publisher: 'Ars Technica', link: 'https://arstechnica.com/b' }]).ok);
ok('an official source qualifies on its own (official)', qualifies([ca[1]]).basis === 'official' && qualifies(ca).basis === 'official');

// ---------- 3. code checks on an item ----------
const GOOD = { title: 'Trump administration orders Commerce to close an AI chip loophole', body: 'The New York Times and The Washington Post report that the Trump administration moved to close an A.I. chip loophole ahead of a China trip.', quotes: [{ key: nyt.key, quote: 'Trump Administration Moves to Close A.I. Chip Loophole Ahead of China Trip' }, { key: wapo.key, quote: 'Trump administration orders Commerce to close chip loophole' }] };
ok('a faithful, attributed item passes', itemProblems(GOOD, [nyt, wapo], 'press').length === 0, itemProblems(GOOD, [nyt, wapo], 'press').join('; '));
ok('an invented quote is refused', itemProblems({ ...GOOD, quotes: [{ key: nyt.key, quote: 'Commerce issued a final rule on 12 chips' }] }, [nyt, wapo], 'press').some((p) => /not in source/.test(p)));
ok('a number in no quote is refused', itemProblems({ ...GOOD, body: GOOD.body + ' It covers 40 firms.' }, [nyt, wapo], 'press').some((p) => /number 40/.test(p)));
ok('naming an outlet that is not a source is refused', itemProblems({ ...GOOD, body: 'Reuters and The New York Times report that it moved to close an A.I. chip loophole.' }, [nyt, wapo], 'press').some((p) => /Reuters/.test(p)));
ok('a press item must be attributed', itemProblems({ ...GOOD, body: 'The administration closed an A.I. chip loophole.' }, [nyt, wapo], 'press').some((p) => /which outlets report/.test(p)));

// ---------- 4. grouping, writing, reviewing ----------
{
  const g = await groupLeads({ grouper: fake([{ groups: [{ keys: [nyt.key, wapo.key, 'made-up'], event: 'chip loophole order', in_scope: true, why: 'government action on AI chips' }, { keys: [wapo.key, wapo2.key], event: 'x', in_scope: false, why: 'y' }] }]), leads: [nyt, wapo, wapo2] });
  ok('grouping keeps only known keys, each key in one group', g.length === 2 && g[0].keys.join() === `${nyt.key},${wapo.key}` && g[1].keys.join() === wapo2.key);
  const pass1 = { same_event: true, in_scope: true, faithful: true, problems: [] };
  const w = await writePressItem({ writer: fake([GOOD]), reviewer: fake([pass1]), leads: [nyt, wapo], basis: 'press', itemId: 't' });
  ok('a clean item and a passing review: publishable', w.decision === 'publishable');
  const h = await writePressItem({ writer: fake([GOOD]), reviewer: fake([{ ...pass1, faithful: false, problems: ['states a report as confirmed'] }]), leads: [nyt, wapo], basis: 'press', itemId: 't' });
  ok('a review finding: held', h.decision === 'held' && /not faithful/.test(h.reason));
  const s = await writePressItem({ writer: fake([GOOD]), reviewer: fake([{ ...pass1, same_event: false }]), leads: [nyt, wapo], basis: 'press', itemId: 't' });
  ok('sources that are not one event: held', s.decision === 'held');
  const twice = await writePressItem({ writer: fake([{ ...GOOD, quotes: [] }, { ...GOOD, quotes: [] }]), reviewer: fake([]), leads: [nyt, wapo], basis: 'press', itemId: 't' });
  ok('an item failing its checks twice: held, no review spent', twice.decision === 'held' && /code checks/.test(twice.reason));
  const item = pressItem({ out: GOOD, leads: [nyt, wapo], basis: 'press', at: '2026-11-26T08:00:00Z', runId: 'r' });
  const liveNews = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'live-2026-11-26', 'news.json'), 'utf8')), v = makeValidator().check('news', { ...liveNews, items: [...liveNews.items, item] });
  ok('the item passes the news schema', v.length === 0, v.join('; '));
  ok('the item says it is from press reports, links both stories and quotes them', /^From press reports \(The New York Times, The Washington Post\); not confirmed by an official record/.test(item.check) && item.basis === 'press' && item.links.length === 2 && item.evidence.every((e) => item.links.some((l) => l.u === e.source_url)));
  const off = pressItem({ out: { ...GOOD, quotes: [{ key: ca[1].key, quote: 'Attorney General Bonta Sues OpenAI' }] }, leads: ca, basis: 'official', at: '2026-11-26T08:00:00Z', runId: 'r' });
  ok('an officially confirmed item says so', /^From the official release \(California Attorney General\), with press reports/.test(off.check) && off.basis === 'official');
}

// ---------- 5. the step on the frozen site data ----------
const LIVE = path.join(here, '..', 'fixtures', 'live-2026-11-26');
const setup = (leads) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pressnews-'));
  for (const f of ['entries', 'news', 'site', 'relationships', 'changes']) fs.copyFileSync(path.join(LIVE, f + '.json'), path.join(d, f + '.json'));
  fs.writeFileSync(path.join(d, 'leads.json'), JSON.stringify({ items: Object.fromEntries(leads.map((l) => [l.key, l])) }));
  return { dir: d, leadsFile: path.join(d, 'leads.json'), stateFile: path.join(d, 'press-news.json') };
};
const factory = (answers) => ({ make: (role) => ({ async generate(req) { const a = answers[role].shift(); return { data: a }; } }) });
{
  const s = setup(loop.leads), ON = { auto_publish: { press_news: true }, max_entries_changed_per_run: 15 };
  const off = await runPressNewsStep({ dataDir: s.dir, leadsFile: s.leadsFile, stateFile: s.stateFile, config: { auto_publish: { press_news: false } }, factory: factory({}), today: '2026-11-17', runId: 'r0' });
  ok('switch off: no AI, nothing written, the candidates counted (The Independent left out)', off.status === 'quiet' && off.candidates === 3 && /off/.test(off.skipped_why));
  const before = loadData(s.dir);
  const answers = { validator: [{ groups: [{ keys: [nyt.key, wapo.key], event: 'chip loophole order', in_scope: true, why: 'x' }, { keys: [wapo2.key], event: 'Megaspeed statement', in_scope: false, why: 'company statement' }] }], generator: [GOOD], bill_reviewer: [{ same_event: true, in_scope: true, faithful: true, problems: [] }] };
  const r = await runPressNewsStep({ dataDir: s.dir, leadsFile: s.leadsFile, stateFile: s.stateFile, config: ON, factory: factory(answers), today: '2026-11-17', now: new Date('2026-11-17T08:00:00Z'), runId: 'r1' });
  const after = loadData(s.dir);
  ok('switch on: one press item added, written, nothing else changed', r.status === 'written' && after.news.items.length === before.news.items.length + 1 && JSON.stringify(after.entries) === JSON.stringify(before.entries), JSON.stringify(r));
  ok('its leads are used: the next run has nothing to do', pressCandidates(JSON.parse(fs.readFileSync(s.leadsFile, 'utf8')), JSON.parse(fs.readFileSync(s.stateFile, 'utf8')), '2026-11-17', after.news).length === 0);
  const single = setup([caseOf('texas-sues-openai').leads[0]]);
  const one = await runPressNewsStep({ dataDir: single.dir, leadsFile: single.leadsFile, stateFile: single.stateFile, config: ON, factory: factory({ validator: [{ groups: [{ keys: [caseOf('texas-sues-openai').leads[0].key], event: 'Texas sues OpenAI', in_scope: true, why: 'lawsuit' }] }], generator: [], bill_reviewer: [] }), today: '2026-10-24', runId: 'r2' });
  ok('one outlet alone: nothing written, it waits (stays an open lead)', one.added.length === 0 && one.waiting === 1 && one.qualifying === 0);
}

// ---------- 6. the measure's scoring, the gate, the report ----------
{
  const c = caseOf('chip-loophole');
  ok('measure: the gold event published with the right basis is right', scoreItem(c, [nyt.key, wapo.key], 'press', { supported: true }).length === 0);
  ok('measure: a mixed group, a wrong basis or unsupported wording is wrong', scoreItem(c, [nyt.key, wapo2.key], 'press', { supported: true }).length > 0 && scoreItem(c, [nyt.key, wapo.key], 'official', { supported: true }).length > 0 && scoreItem(c, [nyt.key, wapo.key], 'press', { supported: false, problems: ['x'] }).length > 0);
  ok('measure: anything published in a case with no gold event is wrong', scoreItem(caseOf('anthropic-ipo'), caseOf('anthropic-ipo').leads.map((l) => l.key), 'press', { supported: true }).length > 0);
  const models = { provider: 'anthropic', anthropic: { roles: { validator: { model: 'v' }, generator: { model: 'g' }, bill_reviewer: { model: 'r' } } } };
  const rep = (o) => ({ measure: 'press_news', run_at: '2026-11-26T00:00:00Z', checks_hash: 'h', grouper: 'v', writer: 'g', reviewer: 'r', cases: CASES.length, published: 3, wrong: 0, errors: 0, ...o });
  const g = (r) => gate({ config: { auto_publish: { press_news: true } }, models, measures: r ? [r] : [], hashes: { press_news: 'h' }, expected: { press_news: CASES.length }, goldItems: 1 }).fields.press_news;
  ok('gate: a full passing report opens the switch', g(rep()).meets === true);
  ok('gate: no report, a wrong item, a partial run, other models or old code keep it closed', !g(null).meets && !g(rep({ wrong: 1 })).meets && !g(rep({ cases: 2 })).meets && !g(rep({ writer: 'x' })).meets && !g(rep({ checks_hash: 'o' })).meets && !g(rep({ published: 0 })).meets);
  const w = watchLines({ sources: [], held: [], ai: {}, notes: [], press_news: { candidates: 3, added: [{ title: 'Chip loophole', basis: 'press' }], held: [{ event: 'x', why: 'the reviewer: not faithful' }], out_of_scope: [], waiting: 0, skipped_why: null } });
  ok('report: added items are listed with their basis; held ones are an alert', w.some((l) => /^1 news item added from press reports or official releases.*Chip loophole \(press reports\)/.test(l)) && w.some((l) => /^⚠️ 1 press-based news item not published/.test(l)), w.join('\n'));
}

console.log(`press-based news: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
