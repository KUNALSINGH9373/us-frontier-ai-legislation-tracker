// The gate: which AI-written output may publish on its own. Each switch in config/publish.json (auto_publish) may be on only when the latest
// report of ITS OWN measure meets the bar, and that report was made by the code as it is now (checks_hash, eval/hash.mjs):
//   mechanism, thresholds, penalties   the field eval (eval/run.mjs) over the whole test set for the production model: eval_bar
//   new_entries                        every reading field above AND the Tier B replay set (eval/tierb-set.mjs) at zero wrong
//   relationships                      the links backtest on the real network AND the links synthetic suite (eval/links-measure.mjs), zero wrong
//   news                               the recorded leads set (eval/news-set.mjs) at zero wrong
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
  'node eval/news-set.mjs                                                   # recorded news leads set (code only, scripted recorded answers)',
  'node eval/gate.mjs'
];

// The latest report of a non-field measure (kind tierb | links | news) that was made by the current code.
const latestOf = (measures, kind) => (measures || []).filter((r) => r && r.measure === kind).sort((a, b) => String(a.run_at).localeCompare(String(b.run_at))).pop() || null;

export function gate({ config, models, reports = [], goldItems, measures = [], hashes = null, error = null }) {
  const bar = config.eval_bar || { pass_rate: 1, unsupported_fields: 0, scope_agreement: 1 };
  const prod = models && (models.provider === 'anthropic' ? models.anthropic.roles.generator.model : models.roles.generator.model);
  const auto = config.auto_publish || {};
  if (error) {
    const fields = Object.fromEntries(Object.keys(auto).filter((f) => !f.startsWith('_')).map((f) => [f, { on: !!auto[f], meets: false, note: `the gate inputs could not be read (${error}); every switch is off this run` }]));
    return { model: prod, report: null, bar, fields, violations: Object.entries(fields).filter(([, x]) => x.on).map(([f]) => f), error };
  }
  const hashOk = (r, m) => !hashes || (r && r.checks_hash && r.checks_hash === hashes[m]);
  // Only a run over the whole test set counts (a run limited with --only or --limit proves nothing about the rest), for the production
  // model, made by the current prompts and checks.
  const latest = reports.filter((r) => r.generator === prod && (!goldItems || (r.summary && r.summary.items === goldItems)) && hashOk(r, 'fields')).sort((a, b) => a.run_at.localeCompare(b.run_at)).pop() || null;
  const fieldOf = (f) => {
    const s = latest && latest.summary.fields[f];
    const meets = !!s && s.pass_rate >= bar.pass_rate && s.unsupported_fields <= bar.unsupported_fields && latest.summary.scope_agreement >= bar.scope_agreement;
    return { on: !!auto[f], meets, pass_rate: s ? s.pass_rate : null };
  };
  const fields = Object.fromEntries(Object.keys(auto).filter((f) => !f.startsWith('_') && !(f in MEASURED)).map((f) => [f, fieldOf(f)]));
  const fieldsMeet = FIELD_SWITCHES.every((f) => (fields[f] || fieldOf(f)).meets);
  const measured = (kind, m) => { const r = latestOf(measures, kind); return r && hashOk(r, m) ? r : null; };
  const zero = (r) => !!r && Number(r.cases) > 0 && r.wrong === 0 && (!('errors' in r) || r.errors === 0);
  // new_entries: the reading fields AND the Tier B replay set. Relationships are their own measure, never part of this.
  if ('new_entries' in auto) {
    const t = measured('tierb', 'new_entries');
    fields.new_entries = { on: !!auto.new_entries, meets: fieldsMeet && zero(t), report: t ? t.run_at : null, note: !fieldsMeet ? 'every reading field must meet the bar on the field eval' : !t ? 'no Tier B replay report made by the current code (eval/tierb-set.mjs)' : zero(t) ? null : `the Tier B replay set has ${t.wrong} wrong of ${t.cases}` };
  }
  if ('relationships' in auto) {
    const l = measured('links', 'relationships');
    fields.relationships = { on: !!auto.relationships, meets: zero(l), report: l ? l.run_at : null, note: !l ? 'no links report made by the current code (eval/links-measure.mjs)' : zero(l) ? null : `links: ${l.wrong} wrong (backtest ${l.backtest_errors}, synthetic suite ${l.suite_failed} failed)` };
  }
  if ('news' in auto) {
    const n = measured('news', 'news');
    fields.news = { on: !!auto.news, meets: zero(n), report: n ? n.run_at : null, note: !n ? 'no news-set report made by the current code (eval/news-set.mjs)' : zero(n) ? null : `the news set has ${n.wrong} wrong of ${n.cases}` };
  }
  const violations = Object.entries(fields).filter(([, x]) => x.on && !x.meets).map(([f]) => f);
  return { model: prod, report: latest ? latest.run_at : null, bar, fields, violations };
}

// The gate at run time (update.mjs): every auto_publish switch whose measure does not meet the bar is treated as OFF for the run, whatever
// config/publish.json says. Returns { config: a copy with the switches the run may use, gate, off: [{ field, why }] }. Never throws.
export function gatedPublishConfig({ config, models, reports, goldItems, measures, hashes, error }) {
  let g;
  try { g = gate({ config, models, reports, goldItems, measures, hashes, error }); }
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
    return { reports: all.filter((r) => !r.measure || r.measure === 'fields'), measures: all.filter((r) => r.measure && r.measure !== 'fields'), goldItems: gold.items.length, hashes: currentHashes() };
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
