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
import { createLlmFactory } from '../llm/make.mjs';
import { processItem } from './process-item.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');
const safe = (id) => id.replace(/[^A-Za-z0-9._-]+/g, '-');
const WORK = new Set(['material', 'new_entry_candidate']);

// factory (llm/make.mjs) is how production runs get their AI clients (provider from config/models.json, spend saved, monthly cap);
// config + apiKey + fetchImpl is the older direct Gemini path the tests use.
// maxItems caps how many items one run sends to the AI (material changes first, then new-bill candidates); the rest wait for the next run.
export async function runAgents({ runDir, entries, config, apiKey, fetchImpl, factory, today, now = new Date(), only, maxItems, log = () => {} }) {
  const changeset = JSON.parse(fs.readFileSync(path.join(runDir, 'changeset.json'), 'utf8'));
  const diffs = JSON.parse(fs.readFileSync(path.join(runDir, 'diff.json'), 'utf8')).items;
  const itemById = new Map(changeset.items.map((i) => [i.item_id, i]));
  const byKey = new Map(entries.map((e) => [e.key, e]));
  // A thinking model with a large output budget can take a minute or more, so the timeout is generous.
  let generator, validator, referee = null, ledger;
  if (factory) {
    generator = factory.make('generator'); validator = factory.make('validator'); ledger = factory.ledger;
    // The scope referee (a stronger model, asked only on disputed scope calls). A provider with no "referee" role runs without one.
    try { referee = factory.make('referee'); } catch { referee = null; }
    if (!generator) throw new Error(`${factory.keyName} is not set`);
  } else {
    const http = createHttp({ fetchImpl, headers: { 'x-goog-api-key': apiKey }, secrets: [apiKey], maxRequests: 400, timeoutMs: 180000, log });
    ({ llm: generator, ledger } = createLlmFromConfig({ config, apiKey, http, role: 'generator', log }));
    ({ llm: validator } = createLlmFromConfig({ config, apiKey, http, role: 'validator', log }));
  }
  const all = diffs.filter((d) => WORK.has(d.verdict) && (!only || d.item_id === only)).sort((a, b) => (a.verdict === 'material' ? 0 : 1) - (b.verdict === 'material' ? 0 : 1));
  const todo = maxItems ? all.slice(0, maxItems) : all;
  fs.mkdirSync(path.join(runDir, 'results'), { recursive: true });

  const summary = { run_id: changeset.run_id, started_at: now.toISOString(), outcomes: {}, items: [], eligible_items: all.length, deferred_items: all.length - todo.length, stopped_by_budget: false, stopped_by_service_errors: false };
  let consecutiveServiceErrors = 0;
  for (const d of todo) {
    const item = itemById.get(d.item_id);
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, item.raw_path), 'utf8'));
    let r;
    try {
      r = await processItem({ generator, validator, referee, item, raw, diff: d, entry: d.entry_key ? byKey.get(d.entry_key) : null, entries, today, runId: changeset.run_id, now, log });
    } catch (e) {
      if (e instanceof BudgetExceeded) { summary.stopped_by_budget = true; if (e.scope === 'month') summary.stopped_by_month_cap = true; summary.items.push({ item_id: d.item_id, outcome: 'not_processed', reason: e.message }); summary.outcomes.not_processed = (summary.outcomes.not_processed || 0) + 1; log(`stopped: ${e.message}`); break; }
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
  const runsDir = path.join(pipelineDir, 'data', 'runs');
  const positional = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const runDir = positional ? path.resolve(positional) : path.join(runsDir, fs.readdirSync(runsDir).filter((r) => fs.existsSync(path.join(runsDir, r, 'diff.json'))).sort().pop());
  const config = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'models.json'), 'utf8'));
  if (opt('provider')) config.provider = opt('provider');
  if (opt('max-tokens')) config.limits.max_tokens_per_run = Number(opt('max-tokens'));
  // Try other models for one run without editing config/models.json (applies to the provider in use).
  const roles = config.provider === 'anthropic' ? config.anthropic.roles : config.roles;
  if (opt('generator-model')) roles.generator.model = opt('generator-model');
  if (opt('validator-model')) roles.validator.model = opt('validator-model');
  if (opt('thinking-level') && config.provider !== 'anthropic') { roles.generator.thinking_level = opt('thinking-level'); roles.validator.thinking_level = opt('thinking-level'); }
  if (opt('max-output-tokens')) { roles.generator.max_output_tokens = Number(opt('max-output-tokens')); roles.validator.max_output_tokens = Number(opt('max-output-tokens')); }
  const factory = createLlmFactory({ models: config, log: (m) => console.log('  ' + m) });
  if (!factory.hasKey) { console.error(`${factory.keyName} is not set`); process.exit(2); }
  // The entries as the site has them now (the publisher's data), so what the agents compare against is current.
  const entries = JSON.parse(fs.readFileSync(path.join(pipelineDir, '..', 'web', 'data', 'v2', 'entries.json'), 'utf8'));
  console.log(`agents on ${path.basename(runDir)}${opt('item') ? ' (only ' + opt('item') + ')' : ''}; ${config.provider}: generator ${roles.generator.model}, validator ${roles.validator.model}; budget ${config.limits.max_tokens_per_run} tokens; month so far $${factory.monthStatus().spent} of $${config.monthly_cost_cap_usd}`);
  const s = await runAgents({ runDir, entries, config, factory, today: new Date().toISOString().slice(0, 10), only: opt('item'), log: (m) => console.log('  ' + m) });
  console.log(`\noutcomes: ${JSON.stringify(s.outcomes)}`);
  s.items.forEach((i) => console.log(`  ${i.outcome.padEnd(13)} ${i.item_id} (${i.attempts ?? '-'} round(s), ${i.tokens ?? 0} tokens)${i.reason ? '\n      ' + i.reason : ''}`));
  console.log(`LLM: ${s.llm.calls} call(s), ${s.llm.input_tokens} in / ${s.llm.output_tokens} out tokens${s.llm.estimated_cost_usd != null ? ', est. $' + s.llm.estimated_cost_usd : ' (no prices configured, so no dollar estimate)'}`);
}
