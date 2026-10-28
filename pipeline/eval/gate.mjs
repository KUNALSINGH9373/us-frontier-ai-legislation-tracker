// The gate: which AI-written fields may publish on their own. A field's switch in config/publish.json (auto_publish)
// may be on only when the latest test-set report for the configured production model meets eval_bar.
//   node eval/gate.mjs            prints the verdict per field; exit 1 if a switch is on without a passing report
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');

// Switches that are not bill reading fields: new_entries follows them all; news items (news/run.mjs) are not measured by the bill test set.
const NOT_FIELDS = ['new_entries', 'news'];

export function gate({ config, models, reports, goldItems }) {
  const bar = config.eval_bar || { pass_rate: 1, unsupported_fields: 0, scope_agreement: 1 };
  const prod = models.provider === 'anthropic' ? models.anthropic.roles.generator.model : models.roles.generator.model;
  // Only a run over the whole test set counts: a run limited with --only or --limit proves nothing about the rest.
  const latest = reports.filter((r) => r.generator === prod && (!goldItems || r.summary.items === goldItems)).sort((a, b) => a.run_at.localeCompare(b.run_at)).pop() || null;
  const fields = Object.fromEntries(Object.keys(config.auto_publish).filter((f) => !NOT_FIELDS.includes(f)).map((f) => {
    const s = latest && latest.summary.fields[f];
    const meets = !!s && s.pass_rate >= bar.pass_rate && s.unsupported_fields <= bar.unsupported_fields && latest.summary.scope_agreement >= bar.scope_agreement;
    return [f, { on: !!config.auto_publish[f], meets, pass_rate: s ? s.pass_rate : null }];
  }));
  const allMeet = Object.values(fields).every((x) => x.meets);
  fields.new_entries = { on: !!config.auto_publish.new_entries, meets: allMeet };
  if ('news' in config.auto_publish) fields.news = { on: !!config.auto_publish.news, meets: null, note: 'not measured by the bill test set: each item needs every quote and number in its official release (code) and every claim confirmed by a second reader' };
  const violations = Object.entries(fields).filter(([, x]) => x.on && x.meets === false).map(([f]) => f);
  return { model: prod, report: latest ? latest.run_at : null, bar, fields, violations };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const dir = path.join(here, 'reports');
  const reports = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => read(path.join(dir, f))) : [];
  const g = gate({ config: read(path.join(P, 'config', 'publish.json')), models: read(path.join(P, 'config', 'models.json')), reports, goldItems: read(path.join(here, 'gold.json')).items.length });
  console.log(`production model ${g.model}; latest report ${g.report || 'none'}; bar ${JSON.stringify(g.bar)}`);
  for (const [f, x] of Object.entries(g.fields)) console.log(`  ${f}: switch ${x.on ? 'ON' : 'off'}, ${x.meets === null ? x.note : x.meets ? 'meets the bar' : 'below the bar'}${x.pass_rate != null ? ` (pass rate ${Math.round(x.pass_rate * 100)}%)` : ''}`);
  if (g.violations.length) { console.error(`switched on without a passing report: ${g.violations.join(', ')}`); process.exit(1); }
}
