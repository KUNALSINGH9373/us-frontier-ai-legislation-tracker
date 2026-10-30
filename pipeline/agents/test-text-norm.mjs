// The shared text-cleanup and number module (agents/text-norm.mjs) and the quote check built on it (C3, C4). Code only, no AI.
//   node agents/test-text-norm.mjs
import { cleanText, parseNumberWords, detectNumbering, digitRuns, NUMBER_WORD, COMPUTE_POWER_PHRASE, LOST_EXPONENT_IN_VALUE, LOST_EXPONENT, exponentOf } from './text-norm.mjs';
import { normaliseExponents, thresholdNumberProblems } from './checks.mjs';
import { containsQuote } from './source-text.mjs';
import { SECTION_MARKERS } from './rules.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail === undefined ? '' : detail); } };
const same = (s) => cleanText(s) === s;

// ---------- lost superscripts: every form handled before C3 still is ----------
ok('1026 integer', cleanText('greater than 1026 integer or') === 'greater than 10^26 integer or');
ok('10�26 / 10ˆ26 operations', cleanText('10�26 operations') === '10^26 operations' && cleanText('10ˆ26 operations') === '10^26 operations');
ok('PA "1,026 integer"', cleanText('greater than 1,026 integer or floating-point') === 'greater than 10^26 integer or floating-point');
ok('"1026 FLOPs"', cleanText('over 1026 FLOPs') === 'over 10^26 FLOPs');
ok('years, counts and written exponents are untouched', same('In 2026 operations began; 1026 people; 10^26 operations; 1,025 operations were logged; 1026 inserting'));
// new: one pattern, so the source repair now also reads "10.26" (AZ H.B. 4098's misprint), as the threshold check always did
ok('"10.26 computational operations" is 10^26 (AZ form)', cleanText('greater than 10.26 computational operations') === 'greater than 10^26 computational operations');
ok('"1,026 operations" (no strong unit) is a count, in a source and in a written value', same('1,026 operations were logged') && !new RegExp(LOST_EXPONENT_IN_VALUE.source, 'i').test('more than 1,026 operations'));

// ---------- false rewrites (independent review): a figure that is not a lost exponent is never changed ----------
ok('a cited provision is not an exponent: "Section 10.21", "sec. 10.25", "§ 1026", "paragraph 10.20", "§1026"',
  same('under Section 10.21 integer') && same('see sec. 10.25 FLOPs') && same('as in § 1026 computational operations') && same('paragraph 10.20 floating-point') && same('§1026 integer'));
ok('"10.21 operations" / "1025 operations" (weak unit only) are left as printed', same('within 10.21 operations of') && same('the first 1025 operations'));
ok('no guess at a digit after an amount: "$1,000.5 million" and "$500,000,000.8 Minor" stay as printed with no line run',
  same('a fine of $1,000.5 million. The') && same('at least $500,000,000.8 "Minor" means'));
ok('normaliseExponents does not rewrite a cited section or a count', normaliseExponents('Section 10.26 integer; 1,026 operations') === 'Section 10.26 integer; 1,026 operations');

// ---------- true rewrites: a lost superscript is still put back, in a source and in a written value ----------
ok('10^26 with a lost superscript ("1026 integer", "10.26 computational", "10,26 FLOPs", "10�26 operations")',
  cleanText('more than 1026 integer') === 'more than 10^26 integer' && cleanText('10,26 FLOPs') === '10^26 FLOPs' && cleanText('of 10�26 operations') === 'of 10^26 operations');
ok('PA H.B. 2800 "1,026 integer or floating-point operations" -> 10^26', cleanText('using greater than 1,026 integer or floating-point operations') === 'using greater than 10^26 integer or floating-point operations'
  && normaliseExponents('more than 1,026 integer or floating-point operations') === 'more than 10^26 integer or floating-point operations');
ok('exponentOf reads both match forms', [...'1,026 integer and 10ˆ25 operations'.matchAll(new RegExp(LOST_EXPONENT.source, 'gi'))].map(exponentOf).join() === '26,25');
ok('the threshold check names the right exponent for either form', /10\^26; write it as 10\^26/.test(thresholdNumberProblems('t', 'over 1,026 integer operations').join()) && /10\^25; write it as 10\^25/.test(thresholdNumberProblems('t', '10ˆ25 operations').join()));

// ---------- powers written out ----------
ok('CT "ten to the twen ty - sixth power" (previous one-off)', cleanText('greater than ten to the twen ty - sixth power integer or') === 'greater than 10^26 integer or');
ok('"10 to the 26th power"', cleanText('more than 10 to the 26th power floating-point operations') === 'more than 10^26 floating-point operations');
ok('"ten to the power of twenty-six"', cleanText('ten to the power of twenty-six integer operations') === '10^26 integer operations');
ok('"10 to the power of 25"', cleanText('10 to the power of 25 operations') === '10^25 operations');
ok('"ten to the thirtieth power"', cleanText('ten to the thirtieth power FLOPs') === '10^30 FLOPs');
ok('split elsewhere: "twenty - si xth", "tw enty-fifth"', cleanText('ten to the twenty - si xth power integer') === '10^26 integer' && cleanText('ten to the tw enty-fifth power operations') === '10^25 operations');
ok('a power with no compute unit after it is left alone', same('ten to the sixth power') && same('raised 10 to the 26th power of'));
ok('parseNumberWords', [['twen ty - sixth', 26], ['thirtieth', 30], ['26th', 26], ['twenty-six', 26], ['nineteenth', 19], ['seven', 7], ['ninety nine', 99], ['bogus', null]].every(([s, v]) => parseNumberWords(s) === v));
ok('NUMBER_WORD does not match inside a word', !new RegExp(`^(?:${NUMBER_WORD})$`, 'i').test('someone') && new RegExp(`^(?:${NUMBER_WORD})$`, 'i').test('twenty-sixth'));
const cp = new RegExp(COMPUTE_POWER_PHRASE, 'i');
ok('section markers: a compute power in words or digits, 20-29 only', cp.test('ten to the twenty-sixth power') && cp.test('10 to the 26th power') && cp.test('ten to the power of twenty') && !cp.test('ten to the sixth power') && !cp.test('ten to the thirtieth power'));
ok('section markers: "ten to the twenty-sixth power" marks a frontier threshold', new RegExp(SECTION_MARKERS.B, 'i').test('trained using more than ten to the twenty-sixth power operations'));

// ---------- line numbering: one detector, two formats ----------
const ny = '5 frontier models in 6 the State that are developed by a large 7 developer with 50 employees shall, before 8 deployment, implement';
const d = detectNumbering(ny);
ok('line format: the run is found, a real figure is not', d.values.has(6) && d.values.has(8) && !d.values.has(50));
const mn = '3.28 Subd. 4. Safety incident disclosure. A developer must disclose each\n3.29 affecting the model to the attorney general within 72 hours of the\n3.30 the developer learns of it. Section 3.31 of the code applies\n3.31 to each incident report.';
const m = detectNumbering(mn);
ok('page.line format: the run is found', ['3.28', '3.29', '3.30', '3.31'].every((x) => m.pageLines.has(x)));
ok('page.line format: a section decimal inside a line is not stripped', m.positions.filter((p) => p.v === '3.31').length === 1);
ok('page.line format: a lone section number at a line start is not a run', detectNumbering('Intro text here.\n2.5 Definitions apply.\nOther text 7.2 here.').pageLines.size === 0);
ok('a quote across MN page.line numbers is found', containsQuote(mn, 'A developer must disclose each affecting the model to the attorney general'));

// ---------- C4: the loose retry cannot hide a misquoted figure ----------
const src = '11 the developer shall pay a civil 12 penalty of $10,000 for each violation, 13 and the attorney general shall recover 14 the penalty in a civil action within 15 days.';
ok('a faithful quote that copied a line number still matches', containsQuote(src, 'civil 12 penalty of $10,000'));
ok('a faithful quote across line numbers matches', containsQuote(src, 'shall pay a civil penalty of $10,000 for each violation'));
ok('a misquoted figure equal to a line number elsewhere is refused', !containsQuote(src, 'the developer shall pay a civil 13 penalty of $10,000'));
ok('a figure in the bill that is also a line number (15 days) still matches', containsQuote(src, 'in a civil action within 15 days'));
ok('a misquoted deadline equal to a line number is refused', !containsQuote(src, 'the attorney general shall recover 12 the penalty in a civil action'));
ok('digitRuns reads an exponent printed any way alike', ['10^26', '10²⁶', '1026 integer', '10\\26\\'].every((x) => digitRuns(x).has('26')));

console.log(`text-norm: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
