// Reading news feeds and official release pages. Plain code, no AI, no network: callers pass the text in.
//   parseFeed(xml)          RSS 2.0 or Atom -> [{ title, link, date, summary }]
//   robotsAllows(txt, path) the site's robots.txt rules for every crawler ("User-agent: *"); a page it disallows is never read
//   releaseText(html)       the words of a release page, without menus, headers and footers (quotes and numbers are checked against this)
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

// Lines of site furniture that pages without <main> (NIST) leave in the text: the .gov banner, share buttons, the feedback box.
const FURNITURE = /^(?:Skip to main content|Official websites use \.gov|A \.gov website belongs to an official government organization in the United States\.|Secure \.gov websites use HTTPS|A lock \(|\) or https:\/\/ means you’ve safely connected to the \.gov website\..*|Share|Facebook|Linkedin|LinkedIn|X\.com|Twitter|Email|Print|Was this page helpful\?|UPDATES|NEWS|https?:\/\/\S+)$/;

// The release itself: the page's <main> or <article> when it has one, with menus, headers, footers and forms removed. A page without
// either starts at its "main-content" anchor when it has one; the .gov banner, share and feedback blocks and furniture lines are dropped,
// so quotes are checked against the article's own words.
export function releaseText(html) {
  let h = String(html || '').replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ');
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(h) || /<article[\s>][\s\S]*?<\/article>/i.exec(h);
  if (main) h = main[0];
  else {
    const at = h.search(/<a\b[^>]*\bid="main-content"/i);
    if (at > 0) h = h.slice(at);
    h = h.replace(/<section\b[^>]*class="[^"]*usa-banner[^"]*"[\s\S]*?<\/section>/gi, ' ');
  }
  h = h.replace(/<(nav|header|footer|aside|form)[\s>][\s\S]*?<\/\1>/gi, ' ').replace(/<\/(p|div|h\d|li|br|tr)>|<br\s*\/?>/gi, '$&\n');
  return htmlToText(h).replace(/[ \t]+\n/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l && !FURNITURE.test(l)).join('\n').trim();
}

// The release's own date: a line that is only a date ("Tuesday, September 22, 2026", "October 16, 2026", "Released October 16, 2026"),
// else the first written date in its opening. null when the release states none.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WRITTEN = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})\b/;
const isoOf = (m) => `${m[3]}-${String(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
export function releaseDate(text) {
  const lines = String(text || '').split('\n').slice(0, 25);
  for (const l of lines) { const m = new RegExp(`^(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\\s+|Released\\s+|Posted\\s+(?:on\\s+)?)?${WRITTEN.source}$`, 'i').exec(l.trim()); if (m) return isoOf(m); }
  const m = WRITTEN.exec(String(text || '').slice(0, 600));
  return m ? isoOf(m) : null;
}

// A press story reposted on an official site ("In The News" with the reporter and outlet under the title): not the body's own
// statement, so it is a press lead, never a news item. Read from the opening lines of the page text.
const OUTLETS = /^(?:POLITICO|Politico|Axios|The Hill|Punchbowl News|Reuters|Bloomberg(?: Government| Law)?|The Washington Post|Washington Post|The New York Times|New York Times|The Wall Street Journal|CNN|CNBC|NBC News|ABC News|CBS News|Fox News|Roll Call|Semafor|Wired|WIRED|The Verge|NPR|Los Angeles Times|LA Times|San Francisco Chronicle|San Jose Mercury News|The Atlantic|Time|TIME|Fortune|Forbes|Business Insider|The Guardian|Associated Press|AP|Newsweek|MSNBC|Vox|Breitbart|Daily Caller|Washington Examiner|Federal News Network|FedScoop|Nextgov|Nextgov\/FCW|Inside AI Policy|Tech Policy Press)$/;
export function pressRepost(text) {
  const lines = String(text || '').split('\n').slice(0, 12).map((l) => l.trim());
  if (lines.some((l) => /^(?:In The News|In the News|News Coverage|Press Coverage|Media Coverage|Op-?Eds?|Editorials?|Opinion)$/i.test(l))) return true;
  if (lines.some((l) => OUTLETS.test(l) || /^By\s+[A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+){0,3}\s*(?:,|\||—|-)\s*(?:the\s+)?[A-Z]/.test(l))) return true;
  return /\b(?:originally (?:appeared|published) (?:in|on)|this (?:article|op-ed|story) (?:first )?(?:appeared|was published) in)\b/i.test(String(text || '').slice(0, 3000));
}
