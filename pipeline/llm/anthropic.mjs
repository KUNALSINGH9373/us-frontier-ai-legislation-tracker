// A small Claude client with the same shape as the Gemini one (llm/gemini.mjs), so the agents need no change
// when config/models.json switches "provider" to "anthropic".
// - JSON output only: one answer in the caller's schema (structured outputs), checked again in code
// - every call is counted on the shared ledger and checked against the budget BEFORE it is made
// - the key comes from the environment and never appears in logs (the SDK sends it in a header)
// Production runs on Claude; build and tests run on Gemini (owner's decision, 15 Oct 2026).
// Each attempt times out after 2 minutes (the SDK default is 10), so a stuck call cannot hold a scheduled run for an hour.
import Anthropic from '@anthropic-ai/sdk';
import { LlmOutputError, InputTooLarge } from './gemini.mjs';
import { toJsonSchema, schemaProblems, dropOptionalNulls } from './schema.mjs';

// timeoutMs: each attempt's limit. 2 minutes by default, so a stuck call cannot hold a scheduled run; a role that reads a whole bill and
// writes a long answer sets more in config/models.json (timeout_ms), or every long bill times out on every run (live run, 31 Oct 2026).
export function createAnthropic({ apiKey, client, role, model, maxOutputTokens = 4000, effort = null, ledger, maxInputChars = 120000, timeoutMs = 120000, log = () => {} }) {
  const api = client || new Anthropic({ apiKey, maxRetries: 3, timeout: timeoutMs });
  // With a schema the API constrains the reply to exactly one JSON value of that shape (structured outputs), so there is nothing to
  // pick between. It is still checked in code: an answer of the wrong shape is unusable (LlmOutputError) and the caller asks once more.
  const parse = (text, responseSchema) => {
    const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let data; try { data = JSON.parse(clean); } catch (e) { throw new LlmOutputError('the model did not return valid JSON', clean.slice(0, 300)); }
    if (responseSchema) data = dropOptionalNulls(responseSchema, data);
    const problems = responseSchema ? schemaProblems(responseSchema, data) : [];
    if (problems.length) throw new LlmOutputError('the answer does not fit its schema: ' + problems.slice(0, 3).join('; '), clean.slice(0, 300));
    return data;
  };
  return {
    role, model, timeoutMs,
    // A turn with Claude's server-side web search (26 Nov 2026, the weekly completeness check, audit/completeness.mjs). Returns the final
    // text, the URLs the searches returned, and how many searches ran. Each request is checked against the budget first and recorded on the
    // ledger with its search fee ($10 per 1,000 searches, usage.server_tool_use.web_search_requests). A paused turn (stop_reason
    // "pause_turn") is continued by sending the paused assistant message back unchanged, at most maxContinues times.
    async search({ system, prompt, itemId, maxUses = 10, maxContinues = 4, searchCostUsd = 0.01 }) {
      if (prompt.length + (system || '').length > maxInputChars) throw new InputTooLarge(prompt.length + (system || '').length, maxInputChars);
      const messages = [{ role: 'user', content: prompt }];
      let res = null, searches = 0;
      const urls = new Set();
      for (let round = 0; round <= maxContinues; round++) {
        if (ledger) ledger.assertWithin(itemId);
        res = await api.messages.create({
          model, max_tokens: maxOutputTokens, ...(system ? { system } : {}), ...(effort ? { output_config: { effort } } : {}),
          tools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: maxUses }], messages
        });
        const usage = res.usage || {}, n = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
        searches += n;
        if (ledger) ledger.record({ role, model, itemId, usage: { promptTokenCount: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), candidatesTokenCount: usage.output_tokens || 0, extraCostUsd: n * searchCostUsd } });
        for (const b of res.content || []) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) if (r && r.url) urls.add(r.url);
        if (res.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: res.content });
      }
      if (res.stop_reason === 'refusal') throw new LlmOutputError('the model declined' + (res.stop_details && res.stop_details.category ? ` (${res.stop_details.category})` : ''), JSON.stringify(res.stop_details || {}));
      if (res.stop_reason === 'max_tokens') throw new LlmOutputError('the model stopped early: max_tokens', 'max_tokens');
      if (res.stop_reason === 'pause_turn') throw new LlmOutputError('the search turn did not finish', 'pause_turn');
      const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      log(`${role}/${model}: web search, ${searches} search(es)`);
      return { text, searchedUrls: [...urls], searches };
    },
    // Same call as the Gemini client. responseSchema (a Gemini-style schema, llm/schema.mjs) is sent as the structured-output
    // format, so the reply is exactly one answer of that shape. Forced tool use (tool_choice "tool") would do the same, but the
    // current Sonnet and Opus models refuse it with a 400; output_config.format is the API's route for a JSON-only answer.
    async generate({ system, prompt, itemId, responseSchema }) {
      if (prompt.length + (system || '').length > maxInputChars) throw new InputTooLarge(prompt.length + (system || '').length, maxInputChars);
      if (ledger) ledger.assertWithin(itemId);
      // No temperature: current Claude models reject non-default sampling values. Thinking stays adaptive (the default);
      // effort sets its depth.
      const params = {
        model, max_tokens: maxOutputTokens,
        ...(system ? { system: system + '\n\nReply with one JSON value only, no prose and no code fences.' } : {}),
        ...(effort || responseSchema ? { output_config: { ...(effort ? { effort } : {}), ...(responseSchema ? { format: { type: 'json_schema', schema: toJsonSchema(responseSchema) } } : {}) } } : {}),
        messages: [{ role: 'user', content: prompt }]
      };
      // Streamed (27 Nov 2026): a long bill's answer needs more than 32,000 output tokens (IL SB 315 stopped at max_tokens twice), and the
      // SDK requires streaming for large max_tokens. finalMessage() gives the same message object as create().
      const res = api.messages.stream ? await api.messages.stream(params).finalMessage() : await api.messages.create(params);
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
