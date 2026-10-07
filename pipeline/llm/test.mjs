// Run:  node llm/test.mjs   (or npm run test:llm)   A fake Gemini server: no live calls, no cost.
import { createGemini, createLedger, createLlmFromConfig, BudgetExceeded, LlmOutputError, InputTooLarge } from './gemini.mjs';
import { createHttp, HttpError } from '../grabber/lib/http.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const KEY = 'GEMINI-SECRET-KEY-XYZ-789';

function fake(handler) {
  const calls = [], sleeps = [];
  const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null }); return handler(calls.length, resp, { url, init }); };
  return { fetchImpl, calls, sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}
const answer = (obj, usage = { promptTokenCount: 100, candidatesTokenCount: 20 }, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }], usageMetadata: usage });
const mk = (srv, extra = {}) => createHttp({ fetchImpl: srv.fetchImpl, sleep: srv.sleep, headers: { 'x-goog-api-key': KEY }, secrets: [KEY], ...extra });
const gem = (srv, o = {}) => { const ledger = o.ledger || createLedger({ limits: o.limits || {}, prices: o.prices || {} }); return { llm: createGemini({ http: mk(srv, o.http), apiKey: KEY, role: 'generator', model: 'gemini-3.5-flash-lite', ledger, ...o.cfg }), ledger }; };

// ---------- a normal call ----------
{
  const srv = fake((n, r) => r(200, answer({ ok: true })));
  const { llm, ledger } = gem(srv);
  const r = await llm.generate({ system: 'Be brief.', prompt: 'Say ok', itemId: 'i1' });
  ok('returns parsed JSON', r.data.ok === true && r.finishReason === 'STOP');
  const c = srv.calls[0];
  ok('calls the right model endpoint', c.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent', c.url);
  ok('asks for JSON output at temperature 0', c.body.generationConfig.responseMimeType === 'application/json' && c.body.generationConfig.temperature === 0);
  ok('sends the system instruction and the prompt', c.body.systemInstruction.parts[0].text === 'Be brief.' && c.body.contents[0].parts[0].text === 'Say ok');
  ok('the key is in a header and never in the URL or body', c.init.headers['x-goog-api-key'] === KEY && !c.url.includes(KEY) && !c.init.body.includes(KEY));
  const t = ledger.totals();
  ok('usage is counted', t.calls === 1 && t.input_tokens === 100 && t.output_tokens === 20 && t.by_role.generator.calls === 1);
  ok('cost is null until prices are configured', t.estimated_cost_usd === null);
}
// ---------- thinking level ----------
{
  const srv = fake((n, r) => r(200, answer({ ok: true })));
  const { llm } = gem(srv, { cfg: { thinkingLevel: 'low' } });
  await llm.generate({ prompt: 'x' });
  ok('a thinking level is sent when configured', srv.calls[0].body.generationConfig.thinkingConfig.thinkingLevel === 'low');
  const srv2 = fake((n, r) => r(200, answer({ ok: true })));
  await gem(srv2).llm.generate({ prompt: 'x' });
  ok('and nothing is sent when it is not', srv2.calls[0].body.generationConfig.thinkingConfig === undefined);
  const http = mk(fake((n, r) => r(200, answer({ a: 1 }))));
  const cfg = { roles: { generator: { model: 'gemini-3.5-flash', temperature: 0, max_output_tokens: 100, thinking_level: 'low' } }, limits: {}, prices_per_million_tokens: {} };
  const srv3 = fake((n, r) => r(200, answer({ a: 1 })));
  const g = createLlmFromConfig({ config: cfg, apiKey: KEY, http: mk(srv3), role: 'generator' });
  await g.llm.generate({ prompt: 'x' });
  ok('thinking_level in config/models.json reaches the request', srv3.calls[0].body.generationConfig.thinkingConfig.thinkingLevel === 'low');
}

// ---------- cost estimate ----------
{
  const srv = fake((n, r) => r(200, answer({ ok: 1 }, { promptTokenCount: 1_000_000, candidatesTokenCount: 500_000 })));
  const { llm, ledger } = gem(srv, { prices: { 'gemini-3.5-flash-lite': { input: 0.1, output: 0.4 } } });
  await llm.generate({ prompt: 'x' });
  ok('estimated cost = tokens x configured price', ledger.totals().estimated_cost_usd === 0.3, String(ledger.totals().estimated_cost_usd));
}
// thinking tokens are billed as output
{
  const srv = fake((n, r) => r(200, answer({ a: 1 }, { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 50 })));
  const { llm, ledger } = gem(srv); await llm.generate({ prompt: 'x' });
  ok('thinking tokens are counted as output', ledger.totals().output_tokens === 55);
}
// ---------- output problems ----------
for (const [name, body, re] of [
  ['an answer cut off by the token limit', answer('{"a":', undefined, 'MAX_TOKENS'), /MAX_TOKENS/],
  ['a safety block', answer('{}', undefined, 'SAFETY'), /SAFETY/],
  ['no candidates', { promptFeedback: { blockReason: 'OTHER' }, usageMetadata: { promptTokenCount: 5 } }, /blocked: OTHER/],
  ['an empty answer', answer('   '), /empty/],
  ['text that is not JSON', answer('Sure! Here is the answer.'), /valid JSON/]
]) {
  const { llm } = gem(fake((n, r) => r(200, body)));
  let err; try { await llm.generate({ prompt: 'x' }); } catch (e) { err = e; }
  ok('rejects ' + name, err instanceof LlmOutputError && re.test(err.message), err && err.message);
}
{
  const { llm } = gem(fake((n, r) => r(200, answer('```json\n{"fenced": true}\n```'))));
  ok('accepts JSON wrapped in a code fence', (await llm.generate({ prompt: 'x' })).data.fenced === true);
}
// ---------- budgets ----------
{
  const srv = fake((n, r) => r(200, answer({ a: 1 }, { promptTokenCount: 600, candidatesTokenCount: 100 })));
  const { llm, ledger } = gem(srv, { limits: { max_tokens_per_run: 1000 } });
  await llm.generate({ prompt: 'x' }); await llm.generate({ prompt: 'x' });
  let err; try { await llm.generate({ prompt: 'x' }); } catch (e) { err = e; }
  ok('the run budget stops further calls before they are made', err instanceof BudgetExceeded && srv.calls.length === 2, `${srv.calls.length} calls`);
}
{
  const srv = fake((n, r) => r(200, answer({ a: 1 }, { promptTokenCount: 600, candidatesTokenCount: 100 })));
  const { llm } = gem(srv, { limits: { max_tokens_per_item: 1000 } });
  await llm.generate({ prompt: 'x', itemId: 'A' }); await llm.generate({ prompt: 'x', itemId: 'A' });
  let err; try { await llm.generate({ prompt: 'x', itemId: 'A' }); } catch (e) { err = e; }
  const other = await llm.generate({ prompt: 'x', itemId: 'B' });
  ok('the per-item budget stops one runaway item but not the others', err instanceof BudgetExceeded && other.data.a === 1);
}
{
  const srv = fake((n, r) => r(200, answer({ a: 1 })));
  const { llm } = gem(srv, { cfg: { maxInputChars: 50 } });
  let err; try { await llm.generate({ prompt: 'x'.repeat(100) }); } catch (e) { err = e; }
  ok('an oversized prompt is refused, never silently truncated, and costs nothing', err instanceof InputTooLarge && srv.calls.length === 0);
}
// ---------- API errors ----------
{
  const srv = fake((n, r) => (n < 3 ? r(429, { error: { message: 'quota' } }) : r(200, answer({ ok: 1 }))));
  const { llm } = gem(srv); const r = await llm.generate({ prompt: 'x' });
  ok('rate limit (429) is retried with growing waits, then succeeds', r.data.ok === 1 && srv.sleeps.length === 2 && srv.sleeps[1] > srv.sleeps[0], JSON.stringify(srv.sleeps));
}
{
  const srv = fake((n, r) => r(400, { error: { message: 'bad request mentioning ' + KEY } }));
  const { llm } = gem(srv); let err; try { await llm.generate({ prompt: 'x' }); } catch (e) { err = e; }
  ok('a 400 fails at once and the key is scrubbed from the message', err instanceof HttpError && err.status === 400 && srv.calls.length === 1 && !JSON.stringify([err.message, err.body]).includes(KEY), String(err && err.body));
}
{
  const srv = fake((n, r) => r(200, answer({ a: 1 }, { promptTokenCount: 5, candidatesTokenCount: 5 })));
  const http = mk(srv), config = { roles: { generator: { model: 'gemini-3.5-flash-lite', temperature: 0, max_output_tokens: 100 }, validator: { model: 'gemini-3.5-flash-lite' } }, limits: { max_tokens_per_run: 1000 }, prices_per_million_tokens: {} };
  const g = createLlmFromConfig({ config, apiKey: KEY, http, role: 'generator' }), v = createLlmFromConfig({ config, apiKey: KEY, http, role: 'validator' });
  await g.llm.generate({ prompt: 'x' }); await v.llm.generate({ prompt: 'x' });
  ok('roles built from config share one ledger, so the run budget covers both', g.ledger === v.ledger && g.ledger.totals().calls === 2 && g.ledger.totals().by_role.generator.calls === 1 && g.ledger.totals().by_role.validator.calls === 1);
  let err; try { createLlmFromConfig({ config, apiKey: KEY, http, role: 'nobody' }); } catch (e) { err = e; }
  ok('an unconfigured role is an error', !!err);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
