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
  let h = stripHidden(html).replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ');
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

// Text a reader of the page never sees is not part of the release (audit R12, 29 Oct 2026: a display:none paragraph announced a bill
// and penalties the visible release does not). Removed before anything is read: HTML comments, <template>, <noscript>, and every
// element (with all it contains) that is hidden by the `hidden` attribute, aria-hidden="true", an inline style (display:none,
// visibility:hidden or collapse, opacity:0, font-size:0, zero width or height with overflow hidden, clip / clip-path to nothing,
// text-indent or left/top far off-screen), a class the page's own <style> hides that way, or a common hiding class (sr-only,
// visually-hidden, screen-reader-text, hidden, d-none, invisible). Unclosed hidden elements remove the rest of the page (safe side).
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const HIDING_CLASS = new Set(['sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'screenreader-only', 'hidden', 'd-none', 'invisible', 'hide', 'element-invisible', 'offscreen']);
function hiddenStyle(css) {
  const s = String(css || '').toLowerCase().replace(/\s+/g, '');
  return /(?:^|;|\{)display:none/.test(s) || /visibility:(?:hidden|collapse)/.test(s) || /(?:^|;|\{)opacity:0(?:\.0*)?(?:;|$|!|\})/.test(s)
    || /font-size:0(?:px|em|rem|%|pt)?(?:;|$|!|\})/.test(s) || /(?:^|;|\{)(?:max-)?(?:width|height):0(?:px)?(?:;|$|!|\})/.test(s)
    || /clip:rect\(0(?:px)?,?0(?:px)?,?0(?:px)?,?0(?:px)?\)/.test(s) || /clip:rect\(1px,?1px,?1px,?1px\)/.test(s) || /clip-path:inset\(50%\)|clip-path:circle\(0/.test(s)
    || /(?:text-indent|left|top|right|margin-left):-\d{3,}/.test(s) || /transform:scale\(0\)/.test(s);
}
export function stripHidden(html) {
  let h = String(html || '').replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<(template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
  // classes the page's own stylesheet hides
  const hiddenClasses = new Set(HIDING_CLASS);
  for (const st of h.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) for (const rule of st[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!hiddenStyle(rule[2])) continue;
    for (const sel of rule[1].split(',')) { const m = sel.trim().match(/^(?:[a-z0-9]*)\.([\w-]+)$/i); if (m) hiddenClasses.add(m[1].toLowerCase()); }
  }
  const isHidden = (attrs) => {
    if (/(?:^|\s)hidden(?:\s|=|$|\/)/i.test(attrs.replace(/"[^"]*"|'[^']*'/g, '""'))) return true;
    if (/\baria-hidden\s*=\s*["']?true/i.test(attrs)) return true;
    const st = attrs.match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i); if (st && hiddenStyle(st[1] || st[2])) return true;
    const cl = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    return !!cl && (cl[1] || cl[2] || '').split(/\s+/).some((c) => hiddenClasses.has(c.toLowerCase()));
  };
  const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let out = '', i = 0, m;
  while ((m = TAG.exec(h))) {
    const [all, close, name0, attrs] = m, name = name0.toLowerCase();
    if (close || !isHidden(attrs)) continue;
    out += h.slice(i, m.index) + ' ';
    if (VOID.has(name) || /\/\s*$/.test(attrs)) { i = m.index + all.length; continue; }
    // skip to the matching close tag of the same name
    let depth = 1, n; const inner = new RegExp(`<(/?)${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi'); inner.lastIndex = m.index + all.length;
    while (depth && (n = inner.exec(h))) depth += n[1] ? -1 : 1;
    i = depth ? h.length : inner.lastIndex; TAG.lastIndex = i;
  }
  return out + h.slice(i);
}

// The release's own date: a line that is only a date ("Tuesday, September 22, 2026", "October 16, 2026", "Released October 16, 2026"),
// or a dateline ("WASHINGTON, D.C., October 16, 2026 – Today ..."). A date merely written in the opening may be the date of the event
// the release describes, not of the release (code review, 29 Oct 2026): it is taken only when it agrees with the date the feed lists
// the release under (feedDate) within RELEASE_DATE_FEED_DAYS days. null when the release states no date of its own: the item is held.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WRITTEN = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})\b/;
const isoOf = (m) => `${m[3]}-${String(MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
export const RELEASE_DATE_FEED_DAYS = 2;
const DAY = '(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\\s+)?';
const DATE_LINE = new RegExp(`^(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\\s+|Released\\s+|Posted\\s+(?:on\\s+)?)?${WRITTEN.source}$`, 'i');
// "WASHINGTON, D.C., October 16, 2026 –", "SACRAMENTO (October 16, 2026) —", "October 16, 2026 – WASHINGTON": a place in capitals and a dash.
const DATELINE_AFTER = new RegExp(`^[A-Z][A-Z .,'’]{1,40}?[,(]?\\s*${DAY}${WRITTEN.source}\\)?\\s*[–—-]\\s`);
const DATELINE_BEFORE = new RegExp(`^${DAY}${WRITTEN.source}\\s*[–—-]\\s*[A-Z]{3,}`);
const gapDays = (a, b) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5;
// A date line may carry an update note: "September 3, 2026 (updated October 25, 2026)" is a release of September 3 (audit R11): the
// first date is the release's own, never the update's.
const DATE_LINE_UPDATED = new RegExp(`^(?:(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\\s+|Released\\s+|Posted\\s+(?:on\\s+)?)?${WRITTEN.source}\\s*[(\\[]\\s*(?:last\\s+)?(?:updated|revised|modified|amended)\\b[^)\\]]*[)\\]]\\.?$`, 'i');
// A year typo in the release's own date (audit R06: "October 21, 2025" on a release the feed lists on 2026-10-21): when the year is one
// less than the feed date's and the month and day are within RELEASE_DATE_FEED_DAYS days of the feed date, the feed's year is used.
// Anything else is taken as written (and an old date is refused as old news).
function yearTypo(iso, feedDate) {
  if (!feedDate || !/^\d{4}-\d{2}-\d{2}$/.test(feedDate)) return iso;
  const fy = Number(feedDate.slice(0, 4));
  if (Number(iso.slice(0, 4)) !== fy - 1) return iso;
  const fixed = fy + iso.slice(4);
  return Number.isFinite(Date.parse(fixed + 'T00:00:00Z')) && gapDays(fixed, feedDate) <= RELEASE_DATE_FEED_DAYS ? fixed : iso;
}
export function releaseDate(text, feedDate = null) {
  const lines = String(text || '').split('\n').slice(0, 25).map((l) => l.trim());
  for (const l of lines) { const m = DATE_LINE.exec(l) || DATE_LINE_UPDATED.exec(l); if (m) return yearTypo(isoOf(m), feedDate); }
  for (const l of lines) { const m = DATELINE_AFTER.exec(l) || DATELINE_BEFORE.exec(l); if (m) return yearTypo(isoOf(m), feedDate); }
  const m = WRITTEN.exec(String(text || '').slice(0, 600));
  if (!m || !feedDate) return null;
  return gapDays(isoOf(m), feedDate) <= RELEASE_DATE_FEED_DAYS ? isoOf(m) : null;
}

// A press story reposted on an official site ("In The News" with the reporter and outlet under the title): not the body's own
// statement, so it is a press lead, never a news item. Read from the opening lines of the page text.
const OUTLETS = /^(?:POLITICO|Politico|Axios|The Hill|Punchbowl News|Reuters|Bloomberg(?: Government| Law)?|The Washington Post|Washington Post|The New York Times|New York Times|The Wall Street Journal|CNN|CNBC|NBC News|ABC News|CBS News|Fox News|Roll Call|Semafor|Wired|WIRED|The Verge|NPR|Los Angeles Times|LA Times|San Francisco Chronicle|San Jose Mercury News|The Atlantic|Time|TIME|Fortune|Forbes|Business Insider|The Guardian|Associated Press|AP|Newsweek|MSNBC|Vox|Breitbart|Daily Caller|Washington Examiner|Federal News Network|FedScoop|Nextgov|Nextgov\/FCW|Inside AI Policy|Tech Policy Press)$/;
// Also (audit N6, 29 Oct 2026): "Brendan Bordelon reports for Politico", "writes for The Hill", "according to Axios" in the opening,
// "(c) 2026 POLITICO", a byline line "Gabby Miller, Politico" or "Politico | Oct 23", "Originally published in ...".
const OUTLET_WORD = `(?:the\\s+)?(?:${OUTLETS.source.slice(4, -2)})\\b`;
const REPORTS_FOR = new RegExp(`\\b(?:reports?|reported|reporting|writes|wrote|writing)\\s+for\\s+${OUTLET_WORD}`);
const ACCORDING_TO_OUTLET = new RegExp(`\\b[Aa]ccording to\\s+${OUTLET_WORD}`);
const COPYRIGHT_OUTLET = new RegExp(`(?:©|\\([cC]\\)|\\b[Cc]opyright)\\s*(?:\\d{4}\\s+)?${OUTLET_WORD}`);
const BYLINE_OUTLET = new RegExp(`^(?:By\\s+)?[A-Z][\\w.'’-]+(?:\\s+[A-Z][\\w.'’-]+){0,3}\\s*(?:,|\\||—|–|-)\\s*${OUTLET_WORD}|^${OUTLET_WORD}\\s*(?:\\||—|–|-|,)\\s*\\S`);
export function pressRepost(text) {
  const t = String(text || ''), lines = t.split('\n').slice(0, 12).map((l) => l.trim()), head = t.slice(0, 3000);
  if (lines.some((l) => /^(?:In The News|In the News|News Coverage|Press Coverage|Media Coverage|Op-?Eds?|Editorials?|Opinion)$/i.test(l))) return true;
  if (lines.some((l) => OUTLETS.test(l) || /^By\s+[A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+){0,3}\s*(?:,|\||—|-)\s*(?:the\s+)?[A-Z]/.test(l) || BYLINE_OUTLET.test(l))) return true;
  if (REPORTS_FOR.test(head) || COPYRIGHT_OUTLET.test(t) || ACCORDING_TO_OUTLET.test(t.slice(0, 600))) return true;
  return /\b(?:originally (?:appeared|published) (?:in|on|by)|this (?:article|op-ed|story|column) (?:first )?(?:appeared|was published) in)\b/i.test(head);
}

// An opinion piece (op-ed, column) on an official site: by the owner's decision only a lead, never a news item (audit N9). Told by a
// label line ("Op-Ed", "Column"); or, with none of a release's markers (a dateline, "FOR IMMEDIATE RELEASE", "Contact:", "issued the
// following statement", "Today, ..."), by "this op-ed"/"my column", an essay in the first person ("I have", "my view", "I wrote"), or an
// author line at the end ("Ted W. Lieu represents California's 36th District.").
const RELEASE_MARKERS = /FOR IMMEDIATE RELEASE|^\s*(?:Media |Press )?Contacts?:|^[A-Z][A-Z .,'’]{2,40}?(?:\([^)]*\))?\s*[–—-]\s|following statement|said in a statement|^\s*Today,/m;
export function opinionPiece(text) {
  const t = String(text || ''), lines = t.split('\n').slice(0, 12).map((l) => l.trim());
  if (lines.some((l) => /^(?:Op-?Ed|Opinion|Column|Guest Column|Commentary|Guest Essay)\b(?:\s*[:|–—-]|$)/i.test(l))) return true;
  if (RELEASE_MARKERS.test(t.slice(0, 1500))) return false;
  const head = t.slice(0, 2000), firstPerson = (head.match(/\b(?:I|I'm|I’m|I've|I’ve|my|me|myself)\b/g) || []).length;
  const bio = /^[A-Z][\w.'’ -]{2,60} (?:represents|serves as|is the (?:U\.S\. )?(?:Representative|Senator|Congress(?:man|woman)))\b.{0,120}$/m.test(t.split('\n').slice(-4).join('\n'));
  return /\b(?:this|my) (?:op-?ed|column|guest essay)\b|\bop-?ed\b/i.test(head) || firstPerson >= 3 || /\bI wrote\b/.test(head) || bio;
}
