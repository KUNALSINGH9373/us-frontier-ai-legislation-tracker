// Round 3 regressions (Tier B new entries; audit of 29 Oct 2026, E:/uslegislation/l2r3-entries-scratch). Code only, no AI.
//   node agents/test-round3.mjs
import { measureKind, federalRefusals, recordRefusals } from './record-kind.mjs';
import { sectionPassage, quoteMeetsSection, sectionsByCode } from './rules.mjs';
import { numbersIn, trackerIndex, duplicateOf, relatedUnread, companionOf, refileOf, federalNameMatch, similarity } from './dedupe.mjs';
import { containsQuote, lineNumbers } from './source-text.mjs';
import { quoteMatchProblems, checkNewEntry } from '../publish/guards.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };

// ---------- 6. federal resolutions and the federal section criterion ----------
{
  const it = (t, n) => ({ item_id: `congress_gov:119/${t}/${n}`, source: 'congress_gov' });
  ok('6 S.Res., H.Res., Con.Res. and J.Res. are refused before any AI', ['sres', 'hres', 'sconres', 'hconres', 'sjres', 'hjres'].every((t) => federalRefusals(it(t, 918), {}).length === 1) && federalRefusals(it('sres', 918), { bill: { type: 'SRES', title: 'A resolution establishing the Select Committee on Artificial Intelligence.' } }).length === 1);
  ok('6 a federal bill (H.R., S.) is not refused as a resolution', federalRefusals(it('hr', 10152), { bill: { type: 'HR', title: 'Open-Source AI Leadership Act' } }).length === 0 && federalRefusals(it('s', 5047), { bill: { type: 'S', title: 'AI Physical Systems Coordination Act' } }).length === 0);
  const HR10502 = 'The Director of National Intelligence shall submit to Congress a report on the use of artificial intelligence systems to acquire, analyze, query, disseminate, or otherwise access information under section 702 of the Foreign Intelligence Surveillance Act, including the privacy and civil liberties safeguards that apply.';
  ok('6 F: a report on agency use of AI under section 702 (H.R. 10502) meets neither D nor F', !sectionPassage('F', HR10502) && !sectionPassage('D', HR10502) && !quoteMeetsSection('F', HR10502));
  ok('6 F: a federal AI-risk passage meets F (CBRN capabilities of foreign models; AI incident reporting at DoD)', quoteMeetsSection('F', 'The development and use of chemical, biological, radiological, or nuclear capabilities') && quoteMeetsSection('F', 'The Secretary of Defense shall establish a program for reporting incidents involving artificial intelligence systems'));
  ok('6 F: procurement of AI is OUT', !quoteMeetsSection('F', 'The Administrator shall issue guidance on the procurement of artificial intelligence systems, including testing of such systems') );
  ok('6 D: a frontier-developer duty meets D; an F-only passage does not', quoteMeetsSection('D', 'a developer of a frontier model trained using more than 10^26 operations') && !quoteMeetsSection('D', 'reporting incidents involving artificial intelligence systems'));
  const e = { section: 'F', type: 'bill', level: 'federal', jurisdiction: 'Federal', state: null, status: 'pending', origin: 'automated', verification: { method: 'agent' }, title: 'S.Res. 918 — A resolution establishing the Select Committee on Artificial Intelligence.', mechanism: null, thresholds: null, penalties: null, evidence: [{ field: 'section', quote: 'reporting incidents involving artificial intelligence systems' }] };
  ok('6 tier B refuses a congressional resolution title in D or F', checkNewEntry(e).some((p) => /congressional resolution/.test(p)));
  ok('6 tier B refuses a federal F entry without a section quote meeting F', checkNewEntry({ ...e, title: 'H.R. 10502 — To direct the DNI', evidence: [{ field: 'section', quote: HR10502 }] }).some((p) => /section F's criterion/.test(p)) && !checkNewEntry({ ...e, title: 'H.R. 1 — X' }).some((p) => /section F's criterion/.test(p)));
}

// ---------- 7. dedupe ----------
{
  const n = (t) => numbersIn(t).join(',');
  ok('7 numbersIn reads "Assembly Bill 1018" and "Senate Bill 53"', /AB1018/.test(n('California Assembly Bill 1018')) && /SB53/.test(n('Senate Bill 53 (2025)')) && /SB53/.test(n('Senate Bill No. 53')));
  ok('7 numbersIn reads S.6953B, SSB/ESHB, LD and House File', /S6953/.test(n('the RAISE Act (S.6953B)')) && /SB5001/.test(n('SSB 5001')) && /HB1234/.test(n('ESHB 1234')) && /LD1234/.test(n('Maine LD 1234')) && /HF2412/.test(n('House File 2412')) && /SF1/.test(n('Senate File 1')));
  const tracked = { key: 'ca-sb-53', state: 'CA', level: 'state', title: 'S.B. 53 — Transparency in Frontier Artificial Intelligence Act', short_name: 'CA SB 53', events: [{ date: '2025-01-07', text: 'Introduced' }, { date: '2025-09-29', text: 'Signed' }], identifiers: { session: '2025-2026 Regular Session', external: {} } };
  const idx = trackerIndex([tracked]);
  const cand = (years, title = 'Vehicles: speed limits') => ({ item: { item_id: 'legiscan:999', source: 'legiscan' }, raw: { bill: { state: 'CA', bill_number: 'SB53', title, session: { year_start: years[0], year_end: years[1] } }, text: '' }, idx });
  ok('7 a reused number in a later session is not a duplicate', duplicateOf(cand([2027, 2028])) === null);
  ok('7 the same number in the same session is a duplicate', !!duplicateOf(cand([2025, 2026])));
  ok('7 a reused number whose title matches is a duplicate', !!duplicateOf(cand([2027, 2028], 'Transparency in Frontier Artificial Intelligence Act')));
  const hawley = { key: 'ai-agent-accountability-act-hawley-murphy-announced', level: 'federal', section: 'D', title: 'AI Agent Accountability Act (Hawley–Murphy) — announced, not yet numbered', short_name: 'AI Agent Accountability Act (Hawley–Murphy, announced)', sponsor_text: 'Sens. Josh Hawley (R-MO), Chris Murphy (D-CT)', identifiers: { external: {} } };
  const liccardo = { key: 'liccardo-kiley-us-china-ai-safety-bill', level: 'federal', section: 'D', title: 'U.S.–China frontier-AI safety coordination bill (Liccardo–Kiley) — announced', short_name: 'US-China AI safety bill (Liccardo-Kiley)', sponsor_text: 'Reps. Sam Liccardo (D-CA), Kevin Kiley (I-CA)', identifiers: { external: {} } };
  const fed = (title, sponsors) => ({ item: { item_id: 'congress_gov:119/s/5700', source: 'congress_gov', title }, raw: { bill: { title, sponsors } } });
  ok('7 an announced federal bill, numbered, is held (title and sponsor)', !!federalNameMatch({ ...fed('AI Agent Accountability Act', [{ lastName: 'Hawley' }]), entries: [hawley] }) && duplicateOf({ ...fed('AI Agent Accountability Act', [{ lastName: 'Hawley' }]), idx: trackerIndex([hawley]) }).possible === true);
  ok('7 the Liccardo-Kiley announced bill, numbered, is held', !!federalNameMatch({ ...fed('United States-China Artificial Intelligence Safety Coordination Act', [{ lastName: 'Liccardo' }]), entries: [liccardo] }));
  ok('7 the same title with no shared sponsor, or another bill by the same sponsor, is not held', !federalNameMatch({ ...fed('AI Agent Accountability Act', [{ lastName: 'Smith' }]), entries: [hawley] }) && !federalNameMatch({ ...fed('Farm Credit Modernization Act', [{ lastName: 'Hawley' }]), entries: [hawley] }));
  ok('7 relatedUnread compares the stored list with the count', !!relatedUnread({ source: 'congress_gov' }, { bill: { relatedBills: { count: 2 } }, related_bills: [] }) && !!relatedUnread({ source: 'congress_gov' }, { bill: { relatedBills: { count: 2 } }, related_bills: [{}] }) && relatedUnread({ source: 'congress_gov' }, { bill: { relatedBills: { count: 1 } }, related_bills: [{}] }) === null);
  const body = 'Section 1. A large developer shall not deploy a frontier model unless the large developer has implemented a written safety and security protocol, conducted annual independent audits, and published redacted transparency reports to the attorney general. Section 2. The attorney general may bring a civil action for a violation and recover a civil penalty. Section 3. Employees who disclose information about critical risks are protected from retaliation by the large developer.';
  ok('7 a same-run companion (same text, other number and chamber) is not created twice', !!companionOf({ text: 'HOUSE BILL 4098. ' + body }, [{ key: 'az-hb-4098', label: 'AZ HB 4098', text: 'SENATE BILL 1500. ' + body, textKey: (() => null)() }]));
  ok('7 two different bills are not companions', companionOf({ text: body }, [{ key: 'x', label: 'x', text: 'Section 1. A person shall not operate a motor vehicle at a speed greater than is reasonable and prudent under the conditions, having regard to the actual and potential hazards then existing on the highway, and the traffic.' }]) === null);
  const entryA = { key: 'az-hb-4098', state: 'AZ', level: 'state', title: 'H.B. 4098 — Artificial intelligence businesses; attorney general; requirements', mechanism: 'An artificial intelligence business must conduct a risk assessment of each high risk AI system, submit a transparency report to the attorney general before using or selling it, and conduct a quarterly audit to identify and correct discrimination.' };
  ok('7 a refile in a later session with no link (same description) is held', !!refileOf({ ...entryA, key: 'az-hb-2001', title: 'H.B. 2001 — Artificial intelligence businesses; attorney general; requirements' }, [entryA]));
  ok('7 a different bill of the same state is not a refile', refileOf({ key: 'az-sb-1', state: 'AZ', title: 'S.B. 1 — Chatbots; minors', mechanism: 'Operators of companion chatbots must verify the age of users and disclose that the chatbot is not a human at the start of each conversation.' }, [entryA]) === null);
  ok('7 similarity: same words high, other words low', similarity(body, body.replace('attorney general', 'Attorney General')) > 0.9 && similarity(body, 'The board of pharmacy shall license pharmacists who complete an approved course of study and pass the examination given by the board each year.') < 0.2);
}

// ---------- 8. record kind ----------
{
  const memorial = 'HOUSE CONCURRENT MEMORIAL. A RESOLUTION urging the Congress of the United States to enact a bill on frontier artificial intelligence. BE IT RESOLVED by the House of Representatives of the State of Arizona that the Congress shall act.';
  ok('8 an explicit resolution or memorial form wins over "a bill" in the opening', measureKind({ bill_number: 'HB4098', bill_type_id: 1 }, memorial) !== 'bill' && measureKind({ bill_number: 'HB4098', bill_type_id: 1 }, 'BE IT RESOLVED by the Senate, that the Congress enact an act on AI.') === 'resolution');
  ok('8 a title that names the resolution form wins', measureKind({ bill_number: 'HB12', bill_type_id: 1, title: 'A Resolution urging Congress to regulate frontier AI' }, 'A BILL relating to AI') === 'resolution' && measureKind({ bill_number: 'HB12', bill_type_id: 1, title: 'House Joint Memorial on AI safety' }, 'AN ACT') === 'memorial');
  ok('8 a bill about "dispute resolution" or a "memorial highway" is still a bill', measureKind({ bill_number: 'HB12', bill_type_id: 1, title: 'Alternative Dispute Resolution Act' }, 'A BILL to be entitled an act relating to the resolution of disputes involving AI') === 'bill' && measureKind({ bill_number: 'SB3', bill_type_id: 1, title: 'Memorial highway designation' }, 'AN ACT designating a memorial highway') === 'bill');
  ok('8 Nebraska LR300 is a resolution', measureKind({ bill_number: 'LR300', bill_type_id: 1 }, '') === 'resolution' && recordRefusals({ bill: { title: 'x', bill_number: 'LR300', bill_type_id: 1 }, text: '' }).length === 1);
}

// ---------- 9. pre-AI section filter ----------
{
  const NC = 'Computing cluster. A set of machines with a capacity of at least 10 to the power of 20 integer or floa ting - point operations per second. Covered model. An artificial intelligence model trained using a quantity of computing power greater than 10 to the 26th power integer or floating point operations. Critical harm. A harm caused or materially enabled by a cove red model including the creation or use in a manner that results in mass casualties of a chemical, biological, radiological, or nuclear weapon. ' + 'Definitions continue. '.repeat(60) + '(a) Before beginning to initially train a covered model, the developer shall implement the capability to promptly enact a full shutdown.';
  ok('9 NC S735: covered model, threshold in words and PDF-split words meet B', !!sectionPassage('B', NC) && sectionsByCode(NC, ['B', 'B.2', 'C']).includes('B'));
  ok('9 "10 to the 26th power" and "covered model" are threshold markers', quoteMeetsSection('B', 'greater than 10 to the 26th power integer operations') && quoteMeetsSection('B', 'a cove red model or covered model derivative') && quoteMeetsSection('B', 'integer or floa ting - point operations'));
  const B2 = 'Findings: some say models trained with FLOPs are risky. ' + 'Filler sentence about the state budget. '.repeat(150) + 'A developer of an artificial intelligence model shall assess catastrophic risk and shall not deploy a model that poses an unreasonable risk of critical harm.';
  ok('9 B.2 is not vetoed by a threshold word far from any duty', !!sectionPassage('B.2', B2));
  ok('9 B.2 is refused when the text meets B', !sectionPassage('B.2', 'A frontier developer shall assess catastrophic risk of each frontier model trained using more than 10^26 operations.'));
  const NJ = 'compostable items certified by a recognized third-party independent verification organization, does not contain a product that is sold in the State';
  ok('9 C needs an AI context (NJ S1927 compost bill does not meet C)', !sectionPassage('C', NJ) && !quoteMeetsSection('C', NJ) && !!sectionPassage('C', 'The Attorney General shall license independent verification organizations that assess artificial intelligence models.'));
}

// ---------- 10. numbers and duties against their quotes ----------
{
  const base = { mechanism: 'A developer must publish a safety and security protocol before deployment.', thresholds: 'Trained using more than 10^26 integer or floating-point operations.', penalties: 'Civil penalty of up to $50,000 per violation.',
    evidence: [{ field: 'mechanism', quote: 'shall publish a safety and security protocol before deployment' }, { field: 'thresholds', quote: 'greater than 10^26 integer or floating-point operations' }, { field: 'penalties', quote: 'civil penalty of not more than $50,000 per violation' }] };
  ok('10 a faithful entry has no number or duty problem', quoteMatchProblems(base).length === 0, quoteMatchProblems(base).join('; '));
  ok('10 10^25 against a quoted 10^26 is refused', quoteMatchProblems({ ...base, thresholds: 'Trained using more than 10^25 operations.' }).some((p) => /thresholds gives 25/.test(p)));
  ok('10 $500,000 against a quoted $50,000 is refused', quoteMatchProblems({ ...base, penalties: 'Civil penalty of up to $500,000 per violation.' }).some((p) => /penalties gives 500000/.test(p)));
  ok('10 "$100 million" reads as $100,000,000', quoteMatchProblems({ ...base, penalties: 'Up to $100 million.', evidence: [...base.evidence.filter((x) => x.field !== 'penalties'), { field: 'penalties', quote: 'not more than $100,000,000' }] }).length === 0);
  ok('10 an invented duty with no quote is refused', quoteMatchProblems({ ...base, mechanism: base.mechanism + ' Developers must also pause training when a critical harm occurs.' }).some((p) => /duty no quote backs/.test(p)));
}

// ---------- 11. line-numbered texts ----------
{
  const MA = '1134 input it receives how to generate outputs. 1135 (c) (1) "Catastrophic risk" means a foreseeable and material risk that a frontier 1136 developer\'s development, storage, use, or deployment of a frontier model will materially 1137 contribute to the death of, or serious injury to, more than 50 people or more than one billion 1138 dollars in damage. 1139 (d) "Critical safety incident" means';
  ok('11 a quote across a printed line number is found', containsQuote(MA, 'a frontier developer\'s development, storage, use, or deployment of a frontier model will materially contribute to the death of'));
  ok('11 a quote that copied the line numbers is found', containsQuote(MA, 'material risk that a frontier 1136 developer\'s development'));
  ok('11 hyphenation and split hyphens are read alike', containsQuote('integer or floating - point oper- ations and', 'integer or floating-point operations'));
  ok('11 a quote that does not match is still refused', !containsQuote(MA, 'more than 100 people') && !containsQuote(MA, 'a frontier developer\'s development will contribute to the death of') && !containsQuote(MA, 'more than people'));
  ok('11 only the line-number run is removed (50 is a real figure)', !lineNumbers(MA).values.has(50) && lineNumbers(MA).values.has(1136));
}

console.log(`round 3: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
