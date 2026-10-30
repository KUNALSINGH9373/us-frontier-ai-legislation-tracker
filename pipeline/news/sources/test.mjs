// Run:  node news/sources/test.mjs
// Official news source adapters (news/sources/*.mjs) against responses recorded live on 29 Oct 2026
// (fixtures/news/sources/<adapter>/, index.json maps each request URL, API key removed, to its recorded file). Offline, no AI.
// Positive cases the live day did not contain (a hearing on a tracked bill, a law from a tracked bill, an AI nomination) are made by
// changing one field of a recorded response in memory; the files on disk stay as recorded.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as M from './match.mjs';
import * as C from './common.mjs';
import * as FR from './federal_register.mjs';
import * as CX from './congress_extra.mjs';
import * as GI from './govinfo.mjs';
import * as RG from './regulations_gov.mjs';
import * as WH from './whitehouse.mjs';
import * as NIST from './nist.mjs';
import * as CBO from './cbo.mjs';
import * as CAAG from './ca_ag.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', '..', 'fixtures', 'news', 'sources');
const ENTRIES = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'web', 'data', 'v2', 'entries.json'), 'utf8'));
const KEY = 'TESTKEY-abcdef123456';
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const clone = (o) => JSON.parse(JSON.stringify(o));

// Fixture transport. patch(url, data) may change a recorded JSON body (or text) before it is served.
function fixtureHttp(name, { patch = null, calls = [] } = {}) {
  const dir = path.join(FIX, name);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const http = async (url) => {
    calls.push(url);
    const k = url.replace(/([?&])api_key=[^&]*&?/, '$1').replace(/[?&]$/, '');
    const rec = idx.responses[k];
    if (!rec) return { status: 404, text: 'not recorded' };
    let text = fs.readFileSync(path.join(dir, rec.file), 'utf8');
    if (patch) { const isJson = rec.file.endsWith('.json'); const out = patch(k, isJson ? JSON.parse(text) : text); if (out !== undefined) text = isJson ? JSON.stringify(out) : out; }
    return { status: rec.status, text };
  };
  return { http, recordedAt: idx.recorded_at, calls };
}
const plainOk = (items) => items.every((i) => !/[<>]/.test(i.title) && Object.values(i.facts).every((v) => typeof v !== 'string' || !/<\/?[a-z][^>]*>/i.test(v)));
const shapeOk = (items, source) => items.every((i) => i.source === source && i.source_id && /^\d{4}-\d{2}-\d{2}$/.test(i.date) && /^https:\/\//.test(i.url) && i.title && i.retrieved_at && 'entry_id' in i && 'class' in i && i.jurisdiction);
const noKeyLeak = (out) => !JSON.stringify(out).includes(KEY);

// ---------- 1. matcher ----------
const I = M.buildIndex(ENTRIES);
const mt = (t, j) => M.matchText(I, t, j).entry_id;
ok('1.1 "S. 2938" -> S 2938 entry', mt('S. 2938', 'US') === 's-2938-ai-risk-evaluation-act');
ok('1.2 "S2938" -> same', mt('S2938', 'US') === 's-2938-ai-risk-evaluation-act');
ok('1.3 "S.2938" and "S 2938" -> same', mt('S.2938', 'US') === 's-2938-ai-risk-evaluation-act' && mt('S 2938', 'US') === 's-2938-ai-risk-evaluation-act');
ok('1.4 "SB 53" in CA -> TFAIA', mt('Governor signs SB 53 today', 'CA') === 'ca-sb-53-tfaia');
ok('1.5 "S.B. 53" and "SB53" in CA -> TFAIA', mt('S.B. 53', 'CA') === 'ca-sb-53-tfaia' && mt('SB53', 'CA') === 'ca-sb-53-tfaia');
ok('1.6 near miss "SB 530" does not match SB 53', mt('SB 530', 'CA') === null);
ok('1.7 near miss "SB 5" / "SB 535" / "SB 53.5" do not match', mt('SB 5', 'CA') === null && mt('SB 535', 'CA') === null && mt('SB 53.5', 'CA') === null);
ok('1.8 "SB 53" outside California does not match', mt('SB 53', 'NY') === null && mt('SB 53', 'US') === null);
ok('1.9 NY "A6453" and "A06453" -> RAISE Act', mt('A6453', 'NY') === 'ny-raise-act-ch-699-ch-96' && mt('A06453', 'NY') === 'ny-raise-act-ch-699-ch-96');
ok('1.10 NY "A.6453-B" and "S.6953-B" -> RAISE Act', mt('A.6453-B', 'NY') === 'ny-raise-act-ch-699-ch-96' && mt('S.6953-B', 'NY') === 'ny-raise-act-ch-699-ch-96');
ok('1.11 NY near miss "A64530" / "A645" no match', mt('A64530', 'NY') === null && mt('A645', 'NY') === null);
ok('1.12 "U.S. 2938" is not a bill', mt('Title 42 U.S. 2938', 'US') === null && M.billTokens('U.S. 2938', 'US').length === 0);
ok('1.13 "S. 29" is not S. 2938', mt('S. 29', 'US') === null);
ok('1.14 "S. 29380" is not S. 2938', mt('S. 29380', 'US') === null);
ok('1.15 H.R. 9925 forms', ['H.R. 9925', 'H.R.9925', 'HR 9925', 'HR9925', 'H. R. 9925'].every((t) => mt(t, 'US') === 'h-r-9925-frontier-act'));
ok('1.16 federal "HB 9925" is not H.R. 9925', mt('HB 9925', 'US') === null);
ok('1.17 lower-case prose "s 2938" never counts', mt('s 2938', 'US') === null);
ok('1.18 companion bills map to one entry', mt('S. 5105', 'US') === 'h-r-9914-s-5105-catsr' && mt('H.R. 9914', 'US') === 'h-r-9914-s-5105-catsr');
ok('1.19 two different tracked bills in one text -> null (ambiguous)', mt('S. 2938 and H.R. 9925', 'US') === null);
ok('1.20 same entry twice -> still matches', mt('H.R. 9914 and its companion S. 5105', 'US') === 'h-r-9914-s-5105-catsr');
ok('1.21 official short title matches', mt('CBO scores the Artificial Intelligence Risk Evaluation Act of 2025', 'US') === 's-2938-ai-risk-evaluation-act');
ok('1.22 short title without year matches', mt('the Artificial Intelligence Risk Evaluation Act would', 'US') === 's-2938-ai-risk-evaluation-act');
ok('1.23 title in another jurisdiction does not match', mt('Artificial Intelligence Risk Evaluation Act', 'CA') === null);
ok('1.24 partial title does not match', mt('Artificial Intelligence Risk Evaluation', 'US') === null);
ok('1.25 shared title (two IL entries) -> null', mt('AI Safety Measures Act', 'IL') === null);
ok('1.26 EO number forms', mt('Executive Order 14434', 'US') === 'eo-14434-super-intelligence-terminology-order' && mt('EO 14365', 'US') === 'eo-14365-state-law-framework' && mt('E.O. 14409', 'US') === 'eo-14409-pre-release-access');
ok('1.27 EO near miss 14343 / 143650 no match', mt('Executive Order 14343', 'US') === null && mt('Executive Order 143650', 'US') === null);
ok('1.28 an EO cited in passing by another entry is not that entry', mt('EO 14365', 'US') === 'eo-14365-state-law-framework');
ok('1.29 EO quoted title matches', mt('Inaugurating The Era Of Super Intelligence', 'US') === 'eo-14434-super-intelligence-terminology-order');
ok('1.30 excluded entries are never matched', mt('Texas HB 149', 'TX') === null && mt('SB 5395', 'WA') === null);
ok('1.31 matchBill structured', M.matchBill(I, { jurisdiction: 'US', type: 'S', number: '2938', congress: 119 }) === 's-2938-ai-risk-evaluation-act'
  && M.matchBill(I, { jurisdiction: 'US', type: 'hr', number: '09925' }) === 'h-r-9925-frontier-act');
ok('1.32 matchBill wrong congress -> null', M.matchBill(I, { jurisdiction: 'US', type: 'S', number: '2938', congress: 118 }) === null);
ok('1.33 matchBill near miss -> null', M.matchBill(I, { jurisdiction: 'US', type: 'S', number: '29380', congress: 119 }) === null);
ok('1.34 bad jurisdiction -> null', mt('S. 2938', 'Federal') === null && mt('S. 2938', null) === null);
ok('1.35 MN "H.F. 4532" and "HF4532"', mt('H.F. 4532', 'MN') === 'mn-hf-4532-no-threshold' && mt('HF4532', 'MN') === 'mn-hf-4532-no-threshold');
ok('1.36 PA state "H.R. 637" resolution is not "HB 637"', mt('H.R. 637', 'PA') === 'pa-h-r-637-frontier-ai-resolution' && mt('HB 637', 'PA') === null);
ok('1.37 CT SB 5 shared by two entries -> null', mt('S.B. 5', 'CT') === null);
ok('1.38 "Section 5" / "A 12" prose not bills', M.billTokens('Section 5 of A 12', 'NY').length === 0);
ok('1.39 normBill', M.normBill('S. 2938', 'US') === 'S2938' && M.normBill('A06453', 'NY') === 'AB6453' && M.normBill('SB 53', 'CA') === 'SB53');
ok('1.40 matched-by reported', M.matchText(I, 'S. 2938', 'US').by === 'number' && M.matchText(I, 'AI Kill Switch Act', 'US').by === 'title');

// ---------- 2. common ----------
ok('2.1 dateOk accepts retrieval day + 1, rejects + 2 and impossible dates', C.dateOk('2026-10-30', '2026-10-29T10:00:00Z') && !C.dateOk('2026-10-31', '2026-10-29T10:00:00Z') && !C.dateOk('2026-02-30', '2026-10-29') && !C.dateOk('10/29/2026', '2026-10-29') && !C.dateOk('1980-01-01', '2026-10-29'));
ok('2.2 hostAllowed: https on the list only (subdomains ok)', C.hostAllowed('https://www.federalregister.gov/x', ['federalregister.gov']) && !C.hostAllowed('http://www.federalregister.gov/x', ['federalregister.gov'])
  && !C.hostAllowed('https://federalregister.gov.evil.com/x', ['federalregister.gov']) && !C.hostAllowed('https://evilfederalregister.gov/x', ['federalregister.gov']));
ok('2.3 redact removes keys', !C.redact(`x?api_key=${KEY}&a=1`, KEY).includes(KEY) && !C.redact('u?api_key=SECRET999', '').includes('SECRET999'));
ok('2.4 etDate in Washington time', C.etDate('2026-10-14T03:59:59Z') === '2026-10-13' && C.etDate('2026-10-28T20:03:48Z') === '2026-10-28');
ok('2.5 isAI', C.isAI('Inaugurating the Era of Super Intelligence') && C.isAI('AI Kill Switch Act') && !C.isAI('Thai food') && !C.isAI('Said a thing') && !C.isAI('Music Streaming Fraud'));
ok('2.6 config has hosts for every adapter', ['federal_register', 'congress_extra', 'govinfo', 'regulations_gov', 'whitehouse', 'nist', 'cbo', 'ca_ag'].every((n) => C.sourceConfig(n).hosts.length > 0 && C.sourceConfig(n).cadence_hours > 0 && !('cadence' in C.sourceConfig(n))));

const run = async (mod, name, opts = {}) => {
  const f = fixtureHttp(name, opts);
  const out = await mod.fetchItems({ http: f.http, env: { CONGRESS_API_KEY: KEY, ...(opts.env || {}) }, since: opts.since, entries: ENTRIES, now: opts.now || f.recordedAt, state: {} });
  return { out, calls: f.calls, recordedAt: f.recordedAt };
};
const throwing = async () => { throw new Error(`boom api_key=${KEY}`); };
const status500 = async () => ({ status: 500, text: 'err' });

// ---------- 3. Federal Register ----------
{
  const { out } = await run(FR, 'federal_register', { since: '2026-09-01' });
  const eo = out.items.find((i) => i.class === 'executive-order');
  ok('3.1 health ok with items', out.health.ok && out.health.count === out.items.length && out.items.length >= 3, JSON.stringify(out.health));
  ok('3.2 EO 14434: signing date, entry, verbatim title, FR url', eo && eo.date === '2026-09-29' && eo.entry_id === 'eo-14434-super-intelligence-terminology-order' && eo.title === 'Inaugurating the Era of Super Intelligence'
    && eo.facts.eo_number === '14434' && eo.source_id === '2026-20321' && /^https:\/\/www\.federalregister\.gov\//.test(eo.url), JSON.stringify(eo));
  ok('3.3 comment-period-open dated the publication day with comments_close', out.items.some((i) => i.class === 'comment-period-open' && i.facts.comments_close && i.date === i.facts.publication_date));
  ok('3.4 no comment-period-closing before the close date', !out.items.some((i) => i.class === 'comment-period-closing'));
  ok('3.5 noise dropped (full-text hits without AI in title/abstract)', !out.items.some((i) => /ETC Tiger Pipeline|Music Streaming Fraud/.test(i.title)));
  ok('3.6 shape + plain text', shapeOk(out.items, 'federal_register') && plainOk(out.items));
  ok('3.7 newest reported', out.health.newest === out.items.map((i) => i.date).sort().pop());
  ok('3.8 state cursor returned', out.state && /^\d{4}-\d{2}-\d{2}$/.test(out.state.since));
  const later = await run(FR, 'federal_register', { since: '2026-09-01', now: '2026-12-01T12:00:00Z' });
  const cl = later.out.items.filter((i) => i.class === 'comment-period-closing');
  ok('3.9 after the close date: comment-period-closing dated comments_close', cl.length >= 1 && cl.every((i) => i.date === i.facts.comments_close && i.date <= '2026-12-01'), JSON.stringify(cl.map((i) => i.date)));
  // Injected: a future-dated document, a foreign host, an HTML title, a memorandum, a public-inspection AI filing.
  let piTitle = 'Revoking an Order on Artificial Intelligence';
  const patch = (k, d) => {
    if (/PRESDOCU/.test(k)) {
      const base = d.results.find((r) => r.executive_order_number === '14434');
      d.results.push({ ...base, document_number: 'FUT-1', signing_date: '2027-03-01', publication_date: '2027-03-04' });
      d.results.push({ ...base, document_number: 'EVIL-1', html_url: 'https://evil.example.com/doc' });
      d.results.push({ ...base, document_number: 'MEMO-1', subtype: 'Memorandum', executive_order_number: null, title: 'Advancing <b>Artificial Intelligence</b> Security', signing_date: '2026-10-01' });
      // review r9 B1/B2: an untracked order revoking or amending a tracked one, and a printing correction of a tracked one
      d.results.push({ ...base, document_number: '2026-50001', executive_order_number: '15050', title: 'Revoking Executive Order 14434 on Artificial Intelligence', abstract: base.title, signing_date: '2026-10-20' });
      d.results.push({ ...base, document_number: '2026-50002', executive_order_number: '15051', title: 'Amendments to Executive Order 14434 on Artificial Intelligence', abstract: base.title, signing_date: '2026-10-21' });
      d.results.push({ ...base, document_number: 'C1-2026-50003' });
      d.results.push({ ...base, document_number: '2026-50004', subtype: 'Memorandum', executive_order_number: null, title: `Memorandum Amending ${base.title}`, signing_date: '2026-10-22' });
      piTitle = `Revoking ${base.title}`;
      return d;
    }
    if (/public-inspection/.test(k)) { d.results.push({ ...d.results[0], document_number: '2026-99998', title: piTitle, type: 'Presidential Document', filed_at: '2026-10-28T08:45:00.000-04:00', html_url: 'https://www.federalregister.gov/public-inspection/2026-99998/x' }); d.results.push({ ...d.results[0], document_number: '2026-99999', title: 'Artificial Intelligence Evaluation Framework; Request for Information', type: 'Notice', filed_at: '2026-10-28T08:45:00.000-04:00', html_url: 'https://www.federalregister.gov/public-inspection/2026-99999/x' }); return d; }
  };
  const inj = await run(FR, 'federal_register', { since: '2026-09-01', patch });
  ok('3.10 future-dated document rejected (counted)', !inj.out.items.some((i) => i.source_id === 'FUT-1') && inj.out.health.rejected >= 1);
  ok('3.11 host not on the allowlist rejected', !inj.out.items.some((i) => i.source_id === 'EVIL-1'));
  const memo = inj.out.items.find((i) => i.source_id === 'MEMO-1');
  ok('3.12 memorandum -> presidential-memo, HTML stripped from title', memo && memo.class === 'presidential-memo' && memo.title === 'Advancing Artificial Intelligence Security', JSON.stringify(memo));
  const pi = inj.out.items.find((i) => i.source_id === 'pi:2026-99999');
  ok('3.13 public inspection: filing day, flagged; a request for information is not guidance (review r10), so no class', pi && pi.date === '2026-10-28' && pi.class === null && pi.facts.public_inspection === true, JSON.stringify(pi));
  ok('3.14 rejected items do not make health fail', inj.out.health.ok);
  const rv = inj.out.items.filter((i) => ['2026-50001', '2026-50002'].includes(i.source_id));
  ok('3.14b an untracked order revoking or amending a tracked one is on no entry', rv.length === 2 && rv.every((i) => !i.entry_id), JSON.stringify(rv.map((i) => [i.source_id, i.entry_id])));
  const chg = inj.out.items.filter((i) => ['2026-50004', 'pi:2026-99998'].includes(i.source_id));
  ok('3.14d a memorandum or filed document changing an order is on no entry', chg.length === 2 && chg.every((i) => !i.entry_id), JSON.stringify(chg.map((i) => [i.source_id, i.entry_id])));
  ok('3.14e the tracked order own document is still on its entry', inj.out.items.some((i) => i.facts.eo_number === '14434' && i.entry_id === 'eo-14434-super-intelligence-terminology-order'));
  ok('3.14c a Federal Register correction (C1-...) is not an item', !inj.out.items.some((i) => /^C1-/.test(i.source_id)));
  const bad = await FR.fetchItems({ http: status500, entries: ENTRIES, since: '2026-09-01' });
  ok('3.15 HTTP 500: no throw, health not ok, error reported', bad.items.length === 0 && !bad.health.ok && bad.health.errors.some((e) => /HTTP 500/.test(e)));
  const thr = await FR.fetchItems({ http: throwing, entries: ENTRIES });
  ok('3.16 transport throws: no throw, health not ok, key redacted', !thr.health.ok && noKeyLeak(thr));
  ok('3.17 classify', FR.classify({ type: 'Rule' }) === 'agency-rule-final' && FR.classify({ type: 'Proposed Rule' }) === 'agency-rule-proposed' && FR.classify({ type: 'Notice', title: 'Sunshine Act Meetings' }) === null
    && FR.classify({ type: 'Presidential Document', subtype: 'Proclamation' }) === null);
}

// ---------- 4. Congress.gov extra ----------
{
  const nk = await CX.fetchItems({ http: status500, env: {}, entries: ENTRIES });
  ok('4.1 no key -> no items, "no key"', nk.items.length === 0 && !nk.health.ok && nk.health.errors[0] === 'no key');
  const { out, calls } = await run(CX, 'congress_extra', { since: '2026-10-10' });
  ok('4.2 recorded day: no tracked bill at a hearing, no AI CRS bill, no AI nomination -> 0 items, health ok', out.items.length === 0 && out.health.ok, JSON.stringify(out.health));
  ok('4.3 per-run calls small (<= 28)', calls.length <= 3 + CX.MAX_MEETINGS + CX.MAX_CRS, String(calls.length));
  ok('4.4 key never in output', noKeyLeak(out));
  const patch = (k, d) => {
    if (/committee-meeting\/119\/house\/119549/.test(k)) { d.committeeMeeting.relatedItems.bills.push({ congress: 119, number: '2938', type: 'S' }); return d; }
    if (/committee-meeting\/119\/house\/118597/.test(k)) { d.committeeMeeting.relatedItems = { bills: [{ congress: 119, number: '29380', type: 'S' }] }; return d; }
    if (/committee-meeting\/119\/house\/119520/.test(k)) { d.committeeMeeting.relatedItems = { bills: [{ congress: 119, number: '9925', type: 'HR' }] }; d.committeeMeeting.date = '2026-11-12T15:00:00Z'; d.committeeMeeting.type = 'Hearing'; d.committeeMeeting.meetingStatus = 'Scheduled'; return d; }
    if (/crsreport\/IF13336/.test(k)) { d.CRSReport.summary += ' The AI Kill Switch Act (H.R. 9917) would require ...'; return d; }
    if (/crsreport\/LSB11429/.test(k)) { d.CRSReport.relatedMaterials = [{ congress: 119, number: 2938, type: 'S' }, { congress: 119, number: 9925, type: 'HR' }]; return d; }
    if (/nomination\?/.test(k)) {
      d.nominations.push({ ...d.nominations[0], congress: 119, citation: 'PN999', number: 999, description: 'Jane Doe, of Virginia, to be Director of the Office of Science and Technology Policy, vice John Roe, resigned.', receivedDate: '2026-10-20' });
      d.nominations.push({ ...d.nominations[0], congress: 119, citation: 'PN998', number: 998, description: 'Jim Doe, of Ohio, to be Archivist of the United States.', receivedDate: '2026-10-20' });
      d.nominations.push({ ...d.nominations[0], congress: 118, citation: 'PN997', number: 997, description: 'Old Nominee, to be Director of the National Institute of Standards and Technology.', receivedDate: '2024-01-20' });
      return d;
    }
  };
  const inj = (await run(CX, 'congress_extra', { since: '2026-10-10', patch })).out;
  // The real record of meeting 119549 says "Rescheduled": it did not take place on its listed (past) date (review r9 #2).
  const resched = inj.items.find((i) => i.source_id === 'meeting:119/house/119549');
  ok('4.5 rescheduled meeting with a past date -> not held, withdrawn', resched && resched.class !== 'hearing-held' && resched.facts.withdrawn === true, JSON.stringify(resched && { class: resched.class, facts: resched.facts }));
  const asStatus = (status) => (k, d) => { const r = patch(k, d); if (/committee-meeting\/119\/house\/119549/.test(k)) d.committeeMeeting.meetingStatus = status; return r || d; };
  const held = (await run(CX, 'congress_extra', { since: '2026-10-10', patch: asStatus('Scheduled') })).out.items.find((i) => i.source_id === 'meeting:119/house/119549');
  ok('4.5b past meeting still "Scheduled" -> hearing-held on the meeting day', held && held.class === 'hearing-held' && held.entry_id === 's-2938-ai-risk-evaluation-act' && held.date === '2026-09-15' && /congress\.gov\/event\//.test(held.url), JSON.stringify(held));
  for (const s of ['Postponed', 'Canceled', 'Tentative', '']) {
    const x = (await run(CX, 'congress_extra', { since: '2026-10-10', patch: asStatus(s) })).out.items.find((i) => i.source_id === 'meeting:119/house/119549');
    ok(`4.5c past meeting with status "${s}" -> not held`, x && x.class !== 'hearing-held', JSON.stringify(x && x.class));
  }
  ok('4.6 near-miss related bill (S. 29380) -> nothing', !inj.items.some((i) => i.source_id === 'meeting:119/house/118597'));
  const sch = inj.items.find((i) => i.source_id === 'meeting:119/house/119520');
  ok('4.7 future meeting -> hearing-scheduled, dated when listed (not the future day), meeting_date in facts', sch && sch.class === 'hearing-scheduled' && sch.date <= inj.items[0].retrieved_at.slice(0, 10) && sch.facts.hearing_date === '2026-11-12', JSON.stringify(sch));
  const crs = inj.items.find((i) => i.class === 'crs-report');
  ok('4.8 CRS report naming a tracked bill -> crs-report', crs && crs.entry_id === 'h-r-9917-ai-kill-switch-act' && crs.source_id.startsWith('crs:IF13336') && /congress\.gov\/crs-product\/IF13336/.test(crs.url), JSON.stringify(crs));
  ok('4.9 CRS report related to two tracked bills -> not attached (ambiguous)', !inj.items.some((i) => /LSB11429/.test(i.source_id)));
  const nom = inj.items.filter((i) => i.class === 'nomination');
  ok('4.10 only the AI-relevant 119th-Congress nomination', nom.length === 1 && nom[0].source_id === 'nomination:119/PN999' && nom[0].date === '2026-10-20' && nom[0].entry_id === null, JSON.stringify(nom));
  ok('4.11 shape + plain text', shapeOk(inj.items, 'congress_extra') && plainOk(inj.items) && noKeyLeak(inj));
  const thr = await CX.fetchItems({ http: throwing, env: { CONGRESS_API_KEY: KEY }, entries: ENTRIES });
  ok('4.12 transport throws: no throw, key redacted', !thr.health.ok && noKeyLeak(thr));
}

// ---------- 5. GovInfo ----------
{
  ok('5.1 key fallback order', GI.keyOf({ GOVINFO_API_KEY: 'a', DATA_GOV_API_KEY: 'b', CONGRESS_API_KEY: 'c' }) === 'a' && GI.keyOf({ DATA_GOV_API_KEY: 'b', CONGRESS_API_KEY: 'c' }) === 'b' && GI.keyOf({ CONGRESS_API_KEY: 'c' }) === 'c' && GI.keyOf({}) === null);
  ok('5.2 no key', (await GI.fetchItems({ http: status500, env: {}, entries: ENTRIES })).health.errors[0] === 'no key');
  ok('5.3 parseBillPackage', JSON.stringify(GI.parseBillPackage('BILLS-119hr4307enr')) === JSON.stringify({ congress: 119, type: 'HR', number: '4307', version: 'enr' }) && GI.parseBillPackage('PLAW-119publ1') === null);
  const { out } = await run(GI, 'govinfo', { since: '2026-10-22' });
  const tv = out.items.find((i) => /BILLS-119hr10873/.test(i.source_id));
  ok('5.4 recorded: the introduced text of tracked H.R. 10873 is recorded with no class (it is not new text, review r13)', tv && tv.class === null && tv.entry_id === 'h-r-10873-ai-cyber-defense-act' && tv.facts.number === 'H.R. 10873' && /govinfo\.gov\/app\/details\/BILLS-119hr10873/.test(tv.url), JSON.stringify(tv));
  ok('5.5 recorded: no became-law (no tracked bill became law)', !out.items.some((i) => i.class === 'became-law') && out.health.ok);
  ok('5.6 untracked bills ignored', out.items.every((i) => i.entry_id));
  const inj = (await run(GI, 'govinfo', { since: '2026-10-22', patch: (k, d) => { if (/related\/PLAW-119publ131\/BILLS/.test(k)) { d.results = d.results.map((r) => ({ ...r, packageId: r.packageId.replace('hr4307', 's2938') })); return d; } } })).out;
  const law = inj.items.find((i) => i.class === 'became-law');
  ok('5.7 law whose bill versions are a tracked bill -> became-law confirmation', law && law.entry_id === 's-2938-ai-risk-evaluation-act' && law.facts.role === 'confirmation' && law.facts.public_law === '119-131' && law.date === '2026-10-20', JSON.stringify(law));
  ok('5.8 shape + plain text + no key', shapeOk(inj.items, 'govinfo') && plainOk(inj.items) && noKeyLeak(inj));
}

// ---------- 6. Regulations.gov ----------
{
  ok('6.1 key fallback', RG.keyOf({ REGULATIONS_GOV_API_KEY: 'r', CONGRESS_API_KEY: 'c' }) === 'r' && RG.keyOf({ CONGRESS_API_KEY: 'c' }) === 'c');
  ok('6.2 no key', (await RG.fetchItems({ http: status500, env: {}, entries: ENTRIES })).health.errors[0] === 'no key');
  const { out } = await run(RG, 'regulations_gov');
  const op = out.items.find((i) => i.class === 'comment-period-open');
  ok('6.3 AI comment period open (Washington dates)', op && op.facts.comments_close === '2026-11-25' && op.date === '2026-10-26' && /regulations\.gov\/document\//.test(op.url), JSON.stringify(op));
  ok('6.4 non-AI titles dropped', out.items.every((i) => C.isAI(i.title)));
  ok('6.5 no closing before the end day', !out.items.some((i) => i.class === 'comment-period-closing'));
  const later = (await run(RG, 'regulations_gov', { since: '2026-10-15', now: '2026-11-27T12:00:00Z' })).out;
  ok('6.6 closing dated the end day once it has come', later.items.some((i) => i.class === 'comment-period-closing' && i.date === '2026-11-25'));
  ok('6.7 shape + no key', shapeOk(out.items, 'regulations_gov') && noKeyLeak(out));
}

// ---------- 7. White House ----------
{
  const { out } = await run(WH, 'whitehouse');
  ok('7.1 one AI executive order; the housing order (AI only in its text) and proclamations dropped', out.items.length === 1 && out.items[0].class === 'executive-order', JSON.stringify(out.items.map((i) => i.title)));
  const it = out.items[0];
  ok('7.2 verbatim title, needs Federal Register confirmation, entry by title', it.title === 'Inaugurating The Era Of Super Intelligence' && it.facts.needs_confirmation === 'federal_register' && it.entry_id === 'eo-14434-super-intelligence-terminology-order');
  ok('7.3 shape + plain text + whitehouse.gov', shapeOk(out.items, 'whitehouse') && plainOk(out.items) && /^https:\/\/www\.whitehouse\.gov\//.test(it.url));
  ok('7.4 classOf', WH.classOf(['Presidential Actions', 'Presidential Memoranda']) === 'presidential-memo' && WH.classOf(['Proclamations']) === null);
  const bad = await WH.fetchItems({ http: async () => ({ status: 200, text: '<html>blocked</html>' }), entries: ENTRIES });
  ok('7.5 not a feed -> health not ok', !bad.health.ok && bad.items.length === 0);
}

// ---------- 8. statement feeds ----------
{
  const n = (await run(NIST, 'nist')).out;
  ok('8.1 NIST: AI items only, all statements (class null, role statement)', n.items.length >= 3 && n.items.every((i) => i.class === null && i.facts.role === 'statement' && i.facts.publisher === 'NIST' && typeof i.facts.text === 'string' && /nist\.gov/.test(i.url)) && n.health.ok);
  ok('8.2 NIST shape + plain text', shapeOk(n.items, 'nist') && plainOk(n.items));
  const c = (await run(CBO, 'cbo')).out;
  ok('8.3 CBO recorded: no tracked bill, no AI item -> 0, health ok', c.items.length === 0 && c.health.ok);
  const cpatch = (k, x) => x.replace('<item>', `<item><title>S. 2938, Artificial Intelligence Risk Evaluation Act of 2025</title><link>https://www.cbo.gov/publication/99001</link><pubDate>Tue, 27 Oct 2026 14:00:00 -0400</pubDate><guid>99001</guid><description>As ordered reported</description></item><item><title>S. 29380, Some Other Act</title><link>https://www.cbo.gov/publication/99002</link><pubDate>Tue, 27 Oct 2026 14:00:00 -0400</pubDate><guid>99002</guid></item><item><title>Artificial Intelligence and the Federal Budget</title><link>https://www.cbo.gov/publication/99003</link><pubDate>Tue, 27 Oct 2026 14:00:00 -0400</pubDate><guid>99003</guid></item><item><title>Artificial Intelligence Risk Evaluation Act cost discussion</title><link>https://www.cbo.gov/publication/99004</link><pubDate>Tue, 27 Oct 2026 14:00:00 -0400</pubDate><guid>99004</guid></item><item>`);
  const ci = (await run(CBO, 'cbo', { patch: cpatch })).out;
  const est = ci.items.find((i) => i.source_id === '99001');
  ok('8.4 CBO title naming S. 2938 -> cbo-estimate (official)', est && est.class === 'cbo-estimate' && est.entry_id === 's-2938-ai-risk-evaluation-act' && est.facts.role === 'official' && est.date === '2026-10-27', JSON.stringify(est));
  ok('8.5 CBO near miss S. 29380 -> nothing', !ci.items.some((i) => i.source_id === '99002'));
  ok('8.6 CBO AI item without a number -> statement candidate', ci.items.some((i) => i.source_id === '99003' && i.class === null && i.facts.role === 'statement'));
  ok('8.7 CBO short title alone is not an estimate', ci.items.some((i) => i.source_id === '99004' && i.class === null && i.facts.role === 'statement'));
  const a = (await run(CAAG, 'ca_ag')).out;
  ok('8.8 CA AG: statements only, jurisdiction CA', a.health.ok && a.items.every((i) => i.class === null && i.facts.role === 'statement' && i.jurisdiction === 'CA' && /oag\.ca\.gov/.test(i.url)));
  const apatch = (k, x) => x.replace('<item>', `<item><title>Attorney General Bonta Issues Guidance on SB 53 Compliance</title><link>https://oag.ca.gov/news/press-releases/sb53</link><pubDate>Tue, 27 Oct 2026 10:00:00 -0700</pubDate><guid>sb53</guid><description>&lt;p&gt;Guidance on &lt;b&gt;SB 53&lt;/b&gt;&lt;/p&gt;</description></item><item><title>Attorney General Bonta on SB 530 Water Rules</title><link>https://oag.ca.gov/news/press-releases/sb530</link><pubDate>Tue, 27 Oct 2026 10:00:00 -0700</pubDate><guid>sb530</guid></item><item><title>Statement on SB 53</title><link>http://oag.ca.gov/news/press-releases/insecure</link><pubDate>Tue, 27 Oct 2026 10:00:00 -0700</pubDate><guid>insecure</guid></item><item>`);
  const ai = (await run(CAAG, 'ca_ag', { patch: apatch })).out;
  ok('8.9 CA AG release naming SB 53 -> statement attached to TFAIA', ai.items.some((i) => i.source_id === 'sb53' && i.entry_id === 'ca-sb-53-tfaia' && i.class === null));
  ok('8.10 CA AG near miss SB 530 (not AI) -> nothing', !ai.items.some((i) => i.source_id === 'sb530'));
  ok('8.11 non-https link rejected', !ai.items.some((i) => i.source_id === 'insecure'));
  const down = await NIST.fetchItems({ http: status500, entries: ENTRIES });
  ok('8.12 feed down -> health not ok, no throw', !down.health.ok && down.items.length === 0);
}

// ---------- 9. fixtures carry no secrets ----------
{
  let leak = false;
  for (const d of fs.readdirSync(FIX)) for (const f of fs.readdirSync(path.join(FIX, d))) { const t = fs.readFileSync(path.join(FIX, d, f), 'utf8'); if (/api_key=(?!REDACTED)[A-Za-z0-9]{8,}/.test(t)) leak = true; }
  ok('9.1 no api_key value in any fixture', !leak);
}

console.log(`\nnews sources: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
