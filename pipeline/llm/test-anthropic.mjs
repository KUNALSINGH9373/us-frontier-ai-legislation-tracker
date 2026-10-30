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
const fails = async (reply, re, opts = {}) => { try { await createAnthropic({ client: fake(reply), role: 'r', model: 'm', ...opts }).generate({ prompt: opts.prompt || 'p', responseSchema: opts.schema }); return false; } catch (e) { return e instanceof (opts.type || LlmOutputError) && re.test(e.message); } };
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
  // C2: every call with a schema asks the API for exactly one answer of that shape (structured outputs, output_config.format).
  const { VERDICT_SCHEMA } = await import('../agents/prompts.mjs');
  const client = fake(msg('{"results":[{"n":1,"supported":true,"quote":"a b","reason":null}]}'));
  const r = await createAnthropic({ client, role: 'r', model: 'm', effort: 'high' }).generate({ prompt: 'p', responseSchema: VERDICT_SCHEMA });
  const f = client.calls[0].output_config;
  ok('a schema is sent as output_config.format json_schema, next to effort', f.effort === 'high' && f.format.type === 'json_schema' && f.format.schema.type === 'object' && f.format.schema.additionalProperties === false);
  const item = f.format.schema.properties.results.items;
  ok('the schema is JSON Schema: lower-case types, nullable as a null type, required kept', item.properties.n.type === 'integer' && JSON.stringify(item.properties.quote.type) === '["string","null"]' && item.required.includes('supported') && item.additionalProperties === false);
  ok('no tool and no tool_choice is sent (the current Sonnet and Opus models refuse forced tool use)', !('tools' in client.calls[0]) && !('tool_choice' in client.calls[0]));
  ok('the one answer is returned', r.data.results[0].quote === 'a b');
  const noSchema = fake(msg('{"a":1}'));
  await createAnthropic({ client: noSchema, role: 'r', model: 'm' }).generate({ prompt: 'p' });
  ok('without a schema no format is sent', !('output_config' in noSchema.calls[0]));
  ok('an answer that does not fit the schema is unusable (the caller asks once more)', await fails(msg('{"results":[{"n":"one","supported":true}]}'), /does not fit its schema/, { schema: VERDICT_SCHEMA }));
  ok('a missing required key is unusable', await fails(msg('{"verdict":true}'), /results is missing/, { schema: VERDICT_SCHEMA }));
  // The old free-text heuristics are gone: text around the JSON or two answers in one reply are simply not valid JSON.
  ok('a sentence around the JSON is not read', await fails(msg('Here is my answer:\n{"a":1}\nDone.'), /valid JSON/));
  ok('two answers in one reply are not read', await fails(msg('{"a":1}\n{"a":2}'), /valid JSON/));
  ok('text with no JSON object is unusable', await fails(msg('I think it is in scope.'), /valid JSON/));
  // The agents' retry: an unusable answer, then a good one.
  let n = 0; const twice = fake(() => msg(n++ ? '{"results":[{"n":1,"supported":false}]}' : '{"results":[]', {}));
  const llm = createAnthropic({ client: twice, role: 'r', model: 'm' });
  const askAgain = async (req) => { try { return await llm.generate(req); } catch (e) { if (!(e instanceof LlmOutputError)) throw e; return llm.generate(req); } };
  ok('an unusable answer is asked once more and the second answer is used', (await askAgain({ prompt: 'p', responseSchema: VERDICT_SCHEMA })).data.results[0].supported === false && twice.calls.length === 2);
}
{
  const { schemaProblems, toJsonSchema } = await import('./schema.mjs');
  const S = { type: 'OBJECT', required: ['v'], properties: { v: { type: 'STRING', enum: ['yes', 'no'], nullable: true }, k: { type: 'ARRAY', items: { type: 'NUMBER' } } } };
  ok('schema: enum, nullable and arrays are checked', !schemaProblems(S, { v: null, k: [1, 2.5] }).length && schemaProblems(S, { v: 'maybe' }).length === 1 && schemaProblems(S, { v: 'yes', k: ['x'] }).length === 1);
  ok('schema: a nullable enum lists null', toJsonSchema(S).properties.v.enum.includes(null));
}
console.log(`anthropic client: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
