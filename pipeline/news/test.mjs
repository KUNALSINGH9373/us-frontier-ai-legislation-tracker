// Run:  node news/test.mjs
// News leads with real feeds recorded on 28 Oct 2026 (fixtures/news/: Politico technology, NIST news, Rep. Liccardo's feed) and a
// scripted headline screen (no AI, no network): reading feeds, robots.txt, matching headlines to tracked entries, the lead window and
// dedupe, the polite reader, and the whole news step: leads are only reported (a primary one may attach to an official event as a
// statement), nothing is ever written from a release page. The event model is tested in news/test-events.mjs.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseFeed, robotsAllows, linkKey, isoDate } from './feeds.mjs';
import { findLeads, matchEntries, entryIndex, billNumbers, releaseUrl, NEWS_TERMS } from './leads.mjs';
import { newsRun, createReader } from './run.mjs';
import { emptyState, saveEvents } from './events.mjs';
import { newReport, finalize } from '../report/build.mjs';
import { formatReport } from '../report/format.mjs';
import { formatHtml } from '../report/html.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', 'fixtures', 'news'), realData = path.join(here, '..', '..', 'web', 'data', 'v2');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const clone = (o) => JSON.parse(JSON.stringify(o));

const FEEDS = { 'https://rss.politico.com/technology.xml': read('politico-technology.xml'), 'https://www.nist.gov/news-events/news/rss.xml': read('nist-news.xml'), 'https://liccardo.house.gov/rss.xml': read('liccardo.xml') };
const RELEASE_URL = 'https://liccardo.house.gov/media/press-releases/new-bipartisan-ai-safety-bill-will-move-us-and-china-beyond-red-phone';
const SOURCES = { user_agent: 'test', sources: [
  { id: 'politico-technology', url: 'https://rss.politico.com/technology.xml', type: 'rss', publisher: 'Politico', primary: false, kind: 'federal' },
  { id: 'nist-news', url: 'https://www.nist.gov/news-events/news/rss.xml', type: 'rss', publisher: 'NIST', primary: true, kind: 'executive' },
  { id: 'rep-liccardo', url: 'https://liccardo.house.gov/rss.xml', type: 'rss', publisher: 'Rep. Sam Liccardo', primary: true, kind: 'federal', sponsor: 'Liccardo' },
  { id: 'federal-register', url: 'https://www.federalregister.gov/api/v1/documents.json', type: 'json_api', publisher: 'Federal Register', primary: true }
] };
const TODAY = '2026-10-28', NOW = new Date('2026-10-28T06:00:00Z');
const entries = JSON.parse(fs.readFileSync(path.join(realData, 'entries.json'), 'utf8'));
const LICCARDO_KEY = 'liccardo-kiley-us-china-ai-safety-bill';
const PITCH = 'Anthropic quietly pitches its own AI safety bill to lawmakers', STAFF = 'Senate poised to add Claude to staffers’ AI tools';

function scripted(fn) { return { calls: [], async generate(req) { this.calls.push(req); const r = fn(req, this.calls.length); if (r instanceof Error) throw r; return { data: r, usage: {} }; } }; }
// The headline screen: "yes" for the two real stories, "no" for everything else (an irrelevant AI headline among them).
const screenOf = (yes = [/Liccardo Pushes/, /quietly pitches/, /H\.R\. 9917/]) => scripted((req) => ({ results: req.prompt.split('\n').slice(1).map((l) => { const [id, title] = l.split('\t'); return { id, verdict: yes.some((r) => r.test(title)) ? 'yes' : 'no', reason: 'scripted' }; }) }));
// Only the screener: no other role exists in the news step any more.
const factoryOf = ({ screener = screenOf() } = {}) => ({ keyName: 'ANTHROPIC_API_KEY', make: (role) => { if (role !== 'screener') throw new Error(`role ${role} is not used by the news step`); return screener; } });
const fakeReader = (extra = {}) => { const pages = { ...FEEDS, ...extra }; let n = 0; return { got: [], used: () => n, async get(u) { n++; this.got.push(u); if (pages[u] instanceof Error) throw pages[u]; if (!(u in pages)) throw new Error(`HTTP 404 for ${u}`); return pages[u]; } }; };
const CONFIG = (on) => ({ max_entries_changed_per_run: 15, auto_publish: { news: on }, news_leads: { enabled: true, max_age_days: 40 } });
// The site already has the 22 Sept Liccardo item (written by hand). The sandboxes start from the news page as it was before it.
const NEWS_REAL = JSON.parse(fs.readFileSync(path.join(realData, 'news.json'), 'utf8'));
const NEWS_BEFORE = { ...NEWS_REAL, items: NEWS_REAL.items.filter((n) => !(n.links || []).some((l) => l.u === RELEASE_URL)) };
if (NEWS_BEFORE.items.length !== NEWS_REAL.items.length - 1) throw new Error('test expects the real news page to have the 22 Sept Liccardo item once');
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-test-'));
  fs.mkdirSync(path.join(dir, 'data'));
  for (const f of ['entries', 'site', 'changes', 'relationships']) if (fs.existsSync(path.join(realData, f + '.json'))) fs.copyFileSync(path.join(realData, f + '.json'), path.join(dir, 'data', f + '.json'));
  fs.writeFileSync(path.join(dir, 'data', 'news.json'), JSON.stringify(NEWS_BEFORE, null, 1));
  return { dir, dataDir: path.join(dir, 'data'), seenFile: path.join(dir, 'state', 'news-seen.json'), eventsFile: path.join(dir, 'state', 'news-events.json'), healthFile: path.join(dir, 'state', 'news-health.json') };
}
const run = (sb, o = {}) => newsRun({ dataDir: sb.dataDir, seenFile: sb.seenFile, eventsFile: sb.eventsFile, healthFile: sb.healthFile, config: CONFIG(false), sources: SOURCES, factory: factoryOf(), today: TODAY, now: NOW, runId: 'update-test', reader: fakeReader(), records: [], ...o });

// ---------- 1. reading real feeds ----------
{
  const p = parseFeed(FEEDS['https://rss.politico.com/technology.xml']), n = parseFeed(FEEDS['https://www.nist.gov/news-events/news/rss.xml']), l = parseFeed(FEEDS['https://liccardo.house.gov/rss.xml']);
  ok('1 every item of the three recorded feeds is read', p.length === 30 && n.length === 40 && l.length === 10, `${p.length} ${n.length} ${l.length}`);
  ok('1 titles, links and dates', p.some((i) => i.title === PITCH && /^https:\/\/www\.politico\.com\//.test(i.link) && /^2026-10-\d\d$/.test(i.date)) && l[0].date === '2026-09-25', JSON.stringify(p[0]));
  ok('1 entities and CDATA decoded, tags stripped from summaries', p.some((i) => i.title === STAFF) && !p.some((i) => /<|&lt;|&amp;/.test(i.summary)));
  ok('1 a House teaser page links to its release, which is the page read', releaseUrl(l[0]) === RELEASE_URL, releaseUrl(l[0]));
  const atom = parseFeed('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">H.R. 9917 &amp; a hearing</title><link rel="alternate" href="https://example.gov/r/1"/><updated>2026-10-27T10:00:00-04:00</updated><summary>The AI Kill Switch Act.</summary></entry></feed>');
  ok('1 Atom feeds too', atom.length === 1 && atom[0].title === 'H.R. 9917 & a hearing' && atom[0].link === 'https://example.gov/r/1' && atom[0].date === '2026-10-27');
  ok('1 dates are read in UTC; an unreadable date is null', isoDate('Tue, 27 Oct 2026 21:03:12 -0700') === '2026-10-28' && isoDate('soon') === null);
  ok('1 the same link with http, www, a slash or tracking parameters is one link', linkKey('http://www.politico.com/a/b/?utm_source=x') === linkKey('https://politico.com/a/b'));
}
// ---------- 2. robots.txt ----------
{
  const R = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nDisallow: /*?f%5B*\nAllow: /private/press/\nDisallow: /*.pdf$\n';
  ok('2 robots: general rules apply, a named crawler\'s rules do not', robotsAllows(R, '/news/rss.xml') && !robotsAllows(R, '/private/x'));
  ok('2 robots: the longest rule wins, Allow beats a shorter Disallow', robotsAllows(R, '/private/press/r1'));
  ok('2 robots: wildcards and "$" (the real NIST and House patterns)', !robotsAllows(R, '/search?f%5B0%5D=1') && !robotsAllows(R, '/a/b.pdf') && robotsAllows(R, '/a/b.pdf?x=1') && robotsAllows('User-agent: *\nDisallow: /*/media/oembed\n', '/rss.xml'));
  ok('2 robots: no file or an empty one allows everything', robotsAllows('', '/x') && robotsAllows('User-agent: *\nDisallow:\n', '/x'));
}

// ---------- 3. matching headlines to tracked entries ----------
{
  const ix = entryIndex(entries);
  ok('3 bill numbers as headlines write them', ['HR9917', 'S2938', 'SB53'].every((b) => billNumbers('H.R. 9917, S. 2938 and SB 53').has(b)));
  ok('3 by bill number', matchEntries({ title: 'Hearing set on H.R. 9917' }, ix).tracker === 'h-r-9917-ai-kill-switch-act');
  ok('3 by the bill\'s own name', matchEntries({ title: 'House panel to mark up the AI Kill Switch Act' }, ix).tracker === 'h-r-9917-ai-kill-switch-act');
  ok('3 on a sponsor\'s own feed the sponsor is a weak match and never sets the tracker (every release of that member is on it)', (() => { const m = matchEntries({ title: 'Liccardo Pushes for US-China Coordination on AI Safety', sponsor: 'Liccardo' }, ix); return m.tracker === null && m.matches.some((x) => x.key === LICCARDO_KEY && x.by === 'sponsor'); })());
  ok('3 a sponsor\'s name with no AI word is no match', matchEntries({ title: 'Lieu visits a veterans home' }, ix).matches.length === 0);
  ok('3 several entries at the same level: matches listed, no tracker guessed', (() => { const m = matchEntries({ title: 'Obernolte and Lieu on AI' }, ix); return m.matches.length > 1 && m.tracker === null; })());
  ok('3 the code screen needs an AI word', NEWS_TERMS.test(PITCH) && !NEWS_TERMS.test('Zuckerberg considered leaving CA over wealth tax'));
}

// ---------- 4. leads: window, dedupe, screens ----------
{
  const news = clone(NEWS_BEFORE.items), pitch = parseFeed(FEEDS['https://rss.politico.com/technology.xml']).find((i) => i.title === PITCH);
  const screener = screenOf();
  const r = await findLeads({ sources: SOURCES.sources, fetchFeed: async (u) => FEEDS[u], news, entries, screener, today: TODAY, maxAgeDays: 40 });
  ok('4 the official release and the press story are leads', r.leads.length === 2 && r.leads.some((l) => l.primary && l.tracker === null && l.release_url === RELEASE_URL) && r.leads.some((l) => !l.primary && l.title === PITCH), JSON.stringify(r.leads.map((l) => l.title)));
  ok('4 an irrelevant AI headline is dropped by the screen', r.screened_out.some((s) => s.title === STAFF && s.by === 'model'));
  ok('4 a headline with no AI word is dropped by code, without asking the model', r.screened_out.some((s) => /wealth tax/.test(s.title) && s.by === 'code') && !screener.calls[0].prompt.includes('wealth tax'));
  ok('4 old items are left out; the Federal Register is the grabber\'s, not read here', r.old > 0 && r.feeds.length === 3);
  ok('4 everything screened out is remembered, leads are not yet', Object.values(r.seen_add).every((v) => v.outcome === 'screened_out') && !(linkKey(pitch.link) in r.seen_add));
  const dupNews = [...news, { date: '2026-10-20', title: 'x'.repeat(10), body: 'y'.repeat(30), links: [{ t: 'Politico', u: pitch.link.replace('https://www.', 'http://') + '/' }] }];
  const r2 = await findLeads({ sources: SOURCES.sources, fetchFeed: async (u) => FEEDS[u], news: dupNews, entries, screener: screenOf(), today: TODAY, maxAgeDays: 40 });
  const real = await findLeads({ sources: SOURCES.sources, fetchFeed: async (u) => FEEDS[u], news: NEWS_REAL.items, entries, screener: screenOf(), today: TODAY, maxAgeDays: 40 });
  ok('4 on the real page the Liccardo release is already reported (by hand, Sept 22): a duplicate, found by its release link before any AI', real.duplicates.some((d) => /Liccardo Pushes/.test(d.title)) && !real.leads.some((l) => l.primary));
  ok('4 a story already on the news page is a duplicate, not a lead', r2.duplicates.some((d) => d.title === PITCH) && !r2.leads.some((l) => l.title === PITCH));
  const r3 = await findLeads({ sources: SOURCES.sources, fetchFeed: async (u) => FEEDS[u], news, entries, seen: { [linkKey(pitch.link)]: { outcome: 'lead' } }, screener: screenOf(), today: TODAY, maxAgeDays: 40 });
  ok('4 a lead seen on an earlier run is not reported again', r3.already_seen === 1 && r3.leads.length === 1);
  const r4 = await findLeads({ sources: SOURCES.sources, fetchFeed: async (u) => FEEDS[u], news, entries, screener: scripted(() => new Error('HTTP 529 for model')), today: TODAY, maxAgeDays: 40 });
  ok('4 a failed screen keeps every headline that passed the code screen ("maybe")', r4.leads.length > 2 && r4.leads.every((l) => l.screen.verdict === 'maybe'));
  const atom = '<feed><entry><title>Hearing on H.R. 9917</title><link href="https://example.gov/r/2"/><updated>2026-10-27T10:00:00Z</updated></entry></feed>';
  const r5 = await findLeads({ sources: [{ id: 'x', url: 'u', type: 'atom', publisher: 'X', primary: true }], fetchFeed: async () => atom, news, entries, screener: scripted((req) => ({ results: [{ id: req.prompt.split('\n')[1].split('\t')[0], verdict: 'no', reason: 'scripted' }] })), today: TODAY });
  ok('4 a headline naming a tracked bill is kept even when the model says no', r5.leads.length === 1 && r5.leads[0].tracker === 'h-r-9917-ai-kill-switch-act');
  const r6 = await findLeads({ sources: SOURCES.sources, fetchFeed: async (u) => { if (/nist/.test(u)) throw new Error('HTTP 403 for nist'); return FEEDS[u]; }, news, entries, screener: screenOf(), today: TODAY, maxAgeDays: 40 });
  ok('4 a feed that fails is recorded and the others are still read', r6.feeds.some((f) => f.id === 'nist-news' && !f.ok && /403/.test(f.why)) && r6.leads.length === 2);
}

// ---------- 4b. the polite reader ----------
{
  const calls = [];
  const fetchImpl = async (u, init) => {
    calls.push({ u, ua: init.headers['User-Agent'], accept: init.headers.Accept });
    const t = { 'https://ok.gov/robots.txt': 'User-agent: *\nDisallow: /private/\n', 'https://ok.gov/rss.xml': '<rss/>', 'https://ok.gov/private/r': 'secret' }[u];
    if (u === 'https://blocked.gov/robots.txt') return { ok: false, status: 403, text: async () => 'Unauthorized', headers: { get: () => null } };
    if (u === 'https://none.gov/robots.txt') return { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
    if (u === 'https://none.gov/rss.xml') return { ok: true, status: 200, text: async () => '<rss>none</rss>' };
    return t == null ? { ok: false, status: 404, text: async () => '', headers: { get: () => null } } : { ok: true, status: 200, text: async () => t };
  };
  const rd = createReader({ userAgent: 'us-frontier-ai-tracker-pipeline/0.1 (news leads; RSS reader)', fetchImpl });
  ok('10 an allowed feed is read, with our own honest name and a feed Accept header', (await rd.get('https://ok.gov/rss.xml', 'application/rss+xml')) === '<rss/>' && calls.every((c) => /^us-frontier-ai-tracker-pipeline/.test(c.ua)) && calls.find((c) => c.u === 'https://ok.gov/rss.xml').accept === 'application/rss+xml');
  ok('10 a page robots.txt disallows is never fetched', await rd.get('https://ok.gov/private/r', 'text/html').then(() => false, (e) => /robots\.txt/.test(e.message)) && !calls.some((c) => c.u === 'https://ok.gov/private/r'));
  ok('10 a site that refuses robots.txt (403) is not read at all', await rd.get('https://blocked.gov/rss.xml', 'x').then(() => false, () => true) && !calls.some((c) => c.u === 'https://blocked.gov/rss.xml'));
  ok('10 no robots.txt (404) allows reading', (await rd.get('https://none.gov/rss.xml', 'x')) === '<rss>none</rss>');
  ok('10 robots.txt is fetched once per site', calls.filter((c) => c.u === 'https://ok.gov/robots.txt').length === 1);
}

// ---------- 5. the whole step: leads are reported, nothing is written from a release ----------
{
  const sb = sandbox(), before = fs.readFileSync(path.join(sb.dataDir, 'news.json'), 'utf8');
  const r = await run(sb, { config: CONFIG(true) });
  ok('5 the official release and the press story are reported as leads; news.json unchanged even with publishing on', r.leads.length === 2 && r.leads.some((l) => l.primary) && r.leads.some((l) => !l.primary && l.title === PITCH) && fs.readFileSync(path.join(sb.dataDir, 'news.json'), 'utf8') === before && r.drafted.length === 0, JSON.stringify(r.leads));
  ok('5 no page but the feeds is fetched: release pages are never read', r.requests === 3, String(r.requests));
  const seen = JSON.parse(fs.readFileSync(sb.seenFile, 'utf8')).items;
  ok('5 leads are remembered, so the next run does not report them again', Object.values(seen).some((v) => v.outcome === 'lead') && (await run(sb)).leads.length === 0);
  // a primary lead on a tracked entry attaches to an official event as a statement (within 3 days, a compatible headline)
  const sb2 = sandbox(), st = emptyState();
  const key = 'US|h-r-9917-ai-kill-switch-act|hearing-held|2026-10-26';
  st.events[key] = { key, jurisdiction: 'US', entry_id: 'h-r-9917-ai-kill-switch-act', class: 'hearing-held', date: '2026-10-26', facts: { action: 'Committee on Energy and Commerce. Hearings held.' }, sources: [{ role: 'official', source: 'congress_gov', source_id: '119/hr/9917#x', url: 'https://www.congress.gov/bill/119th-congress/house-bill/9917', retrieved_at: '2026-10-26T08:00:00Z' }], status: 'confirmed', confirmations: [], stable_runs: 2, history: [], card: null };
  fs.mkdirSync(path.dirname(sb2.eventsFile), { recursive: true }); saveEvents(sb2.eventsFile, st);
  const atom = '<feed><entry><title>Hearing on H.R. 9917, the AI Kill Switch Act</title><link href="https://lieu.house.gov/media-center/press-releases/hearing-hr-9917"/><updated>2026-10-27T10:00:00Z</updated></entry></feed>';
  const SRC2 = { user_agent: 't', sources: [{ id: 'rep-lieu', url: 'https://lieu.house.gov/rss.xml', type: 'atom', publisher: 'Rep. Ted Lieu', primary: true, kind: 'federal' }] };
  const r2 = await run(sb2, { sources: SRC2, reader: fakeReader({ 'https://lieu.house.gov/rss.xml': atom }) });
  const ev = JSON.parse(fs.readFileSync(sb2.eventsFile, 'utf8')).events[key];
  ok('5 a release the day after a hearing attaches to the hearing event as a statement (verbatim headline + link), and is not also a lead', r2.events.statements === 1 && ev.sources.some((s) => s.role === 'statement' && s.title === 'Hearing on H.R. 9917, the AI Kill Switch Act' && /lieu\.house\.gov/.test(s.url)) && !r2.leads.some((l) => /9917/.test(l.title)), JSON.stringify({ leads: r2.leads, st: r2.events.statements }));
  for (const s of [sb, sb2]) fs.rmSync(s.dir, { recursive: true, force: true });
}

// ---------- 6. the Telegram report ----------
{
  const sb = sandbox(), nw = await run(sb);
  const rep = newReport({ id: 'update-20261028-0600', now: NOW });
  rep.publish.runs.push({ status: 'quiet', entries_updated: [], entries_added: [], links_added: 0, news_added: 0, fields_changed: [], not_applied: [] });
  rep.news = nw;
  finalize(rep, { now: new Date('2026-10-28T06:02:00Z'), spend: null, month: null });
  ok('6 totals count leads; nothing published is not a change', rep.totals.news_leads === 2 && rep.totals.news_written === 0 && rep.changed === false);
  const plain = formatReport(rep), html = formatHtml(rep).text;
  ok('6 plain and phone reports list the leads as not published', /News leads: 2 \(.*\) — not published/.test(plain) && /<b>News leads \(2\)<\/b>\n<i>not published<\/i>/.test(html), plain + '\n' + html);
  const rep3 = newReport({ id: 'u', now: NOW }); rep3.news = { ...nw, feeds_failed: [{ id: 'nist-news', why: 'HTTP 403' }] };
  finalize(rep3, { now: NOW });
  ok('6 a feed that could not be read is a warning', /⚠️ 1 news feed could not be read: nist-news/.test(formatReport(rep3)) && formatHtml(rep3).text.startsWith('🟡'));
  const rep4 = newReport({ id: 'u', now: NOW }); finalize(rep4, { now: NOW });
  ok('6 no news section when the step did not run', !/News/.test(formatReport(rep4)) && !/News/.test(formatHtml(rep4).text));
  fs.rmSync(sb.dir, { recursive: true, force: true });
}

console.log(`news: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
