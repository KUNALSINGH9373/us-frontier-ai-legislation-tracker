// The gate: which AI-written output may publish on its own. Each switch in config/publish.json (auto_publish) may be on only when the latest
// report of ITS OWN measure meets the bar, and that report was made by the code as it is now (checks_hash, eval/hash.mjs):
//   mechanism, thresholds, penalties   the field eval (eval/run.mjs) over the whole test set for the production model: eval_bar
//   new_entries                        every reading field above AND the Tier B replay set (eval/tierb-set.mjs) at zero wrong
//   relationships                      the links backtest on the real network AND the links synthetic suite (eval/links-measure.mjs), zero wrong
//   news                               the event set (eval/news-set.mjs) and the card writer (eval/news-writer-set.mjs) at zero wrong
// A report whose checks_hash is missing or differs from the current code does not count. An unreadable report or gold file turns every
// switch off for the run with a note (update.mjs never stops on it; the official-record steps go on).
//   node eval/gate.mjs            prints the verdict per switch; exit 1 if a switch is on without a passing report
// The commands that make reports that count are printed by `node eval/gate.mjs --how`.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { currentHashes } from './hash.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');

export const FIELD_SWITCHES = ['mechanism', 'thresholds', 'penalties'];
const MEASURED = { new_entries: 'tierb', relationships: 'links', news: 'news' };
export const HOW = [
  'cd pipeline',
  'node eval/fetch-texts.mjs && node eval/run.mjs --provider anthropic      # field eval (whole test set, production models; paid)',
  'node eval/tierb-set.mjs                                                  # Tier B replay set (code only, no AI)',
  'node eval/links-measure.mjs                                              # links backtest + links synthetic suite (code only)',
  'node eval/news-set.mjs                                                   # news event set (code only, real records replayed)',
  'node eval/news-writer-set.mjs                                            # news card writer (recorded answers + synthetic bad cards)',
  'node eval/gate.mjs'
];

// The latest report of a non-field measure (kind tierb | links | news) that was made by the current code.
const latestOf = (measures, kind) => (measures || []).filter((r) => r && r.measure === kind).sort((a, b) => String(a.run_at).localeCompare(String(b.run_at))).pop() || null;

// The production model of a role (generator, validator, referee) in config/models.json; null when the provider has no such role.
export const roleModel = (models, role) => { if (!models) return null; const roles = models.provider === 'anthropic' ? models.anthropic && models.anthropic.roles : models.roles; return roles && roles[role] ? roles[role].model : null; };

export function gate({ config, models, reports = [], goldItems, measures = [], hashes = null, expected = {}, error = null }) {
  const bar = config.eval_bar || { pass_rate: 1, unsupported_fields: 0, scope_agreement: 1 };
  const prod = roleModel(models, 'generator'), prodReader = roleModel(models, 'validator'), prodReferee = roleModel(models, 'referee');
  const auto = config.auto_publish || {};
  if (error) {
    const fields = Object.fromEntries(Object.keys(auto).filter((f) => !f.startsWith('_')).map((f) => [f, { on: !!auto[f], meets: false, note: `the gate inputs could not be read (${error}); every switch is off this run` }]));
    return { model: prod, report: null, bar, fields, violations: Object.entries(fields).filter(([, x]) => x.on).map(([f]) => f), error };
  }
  // Fail closed: no current hashes (or none for the measure) means no report counts.
  const hashOk = (r, m) => !!(hashes && hashes[m] && r && r.checks_hash && r.checks_hash === hashes[m]);
  // Only a run over the whole test set counts (a run limited with --only or --limit proves nothing about the rest), made by the production
  // generator, reader (validator) AND referee, by the current code. A report that does not name its reader and referee does not count.
  const sameModels = (r) => r.generator === prod && (r.validator || r.reader) === prodReader && 'referee' in r && (r.referee || null) === prodReferee;
  const fullSet = (r) => r.partial !== true && Number(goldItems) > 0 && !!r.summary && r.summary.items === goldItems;
  const latest = reports.filter((r) => r && sameModels(r) && fullSet(r) && hashOk(r, 'fields')).sort((a, b) => String(a.run_at).localeCompare(String(b.run_at))).pop() || null;
  const fieldOf = (f) => {
    const s = latest && latest.summary.fields[f];
    const meets = !!s && s.pass_rate >= bar.pass_rate && s.unsupported_fields <= bar.unsupported_fields && latest.summary.scope_agreement >= bar.scope_agreement;
    return { on: !!auto[f], meets, pass_rate: s ? s.pass_rate : null };
  };
  const fields = Object.fromEntries(Object.keys(auto).filter((f) => !f.startsWith('_') && !(f in MEASURED)).map((f) => [f, fieldOf(f)]));
  const fieldsMeet = FIELD_SWITCHES.every((f) => (fields[f] || fieldOf(f)).meets);
  const measured = (kind, m) => { const r = latestOf(measures, kind); return r && hashOk(r, m) ? r : null; };
  // A measure counts only over its whole case set: never a partial run (--only), never fewer cases than the set holds. The links measure
  // has no fixed case file: its cases must add up (backtest both ways + the whole synthetic suite, read) and none may be missing.
  const complete = (r, kind) => {
    if (!r || r.partial === true || !(Number(r.cases) > 0)) return false;
    if (kind === 'links') {
      const b = r.backtest || {}, sum = Number(b.proposals) + Number(b.as_new_proposals) + Number(r.suite_passed) + Number(r.suite_failed);
      return r.suite_note == null && r.applied_wrong === 0 && Number(b.proposals) > 0 && Number(r.suite_passed) > 0 && sum === Number(r.cases) && (expected.links == null || Number(r.cases) >= expected.links);
    }
    return Number(expected[kind]) > 0 && Number(r.cases) >= Number(expected[kind]);
  };
  // links: wrong record-proved (applied) edges are counted on their own and must be 0 (a report without the count does not count).
  const zeroOf = (kind) => (r) => complete(r, kind) && r.wrong === 0 && (!('errors' in r) || r.errors === 0);
  const incomplete = (r, kind) => `the latest ${kind} report is not over the whole case set (${r.partial === true ? 'partial run' : `${r.cases} cases${expected[kind] ? ` of ${expected[kind]}` : ''}`})`;
  // new_entries: the reading fields AND the Tier B replay set. Relationships are their own measure, never part of this.
  if ('new_entries' in auto) {
    const t = measured('tierb', 'new_entries'), zero = zeroOf('tierb');
    fields.new_entries = { on: !!auto.new_entries, meets: fieldsMeet && zero(t), report: t ? t.run_at : null, note: !fieldsMeet ? 'every reading field must meet the bar on the field eval' : !t ? 'no Tier B replay report made by the current code (eval/tierb-set.mjs)' : zero(t) ? null : !complete(t, 'tierb') ? incomplete(t, 'tierb') : `the Tier B replay set has ${t.wrong} wrong of ${t.cases}` };
  }
  if ('relationships' in auto) {
    const l = measured('links', 'relationships'), zero = zeroOf('links');
    fields.relationships = { on: !!auto.relationships, meets: zero(l), report: l ? l.run_at : null, note: !l ? 'no links report made by the current code (eval/links-measure.mjs)' : zero(l) ? null : !complete(l, 'links') ? incomplete(l, 'links') : `links: ${l.wrong} wrong (backtest ${l.backtest_errors}, synthetic suite ${l.suite_failed} failed)` };
  }
  if ('news' in auto) {
    // news: the event set (eval/news-set.mjs) AND the card writer (eval/news-writer-set.mjs: full set, current code, at least one card
    // really written by the AI), both at zero wrong
    const n = measured('news', 'news'), zero = zeroOf('news');
    // news.ai_writer false (default): the report must be the phrase-bank measure (mode bank). true: an AI report with at least one
    // AI-written card, recorded with the production generator and validator (roleModel).
    const aiWriter = !!(config.news && config.news.ai_writer === true);
    const w = measured('news_writer', 'news_writer');
    const modeOk = !w ? false : aiWriter ? w.mode === 'ai' && Number(w.ai_written) > 0 && w.generator === prod && w.validator === prodReader : w.mode === 'bank';
    const wOk = zeroOf('news_writer')(w) && modeOk;
    const nNote = !n ? 'no news-set report made by the current code (eval/news-set.mjs)' : zero(n) ? null : !complete(n, 'news') ? incomplete(n, 'news') : `the news set has ${n.wrong} wrong of ${n.cases}`;
    const wNote = !w ? 'no news-writer report made by the current code (eval/news-writer-set.mjs)' : wOk ? null : !complete(w, 'news_writer') ? incomplete(w, 'news_writer') : w.wrong ? `the news-writer set has ${w.wrong} wrong of ${w.cases}` : aiWriter ? (w.mode !== 'ai' ? 'news.ai_writer is on but the news-writer report is not an AI report' : Number(w.ai_written) > 0 ? `the news-writer AI answers were recorded with ${w.generator}/${w.validator}, not the production ${prod}/${prodReader}` : 'the news-writer report has no AI-written card') : 'the news-writer report is not the phrase-bank measure (news.ai_writer is off)';
    // Lane 1's own official-action news must be off before the event model publishes, or both write the same action (review r3 #4)
    const lane1 = !config || config.news_from_official_actions !== false;
    fields.news = { on: !!auto.news, meets: zero(n) && wOk && !lane1, report: n ? n.run_at : null, writer_report: w ? w.run_at : null, note: lane1 ? 'news_from_official_actions is on in config/publish.json: Lane 1 already writes official-action news; switch it off before news publishing goes on' : nNote || wNote };
  }
  const violations = Object.entries(fields).filter(([, x]) => x.on && !x.meets).map(([f]) => f);
  return { model: prod, report: latest ? latest.run_at : null, bar, fields, violations };
}

// The gate at run time (update.mjs): every auto_publish switch whose measure does not meet the bar is treated as OFF for the run, whatever
// config/publish.json says. Returns { config: a copy with the switches the run may use, gate, off: [{ field, why }] }. Never throws.
export function gatedPublishConfig({ config, models, reports, goldItems, measures, hashes, expected, error }) {
  let g;
  try { g = gate({ config, models, reports, goldItems, measures, hashes, expected, error }); }
  catch (e) { g = gate({ config, models, error: `the gate failed: ${e.message}` }); }
  const out = JSON.parse(JSON.stringify(config)), off = [];
  for (const [f, x] of Object.entries(g.fields)) {
    if (!x.on || x.meets === true) continue;
    out.auto_publish[f] = false;
    off.push({ field: f, why: g.error ? x.note : x.note || (!g.report ? `no full test-set report for ${g.model} made by the current prompts and checks (eval/reports), so the gate cannot pass` : `the latest full test-set report for ${g.model} (${g.report}) is below the bar for ${f}`) });
  }
  return { config: out, gate: g, off };
}

// Reads the inputs of the gate from disk: the reports in eval/reports (field eval reports, and measure reports with "measure"), the size of
// the test set, and the current code hashes. An unreadable file gives { error } (all switches off), never an exception.
export function readGateInputs(dir = path.join(here, 'reports'), goldFile = path.join(here, 'gold.json')) {
  try {
    const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
    const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return read(path.join(dir, f)); } catch (e) { throw new Error(`${path.basename(f)} is unreadable: ${e.message}`); } }) : [];
    const gold = read(goldFile);
    if (!gold || !Array.isArray(gold.items)) throw new Error('gold.json has no items list');
    // The size of each fixed case set: a measure report with fewer cases does not count.
    const setSize = (f) => { const s = read(f); if (!s || !Array.isArray(s.cases)) throw new Error(`${path.basename(path.dirname(f))}/cases.json has no cases list`); return s.cases.length; };
    const expected = { tierb: setSize(path.join(here, 'tierb-set', 'cases.json')), news: setSize(path.join(here, 'news-set', 'cases.json')), news_writer: setSize(path.join(here, 'news-writer-set', 'cases.json')), links: null };
    return { expected, reports: all.filter((r) => !r.measure || r.measure === 'fields'), measures: all.filter((r) => r.measure && r.measure !== 'fields'), goldItems: gold.items.length, hashes: currentHashes() };
  } catch (e) { return { reports: [], measures: [], goldItems: 0, hashes: null, error: String(e.message || e).slice(0, 200) }; }
}

// Writes a measure report (eval/tierb-set.mjs, eval/links-measure.mjs, eval/news-set.mjs) where readGateInputs finds it.
export function writeMeasureReport(report, dir = path.join(here, 'reports')) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${report.run_at.slice(0, 10)}-${report.measure}.json`);
  fs.writeFileSync(f, JSON.stringify(report, null, 1) + '\n');
  return f;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--how')) { console.log(HOW.join('\n')); process.exit(0); }
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const inputs = readGateInputs();
  const g = gate({ config: read(path.join(P, 'config', 'publish.json')), models: read(path.join(P, 'config', 'models.json')), ...inputs });
  console.log(`production model ${g.model}; latest field report counted ${g.report || 'none'}; bar ${JSON.stringify(g.bar)}${g.error ? `; ERROR ${g.error}` : ''}`);
  for (const [f, x] of Object.entries(g.fields)) console.log(`  ${f}: switch ${x.on ? 'ON' : 'off'}, ${x.meets ? 'meets the bar' : 'below the bar'}${x.pass_rate != null ? ` (pass rate ${Math.round(x.pass_rate * 100)}%)` : ''}${x.note ? ` - ${x.note}` : ''}`);
  if (g.violations.length) { console.error(`switched on without a passing report: ${g.violations.join(', ')}`); process.exit(1); }
}
