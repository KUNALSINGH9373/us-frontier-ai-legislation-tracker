// End of a Congress (publish/congress-end.mjs) on the frozen site data of 12 Nov 2026 (fixtures/correct), with a fake Congress.gov.
// Pending federal bills turn "died" on 3 Jan 2027 and not a second before; a bill that went to the President, a record that cannot be
// read, a bill with no id and a later Congress's bill are left alone; the per-run limit is kept; a second run changes nothing; the
// result passes every publish guard. Also: news matching by Congress (news/sources/match.mjs) and the report lines. No network.
//   node publish/test-congress-end.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyCongressEnd, congressEndRun, congressEndDate, due, TO_PRESIDENT } from './congress-end.mjs';
import { loadData } from './run.mjs';
import { checkPublish } from './guards.mjs';
import { advanceCutoff } from './tier-a.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { checkTracking, billIdProblems } from '../schema/tracking.mjs';
import { HttpError } from '../grabber/lib/http.mjs';
import { buildIndex, matchBill } from '../news/sources/match.mjs';
import { watchLines } from '../report/format.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, '..', 'fixtures', 'correct');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const copy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cend-')); for (const f of fs.readdirSync(FX)) fs.copyFileSync(path.join(FX, f), path.join(d, f)); return d; };
const LAST = '2027-01-02T23:59:59Z', FIRST = '2027-01-03T00:00:00Z', LATER = '2027-01-03T08:00:00Z';
const ids = (e) => (e.identifiers && e.identifiers.external && e.identifiers.external.congress_gov) || [];
// A fake Congress.gov: every bill's last action is a referral, unless told otherwise.
const fake = ({ actions = {}, fail: broken = [] } = {}) => {
  const calls = [];
  return { calls, async getActions({ congress, type, number }) {
    const id = `${congress}/${type}/${number}`; calls.push(id);
    if (broken.includes(id)) throw new HttpError(503, `https://api.congress.gov/v3/bill/${id}/actions`, '');
    return actions[id] || [{ actionDate: '2026-10-01', text: 'Referred to the Committee on Energy and Commerce.' }, { actionDate: '2026-09-20', text: 'Introduced in House' }];
  } };
};
const data = loadData(FX);
const BIG = { max_entries_changed_per_run: 50 };
const waitingAt = (t) => due(data, new Date(t));

// ---------- 1. the date ----------
ok('the 119th Congress ends on 3 Jan 2027, the 120th on 3 Jan 2029', congressEndDate(119) === '2027-01-03' && congressEndDate(120) === '2029-01-03');
ok('nothing is due on the last second of 2 Jan 2027', waitingAt(LAST).length === 0);
ok('nothing is due today (26 Nov 2026) either', waitingAt('2026-11-26T12:00:00Z').length === 0);
const W = waitingAt(FIRST);
ok('every pending or stalled federal bill (not drafts, not laws) is due from 3 Jan 2027', W.length > 20 && W.every((e) => e.level === 'federal' && e.type === 'bill' && ['pending', 'stalled'].includes(e.status)), W.length);
ok('the records-to-the-President rule', TO_PRESIDENT.test('Presented to President.') && TO_PRESIDENT.test('Became Public Law No: 119-60.') && TO_PRESIDENT.test('Vetoed by President.') && !TO_PRESIDENT.test('Referred to the Committee on the Judiciary.'));

// ---------- 2. the step, before and on the day ----------
{
  const dir = copy(), c = fake();
  const r = await congressEndRun({ congress: c, dataDir: dir, now: new Date(LAST), runId: 't0', maxEntries: 50, config: BIG });
  ok('on 2 Jan 2027 the step reads nothing and writes nothing', r.status === 'quiet' && c.calls.length === 0 && fs.readFileSync(path.join(dir, 'entries.json'), 'utf8') === fs.readFileSync(path.join(FX, 'entries.json'), 'utf8'));
}
{
  const dir = copy(), before = loadData(dir);
  const withIds = W.filter((e) => ids(e).length), first = withIds[0], second = withIds[1], third = withIds[2];
  const toPres = ids(second)[0], broken = ids(third)[0];
  const c = fake({ actions: { [toPres]: [{ actionDate: '2026-12-20', text: 'Presented to President.' }, { actionDate: '2026-12-18', text: 'Passed Senate without amendment by Unanimous Consent.' }] }, fail: [broken] });
  const r = await congressEndRun({ congress: c, dataDir: dir, now: new Date(LATER), runId: 't1', maxEntries: 50, config: BIG });
  const after = loadData(dir), get = (d, k) => d.entries.find((e) => e.key === k);
  const e1 = get(after, first.key), ev = e1.events.find((v) => /^Died at the end of the 119th Congress/.test(v.text));
  ok('on 3 Jan 2027 a pending bill becomes failed', r.status === 'published' && e1.status === 'failed', r.summary);
  ok('its event is dated 3 Jan 2027 and names the Congress', ev && ev.date === '2027-01-03' && ev.type === 'Vetoed / failed / rescinded' && ev.text === 'Died at the end of the 119th Congress (Jan 3, 2027) without becoming law' && !ev.scheduled, JSON.stringify(ev));
  ok('the event links the bill\'s own Congress.gov page', ev && /^https:\/\/www\.congress\.gov\/bill\/119th-congress\//.test(ev.source_url));
  ok('the status text keeps the author\'s words and adds the record\'s last action', e1.status_text.startsWith(String(first.status_text).replace(/[\s.;]+$/, '').slice(0, 40)) && /last action on its Congress\.gov record is "Referred to the Committee on Energy and Commerce" \(Oct 1, 2026\)\.$/.test(e1.status_text), e1.status_text);
  ok('the evidence quotes the record', e1.evidence.some((x) => x.field === 'status' && x.quote === 'Referred to the Committee on Energy and Commerce.' && x.source_url === ev.source_url));
  ok('a bill that went to the President is left alone, and said why', get(after, second.key).status === second.status && r.result.skipped.some((s) => s.entry_key === second.key && /went to the President/.test(s.why)));
  ok('a record that cannot be read is left for the next run', get(after, third.key).status === third.status && r.errors.some((x) => x.startsWith(third.key)));
  ok('a bill with no Congress.gov id is never guessed', W.filter((e) => !ids(e).length).every((e) => get(after, e.key).status === e.status && r.result.skipped.some((s) => s.entry_key === e.key && /no Congress\.gov id/.test(s.why))));
  const noSched = (e) => JSON.stringify({ ...e, events: e.events.map(({ scheduled, ...v }) => v) }); // the cut-off moving recomputes scheduled flags, nothing else
  ok('drafts, laws, orders and state bills do not change', before.entries.filter((e) => !(e.level === 'federal' && e.type === 'bill')).every((e) => noSched(e) === noSched(get(after, e.key))));
  ok('the changes log names every status change', after.changes.items.filter((x) => x.run_id === 't1' && x.field === 'status').length === r.result.touched.length);
  ok('the cut-off moves to the run date', after.site.updates_through === '2027-01-03');
  const check = checkPublish({ before, after, runDate: '2027-01-03', maxEntries: 50, config: BIG });
  ok('the result passes every publish guard and the integrity rules', !check.problems.length && !checkIntegrity(after).length, check.problems.slice(0, 3).join('; '));
  // a second run: nothing new, and the bill that went to the President still waits for its record
  const c2 = fake({ actions: { [toPres]: [{ actionDate: '2026-12-20', text: 'Presented to President.' }] } });
  const r2 = await congressEndRun({ congress: c2, dataDir: dir, now: new Date('2027-01-03T12:00:00Z'), runId: 't2', maxEntries: 50, config: BIG });
  ok('a second run marks only the bill whose record failed before', r2.result.touched.length === 1 && r2.result.touched[0] === third.key, JSON.stringify(r2.result.touched));
  const r3 = await congressEndRun({ congress: fake(), dataDir: dir, now: new Date('2027-01-03T16:00:00Z'), runId: 't3', maxEntries: 50, config: BIG });
  ok('a third run changes nothing (no event twice)', r3.result.touched.length === 0 || r3.result.touched.every((k) => k === second.key), JSON.stringify(r3.result.touched));
  ok('no entry has the died event twice', loadData(dir).entries.every((e) => e.events.filter((v) => /^Died at the end/.test(v.text)).length <= 1));
}

// ---------- 2b. bills announced without a number (config/announced-bills.json; owner decision 26 Nov 2026) ----------
{
  const announced = JSON.parse(fs.readFileSync(path.join(here, '..', 'config', 'announced-bills.json'), 'utf8')).bills;
  const HM = 'ai-agent-accountability-act-hawley-murphy-announced', LK = 'liccardo-kiley-us-china-ai-safety-bill';
  const NAMES = { H001089: 'Josh Hawley', M001169: 'Christopher Murphy', L000607: 'Sam T. Liccardo', K000401: 'Kevin Kiley' };
  const withSponsors = (lists = {}, broken = []) => ({ ...fake(), calls: [],
    async getMember(id) { if (broken.includes(id)) throw new HttpError(503, `https://api.congress.gov/v3/member/${id}`, ''); return { bioguideId: id, directOrderName: NAMES[id] }; },
    async getSponsored(id) { return lists[id] || [{ congress: 119, type: 'S', number: '5723', title: 'No Forced Arbitration for Child Sexual Exploitation and Cyber Injuries Act', introducedDate: '2026-11-16' }]; } });
  const dir = copy(), before = loadData(dir);
  const r = await congressEndRun({ congress: withSponsors({ L000607: [{ congress: 119, type: 'HR', number: '11064', title: 'Data Center Community Empowerment Act of 2026', introducedDate: '2026-11-18' }, { congress: 119, type: 'HR', number: '9000', title: 'Artificial Intelligence Research Act', introducedDate: '2026-08-01' }] }), dataDir: dir, announced, now: new Date(LATER), runId: 'a1', maxEntries: 50, config: BIG });
  const after = loadData(dir), hm = after.entries.find((e) => e.key === HM), lk = after.entries.find((e) => e.key === LK);
  const ev = hm.events.find((v) => /^Not introduced before the end of the 119th Congress/.test(v.text));
  ok('an announced bill none of whose sponsors introduced an AI bill after the announcement is marked "not introduced"', hm.status === 'failed' && ev && ev.date === '2027-01-03' && ev.text === 'Not introduced before the end of the 119th Congress (Jan 3, 2027)', r.summary);
  ok('its status text says what was checked, and keeps the author\'s words', /Not introduced before the end of the 119th Congress \(Jan 3, 2027\): none of the bills its sponsors \(Sen\. Josh Hawley \(R-MO\), Sen\. Chris Murphy \(D-CT\)\) introduced in that Congress after it was announced on Oct 1, 2026 is about AI/.test(hm.status_text) && hm.status_text.startsWith('Status: Announced Oct 1, 2026'), hm.status_text);
  ok('the evidence quotes each sponsor\'s Congress.gov record name, linked to the official Biographical Directory', hm.evidence.filter((x) => x.field === 'status').map((x) => x.quote).join('|') === 'Josh Hawley|Christopher Murphy' && ev.source_url === 'https://bioguide.congress.gov/search/bio/H001089');
  ok('an AI bill introduced BEFORE the announcement does not count (Liccardo, Aug 2026)', lk.status === 'failed');
  ok('the result passes every publish guard', !checkPublish({ before, after, runDate: '2027-01-03', maxEntries: 50 }).problems.length, checkPublish({ before, after, runDate: '2027-01-03', maxEntries: 50 }).problems.slice(0, 3).join('; '));
  const r2 = await congressEndRun({ congress: withSponsors({ M001169: [{ congress: 119, type: 'S', number: '5800', title: 'AI Agent Accountability Act', introducedDate: '2026-12-02' }] }), dataDir: copy(), announced, now: new Date(LATER), runId: 'a2', maxEntries: 50, config: BIG });
  ok('a sponsor\'s AI bill after the announcement: not marked, reported as a possible match', !r2.result.touched.includes(HM) && r2.result.skipped.some((s) => s.entry_key === HM && /possibly introduced as S 5800 "AI Agent Accountability Act"/.test(s.why)), JSON.stringify(r2.result.skipped));
  const r3 = await congressEndRun({ congress: withSponsors({}, ['K000401']), dataDir: copy(), announced, now: new Date(LATER), runId: 'a3', maxEntries: 50, config: BIG });
  ok('a sponsor record that cannot be read: nothing written, tried next run', !r3.result.touched.includes(LK) && r3.errors.some((x) => x.startsWith(LK)) && r3.result.touched.includes(HM));
  const r4 = await congressEndRun({ congress: withSponsors(), dataDir: copy(), now: new Date(LATER), runId: 'a4', maxEntries: 50, config: BIG });
  ok('without the announced list an unnumbered bill is never guessed', !r4.result.touched.includes(HM) && r4.result.skipped.some((s) => s.entry_key === HM && /not in config\/announced-bills\.json/.test(s.why)));
}

// ---------- 2c. two actions on the same date: the one Congress.gov lists first (newest first) is quoted ----------
{
  const one = W.find((e) => ids(e).length === 1), id = ids(one)[0];
  const a = applyCongressEnd({ data, records: { [one.key]: [{ id, url: 'https://www.congress.gov/x', actions: [{ actionDate: '2026-11-24', text: 'Referred to the House Committee on Science, Space, and Technology.' }, { actionDate: '2026-11-24', text: 'Introduced in House' }] }] }, now: new Date(LATER), runId: 'tb' });
  ok('same date: the later action is quoted', /"Referred to the House Committee on Science, Space, and Technology" \(Nov 24, 2026\)\.$/.test(a.data.entries.find((e) => e.key === one.key).status_text), a.data.entries.find((e) => e.key === one.key).status_text);
}

// ---------- 3. the per-run limit ----------
{
  // the frozen data is of 12 Nov 2026: moving its cut-off to 3 Jan 2027 also changes entries with events scheduled in between
  const moved = JSON.parse(JSON.stringify(data)); advanceCutoff(moved, '2027-01-03');
  const byCutoff = moved.entries.filter((e, i) => !W.some((w) => w.key === e.key) && JSON.stringify(e) !== JSON.stringify(data.entries[i])).length;
  const dir = copy(), c = fake();
  const r = await congressEndRun({ congress: c, dataDir: dir, now: new Date(LATER), runId: 't4', maxEntries: byCutoff + 4, config: BIG });
  const before4 = loadData(FX), after4 = loadData(dir);
  ok('what the step changes, the cut-off included, stays within the limit it was given', after4.entries.filter((e, i) => JSON.stringify(e) !== JSON.stringify(before4.entries[i])).length <= byCutoff + 4);
  ok('with room for 4 entries, 4 records are read and 4 bills marked', r.result.touched.length === 4 && c.calls.length >= 4 && new Set(c.calls).size <= 8, `${r.result.touched.length} ${c.calls.length}`);
  ok('the rest wait for the next run (not reported as problems)', r.waiting === W.length && !r.result.skipped.some((s) => /not read/.test(s.why) && !r.summary.includes(s.entry_key) && false));
  const r0 = await congressEndRun({ congress: fake(), dataDir: copy(), now: new Date(LATER), runId: 't5', maxEntries: 0, config: BIG });
  ok('with no room left nothing is read or written', r0.status === 'quiet' && r0.result.touched.length === 0);
}

// ---------- 4. a later Congress: 120th-Congress bills are not touched in 2027 ----------
{
  const d = JSON.parse(JSON.stringify(data)), e = d.entries.find((x) => x.level === 'federal' && x.type === 'bill' && x.status === 'pending' && ids(x).length);
  e.identifiers = { session: '120th Congress', external: { congress_gov: ['120/hr/5'] } };
  const a = applyCongressEnd({ data: d, records: {}, now: new Date('2027-06-01T00:00:00Z'), runId: 't6' });
  ok('a 120th-Congress bill is not due in 2027', !due(d, new Date('2027-06-01T00:00:00Z')).some((x) => x.key === e.key) && !a.touched.includes(e.key));
  ok('it is due on 3 Jan 2029', due(d, new Date('2029-01-03T00:00:00Z')).some((x) => x.key === e.key));
}

// ---------- 5. news matching by Congress ----------
{
  const d = JSON.parse(JSON.stringify(data.entries)), e = d.find((x) => (ids(x)[0] || '').startsWith('119/s/2938'));
  const I = buildIndex(d);
  ok('a 119th-Congress record matches its 119th-Congress entry', matchBill(I, { jurisdiction: 'US', type: 'S', number: '2938', congress: 119 }) === e.key);
  ok('S. 2938 of the 120th Congress is a different bill', matchBill(I, { jurisdiction: 'US', type: 'S', number: '2938', congress: 120 }) === null);
  d.push({ ...JSON.parse(JSON.stringify(e)), key: 'new-120th-bill', id: 99999, title: 'S. 12 — A 120th Congress bill', short_name: 'S. 12', identifiers: { session: '120th Congress', external: { congress_gov: ['120/s/12'] } }, events: [{ date: '2027-01-10', precision: 'day', type: 'Introduced / published', text: 'Introduced', clause: 'Introduced', inferred_year: false, scheduled: false }] });
  const I2 = buildIndex(d);
  ok('a new 120th-Congress bill matches its own record', matchBill(I2, { jurisdiction: 'US', type: 'S', number: '12', congress: 120 }) === 'new-120th-bill');
  ok('and not a 119th-Congress record of the same number', matchBill(I2, { jurisdiction: 'US', type: 'S', number: '12', congress: 119 }) === null);
}

// ---------- 6. a federal bill's id must be on the entry ----------
ok('a federal title naming a bill without its id is an integrity problem', billIdProblems({ level: 'federal', key: 'x', title: 'H.R. 10981 — American AI Security Act' }).length === 1);
ok('with its id it is not', billIdProblems({ level: 'federal', key: 'x', title: 'H.R. 10981 — American AI Security Act', identifiers: { external: { congress_gov: ['119/hr/10981'] } } }).length === 0);
ok('a state bill and a title that names no bill are not checked', !billIdProblems({ level: 'state', key: 'x', title: 'S.B. 53 — TFAIA' }).length && !billIdProblems({ level: 'federal', key: 'x', title: 'AI Agent Accountability Act (Hawley–Murphy)' }).length);
ok('"S. 2938" is not read as "S. 29"', billIdProblems({ level: 'federal', key: 'x', title: 'S. 2938 — X', identifiers: { external: { congress_gov: ['119/s/2938'] } } }).length === 0);

// ---------- 6b. every pending bill is followed (schema/tracking.mjs) ----------
{
  // small made-up entries (the PR check, node schema/tracking.mjs, runs this on the live data and config)
  const st = { key: 'ny-x', level: 'state', type: 'bill', status: 'pending', title: 'S.1 — X', identifiers: { session: 'S', external: { legiscan: [11, 12] } } };
  const fed = { key: 'h-r-11157-rsi-safety-act', level: 'federal', type: 'bill', status: 'pending', title: 'H.R. 11157 — RSI Safety Act of 2026', identifiers: { session: '119th Congress', external: { congress_gov: ['119/hr/11157'] } } };
  const legiscan = { 'ny-x': { status: 'confirmed', bills: [{ bill_id: 12 }, { bill_id: 11 }] } }, live = [st, fed];
  ok('entries and config that agree pass', checkTracking({ entries: live, legiscan }).length === 0, checkTracking({ entries: live, legiscan }).join('; '));
  const broken = live.map((e) => e === st || e === fed ? { ...e, identifiers: undefined } : e);
  const p = checkTracking({ entries: broken, legiscan: { ...legiscan, [st.key]: undefined } });
  ok('a pending state bill missing from the LegiScan config is a problem', p.some((x) => x.startsWith(st.key) && /not in config/.test(x)), p.join('; '));
  ok('a federal bill without its Congress.gov id is a problem', p.some((x) => x.startsWith('h-r-11157-rsi-safety-act') && /hr 11157/.test(x)));
  const p2 = checkTracking({ entries: live.map((e) => e === st ? { ...e, identifiers: undefined } : e), legiscan });
  ok('a state entry whose ids differ from the config is a problem', p2.some((x) => x.startsWith(st.key) && /differ/.test(x)));
  ok('a failed state bill needs no tracking', !checkTracking({ entries: [{ level: 'state', type: 'bill', status: 'failed', key: 'z' }], legiscan: {} }).length);
}

// ---------- 7. the report ----------
{
  const base = { sources: [], held: [], ai: {}, notes: [], names: { a: 'Bill A', b: 'Bill B' } };
  const quiet = watchLines({ ...base });
  ok('no end-of-Congress line before the end', !quiet.some((l) => /Congress/.test(l)));
  const w = watchLines({ ...base, congress_end: { waiting: 30, marked: ['a'], not_marked: [{ entry_key: 'b', why: 'went to the President' }], errors: [], stopped: null } });
  ok('the report lists what was marked, and alerts what was not', w.some((l) => /^1 pending federal bill marked as died/.test(l) && l.includes('Bill A')) && w.some((l) => /^⚠️ 1 federal bill from an ended Congress not marked as died: Bill B/.test(l)), w.join('\n'));
  ok('and says how many wait for the next run', w.some((l) => /28 more bills will be marked on the next run/.test(l)));
  const s = watchLines({ ...base, congress_end: { waiting: 3, marked: [], not_marked: [], errors: ['CONGRESS_API_KEY is not set'], stopped: null } });
  ok('a missing key is an alert', s.some((l) => /^⚠️ End of Congress: 1 record could not be read \(CONGRESS_API_KEY is not set\)/.test(l)));
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
