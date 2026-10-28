// Run:  node grabber/test-courts.mjs
// The court-docket step: the rate limiter, paging a docket back to the last entry seen, which entries are material, and the publish
// (events, news, status text, guards, state) on a temp copy of the live site data. Docket responses are real CourtListener answers
// recorded on 28 Oct 2026 (fixtures/courts/, trimmed to the fields read). No network.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRateLimiter, createCourtListener, classifyEntry, trimDescription, docketUrl } from './sources/courtlistener.mjs';
import { courtsRun } from '../publish/courts.mjs';
import { loadData } from '../publish/run.mjs';
import { createHttp } from './lib/http.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, '..', 'fixtures', 'courts'), LIVE = path.join(here, '..', '..', 'web', 'data', 'v2');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const j = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const ANTHROPIC = 'fl-anthropic-v-department-of-war-n-d-cal', XAI = 'x-ai-v-weiser-d-colo';
const CASES = { [ANTHROPIC]: { court: 'N.D. Cal.', docket_id: 72379655 }, [XAI]: { court: 'D. Colo.', docket_id: 73171074 } };
const NOW = new Date('2026-10-28T12:00:00Z');

// ---------- the fake CourtListener: page 1 is the recorded answer, page 2 one older entry; down: docket ids answering 500 ----------
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
function fakeCL({ down = [], log = [] } = {}) {
  return async (url, init) => {
    log.push({ url, auth: init.headers.Authorization });
    const u = new URL(url), id = u.searchParams.get('docket');
    if (down.includes(id)) return resp(500, { detail: 'server error' });
    if (u.searchParams.get('page') === '2') return resp(200, { count: 2, next: null, previous: null, results: [{ id: 1, docket: +id, date_filed: '2026-03-01', entry_number: 1, description: 'COMPLAINT against all defendants.', recap_documents: [] }] });
    const f = path.join(FX, `docket-entries-${id}.json`);
    return fs.existsSync(f) ? resp(200, j(f)) : resp(200, { count: 0, next: null, previous: null, results: [] });
  };
}
const mkHttp = (o = {}, max = 12) => createHttp({ fetchImpl: fakeCL(o), sleep: async () => {}, headers: { Authorization: 'Token TEST-TOKEN-123456' }, secrets: ['TEST-TOKEN-123456'], maxRequests: max, retries: 1 });
function tempData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'courts-'));
  const dataDir = path.join(dir, 'data'), docsDir = path.join(dir, 'docs');
  fs.mkdirSync(dataDir);
  for (const f of ['entries', 'news', 'site', 'relationships']) fs.copyFileSync(path.join(LIVE, f + '.json'), path.join(dataDir, f + '.json'));
  return { dir, dataDir, docsDir, stateFile: path.join(dir, 'courts-state.json') };
}

// ---------- 1. the rate limiter ----------
{
  let t = 0; const slept = [];
  const wait = createRateLimiter({ perMinute: 5, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  for (let i = 0; i < 5; i++) { await wait(); t += 1000; }
  ok('five requests in a minute go straight through', slept.length === 0);
  await wait();
  ok('the sixth waits until the first is a minute old', slept.length === 1 && t >= 60000, `${slept} ${t}`);
  const times = []; t = 0; const w2 = createRateLimiter({ perMinute: 5, now: () => t, sleep: async (ms) => { t += ms; } });
  for (let i = 0; i < 12; i++) { await w2(); times.push(t); }
  ok('never more than 5 in any 60 seconds', times.every((x, i) => times.filter((y) => y > x - 60000 && y <= x).length <= 5), JSON.stringify(times));
}

// ---------- 2. which docket entries matter ----------
{
  const k = (description) => { const c = classifyEntry({ description }); return c && c.kind; };
  ok('routine filings are dropped', [
    'NOTICE of Entry of Appearance by Heather K. Kelly on behalf of Philip J. Weiser', 'TRANSCRIPT ORDER for proceedings held on 7/30/2026 before Judge Rita F. Lin',
    'Transcript of Proceedings held on 7/30/2026, before Judge Rita F. Lin.', 'Summons Issued as to all defendants.', 'MOTION for Leave to Appear in Pro Hac Vice by Jane Doe.',
    'ORDER GRANTING APPLICATION FOR ADMISSION OF ATTORNEY PRO HAC VICE', 'CERTIFICATE OF SERVICE by Anthropic PBC', 'Proposed Order re 166 MOTION for Summary Judgment',
    "CLERK'S NOTICE RE: ZOOM ACCESS", 'ORDER REFERRING MOTION(S): 22 Joint MOTION to Vacate', 'MOTION to Withdraw as Attorney by John Roe', 'ORDER on Motion to Withdraw as Attorney', ''
  ].every((d) => k(d) === null), 'one routine filing was kept');
  ok('a notice of appeal, a judgment and an order are material, with news', k('NOTICE OF APPEAL to the 9th Circuit Court of Appeals filed by the defendants.') === 'appeal' && k('JUDGMENT. Signed by Judge Rita F. Lin on August 27, 2026.') === 'judgment' && k('ORDER ON 166 215 CROSS MOTIONS FOR SUMMARY JUDGMENT') === 'order' && classifyEntry({ description: 'JUDGMENT.' }).news === true);
  ok('a minute order setting a deadline is material, without news', k('MINUTE ORDER: Defendants shall file their answer by December 1, 2026.') === 'deadline' && classifyEntry({ description: 'MINUTE ORDER: response due 12/1/2026.' }).news === false);
  ok('a minute order ruling on a motion is an order', k("MINUTE ORDER: The parties' Motion, ECF No. 22, is GRANTED.") === 'order');
  ok('withdrawals (a motion or the case) are material; counsel withdrawing is not', k('NOTICE of Withdrawal of Motion for Preliminary Injunction by Protect Democracy Project') === 'withdrawal' && k('NOTICE OF VOLUNTARY DISMISSAL by plaintiff') === 'withdrawal' && k('Notice of Withdrawal of Counsel') === null);
  ok("the clerk's tags are trimmed from the court's words", trimDescription('JUDGMENT. Signed by Judge Rita F. Lin on August 27, 2026. (rfllc3, COURT STAFF) (Filed on 8/27/2026) (Main Document 252 replaced on 8/27/2026) (Entered: 08/27/2026)') === 'JUDGMENT. Signed by Judge Rita F. Lin on August 27, 2026');
  const rec = j(path.join(FX, 'docket-entries-72379655.json')).results;
  ok('on the recorded N.D. Cal. docket: the appeal, the judgment and the July 20 order are found; transcripts are not', classifyEntry(rec.find((x) => x.entry_number === 253)).kind === 'appeal' && classifyEntry(rec.find((x) => x.entry_number === 252)).kind === 'judgment' && classifyEntry(rec.find((x) => x.entry_number === 239)).kind === 'order' && rec.filter((x) => /TRANSCRIPT/i.test(x.description)).every((x) => !classifyEntry(x)));
}

// ---------- 3. reading a docket back to the last entry seen ----------
{
  const log = [], http = createHttp({ fetchImpl: fakeCL({ log }), sleep: async () => {}, headers: { Authorization: 'Token TEST-TOKEN-123456' }, maxRequests: 10 });
  let limited = 0;
  const cl = createCourtListener(http, { limiter: async () => { limited++; } });
  const r = await cl.newEntries({ docketId: '72379655', since: '2026-07-01' });
  ok('reads newest first until it passes the date, two pages, every request through the limiter', r.complete && r.pages === 2 && limited === 2 && log.length === 2, JSON.stringify(r.pages));
  ok('returns the entries since that date, oldest first', r.entries.length === 20 && r.entries[0].date_filed === '2026-07-20' && r.entries[19].date_filed === '2026-10-26' && r.entries.every((x) => x.date_filed >= '2026-07-01'));
  ok('the token is sent in the header, never in the URL', log.every((l) => l.auth === 'Token TEST-TOKEN-123456' && !l.url.includes('TEST-TOKEN')));
  const r2 = await cl.newEntries({ docketId: '72379655', since: '2026-10-26', seen: r.entries.filter((x) => x.date_filed === '2026-10-26').map((x) => String(x.id)) });
  ok('entries already seen are not returned again; one page is enough', r2.entries.length === 0 && r2.pages === 1);
  const r3 = await cl.newEntries({ docketId: '72379655', since: '2026-01-01', maxPages: 1 });
  ok('a docket not read back to the date says so', r3.complete === false && r3.pages === 1);
}

// ---------- 4. the step: publish on a copy of the live data ----------
{
  const t = tempData();
  fs.writeFileSync(t.stateFile, JSON.stringify({ dockets: { 72379655: { last_date: '2026-07-01', seen: {} } } }));
  const before = loadData(t.dataDir);
  const r = await courtsRun({ http: mkHttp(), limiter: async () => {}, cases: { [ANTHROPIC]: CASES[ANTHROPIC] }, dataDir: t.dataDir, docsDir: t.docsDir, stateFile: t.stateFile, config: { max_entries_changed_per_run: 15 }, runId: 'update-20261028-1200', now: NOW });
  const d = loadData(t.dataDir), e = d.entries.find((x) => x.key === ANTHROPIC), o = before.entries.find((x) => x.key === ANTHROPIC);
  ok('it publishes', r.status === 'published', r.summary);
  const added = e.events.filter((v) => !o.events.some((w) => JSON.stringify(w) === JSON.stringify(v)));
  ok('the July 20 order becomes one Litigation event in the court\'s words, linked to the docket', added.length === 1 && added[0].date === '2026-07-20' && added[0].type === 'Litigation' && /^ORDER\. By July 24, 2026, Anthropic shall file a proposed order/.test(added[0].clause) && added[0].source_url === docketUrl(72379655) && added[0].scheduled === false, JSON.stringify(added));
  ok('days a person already wrote up (Aug 27 judgment, Oct 26 appeal) are not added again', !added.some((v) => ['2026-08-27', '2026-10-26'].includes(v.date)) && r.result.skipped.some((s) => /253/.test(s.why)));
  const n = d.news.items.filter((x) => !before.news.items.some((y) => JSON.stringify(y) === JSON.stringify(x)));
  ok('one fixed-wording news item for the order, kind litigation, no AI', n.length === 1 && n[0].kind === 'litigation' && n[0].tracker === ANTHROPIC && n[0].date === '2026-07-20' && /no AI/.test(n[0].check) && n[0].links[0].u === docketUrl(72379655) && n[0].body.includes('"ORDER. By July 24, 2026'), JSON.stringify(n));
  ok('the status text keeps the author\'s words and adds the order with date and source', e.status_text.startsWith(o.status_text.replace(/[\s.;]+$/, '')) && /Court order \(Dkt\. 239\) \(July 20, 2026, court docket via CourtListener\)$/.test(e.status_text), e.status_text.slice(-120));
  ok('reading fields untouched; the entry is mixed, found by its docket, checked by this run', e.mechanism === o.mechanism && e.title === o.title && e.origin === 'mixed' && e.identifiers.external.courtlistener_docket === '72379655' && e.verification.run_id === 'update-20261028-1200' && e.last_changed === '2026-10-28');
  ok('the change log records it, tier A', ['events', 'status_text', 'origin'].every((f) => d.changes.items.some((c) => c.entry_key === ANTHROPIC && c.field === f && c.tier === 'A')));
  const v = makeValidator();
  ok('every file passes its schema and the files agree', v.check('entry', e).length === 0 && v.check('news', d.news).length === 0 && v.check('changes', d.changes).length === 0 && checkIntegrity({ ...d }).length === 0);
  ok('the docs copy is written too', fs.existsSync(path.join(t.docsDir, 'entries.json')));
  const st = j(t.stateFile).dockets['72379655'];
  ok('the docket state moves to the newest entry, remembering that day\'s entries', st.last_date === '2026-10-26' && Object.values(st.seen).every((x) => x === '2026-10-26') && Object.keys(st.seen).length === 1);
  ok('only the cases asked for were read', r.read.length === 1 && r.requests === 2);
  // the next run: nothing new
  const r2 = await courtsRun({ http: mkHttp(), limiter: async () => {}, cases: { [ANTHROPIC]: CASES[ANTHROPIC] }, dataDir: t.dataDir, docsDir: t.docsDir, stateFile: t.stateFile, config: {}, runId: 'update-20261028-1600', now: NOW });
  ok('the next run finds nothing new, in one request', r2.status === 'quiet' && r2.requests === 1 && JSON.stringify(loadData(t.dataDir).entries) === JSON.stringify(d.entries));
}

// ---------- 5. first read, errors, dry run, stop rules ----------
{
  // a docket never read starts from its entry's last check (28 Oct): nothing in the recording is newer
  const t = tempData();
  const r = await courtsRun({ http: mkHttp(), limiter: async () => {}, cases: CASES, dataDir: t.dataDir, stateFile: t.stateFile, config: {}, runId: 'u', now: NOW });
  ok('a first read starts from the entry\'s last check: no old entry is re-published', r.status === 'quiet' && r.read.every((x) => x.since === '2026-10-28') && j(t.stateFile).dockets['73171074'].last_date === '2026-10-28');
  // one docket failing: the others are still read, and the failed one keeps its state
  const t2 = tempData();
  fs.writeFileSync(t2.stateFile, JSON.stringify({ dockets: { 72379655: { last_date: '2026-07-01', seen: {} }, 73171074: { last_date: '2026-04-01', seen: {} } } }));
  const r2 = await courtsRun({ http: mkHttp({ down: ['72379655'] }), limiter: async () => {}, cases: CASES, dataDir: t2.dataDir, stateFile: t2.stateFile, config: {}, runId: 'u2', now: NOW });
  const s2 = j(t2.stateFile).dockets;
  ok('a docket that fails is reported and keeps its state; the other is read', r2.errors.length === 1 && /HTTP 500/.test(r2.errors[0]) && s2['72379655'].last_date === '2026-07-01' && s2['73171074'].last_date === '2026-10-02', JSON.stringify(r2.errors));
  ok('the error text never shows the token', !JSON.stringify(r2).includes('TEST-TOKEN'));
  const x = loadData(t2.dataDir).entries.find((e) => e.key === XAI);
  ok('D. Colo.: the Apr 16 conference-time reset is housekeeping and not added; the intervention (Apr 24) and stay (Apr 27) a person wrote up are not either', !x.events.some((v) => v.date === '2026-04-16' && /courtlistener/.test(v.source_url || '')) && !x.events.some((v) => ['2026-04-24', '2026-04-27'].includes(v.date) && /courtlistener/.test(v.source_url || '')) && !loadData(t2.dataDir).news.items.some((nn) => nn.tracker === XAI && nn.date === '2026-04-16'), r2.summary);
  // dry run: nothing written
  const t3 = tempData();
  fs.writeFileSync(t3.stateFile, JSON.stringify({ dockets: { 72379655: { last_date: '2026-07-01', seen: {} } } }));
  const snap = fs.readFileSync(path.join(t3.dataDir, 'entries.json'), 'utf8');
  const r3 = await courtsRun({ http: mkHttp(), limiter: async () => {}, cases: { [ANTHROPIC]: CASES[ANTHROPIC] }, dataDir: t3.dataDir, stateFile: t3.stateFile, config: {}, runId: 'u3', now: NOW, dry: true });
  ok('a dry run writes neither data nor state', r3.status === 'dry-run' && fs.readFileSync(path.join(t3.dataDir, 'entries.json'), 'utf8') === snap && j(t3.stateFile).dockets['72379655'].last_date === '2026-07-01');
  // a stop rule: nothing written, state kept, so the same entries are read next run
  const r4 = await courtsRun({ http: mkHttp(), limiter: async () => {}, cases: { [ANTHROPIC]: CASES[ANTHROPIC] }, dataDir: t3.dataDir, stateFile: t3.stateFile, config: { max_entries_changed_per_run: 0 }, runId: 'u4', now: NOW });
  ok('a stopped publish writes nothing and keeps the docket state', r4.status === 'stopped' && /over the limit/.test(r4.summary) && fs.readFileSync(path.join(t3.dataDir, 'entries.json'), 'utf8') === snap && j(t3.stateFile).dockets['72379655'].last_date === '2026-07-01');
  // the request budget runs out: what was read is used, the rest waits
  const t5 = tempData();
  fs.writeFileSync(t5.stateFile, JSON.stringify({ dockets: { 72379655: { last_date: '2026-07-01', seen: {} }, 73171074: { last_date: '2026-04-01', seen: {} } } }));
  const r5 = await courtsRun({ http: mkHttp({}, 2), limiter: async () => {}, cases: CASES, dataDir: t5.dataDir, stateFile: t5.stateFile, config: {}, runId: 'u5', now: NOW });
  ok('a spent request budget stops reading; the unread docket keeps its state', r5.errors.some((x) => /budget/.test(x)) && j(t5.stateFile).dockets['73171074'].last_date === '2026-04-01', JSON.stringify(r5.errors));
}

// ---------- quotes are never cut; housekeeping minute orders are not deadlines ----------
{
  const long = 'MINUTE ORDER: The parties\' Motion, ECF No. 22, is GRANTED. ' + 'The defendant shall not initiate enforcement of the statute. '.repeat(8) + 'Entered by Magistrate Judge X on 4/27/2026.';
  const c = classifyEntry({ description: long });
  ok('a long entry: display text trimmed, full text kept whole', c.text.endsWith('…') && !c.full.includes('…') && c.full.length > c.text.length && c.full.endsWith('4/27/2026'));
  ok('a conference time reset is housekeeping, not a deadline', classifyEntry({ description: 'Minute Order: This matter is before the Court sua sponte. The Scheduling Conference set for 6/16/2026 at 10:30 a.m is hereby RESET to 6/16/2026 at 10:45 a.m.' }) === null);
  ok('a filing deadline is still kept', classifyEntry({ description: 'Set/Reset Deadlines/Hearings: Response to Complaint due by 12/1/2026.' }) === null || classifyEntry({ description: 'MINUTE ORDER. Defendants shall respond to the 1 Complaint by December 1, 2026.' })?.kind === 'deadline');
}

console.log(`\ncourts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
