// RSS 2.0 reading for the official feed adapters (whitehouse, nist, cbo, ca_ag). Keeps what news/feeds.mjs parseFeed drops:
// the guid, the categories and the full item text (plain text only).
import { decode } from '../feeds.mjs';
import { plain, etDate, collect, get, sourceConfig, safely, iso, isAI } from './common.mjs';
import { buildIndex, matchText } from './match.mjs';

const tag = (block, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block); return m ? m[1] : ''; };

export function parseRss(xml) {
  const blocks = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map((b) => ({
    title: plain(tag(b, 'title')),
    link: decode(tag(b, 'link')).trim(),
    guid: decode(tag(b, 'guid')).trim(),
    date: etDate(decode(tag(b, 'pubDate') || tag(b, 'dc:date')).trim()),
    categories: [...b.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map((m) => plain(m[1])),
    text: plain(tag(b, 'content:encoded') || tag(b, 'description')),
  })).filter((i) => i.title && /^https:\/\//.test(i.link));
}

// A statement feed: an official body's own releases. Items are statements only (class null, facts.role 'statement'); they never
// create an event and only attach to one by key. Only items about AI or naming a tracked entry are returned.
// classify(item, match) may return { class, role } to promote an item (CBO cost estimates naming a tracked bill).
export function statementAdapter({ source, url, jurisdiction, publisher, classify = null }) {
  return async function fetchItems({ http, entries = [], now } = {}) {
    return safely(async () => {
      const retrievedAt = iso(now || new Date());
      const c = collect(source, { retrievedAt, hosts: sourceConfig(source).hosts });
      const index = buildIndex(entries);
      const r = await get(http, url, { json: false });
      if (!r.ok) { c.errors.push(r.error); return c.result({}, false); }
      const items = parseRss(r.text);
      if (!items.length && !/<rss|<channel/i.test(r.text)) { c.errors.push(`not a feed: ${url}`); return c.result({}, false); }
      for (const it of items) {
        const text = `${it.title}. ${it.text.slice(0, 1500)}`;
        const m = matchText(index, text, jurisdiction);
        const promoted = classify ? classify(it, index) : null;
        if (!promoted && !m.entry_id && !isAI(`${it.title} ${it.text.slice(0, 1500)}`)) continue;
        c.add({ source_id: it.guid || it.link, jurisdiction, entry_id: promoted?.entry_id ?? m.entry_id, class: promoted?.class ?? null, date: it.date,
          facts: { role: promoted?.role || 'statement', publisher, title: it.title, text: it.text.slice(0, 2000), matched_by: promoted ? 'number' : m.by, number: promoted?.number },
          url: it.link, title: it.title });
      }
      return c.result();
    });
  };
}
