// A small Gemini client for the Generator and Validator.
// - JSON output only, validated by the caller against our own schemas
// - every call is counted (tokens in, out, per role and per item) and checked against a budget BEFORE it is made
// - the key is sent in a header and scrubbed from errors; input is never silently truncated
export class BudgetExceeded extends Error { constructor(what, scope = 'run') { super(`LLM budget reached: ${what}`); this.name = 'BudgetExceeded'; this.scope = scope; } }
export class LlmOutputError extends Error { constructor(msg, detail) { super(msg); this.name = 'LlmOutputError'; this.detail = detail; } }
export class InputTooLarge extends Error { constructor(n, max) { super(`prompt is ${n} characters, over the limit of ${max}`); this.name = 'InputTooLarge'; } }

import { schemaProblems } from './schema.mjs';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Counts usage, prices every call, and enforces the limits from config/models.json.
// - prices: USD per million tokens by model. A model may add a long-prompt tier ({ long_prompt_tokens, long_input, long_output }):
//   a call whose prompt is longer than that is billed at the long rates for the whole call (Claude Haiku above 100K tokens).
// - monthly: { capUsd, spentBefore } stops AI work before the month's spending (already recorded before this run, plus this run) reaches the cap.
// - onCall: called after every call with { role, model, itemId, input, output, cost } so spend can be saved to disk (the grabber and the
//   agents are separate processes, so a per-process total would be lost).
export function createLedger({ limits = {}, prices = {}, monthly = null, onCall = null } = {}) {
  const t = { calls: 0, input: 0, output: 0, cost: 0, unpriced: false, byRole: {}, byItem: {}, byModel: {} };
  const add = (o, k, i, out, c) => { const r = (o[k] = o[k] || { calls: 0, input: 0, output: 0, cost: 0 }); r.calls++; r.input += i; r.output += out; r.cost += c || 0; };
  const priceOf = (model, i, o) => {
    const p = prices[model];
    if (!p || p.input == null || p.output == null) return null;
    const long = p.long_prompt_tokens != null && i > p.long_prompt_tokens;
    return (i / 1e6) * (long && p.long_input != null ? p.long_input : p.input) + (o / 1e6) * (long && p.long_output != null ? p.long_output : p.output);
  };
  return {
    assertWithin(itemId) {
      if (limits.max_tokens_per_run && t.input + t.output >= limits.max_tokens_per_run) throw new BudgetExceeded(`${limits.max_tokens_per_run} tokens per run`);
      const it = itemId && t.byItem[itemId];
      if (limits.max_tokens_per_item && it && it.input + it.output >= limits.max_tokens_per_item) throw new BudgetExceeded(`${limits.max_tokens_per_item} tokens for item ${itemId}`, 'item');
      if (monthly && monthly.capUsd && (monthly.spentBefore || 0) + t.cost >= monthly.capUsd) throw new BudgetExceeded(`the monthly AI cost cap of $${monthly.capUsd} is reached`, 'month');
    },
    record({ role, model, itemId, usage }) {
      const i = usage.promptTokenCount || 0, o = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0); // thinking tokens are billed as output
      const c = priceOf(model, i, o);
      if (c == null) t.unpriced = true;
      t.calls++; t.input += i; t.output += o; t.cost += c || 0;
      add(t.byRole, role, i, o, c); add(t.byModel, model, i, o, c); if (itemId) add(t.byItem, itemId, i, o, c);
      if (onCall) onCall({ role, model, itemId: itemId || null, input: i, output: o, cost: c });
    },
    totals() {
      return { calls: t.calls, input_tokens: t.input, output_tokens: t.output, total_tokens: t.input + t.output, by_role: t.byRole, by_model: t.byModel, estimated_cost_usd: !t.unpriced && t.calls ? Math.round(t.cost * 1e6) / 1e6 : null };
    },
    itemTokens: (id) => (t.byItem[id] ? t.byItem[id].input + t.byItem[id].output : 0)
  };
}

export function createGemini({ http, apiKey, role, model, temperature = 0, maxOutputTokens = 4000, thinkingLevel = null, ledger, maxInputChars = 120000, log = () => {} }) {
  const parseJson = (text) => {
    const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(clean); } catch (e) { throw new LlmOutputError('the model did not return valid JSON', clean.slice(0, 300)); }
  };
  // The same shape check as the Claude client: an answer that does not fit the caller's schema is unusable.
  const fit = (data, responseSchema, text) => {
    const problems = responseSchema ? schemaProblems(responseSchema, data) : [];
    if (problems.length) throw new LlmOutputError('the answer does not fit its schema: ' + problems.slice(0, 3).join('; '), text.slice(0, 300));
    return data;
  };
  return {
    role, model,
    // system: instructions. prompt: the material. responseSchema (optional): a Gemini-style schema to steer the shape.
    async generate({ system, prompt, itemId, responseSchema }) {
      if (prompt.length + (system || '').length > maxInputChars) throw new InputTooLarge(prompt.length + (system || '').length, maxInputChars);
      if (ledger) ledger.assertWithin(itemId);
      const body = {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        // thinkingLevel "low" keeps a thinking model from spending its whole budget reasoning (the default run on a long bill stopped with no answer).
        generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json', ...(responseSchema ? { responseSchema } : {}), ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}) }
      };
      const res = await http.postJson(`${BASE}/${model}:generateContent`, body);
      const usage = res.usageMetadata || {};
      if (ledger) ledger.record({ role, model, itemId, usage });
      const cand = res.candidates && res.candidates[0];
      if (!cand) throw new LlmOutputError('the model returned no answer' + (res.promptFeedback && res.promptFeedback.blockReason ? ` (blocked: ${res.promptFeedback.blockReason})` : ''), JSON.stringify(res.promptFeedback || {}));
      if (cand.finishReason && cand.finishReason !== 'STOP') throw new LlmOutputError(`the model stopped early: ${cand.finishReason}`, cand.finishReason);
      const text = (cand.content && cand.content.parts ? cand.content.parts.map((p) => p.text || '').join('') : '');
      if (!text.trim()) throw new LlmOutputError('the model returned an empty answer');
      log(`${role}/${model}: ${usage.promptTokenCount || 0} in, ${usage.candidatesTokenCount || 0} out`);
      return { data: fit(parseJson(text), responseSchema, text), text, usage, finishReason: cand.finishReason || 'STOP' };
    }
  };
}

// Builds the three pieces from config/models.json and the environment.
// "provider": "gemini" (build and tests) uses config.roles and the key passed in; "anthropic" (production) uses
// config.anthropic.roles and ANTHROPIC_API_KEY from the environment. createAnthropic is passed in by llm/index.mjs
// so this file does not load the Anthropic SDK for Gemini runs.
export function createLlmFromConfig({ config, apiKey, http, role, log, provider = config.provider, createAnthropic, ledger: given, claudeKey }) {
  const claude = provider === 'anthropic';
  const r = (claude ? (config.anthropic || {}).roles || {} : config.roles)[role];
  if (!r) throw new Error(`no ${claude ? 'anthropic ' : ''}model configured for role "${role}"`);
  const ledger = given || createLlmFromConfig.ledgers.get(http) || createLedger({ limits: config.limits, prices: config.prices_per_million_tokens });
  if (!given) createLlmFromConfig.ledgers.set(http, ledger);
  const maxInputChars = config.limits && config.limits.max_input_chars_per_call;
  if (claude) {
    if (!createAnthropic) throw new Error('provider "anthropic" needs createAnthropic (import createLlmFromConfig from llm/index.mjs)');
    const key = claudeKey || process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
    return { llm: createAnthropic({ apiKey: key, role, model: r.model, maxOutputTokens: r.max_output_tokens, effort: r.effort || null, ledger, maxInputChars, ...(r.timeout_ms ? { timeoutMs: r.timeout_ms } : {}), log }), ledger };
  }
  return { llm: createGemini({ http, apiKey, role, model: r.model, temperature: r.temperature, maxOutputTokens: r.max_output_tokens, thinkingLevel: r.thinking_level || null, ledger, maxInputChars, log }), ledger };
}
createLlmFromConfig.ledgers = new WeakMap();
