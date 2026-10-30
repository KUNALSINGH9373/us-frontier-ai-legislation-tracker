// Jurisdictions and bill numbers, read from config/jurisdictions.json (one table every news module uses). Code only, no AI.
//   jurisdiction(j)        the table's entry, or null
//   STATE_NAMES            code -> name, every jurisdiction (US included)
//   upperOf / lowerOf / unicameralBody / executiveOf / isUnicameral / namesExecutive / lawWordingAllowed
//   prefixOf(number, j)    "H.Con.Res. 5" -> HCONRES; prefixInfo(number, j) -> { prefix, chamber, kind, simple, skips_executive } or null
//   billKey / displayNumber  the number events are compared on / the number a card shows
//   billNumbersIn(s)       bill numbers written in a headline ([{ prefix, num }])
import fs from 'fs';

export const JURISDICTIONS_FILE = new URL('../config/jurisdictions.json', import.meta.url);
const TABLE = JSON.parse(fs.readFileSync(JURISDICTIONS_FILE, 'utf8'));
const J = TABLE.jurisdictions;

export const jurisdiction = (j) => J[j] || null;
export const JURISDICTION_CODES = Object.keys(J);
export const STATE_NAMES = Object.fromEntries(Object.entries(J).map(([c, e]) => [c, e.name]));
export const CHAMBER_LETTERS = TABLE.chamber_letters;
export const isUnicameral = (j) => !!(J[j] && J[j].unicameral);
export const unicameralBody = (j) => (J[j] && J[j].unicameral) || null;
export const upperOf = (j) => (J[j] && J[j].upper) || 'Senate';
export const lowerOf = (j) => (J[j] && J[j].lower) || 'House';
// Whether a card may name the executive and say "signed into law" (news_executive_wording false: the territories, review r6 #7).
export const namesExecutive = (j) => !(J[j] && J[j].news_executive_wording === false);
// Who acts on a passed measure, as a card names it (null where the card names none).
export const executiveOf = (j) => (namesExecutive(j) ? (J[j] && J[j].executive) || 'the Governor' : null);
// "Into law" wording allowed at all in this jurisdiction (law_wording false: the District of Columbia, review r4 #4).
export const lawWordingAllowed = (j) => !(J[j] && J[j].law_wording === false);
export const TERRITORIES = new Set(Object.entries(J).filter(([, e]) => e.type === 'territory').map(([c]) => c));

// The letters before a bill number's digits, upper case, without dots or spaces ("H.Con.Res. 5" -> HCONRES, "KS HR6023" -> HR, "CA ACA 1"
// -> ACA). The jurisdiction's own prefix ("CA SB 53", LegiScan) is dropped. null when there is no number.
const dropJurisdiction = (t, j) => (j && t.toUpperCase().startsWith(`${j} `) && /^[A-Z]{2} +[A-Za-z]/.test(t) ? t.slice(j.length + 1) : t);
export function prefixOf(number, j) {
  const t = dropJurisdiction(String(number || '').trim(), j);
  const m = /^\s*([A-Za-z][A-Za-z.\s]{0,12}?)\s*\.?\s*\d/.exec(t);
  return m ? m[1].replace(/[.\s]/g, '').toUpperCase() : null;
}
// What a prefix means in a jurisdiction: its own prefixes first, then the common state prefixes (unless default_prefixes is false).
// A prefix the table does not list: { prefix, chamber: null, kind: null }.
export function prefixInfo(number, j) {
  const p = prefixOf(number, j);
  if (!p) return null;
  const e = J[j] || {}, own = (e.prefixes || {})[p], def = e.default_prefixes === false ? null : TABLE.state_prefixes[p];
  const x = own || def;
  if (!x) return { prefix: p, chamber: null, kind: null, simple: false, skips_executive: false };
  return { prefix: p, chamber: x.chamber || null, kind: x.kind, simple: !!x.simple, skips_executive: x.skips_executive ?? x.kind !== 'bill' };
}
// The bill number events are compared on (review r5 M6): letters and digits only, the jurisdiction prefix and leading zeros dropped, a
// trailing print letter (NY "A6453B") dropped. null when there is none.
export function billKey(number, j) {
  const t = dropJurisdiction(String(number || '').trim(), j);
  if (!t) return null;
  const n = t.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]+)0+(?=\d)/, '$1').replace(/^([A-Z]+\d+)[A-Z]$/, '$1');
  return /^[A-Z]+\d+$/.test(n) ? n : null;
}
// A record's number as a card shows it: the jurisdiction prefix dropped and a space before the digits ("CA AB1405" -> "AB 1405"); any
// other spelling ("H.R. 3460", "S. 1405", "B 26-0123") is kept as the record gives it.
export function displayNumber(number, j) {
  const t = dropJurisdiction(String(number || '').trim(), j).trim();
  return /^[A-Z]+\d+[A-Z]?$/.test(t) ? t.replace(/^([A-Z]+)(\d)/, '$1 $2') : t;
}

// Federal bill and resolution prefixes ("HR", "S", "HRES", "HJRES", ...), from the table.
export const FEDERAL_PREFIXES = Object.keys((J.US && J.US.prefixes) || {});

// Bill numbers in a headline: "SB 530", "S. 2938", "A.B. 1018", "H.R. 1" -> [{ prefix, num }]; also "Senate Bill 530", "Assembly Bill 1018",
// "SB-530", "SB No. 530" (review r8 #5). The prefixes and spelled forms are the table's (headline_prefixes: "." = an optional full stop
// and space).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HEADLINE_BILL = new RegExp(`\\b(${[...Object.keys(TABLE.spelled_prefixes), ...TABLE.headline_prefixes.map((p) => p.split('.').map(esc).join('\\.?\\s?'))].join('|')})\\.?\\s?(?:-\\s?|no\\.\\s?)?(\\d{1,5})\\b`, 'gi');
export function billNumbersIn(s) {
  const out = [];
  for (const m of String(s || '').matchAll(HEADLINE_BILL)) out.push({ prefix: TABLE.spelled_prefixes[m[1].toLowerCase()] || m[1].toUpperCase().replace(/[.\s]/g, ''), num: String(+m[2]) });
  return out;
}
