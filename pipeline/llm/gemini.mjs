// A small Gemini client for the Generator and Validator.
// - JSON output only, validated by the caller against our own schemas
// - every call is counted (tokens in, out, per role and per item) and checked against a budget BEFORE it is made
// - the key is sent in a header and scrubbed from errors; input is never silently truncated
export class BudgetExceeded extends Error { constructor(what, scope = 'run') { super(`LLM budget reached: ${what}`); this.name = 'BudgetExceeded'; this.scope = scope; } }
export class LlmOutputError extends Error { constructor(msg, detail) { super(msg); this.name = 'LlmOutputError'; this.detail = detail; } }
export class InputTooLarge extends Error { constructor(n, max) { super(`prompt is ${n} characters, over the limit of ${max}`); this.name = 'InputTooLarge'; } }

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Counts usage and enforces the limits from config/models.json.
export function createLedger({ limits = {}, prices = {} } = {}) {
  const t = { calls: 0, input: 0, output: 0, byRole: {}, byItem: {}, byModel: {} };
  const add = (o, k, i, out) => { const r = (o[k] = o[k] || { calls: 0, input: 0, output: 0 }); r.calls++; r.input += i; r.output += out; };
  return {
    assertWithin(itemId) {
      if (limits.max_tokens_per_run && t.input + t.output >= limits.max_tokens_per_run) throw new BudgetExceeded(`${limits.max_tokens_per_run} tokens per run`);
      const it = itemId && t.byItem[itemId];
      if (limits.max_tokens_per_item && it && it.input + it.output >= limits.max_tokens_per_item) throw new BudgetExceeded(`${limits.max_tokens_per_item} tokens for item ${itemId}`, 'item');
    },
    record({ role, model, itemId, usage }) {
      const i = usage.promptTokenCount || 0, o = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0); // thinking tokens are billed as output
      t.calls++; t.input += i; t.output += o;
      add(t.byRole, role, i, o); add(t.byModel, model, i, o); if (itemId) add(t.byItem, itemId, i, o);
    },
    totals() {
      let cost = 0, priced = true;
      for (const [m, u] of Object.entries(t.byModel)) {
        const p = prices[m];
        if (!p || p.input == null || p.output == null) { priced = false; break; }
        cost += (u.input / 1e6) * p.input + (u.output / 1e6) * p.output;
      }
      return { calls: t.calls, input_tokens: t.input, output_tokens: t.output, total_tokens: t.input + t.output, by_role: t.byRole, by_model: t.byModel, estimated_cost_usd: priced && t.calls ? Math.round(cost * 1e6) / 1e6 : null };
    },
    itemTokens: (id) => (t.byItem[id] ? t.byItem[id].input + t.byItem[id].output : 0)
  };
}

export function createGemini({ http, apiKey, role, model, temperature = 0, maxOutputTokens = 4000, thinkingLevel = null, ledger, maxInputChars = 120000, log = () => {} }) {
  const parseJson = (text) => {
    const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(clean); } catch (e) { throw new LlmOutputError('the model did not return valid JSON', clean.slice(0, 300)); }
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
      return { data: parseJson(text), text, usage, finishReason: cand.finishReason || 'STOP' };
    }
  };
}

// Builds the three pieces from config/models.json and the environment.
export function createLlmFromConfig({ config, apiKey, http, role, log }) {
  const r = config.roles[role];
  if (!r) throw new Error(`no model configured for role "${role}"`);
  const ledger = createLlmFromConfig.ledgers.get(http) || createLedger({ limits: config.limits, prices: config.prices_per_million_tokens });
  createLlmFromConfig.ledgers.set(http, ledger);
  return { llm: createGemini({ http, apiKey, role, model: r.model, temperature: r.temperature, maxOutputTokens: r.max_output_tokens, thinkingLevel: r.thinking_level || null, ledger, maxInputChars: config.limits && config.limits.max_input_chars_per_call, log }), ledger };
}
createLlmFromConfig.ledgers = new WeakMap();
