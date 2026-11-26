// End of a state session (publish/session-end.mjs) on the frozen site data of 12 Nov 2026 (fixtures/correct), with a fake LegiScan.
// A pending state bill dies only when LegiScan shows its session adjourned AND a newer regular session convened; LegiScan's "adjourned"
// flag alone (New York, Illinois in Nov 2026) is not enough. A bill that went to the governor, a record that cannot be read and the
// monthly cap are respected; queries are counted; a second run changes nothing; the result passes every publish guard. No network.
//   node publish/test-session-end.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { sessionEndRun, applySessionEnd, due, sessionOver, TO_GOVERNOR } from './session-end.mjs';
import { loadData } from './run.mjs';
import { checkPublish } from './guards.mjs';
import { advanceCutoff } from './tier-a.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { watchLines } from '../report/format.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, '..', 'fixtures', 'correct');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'send-'));
const copy = () => { const d = tmp(); for (const f of fs.readdirSync(FX)) fs.copyFileSync(path.join(FX, f), path.join(d, f)); return d; };
const BIG = { max_entries_changed_per_run: 50 };
const data = loadData(FX);

// Three pending state bills of the frozen data, given made-up LegiScan ids in real-shaped sessions: NY (2025-2026), IL, PA.
const pend = data.entries.filter((e) => e.level === 'state' && e.type === 'bill' && ['pending', 'stalled'].includes(e.status));
const [ny, il, pa] = ['NY', 'IL', 'PA'].map((s) => pend.find((e) => e.state === s));
const tracked = {
  [ny.key]: { status: 'confirmed', bills: [{ bill_id: 101, state: 'NY', session_id: 2188, session_name: '2025-2026 General Assembly', year_end: 2026 }] },
  [il.key]: { status: 'confirmed', bills: [{ bill_id: 201, state: 'IL', session_id: 2176, session_name: '104th General Assembly', year_end: 2026 }] },
  [pa.key]: { status: 'confirmed', bills: [{ bill_id: 301, state: 'PA', session_id: 2192, session_name: '2025-2026 Regular Session', year_end: 2026 }, { bill_id: 302, state: 'PA', session_id: 2192, session_name: '2025-2026 Regular Session', year_end: 2026 }] }
};
const sess = (id, state, ys, ye, o = {}) => ({ session_id: id, state_abbr: state, year_start: ys, year_end: ye, sine_die: 1, prior: 0, prefile: 0, special: 0, session_name: o.name || `${ys}-${ye} Regular Session`, ...o });
// as on 26 Nov 2026: every 2025-2026 session flagged adjourned, no newer session
const NOV = { NY: [sess(2188, 'NY', 2025, 2026, { name: '2025-2026 General Assembly' }), sess(2031, 'NY', 2023, 2024, { prior: 1 })], IL: [sess(2176, 'IL', 2025, 2026, { name: '104th General Assembly' })], PA: [sess(2192, 'PA', 2025, 2026, { sine_die: 0 })] };
// mid-January 2027: New York's and Pennsylvania's new sessions have convened; Illinois's is still prefiling (the lame duck can still act)
const JAN = { NY: [sess(2300, 'NY', 2027, 2028, { sine_die: 0, name: '2027-2028 General Assembly' }), ...NOV.NY.map((x) => ({ ...x, prior: 1 }))], IL: [sess(2301, 'IL', 2027, 2028, { sine_die: 0, prefile: 1, name: '105th General Assembly' }), ...NOV.IL], PA: [sess(2302, 'PA', 2027, 2028, { sine_die: 0, name: '2027-2028 Regular Session' }), sess(2192, 'PA', 2025, 2026)] };
const bill = (id, state, num, history, status = 1) => ({ bill_id: id, state, bill_number: num, status, state_link: `https://legislature.example/${state}/${num}`, url: `https://legiscan.com/${state}/bill/${num}/2025`, history });
const BILLS = {
  101: bill(101, 'NY', 'S10373', [{ date: '2026-09-01', action: 'REFERRED TO INTERNET AND TECHNOLOGY' }, { date: '2026-06-01', action: 'INTRODUCED' }]),
  201: bill(201, 'IL', 'SB3444', [{ date: '2026-03-15', action: 'Referred to Assignments' }]),
  301: bill(301, 'PA', 'HB2800', [{ date: '2026-10-19', action: 'Public hearing held' }]),
  302: bill(302, 'PA', 'HB2801', [{ date: '2026-10-20', action: 'Referred to Communications & Technology' }])
};
const fakeLS = ({ sessions = JAN, bills = BILLS, broken = [] } = {}) => {
  const calls = [];
  return { calls, async sessions(st) { calls.push('sessions:' + st); return sessions[st] || []; },
    async bill(id) { calls.push('bill:' + id); if (broken.includes(id)) throw new Error(`LegiScan getBill returned ERROR: "unavailable"`); return bills[id]; } };
};
const usage = (used = 0) => { const f = path.join(tmp(), 'legiscan-usage.json'); fs.writeFileSync(f, JSON.stringify({ month: '2027-01', used, runs: 1 })); return f; };
const NOW = new Date('2027-01-14T08:00:00Z');

// ---------- 1. the rules ----------
ok('nothing is due in 2026 (a session can end no sooner than its last year)', due(data, tracked, new Date('2026-12-31T23:59:59Z')).length === 0);
ok('all three are due from 1 Jan 2027', due(data, tracked, new Date('2027-01-01T00:00:00Z')).length === 3);
ok('LegiScan\'s "adjourned" flag alone does not end a session (New York, 26 Nov 2026)', sessionOver(NOV.NY, 2188) === null);
ok('a newer session still prefiling does not end it (Illinois lame duck)', sessionOver(JAN.IL, 2176) === null);
ok('adjourned plus a convened newer regular session ends it', sessionOver(JAN.NY, 2188).session_id === 2300 && sessionOver(JAN.PA, 2192).session_id === 2302);
ok('a special session is not a newer regular session', sessionOver([sess(1, 'X', 2025, 2026), sess(2, 'X', 2027, 2027, { special: 1, sine_die: 0 })], 1) === null);
ok('governor wording', TO_GOVERNOR.test('Delivered to Governor') && TO_GOVERNOR.test('Signed by Governor') && TO_GOVERNOR.test('Chapter 12, Statutes of 2026') && TO_GOVERNOR.test('Vetoed') && !TO_GOVERNOR.test('Referred to Assignments'));

// ---------- 2. in December: nothing is read ----------
{
  const dir = copy(), ls = fakeLS(), f = usage();
  const r = await sessionEndRun({ legiscan: ls, tracked, dataDir: dir, config: BIG, usageFile: f, now: new Date('2026-12-20T08:00:00Z'), runId: 'd0' });
  ok('in December 2026 no LegiScan query is made and nothing is written', r.status === 'quiet' && ls.calls.length === 0 && JSON.parse(fs.readFileSync(f, 'utf8')).used === 0);
}

// ---------- 3. while LegiScan does not show the sessions over ----------
{
  const dir = copy(), ls = fakeLS({ sessions: NOV });
  const r = await sessionEndRun({ legiscan: ls, tracked, dataDir: dir, config: BIG, usageFile: usage(), now: NOW, runId: 'd1' });
  ok('only the session lists are read (3 queries), no bill', r.queries === 3 && !ls.calls.some((c) => c.startsWith('bill:')), ls.calls.join(','));
  ok('nothing is marked and nothing is reported as a problem', r.result.touched.length === 0 && r.result.skipped.length === 0 && r.result.waiting.length === 3);
}

// ---------- 4. mid-January 2027 ----------
{
  const dir = copy(), before = loadData(dir), ls = fakeLS(), f = usage(10);
  const r = await sessionEndRun({ legiscan: ls, tracked, dataDir: dir, config: BIG, usageFile: f, now: NOW, runId: 'd2' });
  const after = loadData(dir), g = (k) => after.entries.find((e) => e.key === k);
  ok('New York and Pennsylvania bills are marked; Illinois (lame duck) waits', r.result.touched.length === 2 && g(ny.key).status === 'failed' && g(pa.key).status === 'failed' && g(il.key).status === il.status && r.result.waiting.includes(il.key), r.summary);
  ok('the status text keeps the author\'s words and says what the record shows', g(ny.key).status_text.includes('The 2025-2026 General Assembly ended without the bill passing (LegiScan lists that session as adjourned and the 2027-2028 General Assembly as begun, checked Jan 14, 2027); the last action on the NY Legislature\'s record is "REFERRED TO INTERNET AND TECHNOLOGY" (Sept 1, 2026)') && g(ny.key).status_text.startsWith(String(ny.status_text).slice(0, 30)), g(ny.key).status_text);
  ok('an entry with two bills quotes the latest action and names its bill', /"Referred to Communications & Technology" \(Oct 20, 2026, PA HB2801\)\.$/.test(g(pa.key).status_text), g(pa.key).status_text);
  ok('the evidence quotes the record and links the legislature\'s page', g(ny.key).evidence.some((x) => x.field === 'status' && x.quote === 'REFERRED TO INTERNET AND TECHNOLOGY' && x.source_url === 'https://legislature.example/NY/S10373'));
  ok('queries counted: 3 session lists + 3 bills', r.queries === 6 && JSON.parse(fs.readFileSync(f, 'utf8')).used === 16, `${r.queries}`);
  const check = checkPublish({ before, after, runDate: '2027-01-14', maxEntries: 50 });
  ok('the result passes every publish guard and the integrity rules', !check.problems.length && !checkIntegrity(after).length, check.problems.slice(0, 3).join('; '));
  const r2 = await sessionEndRun({ legiscan: fakeLS(), tracked, dataDir: dir, config: BIG, usageFile: f, now: new Date('2027-01-14T12:00:00Z'), runId: 'd3' });
  ok('a second run marks nothing more (the marked bills are no longer pending)', r2.result.touched.length === 0 && due(loadData(dir), tracked, NOW).length === 1);
}

// ---------- 5. a bill that went to the governor, an unreadable record, the cap, the per-run limit ----------
{
  const gov = { ...BILLS, 101: bill(101, 'NY', 'S10373', [{ date: '2026-12-10', action: 'DELIVERED TO GOVERNOR' }]), 301: { ...BILLS[301], status: 3 } };
  const r = await sessionEndRun({ legiscan: fakeLS({ bills: gov }), tracked, dataDir: copy(), config: BIG, usageFile: usage(), now: NOW, runId: 'd4' });
  ok('a bill delivered to the governor, or enrolled, is left alone and said why', r.result.touched.length === 0 && r.result.skipped.filter((s) => /went to the governor/.test(s.why)).length === 2, JSON.stringify(r.result.skipped));
  const rb = await sessionEndRun({ legiscan: fakeLS({ broken: [101] }), tracked, dataDir: copy(), config: BIG, usageFile: usage(), now: NOW, runId: 'd5' });
  ok('an unreadable record waits for the next run (the others go ahead)', !rb.result.touched.includes(ny.key) && rb.result.touched.includes(pa.key) && rb.errors.some((x) => x.startsWith(ny.key)));
  const capped = await sessionEndRun({ legiscan: fakeLS(), tracked, dataDir: copy(), config: BIG, lsConfig: { monthly_cap: 100 }, usageFile: usage(100), now: NOW, runId: 'd6' });
  ok('at the monthly cap no query is made and it is said', capped.queries === 0 && capped.result.touched.length === 0 && capped.errors.some((x) => /monthly limit/.test(x)));
  const moved = JSON.parse(JSON.stringify(data)); advanceCutoff(moved, '2027-01-14');
  const byCutoff = moved.entries.filter((e, i) => !due(data, tracked, NOW).some((x) => x.key === e.key) && JSON.stringify(e) !== JSON.stringify(data.entries[i])).length;
  const lim = await sessionEndRun({ legiscan: fakeLS(), tracked, dataDir: copy(), config: BIG, usageFile: usage(), now: NOW, runId: 'd7', maxEntries: byCutoff + 1 });
  ok('with room for one entry, one bill is marked', lim.result.touched.length === 1, lim.summary);
  const dry = copy(), f = usage(5);
  const rd = await sessionEndRun({ legiscan: fakeLS(), tracked, dataDir: dry, config: BIG, usageFile: f, now: NOW, runId: 'd8', dry: true });
  ok('a dry run writes nothing', rd.status === 'dry-run' && fs.readFileSync(path.join(dry, 'entries.json'), 'utf8') === fs.readFileSync(path.join(FX, 'entries.json'), 'utf8'));
  ok('a dry run still counts its LegiScan queries', JSON.parse(fs.readFileSync(f, 'utf8')).used === 5 + rd.queries && rd.queries > 0);
}

// ---------- 6. pure: an entry whose tracked bills are in an unknown session is not guessed ----------
{
  const a = applySessionEnd({ data, tracked, sessions: { NY: [], IL: [], PA: [] }, bills: BILLS, now: NOW, runId: 'd9' });
  ok('a session missing from LegiScan\'s list is never treated as over', a.touched.length === 0);
}

// ---------- 7. the report ----------
{
  const base = { sources: [], held: [], ai: {}, notes: [], names: { a: 'NY S.10373' } };
  const w = watchLines({ ...base, session_end: { waiting: 3, marked: ['a'], not_marked: [{ entry_key: 'b', why: 'PA HB2800 passed both chambers or went to the governor' }], errors: [], stopped: null } });
  ok('the report lists what was marked and alerts what was not', w.some((l) => /^1 pending state bill marked as died at the end of their session/.test(l) && l.includes('NY S.10373')) && w.some((l) => /^⚠️ 1 state bill from an ended session not marked as died/.test(l)), w.join('\n'));
  ok('no line while nothing is due', !watchLines({ ...base }).some((l) => /session/.test(l)));
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
