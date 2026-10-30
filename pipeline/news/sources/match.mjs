// Entry matching for the news source adapters. Code only, never AI: a raw item gets a tracker entry id (the entry's `key`) only when
// a bill number, an executive-order number or an official title/alias names exactly one tracked entry in a compatible jurisdiction.
//   buildIndex(entries)                         -> index (entries = web/data/v2/entries.json array or { entries })
//   normBill(text, jurisdiction)                -> 'SB53' | 'HR9925' | 'A6453' ... | null  (one token)
//   billTokens(text, jurisdiction)              -> ['S2938', ...] every bill number written in the text
//   matchBill(index, { jurisdiction, type, number, congress })  -> entry key | null (structured fields from an API)
//   matchNumbers(index, text, jurisdiction)     -> entry key | null (bill / EO numbers written in text; ambiguous -> null)
//   matchTitle(index, text, jurisdiction)       -> entry key | null (official short titles and aliases, whole phrase)
//   matchText(index, text, jurisdiction)        -> { entry_id, by: 'number'|'title'|null }
// Near misses never match: "SB 53" is not "SB 530", "S. 29" is not "S. 2938", "U.S. 2938" is not a bill.

const STATE_NAMES = { california: 'CA', 'new york': 'NY', illinois: 'IL', massachusetts: 'MA', michigan: 'MI', 'new jersey': 'NJ', tennessee: 'TN', utah: 'UT', louisiana: 'LA', 'rhode island': 'RI', pennsylvania: 'PA', minnesota: 'MN', ohio: 'OH', virginia: 'VA', connecticut: 'CT', colorado: 'CO', texas: 'TX', washington: 'WA' };

export function jurOf(e) {
  const j = String(e.jurisdiction || e.state || '').trim();
  if (/^(US|Federal)$/i.test(j) || e.level === 'federal') return 'US';
  if (/^[A-Z]{2}$/.test(j)) return j;
  return null;
}

// Canonical chamber prefixes. Federal: S, HR, SRES, HRES, SJRES, HJRES, SCONRES, HCONRES. States: SB (S. = S.B.), HB (H. = H.B.),
// AB (A. = A.B., New York's Assembly), HF, SF, HR (state House resolution), SR, plus HJR/SJR.
const PREFIX = String.raw`(H\.?\s?R\.?\s?E\.?S\.?|S\.?\s?R\.?\s?E\.?S\.?|H\.?\s?J\.?\s?R\.?\s?E\.?S\.?|S\.?\s?J\.?\s?R\.?\s?E\.?S\.?|H\.?\s?Con\.?\s?Res\.?|S\.?\s?Con\.?\s?Res\.?|H\.?\s?Res\.?|S\.?\s?Res\.?|H\.?\s?J\.?\s?Res\.?|S\.?\s?J\.?\s?Res\.?|H\.?\s?R\.?|S\.?\s?B\.?|A\.?\s?B\.?|H\.?\s?B\.?|H\.?\s?F\.?|S\.?\s?F\.?|S\.?|A\.?|H\.?)`;
// Not preceded by a letter, a dot or a digit ("U.S. 2938", "USA 12" never match); the number is not followed by another digit or a
// decimal point ("SB 53" never matches "SB 530" or "SB 53.5"). Prefix letters must be upper case except the "Res"/"Con" words.
const TOKEN_RE = new RegExp(String.raw`(?<![A-Za-z.\d])` + PREFIX + String.raw`\s?(?:No\.\s?)?0*(\d{1,5})(?![\d]|\.\d)`, 'g');

function canonPrefix(raw, jur) {
  const p = raw.replace(/[.\s]/g, '').toUpperCase();
  const fed = jur === 'US';
  const map = { HRES: 'HRES', SRES: 'SRES', HJRES: 'HJRES', SJRES: 'SJRES', HCONRES: 'HCONRES', SCONRES: 'SCONRES' };
  if (map[p]) return map[p];
  if (fed) return { HR: 'HR', S: 'S' }[p] || null;               // federal bills are only H.R. and S.
  return { S: 'SB', SB: 'SB', H: 'HB', HB: 'HB', A: 'AB', AB: 'AB', HF: 'HF', SF: 'SF', HR: 'HR' }[p] || null;
}

// All bill tokens in a text. Upper-case letters are required for the chamber part (so "a 5" or "s 12" in prose never count).
export function billTokens(text, jur) {
  const out = [];
  const s = String(text || '');
  for (const m of s.matchAll(TOKEN_RE)) {
    const letters = m[1].replace(/[.\s]/g, '');
    // A bare single letter followed by a space needs a number of 3+ digits ("S. 5" is a section reference far more often than a bill).
    if (letters.length === 1 && /\s/.test(m[0]) && String(+m[2]).length < 3) continue;
    const pre = canonPrefix(m[1], jur);
    if (pre) out.push(pre + String(+m[2]));
  }
  return [...new Set(out)];
}

export function normBill(text, jur) { const t = billTokens(text, jur); return t.length === 1 ? t[0] : null; }

const EO_RE = /(?<![A-Za-z\d])(?:E\.?O\.?|Executive Order(?: No\.)?)\s?(1\d{4})(?!\d)/g;
export const eoTokens = (text) => [...new Set([...String(text || '').matchAll(EO_RE)].map((m) => 'EO' + m[1]))];

const GENERIC = /^(public act|an act|a bill|resolution|the act|ai act|artificial intelligence act)\b/i;
const cleanPhrase = (s) => String(s || '').toLowerCase().replace(/[“”"']/g, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

export function buildIndex(entriesIn) {
  const entries = Array.isArray(entriesIn) ? entriesIn : (entriesIn?.entries || []);
  const bills = new Map(), eos = new Map(), phrases = new Map();
  const add = (map, k, key) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(key); };
  for (const e of entries) {
    if (!e || !e.key || e.type === 'excluded') continue;
    const jur = jurOf(e);
    if (!jur) continue;
    const head = String(e.title || '').split(/\s+—\s+/)[0];
    // Bill numbers: the title's head (before the dash), the short name, and congress.gov ids.
    const sources = [String(e.title || ''), String(e.short_name || '').replace(/\(.*?\)/g, ' ')];
    for (const t of sources) for (const b of billTokens(t, jur)) add(bills, `${jur}|${b}`, e.key);
    const ids = e.identifiers?.external?.congress_gov || [];
    for (const id of ids) { const m = /^(\d+)\/(hr|s|hres|sres|hjres|sjres)\/(\d+)$/i.exec(id); if (m) add(bills, `US|${m[2].toUpperCase()}${+m[3]}`, e.key); }
    for (const t of [head, e.short_name]) for (const x of eoTokens(String(t || '').replace(/\(.*?\)/g, ' '))) add(eos, x, e.key);
    // Official titles: the part after the dash, without parentheticals; also without "of 2025".
    const tail = String(e.title || '').split(/\s+—\s+/).slice(1).join(' — ');
    const cands = [];
    for (const t of [tail, String(e.title || '').split(/\s+—\s+/)[0]]) {
      const base = t.replace(/\(.*?\)/g, ' ').replace(/\s+-\s+.*$/, '');
      for (const part of base.split(/\s*[;,]\s*|\s+\/\s+/)) cands.push(part);
    }
    for (const p0 of cands) {
      const p = cleanPhrase(p0).replace(/\s+(discussion draft|proposal|announced|and other)\b.*$/, '').replace(/^titled (the )?/, '');
      // An executive order's quoted official title counts as a title too ("Inaugurating the Era of Super Intelligence").
      const eoTitle = jur === 'US' && eoTokens(head.replace(/\(.*?\)/g, ' ')).length > 0 && p0 !== head;
      if (p.length < 15 || GENERIC.test(p) || !(/\bact\b/.test(p) || eoTitle) || billTokens(p0, jur).length || eoTokens(p0).length) continue;
      add(phrases, `${jur}|${p}`, e.key);
      const noYear = p.replace(/\s+of\s+20\d\d$/, '');
      if (noYear !== p && noYear.length >= 15) add(phrases, `${jur}|${noYear}`, e.key);
    }
  }
  return { bills, eos, phrases, entries };
}

const one = (sets) => { const all = new Set(); for (const s of sets) for (const k of s) all.add(k); return all.size === 1 ? [...all][0] : null; };
const jurOk = (jur) => /^[A-Z]{2}$/.test(String(jur || ''));

export function matchBill(index, { jurisdiction, type, number, congress } = {}) {
  if (!jurOk(jurisdiction) || number == null) return null;
  if (jurisdiction === 'US' && congress != null && +congress !== 119) return null;   // tracked federal bills are 119th Congress
  const tok = normBill(`${String(type || '').toUpperCase()} ${number}`, jurisdiction) || normBill(`${type}${number}`, jurisdiction);
  if (!tok) return null;
  const s = index.bills.get(`${jurisdiction}|${tok}`);
  return s && s.size === 1 ? [...s][0] : null;
}

export function matchNumbers(index, text, jurisdiction) {
  if (!jurOk(jurisdiction)) return null;
  const hits = [];
  for (const b of billTokens(text, jurisdiction)) { const s = index.bills.get(`${jurisdiction}|${b}`); if (s) hits.push(s); }
  if (jurisdiction === 'US') for (const x of eoTokens(text)) { const s = index.eos.get(x); if (s) hits.push(s); }
  return hits.length ? one(hits) : null;
}

export function matchTitle(index, text, jurisdiction) {
  if (!jurOk(jurisdiction)) return null;
  const t = ' ' + cleanPhrase(text).replace(/[^a-z0-9\- ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  const hits = [];
  for (const [k, s] of index.phrases) {
    const [j, p] = [k.slice(0, 2), k.slice(3)];
    if (j !== jurisdiction) continue;
    const pp = p.replace(/[^a-z0-9\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.includes(' ' + pp + ' ')) hits.push(s);
  }
  return hits.length ? one(hits) : null;
}

export function matchText(index, text, jurisdiction) {
  const n = matchNumbers(index, text, jurisdiction);
  if (n) return { entry_id: n, by: 'number' };
  // A text naming several different numbered bills, none tracked, is not matched on a title either when numbers conflict.
  const t = matchTitle(index, text, jurisdiction);
  return t ? { entry_id: t, by: 'title' } : { entry_id: null, by: null };
}
