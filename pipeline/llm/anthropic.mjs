// A small Claude client with the same shape as the Gemini one (llm/gemini.mjs), so the agents need no change
// when config/models.json switches "provider" to "anthropic".
// - JSON output only: one answer in the caller's schema (structured outputs), checked again in code
// - every call is counted on the shared ledger and checked against the budget BEFORE it is made
// - the key comes from the environment and never appears in logs (the SDK sends it in a header)
// Production runs on Claude; build and tests run on Gemini (owner's decision, 15 Oct 2026).
// Each attempt times out after 2 minutes (the SDK default is 10), so a stuck call cannot hold a scheduled run for an hour.
import Anthropic from '@anthropic-ai/sdk';
import { LlmOutputError, InputTooLarge } from './gemini.mjs';
import { toJsonSchema, schemaProblems } from './schema.mjs';

// timeoutMs: each attempt's limit. 2 minutes by default, so a stuck call cannot hold a scheduled run; a role that reads a whole bill and
// writes a long answer sets more in config/models.json (timeout_ms), or every long bill times out on every run (live run, 31 Oct 2026).
export function createAnthropic({ apiKey, client, role, model, maxOutputTokens = 4000, effort = null, ledger, maxInputChars = 120000, timeoutMs = 120000, log = () => {} }) {
  const api = client || new Anthropic({ apiKey, maxRetries: 3, timeout: timeoutMs });
  // With a schema the API constrains the reply to exactly one JSON value of that shape (structured outputs), so there is nothing to
  // pick between. It is still checked in code: an answer of the wrong shape is unusable (LlmOutputError) and the caller asks once more.
  const parse = (text, responseSchema) => {
    const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let data; try { data = JSON.parse(clean); } catch (e) { throw new LlmOutputError('the model did not return valid JSON', clean.slice(0, 300)); }
    const problems = responseSchema ? schemaProblems(responseSchema, data) : [];
    if (problems.length) throw new LlmOutputError('the answer does not fit its schema: ' + problems.slice(0, 3).join('; '), clean.slice(0, 300));
    return data;
  };
  return {
    role, model, timeoutMs,
    // Same call as the Gemini client. responseSchema (a Gemini-style schema, llm/schema.mjs) is sent as the structured-output
    // format, so the reply is exactly one answer of that shape. Forced tool use (tool_choice "tool") would do the same, but the
    // current Sonnet and Opus models refuse it with a 400; output_config.format is the API's route for a JSON-only answer.
    async generate({ system, prompt, itemId, responseSchema }) {
      if (prompt.length + (system || '').length > maxInputChars) throw new InputTooLarge(prompt.length + (system || '').length, maxInputChars);
      if (ledger) ledger.assertWithin(itemId);
      // No temperature: current Claude models reject non-default sampling values. Thinking stays adaptive (the default);
      // effort sets its depth.
      const res = await api.messages.create({
        model, max_tokens: maxOutputTokens,
        ...(system ? { system: system + '\n\nReply with one JSON value only, no prose and no code fences.' } : {}),
        ...(effort || responseSchema ? { output_config: { ...(effort ? { effort } : {}), ...(responseSchema ? { format: { type: 'json_schema', schema: toJsonSchema(responseSchema) } } : {}) } } : {}),
        messages: [{ role: 'user', content: prompt }]
      });
      const usage = res.usage || {};
      if (ledger) ledger.record({ role, model, itemId, usage: { promptTokenCount: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), candidatesTokenCount: usage.output_tokens || 0 } });
      if (res.stop_reason === 'refusal') throw new LlmOutputError('the model declined' + (res.stop_details && res.stop_details.category ? ` (${res.stop_details.category})` : ''), JSON.stringify(res.stop_details || {}));
      if (res.stop_reason === 'max_tokens') throw new LlmOutputError('the model stopped early: max_tokens', 'max_tokens');
      const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text.trim()) throw new LlmOutputError('the model returned an empty answer');
      log(`${role}/${model}: ${usage.input_tokens || 0} in, ${usage.output_tokens || 0} out`);
      return { data: parse(text, responseSchema), text, usage, finishReason: res.stop_reason || 'end_turn' };
    }
  };
}
