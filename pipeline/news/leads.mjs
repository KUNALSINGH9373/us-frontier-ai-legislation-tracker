// News leads: headlines from the feeds in config/news-sources.json that may be news about frontier-AI policy.
//   fetch each feed -> keep items from the last N days -> drop links already on the news page or seen on an earlier run
//   -> code keyword screen -> AI headline screen (role "screener"; only a confident "no" is dropped) -> match to tracked entries
// A lead is only a pointer. Press (secondary) leads are never published; a primary lead may become a news item through
// news/write.mjs, which reads the official release itself. Pure apart from the fetch function the caller passes in.
import crypto from 'crypto';
import { parseFeed, linkKey } from './feeds.mjs';
import { NEWS_SCREEN_SYSTEM } from './prompts.mjs';
import { norm } from '../agents/source-text.mjs';

// The code screen: a headline (or its summary) needs an AI or advanced-computing word, or a tracked bill's number or name.
export const NEWS_TERMS = /\b(?:A\.?I\.?|AGI|artificial intelligence|frontier|superintelligen\w*|super intelligence|foundation models?|large language models?|LLMs?|machine learning|neural|chatbots?|generative|model weights|compute|chips?|semiconductors?|GPUs?|Nvidia|export controls?|OpenAI|Anthropic|xAI|DeepMind|DeepSeek|Gemini|Claude|ChatGPT|Grok|CAISI|AI Safety Institute|algorithm\w*|autonomous|kill switch)\b/i;

const id = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const daysBefore = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);
const titleKey = (t) => norm(t).replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// Bill numbers as headlines write them: "S. 2938", "H.R. 10873", "HR 9917", "SB 53", "S.B. 813", "HF 4532", "A.5275".
const BILL = /\b(H\.?\s?R|S\.?\s?B|H\.?\s?B|A\.?\s?B|H\.?\s?F|S\.?\s?F|S|A)\.?\s?(\d{1,5})\b/g;
export const billNumbers = (s) => new Set([...String(s || '').matchAll(BILL)].map((m) => m[1].replace(/[.\s]/g, '').toUpperCase() + m[2]));
// A bill's own name: the words before "Act" in the short name ("AI Kill Switch Act", "FRONTIER Act"), at least two words or one in capitals.
const actNames = (e) => [...String(`${e.short_name} ${e.title}`).matchAll(/((?:[A-Z][\w'’-]*\s+){1,7}Act)\b/g)].map((m) => m[1].replace(/^(?:H\.?R|S)\.?\s+/, '').trim()).filter((n) => n.split(/\s+/).length > 2 || /^[A-Z]{3,}\s+Act$/.test(n));
// Sponsors' surnames from the sponsor line ("Reps. Sam Liccardo (D-CA), Kevin Kiley (I-CA)" -> Liccardo, Kiley).
const surnames = (e) => [...String(e.sponsor_text || '').matchAll(/([A-Z][a-zA-Z'’-]{2,})\s*\((?:[DRI])-[A-Z]{2}\)/g)].map((m) => m[1]);

// Index of tracked entries (section J, the excluded list, is never matched).
export function entryIndex(entries) {
  return entries.filter((e) => e.section !== 'J').map((e) => ({ key: e.key, bills: billNumbers(`${e.short_name} ${e.title}`), names: actNames(e), sponsors: surnames(e), state: e.state || null }));
}

// Which tracked entries a headline is about: by bill number, by the bill's name, or by a sponsor's name (with an AI word, or on
// that sponsor's own feed). tracker is set only when exactly one entry matches at the strongest level found.
export function matchEntries({ title, summary, sponsor }, index) {
  const text = `${title} ${summary || ''}`, bills = billNumbers(text), low = norm(text);
  const hit = (by) => index.filter((x) => (by === 'bill' ? [...x.bills].some((b) => bills.has(b)) : by === 'name' ? x.names.some((n) => low.includes(norm(n))) : x.sponsors.some((s) => s === sponsor || new RegExp(`\\b${s}\\b`).test(text) && NEWS_TERMS.test(text))));
  for (const by of ['bill', 'name', 'sponsor']) {
    const m = hit(by);
    if (m.length) return { matches: m.map((x) => ({ key: x.key, by })), tracker: m.length === 1 ? m[0].key : null };
  }
  return { matches: [], tracker: null };
}

// A source's item is secondary even on an official site when it is an op-ed (config secondary_paths / secondary_titles).
const isPrimary = (src, item) => !!src.primary && !(src.secondary_paths || []).some((p) => { try { return new URL(item.link).pathname.includes(p); } catch { return false; } }) && !(src.secondary_titles && new RegExp(src.secondary_titles).test(item.title));

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
  for (const src of sources.filter((s) => s.type === 'rss' || s.type === 'atom')) {
    let items;
    try { items = parseFeed(await fetchFeed(src.url)); out.feeds.push({ id: src.id, ok: true, items: items.length }); }
    catch (e) { out.feeds.push({ id: src.id, ok: false, why: String(e.message || e).slice(0, 200) }); log(`feed ${src.id}: ${e.message}`); continue; }
    for (const item of items) {
      if (!item.date || item.date < since || item.date > today) { out.old++; continue; }
      const k = linkKey(item.link);
      if (runKeys.has(k)) continue;
      runKeys.add(k);
      if (onPage.has(k) || onPage.has(linkKey(releaseUrl(item))) || titlesOnPage.has(titleKey(item.title))) { out.duplicates.push({ title: item.title, link: item.link, why: 'already on the news page' }); continue; }
      if (seen[k] && !seen[k].retry) { out.already_seen++; continue; }
      const m = matchEntries({ ...item, sponsor: src.sponsor }, index);
      const lead = { id: id(k), key: k, source_id: src.id, publisher: src.publisher, kind: src.kind || 'federal', primary: isPrimary(src, item), title: item.title, link: item.link, release_url: releaseUrl(item), date: item.date, summary: item.summary, ...m };
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
