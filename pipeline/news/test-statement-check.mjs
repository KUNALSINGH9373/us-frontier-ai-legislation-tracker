// Run:  node news/test-statement-check.mjs
// The AI check on statements (news/statement-check.mjs) and the strict state shapes (news/strict.mjs): both only ever remove.
import { acceptAnswer, makeStatementVerifier, checkAttachments } from './statement-check.mjs';
import { attachStatements } from './attach.mjs';
import { provenState, losingTally } from './strict.mjs';
import { classifyState } from './classify.mjs';
import { stateActionKind } from '../grabber/sources/legiscan.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };

// ---------- the AI answer, checked by code ----------
const sig = { key: 'k1', entry_id: 'e1', class: 'executive-signature', date: '2026-10-20', facts: { number: 'AB 1405' }, sources: [{ role: 'official', url: 'https://leginfo.legislature.ca.gov/x' }] };
const yes = (quote, cls = 'executive-signature') => ({ reports: 'yes', event_class: cls, quote, why: 'x' });
ok('a yes with the headline\'s own words for the event is accepted', acceptAnswer(yes('signs AB 1405'), 'Governor Newsom signs AB 1405', sig).ok);
ok('a "no" is refused', !acceptAnswer({ reports: 'no', event_class: 'none', quote: '' }, 'Governor Newsom signs AB 1405', sig).ok);
ok('another class is refused', !acceptAnswer(yes('signs AB 1405', 'executive-veto'), 'Governor Newsom signs AB 1405', sig).ok);
ok('a quote not in the headline is refused', !acceptAnswer(yes('signed AB 1405 into law'), 'Governor Newsom signs AB 1405', sig).ok);
ok('a quote with no word for the event is refused', !acceptAnswer(yes('Governor Newsom'), 'Governor Newsom signs AB 1405', sig).ok);
ok('a missing or empty answer is refused', !acceptAnswer(null, 'x', sig).ok && !acceptAnswer(yes(''), 'Governor Newsom signs AB 1405', sig).ok);
const veto = { ...sig, class: 'executive-veto' };
ok('a wrong AI yes on "weighs veto" is still refused by code', !acceptAnswer(yes('governor weighs veto', 'executive-veto'), 'Senate advances AI bill as governor weighs veto', veto).ok);
ok('a wrong AI yes on "urges veto" is still refused by code', !acceptAnswer(yes('urges veto', 'executive-veto'), 'Coalition urges veto of AB 1405', veto).ok);

// ---------- the verifier: no AI, a failed call, an answer ----------
const v0 = makeStatementVerifier(null);
ok('no AI: nothing attaches', (await v0('Governor signs AB 1405', sig)).ok === false);
const vErr = makeStatementVerifier({ generate: async () => { throw new Error('boom'); } });
ok('a failed AI call: nothing attaches', (await vErr('Governor signs AB 1405', sig)).ok === false);
const vYes = makeStatementVerifier({ generate: async () => ({ data: yes('signs AB 1405') }) });
ok('an AI yes the code confirms attaches', (await vYes('Governor Newsom signs AB 1405', sig)).ok === true);

// ---------- checkAttachments: code proposes, the check removes ----------
const st = (title) => ({ source: 'release', source_id: title, entry_id: 'e1', date: '2026-10-21', title, url: 'https://gov.ca.gov/r/' + encodeURIComponent(title), facts: { role: 'statement', publisher: 'Gov' } });
{
  const before = { k1: sig };
  const att = await checkAttachments(attachStatements([sig], [st('Governor Newsom signs AB 1405')], { allowHosts: ['gov.ca.gov'] }), before, null);
  ok('without AI a code-proposed statement comes off the event and stays on the timeline', att.events[0].sources.length === 1 && att.timeline.length === 1 && /no AI/.test(att.timeline[0].held));
}
{
  const att = await checkAttachments(attachStatements([sig], [st('Governor Newsom signs AB 1405')], { allowHosts: ['gov.ca.gov'] }), { k1: sig }, vYes);
  ok('with an AI yes the statement stays, marked as checked', att.events[0].sources.length === 2 && att.events[0].sources[1].checked === 'ai+code');
}

// ---------- strict state shapes: wording found by review round 6 is no card ----------
const R6 = [['Passed by temporarily', 'VA'], ['Passed by', 'VA'], ['Passed Senate, vote rescinded', 'MD'], ['Passed House, vote expunged', 'NH'], ['Passed: no', 'ND'],
  ['may pass', 'ME'], ['to be passed', 'ME'], ['declined to pass', 'TX'], ['DO PASS (2-7)', 'ND'], ['Report: ought not to pass; amendment unfavorable', 'ME'],
  ['Reported Do Pass (H) - AYES: 2 NOES: 7 PRESENT: 0', 'MO'], ['Read third time. Passed. (Ayes 20. Noes 30.) Ordered to the Senate.', 'CA'],
  ['Passed Senate (vote rescinded)', 'MD'], ['Read third time. Passed. (Ayes 30. Noes 2. Vote Rescinded.) Ordered to the Senate.', 'CA'],
  ['Report adopted; Passed Third Reading. Ayes, 25; vote reconsidered', 'HI'], ['Reported from Rules, not recommended (5-Y 9-N)', 'VA']];
for (const [t, j] of R6) ok(`no card: ${j} "${t}"`, classifyState(t, { jurisdiction: j }) === null, `got ${classifyState(t, { jurisdiction: j })}`);
for (const t of ['Passed by temporarily', 'Passed Senate, vote rescinded', 'DO PASS (2-7)', 'Report: ought not to pass; amendment unfavorable', 'may pass', 'Passed: no', 'declined to pass'])
  ok(`Lane 1 does not call "${t}" a passage`, stateActionKind(t).kind !== 'passed', stateActionKind(t).kind);
ok('a clean passage still has its card', classifyState('Read third time. Passed. (Ayes 74. Noes 0. Page 6148.) Ordered to the Senate.', { jurisdiction: 'CA' }) === 'passage');
ok('an unknown wording of a passage has no card', classifyState('Passed Senate after lengthy floor fight', { jurisdiction: 'MD' }) === null);
ok('a name slot never holds an action word', !provenState('committee-passage', 'Reported from Rules, reconsidered') && provenState('committee-passage', 'Reported from Rules (12-Y 2-N)'));
ok('a losing tally is found in each format', ['(Ayes 2. Noes 7.)', '(2-Y 7-N)', 'DO PASS (2-7)', 'YEAS 10 NAYS 30', '; 3-9-0'].every((x) => losingTally(x)) && !losingTally('(Ayes 30. Noes 2.)'));

// ---------- review round 7 ----------
const R7 = ['Reported from Judiciary adversely', 'Reported from Judiciary (adverse)', 'Reported from Judiciary contrary', 'Reported from Judiciary ITL', 'Reported from Judiciary ONTP',
  'Reported from Judiciary OTP-ND', 'Reported from Judiciary - held in committee', 'Reported from Judiciary (dead)', 'Reported from Judiciary (Laid over)', 'Reported from Judiciary: interim study',
  'Reported from Judiciary, sent to study', 'Do pass Interim Study Committee', 'Voted do pass H Interim Study', 'Do pass Judiciary 3 yeas 6 nays', 'Passed House 10 yeas, 25 nays',
  'Passed House (0 yeas, 90 nays)', 'Passed Senate, 17 to 18', 'Reported from Judiciary 2-7', 'Reported favorably 0-5', 'Passed House 40/55/0', 'Senate/ passed 1st & 2nd readings/ suspension in Senate'];
for (const t of R7) ok(`r7 no card: "${t}"`, classifyState(t, { jurisdiction: 'XX' }) === null, String(classifyState(t, { jurisdiction: 'XX' })));
for (const t of R7.slice(0, 20)) ok(`r7 Lane 1 not passed: "${t}"`, stateActionKind(t).kind !== 'passed', stateActionKind(t).kind);
const passEv = { ...sig, class: 'passage', facts: { number: 'SB 53', chamber: 'House' } };
for (const h of ['Senate kills AI bill passed by House', 'Senate shelves AI bill passed by House', 'AI bill passed by Senate dies in House', 'House Republicans stall AI bill passed by Senate',
  'Lawmakers tabled AI bill passed by Senate', 'House kills Senate-passed AI bill', 'House passes amendment to AI safety bill', 'House passes resolution on artificial intelligence'])
  ok(`r7 a cherry-picked AI quote cannot attach: "${h}"`, !acceptAnswer(yes('passed by House', 'passage'), h, passEv).ok && !acceptAnswer(yes('passes', 'passage'), h, passEv).ok);
ok('r7 "sustains veto" and a budget signing never attach', !acceptAnswer(yes('sustains veto', 'executive-veto'), 'House sustains veto of AI bill', veto).ok && !acceptAnswer(yes('signs budget'), 'Governor signs budget with AI funding', sig).ok);

// ---------- review round 8 ----------
for (const t of ['Passed House (Vote: Aye 5, No 7)', 'Passed Senate (Vote: 12 Aye, 14 No)', 'Passed House (Vote: Yes 5, No 7)', 'Passed House (Vote 12 For, 14 Against)',
  'Passed House (Vote Voided)', 'Passed House (Vote Nullified)', 'Passed House (Vote Taken Again Feb 3)', 'Passed House. Ayes, 50. Noes, 10. Ruled Out of Order',
  'Indefinitely postponed', 'House/ filed in House file for bills not passed', 'died in assembly', 'DIED IN SENATE', 'Died in Messages', 'House/ passed 3rd reading in Rules Committee'])
  ok(`r8 no card: "${t}"`, classifyState(t, { jurisdiction: 'XX' }) === null, String(classifyState(t, { jurisdiction: 'XX' })));
for (const t of ['Passed House (Vote: Aye 5, No 7)', 'Passed House (Vote 12 For, 14 Against)']) ok(`r8 Lane 1 not passed: "${t}"`, stateActionKind(t).kind !== 'passed', stateActionKind(t).kind);
for (const t of ['Veto override vote: 24 yeas, 15 nays, Lost', 'Vote to override veto: Ayes 30, Noes 10 (two-thirds not reached)', "Governor's veto overridden in House; Senate fails to override"])
  ok(`r8 Lane 1: a failed override is not one: "${t}"`, stateActionKind(t).kind !== 'veto_override', stateActionKind(t).kind);
{
  const { numberConflict, wordsAgree } = await import('./attach.mjs');
  ok('r8 another bill named in any form is a conflict', ['Senate passes Senate Bill 530', 'Senate passes SB-530', 'Senate passes SB No. 530', 'Senate passes SB 7, a follow-up to SB 53'].every((h) => numberConflict(h, 'SB 53')) && numberConflict('Senate passes H.R. 5', 'S. 2938') && !numberConflict('Senate passes Senate Bill 53', 'SB 53'));
  const asm = { class: 'passage', facts: { chamber: 'Assembly' } };
  ok('r8 a headline that names no chamber, or two, does not back a single chamber vote', !wordsAgree('Legislature passes AI safety bill', asm) && !wordsAgree('Assembly and Senate pass AI bill', asm) && wordsAgree('Assembly passes AI safety bill', asm));
}
{
  let calls = 0; const answers = [{ reports: 'no', event_class: 'none', quote: '' }, yes('signs AB 1405')];
  const flaky = makeStatementVerifier({ generate: async () => ({ data: answers[calls++] }) });
  const memo = {};
  const one = async () => checkAttachments(attachStatements([sig], [st('Governor Newsom signs AB 1405')], { allowHosts: ['gov.ca.gov'] }), { k1: sig }, flaky, memo);
  const a1 = await one(), a2 = await one();
  ok('r8 a statement the AI refused once is never asked again, so a later "yes" cannot attach it', a1.events[0].sources.length === 1 && a2.events[0].sources.length === 1 && calls === 1);
  const memo2 = {}; await checkAttachments(attachStatements([sig], [st('Governor Newsom signs AB 1405')], { allowHosts: ['gov.ca.gov'] }), { k1: sig }, vErr, memo2);
  ok('r8 a failed AI call is not remembered (asked again next run)', Object.keys(memo2).length === 0);
}

// ---------- review round 9 ----------
for (const [t, bad] of [['Veto override vote scheduled', 'veto_override'], ['Veto override motion filed', 'veto_override'], ['Not signed by Governor', 'enacted'],
  ["Approved by Governor's office for signature", 'enacted'], ['Passed House (Y-30 N-60)', 'passed'], ['Passed House on March 3 in error', 'passed'],
  ['Refused passage; reconsidered and passed', 'failed'], ['Bill reconsidered; failed passage vacated', 'failed'], ['Died in House; revived', 'failed'], ['Indefinitely postponed amendment', 'failed']])
  ok(`r9 Lane 1: "${t}" is not ${bad}`, stateActionKind(t).kind !== bad, stateActionKind(t).kind);
{
  const { compatibleClasses, wordsAgree } = await import('./attach.mjs');
  for (const h of ['Speaker and Senate President sign AI safety bill, sending it to Governor', 'Senate President signs AI bill', 'Senator signs on to AI safety bill', 'Governor signs letter backing AI safety bill'])
    ok(`r9 not a signature: "${h}"`, !compatibleClasses(h).has('executive-signature') && !compatibleClasses(h).has('became-law'));
  ok('r9 a real signing headline still is one', compatibleClasses('Governor Newsom signs SB 53').has('executive-signature') && compatibleClasses('Gov. Hochul signs AI safety bill').has('executive-signature'));
  for (const h of ['House approves AI bill on first reading', 'House passes AI bill again']) ok(`r9 not the passage: "${h}"`, !compatibleClasses(h).has('passage'));
  const house = { class: 'passage', facts: { chamber: 'House' } };
  ok('r9 "passes House Judiciary" is a committee vote, not the House passage', !wordsAgree('AI bill passes House Judiciary', house) && wordsAgree('AI bill passes House', house) && wordsAgree('House passes AI bill', house));
  ok('r9 an override names its chamber alone', !wordsAgree('Legislature overrides veto of AI bill', { class: 'veto-override-passage', facts: { chamber: 'House' } }));
}
{
  const { classify } = await import('./sources/federal_register.mjs');
  ok('r9 an FR Rule that corrects, delays or rescinds is no final rule', ['Final rule; correcting amendment', 'Final rule; delay of effective date', 'Withdrawal of direct final rule', 'Final rule; rescission'].every((a) => classify({ type: 'Rule', action: a, title: 'AI rule' }) === null) && classify({ type: 'Rule', action: 'Final rule.', title: 'AI rule' }) === 'agency-rule-final');
}

// ---------- review round 10 ----------
for (const [t, j] of [['Returned From House Passed; referred to enrolling', 'ID'], ['Passed Both Houses', 'IL'], ['Died In Committee', 'MS'], ['Died in Information Technology Budget & Policy Subcommittee', 'FL'], ['Reported from Committee of the Whole', 'XX']])
  ok('r10 no card: ' + t, classifyState(t, { jurisdiction: j }) === null, String(classifyState(t, { jurisdiction: j })));
{
  const { classify } = await import('./sources/federal_register.mjs');
  ok('r10 a proposed-rule withdrawal, extension or reopening is no new proposal', ['Proposed rule; withdrawal.', 'Proposed rule; extension of comment period.', 'Proposed rule; reopening of comment period.'].every((a) => classify({ type: 'Proposed Rule', action: a, title: 'AI' }) === null) && classify({ type: 'Proposed Rule', action: 'Proposed rule.', title: 'AI' }) === 'agency-rule-proposed');
  ok('r10 an RFI or a meeting notice is not guidance', classify({ type: 'Notice', title: 'Request for Information (RFI) on Future Needs for Medical Metrology and Standards' }) === null && classify({ type: 'Notice', title: 'AI Risk Management Framework workshop' }) === null && classify({ type: 'Notice', title: 'AI Risk Management Framework: Generative AI Profile' }) === 'agency-guidance');
  const { numberConflict, wordsAgree } = await import('./attach.mjs');
  ok('r10 other prefixes are compared (SF, HF, LD, SJR)', numberConflict('Senate passes SF 2000', 'SF 1000') && numberConflict('House passes HF 12', 'HF 1') && numberConflict('LD 99 passes', 'LD 9') && !numberConflict('Senate passes SF 1000', 'SF 1000'));
  ok('r10 an event with no chamber does not back a headline that names one', !wordsAgree('Senate passes AI bill', { class: 'passage', facts: {} }));
}
for (const [t, bad] of [['Veto override: 30-40', 'veto_override'], ['Veto Override Vote 12 yeas 30 nays', 'veto_override'], ['House veto override (Y-40 N-60)', 'veto_override'], ['Governor signed - Section 3 vetoed', 'vetoed'],
  ['Passed Senate (Vote Voided)', 'passed'], ['Signed by Governor (Vote Voided)', 'enacted'], ['Chaptered by Secretary of State - Res. Chapter 12', 'enacted'], ['Passed Senate. Yeas 10 - Nays 30', 'passed'], ['Passed House 40Y-60N', 'passed']])
  ok('r10 Lane 1: "' + t + '" is not ' + bad, stateActionKind(t).kind !== bad, stateActionKind(t).kind);
ok('r10 Lane 1: "Governor vetoed; Senate overrode" is the override', stateActionKind('Governor vetoed; Senate overrode').kind === 'veto_override');

// ---------- review round 11 ----------
{
  const { chamberOf } = await import('./classify.mjs');
  ok('r11 "Senate substitute agreed to by House": the House acts', chamberOf('Senate substitute agreed to by House (84-Y 14-N 0-A)', 'H') === 'House' && chamberOf('Senate concurs in House amendments') === 'Senate');
  const { classify } = await import('./sources/federal_register.mjs');
  ok('r11 an ANPRM, an inquiry or an interpretive rule is no proposal or final rule', classify({ type: 'Proposed Rule', title: 'AI', abstract: 'The FTC proposes to commence a rulemaking proceeding' }) === null
    && classify({ type: 'Proposed Rule', title: 'Exemption to Prohibition on Circumvention; Notice of Inquiry' }) === null && classify({ type: 'Rule', action: 'Interpretive rule.', title: 'AI' }) === null);
  const { compatibleClasses } = await import('./attach.mjs');
  for (const [h, cls] of [['Governor Pillen approves LB 504', 'passage'], ['Governor Pillen approves LB 504', 'veto-override-passage'], ['Senate passes AI safety bill', 'concurrence'],
    ['Senate passes AI bill for the second time', 'passage'], ['Senate passes AI bill in final form', 'passage'], ['Lt. Governor signs AI bill', 'executive-signature'], ['Acting Governor signs SB 7', 'executive-signature']])
    ok('r11 "' + h + '" is not ' + cls, !compatibleClasses(h).has(cls));
}
for (const t of ['Senate amendments concurred in (13-50)', 'Agreed to by House 10-60', 'Passed for the day', 'Governor signed executive order', "Signed by Governor's chief of staff"])
  ok('r11 Lane 1: "' + t + '" is procedural', stateActionKind(t).kind === 'procedural', stateActionKind(t).kind);
ok('r11 a veto message referred is no referral card', classifyState('Veto read and referred to committee', { jurisdiction: 'XX' }) === null);

// ---------- review round 12 ----------
{
  const { chamberOf } = await import('./classify.mjs');
  ok('r12 Missouri "S Third Read and Passed" filed under H is the Senate', chamberOf('S Third Read and Passed', 'H') === 'Senate' && chamberOf('H Third Read and Passed', 'S') === 'House');
}
for (const [t, j] of [['Passed Enrolled', 'MD'], ['Truly Agreed To and Finally Passed', 'MO'], ['HCS Reported Do Pass H Professional Registration and Licensing', 'MO'], ['Reported from S Emerging Issues and Professional Registration Committee', 'MO'],
  ['Passed to be engrossed - 2 YEAS to 148 NAYS (See YEA and NAY No. 231 )', 'MA'], ['Report adopted; Passed Third Reading. Ayes, 10; Aye(s) with reservations: none . 15 No(es): A, B. 0 Excused: none.', 'HI'],
  ['Passed Third Reading with none voting aye with reservations; Representative(s) C voting no (40) and none excused (0).', 'HI']])
  ok('r12 no card: ' + t, classifyState(t, { jurisdiction: j }) === null, String(classifyState(t, { jurisdiction: j })));
ok('r12 Missouri\'s committee vote still has its card', classifyState('HCS Voted Do Pass H Professional Registration and Licensing', { jurisdiction: 'MO' }) === 'committee-passage');

// ---------- review round 13 ----------
{
  const { agreeState } = await import('./classify.mjs');
  ok('r13 an Open States label stands only when the same rules agree', agreeState('amendment-passage', 'Assembly amendments concurred in. (Ayes 29. Noes 8. Page 3039.) Ordered to engrossing and enrolling.', { jurisdiction: 'CA' }) === null
    && agreeState('amendment-passage', 'From committee: Do pass as amended. (Ayes 11. Noes 0.) (May 23).', { jurisdiction: 'CA' }) === null
    && agreeState('passage', 'Passed Senate, vote rescinded', { jurisdiction: 'MD' }) === null
    && agreeState('passage', 'Read third time. Passed. (Ayes 30. Noes 6.) Ordered to the Assembly.', { jurisdiction: 'CA' }) === 'passage'
    && agreeState('amendment-passage', 'Amendment No. 1 adopted', { jurisdiction: 'CA' }) === 'amendment-passage');
  ok('r13 CA suspense file is no referral', classifyState('In committee: Referred to suspense file.', { jurisdiction: 'CA' }) === null);
  ok('r13 Hawaii: noes plus excused make a majority', losingTally('Passed Third Reading; Representative(s) A voting no (25) and 3 excused'));
}

// ---------- review round 14 ----------
{
  const { agreeState } = await import('./classify.mjs');
  ok('r14 leaving a committee or schedule is no withdrawal; a received bill is not introduced; a motion on an amendment is not its passage',
    ['Withdrawn from Fiscal Policy -SJ 359', 'Withdrawn from schedule', 'Withdrawn from Special Order Calendar'].every((t) => agreeState('withdrawal', t, { jurisdiction: 'FL' }) === null)
    && agreeState('withdrawal', 'Withdrawn by sponsor', { jurisdiction: 'FL' }) === 'withdrawal'
    && agreeState('introduction', 'Received from Senate; read a first time', { jurisdiction: 'MN' }) === null
    && agreeState('amendment-passage', 'Motion to table Amendment No. 1 adopted', { jurisdiction: 'IL' }) === null);
}

// ---------- local live run (30 Oct 2026): Open States keeps what it read and resumes ----------
{
  const OS = await import('./sources/openstates.mjs');
  const bills = [1, 2, 3, 4].map((n) => ({ entry_id: 'e' + n, state: 'CA', number: 'SB ' + n, session_name: '2025-2026 Regular Session', os_session: '20252026' }));
  let t = 0; const clock = () => t;
  const http = async (url) => { t += 1000; return { ok: true, status: 200, text: JSON.stringify(/\/bills\?/.test(url) ? { results: [{ id: 'ocd-' + /identifier=SB(\+|%20| )(\d)/.exec(url)[2], identifier: 'SB ' + /identifier=SB(\+|%20| )(\d)/.exec(url)[2], actions: [{ date: '2026-10-20', description: 'Read third time. Passed. (Ayes 30. Noes 6.) Ordered to the Assembly.', classification: ['passage'], order: 1, organization: { classification: 'upper' } }] }] } : { results: [] }) }; };
  const cfg = { openstates: { max_requests_per_run: 80, min_interval_ms: 0, base: 'https://v3.openstates.org' } };
  const r1 = await OS.fetchItems({ http, env: { PLURAL_API_KEY: 'k' }, entries: bills, config: cfg, sleep: async () => {}, deadline: 15000, clock, now: () => new Date('2026-10-21T00:00:00Z') });
  ok('Open States stops before the deadline, keeps what it read and records where to resume', r1.items.length > 0 && r1.health.truncated && r1.state.cursor > 0 && r1.state.cursor < 4, JSON.stringify({ n: r1.items.length, cur: r1.state.cursor, e: r1.health.errors }));
  t = 0;
  const r2 = await OS.fetchItems({ http, env: { PLURAL_API_KEY: 'k' }, entries: bills, config: cfg, state: r1.state, sleep: async () => {}, deadline: 15000, clock, now: () => new Date('2026-10-21T04:00:00Z') });
  ok('the next run starts at the next bill', r2.items[0] && r2.items[0].entry_id === 'e' + (r1.state.cursor + 1), JSON.stringify({ first: r2.items.map((i) => i.entry_id) }));
}

console.log(`statement check + strict shapes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
