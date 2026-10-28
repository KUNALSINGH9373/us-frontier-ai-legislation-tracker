// The duty checker: plain code, no AI. Holds every duty of an entry to the stored official text.
//   node duties/check.mjs [key ...]        checks duties/drafts/<key>.json (all drafts when no key is given)
// A draft is { key, source_url, duties } where duties has the 13 answers of entry.schema.json "duties".
// For each answer the checker proves: the format is valid, the quote is found word for word, the source URL is the
// one the text came from, every number in the summary and quote is in the text, the section number is in the text,
// and no foreign-script letters crept in. Anything else is reported as a problem and the draft is not merged.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeValidator } from '../schema/validate.mjs';
import { containsQuote, digitRuns } from '../agents/source-text.mjs';
import { sha } from '../grabber/lib/run-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');
export const DRAFTS = path.join(here, 'drafts');
export const TEXTS = path.join(P, 'data', 'eval', 'texts');

// "twenty-four hours", "fifteen days", "one hundred" count as the numbers 24, 15, 100, so a summary may write 24 where the text spells it out.
const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const MULT = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };
export function wordNumbers(text) {
  // Reads runs of number words as one number ("two thousand twenty-nine" = 2029, "one hundred" = 100) and also keeps each
  // part on its own ("twenty-four" gives 24, 20 and 4), so a summary may use any of them.
  const out = new Set(), words = String(text || '').toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/);
  let total = 0, cur = 0, any = false;
  const flush = () => { if (any) out.add(String(total + cur)); total = cur = 0; any = false; };
  for (const w of words) {
    if (UNITS[w] != null) { cur += UNITS[w]; out.add(String(UNITS[w])); any = true; }
    else if (TENS[w] != null) { cur += TENS[w]; out.add(String(TENS[w])); any = true; }
    else if (w === 'hundred') { cur = (cur || 1) * 100; any = true; }
    else if (MULT[w] != null) { total += (cur || 1) * MULT[w]; cur = 0; any = true; }
    else if (w === 'and' && any) continue;
    else flush();
  }
  flush();
  return out;
}

// Letters outside the Latin script, which the English official texts never contain (a field once ended in Bengali).
const foreign = (s) => /[Ͱ-ϿЀ-ӿ֐-ۿऀ-෿฀-࿿぀-ヿ一-鿿가-힯]/.test(s);

// "1" in a summary is usually the word "one" ("a single report"), not a figure the text must state.
const trivial = new Set(['1']);

// The numbers a text states, in digits or in words, as a test function.
function numbersOf(text) {
  const textNums = digitRuns(text), wordNums = wordNumbers(text);
  // A large figure followed by a stray footnote digit ("$500,000,000.8", printed that way in the Illinois text) also counts as the figure itself.
  for (const n of [...textNums]) { const m = /^(\d{4,})\.\d+$/.exec(n); if (m) textNums.add(m[1]); }
  return (n) => textNums.has(n) || wordNums.has(n);
}

export function checkDuties(duties, text, { sourceUrl } = {}) {
  const v = makeValidator();
  const shape = v.check('duties', duties);
  if (shape.length) return shape.map((s) => 'format: ' + s);
  const inText = numbersOf(text);
  return Object.entries(duties).flatMap(([name, d]) => answerProblems(name, d, text, { sourceUrl, inText }));
}

let dutyShape;
// One answer on its own (the agents' duty step drops answers one by one): its format against common.schema.json "duty", then the same text checks.
export function checkAnswer(name, d, text, { sourceUrl } = {}) {
  const shape = (dutyShape ||= makeValidator()).check('duty', d);
  if (shape.length) return shape.map((s) => `${name}: format: ${s}`);
  return answerProblems(name, d, text, { sourceUrl, inText: numbersOf(text) });
}

function answerProblems(name, d, text, { sourceUrl, inText }) {
  const problems = [];
  const at = (m) => problems.push(`${name}: ${m}`);
  if (foreign(d.summary) || foreign(d.quote || '')) at('contains letters from a script the text does not use');
  for (const n of digitRuns(d.summary)) if (!trivial.has(n) && !inText(n)) at(`the summary has the number ${n}, which is not in the official text`);
  if (d.value === 'not_in_bill') return problems;
  if (!containsQuote(text, d.quote)) at(`the quote is not in the official text: "${d.quote.slice(0, 80)}"`);
  if (sourceUrl && d.source_url !== sourceUrl) at(`source_url ${d.source_url} is not the text's own URL ${sourceUrl}`);
  for (const n of digitRuns(d.quote)) if (!inText(n)) at(`the quote has the number ${n}, which is not in the official text`);
  // The section label need not match the bill's punctuation, but any number in it must occur in the text.
  for (const n of digitRuns(d.section)) if (!inText(n)) at(`the section "${d.section}" has the number ${n}, which is not in the official text`);
  return problems;
}

export function loadDraft(key) {
  const f = path.join(DRAFTS, key + '.json');
  if (!fs.existsSync(f)) throw new Error('no draft ' + f);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
export function loadText(key) {
  const f = path.join(TEXTS, key + '.txt');
  if (!fs.existsSync(f)) throw new Error('no stored text for ' + key + ' (run: node eval/fetch-texts.mjs --only ' + key + ')');
  return fs.readFileSync(f, 'utf8');
}

// A whole draft: its duties against its stored text, plus the basis hash the merge will record.
export function checkDraft(draft, text) {
  const problems = [];
  if (!draft.key) problems.push('draft has no key');
  const basis = draft.basis || {};
  if (basis.sha256 && basis.sha256 !== sha(text)) problems.push('the stored text has changed since the draft was written (hash differs); re-read the bill');
  return problems.concat(checkDuties(draft.duties, text, { sourceUrl: draft.source_url }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : fs.existsSync(DRAFTS) ? fs.readdirSync(DRAFTS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  let bad = 0;
  for (const k of keys) {
    let problems;
    try { problems = checkDraft(loadDraft(k), loadText(k)); } catch (e) { problems = [e.message]; }
    if (problems.length) { bad++; console.log(`FAIL ${k}\n  ` + problems.join('\n  ')); } else console.log(`ok   ${k}`);
  }
  console.log(bad ? `${bad} of ${keys.length} FAILED` : `${keys.length} OK`);
  process.exit(bad ? 1 : 0);
}
