// Reading news feeds. Plain code, no AI, no network: callers pass the text in.
//   parseFeed(xml)          RSS 2.0 or Atom -> [{ title, link, date, summary }]
//   robotsAllows(txt, path) the site's robots.txt rules for every crawler ("User-agent: *"); a page it disallows is never read
//   parseTeaserPage(html)   an official listing page of teasers, read like a feed (release pages themselves are never read)
import { htmlToText } from '../grabber/lib/text.mjs';

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
export const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITY ? ENTITY[n.toLowerCase()] : m));
const plain = (s) => htmlToText(decode(s)).replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block); return m ? m[1] : ''; };

// "Fri, 25 Sep 2026 18:16:34 +0000" or "2026-09-25T14:16:34-04:00" -> "2026-09-25" (UTC); null when there is no readable date.
export function isoDate(s) {
  const t = Date.parse(decode(s).trim());
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export function parseFeed(xml) {
  const x = String(xml || '');
  const atom = !/<item[\s>]/i.test(x) && /<entry[\s>]/i.test(x);
  const blocks = x.match(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map((b) => {
    let link = decode(tag(b, 'link')).trim();
    if (atom || !link) { const l = /<link\b[^>]*?(?:rel="alternate"[^>]*?)?href="([^"]+)"/i.exec(b); if (l) link = decode(l[1]).trim(); }
    const date = isoDate(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const body = decode(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'));
    // Links inside the item's text: some House sites list a teaser page whose text links to the release itself.
    const links = [...new Set([...body.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) => decode(m[1])))];
    return { title: plain(tag(b, 'title')), link, date, summary: plain(body).slice(0, 600), links };
  }).filter((i) => i.title && /^https?:\/\//.test(i.link));
}

// The same story reached by http or https, with or without "www.", a trailing slash or tracking parameters, is one link.
export function linkKey(u) {
  try {
    const url = new URL(u);
    [...url.searchParams.keys()].filter((k) => /^(utm_|cmpid|ref$|source$)/i.test(k)).forEach((k) => url.searchParams.delete(k));
    return (url.host.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '') + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '')).toLowerCase();
  } catch { return String(u || '').toLowerCase(); }
}

// robots.txt: the group for "User-agent: *" (we send our own honest name, so the general rules are the ones that apply to us).
// The longest matching rule wins; on a tie Allow wins (RFC 9309). "*" matches anything, "$" ends the path.
export function robotsAllows(txt, pathAndQuery) {
  const rules = [];
  let star = false, inGroup = false;
  for (const raw of String(txt || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!inGroup) star = false; inGroup = true; if (v === '*') star = true; continue; }
    inGroup = false;
    if (star && (k === 'allow' || k === 'disallow') && v) rules.push({ allow: k === 'allow', path: v });
  }
  let best = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$'));
    if (!re.test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// An official listing page of teasers (NIST's CAISSI page: <article about="/news-events/news/..." class="nist-teaser"> with a title
// link and <time datetime>), read like a feed. A teaser without its own machine-readable date is left out (dates are never guessed).
export function parseTeaserPage(html, baseUrl) {
  const out = [];
  for (const m of String(html || '').matchAll(/<article\b[^>]*class="[^"]*\bnist-teaser\b[^"]*"[^>]*>[\s\S]*?<\/article>/gi)) {
    const b = m[0], a = /<h\d[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b), t = /<time[^>]*datetime="([^"]+)"/i.exec(b);
    if (!a || !t) continue;
    let link; try { link = new URL(decode(a[1]).trim(), baseUrl).href; } catch { continue; }
    const summary = /class="[^"]*text-with-summary[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(b);
    out.push({ title: plain(a[2]), link, date: isoDate(t[1]), summary: summary ? plain(summary[1]).slice(0, 600) : '', links: [] });
  }
  return out.filter((i) => i.title && /^https?:\/\//.test(i.link));
}
