// News leads: headlines from the feeds in config/news-sources.json that may be news about frontier-AI policy.
//   fetch each feed -> keep items from the last N days -> drop links already on the news page or seen on an earlier run
//   -> code keyword screen -> AI headline screen (role "screener"; only a confident "no" is dropped) -> match to tracked entries
// A lead is only a pointer. Press (secondary) leads are never published; a primary lead may become a news item through
// news/write.mjs, which reads the official release itself. Pure apart from the fetch function the caller passes in.
import crypto from 'crypto';
import { parseFeed, parseTeaserPage, linkKey } from './feeds.mjs';
import { NEWS_SCREEN_SYSTEM } from './prompts.mjs';
import { norm } from '../agents/source-text.mjs';

// The code screen: a headline (or its summary) needs an AI or advanced-computing word, or a tracked bill's number or name.
export const NEWS_TERMS = /\b(?:A\.?I\.?|AGI|artificial intelligence|frontier|superintelligen\w*|super intelligence|foundation models?|large language models?|LLMs?|machine learning|neural|chatbots?|generative|model weights|compute|chips?|semiconductors?|GPUs?|Nvidia|export controls?|OpenAI|Anthropic|xAI|DeepMind|DeepSeek|Gemini|Claude|ChatGPT|Grok|CAISI|AI Safety Institute|algorithm\w*|autonomous|kill switch)\b/i;

const id = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const daysBefore = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);
const titleKey = (t) => norm(t).replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// Bill numbers as our own entries write them: "S. 2938", "H.R. 10873", "SB 53", "S.B. 813", "HF 4532", "A.5275".
const BILL = /\b(H\.?\s?R|S\.?\s?B|H\.?\s?B|A\.?\s?B|H\.?\s?F|S\.?\s?F|S|A)\.?\s?(\d{1,5})\b/g;
// Bill numbers in a headline or a release, read more strictly: a one-letter prefix needs its full stop ("S. 2938", "A.5275"; a bare
// "S 12" or "A 5" is too common in ordinary text), and the "S." of "U.S." is not a bill.
const BILL_TEXT = /(?<![.\w])(?:(H\.?\s?R|S\.?\s?B|H\.?\s?B|A\.?\s?B|H\.?\s?F|S\.?\s?F)\.?|(S|A)\.)\s?(\d{1,5})\b/g;
const numOf = (prefix, n) => prefix.replace(/[.\s]/g, '').toUpperCase() + n;
export const billNumbers = (s) => new Set([...String(s || '').matchAll(BILL_TEXT)].map((m) => numOf(m[1] || m[2], m[3])));
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const CODE_OF = Object.fromEntries(Object.entries(STATES).map(([c, n]) => [n.toLowerCase(), c]));
const NAMES_RE = Object.values(STATES).sort((a, b) => b.length - a.length).join('|');
// The state written right before a bill number: "Nevada SB 53", "California's SB 53", "New York State Senate Bill S.10373", "NV SB 53".
const STATE_BEFORE = new RegExp(`(?:\\b(${NAMES_RE})|\\b(${Object.keys(STATES).join('|')}))(?:['’]s)?(?:\\s+State)?(?:\\s+(?:Senate|House|Assembly|General Assembly|Legislature))?(?:\\s+(?:Bill|Resolution))?(?:\\s+No\\.)?\\s*$`);
const stateBefore = (text, at) => { const m = STATE_BEFORE.exec(text.slice(Math.max(0, at - 60), at)); return m ? (m[1] ? CODE_OF[m[1].toLowerCase()] : m[2]) : null; };
// Each bill number in the text with the state written next to it (null: none written).
// A number written once with its state ("Nevada Senate Bill 53 (SB 53)", "Nevada SB 53 took effect") keeps that state where the text
// later writes it bare; a number given two different states is left without one (and so matches nothing).
const STATE_WORDS = new RegExp(`\\b(${NAMES_RE})(?:['’]s)?(?:\\s+State)?\\s+(?:Senate|House|Assembly)\\s+Bill\\s+(?:No\\.\\s*)?(\\d{1,5})\\b`, 'g');
export const billMentions = (s) => {
  const t = String(s || ''), list = [...t.matchAll(BILL_TEXT)].map((m) => ({ num: numOf(m[1] || m[2], m[3]), n: m[3], state: stateBefore(t, m.index) }));
  const known = new Map(), add = (key, st) => known.set(key, known.has(key) && known.get(key) !== st ? '?' : st);
  list.filter((b) => b.state).forEach((b) => add(b.num, b.state));
  for (const m of t.matchAll(STATE_WORDS)) add('#' + m[2], CODE_OF[m[1].toLowerCase()]); // "Nevada Senate Bill 53": any prefix with that number
  return list.map((b) => {
    if (b.state) return { num: b.num, state: b.state };
    const st = known.get(b.num) || known.get('#' + b.n);
    return { num: b.num, state: st && st !== '?' ? st : st === '?' ? '?' : null };
  });
};
const namesState = (text, code) => new RegExp(`\\b${STATES[code]}\\b`, 'i').test(text) || new RegExp(`\\b${code}\\b`).test(text);
// A bill's own name: the words before "Act" in the short name ("AI Kill Switch Act", "FRONTIER Act"), at least two words or one in capitals.
const actNames = (e) => [...String(`${e.short_name} ${e.title}`).matchAll(/((?:[A-Z][\w'’-]*\s+){1,7}Act)\b/g)].map((m) => m[1].replace(/^(?:H\.?R|S)\.?\s+/, '').trim()).filter((n) => n.split(/\s+/).length > 2 || /^[A-Z]{3,}\s+Act$/.test(n));
// Sponsors' surnames from the sponsor line ("Reps. Sam Liccardo (D-CA), Kevin Kiley (I-CA)" -> Liccardo, Kiley).
const surnames = (e) => [...String(e.sponsor_text || '').matchAll(/([A-Z][a-zA-Z'’-]{2,})\s*\((?:[DRI])-[A-Z]{2}\)/g)].map((m) => m[1]);

// Index of tracked entries (section J, the excluded list, is never matched).
export function entryIndex(entries) {
  return entries.filter((e) => e.section !== 'J').map((e) => {
    const bills = new Set([...String(`${e.short_name} ${e.title}`).matchAll(BILL)].map((m) => numOf(m[1], m[2])));
    // jurisdiction: "US" for a federal entry (even one filed under a state, like a California court case), else the state's code.
    const jur = e.jurisdiction && e.jurisdiction !== 'US' && e.jurisdiction !== 'Federal' ? e.jurisdiction : (e.level === 'state' && e.state) ? e.state : 'US';
    return { key: e.key, short_name: e.short_name, bills, names: actNames(e), sponsors: surnames(e), state: e.state || null, jur };
  });
}

// A bill number in the text names this entry only in the entry's own jurisdiction: a federal entry needs a federal number ("H.R." or
// "S.") with no state written before it; a state entry needs its own state written before the number ("Nevada SB 53" is never
// California's SB 53), or no state written and the feed being that state's own (source config "state").
const billHit = (x, mentions, srcState) => mentions.some((b) => x.bills.has(b.num) && (x.jur === 'US' ? b.state === null && /^(HR|S)\d/.test(b.num) : b.state === x.jur || (b.state === null && srcState === x.jur)));
const nameHit = (x, text, low, srcState) => x.names.some((n) => low.includes(norm(n))) && (x.jur === 'US' || srcState === x.jur || namesState(text, x.jur));

// Which tracked entries a text (a headline, or a release) is about: by bill number or by the bill's name, in the entry's own
// jurisdiction. A sponsor's surname is listed as a weaker match (by: "sponsor") but never sets the tracker: a member's own feed
// carries releases about everything that member does. tracker is set only when exactly one entry matches by number, or else by name.
export function matchEntries({ title, summary, text: body, sponsor, state = null }, index) {
  const text = body != null ? String(body) : `${title} ${summary || ''}`, mentions = billMentions(text), low = norm(text);
  for (const by of ['bill', 'name']) {
    const m = index.filter((x) => (by === 'bill' ? billHit(x, mentions, state) : nameHit(x, text, low, state)));
    if (m.length) return { matches: m.map((x) => ({ key: x.key, by })), tracker: m.length === 1 ? m[0].key : null };
  }
  const s = index.filter((x) => x.sponsors.some((n) => n === sponsor || (new RegExp(`\\b${n}\\b`).test(text) && NEWS_TERMS.test(text))));
  return { matches: s.map((x) => ({ key: x.key, by: 'sponsor' })), tracker: null };
}

// The tracked entry a release itself names (by number or name, in its jurisdiction), or null. Only a candidate: the second reader
// must confirm "This release is about <entry>" with a quote from the release before an item carries it (news/write.mjs).
// label: the bill as the release itself writes it (its number or its name), so the claim the reader checks holds nothing the release
// does not say.
export function releaseTracker({ release, index, state = null }) {
  const text = String(release || ''), m = matchEntries({ text, state }, index);
  if (!m.tracker) return null;
  const x = index.find((e) => e.key === m.tracker);
  if (m.matches[0].by === 'bill') {
    const hit = [...text.matchAll(BILL_TEXT)].find((b) => x.bills.has(numOf(b[1] || b[2], b[3])));
    return { ...x, label: hit ? hit[0].trim() : x.short_name };
  }
  return { ...x, label: `the ${x.names.find((n) => norm(text).includes(norm(n)))}` };
}

// A source's item is secondary even on an official site when it is an op-ed or a repost of a press story (config secondary_paths /
// secondary_titles). Both the item's own link and the release page it points to are tested.
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
export const isPrimary = (src, item, release = releaseUrl(item)) => !!src.primary && !(src.secondary_paths || []).some((p) => pathOf(item.link).includes(p) || pathOf(release).includes(p)) && !(src.secondary_titles && new RegExp(src.secondary_titles).test(item.title));

// The page to read for a primary lead: the item's own link, or (House teaser pages) a release link on the same site in its text.
export function releaseUrl(item) {
  let host; try { host = new URL(item.link).host.replace(/^www\./, ''); } catch { return item.link; }
  const own = (item.links || []).find((u) => { try { const x = new URL(u); return x.host.replace(/^www\./, '') === host && /press|release|news/i.test(x.pathname); } catch { return false; } });
  return (own || item.link).replace(/^http:\/\//, 'https://');
}

// sources: config/news-sources.json "sources". fetchFeed(url) -> xml text (throws on failure). news: the news.json items.
// seen: state/news-seen.json "items" (link key -> { first_seen, outcome }). screener: an AI client or null (then every headline that
// passed the code screen counts as "maybe"). Returns { leads, screened_out, duplicates, already_seen, old, feeds, seen_add }.
export async function findLeads({ sources, fetchFeed, news, seen = {}, entries, screener = null, today, maxAgeDays = 14, log = () => {} }) {
  const since = daysBefore(today, maxAgeDays), index = entryIndex(entries);
  const onPage = new Set(news.flatMap((n) => (n.links || []).map((l) => linkKey(l.u))));
  const titlesOnPage = new Set(news.map((n) => titleKey(n.title)));
  const out = { leads: [], screened_out: [], duplicates: [], already_seen: 0, old: 0, feeds: [], seen_add: {} };
  const runKeys = new Set(), pending = [];
  for (const src of sources.filter((s) => ['rss', 'atom', 'html_teasers'].includes(s.type))) {
    let items;
    try { items = (src.type === 'html_teasers' ? parseTeaserPage(await fetchFeed(src.url, 'text/html'), src.url) : parseFeed(await fetchFeed(src.url))); out.feeds.push({ id: src.id, ok: true, items: items.length }); }
    catch (e) { out.feeds.push({ id: src.id, ok: false, why: String(e.message || e).slice(0, 200) }); log(`feed ${src.id}: ${e.message}`); continue; }
    for (const item of items) {
      if (!item.date || item.date < since || item.date > today) { out.old++; continue; }
      const k = linkKey(item.link);
      if (runKeys.has(k)) continue;
      runKeys.add(k);
      if (onPage.has(k) || onPage.has(linkKey(releaseUrl(item))) || titlesOnPage.has(titleKey(item.title))) { out.duplicates.push({ title: item.title, link: item.link, why: 'already on the news page' }); continue; }
      if (seen[k] && !seen[k].retry) { out.already_seen++; continue; }
      const m = matchEntries({ ...item, sponsor: src.sponsor, state: src.state || null }, index);
      const lead = { id: id(k), key: k, source_id: src.id, publisher: src.publisher, kind: src.kind || 'federal', sponsor: src.sponsor || null, state: src.state || null, primary: isPrimary(src, item), title: item.title, link: item.link, release_url: releaseUrl(item), date: item.date, summary: item.summary, ...m };
      if (!NEWS_TERMS.test(`${item.title} ${item.summary}`) && !m.matches.some((x) => x.by !== 'sponsor')) { out.screened_out.push({ title: item.title, link: item.link, by: 'code' }); out.seen_add[k] = { first_seen: today, outcome: 'screened_out', title: item.title }; continue; }
      pending.push(lead);
    }
  }
  // The AI headline screen, built so it cannot make us miss news: a failed call or a headline it leaves out counts as "maybe".
  let verdicts = new Map();
  if (screener && pending.length) {
    try {
      const r = await screener.generate({ system: NEWS_SCREEN_SYSTEM, prompt: 'Headlines (id<TAB>headline<TAB>summary):\n' + pending.map((l) => `${l.id}\t${l.title}\t${String(l.summary || '').slice(0, 200)}`).join('\n'), itemId: 'news-screen' });
      verdicts = new Map(((r.data && r.data.results) || []).filter((x) => ['yes', 'maybe', 'no'].includes(x.verdict)).map((x) => [String(x.id), x]));
    } catch (e) { log(`headline screen failed, every headline kept as "maybe": ${String(e.message).slice(0, 120)}`); }
  }
  for (const l of pending) {
    const v = verdicts.get(l.id);
    // A headline naming a tracked bill by number or name is always kept.
    if (v && v.verdict === 'no' && !l.matches.some((x) => x.by !== 'sponsor')) { out.screened_out.push({ title: l.title, link: l.link, by: 'model', reason: v.reason || '' }); out.seen_add[l.key] = { first_seen: today, outcome: 'screened_out', title: l.title }; continue; }
    out.leads.push({ ...l, screen: v ? { verdict: v.verdict, reason: v.reason || '', by: 'model' } : { verdict: 'maybe', reason: screener ? 'no answer from the model' : 'no model available', by: 'fallback' } });
  }
  return out;
}
