// One way to get an AI client, for every caller (grabber title screen, scope check, agents, recall scripts).
// It reads config/models.json "provider" ("anthropic" in production, "gemini" for testing), builds one shared ledger that
// saves every call to the month's spend log and refuses calls once the monthly cost cap is reached.
import path from 'path';
import { fileURLToPath } from 'url';
import { createHttp } from '../grabber/lib/http.mjs';
import { createLlmFromConfig, createLedger } from './index.mjs';
import { createSpend } from './spend.mjs';

export const DEFAULT_SPEND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'ledger');
export const keyNameOf = (provider) => (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY');

// models: the parsed config/models.json. limits: override the token limits (scope-check has its own).
export function createLlmFactory({ models, limits = models.limits, dir = DEFAULT_SPEND_DIR, now = () => new Date(), env = process.env, log = () => {}, fetchImpl } = {}) {
  const provider = models.provider, key = env[keyNameOf(provider)] || '';
  const spend = createSpend({ dir, now });
  const cap = models.monthly_cost_cap_usd || null, warnFraction = models.monthly_warn_fraction || 0.8;
  const ledger = createLedger({ limits, prices: models.prices_per_million_tokens, monthly: cap ? { capUsd: cap, spentBefore: spend.monthTotal() } : null, onCall: (c) => spend.append(c) });
  // Gemini goes through our HTTP client (key in a header, scrubbed from errors); Claude's SDK does its own HTTP, so the shared object is only a key for the ledger.
  const http = provider === 'anthropic' ? {} : createHttp({ headers: { 'x-goog-api-key': key }, secrets: [key], maxRequests: 200, timeoutMs: 180000, ...(fetchImpl ? { fetchImpl } : {}), log });
  return {
    provider, ledger, spend, hasKey: !!key, keyName: keyNameOf(provider), cap, warnFraction,
    // null when there is no key (callers then run without AI, e.g. the title screen treats every title as "maybe").
    make: (role) => (key ? createLlmFromConfig({ config: { ...models, limits }, apiKey: key, claudeKey: provider === 'anthropic' ? key : undefined, http, role, log, ledger }).llm : null),
    monthStatus: () => spend.status({ cap, warnFraction })
  };
}

// The model name a role uses under the configured provider (for report headings).
export const roleModel = (models, role) => ((models.provider === 'anthropic' ? (models.anthropic || {}).roles : models.roles) || {})[role]?.model || '?';
