// Run:  node news/test-writer.mjs
// The fact-sheet news writer: the fact sheet holds only the event, identity, stage (no next step, review r5) and verified fields; the code checks refuse every
// trap; a reader that is not satisfied, an API failure or bad JSON gives the template card; the recorded eval set replays at 0 wrong.
import assert from 'assert';
import { buildFactSheet, stageOf, timingOf, billNumbers, provenStage, skipsExecutive, isResolution, isConstitutionalAmendment, originOf, billKey } from './factsheet.mjs';
import { checkCard, writeCard, bankCard } from './writer.mjs';
import { BANK, candidates, hashIndex } from './phrasebank.mjs';
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
  assert.strictEqual(s.stage_code, 'passed-chamber');
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
await t('r5 stage: only what this entry\'s own confirmed events prove', () => {
  const e = (cls, chamber, number = 'AB 1018', date = '2026-10-20', status = 'confirmed') => ({ key: `${cls}${chamber}${number}${date}`, jurisdiction: 'CA', entry_id: 'x', class: cls, date, status, facts: { chamber, number } });
  const conf = (x) => x.status === 'confirmed';
  const cc = e('concurrence', 'Assembly', 'AB 1018', '2026-10-25');
  assert.strictEqual(provenStage(cc, [cc], conf), 'passed-chamber'); // a concurrence alone: not both chambers
  assert.strictEqual(provenStage(cc, [cc, e('passage', 'Senate')], conf), 'passed-both');
  assert.strictEqual(provenStage(cc, [cc, e('passage', 'Senate', 'AB 1018', '2026-10-20', 'pending')], conf), 'passed-chamber'); // not confirmed
  assert.strictEqual(provenStage(cc, [cc, e('passage', 'Senate', 'SB 9')], conf), 'passed-chamber'); // a companion bill proves nothing for this one
  assert.strictEqual(provenStage(cc, [cc, e('passage', 'Senate', 'AB 1018', '2026-10-30')], conf), 'passed-chamber'); // later events do not count
  assert.strictEqual(provenStage(e('enrolled', null), [], conf), 'passed-both');
  assert.strictEqual(provenStage(e('failure', 'Senate'), [], conf), null);
  const ne = { ...e('passage', 'Legislature'), jurisdiction: 'NE', facts: { chamber: 'Legislature', number: 'LB 1' } };
  assert.strictEqual(provenStage(ne, [ne], conf), 'passed-chamber');
  assert.strictEqual(billKey('NY A6453B', 'NY'), 'A6453'); assert.strictEqual(billKey('CA SB53', 'CA'), 'SB53'); assert.strictEqual(billKey('H.R. 3460', 'US'), 'HR3460');
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
  const classes = ['introduction', 'referral-committee', 'hearing-scheduled', 'hearing-held', 'committee-passage', 'committee-failure', 'passage', 'failure', 'amendment-passage', 'concurrence', 'enrolled', 'executive-receipt', 'executive-signature', 'executive-veto', 'became-law', 'veto-override-passage', 'withdrawal', 'carried-over', 'new-text-version', 'crs-report', 'cbo-estimate', 'executive-order', 'presidential-memo', 'agency-rule-proposed', 'agency-rule-final', 'agency-guidance', 'comment-period-open', 'comment-period-closing', 'nomination', 'court-filing', 'court-ruling'];
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
