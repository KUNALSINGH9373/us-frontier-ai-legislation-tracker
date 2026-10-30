// Run:  node news/test-classify.mjs
// The news classifier (news/classify.mjs) over every distinct official action string in the stored runs (fixtures/news/action-strings.json:
// Congress.gov actions and LegiScan history steps, each with its reviewed class), kept consistent with Lane 1's own action typing.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyAction, classifyCongress, classifyState, classifyCourt, EVENT_CLASSES } from './classify.mjs';
import { actionKind } from '../compare/congress.mjs';
import { stateActionKind } from '../grabber/sources/legiscan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const rows = JSON.parse(fs.readFileSync(path.join(P, 'fixtures', 'news', 'action-strings.json'), 'utf8')).rows;
const cls = (r) => classifyAction(r.source, r.text, { jurisdiction: r.jurisdiction, isFirst: r.first, chamber: r.chamber });
const lane1 = (r) => (r.source === 'legiscan' ? stateActionKind(r.text, r.first) : actionKind(r.text));

ok(`the table holds every stored action string (${rows.length}), both sources`, rows.length > 2500 && rows.filter((r) => r.source === 'congress_gov').length >= 90);
const wrong = rows.filter((r) => cls(r) !== r.class);
ok('every action string gets its reviewed class', !wrong.length, wrong.slice(0, 8).map((r) => `${r.jurisdiction}: ${r.text} -> ${cls(r)}, want ${r.class}`).join(' | '));
ok('every class is in the contract, or null', rows.every((r) => r.class === null || EVENT_CLASSES.includes(r.class)));
// Lane 1 consistency: a step Lane 1 calls routine or procedural is null here, except an executive receipt (Lane 1 has no such milestone)
const extra = rows.filter((r) => !lane1(r).type && cls(r) && cls(r) !== 'executive-receipt' && !(cls(r) === 'concurrence' && /^\W*(house|senate|assembly) concurs? in/i.test(r.text)));
ok('a step Lane 1 calls procedural is never a news event (only an executive receipt, and "X concurs in Y amendments", are added)', !extra.length, extra.slice(0, 5).map((r) => `${r.jurisdiction}: ${r.text} -> ${cls(r)}`).join(' | '));
// and the big outcomes always agree
const agree = { enacted: ['became-law', 'executive-signature', null], vetoed: ['executive-veto', null], veto_override: ['veto-override-passage'], introduced: ['introduction', 'executive-receipt'] };
const bad = rows.filter((r) => agree[lane1(r).kind] && !agree[lane1(r).kind].includes(cls(r)));
ok('Lane 1 enactment, veto, override and introduction map to the same outcome here', !bad.length, bad.slice(0, 5).map((r) => `${r.jurisdiction}: ${r.text} -> ${cls(r)} (${lane1(r).kind})`).join(' | '));
ok('a Public Act number, a first reading and a carry-over line stay as Lane 1 has them', classifyState('Public Act . . . . . . . . . 104-0466', { jurisdiction: 'IL' }) === null && classifyState('Pass First Reading', { jurisdiction: 'HI' }) === null && classifyState('Carried over to 2026 Regular Session.', { jurisdiction: 'HI' }) === 'carried-over');

// hand-checked cases, one per rule
const T = [
  ['congress_gov', 'Became Public Law No: 119-12.', 'became-law'], ['congress_gov', 'Signed by President.', 'executive-signature'], ['congress_gov', 'Presented to President.', 'executive-receipt'],
  ['congress_gov', 'Passed Senate without amendment by Unanimous Consent.', 'passage'], ['congress_gov', 'Cleared for White House.', null], ['congress_gov', 'Committee on Energy and Natural Resources. Hearings held.', 'hearing-held'],
  ['congress_gov', 'Ordered to be Reported by the Yeas and Nays: 26 - 21.', 'committee-passage'], ['congress_gov', 'Committee Consideration and Mark-up Session Held', null], ['congress_gov', 'Motion to proceed to consideration of measure agreed to in Senate by Voice Vote.', null],
  ['legiscan', 'Chaptered by Secretary of State - Chapter 178, Statutes of 2026.', 'became-law', 'CA'], ['legiscan', 'Approved by the Governor.', 'executive-signature', 'CA'], ['legiscan', 'Enrolled and presented to the Governor at 1 p.m.', 'executive-receipt', 'CA'],
  ['legiscan', 'SIGNED CHAP.55', 'executive-signature', 'NY'], ['legiscan', 'Governor vetoed specific Line Item(s)', null, 'FL'], ['legiscan', 'Vetoed by Governor.', 'executive-veto', 'CA'],
  ['legiscan', 'Read third time. Passed. (Ayes 74. Noes 0. Page 6148.) Ordered to the Senate.', 'passage', 'CA'], ['legiscan', 'Passed 2nd Reading', null, 'NC'], ['legiscan', 'Passed to engrossment as amended', null, 'TX'],
  ['legiscan', 'Introduced, Passed on First Consideration', null, 'TN'], ['legiscan', 'Report adopted; Passed Third Reading. Ayes, 25.', 'passage', 'HI'], ['legiscan', 'Passed Second Reading as amended in HD 1 and referred to the committee(s) on FIN', 'committee-passage', 'HI'],
  ['legiscan', 'Ought not to pass', null, 'ME'], ['legiscan', 'Committee report: ought not to pass', null, 'ME'], ['legiscan', 'Unfavorable Report by Judicial Proceedings', null, 'MD'],
  ['legiscan', 'Reported out without recommendation, as amended', null, 'ID'],
  ['legiscan', 'Inexpedient to Legislate: Motion Adopted Voice Vote 03/11/2026 House Journal 7 P. 4', 'failure', 'NH'], ['legiscan', 'Do Pass Failed', null, 'ND'],
  ['legiscan', 'Do pass recommendation failed', null, 'OK'], ['legiscan', 'Ought to Pass Report Accepted', null, 'ME'], ['legiscan', 'Senate Accepted Ought to Pass Report', null, 'ME'],
  ['legiscan', 'Passed Senate; House amendment not recommended', null, 'MD'], ['legiscan', 'Ought to Pass', 'committee-passage', 'ME'],
  ['legiscan', 'Committee Report: Ought to Pass 03/03/2026 (Vote 15-0; Consent Calendar) House Calendar 10 P. 6', 'committee-passage', 'NH'],
  ['legiscan', 'From committee: Do pass. (Ayes 11. Noes 0.) (May 23).', 'committee-passage', 'CA'], ['legiscan', 'Senate amendments concurred in. To Engrossing and Enrolling.', 'concurrence', 'CA'], ['legiscan', 'Died In Committee', null, 'MS'],
  ['legiscan', 'Read third time. Refused passage. (Ayes 13. Noes 24.)', 'failure', 'CA'], ['legiscan', 'Set for hearing April 13.', 'hearing-scheduled', 'CA'], ['legiscan', 'In committee: Held under submission.', null, 'CA'],
  ['legiscan', "House Hearing: Wednesday, February 12, 2025, 9:00 AM Room 218-N - CANCELED", null, 'KS'], ['legiscan', 'Conference committee meeting to reconvene on 04-28-26 2:40PM', null, 'HI'], ['legiscan', 'Referred to Office of Legislative Research and Office of Fiscal Analysis 03/25/26 5:00 PM', null, 'CT'],
  ['legiscan', 'Sent to the Governor', 'executive-receipt', 'IL'], ['legiscan', 'Ordered Enrolled', 'enrolled', 'NC'], ['legiscan', 'Engrossed', null, 'NC']
];
for (const [src, text, want, jur] of T) { const got = classifyAction(src, text, { jurisdiction: jur || 'US' }); ok(`hand case: ${jur || 'US'} "${text.slice(0, 60)}" -> ${want}`, got === want, `got ${got}`); }
ok('an unknown source maps nothing', classifyAction('other', 'Passed') === null && classifyCongress('') === null && classifyState('') === null);
ok('courts: an order of final relief is a ruling, a notice of appeal a filing, a routine entry nothing', classifyCourt({ description: 'ORDER OF FINAL RELIEF. Signed by Judge Rita F. Lin on August 27, 2026.' }) === 'court-ruling' && classifyCourt({ description: 'NOTICE OF APPEAL to the 9th Circuit Court of Appeals filed by X.' }) === 'court-filing' && classifyCourt({ description: 'CERTIFICATE OF SERVICE' }) === null);

console.log(`news classify: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
