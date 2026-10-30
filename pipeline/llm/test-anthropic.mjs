// Tests for the Claude client with a stand-in for the SDK: no network, no key.
//   node llm/test-anthropic.mjs
import { createAnthropic, createLedger, createLlmFromConfig, LlmOutputError, InputTooLarge, BudgetExceeded } from './index.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const fake = (reply) => { const calls = []; return { calls, messages: { create: async (req) => { calls.push(req); return typeof reply === 'function' ? reply(req) : reply; } } }; };
const msg = (text, extra = {}) => ({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 30 }, ...extra });

{
  const client = fake(msg('{"in_scope": true}')), ledger = createLedger();
  const llm = createAnthropic({ client, role: 'screener', model: 'claude-haiku-5-5', maxOutputTokens: 500, effort: 'low', ledger });
  const r = await llm.generate({ system: 'Classify.', prompt: 'A bill about frontier models', itemId: 'x' });
  const req = client.calls[0];
  ok('returns parsed JSON from the text block (thinking blocks ignored)', r.data.in_scope === true);
  ok('sends model, max_tokens, effort and the user prompt', req.model === 'claude-haiku-5-5' && req.max_tokens === 500 && req.output_config.effort === 'low' && req.messages[0].content === 'A bill about frontier models');
  ok('sends no temperature (rejected by current models)', !('temperature' in req));
  ok('asks for JSON only in the system prompt', /JSON value only/.test(req.system));
  ok('counts tokens on the shared ledger', ledger.totals().input_tokens === 120 && ledger.totals().output_tokens === 30 && ledger.itemTokens('x') === 150);
}
{
  const llm = createAnthropic({ client: fake(msg('```json\n{"a":1}\n```')), role: 'r', model: 'm' });
  ok('code fences are stripped', (await llm.generate({ prompt: 'p' })).data.a === 1);
}
const fails = async (reply, re, opts = {}) => { try { await createAnthropic({ client: fake(reply), role: 'r', model: 'm', ...opts }).generate({ prompt: opts.prompt || 'p' }); return false; } catch (e) { return e instanceof (opts.type || LlmOutputError) && re.test(e.message); } };
ok('a refusal is an error with its category', await fails(msg('', { stop_reason: 'refusal', stop_details: { category: 'cyber' } }), /declined \(cyber\)/));
ok('hitting max_tokens is an error, not a half answer', await fails(msg('{"a":', { stop_reason: 'max_tokens' }), /max_tokens/));
ok('prose instead of JSON is an error', await fails(msg('Sure, here it is'), /valid JSON/));
ok('an empty answer is an error', await fails(msg(''), /empty/));
ok('input over the limit is refused before any call', await fails(msg('{}'), /over the limit/, { type: InputTooLarge, maxInputChars: 10, prompt: 'x'.repeat(50) }));
{
  const ledger = createLedger({ limits: { max_tokens_per_run: 100 } }); ledger.record({ role: 'r', model: 'm', usage: { promptTokenCount: 100 } });
  const client = fake(msg('{}'));
  let e; try { await createAnthropic({ client, role: 'r', model: 'm', ledger }).generate({ prompt: 'p' }); } catch (x) { e = x; }
  ok('the run budget is checked before the call is made', e instanceof BudgetExceeded && client.calls.length === 0);
}
{
  const config = { provider: 'anthropic', roles: { screener: { model: 'gemini-x' } }, anthropic: { roles: { screener: { model: 'claude-haiku-5-5', max_output_tokens: 900, effort: 'low' } } }, limits: {} };
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  const { llm } = createLlmFromConfig({ config, http: {}, role: 'screener' });
  ok('provider "anthropic" picks the Claude role from config', llm.model === 'claude-haiku-5-5');
  const g = createLlmFromConfig({ config: { ...config, provider: 'gemini' }, apiKey: 'k', http: {}, role: 'screener' });
  ok('provider "gemini" still picks the Gemini role', g.llm.model === 'gemini-x');
  delete process.env.ANTHROPIC_API_KEY;
  let e; try { createLlmFromConfig({ config, http: {}, role: 'screener' }); } catch (x) { e = x; }
  ok('provider "anthropic" without a key fails clearly', e && /ANTHROPIC_API_KEY is not set/.test(e.message));
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
}

{
  // Opus as referee (30 Oct 2026): a sentence around the JSON is not an unusable answer; text with no JSON object still is
  const r = await createAnthropic({ client: fake(msg('Here is my answer:\n{"results":[{"n":1,"supported":true}]}\nDone.')), role: 'r', model: 'm' }).generate({ prompt: 'p' });
  ok('JSON with a sentence around it is read', r.data.results[0].supported === true);
  // Independent review, 30 Oct 2026: two different answers in one reply are not trusted (a "false" then a weaker "true"); the caller asks again.
  ok('two different answers in one reply are unusable (Opus, H.R. 9917)', await fails(msg('{"results":[{"n":1,"supported":false}]}\n\nWait, let me check {the text}.\n\n{"results":[{"n":1,"supported":true,"quote":"a b"}]}'), /two different answers/));
  const same = await createAnthropic({ client: fake(msg('{"a":1}\nTo repeat: {"a":1}')), role: 'r', model: 'm' }).generate({ prompt: 'p' });
  ok('the same answer repeated is used', same.data.a === 1);
  const inner = await createAnthropic({ client: fake(msg('Answer: {"q":"text with {braces} and \\"quotes\\" inside","n":1}')), role: 'r', model: 'm' }).generate({ prompt: 'p' });
  ok('braces inside a string do not split the answer', inner.data.n === 1 && /braces/.test(inner.data.q));
  ok('text with no JSON object is still unusable', await fails(msg('I think it is in scope.'), /valid JSON/) && await fails(msg('text { broken'), /valid JSON/));
}
console.log(`anthropic client: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
