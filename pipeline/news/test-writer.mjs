// Run:  node news/test-writer.mjs
// The fact-sheet news writer: the fact sheet holds only the event, identity, stage (no next step, review r5) and verified fields; the code checks refuse every
// trap; a reader that is not satisfied, an API failure or bad JSON gives the template card; the recorded eval set replays at 0 wrong.
import assert from 'assert';
import { buildFactSheet, stageOf, timingOf, billNumbers, skipsExecutive, isResolution, isConstitutionalAmendment, originOf, billKey, STATE_NAMES } from './factsheet.mjs';
import * as FSM from './factsheet.mjs';
import { checkCard, writeCard, bankCard } from './writer.mjs';
import { BANK, candidates, hashIndex, summaryLabel } from './phrasebank.mjs';
const AI_ON = { news: { ai_writer: true } };
import { runWriterSet, runBankMeasure, loadEntries, WRITER_SET } from '../eval/news-writer-set.mjs';
import fs from 'fs';

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok ' + name); };
const entries = loadEntries();
const ev = (o) => ({ key: 'k', jurisdiction: 'CA', entry_id: 'ca-ab-1405-auditor-registry', class: 'passage', date: '2026-08-30', facts: { chamber: 'Senate', number: 'AB 1405', vote: { yes: 38, no: 2 } }, ...o });
const sheet = (o, today = '2026-10-29') => buildFactSheet(ev(o), entries.get('ca-ab-1405-auditor-registry'), { today });
const script = (answers) => ({ i: 0, async generate() { const a = answers[Math.min(this.i++, answers.length - 1)]; if (a instanceof Error) throw a; return { data: a }; } });
const good = { headline: 'California Senate passes AB 1405, 38-2', body: 'The California Senate passed AB 1405 by a vote of 38-2 on August 30, 2026. Status: Passed the Senate.' };
const yes = { faithful: true, added_or_overstated: [] };

await t('fact sheet: closed fields, stage from code, no next step (review r5)', () => {
  const s = sheet({});
  assert.deepStrictEqual(Object.keys(s), ['event', 'bill', 'stage', 'stage_code', 'verified', 'milestones']);
  assert.strictEqual(s.stage, 'Passed the Senate');
  assert.strictEqual(s.stage_code, null); // review r6: a passage alone carries no stage code
  assert.ok(!JSON.stringify(s).includes('status_text'));
  assert.strictEqual(stageOf('passage', 'NE', { chamber: 'Legislature' }), 'Passed the Legislature');
  assert.deepStrictEqual(billNumbers('IL SB 315 (P.A. 104-0538)'), ['SB 315']);
});
await t('r5 M4/L1: resolutions, memorials and constitutional amendments skip the executive; never "into law"', () => {
  for (const [n, j] of [['HJ 4', 'MT'], ['SJ 2', 'MT'], ['HC 3', 'MT'], ['SC 1', 'SD'], ['HM 2', 'NM'], ['SM 9', 'NM'], ['SCR 12', 'CA'], ['HCR 5', 'TX'], ['ACR 10', 'NJ'], ['ACA 1', 'CA'], ['SCA 8', 'CA'], ['HJR 1', 'VA'], ['SR 5', 'CA'], ['KS HR6023', 'KS'], ['LR 22', 'NE'], ['LRCA 3', 'NE'], ['H.Res. 12', 'US'], ['S.Res. 4', 'US'], ['H.Con.Res. 7', 'US'], ['S.Con.Res. 2', 'US']]) {
    assert.ok(isResolution(n, j), `${n} is a resolution`);
    assert.ok(skipsExecutive(n, j), `${n} skips the executive`);
  }
  assert.ok(isConstitutionalAmendment('ACA 1', 'CA') && isConstitutionalAmendment('ACR 10', 'NJ') && !isConstitutionalAmendment('ACR 10', 'CA') && !isConstitutionalAmendment('SB 53', 'CA'));
  assert.ok(isResolution('H.J.Res. 3', 'US') && !skipsExecutive('H.J.Res. 3', 'US')); // a federal joint resolution goes to the President, never "into law"
  for (const [n, j] of [['SB 53', 'CA'], ['CA SB53', 'CA'], ['H.R. 3460', 'US'], ['S. 1405', 'US'], ['HB 2800', 'VA'], ['LD 1234', 'ME'], ['A 6453', 'NY']]) assert.ok(!isResolution(n, j) && !skipsExecutive(n, j), n);
  // the fact sheet: no executive, no "Sent to the Governor", no "Signed into law" for these
  const rs = buildFactSheet({ key: 'k', jurisdiction: 'CA', class: 'executive-receipt', date: '2026-10-27', facts: { number: 'ACA 1' } }, null);
  assert.strictEqual(rs.bill.executive, null); assert.strictEqual(rs.stage, null);
  assert.strictEqual(bankCard({ event: { key: 'k', class: 'executive-receipt' }, sheet: rs }).card.written_by, 'template'); // no bank card: none names an executive
  const sg = buildFactSheet({ key: 'k', jurisdiction: 'MT', class: 'executive-signature', date: '2026-10-27', facts: { number: 'HJ 4', executive: 'Governor Greg Gianforte' } }, null);
  assert.strictEqual(sg.stage, 'Signed'); assert.ok(!('executive' in sg.event));
  const c = bankCard({ event: { key: 'k', class: 'executive-signature' }, sheet: sg }).card;
  assert.ok(c.written_by === 'bank' && !/governor|into law|enact/i.test(c.headline + c.body), JSON.stringify(c));
  // an unknown bill number: never "into law"
  assert.strictEqual(stageOf('executive-signature', 'CA', {}), 'Signed');
});
await t('r5 M2: Maine LD has no origin chamber', () => {
  assert.strictEqual(originOf('LD 1234', 'ME'), null);
  assert.strictEqual(originOf('AB 1018', 'CA'), 'Assembly');
});
await t('r6: no cross-event stage; a card states only its own event', () => {
  assert.ok(!('provenStage' in FSM));
  const s = buildFactSheet({ key: 'k', jurisdiction: 'CA', class: 'concurrence', date: '2026-10-27', facts: { number: 'AB 1018', chamber: 'Senate' } }, null);
  assert.strictEqual(s.stage, 'Concurred in the Senate'); assert.strictEqual(s.stage_code, null);
  assert.strictEqual(billKey('NY A6453B', 'NY'), 'A6453'); assert.strictEqual(billKey('CA SB53', 'CA'), 'SB53'); assert.strictEqual(billKey('H.R. 3460', 'US'), 'HR3460');
});
await t('r6 #1: a resolution or amendment chaptered is never a law', async () => {
  const { classifyState } = await import('./classify.mjs');
  assert.strictEqual(classifyState('Chaptered by Secretary of State - Res. Chapter 101, Statutes of 2026.', { jurisdiction: 'CA' }), null);
  assert.strictEqual(classifyState('Chaptered by Secretary of State - Chapter 178, Statutes of 2026.', { jurisdiction: 'CA' }), 'became-law');
  const { normalizeItem } = await import('./events.mjs');
  for (const n of ['CA SCR12', 'CA ACA1', 'CA AJR5']) assert.strictEqual(normalizeItem({ source: 'legiscan', source_id: 'x', jurisdiction: 'CA', class: 'became-law', date: '2026-10-01', facts: { number: n, action: 'Chaptered by Secretary of State - Chapter 9' }, url: 'u', retrieved_at: 'r' }).item.class, null, n);
  for (const [n, j] of [['SCR 12', 'CA'], ['ACA 1', 'CA'], ['AJR 5', 'CA'], ['S.J.Res. 3', 'US'], ['H.Con.Res. 7', 'US'], ['B 26-0123', 'DC'], [null, 'CA']]) {
    const sh = buildFactSheet({ key: 'k', jurisdiction: j, class: 'became-law', date: '2026-10-27', facts: n ? { number: n } : {} }, null);
    assert.strictEqual(sh.stage, null, n); assert.strictEqual(sh.stage_code, null, n);
    assert.strictEqual(candidates(sh, 'k').length, 0, `${n}: no became-law variant`);
    assert.ok(checkCard({ headline: `${n || 'It'} becomes law`, body: `${n || 'It'} became law on October 27, 2026. It is in force.` }, sh).some((p) => /law wording/.test(p)), n);
  }
  const sg = buildFactSheet({ key: 'k', jurisdiction: 'US', class: 'executive-signature', date: '2026-10-27', facts: { number: 'S.J.Res. 3' } }, null);
  assert.ok(checkCard({ headline: 'S.J.Res. 3 signed into law', body: 'S.J.Res. 3 was signed into law on October 27, 2026. Status: Signed.' }, sg).some((p) => /law wording/.test(p)));
});
await t('r6 #5/#6: simple resolutions never "both chambers"; resolutions "What it would do"', () => {
  const sh = buildFactSheet({ key: 'k', jurisdiction: 'MN', class: 'enrolled', date: '2026-10-27', facts: { number: 'HR 5' } }, null);
  assert.ok(sh.bill.simple_resolution && sh.stage === 'Enrolled' && sh.stage_code === null);
  for (const c of candidates(sh, 'k')) assert.ok(!/both/i.test(c.headline + c.body), c.body);
  assert.ok(checkCard({ headline: 'HR 5 enrolled', body: 'HR 5 was enrolled after passing both chambers on October 27, 2026. Status: Enrolled.' }, sh).some((p) => /both chambers/.test(p)));
  assert.ok(!buildFactSheet({ key: 'k', jurisdiction: 'US', class: 'enrolled', date: '2026-10-27', facts: { number: 'H.R. 5' } }, null).bill.simple_resolution);
  assert.strictEqual(summaryLabel('executive-signature', true), 'What it would do');
});
await t('r7: override vote, withdrawal and concurrence wording; legislature chamber', async () => {
  const ov = buildFactSheet({ key: 'k', jurisdiction: 'CA', class: 'veto-override-passage', date: '2026-10-27', facts: { number: 'AB 1018', chamber: 'Assembly' } }, null);
  assert.strictEqual(ov.stage, 'Override vote passed the Assembly');
  for (const c of candidates(ov, 'k')) assert.ok(!/overridden|overrides the veto/i.test(c.headline + c.body), c.body);
  const { templateFor } = await import('./templates.mjs');
  const tp = templateFor({ key: 'k', jurisdiction: 'CA', class: 'veto-override-passage', date: '2026-10-27', facts: { number: 'AB 1018', chamber: 'Assembly', action: 'Motion to override the veto adopted.' }, sources: [{ role: 'official', source: 'legiscan' }] }, { short_name: 'X', title: 'X' });
  assert.ok(tp && !/overridden/i.test(tp.headline), JSON.stringify(tp));
  const os = await import('./sources/openstates.mjs');
  for (const d of ['Withdrawn from committee; placed on calendar', 'Withdrawn from Committee on Rules and re-referred', 'Discharged from committee', 'Withdrawn from the Senate Calendar', 'Withdrawn from further consideration by the committee', 'Amendment withdrawn', 'Point of order withdrawn', 'Point of order withdrawn (amendment)']) assert.strictEqual(os.guardClass('withdrawal', d), null, d);
  assert.strictEqual(os.guardClass('withdrawal', 'Withdrawn by author'), 'withdrawal');
  for (const d of ['Senate refused to concur in House amendments', 'House does not concur', 'Nonconcurred in Senate amendments', 'Failed to concur']) assert.strictEqual(os.guardClass('concurrence', d), null, d);
  assert.strictEqual(os.guardClass('concurrence', 'Senate concurred in House amendments'), 'concurrence');
  const { classifyState } = await import('./classify.mjs');
  assert.strictEqual(classifyState('Senate refused to concur in Assembly amendments', { jurisdiction: 'CA' }), null);
  assert.ok(!candidates(buildFactSheet({ key: 'k', jurisdiction: 'US', class: 'withdrawal', date: '2026-10-27', facts: { number: 'H.R. 5', chamber: 'House' } }, null), 'k').some((c) => /from consideration/.test(c.body)));
  const conf = buildFactSheet({ key: 'k', jurisdiction: 'US', class: 'concurrence', date: '2026-10-27', facts: { number: 'H.R. 5', chamber: 'Senate', action: 'Conference report agreed to in Senate' } }, null);
  for (const c of candidates(conf, 'k')) assert.ok(!/amendments/i.test(c.headline + c.body), c.body);
  const am = buildFactSheet({ key: 'k', jurisdiction: 'US', class: 'concurrence', date: '2026-10-27', facts: { number: 'H.R. 5', chamber: 'Senate', action: 'Senate concurred in the House amendments' } }, null);
  assert.ok(am.event.on_amendments && candidates(am, 'k').some((c) => /amendments/.test(c.headline + c.body)));
  assert.strictEqual(buildFactSheet({ key: 'k', jurisdiction: 'DC', class: 'passage', date: '2026-10-27', facts: { number: 'B 26-1', chamber: 'legislature' } }, null).event.chamber, 'Council');
  assert.strictEqual(buildFactSheet({ key: 'k', jurisdiction: 'NE', class: 'passage', date: '2026-10-27', facts: { number: 'LB 1', chamber: 'legislature' } }, null).event.chamber, 'Legislature');
});
await t('r6 #7: territories have names, no executive, no law claims outside became-law', () => {
  const sh = buildFactSheet({ key: 'k', jurisdiction: 'PR', class: 'executive-signature', date: '2026-10-27', facts: { number: 'PC 5', executive: 'Governor X' } }, null);
  assert.strictEqual(sh.bill.jurisdiction_name, 'Puerto Rico'); assert.strictEqual(sh.bill.executive, null); assert.strictEqual(sh.stage, 'Signed'); assert.strictEqual(sh.stage_code, null);
  for (const c of candidates(sh, 'k')) assert.ok(!/governor|into law|enact/i.test(c.headline + c.body), c.body);
  for (const j of ['GU', 'VI', 'AS', 'MP']) assert.ok(STATE_NAMES[j]);
});
await t('r5 M1/M3: H.Res / SR passage, conference-report adoption and re-passage cards state no future step', () => {
  const FUT = /\b(next|will|heads? to|goes to|awaits?|transmittal|consideration in)\b/i;
  const cases = [
    ['US', 'passage', { number: 'H.Res. 12', chamber: 'House' }], ['CA', 'passage', { number: 'SR 5', chamber: 'Senate' }], ['US', 'passage', { number: 'S.Res. 4', chamber: 'Senate', vote: { yes: 60, no: 40 } }],
    ['US', 'concurrence', { number: 'H.R. 1405', chamber: 'House', action: 'Conference report agreed to' }], ['US', 'passage', { number: 'H.R. 1405', chamber: 'Senate', action: 'Conference report agreed to in Senate' }],
    ['CA', 'passage', { number: 'AB 1018', chamber: 'Assembly', action: 'Passed again after reconsideration' }], ['CA', 'passage', { number: 'AB 1018', chamber: 'Senate' }], ['US', 'passage', { number: 'H.R. 1405', chamber: 'House' }],
    ['CA', 'introduction', { number: 'SB 53', chamber: 'Senate' }], ['US', 'referral-committee', { number: 'S. 5493', chamber: 'Senate', committee: 'Senate Committee on Commerce' }], ['CA', 'enrolled', { number: 'AB 1018' }], ['CA', 'executive-receipt', { number: 'AB 1018' }]
  ];
  for (const [j, cls, facts] of cases) {
    const sh = buildFactSheet({ key: 'k', jurisdiction: j, class: cls, date: '2026-10-27', facts }, null, { today: '2026-10-29' });
    for (const c of candidates(sh, 'k')) if (!checkCard(c.check, sh).length) assert.ok(!FUT.test(c.headline + ' ' + c.body), `${cls} ${facts.number}: ${c.headline} | ${c.body}`);
  }
});
await t('hearing-scheduled: dated first seen, hearing day in facts.hearing_date', () => {
  const e = { class: 'hearing-scheduled', date: '2026-10-28', facts: { hearing_date: '2026-11-04' } };
  assert.strictEqual(timingOf(e, '2026-10-29'), 'scheduled');
  assert.strictEqual(timingOf(e, '2026-11-05'), 'held');
  const s = sheet({ class: 'hearing-scheduled', date: '2026-10-28', facts: { chamber: 'Senate', committee: 'Senate Judiciary Committee', number: 'AB 1405', hearing_date: '2026-11-04' } });
  assert.ok(checkCard({ headline: 'Senate Judiciary Committee to hear AB 1405', body: 'The Senate Judiciary Committee is scheduled to hold a hearing on AB 1405 on November 4, 2026. The bill is in committee.' }, s).length === 0);
  assert.ok(checkCard({ headline: 'Senate Judiciary Committee to hear AB 1405', body: 'The Senate Judiciary Committee is scheduled to hold a hearing on AB 1405 on October 28, 2026. The bill is in committee.' }, s).some((p) => /hearing day/.test(p)));
  assert.ok(checkCard({ headline: 'Senate Judiciary Committee hears AB 1405', body: 'The Senate Judiciary Committee held a hearing on AB 1405 on November 4, 2026. The bill is in committee.' }, s).some((p) => /scheduled event/.test(p)));
});
await t('traps: 38-2 never unanimous, no first without milestone, invented names and numbers', () => {
  const s = sheet({});
  assert.deepStrictEqual(checkCard(good, s), []);
  assert.ok(checkCard({ ...good, body: good.body.replace('by a vote of 38-2', 'unanimously') }, s).some((p) => /unanimously/.test(p)));
  assert.ok(checkCard({ ...good, headline: 'First-ever: California Senate passes AB 1405' }, s).some((p) => /milestone/.test(p)));
  assert.ok(checkCard({ ...good, body: good.body + ' Senator Wiener led it.' }, s).length > 0);
  assert.ok(checkCard({ ...good, body: good.body.replace('38-2', '38-1') }, s).length > 0);
  const m = buildFactSheet({ ...ev({}), facts: { ...ev({}).facts, milestone: 'the first state auditor registry' } }, entries.get('ca-ab-1405-auditor-registry'));
  assert.ok(!checkCard({ ...good, headline: 'California Senate passes first auditor registry bill' }, m).some((p) => /milestone/.test(p)));
});
await t('writeCard: AI card when code and reader agree', async () => {
  const r = await writeCard({ config: AI_ON, event: ev({}), entry: entries.get('ca-ab-1405-auditor-registry'), writer: script([good]), reader: script([yes]), today: '2026-10-29' });
  assert.strictEqual(r.card.written_by, 'ai'); assert.strictEqual(r.card.headline, good.headline); assert.ok(r.card.template_headline);
});
await t('writeCard: template on reader refusal, API failure, bad JSON, missing client; never throws', async () => {
  const e = { ...ev({}), card: { template_headline: 'T head', template_body: 'T body.' } }, entry = entries.get('ca-ab-1405-auditor-registry');
  for (const [w, rd] of [[script([good]), script([{ faithful: true, added_or_overstated: ['x'] }])], [script([new Error('529 overloaded')]), script([yes])], [script(['nonsense']), script([yes])], [script([good]), script([new Error('timeout')])], [null, null]]) {
    const r = await writeCard({ config: AI_ON, event: e, entry, writer: w, reader: rd, today: '2026-10-29' });
    assert.strictEqual(r.card.written_by, 'template'); assert.strictEqual(r.card.headline, 'T head');
  }
  const r = await writeCard({ config: AI_ON, event: null, entry: null, writer: null, reader: null });
  assert.strictEqual(r.card.written_by, 'template');
});
await t('eval set: recorded answers and synthetic bad cards replay at 0 wrong', async () => {
  const set = JSON.parse(fs.readFileSync(WRITER_SET, 'utf8'));
  assert.ok(set.cases.length >= 25);
  const rep = await runWriterSet({ cases: set.cases, today: set.today, entries });
  assert.strictEqual(rep.wrong, 0, JSON.stringify(rep.rows.filter((x) => x.wrong)));
  assert.ok(rep.synthetic >= 30 && rep.recorded === set.cases.length);
});
await t('phrase bank is the default: no AI client is called while news.ai_writer is false', async () => {
  let called = 0; const spy = { async generate() { called++; return { data: good }; } };
  for (const config of [null, {}, { news: {} }, { news: { ai_writer: false } }, { news: { ai_writer: 'true' } }]) {
    const r = await writeCard({ config, event: ev({}), entry: entries.get('ca-ab-1405-auditor-registry'), writer: spy, reader: spy, today: '2026-10-29' });
    assert.strictEqual(r.card.written_by, 'bank');
  }
  assert.strictEqual(called, 0);
});
await t('phrase bank: deterministic per event key, neighbours vary, never throws', () => {
  const s = sheet({}), a = bankCard({ event: ev({ key: 'k1' }), sheet: s }), b = bankCard({ event: ev({ key: 'k1' }), sheet: s });
  assert.deepStrictEqual(a.card, b.card);
  const many = new Set(Array.from({ length: 12 }, (_, i) => bankCard({ event: ev({ key: 'k' + i }), sheet: s }).card.headline));
  assert.ok(many.size >= 3, 'adjacent cards vary');
  assert.strictEqual(bankCard({ event: null, sheet: null }).card.written_by, 'template');
  assert.strictEqual(bankCard({ event: ev({ class: 'no-such-class' }), entry: null }).card.written_by, 'template');
});
await t('phrase bank: 4-8 headlines and 3-6 event sentences for every contract class', () => {
  const classes = ['introduction', 'referral-committee', 'hearing-held', 'committee-passage', 'committee-failure', 'passage', 'failure', 'amendment-passage', 'concurrence', 'enrolled', 'executive-receipt', 'executive-signature', 'executive-veto', 'became-law', 'veto-override-passage', 'withdrawal', 'carried-over', 'new-text-version', 'crs-report', 'cbo-estimate', 'executive-order', 'presidential-memo', 'agency-rule-proposed', 'agency-rule-final', 'agency-guidance', 'comment-period-open', 'nomination', 'court-filing', 'court-ruling'];
  for (const c of ['hearing-scheduled', 'comment-period-closing']) assert.ok(!BANK[c], c + ': a future event has no bank (review r8)');
  for (const c of classes) assert.ok(BANK[c] && BANK[c].H.length >= 4 && BANK[c].H.length <= 8 && BANK[c].B.length >= 3 && BANK[c].B.length <= 6, c);
});
await t('phrase bank measure: every class x variant x trap sheet, real events and the checkCard suite at 0 wrong', async () => {
  const set = JSON.parse(fs.readFileSync(WRITER_SET, 'utf8'));
  const rep = await runBankMeasure({ cases: set.cases, today: set.today, entries });
  assert.strictEqual(rep.wrong, 0, JSON.stringify(rep.matrix.examples_wrong.concat(rep.rows.filter((x) => x.wrong)).slice(0, 3)));
  assert.strictEqual(rep.matrix.unusable_headlines.length, 0, rep.matrix.unusable_headlines.join(', '));
  assert.strictEqual(rep.checkcard_suite.passed_wrongly, 0);
  assert.ok(rep.matrix.renderings > 10000 && rep.checkcard_suite.cases >= 70);
});
console.log(`news writer: ${n} tests passed`);
