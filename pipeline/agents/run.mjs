// Runs the Generator and Validator over a run folder that already has changeset.json and diff.json.
//   node agents/run.mjs                              the newest run with a diff.json
//   node agents/run.mjs data/runs/<run id>           a specific run
//   node agents/run.mjs --item congress_gov:119/s/2938   only one item
//   node agents/run.mjs --max-tokens 50000           lower the token budget for this run
// Writes results/<item>.json, results.json (the summary) and llm-usage.json into the run folder. Never touches published data.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from '../grabber/lib/env.mjs';
import { createHttp } from '../grabber/lib/http.mjs';
import { createLlmFromConfig, BudgetExceeded } from '../llm/gemini.mjs';
import { processItem } from './process-item.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');
const safe = (id) => id.replace(/[^A-Za-z0-9._-]+/g, '-');
const WORK = new Set(['material', 'new_entry_candidate']);

export async function runAgents({ runDir, entries, config, apiKey, fetchImpl, today, now = new Date(), only, log = () => {} }) {
  const changeset = JSON.parse(fs.readFileSync(path.join(runDir, 'changeset.json'), 'utf8'));
  const diffs = JSON.parse(fs.readFileSync(path.join(runDir, 'diff.json'), 'utf8')).items;
  const itemById = new Map(changeset.items.map((i) => [i.item_id, i]));
  const byKey = new Map(entries.map((e) => [e.key, e]));
  // A thinking model with a large output budget can take a minute or more, so the timeout is generous.
  const http = createHttp({ fetchImpl, headers: { 'x-goog-api-key': apiKey }, secrets: [apiKey], maxRequests: 400, timeoutMs: 180000, log });
  const { llm: generator, ledger } = createLlmFromConfig({ config, apiKey, http, role: 'generator', log });
  const { llm: validator } = createLlmFromConfig({ config, apiKey, http, role: 'validator', log });
  const todo = diffs.filter((d) => WORK.has(d.verdict) && (!only || d.item_id === only));
  fs.mkdirSync(path.join(runDir, 'results'), { recursive: true });

  const summary = { run_id: changeset.run_id, started_at: now.toISOString(), outcomes: {}, items: [], stopped_by_budget: false, stopped_by_service_errors: false };
  let consecutiveServiceErrors = 0;
  for (const d of todo) {
    const item = itemById.get(d.item_id);
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, item.raw_path), 'utf8'));
    let r;
    try {
      r = await processItem({ generator, validator, item, raw, diff: d, entry: d.entry_key ? byKey.get(d.entry_key) : null, entries, today, runId: changeset.run_id, now, log });
    } catch (e) {
      if (e instanceof BudgetExceeded) { summary.stopped_by_budget = true; summary.items.push({ item_id: d.item_id, outcome: 'not_processed', reason: e.message }); summary.outcomes.not_processed = (summary.outcomes.not_processed || 0) + 1; log(`stopped: ${e.message}`); break; }
      throw e;
    }
    r.tokens = ledger.itemTokens(d.item_id);
    // Circuit breaker: if the model service keeps failing, stop instead of spending minutes retrying every remaining item.
    consecutiveServiceErrors = r.service_error ? consecutiveServiceErrors + 1 : 0;
    if (consecutiveServiceErrors >= 3) { summary.stopped_by_service_errors = true; log('stopped: the model service failed 3 items in a row'); fs.writeFileSync(path.join(runDir, 'results', safe(d.item_id) + '.json'), JSON.stringify(r, null, 1) + '\n'); summary.items.push({ item_id: d.item_id, outcome: r.outcome, operation: r.operation, attempts: r.attempts, tokens: r.tokens, reason: r.reason }); summary.outcomes[r.outcome] = (summary.outcomes[r.outcome] || 0) + 1; break; }
    fs.writeFileSync(path.join(runDir, 'results', safe(d.item_id) + '.json'), JSON.stringify(r, null, 1) + '\n');
    summary.items.push({ item_id: d.item_id, outcome: r.outcome, operation: r.operation, attempts: r.attempts, tokens: r.tokens, reason: r.reason });
    summary.outcomes[r.outcome] = (summary.outcomes[r.outcome] || 0) + 1;
  }
  summary.llm = ledger.totals();
  summary.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(summary, null, 1) + '\n');
  fs.writeFileSync(path.join(runDir, 'llm-usage.json'), JSON.stringify(summary.llm, null, 1) + '\n');
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };
  loadEnv(pipelineDir);
  const key = process.env.GEMINI_API_KEY;
  if (!key) { console.error('GEMINI_API_KEY is not set'); process.exit(2); }
  const runsDir = path.join(pipelineDir, 'data', 'runs');
  const positional = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const runDir = positional ? path.resolve(positional) : path.join(runsDir, fs.readdirSync(runsDir).filter((r) => fs.existsSync(path.join(runsDir, r, 'diff.json'))).sort().pop());
  const config = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'models.json'), 'utf8'));
  if (opt('max-tokens')) config.limits.max_tokens_per_run = Number(opt('max-tokens'));
  // Try other models for one run without editing config/models.json.
  if (opt('generator-model')) config.roles.generator.model = opt('generator-model');
  if (opt('validator-model')) config.roles.validator.model = opt('validator-model');
  if (opt('thinking-level')) { config.roles.generator.thinking_level = opt('thinking-level'); config.roles.validator.thinking_level = opt('thinking-level'); }
  if (opt('max-output-tokens')) { config.roles.generator.max_output_tokens = Number(opt('max-output-tokens')); config.roles.validator.max_output_tokens = Number(opt('max-output-tokens')); }
  const entries = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'out', 'entries.v2.json'), 'utf8'));
  console.log(`agents on ${path.basename(runDir)}${opt('item') ? ' (only ' + opt('item') + ')' : ''}; models: generator ${config.roles.generator.model}, validator ${config.roles.validator.model}; budget ${config.limits.max_tokens_per_run} tokens`);
  const s = await runAgents({ runDir, entries, config, apiKey: key, today: new Date().toISOString().slice(0, 10), only: opt('item'), log: (m) => console.log('  ' + m) });
  console.log(`\noutcomes: ${JSON.stringify(s.outcomes)}`);
  s.items.forEach((i) => console.log(`  ${i.outcome.padEnd(13)} ${i.item_id} (${i.attempts ?? '-'} round(s), ${i.tokens ?? 0} tokens)${i.reason ? '\n      ' + i.reason : ''}`));
  console.log(`LLM: ${s.llm.calls} call(s), ${s.llm.input_tokens} in / ${s.llm.output_tokens} out tokens${s.llm.estimated_cost_usd != null ? ', est. $' + s.llm.estimated_cost_usd : ' (no prices configured, so no dollar estimate)'}`);
}
