// Tests for per-call pricing, the monthly cap, the saved spend log and the shared factory. No network, no key.
//   node llm/test-spend.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLedger, BudgetExceeded } from './index.mjs';
import { createSpend, summarize, monthOf } from './spend.mjs';
import { createLlmFactory } from './make.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
const PRICES = { 'claude-haiku-5-5': { input: 0.1, output: 0.5, long_prompt_tokens: 100000, long_input: 0.5, long_output: 2.5 }, 'claude-sonnet-5-5': { input: 2, output: 10 } };
const use = (i, o) => ({ promptTokenCount: i, candidatesTokenCount: o });

{
  const l = createLedger({ prices: PRICES });
  l.record({ role: 'screener', model: 'claude-haiku-5-5', usage: use(100000, 1000000) });
  ok('a prompt of exactly 100K tokens is billed at the normal Haiku rate', Math.abs(l.totals().estimated_cost_usd - (0.1 * 0.1 + 1 * 0.5)) < 1e-9, String(l.totals().estimated_cost_usd));
  const l2 = createLedger({ prices: PRICES });
  l2.record({ role: 'screener', model: 'claude-haiku-5-5', usage: use(100001, 1000000) });
  ok('a longer prompt is billed at the long rate for the whole call (input and output)', Math.abs(l2.totals().estimated_cost_usd - (100001 / 1e6 * 0.5 + 1 * 2.5)) < 1e-5, String(l2.totals().estimated_cost_usd));
  const l3 = createLedger({ prices: PRICES });
  l3.record({ role: 'generator', model: 'claude-sonnet-5-5', usage: use(1000000, 100000) });
  ok('Sonnet is flat: $2 in, $10 out per million', Math.abs(l3.totals().estimated_cost_usd - 3) < 1e-9);
  l3.record({ role: 'generator', model: 'unknown-model', usage: use(10, 10) });
  ok('one call from an unpriced model makes the whole cost unknown, never a low guess', l3.totals().estimated_cost_usd === null);
  const per = createLedger({ prices: PRICES });
  per.record({ role: 'screener', model: 'claude-haiku-5-5', usage: use(1000, 1000) }); per.record({ role: 'generator', model: 'claude-sonnet-5-5', usage: use(1000, 1000) });
  ok('cost is tracked per role', Math.abs(per.totals().by_role.screener.cost - 0.0006) < 1e-9 && Math.abs(per.totals().by_role.generator.cost - 0.012) < 1e-9);
}
{
  const calls = [];
  const l = createLedger({ prices: PRICES, onCall: (c) => calls.push(c) });
  l.record({ role: 'validator', model: 'claude-sonnet-5-5', itemId: 'it-1', usage: use(500, 100) });
  ok('every call is reported to the spend hook with its cost', calls.length === 1 && calls[0].itemId === 'it-1' && calls[0].input === 500 && calls[0].output === 100 && calls[0].cost > 0);
}
{
  const l = createLedger({ prices: PRICES, monthly: { capUsd: 1, spentBefore: 0.9 } });
  l.assertWithin('x'); // 0.90 of 1.00: allowed
  l.record({ role: 'generator', model: 'claude-sonnet-5-5', usage: use(40000, 2000) }); // $0.10
  const err = (() => { try { l.assertWithin('x'); return null; } catch (e) { return e; } })();
  ok('the next call is refused once the month (before + this run) reaches the cap', err instanceof BudgetExceeded && err.scope === 'month' && /monthly AI cost cap of \$1/.test(err.message), err && err.message);
  ok('no cap set means no refusal', (() => { const n = createLedger({ prices: PRICES, monthly: null }); n.record({ role: 'g', model: 'claude-sonnet-5-5', usage: use(9e6, 9e6) }); try { n.assertWithin(); return true; } catch { return false; } })());
}
{
  const dir = tmp(), t0 = new Date('2026-10-27T10:00:00Z');
  let clock = t0; const sp = createSpend({ dir, now: () => clock });
  sp.append({ role: 'screener', model: 'claude-haiku-5-5', input: 1000, output: 100, cost: 0.00015 });
  clock = new Date('2026-10-27T10:05:00Z');
  sp.append({ role: 'generator', model: 'claude-sonnet-5-5', input: 20000, output: 3000, cost: 0.07 });
  sp.append({ role: 'generator', model: 'claude-sonnet-5-5', input: 10, output: 10, cost: null });
  ok('spend is saved one line per call and read back', sp.read().length === 3 && fs.readFileSync(sp.file('2026-10'), 'utf8').trim().split('\n').length === 3);
  ok('the month total adds the priced calls', sp.monthTotal() === 0.07015);
  const run = sp.between('2026-10-27T10:03:00Z', '2026-10-27T10:10:00Z');
  ok('a run is the calls between its start and end', run.length === 2 && run.every((r) => r.role === 'generator'));
  const s = summarize(sp.read());
  ok('the summary groups by step and model, and counts unpriced calls', s.calls === 3 && s.by_step['title screen'].calls === 1 && s.by_step.writer.calls === 2 && s.by_model['claude-sonnet-5-5'].calls === 2 && s.unpriced_calls === 1 && s.cost_usd === 0.07015, JSON.stringify(s));
  ok('status: below the warning level', sp.status({ cap: 25 }).warn === false && sp.status({ cap: 25 }).over === false);
  ok('status: warning at 80% of the cap', sp.status({ cap: 0.08, warnFraction: 0.8 }).warn === true && sp.status({ cap: 0.08 }).over === false);
  ok('status: over at the cap', sp.status({ cap: 0.07 }).over === true);
  ok('a new month starts at zero', createSpend({ dir, now: () => new Date('2026-11-01T00:00:00Z') }).monthTotal() === 0 && monthOf('2026-11-01T00:00:00Z') === '2026-11');
  fs.appendFileSync(sp.file('2026-10'), 'not json\n');
  ok('a damaged line is skipped, not fatal', sp.read().length === 3);
}
{
  const dir = tmp(), models = JSON.parse(fs.readFileSync(new URL('../config/models.json', import.meta.url), 'utf8'));
  const noKey = createLlmFactory({ models, dir, env: {} });
  ok('the factory reads the provider from config and finds the right key name', noKey.provider === 'anthropic' && noKey.keyName === 'ANTHROPIC_API_KEY' && noKey.hasKey === false);
  ok('without a key, make() returns null so callers can run without AI', noKey.make('screener') === null);
  const withKey = createLlmFactory({ models, dir, env: { ANTHROPIC_API_KEY: 'test-key' } });
  ok('with a key, make() returns a client for the role (Haiku from config)', withKey.hasKey && typeof withKey.make('screener').generate === 'function' && withKey.make('screener').model === 'claude-haiku-5-5');
  ok('the factory ledger saves every call to the month file', (() => { withKey.ledger.record({ role: 'screener', model: 'claude-haiku-5-5', usage: use(1000, 100) }); return withKey.spend.read().length === 1 && withKey.monthStatus().spent > 0; })());
  const g = createLlmFactory({ models: { ...models, provider: 'gemini' }, dir: tmp(), env: { GEMINI_API_KEY: 'g-key' } });
  ok('Gemini still works for testing: provider and key name follow the config', g.provider === 'gemini' && g.keyName === 'GEMINI_API_KEY' && g.make('screener').model === 'gemini-3.5-flash-lite');
  const capped = createLlmFactory({ models: { ...models, monthly_cost_cap_usd: 0.0001 }, dir, env: { ANTHROPIC_API_KEY: 'k' } });
  ok('a new process starts from what the month has already spent, so the cap holds across runs', (() => { try { capped.ledger.assertWithin(); return false; } catch (e) { return e instanceof BudgetExceeded && e.scope === 'month'; } })());
}

console.log(`spend: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
