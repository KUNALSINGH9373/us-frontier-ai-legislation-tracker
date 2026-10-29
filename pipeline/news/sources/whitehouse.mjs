// White House presidential actions feed (keyless): https://www.whitehouse.gov/presidential-actions/feed/
// Executive orders and presidential memoranda (by the feed's own categories) whose own title is about AI.
// A White House posting is not the official record: every item carries facts.needs_confirmation = 'federal_register' and must be
// confirmed by the Federal Register document before it is shown. The entry is matched on the title only (an order's body cites
// other orders it amends).
import { collect, get, sourceConfig, safely, iso, isAI } from './common.mjs';
import { parseRss } from './rss.mjs';
import { buildIndex, matchText } from './match.mjs';

export const FEED = 'https://www.whitehouse.gov/presidential-actions/feed/';
export function classOf(categories) {
  if (categories.some((c) => /^Executive Orders?$/i.test(c))) return 'executive-order';
  if (categories.some((c) => /^Presidential Memorand(a|um)$/i.test(c))) return 'presidential-memo';
  return null;
}

export async function fetchItems({ http, entries = [], now } = {}) {
  return safely(async () => {
    const retrievedAt = iso(now || new Date());
    const c = collect('whitehouse', { retrievedAt, hosts: sourceConfig('whitehouse').hosts });
    const index = buildIndex(entries);
    const r = await get(http, FEED, { json: false });
    if (!r.ok) { c.errors.push(r.error); return c.result({}, false); }
    const items = parseRss(r.text);
    if (!items.length) { c.errors.push('feed has no items'); return c.result({}, false); }
    for (const it of items) {
      const cls = classOf(it.categories);
      if (!cls || !isAI(it.title)) continue;   // title only: orders on other subjects mention AI in passing
      c.add({ source_id: it.guid || it.link, entry_id: matchText(index, it.title, 'US').entry_id, class: cls, date: it.date,
        facts: { title: it.title, needs_confirmation: 'federal_register', categories: it.categories.join('; ') }, url: it.link, title: it.title });
    }
    return c.result();
  });
}
