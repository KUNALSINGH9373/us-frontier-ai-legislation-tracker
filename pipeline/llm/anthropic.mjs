// A small Claude client with the same shape as the Gemini one (llm/gemini.mjs), so the agents need no change
// when config/models.json switches "provider" to "anthropic".
// - JSON output only, validated by the caller against our own schemas
// - every call is counted on the shared ledger and checked against the budget BEFORE it is made
// - the key comes from the environment and never appears in logs (the SDK sends it in a header)
// Production runs on Claude; build and tests run on Gemini (owner's decision, 15 Oct 2026).
// Each attempt times out after 2 minutes (the SDK default is 10), so a stuck call cannot hold a scheduled run for an hour.
import Anthropic from '@anthropic-ai/sdk';
import { LlmOutputError, InputTooLarge } from './gemini.mjs';

export function createAnthropic({ apiKey, client, role, model, maxOutputTokens = 4000, effort = null, ledger, maxInputChars = 120000, log = () => {} }) {
  const api = client || new Anthropic({ apiKey, maxRetries: 3, timeout: 120000 });
  const parseJson = (text) => {
    const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(clean); } catch (e) {
      // A model sometimes puts a sentence before or after its JSON (Opus as referee, 30 Oct 2026 re-test): the one JSON object in the
      // text is used. The callers still check every field of it; anything else is still an unusable answer.
      const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
      if (a >= 0 && b > a) { try { return JSON.parse(clean.slice(a, b + 1)); } catch (e2) { /* falls through */ } }
      throw new LlmOutputError('the model did not return valid JSON', clean.slice(0, 300));
    }
  };
  return {
    role, model,
    // Same call as the Gemini client. responseSchema (a Gemini-style schema) is not sent: the prompts already ask for
    // JSON and the callers validate the result against our own schemas.
    async generate({ system, prompt, itemId }) {
      if (prompt.length + (system || '').length > maxInputChars) throw new InputTooLarge(prompt.length + (system || '').length, maxInputChars);
      if (ledger) ledger.assertWithin(itemId);
      // No temperature: current Claude models reject non-default sampling values. Thinking stays adaptive (the default);
      // effort sets its depth.
      const res = await api.messages.create({
        model, max_tokens: maxOutputTokens,
        ...(system ? { system: system + '\n\nReply with one JSON value only, no prose and no code fences.' } : {}),
        ...(effort ? { output_config: { effort } } : {}),
        messages: [{ role: 'user', content: prompt }]
      });
      const usage = res.usage || {};
      if (ledger) ledger.record({ role, model, itemId, usage: { promptTokenCount: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), candidatesTokenCount: usage.output_tokens || 0 } });
      if (res.stop_reason === 'refusal') throw new LlmOutputError('the model declined' + (res.stop_details && res.stop_details.category ? ` (${res.stop_details.category})` : ''), JSON.stringify(res.stop_details || {}));
      if (res.stop_reason === 'max_tokens') throw new LlmOutputError('the model stopped early: max_tokens', 'max_tokens');
      const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text.trim()) throw new LlmOutputError('the model returned an empty answer');
      log(`${role}/${model}: ${usage.input_tokens || 0} in, ${usage.output_tokens || 0} out`);
      return { data: parseJson(text), text, usage, finishReason: res.stop_reason || 'end_turn' };
    }
  };
}
