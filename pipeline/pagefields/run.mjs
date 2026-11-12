// Writes the entry page fields (display_name, summary_line, thirty_seconds, key_facts) for existing entries, as drafts:
//   node pagefields/run.mjs --only <key,key> | --all   [--out <file>]
// Writer: the generator role (Sonnet). Reviewer: bill_reviewer (Opus, a stronger model). Each entry goes through
// pagefields/write.mjs; results go to out/pagefields/<date>.json with what was kept, what was dropped and why, and the cost.
// Nothing is applied to the site data here: pagefields/apply.mjs does that after the drafts are reviewed.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writePageFields } from './write.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), pipelineDir = path.resolve(here, '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
// Entries with no page: excluded bills (section J) keep their "why it is out" card.
export const eligible = (e) => e.section !== 'J';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadEnv } = await import('../grabber/lib/env.mjs');
  const { createLlmFactory } = await import('../llm/make.mjs');
  loadEnv(pipelineDir);
  const models = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'models.json'), 'utf8'));
  const factory = createLlmFactory({ models, log: (m) => console.log('  ' + m) });
  if (!factory.hasKey) { console.error(`no ${factory.keyName}`); process.exit(2); }
  const entries = JSON.parse(fs.readFileSync(path.join(pipelineDir, '..', 'web', 'data', 'v2', 'entries.json'), 'utf8')).filter(eligible);
  const only = arg('--only') ? arg('--only').split(',') : null;
  const todo = only ? entries.filter((e) => only.includes(e.key)) : process.argv.includes('--all') ? entries : [];
  if (!todo.length) { console.error('nothing to do: pass --only <keys> or --all'); process.exit(2); }
  const writer = factory.make('generator'), reviewer = factory.make('bill_reviewer');
  const before = factory.spend.monthTotal();
  const out = arg('--out') || path.join(pipelineDir, 'out', 'pagefields', new Date().toISOString().slice(0, 10) + '.json');
  const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { results: {} };
  for (const e of todo) {
    try {
      const r = await writePageFields({ entry: e, writer, reviewer, log: (m) => console.log('  ' + m) });
      prev.results[e.key] = { ...r, at: new Date().toISOString() };
      console.log(`${e.key}: kept ${Object.keys(r.fields).join(', ') || 'nothing'}${Object.keys(r.dropped).length ? '; dropped ' + Object.keys(r.dropped).join(', ') : ''}`);
    } catch (err) {
      prev.results[e.key] = { key: e.key, error: String(err && err.message || err).slice(0, 300), at: new Date().toISOString() };
      console.log(`${e.key}: ERROR ${String(err && err.message || err).slice(0, 200)}`);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(prev, null, 2));
  }
  const cost = factory.spend.monthTotal() - before;
  console.log(`\n${todo.length} entr${todo.length === 1 ? 'y' : 'ies'}; cost $${cost.toFixed(3)}; drafts in ${out}`);
}
