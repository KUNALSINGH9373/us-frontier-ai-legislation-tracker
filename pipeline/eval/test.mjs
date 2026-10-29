// Tests for the test-set scoring and the gate. No network, no model.
//   node eval/test.mjs
import { scoreItem, summarise, factNumbers, codeChecks } from './run.mjs';
import { gate, gatedPublishConfig, readGateInputs } from './gate.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const TEXT = 'Sec. 2. A frontier model is trained using greater than 10^26 integer or floating-point operations. A large developer has annual revenue over $500,000,000. Reports are due within 72 hours. Penalty: up to $1,000,000 per violation. Effective 2027.';
const gold = { key: 'x', in_scope: true, mechanism: 'Requires reports within 72 hours; effective 2027', thresholds: '10²⁶ ops; >$500M revenue ($500,000,000)', penalties: 'Up to $1,000,000 per violation; $3,000,000 for repeats' };

ok('exponents read the same however printed; years and single digits are not facts', [...factNumbers('10²⁶ ops in 2027, 3 times')].join() === '10,26');
{
  const s = scoreItem({ gold, text: TEXT, result: { outcome: 'published', in_scope: true, fields: { mechanism: 'Developers report incidents within 72 hours.', thresholds: 'Trained on more than 10^26 operations; revenue over $500,000,000', penalties: 'Up to $1,000,000 per violation' } } });
  ok('thresholds pass when every provable number is stated', s.fields.thresholds.pass && s.fields.thresholds.recall === 1, JSON.stringify(s.fields.thresholds));
  ok('a number the author took from elsewhere ($3,000,000) is not held against the model', s.fields.penalties.pass && !s.fields.penalties.provable.includes('3000000'));
  ok('mechanism passes on support; its number recall is reported', s.fields.mechanism.pass && s.fields.mechanism.recall === 1);
}
{
  const s = scoreItem({ gold, text: TEXT, result: { outcome: 'published', in_scope: true, fields: { mechanism: 'Reports.', thresholds: 'Revenue over $500,000,000', penalties: null } } });
  ok('thresholds missing the compute figure fail', !s.fields.thresholds.pass && s.fields.thresholds.found.join() === '500000000' && s.fields.thresholds.provable.join() === '10,26,500000000');
  ok('penalties left out when the text states one fail', !s.fields.penalties.pass);
}
{
  const s = scoreItem({ gold, text: TEXT, result: { outcome: 'published', in_scope: true, fields: { mechanism: 'Due within 48 hours.', thresholds: '10^26 operations; $500,000,000', penalties: '$1,000,000' } } });
  ok('a number not in the official text is unsupported and fails the field', !s.fields.mechanism.pass && s.fields.mechanism.unsupported.includes('48'));
}
{
  const held = scoreItem({ gold, text: TEXT, result: { outcome: 'held', fields: {} } });
  ok('a held item publishes nothing, so no field passes', Object.values(held.fields).every((f) => !f.pass && !f.got));
  ok('scope: dropping an in-scope bill is wrong', !scoreItem({ gold, text: TEXT, result: { outcome: 'out_of_scope', fields: {} } }).scope_ok);
  const ex = { ...gold, in_scope: false };
  ok('scope: an excluded bill held or dropped is right; published is wrong', scoreItem({ gold: ex, text: TEXT, result: { outcome: 'held', fields: {} } }).scope_ok && scoreItem({ gold: ex, text: TEXT, result: { outcome: 'out_of_scope', fields: {} } }).scope_ok && !scoreItem({ gold: ex, text: TEXT, result: { outcome: 'published', fields: {} } }).scope_ok);
}
{
  const p = codeChecks({ fields: { thresholds: 'more than 10^27 operations' }, evidence: [{ field: 'thresholds', quote: 'greater than 10^27 integer' }] }, TEXT);
  ok('code checks catch an invented quote and an invented number', p.some((x) => /not in the source/.test(x) && /quote/.test(x)) && p.some((x) => /number 27/.test(x)));
  ok('code checks catch stray foreign-script text (a published Bengali tail, 16 Oct)', codeChecks({ fields: { thresholds: 'more than 10^26 operations খেলতে হবে' }, evidence: [{ field: 'thresholds', quote: 'greater than 10^26 integer or floating-point operations' }] }, TEXT).some((x) => /letters that do not occur/.test(x)));
  ok('code checks pass a faithful field', codeChecks({ fields: { thresholds: 'more than 10^26 operations' }, evidence: [{ field: 'thresholds', quote: 'greater than 10^26 integer or floating-point operations' }] }, TEXT).length === 0);
}
{
  const rows = [scoreItem({ gold, text: TEXT, result: { outcome: 'published', in_scope: true, fields: { mechanism: 'Within 72 hours.', thresholds: '10^26; $500,000,000', penalties: '$1,000,000' } } }), scoreItem({ gold, text: TEXT, result: { outcome: 'held', fields: {} } })].map((s) => ({ ...s, gold_in_scope: true }));
  const sum = summarise(rows);
  ok('summary: pass rate over in-scope items', sum.fields.thresholds.pass_rate === 0.5 && sum.fields.thresholds.items === 2);
  const config = { auto_publish: { mechanism: true, thresholds: false, penalties: false, new_entries: false }, eval_bar: { pass_rate: 1, unsupported_fields: 0, scope_agreement: 1 } };
  const models = { provider: 'gemini', roles: { generator: { model: 'm' } } };
  const g = gate({ config, models, reports: [{ generator: 'm', run_at: '2026-10-16', summary: sum }], goldItems: 2 });
  ok('gate: a switch on below the bar is a violation', g.violations.includes('mechanism') && !g.fields.thresholds.meets);
  const g2 = gate({ config, models, reports: [{ generator: 'm', run_at: '2026-10-16', summary: { ...sum, items: 1 } }], goldItems: 2 });
  ok('gate: a partial run does not count', g2.report === null);
  const g3 = gate({ config, models: { provider: 'anthropic', anthropic: { roles: { generator: { model: 'claude' } } } }, reports: [{ generator: 'm', run_at: '2026-10-16', summary: sum }], goldItems: 2 });
  ok('gate: a report for another model does not count', g3.report === null);
  // Round 2 gate (code review B1-B3, S6, S7): every Lane 2 switch has its own measure, made by the current code (checks_hash).
  const all = { pass_rate: 1, unsupported_fields: 0, items: 2 };
  const H = { fields: 'hf', new_entries: 'ht', relationships: 'hl', news: 'hn', news_writer: 'hw' };
  const modelsR = { provider: 'gemini', roles: { generator: { model: 'm' }, validator: { model: 'v' }, referee: { model: 'r' } } };
  const EXP = { tierb: 12, news: 6, news_writer: 7, links: null };
  const fieldsRep = { generator: 'm', reader: 'v', validator: 'v', referee: 'r', run_at: '2026-10-16', checks_hash: 'hf', summary: { items: 2, scope_agreement: 1, fields: { mechanism: all, thresholds: all, penalties: all } } };
  const ON = { mechanism: true, thresholds: true, penalties: true, new_entries: true, relationships: true, news: true };
  const tierb = (o = {}) => ({ measure: 'tierb', run_at: '2026-10-29', checks_hash: 'ht', cases: 12, wrong: 0, ...o });
  const links = (o = {}) => ({ measure: 'links', run_at: '2026-10-29', checks_hash: 'hl', cases: 300, wrong: 0, errors: 0, backtest_errors: 0, backtest: { proposals: 50, as_new_proposals: 50 }, suite_passed: 200, suite_failed: 0, suite_note: null, applied_wrong: 0, ...o });
  const newsR = (o = {}) => ({ measure: 'news', run_at: '2026-10-29', checks_hash: 'hn', cases: 6, wrong: 0, ...o });
  const writerR = (o = {}) => ({ measure: 'news_writer', run_at: '2026-10-29', checks_hash: 'hw', cases: 7, wrong: 0, ai_written: 3, ...o });
  const G = (measures, extra = {}) => gate({ config: { ...config, news_from_official_actions: false, auto_publish: ON, ...(extra.lane1 ? { news_from_official_actions: true } : {}) }, models: modelsR, reports: [fieldsRep], goldItems: 2, measures: measures.some((m) => m.measure === 'news_writer') || extra.noWriter ? measures : [...measures, writerR()], hashes: H, expected: EXP, ...extra });
  // Round 3 gate (audit items 1-4).
  ok('gate r3: a partial measure report (partial: true) never counts, for every measure', !G([tierb({ partial: true }), links(), newsR()]).fields.new_entries.meets && !G([tierb(), links({ partial: true }), newsR()]).fields.relationships.meets && !G([tierb(), links(), newsR({ partial: true })]).fields.news.meets);
  ok('gate r3: fewer cases than the case set holds never count', !G([tierb({ cases: 11 }), links(), newsR()]).fields.new_entries.meets && !G([tierb(), links(), newsR({ cases: 5 })]).fields.news.meets && /whole case set/.test(G([tierb({ cases: 3 }), links(), newsR()]).fields.new_entries.note));
  ok('gate r3: links cases must add up (no suite read, or a missing part, does not count)', !G([tierb(), links({ cases: 299 }), newsR()]).fields.relationships.meets && !G([tierb(), links({ suite_passed: 0, cases: 100 }), newsR()]).fields.relationships.meets && !G([tierb(), links({ suite_note: 'x' }), newsR()]).fields.relationships.meets);
  ok('gate r3: a links report with a wrong record-proved edge, or without that count, does not count', !G([tierb(), links({ applied_wrong: 1 }), newsR()]).fields.relationships.meets && !G([tierb(), links({ applied_wrong: undefined }), newsR()]).fields.relationships.meets);
  ok('gate r3: no known case-set size fails closed', !G([tierb(), links(), newsR()], { expected: {} }).fields.new_entries.meets && !G([tierb(), links(), newsR()], { expected: {} }).fields.news.meets);
  ok('gate r3: a partial field report (partial: true) never counts', G([tierb(), links(), newsR()], { reports: [{ ...fieldsRep, partial: true }] }).report === null);
  ok('gate r3: the field report must match the production reader and referee too', G([], { reports: [{ ...fieldsRep, reader: 'x', validator: 'x' }] }).report === null && G([], { reports: [{ ...fieldsRep, referee: 'x' }] }).report === null && G([], { reports: [(({ referee, ...r }) => r)(fieldsRep)] }).report === null && G([], {}).report === '2026-10-16');
  ok('gate r3: hashes null fails closed (no report counts)', G([tierb(), links(), newsR()], { hashes: null }).violations.length === 6 && G([], { hashes: null }).report === null);
  {
    const { checksHash, pipelineFiles } = await import('./hash.mjs');
    const files = pipelineFiles();
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const must = ['eval/tierb-set/cases.json', 'eval/news-set/cases.json', 'eval/gold.json', 'config/models.json', 'config/publish.json', 'llm/anthropic.mjs', 'grabber/run.mjs', 'compare/run.mjs', 'publish/run.mjs', 'agents/run.mjs', 'links/run.mjs', 'news/run.mjs', 'schema/validate.mjs'];
    const missing = must.filter((f) => fs.existsSync(path.join(root, f)) && !files.includes(f));
    ok('hash r3: checks_hash covers case sets, gold, config, llm, grabber, compare, publish, agents, links, news, schema', missing.length === 0 && files.includes('config/models.json') && files.some((f) => f.startsWith('eval/tierb-set/records/')) && files.some((f) => f.startsWith('grabber/sources/')), missing.join());
    ok('hash r3: what a run writes is not hashed (data, state, reports)', !files.some((f) => /^(data|state|node_modules|eval\/reports)\//.test(f)));
    ok('hash: the tracked-bill lists a run rewrites (config/identifiers*.json) are not hashed', fs.existsSync(path.join(root, 'config', 'identifiers.json')) && !files.some((f) => /^config\/identifiers.*\.json$/.test(f)) && files.includes('config/models.json'), files.filter((f) => f.startsWith('config/')).join());
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-'));
    fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true }); fs.mkdirSync(path.join(tmpRoot, 'eval', 'tierb-set'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'config', 'publish.json'), '{"a":1,"auto_publish":{"news":false}}'); fs.writeFileSync(path.join(tmpRoot, 'eval', 'tierb-set', 'cases.json'), '{"cases":[]}');
    const h0 = checksHash('new_entries', tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'config', 'publish.json'), '{"a":1,"auto_publish":{"news":true}}');
    const h1 = checksHash('new_entries', tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'eval', 'tierb-set', 'cases.json'), '{"cases":[1]}');
    const h2 = checksHash('new_entries', tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, 'config', 'publish.json'), '{"a":2,"auto_publish":{"news":true}}');
    ok('hash r3: a changed case set or publish setting changes the hash; flipping a switch does not', h0 === h1 && h1 !== h2 && h2 !== checksHash('new_entries', tmpRoot));
  }
  const g4 = G([tierb(), links(), newsR()]);
  ok('gate: every switch meets its own measure at zero wrong, made by the current code', g4.violations.length === 0 && g4.fields.new_entries.meets && g4.fields.relationships.meets && g4.fields.news.meets, JSON.stringify(g4.fields));
  const g5 = G([links(), newsR()]);
  ok('gate: new entries need the Tier B replay set as well as the field eval', !g5.fields.new_entries.meets && g5.violations.includes('new_entries') && g5.fields.relationships.meets);
  const g6 = G([tierb(), newsR()]);
  ok('gate: relationships are their own measure and not part of new entries', !g6.fields.relationships.meets && g6.fields.new_entries.meets && g6.violations.join() === 'relationships', g6.violations.join());
  ok('gate: one wrong item in a measure keeps its switch off', !G([tierb({ wrong: 1 }), links(), newsR()]).fields.new_entries.meets && !G([tierb(), links({ wrong: 1, suite_failed: 1 }), newsR()]).fields.relationships.meets && !G([tierb(), links(), newsR({ wrong: 1 })]).fields.news.meets);
  ok('gate: news stays off while Lane 1 still writes official-action news (news_from_official_actions on), with a note saying so', !G([tierb(), links(), newsR()], { lane1: true }).fields.news.meets && /news_from_official_actions/.test(G([tierb(), links(), newsR()], { lane1: true }).fields.news.note));
  ok('gate: news has a measure (the event set); without a report its switch is off', !G([tierb(), links()]).fields.news.meets);
  ok('gate: news also needs the card-writer measure: none, one wrong, a partial set, or no AI-written card keeps it off', !G([tierb(), links(), newsR()], { noWriter: true }).fields.news.meets && !G([tierb(), links(), newsR(), writerR({ wrong: 1 })]).fields.news.meets && !G([tierb(), links(), newsR(), writerR({ cases: 6 })]).fields.news.meets && !G([tierb(), links(), newsR(), writerR({ ai_written: 0 })]).fields.news.meets && !G([tierb(), links(), newsR(), writerR({ checks_hash: 'old' })]).fields.news.meets && G([tierb(), links(), newsR(), writerR()]).fields.news.meets);
  ok('gate: a report made by other code (checks_hash differs or is missing) does not count', !G([tierb({ checks_hash: 'old' }), links(), newsR()]).fields.new_entries.meets && G([], { reports: [{ ...fieldsRep, checks_hash: undefined }] }).report === null);
  const g7 = G([tierb(), links(), newsR()], { error: 'gold.json is unreadable' });
  ok('gate: unreadable inputs turn every switch off with a note', Object.values(g7.fields).every((x) => !x.meets && /could not be read/.test(x.note)) && g7.violations.length === 6);
  const gc = gatedPublishConfig({ config: { ...config, auto_publish: ON }, models, reports: [], goldItems: 0, error: 'reports/x.json is unreadable' });
  ok('gate at run time: an unreadable report turns every switch off, never throws', Object.values(gc.config.auto_publish).every((v) => v === false) && gc.off.length === 6 && gc.off.every((x) => /could not be read/.test(x.why)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')); fs.writeFileSync(path.join(tmp, 'bad.json'), '{ not json');
  const gi = readGateInputs(tmp);
  ok('gate inputs: an unreadable report gives an error, not an exception', !!gi.error && /bad\.json/.test(gi.error));
}

console.log(`eval: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
