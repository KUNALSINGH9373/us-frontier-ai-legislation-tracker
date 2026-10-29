// Run:  node news/test-verify.mjs
// Open States + NY Senate adapters (offline fixtures built from the documented response shapes), confirmation rules, statement
// attachment and source health. No network, no AI. Events are small local stubs in the contract's shape (events.mjs is built elsewhere).
import fs from 'fs';
import path from 'path';
import assert from 'assert/strict';
import { fileURLToPath } from 'url';
import * as OS from './sources/openstates.mjs';
import * as NY from './sources/nysenate.mjs';
import { applyRun, confirmersFor, showable, confirmationTable } from './confirm.mjs';
import { attachStatements, canonicalUrl, numberConflict, allowHostsFrom } from './attach.mjs';
import { updateHealth, alerts, dataAsOf, loadHealth, saveHealth } from './health.mjs';
import os from 'os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures', 'news', 'sources');
const fx = (p) => JSON.parse(fs.readFileSync(path.join(FIX, p), 'utf8'));
let n = 0; const t = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`ok  ${name}`); };
const NOW = new Date('2026-10-29T12:00:00Z');
const noSleep = async () => {};
const fakeHttp = (routes) => { const calls = []; return { calls, getJson: async (u) => { calls.push(u); for (const [re, body] of routes) if (re.test(u)) { if (body instanceof Error) throw body; return body; } return { results: [] }; } }; };
const CA = { entry_id: 'ca-sb-53-tfaia', state: 'CA', number: 'SB53', session_name: '2025-2026 Regular Session' };
const NYB = { entry_id: 'ny-raise-act', state: 'NY', number: 'S06953', session_name: '2025-2026 General Assembly' };

// ---------- adapters
await ta('openstates: no key -> no items, health no key, no request', async () => {
  const http = fakeHttp([]);
  const r = await OS.fetchItems({ http, env: {}, entries: [CA] });
  assert.deepEqual(r, { items: [], health: { ok: false, count: 0, newest: null, errors: ['no key'] } }); assert.equal(http.calls.length, 0);
});
let osItems;
await ta('openstates: maps classifications, exact number only, rejects future dates, hearings', async () => {
  const http = fakeHttp([[/\/bills\?/, fx('openstates/bills-ca-sb53.json')], [/\/events\?/, fx('openstates/events-ca-sb53.json')]]);
  const r = await OS.fetchItems({ http, env: { OPENSTATES_API_KEY: 'SECRET' }, entries: [CA], since: '2025-01-01', now: () => NOW, sleep: noSleep, config: { openstates: { max_requests_per_run: 10 } } });
  osItems = r.items;
  assert.equal(r.health.ok, true);
  assert.ok(r.items.every((x) => x.entry_id === 'ca-sb-53-tfaia' && !/SB530/.test(x.url)), 'SB 530 never mapped to SB 53');
  assert.ok(!r.items.some((x) => x.date === '2099-01-01'), 'future date rejected');
  const cls = (c) => r.items.filter((x) => x.class === c);
  assert.equal(cls('executive-signature')[0].date, '2025-09-29');
  assert.equal(cls('became-law').length, 1);
  assert.deepEqual(cls('passage').map((x) => [x.facts.chamber, x.facts.vote.yes, x.facts.vote.no]), [['upper', 37, 0], ['lower', 45, 11]]);
  assert.equal(r.items.find((x) => x.facts.action.startsWith('Read second')).class, null, 'reading-2 -> null');
  assert.equal(cls('introduction')[0].date, '2025-01-07');
  assert.equal(cls('hearing-held')[0].date, '2025-07-16');
  assert.equal(cls('hearing-scheduled').find((x) => x.facts.withdrawn).facts.event_status, 'cancelled');
  assert.ok(http.calls[0].includes('identifier=SB%2053') && http.calls[0].includes('updated_since=2025-01-01'));
});
await ta('openstates: per-run cap stops early, errors scrub the key', async () => {
  const http = fakeHttp([[/\/bills\?/, new Error('HTTP 500 for x?apikey=SECRET')]]);
  const r = await OS.fetchItems({ http, env: { OPENSTATES_API_KEY: 'SECRET' }, entries: [CA, CA, CA, CA], now: () => NOW, sleep: noSleep, config: { openstates: { max_requests_per_run: 2 } } });
  assert.equal(http.calls.length, 2); assert.equal(r.health.ok, false); assert.ok(r.health.truncated);
  assert.ok(!JSON.stringify(r.health).includes('SECRET'));
});
t('openstates: trackedBills from identifiers config keeps state bills only', () => {
  const b = OS.trackedBills(JSON.parse(fs.readFileSync(OS.IDS_PATH, 'utf8')));
  assert.ok(b.some((x) => x.entry_id === 'ca-sb-53-tfaia' && x.number === 'SB53'));
  assert.ok(b.every((x) => x.state !== 'US'));
  assert.equal(OS.osSession(CA), '20252026');
});
let nyItems;
await ta('nysenate: no key, then RAISE actions mapped with vote and chapter', async () => {
  assert.deepEqual((await NY.fetchItems({ http: fakeHttp([]), env: {}, entries: [NYB] })).health.errors, ['no key']);
  const http = fakeHttp([[/\/bills\/2025\/S6953\?/, fx('nysenate/bill-2025-S6953.json')]]);
  const r = await NY.fetchItems({ http, env: { NYSENATE_API_KEY: 'K' }, entries: [NYB, CA], now: () => NOW, sleep: noSleep });
  nyItems = r.items;
  assert.equal(http.calls.length, 1, 'only NY bills');
  const by = (c) => r.items.filter((x) => x.class === c);
  assert.equal(by('introduction')[0].date, '2025-03-27');
  assert.equal(by('new-text-version')[0].date, '2025-05-14');
  assert.deepEqual(by('passage')[0].facts.vote, { yes: 58, no: 1 });
  assert.equal(by('executive-receipt')[0].date, '2025-12-12');
  assert.equal(by('executive-signature')[0].facts.chapter, '711');
  assert.equal(r.items.find((x) => x.facts.action === 'DELIVERED TO ASSEMBLY').class, null);
  assert.ok(r.items.every((x) => x.url === 'https://www.nysenate.gov/legislation/bills/2025/S6953'));
});
await ta('nysenate: API answering a different bill is refused', async () => {
  const other = fx('nysenate/bill-2025-S6953.json'); other.result = { ...other.result, basePrintNo: 'S69530' };
  const r = await NY.fetchItems({ http: fakeHttp([[/bills/, other]]), env: { NYSENATE_API_KEY: 'K' }, entries: [NYB], now: () => NOW, sleep: noSleep });
  assert.equal(r.items.length, 0); assert.equal(r.health.ok, false);
});

// ---------- confirmation
const ev = (o) => ({ key: `${o.jurisdiction}|${o.entry_id}|${o.class}|${o.date}`, facts: {}, status: 'pending', confirmations: [], history: [], ...o, sources: [{ role: 'official', source: o.src, source_id: o.sid, url: 'https://x.gov', title: 't', retrieved_at: NOW.toISOString() }] });
const item = (o) => ({ jurisdiction: 'CA', entry_id: 'ca-sb-53-tfaia', facts: {}, url: 'https://openstates.org/x', title: 't', retrieved_at: NOW.toISOString(), ...o });
const AT = NOW.toISOString();

t('confirm: legiscan signature confirmed by openstates one day off (time zone)', () => {
  const e = ev({ jurisdiction: 'CA', entry_id: 'ca-sb-53-tfaia', class: 'executive-signature', date: '2025-09-30', src: 'legiscan', sid: 'L1' });
  const { events, report } = applyRun([e], [item({ source: 'legiscan', source_id: 'L1', class: 'executive-signature', date: '2025-09-30' }), ...osItems], { at: AT });
  assert.equal(events[0].status, 'confirmed'); assert.deepEqual(events[0].confirmations, ['openstates']);
  assert.ok(showable(events[0])); assert.ok(report.some((r) => r.kind === 'confirmed'));
  assert.equal(e.status, 'pending', 'input untouched');
});
t('confirm: legiscan alone stays pending (independent source exists for state bills)', () => {
  const e = ev({ jurisdiction: 'CA', entry_id: 'ca-sb-53-tfaia', class: 'executive-signature', date: '2025-09-29', src: 'legiscan', sid: 'L1' });
  let evs = [e];
  for (let i = 0; i < 3; i++) evs = applyRun(evs, [item({ source: 'legiscan', source_id: 'L1', class: 'executive-signature', date: '2025-09-29' })], { at: AT }).events;
  assert.equal(evs[0].status, 'pending'); assert.ok(!showable(evs[0]));
});
t('confirm: conflicting dates between sources -> pending, reported, never shown', () => {
  const e = ev({ jurisdiction: 'CA', entry_id: 'ca-sb-53-tfaia', class: 'executive-signature', date: '2025-10-03', src: 'legiscan', sid: 'L1' });
  const { events, report } = applyRun([e], [item({ source: 'legiscan', source_id: 'L1', class: 'executive-signature', date: '2025-10-03' }), ...osItems], { at: AT });
  assert.equal(events[0].status, 'pending'); assert.equal(events[0].disagreements[0].conflict, 'date'); assert.ok(report.some((r) => r.kind === 'disagreement'));
  assert.ok(!showable(events[0]));
});
t('confirm: different vote -> pending; conflicting class same day (veto vs signature) -> pending', () => {
  const e = ev({ jurisdiction: 'CA', entry_id: 'ca-sb-53-tfaia', class: 'passage', date: '2025-05-28', facts: { chamber: 'upper', vote: { yes: 36, no: 1 } }, src: 'legiscan', sid: 'L2' });
  const r1 = applyRun([e], osItems, { at: AT });
  assert.equal(r1.events[0].status, 'pending'); assert.equal(r1.events[0].disagreements[0].conflict, 'vote');
  const v = ev({ jurisdiction: 'NY', entry_id: 'ny-raise-act', class: 'executive-veto', date: '2025-12-19', src: 'legiscan', sid: 'L3' });
  const r2 = applyRun([v], nyItems, { at: AT });
  assert.equal(r2.events[0].status, 'pending'); assert.equal(r2.events[0].disagreements[0].conflict, 'class');
});
t('confirm: no independent source -> confirmed only after 2 unchanged runs; a change resets', () => {
  const it = { source: 'federal_register', source_id: 'FR1', jurisdiction: 'US', entry_id: 'eo-1', class: 'agency-rule-final', date: '2026-10-20', facts: { document_number: '2026-1' } };
  let evs = [ev({ jurisdiction: 'US', entry_id: 'eo-1', class: 'agency-rule-final', date: '2026-10-20', facts: { document_number: '2026-1' }, src: 'federal_register', sid: 'FR1' })];
  evs = applyRun(evs, [it], { at: AT }).events; assert.equal(evs[0].status, 'pending');
  evs = applyRun(evs, [], { at: AT, okSources: ['federal_register'] }).events; assert.equal(evs[0].stable_runs, 0, 'missing from an ok source resets');
  evs = applyRun(evs, [it], { at: AT }).events; assert.equal(evs[0].status, 'pending');
  evs = applyRun(evs, [it], { at: AT }).events; assert.equal(evs[0].status, 'confirmed');
});
t('confirm: feed replaying the same old item many times in one run counts one run', () => {
  const it = { source: 'courtlistener', source_id: 'C1', jurisdiction: 'US', entry_id: 'case-1', class: 'court-ruling', date: '2026-10-01', facts: {} };
  const e = ev({ jurisdiction: 'US', entry_id: 'case-1', class: 'court-ruling', date: '2026-10-01', src: 'courtlistener', sid: 'C1' });
  const r = applyRun([e], [it, it, it, it], { at: AT });
  assert.equal(r.events[0].stable_runs, 1); assert.equal(r.events[0].status, 'pending');
});
t('confirm: EO from whitehouse needs federal_register; congress_gov enrolled needs govinfo', () => {
  assert.deepEqual(confirmersFor({ jurisdiction: 'US', class: 'executive-order' }, 'whitehouse'), ['federal_register']);
  assert.deepEqual(confirmersFor({ jurisdiction: 'US', class: 'enrolled' }, 'congress_gov'), ['govinfo']);
  assert.deepEqual(confirmersFor({ jurisdiction: 'US', class: 'hearing-held' }, 'congress_gov'), []);
  assert.ok(confirmersFor({ jurisdiction: 'CA', class: 'passage' }, 'legiscan').includes('openstates'));
  assert.ok(!confirmersFor({ jurisdiction: 'CA', class: 'passage' }, 'legiscan').includes('nysenate'));
  const e = ev({ jurisdiction: 'US', entry_id: 'eo-9', class: 'executive-order', date: '2026-10-10', src: 'whitehouse', sid: 'W1' });
  const wh = { source: 'whitehouse', source_id: 'W1', jurisdiction: 'US', entry_id: 'eo-9', class: 'executive-order', date: '2026-10-10', facts: {} };
  let evs = [e]; for (let i = 0; i < 3; i++) evs = applyRun(evs, [wh], { at: AT }).events;
  assert.equal(evs[0].status, 'pending', 'stable runs do not substitute when a confirmer exists');
  evs = applyRun(evs, [wh, { ...wh, source: 'federal_register', source_id: '2026-2222', date: '2026-10-14' }], { at: AT }).events;
  assert.equal(evs[0].status, 'pending', 'FR publication 4 days later is a date disagreement');
  evs = applyRun(evs, [wh, { ...wh, source: 'federal_register', source_id: '2026-2222', date: '2026-10-11' }], { at: AT }).events;
  assert.equal(evs[0].status, 'confirmed');
  assert.ok(confirmationTable().length >= 5);
});
t('confirm: withdrawn record and corrected date never delete', () => {
  const e = ev({ jurisdiction: 'CA', entry_id: 'ca-sb-53-tfaia', class: 'hearing-scheduled', date: '2025-06-20', src: 'openstates', sid: 'ocd-event/bbbb-cancel|hearing-scheduled', status: 'confirmed' });
  const r = applyRun([e], osItems.map((x) => ({ ...x })), { at: AT });
  assert.equal(r.events.length, 1); assert.equal(r.events[0].status, 'withdrawn'); assert.equal(r.events[0].history.at(-1).to, 'withdrawn');
  const c = ev({ jurisdiction: 'CA', entry_id: 'ca-sb-53-tfaia', class: 'executive-signature', date: '2025-09-28', src: 'legiscan', sid: 'L9', status: 'confirmed' });
  const r2 = applyRun([c], [item({ source: 'legiscan', source_id: 'L9', class: 'executive-signature', date: '2025-09-29' })], { at: AT });
  assert.equal(r2.events[0].status, 'corrected'); assert.deepEqual(r2.events[0].history[0], { at: AT, change: 'date', from: '2025-09-28', to: '2025-09-29' });
  assert.ok(!showable(r2.events[0]));
});

// ---------- attachment
const allow = ['gov.ca.gov', 'nysenate.gov', 'justice.gov', 'liccardo.house.gov'];
const sig = { ...ev({ jurisdiction: 'CA', entry_id: 'ca-sb-53-tfaia', class: 'executive-signature', date: '2025-09-29', src: 'openstates', sid: 'x' }), facts: { number: 'SB 53' } };
const pass = { ...ev({ jurisdiction: 'CA', entry_id: 'ca-sb-53-tfaia', class: 'passage', date: '2025-09-12', src: 'openstates', sid: 'y' }), facts: { number: 'SB 53', chamber: 'lower' } };
const st = (o) => ({ source: 'gov-ca', source_id: o.url, jurisdiction: 'CA', entry_id: 'ca-sb-53-tfaia', class: null, retrieved_at: AT, facts: { role: 'statement', publisher: 'Governor of California', text: o.text || '' }, ...o });

t('attach: signing release attaches to the signature event (0..+3 days, class keyword)', () => {
  const r = attachStatements([pass, sig], [st({ title: 'Governor <b>Newsom</b> signs SB 53, landmark AI law', date: '2025-09-30', url: 'https://www.gov.ca.gov/2025/09/29/sb53/?utm_source=x' })], { allowHosts: allow });
  const s = r.events[1].sources.find((x) => x.role === 'statement');
  assert.equal(s.title, 'Governor Newsom signs SB 53, landmark AI law'); assert.equal(s.url, 'https://gov.ca.gov/2025/09/29/sb53');
  assert.ok(!r.events[0].sources.some((x) => x.role === 'statement'));
});
t('attach: release about SB 530 never attaches to SB 53 (even if entry matched by mistake)', () => {
  assert.ok(numberConflict('Governor signs SB 530', 'SB 53')); assert.ok(!numberConflict('Governor signs SB 53', 'SB 53'));
  const r = attachStatements([sig], [st({ title: 'Governor signs SB 530 on water', date: '2025-09-29', url: 'https://gov.ca.gov/sb530' })], { allowHosts: allow });
  assert.ok(!r.events[0].sources.some((x) => x.role === 'statement')); assert.equal(r.leads.length, 1); assert.equal(r.timeline.length, 0);
});
t('attach: outside 0..+3 days, wrong class, before the event -> timeline, not attached', () => {
  const r = attachStatements([sig], [
    st({ title: 'Governor signs SB 53', date: '2025-10-05', url: 'https://gov.ca.gov/a', text: '1' }),
    st({ title: 'Senate passes SB 53', date: '2025-09-29', url: 'https://gov.ca.gov/b' }),
    st({ title: 'Governor signs SB 53', date: '2025-09-28', url: 'https://gov.ca.gov/c', text: '3' }),
    st({ title: 'Statement on AI safety', date: '2025-09-29', url: 'https://gov.ca.gov/d' }),
  ], { allowHosts: allow });
  assert.equal(r.events[0].sources.filter((x) => x.role === 'statement').length, 0); assert.equal(r.timeline.length, 4);
});
t('attach: near-duplicates: same release via www/utm/trailing slash or same text is dropped; a different release is kept', () => {
  const a = st({ title: 'Governor signs SB 53', date: '2025-09-29', url: 'https://www.gov.ca.gov/sb53/', text: 'Today the Governor signed SB 53.' });
  const b = st({ title: 'Governor signs SB 53', date: '2025-09-29', url: 'http://gov.ca.gov/sb53?utm_campaign=z#top', text: 'Today the Governor signed SB 53!' });
  const c = st({ title: 'Governor  signs  SB 53', date: '2025-09-30', url: 'https://gov.ca.gov/press/other-path', text: 'today the governor signed sb 53.' });
  const d = st({ title: 'Governor signs SB 53 and SB 7', date: '2025-09-30', url: 'https://gov.ca.gov/press/other', text: 'Different.' });
  const r = attachStatements([sig], [a, b, c, d], { allowHosts: allow });
  assert.equal(r.events[0].sources.filter((x) => x.role === 'statement').length, 2);
  assert.deepEqual(r.dropped.map((x) => x.why), ['duplicate', 'duplicate']);
  const again = attachStatements(r.events, [a], { allowHosts: allow }); assert.equal(again.dropped[0].why, 'duplicate', 'already attached in an earlier run');
  assert.equal(canonicalUrl('HTTPS://WWW.Gov.ca.gov/x/?b=2&a=1&utm_source=q'), 'https://gov.ca.gov/x?a=1&b=2');
});
t('attach: host not on allowlist dropped; no entry -> Telegram lead; allowlist from config', () => {
  const r = attachStatements([sig], [st({ title: 'Governor signs SB 53', date: '2025-09-29', url: 'https://gov-ca.example.com/sb53' }), st({ title: 'DOJ announces AI task force', entry_id: null, date: '2025-09-29', url: 'https://www.justice.gov/opa/pr/x' })], { allowHosts: allow });
  assert.equal(r.dropped[0].why, 'host not allowlisted'); assert.equal(r.leads.length, 1);
  const hosts = allowHostsFrom(JSON.parse(fs.readFileSync(OS.CONFIG_PATH, 'utf8')));
  assert.ok(hosts.includes('oag.ca.gov') && !hosts.includes('rss.politico.com'));
});

// ---------- health
t('health: ok run, data as of, no alerts', () => {
  const s = updateHealth({ sources: {} }, { openstates: { ok: true, count: 3, newest: '2025-09-29', errors: [] } }, { now: NOW });
  assert.equal(dataAsOf(s).openstates, NOW.toISOString()); assert.deepEqual(alerts(s, { now: NOW, config: { openstates: { cadence_hours: 24 } } }), []);
});
t('health: no key, broken, stale', () => {
  let s = updateHealth({ sources: {} }, { nysenate: { ok: false, count: 0, errors: ['no key'] } }, { now: NOW });
  assert.match(alerts(s, { now: NOW })[0], /no API key/);
  s = updateHealth({ sources: { openstates: { last_ok: '2026-10-25T00:00:00Z', counts: [] } } }, { openstates: { ok: false, count: 0, errors: ['HTTP 500'] } }, { now: NOW });
  const a = alerts(s, { now: NOW, config: { openstates: { cadence_hours: 24 } } });
  assert.ok(a.some((l) => /broken/.test(l)) && a.some((l) => /stale/.test(l)));
});
t('health: zero-volume and spike against the usual count', () => {
  let s = { sources: { legiscan: { counts: [4, 5, 6], last_ok: NOW.toISOString(), newest: '2026-10-28' } } };
  assert.ok(alerts(updateHealth(s, { legiscan: { ok: true, count: 0, errors: [] } }, { now: NOW }), { now: NOW }).some((l) => /zero items/.test(l)));
  assert.ok(alerts(updateHealth(s, { legiscan: { ok: true, count: 90, errors: [] } }, { now: NOW }), { now: NOW }).some((l) => /spike/.test(l)));
});
t('health: future-dated DOJ-style item and a replaying feed are reported', () => {
  const doj = [{ source: 'doj', source_id: 'doj-2027', date: '2027-03-01' }, { source: 'doj', source_id: 'ok', date: '2026-10-28' }];
  const s = updateHealth({ sources: {} }, { doj: { ok: true, count: 2, errors: [] } }, { now: NOW, items: { doj } });
  assert.equal(s.sources.doj.newest, '2026-10-28', 'future date never becomes newest');
  assert.ok(alerts(s, { now: NOW }).some((l) => /future-dated.*doj-2027/.test(l)));
  const old = [{ source: 'ftc', source_id: 'o1', date: '2024-01-01' }];
  const s2 = updateHealth({ sources: { ftc: { newest: '2026-10-27', counts: [1], last_ok: NOW.toISOString() } } }, { ftc: { ok: true, count: 1, errors: [] } }, { now: NOW, items: { ftc: old } });
  assert.ok(alerts(s2, { now: NOW }).some((l) => /replayed/.test(l))); assert.equal(s2.sources.ftc.newest, '2026-10-27');
});
t('health: load/save round trip', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nh-')), 'h.json');
  assert.deepEqual(loadHealth(p), { sources: {} });
  saveHealth(p, { sources: { a: { ok: true } } }); assert.equal(loadHealth(p).sources.a.ok, true);
});
console.log(`\n${n} news verify tests passed`);
