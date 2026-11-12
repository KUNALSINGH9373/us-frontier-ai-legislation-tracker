// "What it orders" checklists (pagefields/exec.mjs) for the executive actions and export rules with a fetched official text
// (pagefields/fetch-exec-texts.mjs), as drafts:
//   node pagefields/exec-run.mjs [--only <key,key>] [--out <file>]
// Writer: generator (Sonnet); independent reader: validator (Haiku), as for the 13 duties. pagefields/apply.mjs writes kept checklists.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeExecChecklist } from './exec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), pipelineDir = path.resolve(here, '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadEnv } = await import('../grabber/lib/env.mjs');
  const { createLlmFactory } = await import('../llm/make.mjs');
  loadEnv(pipelineDir);
  const models = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'models.json'), 'utf8'));
  const factory = createLlmFactory({ models, log: (m) => console.log('  ' + m) });
  if (!factory.hasKey) { console.error(`no ${factory.keyName}`); process.exit(2); }
  const urls = JSON.parse(fs.readFileSync(path.join(here, 'exec-sources.json'), 'utf8'));
  const only = arg('--only') ? arg('--only').split(',') : null;
  const todo = JSON.parse(fs.readFileSync(path.join(pipelineDir, '..', 'web', 'data', 'v2', 'entries.json'), 'utf8')).filter((e) => urls[e.key] && (!only || only.includes(e.key)));
  const generator = factory.make('generator'), validator = factory.make('validator'), before = factory.spend.monthTotal();
  const out = arg('--out') || path.join(pipelineDir, 'out', 'pagefields', 'exec-' + new Date().toISOString().slice(0, 10) + '.json');
  const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { results: {} };
  for (const e of todo) {
    const text = fs.readFileSync(path.join(pipelineDir, 'data', 'exec-texts', e.key + '.txt'), 'utf8');
    try { const r = await writeExecChecklist({ generator, validator, entry: e, sourceText: text, sourceUrl: urls[e.key], log: (m) => console.log('  ' + m) }); prev.results[e.key] = { ...r, at: new Date().toISOString() }; console.log(`${e.key}: ${r.exec_checklist ? 'checklist kept' : r.reason}`); }
    catch (err) { prev.results[e.key] = { key: e.key, error: String(err && err.message || err).slice(0, 300) }; console.log(`${e.key}: ERROR ${String(err && err.message || err).slice(0, 200)}`); }
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(prev, null, 2));
  }
  console.log(`\n${todo.length} action(s); cost $${(factory.spend.monthTotal() - before).toFixed(3)}; drafts in ${out}`);
}
