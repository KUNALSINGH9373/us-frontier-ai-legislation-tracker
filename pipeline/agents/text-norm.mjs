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
// 10²⁶ printed without its superscript: "1026", "10.26", "10�26", "10ˆ26", and (before a strong unit only) "10,26" or "1,026" (a
// thousands comma added after the superscript was lost, PA H.B. 2800's form). Only an exponent of 20-29 right before a compute unit:
// no compute threshold is 10.26, 1026 or 1,026 operations, and a year or count elsewhere is never touched. Group 1 is the exponent.
// In a written value about thresholds (a draft field, a quote's figures) a count is not plausible, so there the comma forms need only
// a compute unit: lostExponent({ inValue: true }). One pattern, in two strengths.
export const lostExponent = ({ inValue = false } = {}) => {
  const u = inValue ? COMPUTE_UNIT : STRONG_UNIT;
  return new RegExp(String.raw`\b(?:10[�ˆ.]?|10,(?=2\d\s+${u})|1,0(?=2\d\s+${u}))(2\d)(?=\s+${COMPUTE_UNIT})`, 'gi');
};
export const LOST_EXPONENT = lostExponent();
export const LOST_EXPONENT_IN_VALUE = lostExponent({ inValue: true });
// Encoding debris a superscript leaves behind on its own.
export const ENCODING_DEBRIS = /[�ˆ]/;
// An amount with one stray digit after its point, in a written value ("$500,000,000.8"): a line number, since cents have two digits.
export const GLUED_AMOUNT = /\$\d{1,3}(?:,\d{3})+\.\d(?!\d)/;
const STRAY_AFTER_AMOUNT = /(\$\d{1,3}(?:,\d{3})+)\.\d(?=\s+["“A-Z(])/g;

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

// ---------- the cleanup every reader sees ----------
// Puts back what printing lost, so the models, the reader and the quote checks all see the bill's own figures:
// - a lost superscript before a compute unit -> 10^N;
// - a power written in words before a compute unit -> 10^N (any exponent: the unit, not the value, says it is a compute figure);
// - a line number glued onto an amount -> removed and the amount ended, so it is never read as cents (only when it is in the run).
export function cleanText(s) {
  let t = String(s || '');
  const found = detectNumbering(t).positions, glued = found.filter((p) => p.glued);
  for (let k = glued.length - 1; k >= 0; k--) { const p = glued[k]; t = t.slice(0, p.i - 1) + '. ' + t.slice(p.i + p.len); } // "$500,000,000.8 " -> "$500,000,000.  "
  // A text whose separate line numbers were dropped in extraction (IL H.B. 4705's LegiScan text keeps only the glued ones) has no run
  // to test against: there one digit after an amount, before a new sentence or definition, is removed (cents have two digits).
  if (!found.some((p) => p.format === 'line')) t = t.replace(STRAY_AFTER_AMOUNT, '$1. ');
  return t.replace(new RegExp(LOST_EXPONENT.source, 'gi'), '10^$1')
    .replace(new RegExp(String.raw`${POWER_PHRASE}(?=\s+${COMPUTE_UNIT})`, 'gi'), (m, n) => { const v = parseNumberWords(n); return v == null ? m : `10^${v}`; });
}

// ---------- figures ----------
const SUP = { '²': '2', '³': '3', '¹': '1', '⁰': '0', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
// Every run of digits in a piece of text (commas removed, superscript digits read as digits), for the "numbers must come from the
// source" check. "10²⁶", "10^26" and GPO's "10\26\" all read as the runs 10 and 26, and a lost superscript as 10^N.
export function digitRuns(text) {
  const t = String(text || '').replace(/[²³¹⁰⁴-⁹]+/g, (m) => '^' + [...m].map((c) => SUP[c]).join('')).replace(/(\d)\\(\d{1,3})\\/g, '$1^$2')
    .replace(new RegExp(LOST_EXPONENT_IN_VALUE.source, 'gi'), '10^$1').replace(/(\d),(?=\d{3}\b)/g, '$1');
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
