// Run:  node news/test-writer.mjs
// The fact-sheet news writer: the fact sheet holds only the event, identity, stage/next and verified fields; the code checks refuse every
// trap; a reader that is not satisfied, an API failure or bad JSON gives the template card; the recorded eval set replays at 0 wrong.
import assert from 'assert';
import { buildFactSheet, stageAndNext, timingOf, billNumbers } from './factsheet.mjs';
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

await t('fact sheet: closed fields, stage and next from code', () => {
  const s = sheet({});
  assert.deepStrictEqual(Object.keys(s), ['event', 'bill', 'stage', 'stage_code', 'next', 'verified', 'milestones']);
  assert.strictEqual(s.next, null); // review r4 #1: AB 1405 started in the Assembly, so its Senate passage has no fixed next step
  assert.strictEqual(stageAndNext('passage', 'CA', { chamber: 'Senate', number: 'SB 53' }).next, 'consideration in the Assembly');
  assert.strictEqual(s.stage_code, 'passed-chamber');
  assert.ok(!JSON.stringify(s).includes('status_text'));
  assert.strictEqual(stageAndNext('passage', 'NE', { chamber: 'Legislature' }).next, null);
  assert.deepStrictEqual(billNumbers('IL SB 315 (P.A. 104-0538)'), ['SB 315']);
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
