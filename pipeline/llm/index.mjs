// One entry point for every provider: createLlmFromConfig with the Claude client wired in.
// config/models.json "provider" picks which one runs ("gemini" for build and tests, "anthropic" in production).
import { createLlmFromConfig as base } from './gemini.mjs';
import { createAnthropic } from './anthropic.mjs';
export { createLedger, createGemini, BudgetExceeded, LlmOutputError, InputTooLarge } from './gemini.mjs';
export { createAnthropic };
export const createLlmFromConfig = (opts) => base({ createAnthropic, ...opts });
