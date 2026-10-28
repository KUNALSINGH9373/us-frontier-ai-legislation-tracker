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
import { escalationBudget } from './budget.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');
const safe = (id) => id.replace(/[^A-Za-z0-9._-]+/g, '-');
const WORK = new Set(['material', 'new_entry_candidate']);

// ---------- items not read again until their record changes ----------
// An item the AI step held for good (escalate: a duplicate, no section, a scope or section not proved, duties that cannot be proved) is
// remembered by its record's hash in state/agent-memo.json (update.mjs keeps it with the promoted state). While the record is unchanged
// it is not read again (no tokens), and its proposal is reported only the first time. A dead state bill (LegiScan status vetoed or
// failed) is not read again while it stays dead, even if LegiScan touches its record. A model-service failure is never remembered.
export const MEMO_FILE = 'agent-memo.json';
const deadBill = (item, raw) => item.source === 'legiscan' && raw && raw.bill && [5, 6].includes(Number(raw.bill.status));
export function memoSkip(memo, item, raw, { newEntriesOn = true } = {}) {
  const m = memo && memo.items && memo.items[item.item_id];
  if (!m) return null;
  // a draft held only because new entries were off is read again once they are on (record unchanged or not)
  if (m.unconfirmed && newEntriesOn !== false) return null;
  if (m.raw_hash && item.raw_hash && m.raw_hash === item.raw_hash) return `its record is unchanged since it was held on ${m.date} (${String(m.reason || '').slice(0, 120)})`;
  if (m.dead && deadBill(item, raw)) return `a dead bill (held on ${m.date}); it is not read again while it stays dead`;
  return null;
}
export function memoRecord(memo, item, raw, r, today) {
  memo.items = memo.items || {};
  if (r.outcome === 'held' && r.escalate && !r.service_error) { const first = !memo.items[item.item_id]; memo.items[item.item_id] = { raw_hash: item.raw_hash || null, reason: String(r.reason || '').slice(0, 300), proposal: r.proposal || null, date: today, dead: deadBill(item, raw), ...(r.unconfirmed ? { unconfirmed: true } : {}) }; return first; }
  delete memo.items[item.item_id];
  return false;
}
const CODE_ONLY = new Set(['cosponsors_change']);

// factory (llm/make.mjs) is how production runs get their AI clients (provider from config/models.json, spend saved, monthly cap);
// config + apiKey + fetchImpl is the older direct Gemini path the tests use.
// maxItems caps how many items one run sends to the AI (material changes first, then new-bill candidates); the rest wait for the next run.
export async function runAgents({ runDir, entries, config, apiKey, fetchImpl, factory, today, now = new Date(), only, maxItems, memoFile = null, newEntriesOn = true, log = () => {} }) {
  const memo = memoFile && fs.existsSync(memoFile) ? (() => { try { return JSON.parse(fs.readFileSync(memoFile, 'utf8')); } catch { return { items: {} }; } })() : { items: {} };
  const changeset = JSON.parse(fs.readFileSync(path.join(runDir, 'changeset.json'), 'utf8'));
  const diffs = JSON.parse(fs.readFileSync(path.join(runDir, 'diff.json'), 'utf8')).items;
  const itemById = new Map(changeset.items.map((i) => [i.item_id, i]));
  const byKey = new Map(entries.map((e) => [e.key, e]));
  // A thinking model with a large output budget can take a minute or more, so the timeout is generous.
  let generator, validator, referee = null, ledger, escalation = null;
  if (factory) {
    generator = factory.make('generator'); validator = factory.make('validator'); ledger = factory.ledger;
    // The scope referee (a stronger model, asked only on disputed scope calls). A provider with no "referee" role runs without one.
    try { referee = factory.make('referee'); } catch { referee = null; }
    if (!generator) throw new Error(`${factory.keyName} is not set`);
    // The escalated pass (config/models.json "escalation"): an item held for its token budget or for running out of rounds is tried once
    // more, written by the stronger model of escalation.generator_role, within escalation.max_tokens_per_item (and the monthly cap).
    const esc = config && config.escalation;
    if (esc && esc.max_tokens_per_item) {
      let g = null; try { g = factory.make(esc.generator_role || 'referee'); } catch { g = null; }
      const perItem = (config.limits && config.limits.max_tokens_per_item) || 60000;
      if (g && newEntriesOn !== false) escalation = { generator: g, validator, budget: escalationBudget({ ledger, perItem, total: esc.max_tokens_per_item }) };
    }
  } else {
    const http = createHttp({ fetchImpl, headers: { 'x-goog-api-key': apiKey }, secrets: [apiKey], maxRequests: 400, timeoutMs: 180000, log });
    ({ llm: generator, ledger } = createLlmFromConfig({ config, apiKey, http, role: 'generator', log }));
    ({ llm: validator } = createLlmFromConfig({ config, apiKey, http, role: 'validator', log }));
  }
  // A material item whose only reasons are record facts code writes itself (a cosponsor total) needs no reading by the AI.
  const codeOnly = (d) => d.verdict === 'material' && d.reasons.length && d.reasons.every((r) => CODE_ONLY.has(r.kind));
  const all = diffs.filter((d) => WORK.has(d.verdict) && !codeOnly(d) && (!only || d.item_id === only)).sort((a, b) => (a.verdict === 'material' ? 0 : 1) - (b.verdict === 'material' ? 0 : 1));
  const todo = maxItems ? all.slice(0, maxItems) : all;
  fs.mkdirSync(path.join(runDir, 'results'), { recursive: true });

  const summary = { run_id: changeset.run_id, started_at: now.toISOString(), outcomes: {}, items: [], eligible_items: all.length, deferred_items: all.length - todo.length, stopped_by_budget: false, stopped_by_service_errors: false, proposals: [], not_reread: 0 };
  let consecutiveServiceErrors = 0;
  for (const d of todo) {
    const item = itemById.get(d.item_id);
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, item.raw_path), 'utf8'));
    const memoWhy = d.verdict === 'new_entry_candidate' ? memoSkip(memo, item, raw, { newEntriesOn }) : null;
    if (memoWhy) {
      const r0 = { item_id: d.item_id, outcome: 'held', operation: 'create', attempts: 0, entry: null, patch: null, verdicts: [], reason: `not read again: ${memoWhy}`, escalate: true, not_reread: true, tokens: 0 };
      fs.writeFileSync(path.join(runDir, 'results', safe(d.item_id) + '.json'), JSON.stringify(r0, null, 1) + '\n');
      summary.items.push({ item_id: d.item_id, outcome: 'held', operation: 'create', attempts: 0, tokens: 0, reason: r0.reason, escalate: true, not_reread: true });
      summary.outcomes.held = (summary.outcomes.held || 0) + 1; summary.not_reread++;
      continue;
    }
    let r;
    try {
      r = await processItem({ generator, validator, referee, escalation, item, raw, diff: d, entry: d.entry_key ? byKey.get(d.entry_key) : null, entries, today, runId: changeset.run_id, now, newEntriesOn, log });
    } catch (e) {
      if (e instanceof BudgetExceeded) { summary.stopped_by_budget = true; if (e.scope === 'month') summary.stopped_by_month_cap = true; summary.items.push({ item_id: d.item_id, outcome: 'not_processed', reason: e.message }); summary.outcomes.not_processed = (summary.outcomes.not_processed || 0) + 1; log(`stopped: ${e.message}`); break; }
      throw e;
    }
    r.tokens = ledger.itemTokens(d.item_id) + (escalation ? escalation.budget.spent(d.item_id) : 0);
    // Circuit breaker: if the model service keeps failing, stop instead of spending minutes retrying every remaining item.
    consecutiveServiceErrors = r.service_error && !r.fetch_error ? consecutiveServiceErrors + 1 : 0; // a record fetch failure is not the model service
    if (consecutiveServiceErrors >= 3) { summary.stopped_by_service_errors = true; log('stopped: the model service failed 3 items in a row'); fs.writeFileSync(path.join(runDir, 'results', safe(d.item_id) + '.json'), JSON.stringify(r, null, 1) + '\n'); summary.items.push({ item_id: d.item_id, outcome: r.outcome, operation: r.operation, attempts: r.attempts, tokens: r.tokens, reason: r.reason }); summary.outcomes[r.outcome] = (summary.outcomes[r.outcome] || 0) + 1; break; }
    fs.writeFileSync(path.join(runDir, 'results', safe(d.item_id) + '.json'), JSON.stringify(r, null, 1) + '\n');
    summary.items.push({ item_id: d.item_id, outcome: r.outcome, operation: r.operation, attempts: r.attempts, tokens: r.tokens, reason: r.reason, ...(r.escalate ? { escalate: true } : {}), ...(r.escalated ? { escalated: true } : {}) });
    summary.outcomes[r.outcome] = (summary.outcomes[r.outcome] || 0) + 1;
    if (d.verdict === 'new_entry_candidate' && memoRecord(memo, item, raw, r, today) && r.proposal) summary.proposals.push(r.proposal);
  }
  if (memoFile) { fs.mkdirSync(path.dirname(memoFile), { recursive: true }); fs.writeFileSync(memoFile, JSON.stringify(memo, null, 1) + '\n'); }
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
