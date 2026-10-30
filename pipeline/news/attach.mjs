// Statement attachment (news/CONTRACT.md: press releases only attach to an existing event). Pure functions.
// A statement RawItem (facts.role === 'statement') attaches to an event only when ALL hold:
//   - entry_id equal (code-matched upstream) and the title names no other bill number of the same kind (SB 530 is not SB 53)
//   - statement date is 0..+3 days after the event date
//   - the event class is compatible with the headline keywords (KEYWORDS), or the headline has no keyword at all -> not attached
// Otherwise it goes to the entry's timeline list (entry known, no event) or to the Telegram leads (no entry).
// Before any of that: verbatim title as plain text, allowlisted host, and exact duplicates (canonical URL or content hash) removed.
import crypto from 'crypto';
import { plain } from './sources/common.mjs';
import { billNumbersIn } from './jurisdictions.mjs';
import { KEYWORDS, NOT_A_REPORT, CHAMBER_COMMITTEE } from './lexicon.mjs';

// Headline keywords (KEYWORDS) and headlines that are not a report (NOT_A_REPORT): config/news-lexicon.json, through news/lexicon.mjs.
export { KEYWORDS, NOT_A_REPORT };

// quote: true when checking a fragment the AI quoted (its subject may sit outside the quote; the whole headline is checked too)
export function compatibleClasses(title, { quote = false } = {}) {
  const out = new Set();
  if (NOT_A_REPORT.test(title)) return out;
  for (const [re, cls] of KEYWORDS) if (re.test(title)) cls.forEach((c) => out.add(c));
  // "passes"/"approves" without "committee" is a floor outcome: never a committee passage (review r8 M1)
  const COMMITTEE = /\b(sub)?committees?\b|\bpanels?\b/i;
  if (!COMMITTEE.test(title)) out.delete('committee-passage');
  // A committee passage headline is not the floor passage, but only when the committee is the one passing ("Senate panel advances AI
  // bill", "bill clears committee"). A headline that only mentions a committee ("Lawmakers pass bill after committee fight") could be
  // either: no passage class at all (review r9 #3).
  const PASS = /\b(pass(es|ed)?|approv(es|ed)|advanc(es|ed)|clear(s|ed))\b/i;
  if (COMMITTEE.test(title) && PASS.test(title)) {
    ['passage', 'concurrence', 'veto-override-passage', 'committee-passage'].forEach((c) => out.delete(c));
    // a chamber passing too ("House passes bill cleared by committee last week"): it reports the floor vote, not the committee's (r9 A1)
    const chamberPasses = /\b(house|senate|assembly|legislature|lawmakers|chamber)\s+(pass(es|ed)?|approv(es|ed)|clear(s|ed)|advanc(es|ed))\b/i.test(title);
    if (!chamberPasses && /\b(sub)?committees?\s+(\w+\s+){0,2}?(pass(es|ed)?|approv(es|ed)|advanc(es|ed)|clear(s|ed))\b|\b(clear(s|ed)|out of|advanc(es|ed) (from|out of)|pass(es|ed) (in|out of)|approv(es|ed) (in|by)) (the |a |its |\w+ )?(sub)?committee\b|\bpanels?\s+(\w+\s+){0,2}?(pass(es|ed)?|approv(es|ed)|advanc(es|ed)|clear(s|ed))\b/i.test(title)) out.add('committee-passage');
  }
  out.delete('hearing-scheduled'); // a scheduled hearing has no card (review r8)
  // A signature is the governor's or the president's, as the one signing: not the legislature's officers ("Speaker and Senate
  // President sign"), a senator signing on, a letter or a pledge (review r9 #6)
  if (!quote && !/\b(gov(ernor)?\.?|president)(\s+[A-Z][\w.'-]+){0,2}\s+sign(s|ed)?\b|\bsigned by (the )?(gov(ernor)?|president)\b/i.test(title) || /\b(senate|house) president\b|\bspeaker\b|\b(lt\.?|lieutenant|acting)\s+gov|\bletter\b|\bsigns? on\b|\bpetition\b|\bpledge\b|\bsenator\b|\brepresentative\b/i.test(title)) { out.delete('executive-signature'); out.delete('became-law'); }
  // a reading or a repeat vote is not the passage ("on first reading", "passes again", "second reading") (review r9 #6)
  if (/\b(first|second|1st|2nd) reading\b|\bagain\b|\b(second|third) time\b|\bfinal (form|version)\b|\bonce more\b|\bre-?pass\w*|\bre-?vote\b|\brevot\w*/i.test(title)) out.clear();
  // a governor's approval is the signature's, never a legislative vote (review r11 #3); a concurrence needs its own word (r11 #4)
  if (/\bgov(ernor)?\b/i.test(title)) { out.delete('passage'); out.delete('concurrence'); out.delete('committee-passage'); if (!/\boverr(id|od)/i.test(title)) out.delete('veto-override-passage'); }
  if (!/\bconcur\w*|\bagree\w*/i.test(title)) out.delete('concurrence');
  // a headline about a hearing to come does not report one held ("Hearing set on AI bill", "Committee to hold hearing") (review r9 #3)
  // nor does one called off ("Hearing on AI bill postponed") (review r9 A2)
  if (/\b(set|sets|schedul\w*|resched\w*|to hold|will|upcoming|plans?|announc\w*|next week|tomorrow|postpon\w*|cancel\w*|delay\w*|rescind\w*|call(s|ed)? off)\b/i.test(title)) out.delete('hearing-held');
  // A headline that also looks ahead ("...; full Senate vote expected next week", "Governor to sign", "Senator plans to introduce",
  // "hearing to follow") carries a prediction: it attaches to nothing (r9 C3, D5/D6). ("May" the month is not a prediction.)
  // (and one that waits or weighs: "as governor weighs veto", "awaits governor's signature", "setting up a vote" (review r6))
  if (/\b(weigh\w*|mull\w*|consider\w*|await\w*|faces?|facing|threat\w*|setting up|sets up|continu\w*|debat\w*|eyes?|eyeing)\b/i.test(title)) out.clear();
  if (/\b(expect\w*|will|next|tomorrow|upcoming|set (for|to)|slated|poised|heads? to|headed to|on track|likely|could|might|later|ahead|pending|to follow)\b|\b(plans?|aims?|seeks?|ready|going|vows?|wants?|hopes?|moves?) to\b|\bto (sign|veto|introduce|pass|vote|hold|approve|consider|take up|testify|issue)\b/i.test(title)) out.clear();
  // Nor a headline that points at another step or another bill, or only asks: a vote or schedule to come ("override vote scheduled",
  // "House vote next"), a date the law takes effect ("effective 2027", "to take effect January 1"), a companion bill, a question
  // (review r9 E3/E4).
  if (/\bvotes?\b|\bschedul\w*|\beffective\b|\btakes? effect\b|\bcompanion\b|\?/i.test(title)) out.clear();
  // A headline that names more than one kind of event ("Assembly approves AI bill after committee hearing") reports one of them, and
  // code cannot tell which: it attaches to nothing (r9 D3/D4). A veto override names the veto it overrides: one kind.
  const kinds = KEYWORDS.map(([re], i) => (re.test(title) ? i : -1)).filter((i) => i >= 0);
  // Signing an order is the order's event: one kind, and not a bill's signature.
  const SIGN = 0, VETO = 1, OVERRIDE = 2, ORDER = 6;
  if (kinds.includes(OVERRIDE)) out.delete('executive-veto'); // an override headline is not the veto's
  if (kinds.includes(ORDER)) { out.delete('executive-signature'); out.delete('became-law'); }
  if (kinds.filter((i) => !(i === VETO && kinds.includes(OVERRIDE)) && !(i === SIGN && kinds.includes(ORDER))).length > 1) out.clear();
  return out;
}

// full entity decoding (review r8 L1): the same plain text as every source adapter
export const plainText = (s) => plain(s);
// A headline that negates, opposes or urges (review r8 M1) never attaches: it does not report the event ("Senator urges House to pass").
// Also a headline whose news is the bill's end (kills, shelves, stalls, dies, tables, sustains), one where the event word only describes
// the bill ("bill passed by House", "Senate-passed bill"), and one about an amendment, a resolution or a budget (review r7 #1). The pattern: NOT_A_REPORT (news/lexicon.mjs).

export function canonicalUrl(u) {
  try {
    const x = new URL(String(u).trim());
    x.protocol = 'https:'; x.hash = ''; x.hostname = x.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) x.searchParams.delete(k);
    x.searchParams.sort();
    let s = x.toString();
    if (x.pathname.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    return s.replace(/\/\?/, '?').replace(/\/$/, x.pathname === '/' ? '' : '');
  } catch { return null; }
}
export const contentHash = (it) => crypto.createHash('sha256').update(`${plainText(it.title).toLowerCase()}\n${plainText((it.facts && it.facts.text) || '').toLowerCase()}`).digest('hex').slice(0, 16);

export function hostAllowed(u, allowHosts) {
  try { const h = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); return allowHosts.some((a) => h === a || h.endsWith(`.${a}`)); } catch { return false; }
}
// Allowlist from config/news-sources.json: hosts of primary (official) sources.
export function allowHostsFrom(cfg) {
  return [...new Set(((cfg && cfg.sources) || []).filter((s) => s.primary).map((s) => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean))];
}

// Bill numbers in a headline: news/jurisdictions.mjs billNumbersIn (the table's prefixes and spelled forms).
export { billNumbersIn };
export function numberConflict(title, eventNumber) {
  const ev = billNumbersIn(eventNumber)[0];
  if (!ev) return false;
  // any other bill named, of any kind, is a conflict: "Senate passes SB 7, a follow-up to SB 53" reports SB 7 (review r8 #5)
  return billNumbersIn(title).some((b) => b.prefix !== ev.prefix || b.num !== ev.num);
}
// The headline's chamber and committee words must agree with the event's facts when both name one ("Senate passes" is not the House
// passage; "Judiciary Committee hearing" is not the Commerce hearing).
const CHAMBER_WORD = /\b(Senate|House|Assembly)\b/g;
export function wordsAgree(title, e) {
  const f = (e && e.facts) || {};
  const named = [...new Set([...String(title || '').matchAll(CHAMBER_WORD)].map((m) => m[1]))];
  if (named.length === 1 && f.chamber && named[0] !== f.chamber) return false;
  // an event with no chamber cannot back a headline that names one (review r10 #7)
  if (['passage', 'committee-passage', 'concurrence', 'failure', 'veto-override-passage'].includes(e && e.class) && !f.chamber && named.length) return false;
  // a chamber's vote is only backed by a headline naming that chamber, alone ("Legislature passes" may be a later vote) (review r8 #6)
  if (['passage', 'committee-passage', 'concurrence', 'failure', 'veto-override-passage'].includes(e && e.class) && f.chamber && !(named.length === 1 && named[0] === f.chamber)) return false;
  // a floor vote's chamber is the chamber itself, not one of its committees ("passes House Judiciary") (review r9 #6)
  if (['passage', 'failure', 'concurrence', 'veto-override-passage'].includes(e && e.class) && CHAMBER_COMMITTEE.test(String(title || ''))) return false;
  const cm = /\b([A-Z][\w&,' -]{2,60}?)\s+Committee\b|\bCommittee on (?:the )?([A-Z][\w&,' -]{2,60})/.exec(String(title || ''));
  if (cm && f.committee) {
    const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []);
    const a = words(cm[1] || cm[2]), b = words(f.committee);
    a.delete('committee'); b.delete('committee');
    if (a.size && ![...a].some((w) => b.has(w))) return false;
  }
  return true;
}
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

// -> { events (copies; statement sources appended), timeline: [{entry_id, item}], leads: [item], dropped: [{item, why}] }
export function attachStatements(events, statements, { allowHosts = [], seen = { urls: [], hashes: [] } } = {}) {
  const urls = new Set(seen.urls || []); const hashes = new Set(seen.hashes || []);
  for (const e of events) for (const s of e.sources || []) if (s.role === 'statement') { const c = canonicalUrl(s.url); if (c) urls.add(c); if (s.hash) hashes.add(s.hash); }
  const out = events.map((e) => ({ ...e, sources: [...(e.sources || [])] }));
  const timeline = []; const leads = []; const dropped = [];
  for (const raw of statements) {
    if (!raw || !raw.facts || raw.facts.role !== 'statement') { dropped.push({ item: raw, why: 'not a statement' }); continue; }
    const title = plainText(raw.title);
    const url = canonicalUrl(raw.url);
    if (!title) { dropped.push({ item: raw, why: 'empty title' }); continue; }
    if (!url || !hostAllowed(url, allowHosts)) { dropped.push({ item: raw, why: 'host not allowlisted' }); continue; }
    const item = { ...raw, title, url };
    const hash = contentHash(item);
    if (urls.has(url) || hashes.has(hash)) { dropped.push({ item, why: 'duplicate' }); continue; }
    urls.add(url); hashes.add(hash);
    const kw = compatibleClasses(title);
    const cands = out.filter((e) => item.entry_id && e.entry_id === item.entry_id && e.status !== 'withdrawn'
      && dayDiff(item.date, e.date) >= 0 && dayDiff(item.date, e.date) <= 3 && kw.has(e.class) && !numberConflict(title, e.facts && e.facts.number))
      .sort((a, b) => dayDiff(item.date, a.date) - dayDiff(item.date, b.date) || (a.key < b.key ? -1 : 1))
      .filter((e) => wordsAgree(title, e));
    // one rule (review r2 #7): exactly one candidate attaches; several are held (timeline), never the nearest guessed
    if (cands.length > 1) { timeline.push({ entry_id: item.entry_id, item: { ...item, hash }, held: `${cands.length} official events could match: not guessed` }); continue; }
    if (cands.length) {
      cands[0].sources.push({ role: 'statement', source: item.source, source_id: item.source_id, url, title, publisher: item.facts.publisher || null, retrieved_at: item.retrieved_at, hash });
    } else if (item.entry_id && !out.some((e) => e.entry_id === item.entry_id && numberConflict(title, e.facts && e.facts.number))) {
      timeline.push({ entry_id: item.entry_id, item: { ...item, hash } });
    } else leads.push({ ...item, hash });
  }
  return { events: out, timeline, leads, dropped, seen: { urls: [...urls], hashes: [...hashes] } };
}
