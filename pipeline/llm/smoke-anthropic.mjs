// One real call to Claude to confirm the key, the model and the client work end to end. Costs a fraction of a cent.
// Run once before switching config/models.json "provider" to "anthropic" (and again after any model change).
//   node llm/smoke-anthropic.mjs [model]        default: config/models.json anthropic.roles.screener.model
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../grabber/lib/env.mjs';
import { createAnthropic, createLedger } from './index.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const env = loadEnv(path.join(here, '..'));
if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set (looked for a .env file upward from pipeline/; found: ' + (env.path || 'none') + ')'); process.exit(2); }
const config = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'models.json'), 'utf8'));
const role = config.anthropic.roles.screener, model = process.argv[2] || role.model;
const ledger = createLedger({ prices: config.prices_per_million_tokens });
const llm = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY, role: 'smoke', model, maxOutputTokens: 1000, effort: 'low', ledger, log: (m) => console.log('  ' + m) });

const bill = 'Section 2. A "frontier model" means a foundation model trained using greater than 10^26 integer or floating-point operations. A large frontier developer shall report a critical safety incident to the Attorney General within 72 hours.';
const t0 = Date.now();
const r = await llm.generate({
  system: 'You read bill text. Answer as JSON: {"compute_threshold": string, "reporting_deadline_hours": number, "quote": string} where quote is copied word for word from the text.',
  prompt: bill,
  responseSchema: { type: 'OBJECT', required: ['compute_threshold', 'reporting_deadline_hours', 'quote'], properties: { compute_threshold: { type: 'STRING' }, reporting_deadline_hours: { type: 'NUMBER' }, quote: { type: 'STRING' } } }
});
const okQuote = typeof r.data.quote === 'string' && bill.includes(r.data.quote);
console.log(JSON.stringify(r.data, null, 1));
console.log(`model ${model} | ${Date.now() - t0} ms | stop ${r.finishReason} | quote found in text: ${okQuote} | deadline 72: ${r.data.reporting_deadline_hours === 72}`);
console.log('usage', JSON.stringify(ledger.totals()));
process.exit(okQuote && r.data.reporting_deadline_hours === 72 ? 0 : 1);
