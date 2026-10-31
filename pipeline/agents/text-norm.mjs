// One place for how bill text is cleaned and how numbers in it are read. Every check that looks at figures (the quote and number
// checks, the threshold rules, the section markers, the self-correction texts) imports from here, so they all agree on one compute-unit
// vocabulary, one exponent pattern, one number-words reader and one line-numbering detector. Nothing here knows any bill: each rule is
// stated in terms of the printed form it repairs. Later readers of a bill's structure build on detectNumbering and cleanText.
import { PIPELINE } from './pipeline-config.mjs';

// ---------- words split by PDF extraction ----------
// "cove red model", "floa ting - point", "twen ty - sixth": one optional space between any two letters, and an optional spaced hyphen.
export const loose = (w) => [...w].map((c, i) => (c === '-' ? String.raw`\s?[- ]?\s?` : c + (i < w.length - 1 && w[i + 1] !== '-' ? String.raw`\s?` : ''))).join('');

// ---------- compute units and the lost superscript ----------
// The words that follow a training-compute figure. "operations" alone is weaker evidence (a count of operations is common), so the
// comma forms of a lost exponent ("1,026 operations" could be a count) need one of the strong words.
const STRONG_UNIT = String.raw`(?:integer|floating|computational|FLOPs?\b)`;
export const COMPUTE_UNIT = String.raw`(?:integer|floating|computational|operations|FLOPs?\b)`;
// 10²⁶ printed without its superscript: "10�26" or "10ˆ26" (the debris proves a superscript) before any compute unit; "1026",
// "10.26", "10,26" or "1,026" (PA H.B. 2800's form) only before a strong unit (integer, floating-point, computational operations,
// FLOPs), since "1025 operations" or "10.21 operations" can be a count or a citation. A number cited as a provision ("Section 10.21",
// "§ 1026", "paragraph 10.20") is never read as an exponent. The same pattern holds in bill text and in written values. Group 1 is
// the exponent.
const CITED = String.raw`(?<!(?:\bsections?|\bsec|\bsubsections?|\bsubdivisions?|\bparagraphs?|\bsubparagraphs?|\bclauses?|\brules?|\barticles?|\bchapters?|\bparts?|\btitles?|\bitems?|\bno|§|¶)\.?\s*)`;
export const LOST_EXPONENT = new RegExp(String.raw`${CITED}\b(?:10[�ˆ](2\d)(?=\s+${COMPUTE_UNIT})|(?:10[.,]?|1,0)(2\d)(?=\s+${STRONG_UNIT}))`, 'gi');
export const LOST_EXPONENT_IN_VALUE = LOST_EXPONENT;
// The exponent of a LOST_EXPONENT match.
export const exponentOf = (m) => m[1] || m[2];
const fixExponent = (m, a, b) => `10^${a || b}`;
// Encoding debris a superscript leaves behind on its own.
export const ENCODING_DEBRIS = /[�ˆ]/;
// An amount with one stray digit after its point, in a written value ("$500,000,000.8"): a line number, since cents have two digits.
export const GLUED_AMOUNT = /\$\d{1,3}(?:,\d{3})+\.\d(?!\d)/;

// ---------- numbers written in words ----------
const UNITS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const ORD_UNITS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const ORD_TEENS = ['tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'];
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORD_TENS = ['twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];
const alt = (words) => [...words].sort((a, b) => b.length - a.length).map(loose).join('|');
// A cardinal or ordinal from one to ninety-nine, in words, tolerating PDF splits ("twen ty - sixth"), or in digits ("26", "26th").
export const NUMBER_WORD = String.raw`(?:\d{1,3}(?:st|nd|rd|th)?\b|(?:${alt(TENS)})(?:\s?-?\s?(?:${alt([...ORD_UNITS, ...UNITS])}))?(?![a-z])|(?:${alt([...ORD_TENS, ...ORD_TEENS, ...TEENS, ...ORD_UNITS, ...UNITS])})(?![a-z]))`;
// The value of a NUMBER_WORD match (null when it is not one): "twen ty - sixth" -> 26, "thirtieth" -> 30, "26th" -> 26.
export function parseNumberWords(s) {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const d = /^(\d{1,3})(?:st|nd|rd|th)?$/.exec(t);
  if (d) return +d[1];
  const small = (w) => { for (const list of [UNITS, ORD_UNITS]) { const i = list.indexOf(w); if (i >= 0) return i + 1; } for (const list of [TEENS, ORD_TEENS]) { const i = list.indexOf(w); if (i >= 0) return i + 10; } return null; };
  if (!t) return null;
  const direct = small(t); if (direct != null) return direct;
  for (const list of [TENS, ORD_TENS]) { const i = list.indexOf(t); if (i >= 0) return 20 + 10 * i; }
  for (let i = 0; i < TENS.length; i++) if (t.startsWith(TENS[i])) { const rest = t.slice(TENS[i].length), u = UNITS.indexOf(rest) >= 0 ? UNITS.indexOf(rest) : ORD_UNITS.indexOf(rest); if (u >= 0) return 20 + 10 * i + u + 1; }
  return null;
}
// "ten to the twenty-sixth power", "10 to the 26th power", "ten to the power of twenty-six", "10 to the power of 26". Group 1 is the
// exponent as written; parseNumberWords reads it.
const powerPhrase = (n) => String.raw`\b(?:ten|10)\s+to\s+the\s+(?:power\s+of\s+)?(${n})(?:\s+power\b)?`;
export const POWER_PHRASE = powerPhrase(NUMBER_WORD);
// The same phrase with an exponent from 20 to 29 only (the training-compute range), for the section markers: "10 to the 26th power",
// "ten to the twenty-sixth power", "ten to the power of twenty".
export const COMPUTE_POWER_PHRASE = powerPhrase(String.raw`2\d(?:st|nd|rd|th)?\b|${loose('twent')}(?:${loose('ieth')}|${loose('y')}(?:\s?-?\s?(?:${alt([...ORD_UNITS, ...UNITS])}))?)(?![a-z])`);

// ---------- printed line numbering ----------
// A numbering format is how a state prints its line numbers: "line" (NY, MA: a bare number every line, "a frontier 1136 developer's")
// or "page.line" (MN: "3.29" at the start of every line). One detector finds a run of tokens of one format, each the token before plus
// one and min_gap to max_gap characters after it, at least min_run long (config/pipeline.json text.numbering). A real figure or section
// decimal is never in such a run. A "line" number glued onto an amount ("$500,000,000.8 'Minor'", IL H.B. 4705) is a token too, but
// only counts when the run needs it and no separate token of the same number is nearby.
const FORMATS = {
  line: { re: /(?<=^|\s)(\d{1,4})(?=\s)|(?<=\$\d{1,3}(?:,\d{3})+\.)(\d{1,2})(?=\s)/g, key: (m) => +(m[1] || m[2]), glued: (m) => !m[1] },
  'page.line': { re: /(?<=^|\n)[ \t]*((\d{1,3})\.(\d{1,2}))(?=\s)/g, key: (m) => +m[2] * 100 + +m[3], value: (m) => m[1], at: (m) => m.index + m[0].length - m[1].length }
};
const NUMBERING = Object.fromEntries((PIPELINE.text && PIPELINE.text.numbering || []).map((f) => [f.name, f]));
function runOf(text, name) {
  const f = FORMATS[name], c = NUMBERING[name];
  const toks = [...text.matchAll(f.re)].map((m) => { const v = f.value ? f.value(m) : (m[1] || m[2]); return { key: f.key(m), v, i: f.at ? f.at(m) : m.index, len: v.length, glued: f.glued ? f.glued(m) : false }; });
  const last = new Map(), chain = new Array(toks.length).fill(1), prevOf = new Array(toks.length).fill(-1), keep = new Set();
  toks.forEach((k, j) => {
    const p = last.get(k.key - 1);
    if (p != null && k.i - toks[p].i >= c.min_gap && k.i - toks[p].i <= c.max_gap) { chain[j] = chain[p] + 1; prevOf[j] = p; }
    last.set(k.key, j);
    if (chain[j] >= c.min_run) for (let x = j; x >= 0 && !keep.has(x); x = prevOf[x]) keep.add(x);
  });
  const near = (k) => toks.some((o) => !o.glued && o.key === k.key && Math.abs(o.i - k.i) <= c.max_gap);
  return [...keep].map((j) => toks[j]).filter((k) => !k.glued || !near(k)).map((k) => ({ ...k, format: name }));
}
// Every printed line number in the text: { positions: [{ i, len, v, format, glued }], values: Set of "line" numbers, pageLines: Set of
// "page.line" strings }, positions in text order.
export function detectNumbering(text) {
  const t = String(text || ''), positions = Object.keys(FORMATS).filter((n) => NUMBERING[n]).flatMap((n) => runOf(t, n)).sort((a, b) => a.i - b.i);
  return { positions, values: new Set(positions.filter((p) => p.format === 'line').map((p) => p.key)), pageLines: new Set(positions.filter((p) => p.format === 'page.line').map((p) => p.v)) };
}

// ---------- printing noise ----------
// What a printer adds to a bill that is not the bill: a page header or footer on its own line on every page, a converter's markers
// ("START_STATUTE", "END_STATUTE") and the replacement character "�" a lost glyph leaves. Nothing here knows a state or a bill:
// - a page header or footer: see pageLines below (whole lines only, a page number going up by one, page-like spacing);
// - a converter marker: capital words joined by underscores;
// - "�" is a space, except between two digits or before a bracket, where it stays: a guess there could join "1�000" into a figure
//   the bill may not state ("10�[26] 25" is read by readerText's amended-exponent rule).
// Every removal is replaced by one space, so no two words or numbers are ever joined; a figure of the bill is never changed.
// (Ported from the C5 archive, reviewed 31 Oct 2026: FAIL CLOSED.)
export const HEADER_MIN_REPEATS = 3;
const MARKER = /\b[A-Z]{2,}(?:_[A-Z]{2,})+\b/g;
const CODE_TOKEN = /^(?:[A-Z0-9#][A-Z0-9#.\-/]*|[A-Za-z]*[\d#][\w#.\-/]*|[a-z]|-+)$/;
const NUM_TOKEN = /^[A-Za-z]*\d/;
const tokensIn = (s) => s.split(/\s+/).map((x) => x.replace(/^[(\[-]+|[)\],;:-]+$/g, '')).filter(Boolean);
const digitsAny = (s) => s.replace(/\d+/g, '#');
// A header or footer is removed only when ALL hold:
// - it is a whole line (a line break, or the text's edge, on both sides);
// - the same line (digits read as any digits) recurs at least HEADER_MIN_REPEATS times, made of identifier-like tokens or a "Page n of
//   m" / "- n -" form, with a letter or a page form in it;
// - exactly one number changes from place to place and it goes up by exactly one each time (a page number);
// - the places are page-like apart: every gap at least PAGE_MIN_GAP characters and no gap more than PAGE_GAP_RATIO times another.
// A header glued into a sentence (the extraction lost its line breaks) is left in; deleting real text (a citation list, a schedule's
// rows, a repeated citation at line ends) is not acceptable.
export const PAGE_MIN_GAP = 400;
export const PAGE_GAP_RATIO = 4;
function pageLines(t) {
  const lines = [], counts = new Map();
  for (const m of t.matchAll(/[^\n]+/g)) {
    const s = m[0].trim(); if (s.length < 3 || s.length > 100) continue;
    const key = digitsAny(s.replace(/\s+/g, ' '));
    lines.push({ i: m.index, len: m[0].length, key, s }); counts.set(key, (counts.get(key) || 0) + 1);
  }
  const page = /^(?:page\s+#+(?:\s+of\s+#+)?|#+\s+of\s+#+|-\s*#+\s*-)$/i;
  // A line that names its page ("Page 2", "Page 5 of 16", "-3-") beside other header text ("2025   Page 5 of 16", "Page 2   Senate Bill
  // 735-First Edition", "-2-   HB25-1212"): the page form is enough evidence, given the counter and spacing rules below.
  const pageForm = (l) => /(?:^|\s)(?:page\s+#+(?:\s+of\s+#+)?|-\s*#+\s*-)(?=\s|$)/i.test(l.key) && !/[$%^§]/.test(l.s);
  const looks = (l) => page.test(l.key) || pageForm(l) || (!/[$%^§]/.test(l.s) && /[A-Za-z]/.test(l.s) && tokensIn(l.s).length >= 2 && tokensIn(l.s).every((x) => CODE_TOKEN.test(x)) && tokensIn(l.s).filter((x) => NUM_TOKEN.test(x)).length >= 2);
  // The page number goes up by one; by two when the line names its page and the layout alternates sides, so that odd and even pages
  // print it in two forms ("Page 2   Senate Bill 735" / "Senate Bill 735   Page 3"), each its own group.
  const counter = (group) => {
    const nums = group.map((l) => (l.s.match(/\d+/g) || []).map(Number));
    if (nums.some((n) => n.length !== nums[0].length)) return false;
    const vary = nums[0].map((_, k) => k).filter((k) => nums.some((n) => n[k] !== nums[0][k]));
    if (vary.length !== 1) return false;
    const steps = nums.slice(1).map((n, j) => n[vary[0]] - nums[j][vary[0]]);
    return steps.every((d) => d === 1) || (pageForm(group[0]) && steps.every((d) => d === 2));
  };
  // Page-like apart; the last page may be short, so the final gap only has to be positive.
  const spaced = (group) => {
    const gaps = group.slice(1).map((l, j) => l.i - group[j].i), body = gaps.length > 2 ? gaps.slice(0, -1) : gaps;
    return gaps.every((g) => g > 0) && body.every((g) => g >= PAGE_MIN_GAP) && Math.max(...body) <= PAGE_GAP_RATIO * Math.min(...body);
  };
  const out = [];
  for (const [key, n] of counts) {
    if (n < HEADER_MIN_REPEATS || !/#/.test(key)) continue;
    const group = lines.filter((l) => l.key === key);
    if (looks(group[0]) && counter(group) && spaced(group)) out.push(...group.map((l) => ({ i: l.i, len: l.len })));
  }
  // A fixed header line ("LB1083   LB1083", "BILL AS INTRODUCED   H.341", "General Assembly Of North Carolina   Session 2025": the
  // same text on every page, no page number in it) is removed only when, besides recurring page-like apart and being short header
  // words (letters, digits, "#", ".", "-", "/"; at most HEADER_MAX_TOKENS of them; no sentence punctuation), EVERY copy sits within
  // PAGE_BLOCK characters of a page line found above. Without a confirmed page line next to it, a repeated line is left as printed.
  const confirmed = out.slice();
  // (the first page's header sits at the top of the text, before any page line: a copy within PAGE_BLOCK of the text's start counts)
  const nearPage = (l) => l.i <= PAGE_BLOCK || confirmed.some((p) => Math.abs(p.i - l.i) <= PAGE_BLOCK);
  for (const [key, n] of counts) {
    if (n < HEADER_MIN_REPEATS || !confirmed.length) continue;
    const group = lines.filter((l) => l.key === key);
    if (confirmed.some((p) => p.i === group[0].i)) continue;
    const toks = tokensIn(group[0].s);
    if (!toks.length || toks.length > HEADER_MAX_TOKENS || !toks.every((x) => HEADER_WORD.test(x)) || /[$%^§,;:]|\.$/.test(group[0].s)) continue;
    const same = (l) => l.s.replace(/\s+/g, ' ') === group[0].s.replace(/\s+/g, ' ');
    // the copy at either end of the text may have no page line beside it (the last page's footer, the first header after an unnumbered
    // page), provided every other copy has one and at least HEADER_MIN_REPEATS do
    const inner = group.filter((l, j) => (j > 0 && j < group.length - 1) || nearPage(l));
    const ends = group.length - inner.length;
    const besidePage = group.filter(nearPage).length >= HEADER_MIN_REPEATS && inner.every(nearPage) && ends <= 2;
    if (group.every(same) && spaced(group) && besidePage) out.push(...group.map((l) => ({ i: l.i, len: l.len })));
  }
  return out;
}
const PAGE_BLOCK = 300;
const HEADER_MAX_TOKENS = 10;
const HEADER_WORD = /^[A-Za-z0-9#][A-Za-z0-9#.\-/]*$/;
// The noise spans of a text: [{ i, len, kind }] in text order, never overlapping.
export function printingNoise(text) {
  const t = String(text || ''), spans = [];
  for (const p of pageLines(t)) spans.push({ ...p, kind: 'line' });
  for (const m of t.matchAll(MARKER)) spans.push({ i: m.index, len: m[0].length, kind: 'marker' });
  for (const m of t.matchAll(/�+/g)) { const a = t[m.index - 1] || '', b = t[m.index + m[0].length] || ''; if (!(/\d/.test(a) && /[\d[]/.test(b))) spans.push({ i: m.index, len: m[0].length, kind: 'replacement' }); }
  spans.sort((a, b) => a.i - b.i || b.len - a.len);
  // a span whose edge would cut a number in two is left in the text ("1234" never becomes "12")
  const splits = (p) => (/\d/.test(t[p.i - 1] || '') && /\d/.test(t[p.i])) || (/\d/.test(t[p.i + p.len - 1]) && /\d/.test(t[p.i + p.len] || ''));
  const out = [];
  for (const p of spans.filter((x) => !splits(x))) { const last = out[out.length - 1]; if (last && p.i < last.i + last.len) { last.len = Math.max(last.len, p.i + p.len - last.i); continue; } out.push({ ...p }); }
  return out;
}
// The text with its printing noise replaced by single spaces.
export function removePrintingNoise(text) {
  let t = String(text || '');
  const spans = printingNoise(t);
  for (let k = spans.length - 1; k >= 0; k--) { const p = spans[k]; t = t.slice(0, p.i) + ' ' + t.slice(p.i + p.len); }
  return t;
}

// ---------- the cleanup every reader sees ----------
// Puts back what printing lost, so the models, the reader and the quote checks all see the bill's own figures:
// - a lost superscript before a compute unit -> 10^N;
// - a power written in words before a compute unit -> 10^N (any exponent: the unit, not the value, says it is a compute figure);
// - a line number glued onto an amount -> removed and the amount ended, so it is never read as cents (only when it is in the run).
export function cleanText(s) {
  let t = String(s || '');
  const glued = detectNumbering(t).positions.filter((p) => p.glued);
  for (let k = glued.length - 1; k >= 0; k--) { const p = glued[k]; t = t.slice(0, p.i - 1) + '. ' + t.slice(p.i + p.len); } // "$500,000,000.8 " -> "$500,000,000.  "
  // With no run to test against (a text whose separate line numbers were dropped in extraction) a digit after an amount is left as
  // printed: a guess could turn "$1,000.5 million" into a wrong figure. A draft quoting such an amount is refused (checks GLUED_AMOUNT).
  return t.replace(new RegExp(LOST_EXPONENT.source, 'gi'), fixExponent)
    .replace(new RegExp(String.raw`${POWER_PHRASE}(?=\s+${COMPUTE_UNIT})`, 'gi'), (m, n) => { const v = parseNumberWords(n); return v == null ? m : `10^${v}`; });
}

// ---------- the text a model reads (new bills) ----------
// cleanText keeps every printed character a tracked entry's quotes may contain. The new-bills writer and reviewer read a cleaner copy,
// so a sentence reads as one sentence. Their quotes still match the bill: containsQuote's second try drops the same line numbers and
// printing noise from the source. Each rule is stated in terms of the printed form it repairs; none knows a state or a bill.
// - printed line numbers (a detectNumbering run: never a real figure) -> removed;
// - page headers and footers, converter markers, a stray "�" (printingNoise) -> removed;
// - an amended exponent before a compute unit, the deleted value in brackets and the inserted one after it ("10�[26] 25 operations",
//   "10 [26] 25 integer") -> 10^25, the inserted value. Brackets anywhere else are left as printed: the writer reports unclear markup;
// - a word hyphenated across a line break ("AI-\n   related") -> "AI-related": the line break is closed and the hyphen kept, since
//   dropping it could join a real compound. Not before "and", "or", "to" or "through" ("pre- and post-deployment").
// Spaces inside a line are collapsed; line breaks are kept, so sections still start on their own lines.
const AMENDED_EXPONENT = new RegExp(String.raw`\b10\s?[�ˆ^]?\s?\[\s?(\d{1,2})\s?\]\s?(\d{1,2})(?=\s+${COMPUTE_UNIT})`, 'gi');
export function readerText(s) {
  let t = cleanText(String(s || '').replace(/\r\n?/g, '\n').replace(/\f/g, '\n'));
  const nums = detectNumbering(t).positions.filter((p) => !p.glued);
  for (let k = nums.length - 1; k >= 0; k--) { const p = nums[k]; t = t.slice(0, p.i) + ' ' + t.slice(p.i + p.len); }
  t = t.replace(AMENDED_EXPONENT, (m, del, ins) => `10^${ins}`);
  t = removePrintingNoise(t);
  t = t.replace(/([A-Za-z])-[ \t]*\n\s*(?!(?:and|or|to|through)\b)([a-z])/g, '$1-$2');
  return t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- figures ----------
const SUP = { '²': '2', '³': '3', '¹': '1', '⁰': '0', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
// Every run of digits in a piece of text (commas removed, superscript digits read as digits), for the "numbers must come from the
// source" check. "10²⁶", "10^26" and GPO's "10\26\" all read as the runs 10 and 26, and a lost superscript as 10^N.
export function digitRuns(text) {
  const t = String(text || '').replace(/[²³¹⁰⁴-⁹]+/g, (m) => '^' + [...m].map((c) => SUP[c]).join('')).replace(/(\d)\\(\d{1,3})\\/g, '$1^$2')
    .replace(new RegExp(LOST_EXPONENT_IN_VALUE.source, 'gi'), fixExponent).replace(/(\d),(?=\d{3}\b)/g, '$1');
  return new Set(t.match(/\d+(?:\.\d+)?/g) || []);
}

// ---------- comparison forms ----------
// Quotes are compared after the same light normalisation on both sides: case, whitespace, curly quotes and dashes.
export const norm = (s) => String(s || '').toLowerCase().replace(/[‘’‛]/g, "'").replace(/[“”„]/g, '"').replace(/[‐-―−]/g, '-').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
// The second, looser form: also without hyphen spacing ("devel- oper", "floating - point").
export const looseForm = (s) => norm(s).replace(/\s*-\s*/g, '').replace(/\s+/g, ' ');

// The same loose form with, for every character, its index in the original text, so a match can be traced back to the printed span.
const mrep = (ms, re, rep) => {
  let s = '', at = 0; const m = [];
  for (const x of ms.s.matchAll(re)) {
    s += ms.s.slice(at, x.index); for (let k = at; k < x.index; k++) m.push(ms.m[k]);
    const r = typeof rep === 'function' ? rep(x[0]) : rep; s += r; for (let k = 0; k < r.length; k++) m.push(ms.m[x.index]);
    at = x.index + x[0].length;
  }
  s += ms.s.slice(at); for (let k = at; k < ms.s.length; k++) m.push(ms.m[k]);
  return { s, m };
};
// text with the given [{ i, len }] spans replaced by a space, then in loose form: { s, m } (m[k] = original index of s[k]).
export function mappedLoose(text, remove = []) {
  let s = '', at = 0; const m = [];
  for (const p of remove) { for (let k = at; k < p.i; k++) m.push(k); s += text.slice(at, p.i) + ' '; m.push(p.i); at = p.i + p.len; }
  for (let k = at; k < text.length; k++) m.push(k); s += text.slice(at);
  let ms = { s, m };
  const lower = ms.s.toLowerCase(); ms = lower.length === ms.s.length ? { s: lower, m: ms.m } : mrep(ms, /[^]/gu, (c) => c.toLowerCase());
  ms = mrep(ms, /[‘’‛]/g, "'"); ms = mrep(ms, /[“”„]/g, '"'); ms = mrep(ms, /[‐-―−]/g, '-'); ms = mrep(ms, / /g, ' ');
  ms = mrep(ms, /\s+/g, ' '); ms = mrep(ms, /^ | $/g, ''); ms = mrep(ms, /\s*-\s*/g, ''); ms = mrep(ms, /\s+/g, ' ');
  return ms;
}
