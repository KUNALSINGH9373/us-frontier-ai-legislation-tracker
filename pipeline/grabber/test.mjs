// Run:  node grabber/test.mjs   (or npm run test:grabber)
// A fake Congress.gov server proves the Grabber's behaviour without any live call.
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { runCongress } from './run.mjs';
import { createHttp, HttpError, QuotaExceeded } from './lib/http.mjs';
import { loadEnv } from './lib/env.mjs';
import { readState, writeState, emptyState } from './lib/state.mjs';
import { makeValidator } from '../schema/validate.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-'));
const KEY = 'SECRET-KEY-DO-NOT-LEAK-123';
const NOW = new Date('2026-10-06T12:00:00Z');
const scope = { title_terms: ['artificial intelligence', '\\bAI\\b', 'frontier'], max_candidates_per_run: 40 };

// ---------- the fake server ----------
function fakeServer({ bills, failures = {}, log = [] }) {
  const sleeps = [];
  const resp = (status, body, headersOrText = {}) => { const isText = typeof headersOrText === 'string'; const headers = isText ? {} : headersOrText; return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] }, json: async () => body, text: async () => (isText ? headersOrText : JSON.stringify(body)) }; };
  const fetchImpl = async (url, init) => {
    log.push({ url, headers: init.headers });
    const u = new URL(url), p = u.pathname.replace('/v3', ''), q = u.searchParams;
    const f = failures[p]; if (f && f.times > 0) { f.times--; return resp(f.status, f.body || { error: 'x ' + (f.leak || '') }, f.headers); }
    if (p === '/bill') {
      let list = bills.filter((b) => b.updateDate >= q.get('fromDateTime') && b.updateDate <= q.get('toDateTime')).sort((a, b) => a.updateDate.localeCompare(b.updateDate));
      const off = +q.get('offset') || 0, lim = +q.get('limit');
      return resp(200, { bills: list.slice(off, off + lim), pagination: { count: list.length } });
    }
    const tx = /^\/bill\/(\d+)\/([a-z]+)\/(\d+)\/text$/.exec(p);
    if (tx) {
      if (failures['/text']) return resp(failures['/text'], { error: 'no text' });
      return resp(200, { textVersions: [{ date: '2026-10-01T04:00:00Z', type: 'Introduced in Senate', formats: [{ type: 'PDF', url: `https://www.congress.gov/x/${tx[3]}.pdf` }, { type: 'Formatted Text', url: `https://www.congress.gov/119/bills/${tx[3]}.htm` }] }] });
    }
    if (u.hostname === 'www.congress.gov' && p.endsWith('.htm')) return resp(200, {}, '<html><body><pre>[S. ' + p.split('/').pop() + ']\nA BILL To establish a Department &amp; regulate advanced AI.</pre></body></html>');
    const m = /^\/bill\/(\d+)\/([a-z]+)\/(\d+)(\/actions|\/summaries)?$/.exec(p);
    if (m) {
      const b = bills.find((x) => String(x.congress) === m[1] && x.type.toLowerCase() === m[2] && String(x.number) === m[3]);
      if (!b) return resp(404, { error: 'not found' });
      if (m[4] === '/actions') return resp(200, { actions: [{ actionDate: b.latestAction.actionDate, text: b.latestAction.text }] });
      if (m[4] === '/summaries') return resp(200, { summaries: [{ text: 'Official summary of ' + b.title }] });
      return resp(200, { bill: { ...b, introducedDate: '2026-09-01', sponsors: [{ fullName: 'Rep. Example' }] } });
    }
    return resp(404, {});
  };
  return { fetchImpl, sleeps, sleep: async (ms) => { sleeps.push(ms); }, log };
}
const bill = (n, title, updateDate, type = 'HR', congress = 119) => ({ congress, type, number: String(n), title, updateDate, updateDateIncludingText: updateDate, latestAction: { actionDate: updateDate.slice(0, 10), text: 'Referred to committee' } });
const mk = (srv, extra = {}) => createHttp({ fetchImpl: srv.fetchImpl, sleep: srv.sleep, headers: { 'X-Api-Key': KEY }, secrets: [KEY], ...extra });
const trackedEntries = [{ key: 'us-hr-9925', identifiers: { external: { congress_gov: ['119/hr/9925'] } } }];
const baseBills = () => [
  bill(9925, 'FRONTIER Artificial Intelligence Act', '2026-10-02T10:00:00Z'),
  bill(7001, 'Frontier AI Safety Transparency Act', '2026-10-03T10:00:00Z'),
  bill(5555, 'A bill to rename a post office', '2026-10-04T10:00:00Z'),
  bill(1111, 'A bill about old news', '2026-09-20T10:00:00Z')            // before the cursor: must never be looked at
];

// ---------- 1. a normal run ----------
{
  const srv = fakeServer({ bills: baseBills() }), out = tmp();
  const r = await runCongress({ http: mk(srv), state: emptyState(), entries: trackedEntries, scope, outDir: out, now: NOW });
  const ids = r.changeset.items.map((i) => i.source_id).sort();
  ok('finds the tracked bill and the AI candidate, skips the post office and the pre-cursor bill', JSON.stringify(ids) === JSON.stringify(['119/hr/7001', '119/hr/9925']), JSON.stringify(ids));
  const t = r.changeset.items.find((i) => i.source_id === '119/hr/9925'), c = r.changeset.items.find((i) => i.source_id === '119/hr/7001');
  ok('tracked bill is matched to its entry key and marked changed', t.entry_key === 'us-hr-9925' && t.change === 'changed' && t.reason === 'updated_since_cursor');
  ok('new candidate has no entry key and is marked new/discovery', c.entry_key === null && c.change === 'new' && c.reason === 'discovery');
  ok('stats add up', r.stats.listed === 3 && r.stats.tracked_changed === 1 && r.stats.candidates === 1 && r.stats.screened_out === 1, JSON.stringify(r.stats));
  ok('raw source text was saved and its hash matches', r.changeset.items.every((i) => { const f = path.join(out, r.runId, i.raw_path); return fs.existsSync(f) && i.raw_hash === require_sha(fs.readFileSync(f, 'utf8')); }));
  ok('change set passes its schema and was written to disk', makeValidator().check('changeset', JSON.parse(fs.readFileSync(path.join(out, r.runId, 'changeset.json'), 'utf8'))).length === 0);
  ok('cursor moved to the end of the window', r.cursor === '2026-10-06T11:58:00Z', r.cursor);
  ok('the API key was sent in the header and never in a URL', srv.log.every((l) => l.headers['X-Api-Key'] === KEY && !l.url.includes(KEY)));
  ok('one list call, three per collected bill, and two more (text list and text) for the new candidate only', r.requests === 1 + 3 + (3 + 2), String(r.requests));
  // ---------- 2. same data again: nothing new ----------
  const srv2 = fakeServer({ bills: baseBills() });
  const r2 = await runCongress({ http: mk(srv2), state: r.nextState, entries: trackedEntries, scope, outDir: out, now: new Date(+NOW + 3600e3), since: '2026-09-29T00:00:00Z' });
  ok('a second run over the same data yields an empty change set', r2.changeset.items.length === 0 && r2.stats.unchanged === 2, JSON.stringify(r2.stats));
  ok('and costs only the list call', r2.requests === 1, String(r2.requests));
  // ---------- 3. a bill changes ----------
  const moved = baseBills(); moved[0] = { ...moved[0], updateDate: '2026-10-06T08:00:00Z', updateDateIncludingText: '2026-10-06T08:00:00Z', latestAction: { actionDate: '2026-10-06', text: 'Passed House' } };
  const r3 = await runCongress({ http: mk(fakeServer({ bills: moved })), state: r.nextState, entries: trackedEntries, scope, outDir: out, now: new Date(+NOW + 7200e3), since: '2026-09-29T00:00:00Z' });
  ok('a changed bill is picked up again', r3.changeset.items.length === 1 && r3.changeset.items[0].source_id === '119/hr/9925');
}
function require_sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ---------- 4. no changes at all ----------
{
  const r = await runCongress({ http: mk(fakeServer({ bills: [] })), state: emptyState(), entries: [], scope, outDir: tmp(), now: NOW });
  ok('an empty window gives an empty change set and still advances the cursor', r.changeset.items.length === 0 && r.cursor === '2026-10-06T11:58:00Z' && r.requests === 1);
}

// ---------- 5. paging ----------
{
  const many = []; for (let i = 0; i < 520; i++) many.push(bill(20000 + i, 'Unrelated bill ' + i, '2026-10-01T' + String(Math.floor(i / 60)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0') + ':00Z'));
  many.push(bill(7777, 'Artificial Intelligence Risk Act', '2026-10-05T10:00:00Z'));
  const srv = fakeServer({ bills: many });
  const r = await runCongress({ http: mk(srv), state: emptyState(), entries: [], scope, outDir: tmp(), now: NOW });
  ok('reads every page (3 pages for 521 bills)', r.stats.listed === 521 && srv.log.filter((l) => /\/bill\?/.test(l.url)).length === 3, JSON.stringify(r.stats));
  ok('still finds the one relevant bill among 521', r.changeset.items.length === 1 && r.changeset.items[0].source_id === '119/hr/7777');
}

// ---------- 6. the request budget stops a run cleanly and resumably ----------
{
  const bills = []; for (let i = 0; i < 6; i++) bills.push(bill(30000 + i, 'Frontier AI Act ' + i, `2026-10-0${i + 1}T10:00:00Z`));
  const r = await runCongress({ http: mk(fakeServer({ bills }), { maxRequests: 8 }), state: emptyState(), entries: [], scope, outDir: tmp(), now: NOW });
  ok('stops when the budget is used up and says so', r.truncated === true && r.requests === 8);
  ok('keeps what it already collected', r.changeset.items.length >= 1 && r.changeset.items.length < 6, String(r.changeset.items.length));
  ok('cursor stops at the last bill it finished, not at the end of the window', r.cursor < '2026-10-06T11:58:00Z' && r.cursor >= '2026-10-01T10:00:00Z', r.cursor);
  const r2 = await runCongress({ http: mk(fakeServer({ bills })), state: r.nextState, entries: [], scope, outDir: tmp(), now: new Date(+NOW + 600e3) });
  const got = new Set([...r.changeset.items, ...r2.changeset.items].map((i) => i.source_id));
  ok('the next run picks up exactly where it stopped, so nothing is lost', got.size === 6, String(got.size));
}

// ---------- 7. candidate cap ----------
{
  const bills = []; for (let i = 0; i < 5; i++) bills.push(bill(40000 + i, 'Frontier AI Act ' + i, `2026-10-0${i + 1}T10:00:00Z`));
  const r = await runCongress({ http: mk(fakeServer({ bills })), state: emptyState(), entries: [], scope: { ...scope, max_candidates_per_run: 2 }, outDir: tmp(), now: NOW });
  ok('stops at the candidate cap and flags it', r.changeset.items.length === 2 && r.stats.over_candidate_cap === 1 && r.truncated);
}

// ---------- 8. errors ----------
{
  const srv = fakeServer({ bills: baseBills(), failures: { '/bill': { status: 429, times: 2, headers: { 'retry-after': '3' } } } });
  const r = await runCongress({ http: mk(srv), state: emptyState(), entries: trackedEntries, scope, outDir: tmp(), now: NOW });
  ok('rate limit (429): waits as told by Retry-After, then succeeds', srv.sleeps.slice(0, 2).every((ms) => ms === 3000) && r.changeset.items.length === 2, JSON.stringify(srv.sleeps));
}
{
  const srv = fakeServer({ bills: baseBills(), failures: { '/bill': { status: 503, times: 1 } } });
  const r = await runCongress({ http: mk(srv), state: emptyState(), entries: trackedEntries, scope, outDir: tmp(), now: NOW });
  ok('server error (503): retries with a growing wait, then succeeds', srv.sleeps[0] === 2000 && r.changeset.items.length === 2);
}
{
  const srv = fakeServer({ bills: baseBills(), failures: { '/bill': { status: 500, times: 99 } } });
  let err; const state = emptyState();
  try { await runCongress({ http: mk(srv, { retries: 2 }), state, entries: [], scope, outDir: tmp(), now: NOW }); } catch (e) { err = e; }
  ok('a persistent failure stops the run with an error', err instanceof HttpError && err.status === 500);
  ok('and leaves the saved state untouched', JSON.stringify(state) === JSON.stringify(emptyState()));
}
{
  const srv = fakeServer({ bills: baseBills(), failures: { '/bill': { status: 403, times: 1, leak: KEY } } });
  let err; try { await runCongress({ http: mk(srv), state: emptyState(), entries: [], scope, outDir: tmp(), now: NOW }); } catch (e) { err = e; }
  ok('a non-retryable error (403) fails at once', err instanceof HttpError && err.status === 403 && srv.sleeps.length === 0);
  ok('the API key is scrubbed from the error text', err && !err.message.includes(KEY) && !String(err.body).includes(KEY), String(err && err.body));
}
{
  const srv = fakeServer({ bills: baseBills() });
  let err; try { await runCongress({ http: mk(srv), state: emptyState(), entries: [], scope, outDir: tmp(), now: NOW, bills: ['119/hr/424242'] }); } catch (e) { err = e; }
  ok('asking for a bill that does not exist fails clearly (404)', err instanceof HttpError && err.status === 404);
}
{
  const http = createHttp({ fetchImpl: async () => { throw new Error('socket hang up with ' + KEY); }, sleep: async () => {}, secrets: [KEY], retries: 1 });
  let err; try { await http.getJson('https://example.test/x'); } catch (e) { err = e; }
  ok('network errors are retried, then reported without the key', err && /socket hang up/.test(err.message) && !err.message.includes(KEY));
}

// ---------- 9. specific bills (reconciliation) ----------
{
  const r = await runCongress({ http: mk(fakeServer({ bills: baseBills() })), state: emptyState(), entries: trackedEntries, scope, outDir: tmp(), now: NOW, bills: ['119/hr/9925', '119/hr/7001'] });
  ok('fetching named bills marks them reconcile and does not move the cursor', r.changeset.items.length === 2 && r.changeset.items.every((i) => i.reason === 'reconcile') && r.cursor === '2026-09-29T00:00:00Z');
  ok('a named bill we track keeps its entry key', r.changeset.items.find((i) => i.source_id === '119/hr/9925').entry_key === 'us-hr-9925');
}

// ---------- 10. state file and key loader ----------
{
  const d = tmp(), f = path.join(d, 'state.json');
  ok('a missing state file reads as empty', JSON.stringify(readState(f)) === JSON.stringify(emptyState()));
  const s = { version: 1, sources: { congress_gov: { last_success: '2026-10-06T12:00:00Z', cursor: '2026-10-06T11:58:00Z', hashes: { '119/hr/9925': 'abc' } } } };
  writeState(f, s); ok('state round-trips', JSON.stringify(readState(f)) === JSON.stringify(s));
  let bad; try { writeState(f, { version: 1, sources: { congress_gov: { last_success: 'yesterday' } } }); } catch (e) { bad = e; }
  ok('refuses to write an invalid state', !!bad && JSON.parse(fs.readFileSync(f, 'utf8')).sources.congress_gov.cursor === '2026-10-06T11:58:00Z');
  ok('no temp file is left behind', !fs.existsSync(f + '.tmp'));
}
{
  const d = tmp(); fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(d, '.env'), '# comment\nTEST_ENV_A = spaced value\nTEST_ENV_B="quoted"\nexport TEST_ENV_C=plain\n\nTEST_ENV_D=fromfile\n');
  process.env.TEST_ENV_D = 'fromshell';
  const r = loadEnv(path.join(d, 'a', 'b'));
  ok('finds .env in a parent folder and reads "KEY = value", quotes and export', r.path === path.join(d, '.env') && process.env.TEST_ENV_A === 'spaced value' && process.env.TEST_ENV_B === 'quoted' && process.env.TEST_ENV_C === 'plain');
  ok('a real environment variable wins over the file', process.env.TEST_ENV_D === 'fromshell');
  ok('reports names only, never values', r.names.includes('TEST_ENV_A') && !JSON.stringify(r).includes('spaced value'));
}

// ---------- 11. the bill's own text, for new candidates only ----------
{
  const srv = fakeServer({ bills: baseBills() }), out = tmp();
  const r = await runCongress({ http: mk(srv), state: emptyState(), entries: trackedEntries, scope, outDir: out, now: NOW });
  const rawOf = (id) => JSON.parse(fs.readFileSync(path.join(out, r.runId, r.changeset.items.find((i) => i.source_id === id).raw_path), 'utf8'));
  const cand = rawOf('119/hr/7001'), tr = rawOf('119/hr/9925');
  ok('a new candidate carries the bill text, as plain text', !!cand.text && /A BILL To establish a Department & regulate advanced AI\./.test(cand.text) && !/<pre>/.test(cand.text) && cand.text_missing === false, String(cand.text));
  ok('a tracked bill\'s update does not spend requests on the text', tr.text === undefined && !srv.log.some((l) => /9925\/text/.test(l.url)));
}
{
  const srv = fakeServer({ bills: baseBills(), failures: { '/text': 404 } });
  const r = await runCongress({ http: mk(srv), state: emptyState(), entries: [], scope, outDir: tmp(), now: NOW });
  ok('if the bill text is not published yet, the candidate is still collected', r.changeset.items.length === 2 && r.stats.candidates === 2, JSON.stringify(r.stats));
}
{
  // A genuine bug (not a network or HTTP problem) must not be mistaken for "text unavailable".
  const srv = fakeServer({ bills: baseBills() });
  const http = mk(srv);
  const orig = http.getText; http.getText = async () => { throw new TypeError('a real bug'); };
  let err; try { await runCongress({ http, state: emptyState(), entries: [], scope, outDir: tmp(), now: NOW }); } catch (e) { err = e; }
  ok('a programming error while fetching text stops the run instead of being hidden', err instanceof TypeError && /real bug/.test(err.message), String(err));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
