// Run:  node news/test.mjs
// The news step with real feeds recorded on 28 Oct 2026 (fixtures/news/: Politico technology, NIST news, Rep. Liccardo's feed and the
// release it links to) and scripted models (no AI, no network), on a copy of the real site data. A checked draft from an official
// release is reported (switch off) or added (switch on); every way an item can be wrong (invented quote or number, a claim the second
// reader does not confirm, a press-only lead, a duplicate, an irrelevant headline, a stop rule) publishes nothing.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseFeed, robotsAllows, releaseText, linkKey, isoDate } from './feeds.mjs';
import { findLeads, matchEntries, entryIndex, billNumbers, releaseUrl, NEWS_TERMS } from './leads.mjs';
import { draftNews, checkNewsDraft, claimsOf, checkLine } from './write.mjs';
import { newsRun, createReader } from './run.mjs';
import { checkPublish, checkNewsAdded } from '../publish/guards.mjs';
import { loadData } from '../publish/run.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { containsQuote } from '../agents/source-text.mjs';
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
const RELEASE_HTML = read('release-liccardo.html'), RELEASE = releaseText(RELEASE_HTML);
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
const GOOD = { newsworthy: true, date: '2026-09-22', title: 'Reps. Liccardo and Kiley announce a US–China frontier-AI safety coordination bill',
  body: 'Reps. Sam Liccardo (D-CA) and Kevin Kiley (I-CA) announced on Sept 22, 2026 legislation "to establish U.S.-China coordination on frontier artificial intelligence safety." It would direct the State Department to seek negotiations with China and authorize $100 million for the Center for AI Standards and Innovation (CAISI).',
  evidence: [{ quote: 'to establish U.S.-China coordination on frontier artificial intelligence safety' }, { quote: 'Authorize $100 million for the Center for AI Standards and Innovation (CAISI)' }] };
const writerOf = (...drafts) => scripted((req, n) => clone(drafts[Math.min(n, drafts.length) - 1]));
const claimCount = (prompt) => (prompt.match(/^\d+\. \[/gm) || []).length;
const yesChecker = () => scripted((req) => ({ results: Array.from({ length: claimCount(req.prompt) }, (_, i) => ({ n: i + 1, supported: true, quote: 'to establish U.S.-China coordination on frontier artificial intelligence safety', reason: null })) }));
const factoryOf = ({ screener = screenOf(), writer = writerOf(GOOD), checker = yesChecker() } = {}) => ({ keyName: 'ANTHROPIC_API_KEY', made: { screener, writer, checker }, make: (role) => ({ screener, generator: writer, validator: checker })[role] || null });
const fakeReader = (extra = {}) => { const pages = { ...FEEDS, [RELEASE_URL]: RELEASE_HTML, ...extra }; let n = 0; return { got: [], used: () => n, async get(u) { n++; this.got.push(u); if (pages[u] instanceof Error) throw pages[u]; if (!(u in pages)) throw new Error(`HTTP 404 for ${u}`); return pages[u]; } }; };
const CONFIG = (on) => ({ max_entries_changed_per_run: 15, auto_publish: { news: on }, news_leads: { enabled: true, max_age_days: 40, max_drafts_per_run: 3, max_rounds: 2 } });

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-test-'));
  for (const d of ['data', 'docs']) {
    fs.mkdirSync(path.join(dir, d));
    for (const f of ['entries', 'site', 'changes', 'relationships']) if (fs.existsSync(path.join(realData, f + '.json'))) fs.copyFileSync(path.join(realData, f + '.json'), path.join(dir, d, f + '.json'));
    fs.writeFileSync(path.join(dir, d, 'news.json'), JSON.stringify(NEWS_BEFORE, null, 1));
  }
  return { dir, dataDir: path.join(dir, 'data'), docsDir: path.join(dir, 'docs'), seenFile: path.join(dir, 'state', 'news-seen.json') };
}
// The site already has the 22 Sept Liccardo item (written by hand). The sandboxes start from the news page as it was before it.
const NEWS_REAL = JSON.parse(fs.readFileSync(path.join(realData, 'news.json'), 'utf8'));
const NEWS_BEFORE = { ...NEWS_REAL, items: NEWS_REAL.items.filter((n) => !(n.links || []).some((l) => l.u === RELEASE_URL)) };
if (NEWS_BEFORE.items.length !== NEWS_REAL.items.length - 1) throw new Error('test expects the real news page to have the 22 Sept Liccardo item once');
const run = (sb, o = {}) => newsRun({ dataDir: sb.dataDir, docsDir: sb.docsDir, seenFile: sb.seenFile, config: CONFIG(false), sources: SOURCES, factory: factoryOf(), today: TODAY, now: NOW, runId: 'update-test', reader: fakeReader(), ...o });
const newsOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'news.json'), 'utf8'));
const LEAD = { id: 'abc', key: 'k', source_id: 'rep-liccardo', publisher: 'Rep. Sam Liccardo', kind: 'federal', primary: true, title: 'Liccardo Pushes for US-China Coordination on AI Safety', link: 'http://liccardo.house.gov/node/671', release_url: RELEASE_URL, date: '2026-09-25', tracker: LICCARDO_KEY, matches: [] };

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

// ---------- 2. robots.txt and release text ----------
{
  const R = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nDisallow: /*?f%5B*\nAllow: /private/press/\nDisallow: /*.pdf$\n';
  ok('2 robots: general rules apply, a named crawler\'s rules do not', robotsAllows(R, '/news/rss.xml') && !robotsAllows(R, '/private/x'));
  ok('2 robots: the longest rule wins, Allow beats a shorter Disallow', robotsAllows(R, '/private/press/r1'));
  ok('2 robots: wildcards and "$" (the real NIST and House patterns)', !robotsAllows(R, '/search?f%5B0%5D=1') && !robotsAllows(R, '/a/b.pdf') && robotsAllows(R, '/a/b.pdf?x=1') && robotsAllows('User-agent: *\nDisallow: /*/media/oembed\n', '/rss.xml'));
  ok('2 robots: no file or an empty one allows everything', robotsAllows('', '/x') && robotsAllows('User-agent: *\nDisallow:\n', '/x'));
  ok('2 release text keeps the release and drops the site menus', /Congressmen Sam Liccardo \(D-CA\) and Kevin Kiley \(I-CA\) will introduce legislation/.test(RELEASE) && /Authorize \$100 million/.test(RELEASE) && !/Skip to main content|Contact Me|Sign up/i.test(RELEASE), RELEASE.slice(0, 300));
}

// ---------- 3. matching headlines to tracked entries ----------
{
  const ix = entryIndex(entries);
  ok('3 bill numbers as headlines write them', ['HR9917', 'S2938', 'SB53'].every((b) => billNumbers('H.R. 9917, S. 2938 and SB 53').has(b)));
  ok('3 by bill number', matchEntries({ title: 'Hearing set on H.R. 9917' }, ix).tracker === 'h-r-9917-ai-kill-switch-act');
  ok('3 by the bill\'s own name', matchEntries({ title: 'House panel to mark up the AI Kill Switch Act' }, ix).tracker === 'h-r-9917-ai-kill-switch-act');
  ok('3 by sponsor, on the sponsor\'s own feed', matchEntries({ title: 'Liccardo Pushes for US-China Coordination on AI Safety', sponsor: 'Liccardo' }, ix).tracker === LICCARDO_KEY);
  ok('3 a sponsor\'s name with no AI word is no match', matchEntries({ title: 'Lieu visits a veterans home' }, ix).matches.length === 0);
  ok('3 several entries at the same level: matches listed, no tracker guessed', (() => { const m = matchEntries({ title: 'Obernolte and Lieu on AI' }, ix); return m.matches.length > 1 && m.tracker === null; })());
  ok('3 the code screen needs an AI word', NEWS_TERMS.test(PITCH) && !NEWS_TERMS.test('Zuckerberg considered leaving CA over wealth tax'));
}

// ---------- 4. leads: window, dedupe, screens ----------
{
  const news = clone(NEWS_BEFORE.items), pitch = parseFeed(FEEDS['https://rss.politico.com/technology.xml']).find((i) => i.title === PITCH);
  const screener = screenOf();
  const r = await findLeads({ sources: SOURCES.sources, fetchFeed: async (u) => FEEDS[u], news, entries, screener, today: TODAY, maxAgeDays: 40 });
  ok('4 the official release and the press story are leads', r.leads.length === 2 && r.leads.some((l) => l.primary && l.tracker === LICCARDO_KEY && l.release_url === RELEASE_URL) && r.leads.some((l) => !l.primary && l.title === PITCH), JSON.stringify(r.leads.map((l) => l.title)));
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

// ---------- 5. drafting from the official release ----------
{
  ok('5 the faithful draft passes every code check', checkNewsDraft({ draft: GOOD, release: RELEASE, lead: LEAD, today: TODAY }).length === 0, JSON.stringify(checkNewsDraft({ draft: GOOD, release: RELEASE, lead: LEAD, today: TODAY })));
  ok('5 claims are the title and each sentence', claimsOf(GOOD).length === 3 && claimsOf(GOOD)[0].field === 'title');
  const w = writerOf(GOOD), c = yesChecker();
  const r = await draftNews({ lead: LEAD, release: RELEASE, writer: w, checker: c, today: TODAY, runId: 'run-x', now: NOW, entryKind: 'federal' });
  ok('5 drafted in one round', r.outcome === 'drafted' && r.rounds === 1, JSON.stringify(r.problems));
  const it = r.item || {};
  ok('5 the item has the site\'s shape and fixed check line', it.check === 'From the official release (Rep. Sam Liccardo), quotes checked by code.' && it.origin === 'automated' && it.verification.method === 'agent' && it.verification.run_id === 'run-x' && it.tracker === LICCARDO_KEY && it.links[0].u === RELEASE_URL && it.links[0].t === 'Rep. Sam Liccardo release, Sept 22');
  ok('5 its evidence quotes are in the release', it.evidence.length === 2 && it.evidence.every((x) => containsQuote(RELEASE, x.quote) && x.source_url === RELEASE_URL));
  ok('5 the second reader sees only the release and numbered claims', /^SOURCE:/.test(c.calls[0].prompt) && !c.calls[0].prompt.includes('EXAMPLES') && claimCount(c.calls[0].prompt) === 3);

  const quote = { ...GOOD, body: GOOD.body.replace('It would direct', 'Liccardo called it "a historic step for AI safety." It would direct') };
  ok('5 an invented quotation is refused by code', checkNewsDraft({ draft: quote, release: RELEASE, lead: LEAD, today: TODAY }).some((p) => /quotation marks that RELEASE does not contain: "a historic step/.test(p)));
  const rq = await draftNews({ lead: LEAD, release: RELEASE, writer: writerOf(quote), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 ...and stays refused after the rewrite round, even though the reader said yes', rq.outcome === 'rejected' && rq.rounds === 2 && !rq.item);
  const num = { ...GOOD, body: GOOD.body.replace('$100 million', '$200 million') };
  ok('5 an invented number is refused by code', checkNewsDraft({ draft: num, release: RELEASE, lead: LEAD, today: TODAY }).some((p) => /numbers not in RELEASE: 200/.test(p)));
  const rn = await draftNews({ lead: LEAD, release: RELEASE, writer: writerOf(num), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 ...and never drafted', rn.outcome === 'rejected');
  const fw = writerOf(quote, GOOD), rf = await draftNews({ lead: LEAD, release: RELEASE, writer: fw, checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 complaints go back word for word, and a fixed draft passes in round 2', rf.outcome === 'drafted' && rf.rounds === 2 && rf.item.verification.rounds === 2 && /YOUR PREVIOUS ITEM WAS REFUSED[\s\S]*a historic step/.test(fw.calls[1].prompt));
  const noChecker = scripted((req) => ({ results: Array.from({ length: claimCount(req.prompt) }, (_, i) => ({ n: i + 1, supported: i !== 2, quote: i !== 2 ? 'to establish U.S.-China coordination on frontier artificial intelligence safety' : null, reason: i === 2 ? 'RELEASE says the bill will be introduced, not that it was' : null })) }));
  const rc = await draftNews({ lead: LEAD, release: RELEASE, writer: writerOf(GOOD), checker: noChecker, today: TODAY, runId: 'r', now: NOW });
  ok('5 a claim the second reader does not confirm is refused', rc.outcome === 'rejected' && /body\[1\].*not supported: RELEASE says/.test(rc.reason), rc.reason);
  const fakeQuoteChecker = scripted((req) => ({ results: Array.from({ length: claimCount(req.prompt) }, (_, i) => ({ n: i + 1, supported: true, quote: 'the bill passed the House' })) }));
  ok('5 a reader\'s "yes" with a quote not in the release does not count', (await draftNews({ lead: LEAD, release: RELEASE, writer: writerOf(GOOD), checker: fakeQuoteChecker, today: TODAY, runId: 'r', now: NOW })).outcome === 'rejected');
  ok('5 a date neither in the release nor the feed is refused; so is a future one', checkNewsDraft({ draft: { ...GOOD, date: '2026-09-21' }, release: RELEASE, lead: LEAD, today: TODAY }).some((p) => /neither in RELEASE/.test(p)) && checkNewsDraft({ draft: { ...GOOD, date: '2026-11-02' }, release: RELEASE, lead: { ...LEAD, date: '2026-11-02' }, today: TODAY }).some((p) => /future/.test(p)));
  ok('5 a date without its year is refused', checkNewsDraft({ draft: { ...GOOD, body: GOOD.body.replace('Sept 22, 2026', 'Sept 22') }, release: RELEASE, lead: LEAD, today: TODAY }).some((p) => /without its year/.test(p)));
  const sw = writerOf(GOOD), rs = await draftNews({ lead: { ...LEAD, primary: false }, release: RELEASE, writer: sw, checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 a press (secondary) lead is never written, and the writer is never asked', rs.outcome === 'secondary' && sw.calls.length === 0);
  const nn = await draftNews({ lead: LEAD, release: RELEASE, writer: writerOf({ newsworthy: false }), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 a release the writer finds off-topic is not drafted', nn.outcome === 'not_newsworthy');
  const down = await draftNews({ lead: LEAD, release: RELEASE, writer: scripted(() => Object.assign(new Error('HTTP 529'), { name: 'HttpError' })), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW }).catch((e) => ({ outcome: 'threw', e }));
  ok('5 an unexpected error is not swallowed as a draft', down.outcome !== 'drafted');
}

// ---------- 6. the whole step, switch off: drafted items are reported, nothing is written ----------
{
  const sb = sandbox(), before = fs.readFileSync(path.join(sb.dataDir, 'news.json'), 'utf8'), f = factoryOf();
  const r = await run(sb, { factory: f });
  ok('6 ran: one drafted, one press lead', r.ran && r.status === 'reported' && r.drafted.length === 1 && r.leads.length === 1 && r.leads[0].title === PITCH && /press report/.test(r.leads[0].note), JSON.stringify({ s: r.status, d: r.drafted, l: r.leads, p: r.problems }));
  ok('6 nothing written while news publishing is off', fs.readFileSync(path.join(sb.dataDir, 'news.json'), 'utf8') === before && r.drafted[0].written === false && !r.publishing);
  ok('6 only the official release was drafted (the writer saw one release)', f.made.writer.calls.length === 1 && f.made.writer.calls[0].prompt.includes(RELEASE_URL));
  const seen = JSON.parse(fs.readFileSync(sb.seenFile, 'utf8')).items;
  ok('6 leads and drafts are remembered', Object.values(seen).some((v) => v.outcome === 'lead' && v.title === PITCH) && Object.values(seen).some((v) => v.outcome === 'drafted'));
  const f2 = factoryOf(), r2 = await run(sb, { factory: f2 });
  ok('6 a second run reports nothing new and drafts nothing', r2.leads.length === 0 && r2.drafted.length === 0 && f2.made.writer.calls.length === 0 && r2.status === 'quiet');
}

// ---------- 7. switch on: the item is added, only added, and passes the stop rules ----------
{
  const sb = sandbox(), before = loadData(sb.dataDir);
  const r = await run(sb, { config: CONFIG(true) });
  ok('7 written', r.status === 'written' && r.drafted[0].written === true, JSON.stringify(r.problems));
  const after = loadData(sb.dataDir), docs = newsOf(sb.docsDir);
  ok('7 one item added, the rest unchanged', after.news.items.length === before.news.items.length + 1 && before.news.items.every((x) => after.news.items.some((y) => JSON.stringify(x) === JSON.stringify(y))));
  ok('7 the live copy matches', JSON.stringify(docs) === JSON.stringify(after.news));
  const added = after.news.items.find((x) => x.origin === 'automated' && x.tracker === LICCARDO_KEY && x.date === '2026-09-22');
  ok('7 the item is about the tracked bill, filed under federal', added && added.kind === 'federal' && added.check === checkLine('Rep. Sam Liccardo'));
  ok('7 the news file passes its schema and the cross-file checks', makeValidator().check('news', after.news).length === 0 && checkIntegrity(after).length === 0);
  ok('7 entries, site and change log untouched', ['entries', 'site', 'changes'].every((k) => JSON.stringify(before[k]) === JSON.stringify(after[k])));
  ok('7 the summary names the published item', /1 published/.test(r.summary) && r.summary.includes(added.title));

  const sb2 = sandbox(), d2 = loadData(sb2.dataDir);
  d2.news.items.push({ ...clone(added), title: 'An earlier item on the same day about the same bill' });
  fs.writeFileSync(path.join(sb2.dataDir, 'news.json'), JSON.stringify(d2.news));
  const r2 = await run(sb2, { config: CONFIG(true) });
  ok('7 a draft repeating an item already on the page (same bill, same day) is not added', r2.drafted.length === 0 && r2.duplicates >= 1 && newsOf(sb2.dataDir).items.length === d2.news.items.length);
}

// ---------- 8. the stop rules for news ----------
{
  const before = { ...loadData(realData), news: clone(NEWS_BEFORE) }, item = (await draftNews({ lead: LEAD, release: RELEASE, writer: writerOf(GOOD), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW })).item;
  const after = { ...before, news: { ...before.news, items: [...before.news.items, item] } };
  const line = () => checkLine('Rep. Sam Liccardo');
  ok('8 a drafted item passes both checks', checkNewsAdded({ before, after, expected: [item], checkLine: line }).length === 0 && checkPublish({ before, after, runDate: TODAY, maxEntries: 15 }).problems.length === 0, JSON.stringify(checkPublish({ before, after, runDate: TODAY, maxEntries: 15 }).problems.slice(0, 3)));
  const edited = clone(after); edited.news.items[0].body += ' Edited.';
  ok('8 editing an existing item stops the run', checkPublish({ before, after: edited, runDate: TODAY, maxEntries: 15 }).problems.some((p) => /news items deleted or edited/.test(p)));
  const extra = clone(after); extra.news.items.push({ ...clone(item), title: 'Something nobody drafted' });
  ok('8 an item this run did not draft stops the run', checkNewsAdded({ before, after: extra, expected: [item], checkLine: line }).some((p) => /not drafted by this run/.test(p)));
  const loose = clone(item); loose.check = 'Looks right.';
  ok('8 an item without the fixed check line stops the run', checkNewsAdded({ before, after: { ...before, news: { ...before.news, items: [...before.news.items, loose] } }, expected: [loose], checkLine: line }).some((p) => /fixed wording/.test(p)));
  const foreign = clone(item); foreign.evidence[0].source_url = 'https://www.politico.com/x';
  ok('8 evidence from a page other than the linked release stops the run', checkNewsAdded({ before, after: { ...before, news: { ...before.news, items: [...before.news.items, foreign] } }, expected: [foreign], checkLine: line }).some((p) => /own linked release/.test(p)));
  const ent = clone(after); ent.entries[0].mechanism += ' x';
  ok('8 the news step may not change an entry', checkNewsAdded({ before, after: ent, expected: [item], checkLine: line }).some((p) => /entries changed/.test(p)));
}

// ---------- 9. failures resolve themselves ----------
{
  const sb = sandbox(), f = factoryOf();
  const r = await run(sb, { factory: f, aiOff: 'dry run (no AI calls are made)', dry: true });
  ok('9 without AI: leads are still reported, nothing is drafted or remembered', r.leads.length > 2 && r.drafted.length === 0 && f.made.writer.calls.length === 0 && !fs.existsSync(sb.seenFile) && r.leads.some((l) => /not drafted: dry run/.test(l.note)));
  const sb2 = sandbox(), r2 = await run(sb2, { reader: fakeReader({ [RELEASE_URL]: new Error('HTTP 503 for liccardo.house.gov') }) });
  const s2 = JSON.parse(fs.readFileSync(sb2.seenFile, 'utf8')).items, rec = Object.values(s2).find((v) => /Liccardo/.test(v.title));
  ok('9 a release that cannot be read is reported and retried on a later run', r2.drafted.length === 0 && r2.leads.some((l) => /could not be read/.test(l.note)) && rec && rec.retry === true && rec.tries === 1, JSON.stringify(rec));
  const r3 = await run(sb2, { factory: factoryOf() });
  ok('9 ...and drafted when it can', r3.drafted.length === 1);
  const sb3 = sandbox(), r4 = await run(sb3, { config: { ...CONFIG(false), news_leads: { ...CONFIG(false).news_leads, max_drafts_per_run: 0 } } });
  ok('9 a lead over the per-run cap waits for the next run (not remembered)', r4.waiting === 1 && !Object.values(JSON.parse(fs.readFileSync(sb3.seenFile, 'utf8')).items).some((v) => /Liccardo Pushes/.test(v.title)), JSON.stringify(r4.drafted));
  const off = await run(sandbox(), { config: { auto_publish: { news: true } } });
  ok('9 the step can be turned off', !off.ran && /turned off/.test(off.skipped_why));
}

// ---------- 10. the polite reader ----------
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

// ---------- 11. the Telegram report ----------
{
  const sb = sandbox(), nw = await run(sb);
  const rep = newReport({ id: 'update-20261028-0600', now: NOW });
  rep.publish.runs.push({ status: 'quiet', entries_updated: [], entries_added: [], links_added: 0, news_added: 0, fields_changed: [], not_applied: [] });
  rep.news = nw;
  finalize(rep, { now: new Date('2026-10-28T06:02:00Z'), spend: null, month: null });
  ok('11 totals count leads and drafts; nothing published is not a change', rep.totals.news_leads === 1 && rep.totals.news_drafted === 1 && rep.totals.news_written === 0 && rep.changed === false);
  const plain = formatReport(rep), html = formatHtml(rep).text;
  ok('11 plain report: "News drafted" says it was not published, "News leads" names the story', /News drafted: 1 from official releases, not published \(news publishing is switched off\)/.test(plain) && /News leads: 1 \(Anthropic quietly pitches its own AI safety bill.*Politico\) — not published/.test(plain), plain);
  ok('11 phone report: both sections, short lines', /<b>News drafted \(1\)<\/b>\n<i>not published: switched off<\/i>/.test(html) && /<b>News leads \(1\)<\/b>\n<i>not published<\/i>\n▸ Anthropic quietly pitches its own…\n {6}<i>Politico<\/i>/.test(html), html);
  const sb2 = sandbox(), nw2 = await run(sb2, { config: CONFIG(true) });
  const rep2 = newReport({ id: 'u', now: NOW }); rep2.news = nw2;
  finalize(rep2, { now: NOW });
  ok('11 a published news item counts as a change', rep2.changed === true && rep2.totals.news_added === 1 && /from official releases, published/.test(formatHtml(rep2).text));
  const rep3 = newReport({ id: 'u', now: NOW }); rep3.news = { ...nw, feeds_failed: [{ id: 'nist-news', why: 'HTTP 403' }] };
  finalize(rep3, { now: NOW });
  ok('11 a feed that could not be read is a warning', /⚠️ 1 news feed could not be read: nist-news/.test(formatReport(rep3)) && formatHtml(rep3).text.startsWith('🟡'));
  const rep4 = newReport({ id: 'u', now: NOW }); finalize(rep4, { now: NOW });
  ok('11 no news section when the step did not run', !/News/.test(formatReport(rep4)) && !/News/.test(formatHtml(rep4).text));
}

console.log(`news: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
