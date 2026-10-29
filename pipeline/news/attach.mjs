// Statement attachment (news/CONTRACT.md: press releases only attach to an existing event). Pure functions.
// A statement RawItem (facts.role === 'statement') attaches to an event only when ALL hold:
//   - entry_id equal (code-matched upstream) and the title names no other bill number of the same kind (SB 530 is not SB 53)
//   - statement date is 0..+3 days after the event date
//   - the event class is compatible with the headline keywords (KEYWORDS), or the headline has no keyword at all -> not attached
// Otherwise it goes to the entry's timeline list (entry known, no event) or to the Telegram leads (no entry).
// Before any of that: verbatim title as plain text, allowlisted host, and exact duplicates (canonical URL or content hash) removed.
import crypto from 'crypto';

export const KEYWORDS = [
  [/\b(sign(s|ed|ing)?|into law)\b/i, ['executive-signature', 'became-law']],
  [/\bveto(es|ed)?\b/i, ['executive-veto']],
  [/\boverrid(e|es|den)\b/i, ['veto-override-passage']],
  [/\b(pass(es|ed)?|approv(es|ed))\b/i, ['passage', 'committee-passage', 'concurrence', 'veto-override-passage']],
  [/\bhearings?\b|\btestif(y|ies|ied)\b/i, ['hearing-scheduled', 'hearing-held']],
  [/\bintroduc(e|es|ed)\b/i, ['introduction']],
  [/\bexecutive order\b/i, ['executive-order']],
  [/\b(final rule|proposed rule|rulemaking)\b/i, ['agency-rule-final', 'agency-rule-proposed']],
];
export function compatibleClasses(title) {
  const out = new Set();
  for (const [re, cls] of KEYWORDS) if (re.test(title)) cls.forEach((c) => out.add(c));
  return out;
}

export const plainText = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

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

// Bill numbers in a headline: "SB 530", "S. 2938", "A.B. 1018", "H.R. 1" -> [{ prefix, num }]
export function billNumbersIn(s) {
  const out = [];
  for (const m of String(s || '').matchAll(/\b(S\.?\s?B|A\.?\s?B|H\.?\s?R|H\.?\s?B|S|A)\.?\s?(\d{1,5})\b/gi)) out.push({ prefix: m[1].toUpperCase().replace(/[.\s]/g, ''), num: String(+m[2]) });
  return out;
}
export function numberConflict(title, eventNumber) {
  const ev = billNumbersIn(eventNumber)[0];
  if (!ev) return false;
  const named = billNumbersIn(title).filter((b) => b.prefix === ev.prefix);
  return named.length > 0 && !named.some((b) => b.num === ev.num);
}
// The headline's chamber and committee words must agree with the event's facts when both name one ("Senate passes" is not the House
// passage; "Judiciary Committee hearing" is not the Commerce hearing).
const CHAMBER_WORD = /\b(Senate|House|Assembly)\b/g;
export function wordsAgree(title, e) {
  const f = (e && e.facts) || {};
  const named = [...new Set([...String(title || '').matchAll(CHAMBER_WORD)].map((m) => m[1]))];
  if (named.length === 1 && f.chamber && named[0] !== f.chamber) return false;
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
