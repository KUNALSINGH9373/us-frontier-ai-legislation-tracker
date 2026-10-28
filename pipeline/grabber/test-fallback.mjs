// Run:  node grabber/test-fallback.mjs
// Two Congress.gov behaviours, proved with a fake server and no live call:
//   1. the date-filtered list is down (HTTP 503): the plain list, newest first, gives exactly the same bills in the same order;
//   2. a new bill without its text waits in data/waiting-for-text.json and is collected on the run its text appears.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCongress, CONGRESS } from './run.mjs';
import { createCongress } from './sources/congress.mjs';
import { createHttp } from './lib/http.mjs';
import { emptyState } from './lib/state.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-'));
const NOW = new Date('2026-10-28T12:00:00Z');
const scope = { title_terms: ['artificial intelligence', '\\bAI\\b', 'frontier'], max_candidates_per_run: 40 };
const resp = (status, body, text) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (text != null ? text : JSON.stringify(body)) });

// filterDown: the date-filtered list answers 503 (always, or only from that offset on). texts: bill number -> has a text.
function fakeServer({ bills, filterDown = false, downFrom = 0, texts = {}, log = [] }) {
  const fetchImpl = async (url) => {
    log.push(url);
    const u = new URL(url), p = u.pathname.replace('/v3', ''), q = u.searchParams;
    if (p === '/bill') {
      const off = +q.get('offset') || 0, lim = +q.get('limit');
      if (q.get('fromDateTime')) {
        if (filterDown && off >= downFrom) return resp(503, null, '<html>503 Service Unavailable</html>');
        const list = bills.filter((b) => b.updateDate >= q.get('fromDateTime') && b.updateDate <= q.get('toDateTime')).sort((a, b) => a.updateDate.localeCompare(b.updateDate));
        return resp(200, { bills: list.slice(off, off + lim), pagination: { count: list.length } });
      }
      const list = [...bills].sort((a, b) => b.updateDate.localeCompare(a.updateDate)); // the plain list: every bill, newest first
      return resp(200, { bills: list.slice(off, off + lim), pagination: { count: list.length } });
    }
    const tx = /^\/bill\/(\d+)\/([a-z]+)\/(\d+)\/text$/.exec(p);
    if (tx) return resp(200, { textVersions: texts[tx[3]] ? [{ date: '2026-10-20T04:00:00Z', type: 'Introduced in House', formats: [{ type: 'Formatted Text', url: `https://www.congress.gov/119/bills/${tx[3]}.htm` }] }] : [] });
    if (u.hostname === 'www.congress.gov' && p.endsWith('.htm')) return resp(200, {}, '<html><body><pre>A BILL To regulate frontier artificial intelligence models.</pre></body></html>');
    const m = /^\/bill\/(\d+)\/([a-z]+)\/(\d+)(\/actions|\/summaries)?$/.exec(p);
    if (m) {
      const b = bills.find((x) => String(x.congress) === m[1] && x.type.toLowerCase() === m[2] && String(x.number) === m[3]);
      if (!b) return resp(404, { error: 'not found' });
      if (m[4] === '/actions') return resp(200, { actions: [{ actionDate: b.latestAction.actionDate, text: b.latestAction.text }] });
      if (m[4] === '/summaries') return resp(200, { summaries: [] });
      return resp(200, { bill: { ...b, introducedDate: '2026-10-01', sponsors: [{ fullName: 'Rep. Example' }] } });
    }
    return resp(404, {});
  };
  return { fetchImpl, log };
}
const mk = (srv, extra = {}) => createHttp({ fetchImpl: srv.fetchImpl, sleep: async () => {}, retries: 2, ...extra });
const bill = (n, title, updateDate, congress = 119) => ({ congress, type: 'HR', number: String(n), title, updateDate, updateDateIncludingText: updateDate, latestAction: { actionDate: updateDate.slice(0, 10), text: 'Referred to committee' } });

// ---------- 1. the fallback gives the identical stream ----------
{
  // 7 bills in the window (one of an older Congress, two with the same timestamp), 2 before it, 1 after it; page size 3
  const bills = [
    bill(1, 'A', '2026-10-20T01:00:00Z'), bill(2, 'B', '2026-10-21T01:00:00Z'), bill(3, 'C', '2026-10-21T01:00:00Z', 118), bill(4, 'D', '2026-10-22T05:00:00Z'),
    bill(5, 'E', '2026-10-23T05:00:00Z'), bill(6, 'F', '2026-10-24T05:00:00Z'), bill(7, 'G', '2026-10-25T05:00:00Z'),
    bill(8, 'old', '2026-10-10T01:00:00Z'), bill(9, 'older', '2026-09-30T01:00:00Z'), bill(10, 'too new', '2026-10-28T11:59:00Z')
  ];
  const window = { from: '2026-10-19T00:00:00Z', to: '2026-10-28T11:58:00Z', pageSize: 3, congress: CONGRESS };
  const list = async (srv) => { const out = [], info = []; for await (const b of createCongress(mk(srv)).listUpdated({ ...window, onFallback: (f) => info.push(f) })) out.push(`${b.congress}/${b.number}@${b.updateDate}`); return { out, info }; };
  const a = await list(fakeServer({ bills }));
  const b = await list(fakeServer({ bills, filterDown: true }));
  ok('the filtered list gives the 6 bills of this Congress in the window, oldest first', a.out.length === 6 && a.out[0].startsWith('119/1@') && a.out[5].startsWith('119/7@') && !a.out.some((x) => x.startsWith('118/')), JSON.stringify(a.out));
  ok('the fallback gives the identical stream', JSON.stringify(a.out) === JSON.stringify(b.out), JSON.stringify(b.out));
  ok('the fallback is reported once, with the reason; the healthy path reports nothing', a.info.length === 0 && b.info.length === 1 && /HTTP 503/.test(b.info[0].reason) && b.info[0].bills === 6, JSON.stringify(b.info));
  ok('the fallback stops paging at the first bill older than the window', b.info[0].pages === 3, String(b.info[0].pages)); // 10 bills newest first, 3 a page: the 3rd page holds the first old one
  const c = await list(fakeServer({ bills, filterDown: true, downFrom: 3 })); // the first page works, then the filter fails
  ok('a filter that fails mid-way: no bill twice, none missed, same order', JSON.stringify(a.out) === JSON.stringify(c.out), JSON.stringify(c.out));
  // a 4xx is a real error (bad request, bad key), never a reason to fall back
  const bad = { fetchImpl: async () => resp(403, { error: 'forbidden' }) };
  let threw = null; try { for await (const x of createCongress(mk(bad)).listUpdated(window)) void x; } catch (e) { threw = e; }
  ok('a 4xx on the filtered list is not hidden by the fallback', threw && threw.status === 403);

  // through the whole Grabber run: the same change set either way, and the stats say the fallback was used
  const entries = [{ key: 'us-hr-4', identifiers: { external: { congress_gov: ['119/hr/4'] } } }];
  const fr = [bill(4, 'Tracked bill', '2026-10-22T05:00:00Z'), bill(20, 'Frontier Artificial Intelligence Safety Act', '2026-10-23T05:00:00Z'), bill(21, 'Post office', '2026-10-24T05:00:00Z'), bill(22, 'old', '2026-10-01T00:00:00Z')];
  const texts = { 20: true };
  const r1 = await runCongress({ http: mk(fakeServer({ bills: fr, texts })), state: emptyState(), entries, scope, outDir: tmp(), now: NOW, since: '2026-10-19T00:00:00Z' });
  const r2 = await runCongress({ http: mk(fakeServer({ bills: fr, texts, filterDown: true })), state: emptyState(), entries, scope, outDir: tmp(), now: NOW, since: '2026-10-19T00:00:00Z' });
  const strip = (r) => r.changeset.items.map((i) => [i.item_id, i.change, i.reason, i.raw_hash === undefined ? null : 'h']);
  ok('a Grabber run over the fallback writes the same change set', JSON.stringify(strip(r1)) === JSON.stringify(strip(r2)) && r1.changeset.items.length === 2, JSON.stringify(strip(r2)));
  ok('and the same cursor', r1.cursor === r2.cursor, `${r1.cursor} ${r2.cursor}`);
  ok('the stats say the fallback was used (for the run report)', r2.stats.list_fallback === true && r2.stats.fallback_pages >= 1 && !r1.stats.list_fallback, JSON.stringify(r2.stats));
  // the budget runs out while the fallback is paging: nothing was processed, so the cursor does not move
  const r3 = await runCongress({ http: mk(fakeServer({ bills: fr, filterDown: true }), { maxRequests: 3 }), state: emptyState(), entries, scope, outDir: tmp(), now: NOW, since: '2026-10-19T00:00:00Z' });
  ok('a run cut off before any bill keeps its cursor', r3.truncated && r3.cursor === '2026-10-19T00:00:00Z', `${r3.truncated} ${r3.cursor}`);
}

// ---------- 2. waiting for text ----------
{
  const entries = [];
  const hr = bill(10768, 'Frontier Artificial Intelligence Accountability Act', '2026-10-20T05:00:00Z');
  // run 1: listed, no text yet -> collected (text_missing) and put on the waiting list
  const out = tmp();
  const r1 = await runCongress({ http: mk(fakeServer({ bills: [hr], texts: {} })), state: emptyState(), entries, scope, outDir: out, now: NOW, since: '2026-10-19T00:00:00Z' });
  const raw1 = JSON.parse(fs.readFileSync(path.join(out, r1.runId, r1.changeset.items[0].raw_path), 'utf8'));
  ok('a new bill without text is collected with text_missing and starts waiting', raw1.text_missing === true && r1.nextWaiting['congress_gov:119/hr/10768'] && r1.nextWaiting['congress_gov:119/hr/10768'].since === '2026-10-28', JSON.stringify(r1.nextWaiting));
  // run 2: not listed again (no update), still no text -> asked once, still waiting
  const later = new Date(+NOW + 86400e3), log2 = [];
  const r2 = await runCongress({ http: mk(fakeServer({ bills: [hr], texts: {}, log: log2 })), state: r1.nextState, entries, scope, outDir: tmp(), now: later, waiting: r1.nextWaiting });
  ok('the next run asks for its text directly (one call) and keeps it waiting', r2.changeset.items.length === 0 && r2.stats.waiting_checked === 1 && log2.filter((u) => /10768\/text/.test(u)).length === 1 && r2.nextWaiting['congress_gov:119/hr/10768'].checks === 2 && r2.nextWaiting['congress_gov:119/hr/10768'].last_checked === '2026-10-29', JSON.stringify(r2.nextWaiting));
  // run 3: the text is published, the bill is not listed (its updateDate did not move) -> collected as a new candidate, with its text
  const out3 = tmp();
  const r3 = await runCongress({ http: mk(fakeServer({ bills: [hr], texts: { 10768: true } })), state: r2.nextState, entries, scope, outDir: out3, now: new Date(+later + 86400e3), waiting: r2.nextWaiting });
  const it = r3.changeset.items[0], raw3 = it && JSON.parse(fs.readFileSync(path.join(out3, r3.runId, it.raw_path), 'utf8'));
  ok('when its text appears it is collected as a new candidate with the text', it && it.item_id === 'congress_gov:119/hr/10768' && it.change === 'new' && it.reason === 'discovery' && raw3.text_missing === false && /frontier artificial intelligence/.test(raw3.text), JSON.stringify(it));
  ok('and leaves the waiting list', !r3.nextWaiting['congress_gov:119/hr/10768'] && r3.stats.waiting_text_found === 1, JSON.stringify(r3.stats));
  // the per-run cap, least recently asked first; a bill tracked meanwhile, or waiting too long, is let go
  const many = {}; for (let i = 0; i < 14; i++) many[`congress_gov:119/hr/${30000 + i}`] = { source_id: `119/hr/${30000 + i}`, title: 'x', since: '2026-10-01', last_checked: i < 2 ? '2026-10-01' : '2026-10-27', checks: 1 };
  many['congress_gov:119/hr/39999'] = { source_id: '119/hr/39999', title: 'tracked now', since: '2026-10-01', last_checked: '2026-10-01', checks: 1 };
  many['congress_gov:119/hr/38888'] = { source_id: '119/hr/38888', title: 'ancient', since: '2025-01-01', last_checked: '2025-01-02', checks: 99 };
  const log4 = [];
  const r4 = await runCongress({ http: mk(fakeServer({ bills: [], log: log4 })), state: emptyState(), entries: [{ key: 'k', identifiers: { external: { congress_gov: ['119/hr/39999'] } } }], scope, outDir: tmp(), now: NOW, waiting: many, waitingChecks: 5 });
  const asked = log4.filter((u) => /\/text/.test(u)).map((u) => /hr\/(\d+)\/text/.exec(u)[1]);
  ok('at most the cap is asked per run, least recently asked first', asked.length === 5 && asked[0] === '30000' && asked[1] === '30001', JSON.stringify(asked));
  ok('a bill tracked meanwhile, or waiting over a year, leaves the list', !r4.nextWaiting['congress_gov:119/hr/39999'] && !r4.nextWaiting['congress_gov:119/hr/38888'] && Object.keys(r4.nextWaiting).length === 14 && r4.stats.waiting_given_up === 1);
  // a reconciliation run (--bill) does not touch the list
  const r5 = await runCongress({ http: mk(fakeServer({ bills: [hr] })), state: emptyState(), entries, scope, outDir: tmp(), now: NOW, bills: ['119/hr/10768'], waiting: r1.nextWaiting });
  ok('a --bill run leaves the waiting list as it was', JSON.stringify(r5.nextWaiting) === JSON.stringify(r1.nextWaiting) && !r5.stats.waiting_checked);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
