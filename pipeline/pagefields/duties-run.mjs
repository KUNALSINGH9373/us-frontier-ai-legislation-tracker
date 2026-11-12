// The 13 duty answers for existing bills that have none yet, from their stored official text (data/eval/texts, URL in
// eval/sources.json), through the same writer and independent reader a new bill gets (agents/duties.mjs: every answer proved by
// code and by the reader, or the whole set is left off). Drafts only:
//   node pagefields/duties-run.mjs --only <key,key> | --all   [--out <file>]
// --all: every bill-layout entry outside section C (IVO and auditor measures have no duties) with a stored text and no duties.
// pagefields/apply.mjs writes the kept sets into the site data.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeDuties } from '../agents/duties.mjs';
import { kindOf } from './layout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), pipelineDir = path.resolve(here, '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const TEXTS = path.join(pipelineDir, 'data', 'eval', 'texts');
const manifest = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'eval', 'sources.json'), 'utf8')).items;

export const wantsDuties = (e) => kindOf(e) === 'bill' && e.section !== 'C' && e.section !== 'J' && !e.duties && fs.existsSync(path.join(TEXTS, e.key + '.txt')) && !!(manifest[e.key] && manifest[e.key].url);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadEnv } = await import('../grabber/lib/env.mjs');
  const { createLlmFactory } = await import('../llm/make.mjs');
  loadEnv(pipelineDir);
  const models = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'models.json'), 'utf8'));
  const factory = createLlmFactory({ models, log: (m) => console.log('  ' + m) });
  if (!factory.hasKey) { console.error(`no ${factory.keyName}`); process.exit(2); }
  const entries = JSON.parse(fs.readFileSync(path.join(pipelineDir, '..', 'web', 'data', 'v2', 'entries.json'), 'utf8'));
  const only = arg('--only') ? arg('--only').split(',') : null;
  const todo = entries.filter(wantsDuties).filter((e) => (only ? only.includes(e.key) : process.argv.includes('--all')));
  if (!todo.length) { console.error('nothing to do: pass --only <keys> or --all (bills with a stored text and no duties)'); process.exit(2); }
  const generator = factory.make('generator'), validator = factory.make('validator');
  const before = factory.spend.monthTotal();
  const out = arg('--out') || path.join(pipelineDir, 'out', 'pagefields', 'duties-' + new Date().toISOString().slice(0, 10) + '.json');
  const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { results: {} };
  for (const e of todo) {
    const text = fs.readFileSync(path.join(TEXTS, e.key + '.txt'), 'utf8'), url = manifest[e.key].url;
    try {
      const d = await writeDuties({ generator, validator, entry: e, sourceText: text, sourceUrl: url, itemId: 'duties:' + e.key, log: (m) => console.log('  ' + m) });
      prev.results[e.key] = { key: e.key, duties: d.duties, duties_basis: d.duties_basis || null, reason: d.reason, dropped: d.dropped, at: new Date().toISOString() };
      console.log(`${e.key}: ${d.duties ? 'duties kept' : 'left off: ' + d.reason}`);
    } catch (err) {
      prev.results[e.key] = { key: e.key, error: String(err && err.message || err).slice(0, 300) };
      console.log(`${e.key}: ERROR ${String(err && err.message || err).slice(0, 200)}`);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(prev, null, 2));
  }
  console.log(`\n${todo.length} bill(s); cost $${(factory.spend.monthTotal() - before).toFixed(3)}; drafts in ${out}`);
}
