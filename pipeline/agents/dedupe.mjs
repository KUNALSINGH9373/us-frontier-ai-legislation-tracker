// Is a new item already in the tracker, under any name? Plain code, used before a new entry is created (publish/tier-b.mjs) and
// before any AI is spent on a candidate (agents/process-item.mjs). A match is never created: it is skipped or held.
// What counts as "already tracked":
//   - any record id an entry holds (Congress.gov, Federal Register, LegiScan), at any level (J and "none" entries included);
//   - a state bill number written anywhere in an entry (title, short name, status, mechanism, thresholds, events, sources), for the
//     entry's state, or for any state the entry names when it has none (J entries: "Texas TRAIGA (HB 149)", "NJ S 1802");
//   - LegiScan's own links between bills (sasts: same as, similar to, replaced by, crossfiled, carry over ...): a companion, an
//     other-chamber twin, an earlier session's version, or the bill an amendment was folded into;
//   - Congress.gov related bills marked "Identical bill" (raw.related_bills, when the grabber stored them);
//   - a state bill whose own text names a tracked bill of the same state ("If and only if Senate Bill 315 ... becomes law ... is amended").
import { billNumbersIn, normNumber } from '../grabber/sources/legiscan.mjs';

export const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico' };
const NAME_RE = new RegExp(`\\b(${Object.values(STATES).sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');
const CODE_RE = new RegExp(`(?<![A-Za-z.])(${Object.keys(STATES).join('|')})(?![A-Za-z])`, 'g');
const BY_NAME = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v, k]));

// The states an entry is about: its own, or every state its title and short name name.
export function statesOf(e) {
  if (e.state) return [e.state];
  if (e.level === 'federal') return [];
  const t = `${e.short_name || ''} ${e.title || ''}`, out = new Set();
  for (const m of t.matchAll(NAME_RE)) out.add(BY_NAME[m[1]]);
  for (const m of t.matchAll(CODE_RE)) out.add(m[1]);
  return [...out];
}

// Bill numbers in free text, in LegiScan's form ("SB189", "HB149", "S3228"): the grabber's reader, plus Colorado's year-numbered
// "SB 26-189" / "SB 24-205" and number ranges "SB 757–760".
export function numbersIn(text) {
  const t = String(text || ''), out = new Set(billNumbersIn(t));
  for (const m of t.matchAll(/(?<![A-Za-z.])([SH])\.?\s?B\.?\s?\d{2}-(\d{1,4})\b/g)) out.add(normNumber(`${m[1]}B${m[2]}`));
  // Nebraska's unicameral "L.B. 1083" / "LB 1083" (LegiScan "LB1083").
  for (const m of t.matchAll(/(?<![A-Za-z.])L\.?\s?B\.?\s?(\d{1,4})\b/g)) out.add(normNumber(`LB${m[1]}`));
  for (const m of t.matchAll(/(?<![A-Za-z.])([SHA])\.?\s?([BF])?\.?\s?(\d{1,5})\s?[–-]\s?(\d{1,5})\b/g)) {
    const a = +m[3], b = +m[4];
    if (b > a && b - a <= 20) for (let k = a; k <= b; k++) out.add(normNumber(`${m[1]}${m[2] || ''}${k}`));
  }
  // Round 3 (audit item 7): numbers written out ("Assembly Bill 1018", "Senate Bill No. 53", "House File 2412", "Senate File 1"), New York's
  // amendment letter ("S.6953B", "A 6453-A" -> S6953, A6453), Washington's substitute prefixes ("SSB 5001", "ESHB 1234", "E2SSB 5083" ->
  // SB5001, HB1234, SB5083) and Maine's Legislative Documents ("LD 1234", "L.D. 1234").
  for (const m of t.matchAll(/\b(Senate|House|Assembly)\s+(Bill|File)\s+(?:No\.?\s*)?(\d{1,5})\b/gi)) out.add(normNumber(`${m[1][0]}${m[2][0]}${m[3]}`));
  for (const m of t.matchAll(/(?<![A-Za-z.])([SA])\.?\s?(\d{1,5})-?[A-F]\b/g)) out.add(normNumber(`${m[1]}${m[2]}`));
  for (const m of t.matchAll(/(?<![A-Za-z.\d])(?:E2S|ESS|ES|2S|SS|E|S)([SH])B\s?(\d{1,5})\b/g)) out.add(normNumber(`${m[1]}B${m[2]}`));
  for (const m of t.matchAll(/(?<![A-Za-z.])L\.?\s?D\.?\s?(\d{1,5})\b/g)) out.add(normNumber(`LD${m[1]}`));
  return [...out].filter(Boolean);
}

// ---------- text similarity (round 3: companions, refiles and announced bills that share no number or link) ----------
const STOP = new Set('the a an and or of to in for on by with as at be is are this that any such its it from under shall may must not no which who than other each all into upon been has have'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[‐-―−]/g, '-').replace(/\b\d+\b/g, ' ').replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length > 1 && !STOP.has(w));
const shingles = (s, n) => { const w = words(s), out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' ')); return out; };
// Containment of the smaller shingle set in the larger (0..1): two texts that are the same bill (a companion, a refile under a new number)
// score near 1 whatever their numbers and headers; different bills on the same subject share few word runs.
export function similarity(a, b, n = 3) {
  const A = shingles(a, n), B = shingles(b, n);
  if (A.size < 8 || B.size < 8) return 0;
  const [s, l] = A.size <= B.size ? [A, B] : [B, A];
  let k = 0; for (const x of s) if (l.has(x)) k++;
  return k / s.size;
}
// A bill's text with everything a companion or refile changes removed (numbers, chamber words, whitespace), hashed: equal = the same text.
export const textKey = (text) => { const w = words(String(text || '').replace(/\b(?:house|senate|assembly|bill|file|act|no)\b/gi, ' ')).join(' '); return w.length >= 200 ? w : null; };
export const TEXT_SIMILAR = 0.85, PROSE_SIMILAR = 0.6, TITLE_SIMILAR = 0.7;
// "Artificial Intelligence" and "AI" are the same title word (round 4: a House companion "Artificial Intelligence Risk Evaluation Act").
const titleWords = (s) => new Set(words(String(s || '').replace(/\([^)]*\)/g, ' ').replace(/[—–-]\s*announced.*$/i, ' ').replace(/\bartificial\s+intelligence\b/gi, ' ai ').replace(/\bannounced\b|\bnot yet numbered\b|\bbill\b|\bact\b|\bof\s+20\d\d\b/gi, ' ')));
// Near-identical titles (round 4): shared words over the LARGER title's words, so a short title inside a long one does not count.
export function titleSameness(a, b) {
  const A = titleWords(a), B = titleWords(b);
  if (!A.size || !B.size) return { sim: 0, size: 0 };
  let k = 0; for (const x of A) if (B.has(x)) k++;
  return { sim: k / Math.max(A.size, B.size), size: Math.min(A.size, B.size) };
}
export const SAME_TITLE = 0.8;
export function titleSimilarity(a, b) {
  const A = titleWords(a), B = titleWords(b);
  if (!A.size || !B.size) return 0;
  let k = 0; for (const x of A) if (B.has(x)) k++;
  return k / Math.min(A.size, B.size) * (Math.min(A.size, B.size) >= 2 ? 1 : 0.5);
}
// Last names in a sponsor line ("Sens. Josh Hawley (R-MO), Chris Murphy (D-CT)", "Rep. Gabe Evans (R-CO)") or a Congress record.
export function sponsorNames(x) {
  if (Array.isArray(x)) return new Set(x.map((s) => String(s.lastName || String(s.fullName || '').replace(/^\w+\.\s*/, '').split(',')[0] || '').toLowerCase().trim()).filter(Boolean));
  const t = String(x || '').replace(/\([^)]*\)/g, ' ').replace(/\b(?:Sens?|Reps?|Del|Rep|Sen)\.\s*/g, ' ');
  return new Set(t.split(/,|\band\b|\bwith\b|[–—/;]/).map((p) => p.trim().split(/\s+/).filter((w) => /^[A-Z][a-zA-Z'’-]+$/.test(w)).pop()).filter(Boolean).map((w) => w.toLowerCase()));
}

const entryText = (e) => [e.title, e.short_name, e.status_text, e.mechanism, e.thresholds, e.signed_text, e.effective_text,
  ...(e.events || []).map((v) => v.text), ...(e.sources || []).map((s) => `${s.label || ''} ${s.url || ''}`)].filter(Boolean).join(' \n ');
// Every "ST:NUMBER" an entry covers.
export const stateNumbersOf = (e) => { const st = statesOf(e); if (!st.length) return []; const ns = numbersIn(entryText(e)); return st.flatMap((s) => ns.map((n) => `${s}:${n}`)); };
// Every record an entry is tracked by, in the item_id form the grabber uses.
export const idsOf = (e) => { const x = (e.identifiers && e.identifiers.external) || {}; return [...(x.congress_gov || []).map((i) => 'congress_gov:' + i), ...(x.federal_register_doc ? ['federal_register:' + x.federal_register_doc] : []), ...(x.legiscan || []).map((i) => 'legiscan:' + i)]; };

// An index of the tracker, built once per run: { ids, numbers: Map("ST:NUM" -> entry key) }.
// The years an entry's bill was alive (its events and its session name), or null when it states none.
export function yearsOf(e) {
  const ys = [...(e.events || []).map((v) => +String(v.date || '').slice(0, 4)), ...[...String((e.identifiers && e.identifiers.session) || '').matchAll(/\b(20\d\d)\b/g)].map((m) => +m[1])].filter((y) => y > 1990);
  return ys.length ? { from: Math.min(...ys), to: Math.max(...ys) } : null;
}
// Round 4: "Senate Bill 6953" reads as SB6953, but New York, New Jersey, Massachusetts and Rhode Island number their bills S6953, A8833,
// H5224 (no B). Each state number is indexed in both forms, so an entry that writes the number out still matches the LegiScan record.
export const numberAliases = (key) => { const m = /^([A-Z]{2}):([SHA])(B?)(\d+)$/.exec(key); return m ? [key, `${m[1]}:${m[2]}${m[3] ? '' : 'B'}${m[4]}`] : [key]; };
export function trackerIndex(entries, tracked = []) {
  const ids = new Map(), numbers = new Map(), byNumber = new Map(), all = [];
  const put = (e) => { all.push(e); idsOf(e).forEach((i) => ids.set(i, e.key)); stateNumbersOf(e).flatMap(numberAliases).forEach((n) => { numbers.has(n) || numbers.set(n, e.key); const l = byNumber.get(n) || byNumber.set(n, []).get(n); l.includes(e) || l.push(e); }); };
  entries.forEach(put);
  tracked.forEach((i) => ids.has(i) || ids.set(i, '(tracked list)'));
  return { ids, numbers, byNumber, entries: all, add: put };
}

// A bill number is reused every session: a tracked "CA SB 53" (2025) does not make a 2027 "SB 53" a duplicate. A number match counts
// only when the sessions overlap, the tracked entry states no years (it cannot be told apart, so it is held), or the titles match.
function sameSessionMatch(idx, key, b) {
  const list = (idx.byNumber && idx.byNumber.get(key)) || [];
  if (!list.length) return idx.numbers.has(key) ? idx.numbers.get(key) : null;
  const s = b.session || {}, from = +s.year_start || null, to = +s.year_end || from;
  for (const e of list) {
    const y = yearsOf(e);
    if (!from || !y || (y.from <= to && y.to >= from) || titleSimilarity(b.title, e.title) >= TITLE_SIMILAR) return e.key;
  }
  return null;
}

// "Senate Bill 315", "House Bill No. 1234", "Assembly Bill 12" in a bill's text -> "SB315", ...
const TEXT_BILL_RE = /\b(Senate|House|Assembly)\s+Bill\s+(?:No\.?\s*)?(\d{1,5})\b/g;
const CHAMBER = { Senate: 'S', House: 'H', Assembly: 'A' };
function textBillNumbers(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(TEXT_BILL_RE)) { out.add(`${CHAMBER[m[1]]}B${m[2]}`); out.add(`${CHAMBER[m[1]]}${m[2]}`); }
  return [...out];
}

// { key, why } for the tracked entry this item duplicates, or null. idx: trackerIndex(entries, tracked).
export function duplicateOf({ item, raw = {}, idx }) {
  if (idx.ids.has(item.item_id)) return { key: idx.ids.get(item.item_id), why: `already tracked (record ${item.item_id})` };
  if (item.source === 'legiscan' && raw.bill) {
    const b = raw.bill, st = b.state, own = normNumber(b.bill_number);
    const ownKey = own ? sameSessionMatch(idx, `${st}:${own}`, b) : null;
    if (ownKey) return { key: ownKey, why: `already tracked (an entry covers ${st} ${own})` };
    for (const s of b.sasts || []) {
      const n = normNumber(s.sast_bill_number);
      if (s.sast_bill_id && idx.ids.has('legiscan:' + s.sast_bill_id)) return { key: idx.ids.get('legiscan:' + s.sast_bill_id), why: `LegiScan links it to a tracked bill (${s.type || 'related'} ${s.sast_bill_number})` };
      if (n && idx.numbers.has(`${st}:${n}`)) return { key: idx.numbers.get(`${st}:${n}`), why: `LegiScan links it to a tracked bill (${s.type || 'related'} ${st} ${n})` };
    }
    // Its history points at another bill ("See S3178", "Substituted by HB 12"): an amendment or substitute folded into that bill.
    for (const h of b.history || []) for (const n of numbersIn(h.action)) if (n !== own && idx.numbers.has(`${st}:${n}`) && /\b(see|substitut|replaced|amend|companion|identical|similar)/i.test(h.action)) return { key: idx.numbers.get(`${st}:${n}`), why: `its history points at a tracked bill ("${h.action}")` };
    // Its own text names a tracked bill of the same state (an amendment to it, or a bill that depends on it becoming law).
    for (const n of [...textBillNumbers(raw.text), ...numbersIn(String(raw.text || '').slice(0, 3000))]) if (n !== own && !numberAliases(`${st}:${n}`).includes(`${st}:${own}`) && idx.numbers.has(`${st}:${normNumber(n)}`)) return { key: idx.numbers.get(`${st}:${normNumber(n)}`), why: `its text names a tracked bill (${st} ${normNumber(n)}); it may amend it or depend on it` };
    // Round 4: a companion or refile with no LegiScan link and another number: the same official title as a tracked entry of the same
    // state, in an overlapping session (or an entry that states no years). Possible duplicate, never created, reported.
    const s = b.session || {}, from = +s.year_start || null, to = +s.year_end || from;
    for (const e of idx.entries || []) {
      if (e.level === 'federal' || !statesOf(e).includes(st)) continue;
      const parts = String(e.title || '').split(' — '), official = parts.length > 1 ? parts.slice(1).join(' — ') : parts[0];
      const ts = [official, e.short_name].map((x) => titleSameness(b.title, x)).sort((x, y) => y.sim - x.sim)[0];
      const y = yearsOf(e);
      if (ts.sim >= SAME_TITLE && ts.size >= 4 && (!from || !y || (y.from <= to && y.to >= from))) return { key: e.key, possible: true, why: `its title is the same as tracked entry "${String(e.short_name || e.title).slice(0, 80)}" (${Math.round(ts.sim * 100)}% of the words), in an overlapping session: a companion or refile under another number? possible duplicate or update of that entry` };
    }
  }
  if (item.source === 'congress_gov') {
    const rel = raw.related_bills || raw.relatedBills?.relatedBills || [];
    for (const r of rel) {
      const identical = (r.relationshipDetails || []).some((d) => /identical/i.test(d.type || ''));
      const id = `congress_gov:${r.congress}/${String(r.type || '').toLowerCase()}/${r.number}`;
      if (identical && idx.ids.has(id)) return { key: idx.ids.get(id), why: `Congress.gov lists it as identical to a tracked bill (${id.slice(13)})` };
    }
    // Any other relationship to a tracked bill (a "Related bill", a procedurally-related one): it may be a new version of that bill or
    // belong on its entry, which code cannot tell; it is never created, and is reported as a possible update of that entry.
    for (const r of rel) {
      const id = `congress_gov:${r.congress}/${String(r.type || '').toLowerCase()}/${r.number}`;
      if (idx.ids.has(id)) return { key: idx.ids.get(id), possible: true, why: `Congress.gov relates it to a tracked bill (${id.slice(13)}: ${(r.relationshipDetails || []).map((d) => d.type).filter(Boolean).join(', ') || 'related'}); possible duplicate or update of that entry` };
    }
    // Round 3 (audit item 7): a federal entry written by hand, often before the bill had a number ("AI Agent Accountability Act
    // (Hawley–Murphy) — announced, not yet numbered"), carries no record id. The new bill's title or short title AND a sponsor shared with
    // that entry make it a possible duplicate or the numbered version of that entry: never created, reported.
    const f = federalNameMatch({ item, raw, entries: idx.entries || [] });
    if (f) return f;
  }
  return null;
}

// The titles a Congress record goes by: its title, the item's title and every short title stored.
const congressTitles = (item, raw) => [item.title, raw.bill && raw.bill.title, ...([raw.titles, raw.bill && raw.bill.titles].find(Array.isArray) || []).map((t) => (t && (t.title || t)) || '')].filter((t) => typeof t === 'string' && t);
export function federalNameMatch({ item, raw = {}, entries = [] }) {
  const titles = congressTitles(item, raw), mine = sponsorNames([...(raw.bill && raw.bill.sponsors) || [], ...(raw.cosponsors || [])]);
  if (!titles.length) return null;
  for (const e of entries) {
    if (e.level !== 'federal' || !['D', 'F', 'G.3'].includes(e.section)) continue;
    const names = [e.short_name, String(e.title || '').split(' — ').slice(-1)[0], e.title].filter(Boolean);
    // Round 4: a companion in the other chamber has other sponsors, and Congress.gov often links it days later: a near-identical title
    // alone (3+ distinctive words) makes it a possible duplicate of the tracked bill.
    const same = titles.flatMap((a) => names.map((b) => titleSameness(a, b))).filter((x) => x.size >= 3).sort((x, y) => y.sim - x.sim)[0];
    if (same && same.sim >= SAME_TITLE) return { key: e.key, possible: true, why: `its title is the same as tracked entry "${String(e.short_name || e.title).slice(0, 80)}" (${Math.round(same.sim * 100)}% of the words): a companion in the other chamber or a reintroduction? possible duplicate of that entry` };
    if (!mine.size) continue;
    const t = Math.max(...titles.flatMap((a) => names.map((b) => titleSimilarity(a, b))));
    const shared = [...sponsorNames(e.sponsor_text)].filter((n) => mine.has(n));
    // An announced bill described in words ("U.S.–China frontier-AI safety coordination bill") rarely shares its future title: a shared
    // sponsor and a weaker title match count for an entry with no Congress record yet.
    const announced = !(idsOf(e).length) || /\bannounced\b/i.test(e.title || '');
    if (shared.length && (t >= TITLE_SIMILAR || (announced && t >= 0.4))) return { key: e.key, possible: true, why: `its title matches tracked entry "${String(e.short_name || e.title).slice(0, 80)}" (sponsor ${shared.join(', ')} on both); possible duplicate or the numbered version of that entry` };
  }
  return null;
}

// ---------- the same bill in one run, or refiled ----------
// Two drafts in one run that are companions (House and Senate twins) or the same text filed twice: the second is never created. Same
// text once numbers and chamber words are removed, or texts that are nearly all the same word runs.
export function companionOf(raw, seen = []) {
  const text = String(raw && raw.text || ''), k = textKey(text);
  for (const s of seen) {
    if (k && s.textKey && k === s.textKey) return { key: s.key, why: `its text is the same as ${s.label}, added in this run (a companion or refile)` };
    const sim = text && s.text ? similarity(text, s.text, 5) : 0;
    if (sim >= TEXT_SIMILAR) return { key: s.key, why: `its text is ${Math.round(sim * 100)}% the same as ${s.label}, added in this run (a companion or refile)` };
  }
  return null;
}
// A new entry whose own prose (title, mechanism, thresholds) is nearly the same as a tracked entry of the same state, or of the federal
// level: a refile under a new number in a later session, with no LegiScan link. Held and reported as a possible duplicate or update.
export function refileOf(draft, entries = []) {
  if (!draft) return null;
  const mine = entryProse(draft), st = draft.state;
  let best = null;
  for (const e of entries) {
    if (e.key === draft.key) continue;
    if (st ? !statesOf(e).includes(st) : e.level !== 'federal') continue;
    const sim = similarity(mine, entryProse(e));
    if (sim >= PROSE_SIMILAR && (!best || sim > best.sim)) best = { key: e.key, sim };
  }
  return best ? { key: best.key, possible: true, why: `its description is ${Math.round(best.sim * 100)}% the same as a tracked entry's (a refile or companion under another number?): possible duplicate or update of that entry` } : null;
}

// A Congress bill with related bills that were not read: an identical tracked bill cannot be ruled out, so it is not created.
export function relatedUnread(item, raw = {}) {
  if (item.source !== 'congress_gov') return null;
  const n = Number(raw.bill && raw.bill.relatedBills && raw.bill.relatedBills.count) || 0;
  const list = raw.related_bills || (raw.relatedBills && raw.relatedBills.relatedBills);
  // Round 3: a stored list shorter than the count (an empty or cut-off fetch) is as good as unread.
  if (n > 0 && !Array.isArray(list)) return `Congress.gov lists ${n} related bill(s) that were not read, so an identical tracked bill cannot be ruled out`;
  if (n > 0 && list.length < n) return `Congress.gov lists ${n} related bill(s) but only ${list.length} were read, so an identical tracked bill cannot be ruled out`;
  return null;
}

// ---------- the same programme under another bill ----------
// A state can re-enact a programme the tracker already has in a different act (CT H.B. 5222 re-enacted the independent-verification pilot
// of P.A. 26-15, Sec. 47 vs Sec. 33), and a hand-written entry often carries no record id or bill number for it. So a new state entry is
// also compared with every entry of its state by what the programme IS: the agencies it names (by name or initials, "Department of
// Consumer Protection" = "DCP"), distinctive programme terms (independent verification organizations, a pilot, a regulatory sandbox, AI
// auditor licensing, the injury-or-property-damage evidence rule) and a quoted act name. Generic frontier words (developer, model, Attorney
// General) never count. A strong overlap is never created: it is held and reported as a possible duplicate or update of that entry.
const PROGRAMME = {
  'independent verification organizations': /\bindependent verification organi[sz]ations?\b|\bIVOs?\b/i,
  'a pilot program': /\bpilot\b/i,
  'a regulatory sandbox': /\bregulatory sandbox(?:es)?\b|\bAI sandbox\b/i,
  'AI auditor licensing': /\b(?:AI|artificial intelligence) auditors?\b|\bauditor licen[cs]/i,
  'the injury-or-property-damage evidence rule': /\binjury\W+or\W+property\W+damage\b/i,
  'an AI safety institute or office': /\b(?:AI|artificial intelligence) (?:safety )?(?:institute|office)\b/i
};
const AGENCY = /\b(?:Department|Office|Commission|Board|Bureau|Division|Agency|Authority|Council|Institute)\s+(?:of|for|on)\s+(?:the\s+)?[A-Z][a-z]+(?:(?:\s+(?:and|of|for|on|the))*\s+[A-Z][a-z]+){0,5}/g;
const ACT_NAME = /[“"]([A-Z][^”"]{3,80}?\bAct)[”"]/g;
const initials = (name) => name.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join('');
const agenciesIn = (t) => [...new Set([...String(t || '').matchAll(AGENCY)].map((m) => m[0].replace(/\s+/g, ' ').trim()))];
export function programmeTerms(text) {
  const t = String(text || '');
  return { concepts: Object.keys(PROGRAMME).filter((k) => PROGRAMME[k].test(t)), agencies: agenciesIn(t), acts: [...new Set([...t.matchAll(ACT_NAME)].map((m) => m[1].toLowerCase()))] };
}
const entryProse = (e) => [e.title, e.short_name, e.mechanism, e.thresholds].filter(Boolean).join(' \n ');
// What two texts share: { score, shared: [readable terms] }. An agency counts when the other text names it or its initials (3+ letters).
export function programmeOverlap(a, b) {
  const A = programmeTerms(a), B = programmeTerms(b), tb = String(b || ''), ta = String(a || '');
  const shared = [], has = (t, name) => t.includes(name) || (initials(name).length >= 3 && new RegExp(`\\b${initials(name)}\\b`).test(t));
  A.concepts.filter((c) => B.concepts.includes(c)).forEach((c) => shared.push({ kind: 'programme', term: c }));
  const ag = new Set([...A.agencies.filter((x) => has(tb, x)), ...B.agencies.filter((x) => has(ta, x))].map((x) => initials(x)));
  ag.forEach((x) => shared.push({ kind: 'agency', term: [...A.agencies, ...B.agencies].find((n) => initials(n) === x) }));
  A.acts.filter((x) => B.acts.includes(x)).forEach((x) => shared.push({ kind: 'act', term: x }));
  const score = shared.reduce((s, x) => s + (x.kind === 'act' ? 2 : 1), 0);
  return { score, shared };
}
export const PROGRAMME_BAR = 3;
// { key, why, possible: true } for the tracked entry of the same state whose programme a new state entry matches, or null.
// draft: the assembled entry (title, mechanism, thresholds, state). A match needs PROGRAMME_BAR points with at least one programme term or
// act name shared (agencies alone are not a programme).
export function programmeDuplicateOf(draft, entries = []) {
  const st = draft && draft.state; if (!st) return null;
  const mine = entryProse(draft);
  let best = null;
  for (const e of entries) {
    if (e.key === draft.key || !statesOf(e).includes(st)) continue;
    const o = programmeOverlap(mine, entryProse(e));
    if (o.score < PROGRAMME_BAR || !o.shared.some((x) => x.kind !== 'agency')) continue;
    if (!best || o.score > best.score) best = { key: e.key, score: o.score, shared: o.shared };
  }
  return best ? { key: best.key, possible: true, why: `the same ${st} programme as a tracked entry (shares ${best.shared.map((x) => x.term).join(', ')}): possible duplicate or update of that entry` } : null;
}
