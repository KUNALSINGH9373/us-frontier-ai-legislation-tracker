// Run:  node news/test-safety.mjs
// Lane 1 safety of the news step (review F2, F3, F5): one time budget for the network adapters, a stop after 3 consecutive errors,
// cadence_hours honoured, the Open States daily quota, and no key-looking string in news-health.json. Fake transports only, no network.
import { eventsStep, NEWS_BUDGET_MS } from './run.mjs';
import { emptyState } from './events.mjs';
import { updateHealth, healthText } from './health.mjs';
import { redact, NEWS_FETCH_TIMEOUT_MS } from './sources/common.mjs';
import * as openstates from './sources/openstates.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, info = '') => { if (cond) { pass++; console.log('ok   ' + name); } else { fail++; console.log('FAIL ' + name + (info ? '\n      ' + info : '')); } };
const NOW = new Date('2026-10-29T06:00:00Z');
const hang = () => new Promise(() => {});
const adapter = (fn) => ({ fetchItems: fn });

// a hanging adapter: the step ends at the budget, the adapter is truncated, the rest are not run, nothing throws
{
  const t0 = Date.now();
  const r = await eventsStep({ state: emptyState(), now: NOW, budgetMs: 300, cadenceOf: () => null, http: async () => hang(),
    extra: [['slow', adapter(async ({ http }) => { await http('https://x.example/a'); return { items: [], health: { ok: true } }; })], ['after', adapter(async () => ({ items: [], health: { ok: true, count: 0 } }))]] });
  const ms = Date.now() - t0;
  ok('F2a a hanging transport: the step finishes within the budget (and Lane 1 goes on)', ms < 2000, `${ms} ms`);
  ok('F2a the hanging adapter is recorded truncated; the adapters after it are not run (truncated)', r.results.slow.truncated && r.results.after.truncated && /time budget/.test(r.results.after.errors[0]));
  ok('F2 default budget 6 min, per-call fetch timeout 15 s', NEWS_BUDGET_MS === 360000 && NEWS_FETCH_TIMEOUT_MS === 15000);
}
// a slow, paced adapter (Open States style): past the deadline its transport refuses and its sleeps end at once
{
  let calls = 0;
  const t0 = Date.now();
  const r = await eventsStep({ state: emptyState(), now: NOW, budgetMs: 400, cadenceOf: () => null, http: async () => { calls++; await new Promise((res) => setTimeout(res, 150)); return { status: 200, text: '{}' }; },
    extra: [['paced', adapter(async ({ http, sleep }) => { const errors = []; for (let i = 0; i < 50; i++) { await sleep(6500); try { await http('https://x.example/' + i); } catch (e) { errors.push(e.message); } } return { items: [], health: { ok: errors.length === 0, errors } }; })]] });
  ok('F2a a slow paced adapter stops at the budget, few calls made, health truncated, never thrown', Date.now() - t0 < 3000 && calls < 10 && r.results.paced.truncated, `${Date.now() - t0} ms, ${calls} calls`);
}
// three consecutive errors stop an adapter
{
  let calls = 0;
  const r = await eventsStep({ state: emptyState(), now: NOW, cadenceOf: () => null, http: async () => { calls++; return { status: 503, text: '' }; },
    extra: [['flaky', adapter(async ({ http }) => { const errors = []; for (let i = 0; i < 20; i++) { try { const x = await http('https://x.example/' + i); if (x.status !== 200) errors.push('HTTP ' + x.status); } catch (e) { errors.push(e.message); } } return { items: [], health: { ok: false, errors } }; })], ['next', adapter(async () => ({ items: [], health: { ok: true, count: 0 } }))]] });
  ok('F2b an adapter is stopped after 3 consecutive errors; the next adapter still runs', calls === 3 && r.results.flaky.truncated && r.results.flaky.ok === false && /3 consecutive errors/.test(r.results.flaky.errors.join(' ')) && r.results.next.ok && !r.results.next.truncated, `${calls} calls`);
}
// cadence: a source read within its cadence is skipped; the previous health record stands
{
  let ran = 0;
  const mod = adapter(async () => { ran++; return { items: [], health: { ok: true, count: 0 } }; });
  const last = { daily: '2026-10-29T02:00:00Z' };
  const r = await eventsStep({ state: emptyState(), now: NOW, cadenceOf: (n) => (n === 'daily' ? 24 : null), lastFetch: last, extra: [['daily', mod]] });
  ok('F2c a 24 h source read 4 h ago is not read again (skipped: cadence)', ran === 0 && r.results.daily.skipped === 'cadence');
  const r2 = await eventsStep({ state: emptyState(), now: NOW, cadenceOf: () => 24, lastFetch: { daily: '2026-10-28T06:05:00Z' }, extra: [['daily', mod]] });
  ok('F2c read again once its cadence has passed (a few minutes of slack)', ran === 1 && !r2.results.daily.skipped);
  const h0 = updateHealth({ sources: {} }, { daily: { ok: true, count: 3, newest: '2026-10-28' } }, { now: new Date('2026-10-28T06:00:00Z') });
  const h1 = updateHealth(h0, r.results, { now: NOW });
  ok('F2c a skip keeps the last read record (last_fetch, last_ok, counts) and notes the skip', h1.sources.daily.last_fetch === h0.sources.daily.last_fetch && h1.sources.daily.count === 3 && h1.sources.daily.last_skipped === NOW.toISOString());
}
// F3: the Open States daily quota
{
  let calls = 0;
  const http = { async getJson() { calls++; return { results: [], legislative_sessions: [] }; } };
  const bills = Array.from({ length: 30 }, (_, i) => ({ state: 'CA', number: `SB ${i + 1}`, entry_id: 'x', os_session: '20252026' }));
  const r = await openstates.fetchItems({ http, env: { OPENSTATES_API_KEY: 'k-123456' }, entries: bills, state: { quota: { day: '2026-10-29', used: 395 } }, config: { openstates: { min_interval_ms: 0 } }, now: NOW, sleep: async () => {} });
  ok('F3 Open States stops at 400 requests per UTC day (395 already used: 5 more)', calls === 5 && r.health.truncated && r.state.quota.used === 400 && /daily cap 400/.test(r.health.errors.join(' ')));
  calls = 0;
  const r2 = await openstates.fetchItems({ http, env: { OPENSTATES_API_KEY: 'k-123456' }, entries: bills.slice(0, 3), state: { quota: { day: '2026-10-28', used: 400 } }, config: { openstates: { min_interval_ms: 0 } }, now: NOW, sleep: async () => {} });
  ok('F3 a new UTC day starts the count again', calls === 3 && r2.state.quota.day === '2026-10-29' && r2.state.quota.used === 3);
}
// F5: no key reaches news-health.json
{
  const secret = 'abcDEF123456secret';
  ok('F5 redact: key=, apikey=, api_key=, token= query values', ['https://legislation.nysenate.gov/api/3/bills?key=zzz999&view=x', 'u?apikey=zzz999', 'u?api_key=zzz999', 'u?a=1&token=zzz999'].every((u) => !redact(u).includes('zzz999') && /REDACTED/.test(redact(u))));
  const h = updateHealth({ sources: {} }, { nysenate: { ok: false, errors: [`HTTP 500 https://legislation.nysenate.gov/api/3/bills/2025?key=${secret}`, `fetch failed for ${secret}`, 'GET /x?apikey=QQQ777 failed'] } }, { now: NOW });
  const text = healthText(h, [secret]);
  ok('F5 news-health.json text has no key value, whatever the error string', !text.includes(secret) && !text.includes('QQQ777') && /REDACTED/.test(text));
}

console.log(`news safety: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
