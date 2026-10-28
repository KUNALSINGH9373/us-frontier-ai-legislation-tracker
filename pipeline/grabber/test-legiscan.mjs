// Run:  node grabber/test-legiscan.mjs   (or npm run test:legiscan)
// No network, no model. Real LegiScan bill records (fixtures/legiscan/bills.json, saved from the 13 Oct 2026 dry run) behind a fake API prove the Grabber.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { runLegiScan, readUsage, addUsage, trackedBills, preciseQuery, frontierMarkers } from './run-legiscan.mjs';
import { classifyTitles, fetchIt, INTENT_SYSTEM } from './intent.mjs';
import { pdfToText, stripLineNumbers, stripRepeats, pageLines, textWarnings } from './lib/pdf.mjs';
import { createOfficial } from './sources/official.mjs';
import { normNumber, billNumbersIn, trackerStatus, eventType, stateActionKind, eventsFrom, latestText, officialUrl } from './sources/legiscan.mjs';
import { createHttp } from './lib/http.mjs';
import { emptyState } from './lib/state.mjs';
import { makeValidator } from '../schema/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BILLS = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'legiscan', 'bills.json'), 'utf8'));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'));
const NOW = new Date('2026-10-13T06:00:00Z');
const KEY = 'secretkey123';
const cfg = { precise_phrases: ['frontier model', 'foundation model'], wide_query: '"artificial intelligence"', exclude_states: ['US'], title_by_bill_max: 20, title_pages_per_run: 60, max_candidates_per_run: 10, per_run_budget: 100, monthly_cap: 15000 };

// ---------- 1. plain functions ----------
ok('normNumber', normNumber('S.B. 53') === 'SB53' && normNumber('S0358') === 'S358' && normNumber('HF 4532') === 'HF4532' && normNumber('nonsense!') === null);
ok('billNumbersIn reads our titles', JSON.stringify(billNumbersIn('S.10373 / A.11636 — x')) === '["S10373","A11636"]'
  && JSON.stringify(billNumbersIn('RAISE Act (S.6953-B/A.6453-B), Chapter 96 of 2026 (S.8828/A.9449)')) === '["S6953","A6453","S8828","A9449"]'
  && JSON.stringify(billNumbersIn('IL SB 315 (P.A. 104-0538)')) === '["SB315"]'
  && billNumbersIn('California ballot initiative A.G. File No. 25-0034').length === 0, JSON.stringify(billNumbersIn('RAISE Act (S.6953-B/A.6453-B)')));
ok('status codes', trackerStatus(4) === 'enacted' && trackerStatus(5) === 'failed' && trackerStatus(6) === 'failed' && trackerStatus(1) === 'pending' && trackerStatus(3) === 'pending');
ok('VA "passed by for the day" is not a passage', eventType('Passed by for the day (Voice Vote)') === null);
ok('amendments and substitutes are noise', eventType('Senate floor amendments read and adopted.') === null && eventType('Committee substitute printed 26107298D-H2') === null);
ok('second-chamber first reading is not an introduction', eventType('In Assembly. Read first time. Held at Desk.') === null && eventType('Read first time. To print.', true) === 'Introduced / published');
ok('concurrence and agreement are passage', eventType('Assembly amendments concurred in. (Ayes 29. Noes 8.)') === 'Passed / advanced' && eventType('Senate substitute agreed to by House (84-Y 14-N 0-A)') === 'Passed / advanced');
ok('signing', eventType('Approved by the Governor.') === 'Signed / enacted' && eventType('Approved by Governor-Chapter 425 (effective 7/1/2026)') === 'Signed / enacted' && eventType('Chaptered by Secretary of State. Chapter 138, Statutes of 2025.') === 'Signed / enacted');
ok('failure', eventType('Vetoed by Governor') === 'Vetoed / failed / rescinded' && eventType('Failed passage in committee') === 'Vetoed / failed / rescinded' && eventType('Veto overridden') === 'Passed / advanced');
{ // failure, veto and enactment are the bill's own; amendments, motions, withdrawals and tabling are procedural (stateActionKind)
  const K = (t, first = false) => stateActionKind(t, first).kind;
  const proc = ['Amendment No. 2 failed', 'Motion to reconsider failed', 'Withdrawn from committee.', 'Amendment tabled', 'Amend Tabled A2', 'Senate Floor Amendment No. 2 Tabled Pursuant to Rule 5-4(a)', 'Senate Committee on Transportation & Energy Lay Over Unamended - Amendment(s) Failed',
    'Failed Concur In S Com Sub', 'Am. withdrawn. (Amendment 1 - HA0860)', 'Jacobson AM1710 withdrawn', 'McKinney MO508 Indefinitely postpone pursuant to Rule 6, Sec. 3(f) filed', 'Motion to Reconsider Vote - Withdrawn Rep. Daniel Didech', 'Motion withdrawn',
    'House Withdrawn from Committee on Federal and State Affairs and re-referred to Committee of the Whole', 'House Withdrawn from Calendar; Referred to Committee on Federal and State Affairs', 'Withdrawn From Com', 'Withdrawn from Rules Committee', 'Senate Withdrawn & Recommitted',
    'Laid on the table', 'Laid on the table (Pursuant to House Rule 71)', 'Removed from table', 'Amendment HA 2 to HB 306 - Stricken in House', 'Amendment HA 1 to HB 306 - Passed In House by Voice Vote', 'Senate proposal of amendment not concurred in and Committee of Conference requested upon motion of Rep. Black of Essex',
    'Consideration of Governor\'s veto pending.', 'tabled line veto memo.1', 'line veto memo.1', 'Chapter 157, 2026 Laws.', 'Acts of Assembly Chapter text (CHAP0425)', 'Minority; do not pass.', 'House Committee of the Whole - Amendment by Representative Hoheisel was adopted', 'On agreeing to the amendment'];
  const badProc = proc.filter((t) => K(t) !== 'procedural' || eventType(t) !== null);
  ok('amendment and motion "failed" / "tabled", "withdrawn from committee", a line veto and a bare "Chapter N" are procedural', !badProc.length, badProc.map((t) => `${t} -> ${K(t)}`).join(' | '));
  const failed = ['Failed passage in committee', 'Second reading, failed to pass, yeas 13 nays 33', 'Read third time. Refused passage. (Ayes 13. Noes 24. Page 3448.)', 'Died In Committee', 'DIED IN SENATE', 'died in assembly', 'Died in Messages', 'Indefinitely postponed', 'Action Postponed Indefinitely',
    'Senate Committee on Transportation & Energy Postpone Indefinitely', 'Inexpedient to Legislate: Motion Adopted Voice Vote 02/19/2026 House Journal 5 P. 7', 'Enacting clause stricken', 'RECOMMIT, ENACTING CLAUSE STRICKEN', 'Senate/ failed in Senate Secretary', 'House/ filed in House file for bills not passed'];
  const badFailed = failed.filter((t) => K(t) !== 'failed');
  ok('the bill\'s own failure: failed passage, died, indefinitely postponed, inexpedient to legislate', !badFailed.length, badFailed.map((t) => `${t} -> ${K(t)}`).join(' | '));
  ok('vetoed by the governor', K('Vetoed by Governor.') === 'vetoed' && K('Vetoed by Governor') === 'vetoed' && eventType('Vetoed by Governor.') === 'Vetoed / failed / rescinded');
  ok('a committee recommending "inexpedient to legislate" is not yet the bill\'s failure', K('Committee Report: Inexpedient to Legislate 02/04/2026 (Vote 16-0; Consent Calendar) House Calendar 7 P. 6') !== 'failed');
  const enacted = ['Chaptered by Secretary of State - Chapter 116, Statutes of 2026.', 'Chaptered by Secretary of State. Chapter 138, Statutes of 2025.', 'Approved by Governor-Chapter 425 (effective 7/1/2026)', 'Approved by the Governor - Chapter 634', 'Signed by Governor on June 17, 2026', 'Governor Signed', 'Governor signed.',
    'House message: Governor approved bill on June 17, 2026', 'House Approved by Governor on Tuesday, April 8, 2025', 'Public Act 26-100', 'Public Act . . . . . . . . . 104-0466', 'SIGNED CHAP.55', 'signed chap.579'];
  const badEnacted = enacted.filter((t) => K(t) !== 'enacted');
  ok('enactment: chaptered, Secretary of State, signed or approved by the governor, public act, NY "signed chap."', !badEnacted.length, badEnacted.map((t) => `${t} -> ${K(t)}`).join(' | '));
  ok('"Chapter N" without chaptered / Secretary of State / governor is not enactment', K('Chapter 157, 2026 Laws.') !== 'enacted' && K('Session Law Chapter 249 Effective: 07/01/2027') !== 'enacted' && K('Reported signed by the Speaker & ordered delivered to Governor') !== 'enacted');
  ok('milestone flag and importance: enacted > override > veto > passage > failure > committee report > hearing > introduced > referred > procedural',
    [['Chaptered by Secretary of State. Chapter 138, Statutes of 2025.', 100], ['Veto overridden', 95], ['Vetoed by Governor.', 90], ['Passed Senate as amended, Ayes 31, Nays 0', 80], ['Died In Committee', 70], ['From committee: Do pass as amended. (Ayes 11. Noes 0.) (July 1).', 60], ['Hearing Conducted S General Laws Committee', 40], ['Introduced in House', 30], ['Referred to Committee on General Laws and Technology', 20], ['Motion withdrawn', 0]]
      .every(([t, n]) => stateActionKind(t).importance === n && stateActionKind(t).milestone === n > 0));
  const kinds = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'legiscan', 'action-kinds.json'), 'utf8')).kinds;
  const all = Object.entries(kinds).flatMap(([k, texts]) => texts.map((t) => [k, t]));
  const wrong = all.filter(([k, t]) => K(t) !== k);
  ok(`every distinct history action in the stored LegiScan records (${all.length}) has its reviewed kind`, all.length >= 2000 && !wrong.length, wrong.slice(0, 10).map(([k, t]) => `${t} -> ${K(t)}, want ${k}`).join(' | '));
  ok('over every stored action: nothing about an amendment, a motion or a withdrawal is a failure, a veto or an enactment', all.filter(([, t]) => /\bamend(ment)?s?\b|\bmotion\b|\bwithdrawn\b|\btabled?\b/i.test(t) && !/enacting clause stricken|inexpedient to legislate/i.test(t)).every(([, t]) => !['failed', 'vetoed', 'enacted'].includes(K(t))));
  ok('over every stored action: "Chapter N" is enactment only beside chaptered, Secretary of State, a governor or NY "signed chap."', all.filter(([, t]) => /chapter \d+/i.test(t) && K(t) === 'enacted').every(([, t]) => /chaptered|secretary of state|governor/i.test(t)));
}
{
  const sb53 = eventsFrom(BILLS['CA-SB53']), types = sb53.map((e) => e.type);
  ok('CA SB 53 history: introduced first, signed last', types[0] === 'Introduced / published' && types.at(-1) === 'Signed / enacted' && types.filter((t) => t === 'Introduced / published').length === 1, types.join(','));
  ok('events carry real dates', sb53.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.precision === 'day'));
  const va = eventsFrom(BILLS['VA-HB797']);
  ok('VA HB 797: one signing, passage of both chambers', va.filter((e) => e.type === 'Signed / enacted').length === 1 && va.some((e) => /passed House/.test(e.text)) && va.some((e) => /Passed Senate/.test(e.text)) && !va.some((e) => /for the day/.test(e.text)));
  ok('NY S.10373 is pending', trackerStatus(BILLS['NY-S10373'].status) === 'pending' && trackerStatus(BILLS['CA-SB53'].status) === 'enacted');
}
ok('latestText prefers HTML of the newest date', (() => { const v = latestText({ texts: [{ doc_id: 1, date: '2026-01-01', mime: 'text/html' }, { doc_id: 2, date: '2026-03-01', mime: 'application/pdf' }, { doc_id: 3, date: '2026-03-01', mime: 'text/html' }] }); return v.doc_id === 3; })());
ok('official legislature URL is cited, LegiScan is the fallback', /leginfo\.legislature\.ca\.gov/.test(officialUrl(BILLS['CA-SB53'])) && officialUrl({ url: 'https://legiscan.com/x' }) === 'https://legiscan.com/x');

// ---------- PDF text ----------
{
  const r = await pdfToText(fs.readFileSync(path.join(here, '..', 'fixtures', 'legiscan', 'PA-HR637.pdf')));
  ok('a real PA PDF is read', r.text && r.pages === 3 && /frontier AI models/.test(r.text), r && r.reason);
  ok('margin line numbers are removed', !/\n\d{1,2}\n/.test(r.text) && !/^\d{1,2} /m.test(r.text));
  const empty = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
  const e = await pdfToText(Buffer.from(empty));
  ok('a PDF with no text layer gives no text, with a reason', e.text === null && /no text layer/.test(e.reason));
  ok('a file that is not a PDF gives no text, with a reason', /not a readable PDF/.test((await pdfToText(Buffer.from('nope'))).reason));
  ok('numbered lines lose their number only when most lines are numbered', JSON.stringify(stripLineNumbers(['1 Section one.', '2 applies to', '3 a frontier', '4 developer', '5 that', '6 trains', '7'])) === '["Section one.","applies to","a frontier","developer","that","trains"]'
    && JSON.stringify(stripLineNumbers(['10 days after notice', 'the developer shall'])) === '["10 days after notice","the developer shall"]');
  ok('right-margin line numbers are removed when they count up (Ohio)', JSON.stringify(stripLineNumbers(['adherence to standards reflecting best 34', 'practices for the prevention of 35', 'damage. 36', '(F) "Security vendor" means 37', 'by an independent verification 38'])) === '["adherence to standards reflecting best","practices for the prevention of","damage.","(F) \\"Security vendor\\" means","by an independent verification"]'
    && JSON.stringify(stripLineNumbers(['fine of 500', 'up to 25', 'section 3', 'within 72', 'at least 10'])) === '["fine of 500","up to 25","section 3","within 72","at least 10"]');
  const it = (s, x, y, w, h = 12) => ({ str: s, transform: [1, 0, 0, 1, x, y], width: w, height: h });
  ok('pieces that touch are one word ("w" + "ithin" -> "within")', pageLines([it('Subject to subsection (c), w', 131.7, 94, 324), it('ithin 72', 455.7, 94, 57.6)])[0] === 'Subject to subsection (c), within 72');
  ok('pieces with a gap keep their space', pageLines([it('greater', 10, 50, 40), it('than', 54, 50, 20)])[0] === 'greater than');
  ok('a raised small number after a number is an exponent ("10" + "26" -> "10^26")', pageLines([it('greater than 10', 10, 50, 90), it('26', 100.5, 54, 8, 7), it('integer operations', 110, 50, 100)])[0] === 'greater than 10^26 integer operations');
  ok('a raised number after a word is not an exponent (footnote stays separate)', !/\^/.test(pageLines([it('Audits', 10, 50, 40), it('1', 50.5, 54, 4, 7)]).join(' ')));
  ok('a printed "1,026 ... operations" is flagged, never rewritten', (() => { const w = textWarnings('greater than 1,026 integer or floating-point operations.'); return w.length === 1 && w[0].reads_as === '10^26' && textWarnings('fine of 1,026 dollars').length === 0; })());
  {
    const fx = (f) => fs.readFileSync(path.join(here, '..', 'fixtures', 'legiscan', f));
    const pa = await pdfToText(fx('PA-HB2800.pdf'));
    ok('real PA H.B. 2800: words split by the printer are rejoined', /within 72\s+hours/.test(pa.text) && !/w ithin/.test(pa.text));
    ok('real PA H.B. 2800: the printed "1,026" is kept as printed and flagged', /greater than 1,026 integer/.test(pa.text) && pa.warnings.some((w) => w.found === '1,026' && w.reads_as === '10^26'));
    ok('real PA H.B. 2800: penalties read exactly', /\$1,000,000 per violation for the first/.test(pa.text.replace(/\s+/g, ' ')) && /\$3,000,000 per violation for a subsequent/.test(pa.text.replace(/\s+/g, ' ')));
    const oh = await pdfToText(fx('OH-HB628.pdf'));
    ok('real OH H.B. 628: right-margin line numbers are gone', /reflecting best\npractices/.test(oh.text) && /both pre-?\s*development/.test(oh.text) && !/pre- 65/.test(oh.text) && oh.text.split('\n').filter((l) => /\S\s+\d{1,3}$/.test(l)).length === 0);
    const ma = await pdfToText(fx('MA-S37.pdf'));
    ok('real MA S. 37: flattened exponents are flagged (1026, 1025, 1020)', ['1026', '1025', '1020'].every((n) => ma.warnings.some((w) => w.found === n)));
  }
  const pages = [['HB 2829', 'body a', 'Page 1 of 3'], ['HB 2829', 'body b', 'Page 2 of 3'], ['HB 2829', 'body c', 'Page 3 of 3']];
  ok('running headers and page footers are removed', JSON.stringify(stripRepeats(pages)) === '[["body a"],["body b"],["body c"]]');
}

// ---------- the AI intent check ----------
{
  const items = [{ id: '1', title: 'Frontier AI safety' }, { id: '2', title: 'Plastic bags' }, { id: '3', title: 'An act to amend the code' }];
  const llm = { generate: async () => ({ data: { results: [{ id: '1', verdict: 'yes', reason: 'frontier' }, { id: '2', verdict: 'no', reason: 'plastics' }] } }) };
  const v = await classifyTitles({ llm, items });
  ok('model verdicts are used', v.get('1').verdict === 'yes' && v.get('2').verdict === 'no' && v.get('1').by === 'model');
  ok('a title the model left out counts as "maybe"', v.get('3').verdict === 'maybe' && v.get('3').by === 'fallback');
  const v2 = await classifyTitles({ llm: { generate: async () => { throw new Error('HTTP 503'); } }, items });
  ok('a failed model call drops nothing', [...v2.values()].every((x) => x.verdict === 'maybe'));
  ok('no model at all drops nothing', [...(await classifyTitles({ llm: null, items })).values()].every((x) => x.verdict === 'maybe'));
  const gen = [{ id: 'a', title: 'AN ACT to amend Tennessee Code Annotated, Title 49, relative to artificial intelligence.' }, { id: 'b', title: 'Makes appropriations for the support of government - Aid to Localities Budget.' }, { id: 'c', title: 'SCH CD-ARTIFICIAL INTELLIGENCE' }, { id: 'd', title: 'Regulating artificial intelligence companion chatbots.' }];
  const vg = await classifyTitles({ llm: { generate: async () => ({ data: { results: gen.map((g) => ({ id: g.id, verdict: 'no', reason: 'x' })) } }) }, items: gen });
  ok('a model "no" on a generic title (amend the code / budget / SCH CD) is overruled to "maybe"', ['a', 'b', 'c'].every((k) => vg.get(k).verdict === 'maybe' && vg.get(k).by === 'rule'));
  ok('a model "no" on a specific excluded topic stands', vg.get('d').verdict === 'no');
  ok('only a "no" is not fetched', fetchIt({ verdict: 'maybe' }) && fetchIt({ verdict: 'yes' }) && !fetchIt({ verdict: 'no' }));
  let calls = 0;
  await classifyTitles({ llm: { generate: async () => { calls++; return { data: { results: [] } }; } }, items: Array.from({ length: 250 }, (_, i) => ({ id: String(i), title: 't' })), batchSize: 120 });
  ok('titles are sent in batches', calls === 3);
  ok('the rule says to prefer maybe and covers chips', /If a title is not plainly in the "no" list/.test(INTENT_SYSTEM) && /security rules for advanced AI chips/.test(INTENT_SYSTEM));
}
ok('frontier markers flag frontier text only', frontierMarkers('a frontier model trained on 10^26 integer or floating-point operations').length >= 2 && frontierMarkers('a ban on plastic bags').length === 0 && frontierMarkers(null).length === 0);

// ---------- a fake LegiScan ----------
const b = (k) => structuredClone(BILLS[k]);
// search: [{ bill, precise }]: precise hits answer the precise query; every hit answers the wide query
function fakeApi({ bills, sessions, search = [], texts = {}, failOp = null }) {
  const calls = [];
  const resp = (body, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const all = () => [...Object.values(bills), ...search.map((s) => s.bill)];
  const fetchImpl = async (url) => {
    const u = new URL(url), op = u.searchParams.get('op'), id = u.searchParams.get('id');
    calls.push(op);
    if (u.searchParams.get('key') !== KEY) return resp({ status: 'ERROR', alert: { message: 'bad key' } });
    if (op === failOp) return resp('server down ' + url, 500);
    if (op === 'getMasterListRaw') { const ml = { session: { session_id: +id } }; (sessions[id] || []).forEach((x, i) => { ml[i] = { bill_id: x.bill_id, number: x.bill_number, change_hash: x.change_hash }; }); return resp({ status: 'OK', masterlist: ml }); }
    if (op === 'getBill') { const x = all().find((v) => String(v.bill_id) === id); return x ? resp({ status: 'OK', bill: x }) : resp({ status: 'ERROR' }); }
    const hits = search.filter((s) => !/frontier model/.test(u.searchParams.get('query') || '') || s.precise);
    if (op === 'getSearchRaw') return resp({ status: 'OK', searchresult: { summary: { page_total: 1, count: hits.length }, results: hits.map((s, i) => ({ relevance: 90 - i, bill_id: s.bill.bill_id, change_hash: s.bill.change_hash })) } });
    if (op === 'getSearch') { const page = +u.searchParams.get('page'), per = 2, rows = hits.slice((page - 1) * per, page * per); const r = { summary: { page_total: Math.ceil(hits.length / per) } }; rows.forEach((s, i) => { r[i] = { relevance: 50, state: s.bill.state, bill_number: s.bill.bill_number, bill_id: s.bill.bill_id, change_hash: s.bill.change_hash, title: s.bill.title }; }); return resp({ status: 'OK', searchresult: r }); }
    if (op === 'getBillText') { const t = texts[id] || { mime: 'text/html', bytes: Buffer.from('<p>SECTION 1. A frontier model shall&nbsp;be safe.</p>') }; return resp({ status: 'OK', text: { doc_id: +id, date: '2026-02-01', type: 'Introduced', mime: t.mime, doc: t.bytes.toString('base64') } }); }
    return resp({ status: 'ERROR' });
  };
  return { fetchImpl, calls, sleep: async () => {} };
}
const http = (api, max = 100) => createHttp({ fetchImpl: api.fetchImpl, sleep: api.sleep, secrets: [KEY], maxRequests: max, retries: 1 });
// a fake model: "no" for any title with "plastic", "yes" for "frontier", nothing for the rest (-> maybe)
const fakeLlm = (log = []) => ({ generate: async ({ prompt }) => { const rows = prompt.split('\n').slice(1).map((l) => l.split('\t')); log.push(rows.length); return { data: { results: rows.filter(([, t]) => /plastic|frontier/i.test(t)).map(([id, t]) => ({ id, verdict: /plastic/i.test(t) ? 'no' : 'yes', reason: 'test' })) } }; } });
const ny = b('NY-S10373'), ca = b('CA-SB53'), la = b('LA-SB474'), ab = b('CA-AB2653'), va = b('VA-HB797');
const mkBill = (id, state, number, title) => ({ ...structuredClone(ab), bill_id: id, state, bill_number: number, title, change_hash: 'h' + id, texts: [{ doc_id: id * 10, date: '2026-01-01', mime: 'text/html' }] });
const ids = { legiscan: {
  'ny-s-10373-verification': { status: 'proposed', bills: [{ bill_id: ny.bill_id, number: 'S10373', state: 'NY', session_id: ny.session_id, year_end: 2026, session_open: true }] },
  'ca-sb-53-tfaia': { status: 'proposed', bills: [{ bill_id: ca.bill_id, number: 'SB53', state: 'CA', session_id: ca.session_id, year_end: 2026, session_open: true }] },
  'va-ch-425-426-jcots-study': { status: 'proposed', bills: [{ bill_id: va.bill_id, number: 'HB797', state: 'VA', session_id: 1, year_end: 2025, session_open: false }] },
  'rejected-entry': { status: 'rejected', bills: [{ bill_id: 999, number: 'X1', state: 'NY', session_id: ny.session_id }] }
} };
const entries = [{ key: 'la-sb-474', level: 'state', state: 'LA', title: 'S.B. 474 — Protecting Louisiana', short_name: 'LA SB 474', status: 'failed' }];
const sessions = { [ny.session_id]: [ny], [ca.session_id]: [ca] };
const tn = mkBill(501, 'TN', 'HB9001', 'AN ACT to amend Tennessee Code Annotated, Title 4 and Title 47'); // a frontier bill whose title says nothing
const plastic = mkBill(502, 'TX', 'HB9', 'Relating to plastic bags');
const fed = mkBill(503, 'US', 'S1', 'Frontier AI Act');
const pdfBill = mkBill(504, 'PA', 'HR637', 'Urging Congress to regulate frontier artificial intelligence');
const search = [{ bill: ab, precise: true }, { bill: la, precise: true }, { bill: ny, precise: true }, { bill: tn, precise: false }, { bill: plastic, precise: false }, { bill: fed, precise: false }, { bill: pdfBill, precise: false }];
const texts = { [ab.texts.at(-1).doc_id]: { mime: 'application/pdf', bytes: Buffer.from('not really a pdf') }, 5040: { mime: 'application/pdf', bytes: fs.readFileSync(path.join(here, '..', 'fixtures', 'legiscan', 'PA-HR637.pdf')) } };

ok('rejected identifiers are not watched', trackedBills(ids).length === 3 && !trackedBills(ids).some((t) => t.bill_id === 999));
ok('precise query is one OR of quoted phrases', preciseQuery({ precise_phrases: ['frontier model', 'foundation model'] }) === '"frontier model" OR "foundation model"');

// ---------- 2. first run ----------
{
  const out = tmp(), llmLog = [];
  const api = fakeApi({ bills: { ny, ca, la, ab, va }, sessions, search, texts });
  const r = await runLegiScan({ http: http(api), apiKey: KEY, llm: fakeLlm(llmLog), state: emptyState(), seen: {}, ids, entries, cfg, outDir: out, now: NOW });
  const items = r.changeset.items, got = (id) => items.find((i) => i.source_id === String(id));
  const rawOf = (id) => JSON.parse(fs.readFileSync(path.join(out, r.runId, got(id).raw_path), 'utf8'));
  ok('both open-session tracked bills fetched on the first run', r.stats.tracked_changed === 2 && items.filter((i) => i.reason === 'updated_since_cursor').length === 2, JSON.stringify(r.stats));
  ok('checked: every tracked entry whose bills were read (master list or closed session)', JSON.stringify([...r.checked].sort()) === JSON.stringify([...new Set(trackedBills(ids).map((t) => t.entry_key))].sort()), JSON.stringify(r.checked));
  ok('a session whose last year is over costs nothing', r.stats.sessions_skipped_closed === 1 && api.calls.filter((c) => c === 'getMasterListRaw').length === 2);
  ok('two bulk searches, no page limit', api.calls.filter((c) => c === 'getSearchRaw').length === 2 && r.stats.precise_hits === 3 && r.stats.wide_hits === 7, JSON.stringify(r.stats));
  ok('a precise hit is fetched without any title screen', got(ab.bill_id) && got(ab.bill_id).reason === 'discovery');
  ok('a vague title is NOT dropped (TN-style "AN ACT to amend")', !!got(tn.bill_id), JSON.stringify(r.stats));
  ok('a confident "no" is dropped and listed with the reason', !got(plastic.bill_id) && r.screenedOut.some((s) => s.bill_id === plastic.bill_id && s.reason) && r.nextSeen[plastic.bill_id].verdict === 'no');
  ok('a bill the tracker already has (failed LA SB 474) is not "new"', !got(la.bill_id) && r.nextSeen[la.bill_id].verdict === 'known_entry');
  ok('tracked bills found by search are not repeated', items.filter((i) => i.source_id === String(ny.bill_id)).length === 1);
  ok('federal bills are left to Congress.gov', !got(fed.bill_id) && r.nextSeen[fed.bill_id].verdict === 'other_jurisdiction');
  ok('few new titles: read from the bills, no titled search pages, one model call', r.stats.title_pages === 0 && llmLog.length === 1 && llmLog[0] === 3, JSON.stringify(llmLog));
  ok('a PDF bill is read into text', rawOf(pdfBill.bill_id).text && /frontier AI models/.test(rawOf(pdfBill.bill_id).text) && r.stats.text_from_pdf === 1, JSON.stringify(r.stats));
  ok('the PDF file is kept next to the record', fs.existsSync(path.join(out, r.runId, rawOf(pdfBill.bill_id).text_version.saved_file)));
  ok('an unreadable PDF is marked missing with the reason', rawOf(ab.bill_id).text_missing === true && /not a readable PDF/.test(rawOf(ab.bill_id).text_version.pdf.reason));
  ok('frontier markers are recorded as a flag', rawOf(tn.bill_id).frontier_markers.includes('frontier model') && Array.isArray(rawOf(ab.bill_id).frontier_markers));
  ok('the intent verdict travels with the record', rawOf(tn.bill_id).search_hit.intent.verdict === 'maybe' && rawOf(ab.bill_id).search_hit.search === 'precise');
  const nyRaw = rawOf(ny.bill_id);
  ok('tracked updates fetch no text (saves queries)', !('text' in nyRaw));
  ok('derived status and events saved with the record', nyRaw.derived.status === 'pending' && nyRaw.derived.events.length === 1);
  ok('source_url is the legislature page', /nysenate\.gov/.test(got(ny.bill_id).source_url));
  ok('change set passes its schema', makeValidator().check('changeset', r.changeset).length === 0);
  ok('state records change hashes', r.nextState.sources.legiscan.hashes[String(tn.bill_id)] === tn.change_hash && makeValidator().check('state', r.nextState).length === 0);

  // ---------- 3. quiet second run ----------
  const api2 = fakeApi({ bills: { ny, ca, la, ab, va }, sessions, search, texts }), log2 = [];
  const r2 = await runLegiScan({ http: http(api2), apiKey: KEY, llm: fakeLlm(log2), state: r.nextState, seen: r.nextSeen, ids, entries, cfg, outDir: tmp(), now: NOW });
  ok('quiet run: no items, no model call', r2.changeset.items.length === 0 && log2.length === 0, JSON.stringify(r2.stats));
  ok('quiet run costs master lists + 2 searches only', r2.requests === 4, api2.calls.join(','));

  // ---------- 4. a "no" bill that changes is re-checked only after 30 days ----------
  const s4 = search.map((s) => (s.bill === plastic ? { ...s, bill: { ...plastic, change_hash: 'new' } } : s));
  const run4 = (days) => runLegiScan({ http: http(fakeApi({ bills: { ny, ca, la, ab, va }, sessions, search: s4, texts })), apiKey: KEY, llm: fakeLlm(), state: r.nextState, seen: r.nextSeen, ids, entries, cfg, outDir: tmp(), now: new Date(+NOW + days * 864e5) });
  ok('a changed "no" bill waits 30 days', (await run4(5)).stats.new_to_screen === 0);
  const r5 = await run4(31);
  ok('and is re-checked after 30 days', r5.stats.new_to_screen === 1 && r5.stats.intent_no === 1, JSON.stringify(r5.stats));

  // ---------- 5. one tracked bill changes ----------
  const ny2 = { ...ny, change_hash: 'changed-hash' };
  const api3 = fakeApi({ bills: { ny: ny2, ca, la, ab, va }, sessions: { ...sessions, [ny.session_id]: [ny2] }, search: [] });
  const r3 = await runLegiScan({ http: http(api3), apiKey: KEY, llm: fakeLlm(), state: r2.nextState, seen: r2.nextSeen, ids, entries, cfg, outDir: tmp(), now: NOW });
  ok('only the changed bill is fetched', r3.changeset.items.length === 1 && r3.changeset.items[0].entry_key === 'ny-s-10373-verification' && api3.calls.filter((c) => c === 'getBill').length === 1);
}

// ---------- 5b. text from the legislature's own site (no LegiScan query); priority filter ----------
{
  const withLink = (id, st) => ({ ...mkBill(id, st, 'SB' + id, 'Frontier artificial intelligence act'), texts: [{ doc_id: id * 10, date: '2026-01-01', mime: 'text/html', state_link: `https://legis.example.gov/${id}.htm` }] });
  const ok1 = withLink(701, 'CA'), bad = withLink(702, 'CA'), pdfOff = withLink(703, 'CA');
  const pages = { [ok1.texts[0].state_link]: { type: 'text/html', body: Buffer.from('<html><body><p>' + 'SECTION 1. A large frontier developer shall publish a frontier AI framework. '.repeat(10) + '</p></body></html>') },
    [pdfOff.texts[0].state_link]: { type: 'application/pdf', body: fs.readFileSync(path.join(here, '..', 'fixtures', 'legiscan', 'PA-HR637.pdf')) } };
  const offFetch = async (url) => { const p = pages[url]; return p ? { ok: true, status: 200, headers: { get: () => p.type }, arrayBuffer: async () => p.body } : { ok: false, status: 404, headers: { get: () => '' }, arrayBuffer: async () => Buffer.from('') }; };
  const s5 = [ok1, bad, pdfOff].map((x) => ({ bill: x, precise: true }));
  const api = fakeApi({ bills: {}, sessions: {}, search: s5 });
  const out = tmp();
  const r = await runLegiScan({ http: http(api), apiKey: KEY, llm: null, official: createOfficial({ fetchImpl: offFetch }), state: emptyState(), seen: {}, ids: { legiscan: {} }, cfg: { ...cfg, text_fallback_legiscan: true }, outDir: out, now: NOW });
  const raw = (id) => JSON.parse(fs.readFileSync(path.join(out, r.runId, r.changeset.items.find((i) => i.source_id === String(id)).raw_path), 'utf8'));
  ok('official HTML text is used, no LegiScan text query', raw(701).text_version.from === 'official' && /large frontier developer/.test(raw(701).text));
  ok('official PDF is read and kept', raw(703).text_version.from === 'official' && /frontier AI models/.test(raw(703).text) && raw(703).text_version.saved_file);
  ok('a failing official site falls back to LegiScan (one query)', raw(702).text_version.from === 'legiscan' && api.calls.filter((c) => c === 'getBillText').length === 1, api.calls.join(','));
  ok('stats count official texts', r.stats.text_from_official === 2);
  const r2 = await runLegiScan({ http: http(fakeApi({ bills: {}, sessions: {}, search: s5 })), apiKey: KEY, official: createOfficial({ fetchImpl: offFetch }), state: emptyState(), ids: { legiscan: {} }, cfg: { ...cfg, text_fallback_legiscan: false }, outDir: tmp(), now: NOW });
  ok('with the fallback off, a failed official copy costs nothing and is marked missing', r2.stats.text_missing === 1);
  const mixed = [{ bill: withLink(711, 'CA'), precise: true }, { bill: mkBill(712, 'CA', 'AB712', 'Artificial intelligence: something'), precise: false }];
  const r3 = await runLegiScan({ http: http(fakeApi({ bills: {}, sessions: {}, search: mixed })), apiKey: KEY, llm: null, state: emptyState(), seen: {}, ids: { legiscan: {} }, cfg, outDir: tmp(), now: NOW, only: ['precise'] });
  ok('"only" fetches the chosen kinds and holds the rest unseen', r3.changeset.items.length === 1 && r3.stats.held_by_only === 1 && !r3.nextSeen['712'] && !r3.nextState.sources.legiscan.hashes['712']);
}

// ---------- 6. many new titles: titled search pages; caps only delay ----------
{
  const many = Array.from({ length: 30 }, (_, i) => ({ bill: mkBill(600 + i, 'CA', 'AB' + (600 + i), i % 2 ? 'Frontier artificial intelligence developers' : 'Artificial intelligence: something'), precise: false }));
  const c6 = { ...cfg, title_by_bill_max: 5, title_pages_per_run: 100, max_candidates_per_run: 4 };
  const api = fakeApi({ bills: {}, sessions: {}, search: many });
  const r = await runLegiScan({ http: http(api, 200), apiKey: KEY, llm: fakeLlm(), state: emptyState(), seen: {}, ids: { legiscan: {} }, cfg: c6, outDir: tmp(), now: NOW });
  ok('many new titles come from titled search pages, not one query each', r.stats.title_pages === 15 && api.calls.filter((c) => c === 'getBill').length === 4, JSON.stringify(r.stats));
  ok('"yes" before "maybe"', r.changeset.items.every((i) => /Frontier/.test(i.title)));
  ok('candidate cap delays the rest, it does not drop them', r.stats.candidates === 4 && r.stats.waiting_for_next_run === 26 && r.truncated && Object.keys(r.nextSeen).length === 0, JSON.stringify(r.stats));
  const r2 = await runLegiScan({ http: http(fakeApi({ bills: {}, sessions: {}, search: many }), 200), apiKey: KEY, llm: fakeLlm(), state: r.nextState, seen: r.nextSeen, ids: { legiscan: {} }, cfg: c6, outDir: tmp(), now: NOW });
  ok('the next run continues with the ones that waited', r2.stats.candidates === 4 && !r2.changeset.items.some((i) => r.changeset.items.some((j) => j.source_id === i.source_id)));

  const r3 = await runLegiScan({ http: http(fakeApi({ bills: { ny, ca }, sessions, search: [] }), 3), apiKey: KEY, state: emptyState(), ids, cfg, outDir: tmp(), now: NOW });
  ok('per-run budget is a hard stop, not an error', r3.truncated === true && r3.requests === 3);
  ok('bills not reached are not marked seen (picked up next run)', Object.keys(r3.nextState.sources.legiscan.hashes).length < 2);
}

// ---------- 7. failures never leak the key ----------
{
  let err = null;
  try { await runLegiScan({ http: http(fakeApi({ bills: { ny, ca }, sessions, failOp: 'getMasterListRaw' })), apiKey: KEY, state: emptyState(), ids, cfg, outDir: tmp(), now: NOW }); } catch (e) { err = e; }
  ok('a server failure fails the run', err !== null);
  ok('the key is scrubbed from the error', err && !String(err.message + (err.body || '')).includes(KEY), String(err && err.message));
  let err2 = null;
  try { await runLegiScan({ http: http(fakeApi({ bills: { ny }, sessions })), apiKey: 'wrong', state: emptyState(), ids, cfg, outDir: tmp(), now: NOW }); } catch (e) { err2 = e; }
  ok('an API error status fails the run', err2 && /returned ERROR/.test(err2.message) && !err2.message.includes('wrong'));
}

// ---------- 8. monthly usage counter ----------
{
  const f = path.join(tmp(), 'usage.json');
  ok('usage starts at zero', readUsage(f, NOW).used === 0);
  addUsage(f, NOW, 40); addUsage(f, NOW, 2);
  ok('usage adds up within a month', readUsage(f, NOW).used === 42 && readUsage(f, NOW).runs === 2);
  ok('usage resets in a new month', readUsage(f, new Date('2026-11-01T00:00:00Z')).used === 0);
}

console.log(`\nlegiscan grabber: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
