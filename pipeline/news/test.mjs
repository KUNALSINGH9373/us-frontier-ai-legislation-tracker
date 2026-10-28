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
import * as F from './feeds.mjs';
import * as L from './leads.mjs';
import * as W from './write.mjs';
import * as RUN from './run.mjs';
import * as P from './prompts.mjs';

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
const factoryOf = ({ screener = screenOf(), writer = writerOf(GOOD), checker = yesChecker(), referee = null } = {}) => ({ keyName: 'ANTHROPIC_API_KEY', made: { screener, writer, checker, referee }, make: (role) => ({ screener, generator: writer, validator: checker, referee })[role] || null });
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
const draft = (o) => draftNews({ maxAgeDays: 40, ...o }); // the recorded release is from Sept 22; the tests read it as of Oct 28

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

// ---------- 5. drafting from the official release ----------
{
  ok('5 the faithful draft passes every code check', checkNewsDraft({ draft: GOOD, release: RELEASE, lead: LEAD, today: TODAY }).length === 0, JSON.stringify(checkNewsDraft({ draft: GOOD, release: RELEASE, lead: LEAD, today: TODAY })));
  ok('5 claims are the title and each sentence', claimsOf(GOOD).length === 3 && claimsOf(GOOD)[0].field === 'title');
  const w = writerOf(GOOD), c = yesChecker();
  const r = await draft({ lead: LEAD, release: RELEASE, writer: w, checker: c, today: TODAY, runId: 'run-x', now: NOW, entryKind: 'federal' });
  ok('5 drafted in one round', r.outcome === 'drafted' && r.rounds === 1, JSON.stringify(r.problems));
  const it = r.item || {};
  ok('5 the item has the site\'s shape and fixed check line', it.check === 'From the official release (Rep. Sam Liccardo), quotes checked by code.' && it.origin === 'automated' && it.verification.method === 'agent' && it.verification.run_id === 'run-x' && it.tracker === null && it.links[0].u === RELEASE_URL && it.links[0].t === 'Rep. Sam Liccardo release, Sept 22');
  ok('5 its evidence quotes are in the release', it.evidence.length === 2 && it.evidence.every((x) => containsQuote(RELEASE, x.quote) && x.source_url === RELEASE_URL));
  ok('5 the second reader sees only the release and numbered claims', /^SOURCE:/.test(c.calls[0].prompt) && !c.calls[0].prompt.includes('EXAMPLES') && claimCount(c.calls[0].prompt) === 3);

  const quote = { ...GOOD, body: GOOD.body.replace('It would direct', 'Liccardo called it "a historic step for AI safety." It would direct') };
  ok('5 an invented quotation is refused by code', checkNewsDraft({ draft: quote, release: RELEASE, lead: LEAD, today: TODAY }).some((p) => /quotation marks that RELEASE does not contain: "a historic step/.test(p)));
  const rq = await draft({ lead: LEAD, release: RELEASE, writer: writerOf(quote), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 ...and stays refused after the rewrite round, even though the reader said yes', rq.outcome === 'rejected' && rq.rounds === 2 && !rq.item);
  const num = { ...GOOD, body: GOOD.body.replace('$100 million', '$200 million') };
  ok('5 an invented number is refused by code', checkNewsDraft({ draft: num, release: RELEASE, lead: LEAD, today: TODAY }).some((p) => /numbers not in RELEASE: 200/.test(p)));
  const rn = await draft({ lead: LEAD, release: RELEASE, writer: writerOf(num), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 ...and never drafted', rn.outcome === 'rejected');
  const fw = writerOf(quote, GOOD), rf = await draft({ lead: LEAD, release: RELEASE, writer: fw, checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 complaints go back word for word, and a fixed draft passes in round 2', rf.outcome === 'drafted' && rf.rounds === 2 && rf.item.verification.rounds === 2 && /YOUR PREVIOUS ITEM WAS REFUSED[\s\S]*a historic step/.test(fw.calls[1].prompt));
  const noChecker = scripted((req) => ({ results: Array.from({ length: claimCount(req.prompt) }, (_, i) => ({ n: i + 1, supported: i !== 2, quote: i !== 2 ? 'to establish U.S.-China coordination on frontier artificial intelligence safety' : null, reason: i === 2 ? 'RELEASE says the bill will be introduced, not that it was' : null })) }));
  const rc = await draft({ lead: LEAD, release: RELEASE, writer: writerOf(GOOD), checker: noChecker, today: TODAY, runId: 'r', now: NOW });
  ok('5 a claim the second reader does not confirm is refused', rc.outcome === 'rejected' && /body\[1\].*not supported: RELEASE says/.test(rc.reason), rc.reason);
  const fakeQuoteChecker = scripted((req) => ({ results: Array.from({ length: claimCount(req.prompt) }, (_, i) => ({ n: i + 1, supported: true, quote: 'the bill passed the House' })) }));
  ok('5 a reader\'s "yes" with a quote not in the release does not count', (await draft({ lead: LEAD, release: RELEASE, writer: writerOf(GOOD), checker: fakeQuoteChecker, today: TODAY, runId: 'r', now: NOW })).outcome === 'rejected');
  ok('5 a date neither in the release nor the feed is refused; so is a future one', checkNewsDraft({ draft: { ...GOOD, date: '2026-09-21' }, release: RELEASE, lead: LEAD, today: TODAY }).some((p) => /neither in RELEASE/.test(p)) && checkNewsDraft({ draft: { ...GOOD, date: '2026-11-02' }, release: RELEASE, lead: { ...LEAD, date: '2026-11-02' }, today: TODAY }).some((p) => /future/.test(p)));
  ok('5 a date without its year is refused', checkNewsDraft({ draft: { ...GOOD, body: GOOD.body.replace('Sept 22, 2026', 'Sept 22') }, release: RELEASE, lead: LEAD, today: TODAY }).some((p) => /without its year/.test(p)));
  const chk = (body) => checkNewsDraft({ draft: { ...GOOD, body }, release: RELEASE, lead: LEAD, today: TODAY });
  ok('5 a date in the body that is not in the release is refused (release date vs event date)', chk(GOOD.body.replace('Sept 22, 2026', 'Sept 22, 2026, with a hearing on Oct 5, 2026,')).some((p) => /2026-10-05 written in the item is not in RELEASE/.test(p)));
  ok('5 ... the release\'s own date and the feed\'s listing date pass', chk(GOOD.body).length === 0 && chk(GOOD.body.replace('Sept 22, 2026', 'Sept 25, 2026')).length === 0);
  const red = 'By establishing red lines now';
  ok('5 a quotation given to the person the release gives it to passes', chk(`${GOOD.body} "${red}," Liccardo said.`).length === 0, JSON.stringify(chk(`${GOOD.body} "${red}," Liccardo said.`)));
  ok('5 ... given to someone else is refused', chk(`${GOOD.body} "${red}," Kiley said.`).some((p) => /given to Kiley/.test(p)) && chk(`${GOOD.body} Rep. Kevin Kiley said "${red}".`).some((p) => /given to Kiley/.test(p)));
  ok('5 a statement sourced to a press outlet the release does not name is refused', chk(`${GOOD.body} According to Politico, the bill has support.`).some((p) => /"Politico", whom RELEASE does not name/.test(p)) && chk(`${GOOD.body} Axios reported the bill has support.`).some((p) => /"Axios"/.test(p)));
  const own = await draft({ lead: LEAD, release: RELEASE, writer: writerOf({ ...GOOD, check: 'Official statement, verified.' }), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 the check line is code\'s, never the writer\'s', own.item && own.item.check === checkLine(LEAD.publisher));
  const sw = writerOf(GOOD), rs =await draft({ lead: { ...LEAD, primary: false }, release: RELEASE, writer: sw, checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 a press (secondary) lead is never written, and the writer is never asked', rs.outcome === 'secondary' && sw.calls.length === 0);
  const nn = await draft({ lead: LEAD, release: RELEASE, writer: writerOf({ newsworthy: false }), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW });
  ok('5 a release the writer finds off-topic is not drafted', nn.outcome === 'not_newsworthy');
  const down = await draft({ lead: LEAD, release: RELEASE, writer: scripted(() => Object.assign(new Error('HTTP 529'), { name: 'HttpError' })), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW }).catch((e) => ({ outcome: 'threw', e }));
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
  const added = after.news.items.find((x) => x.origin === 'automated' && x.tracker === null && x.date === '2026-09-22');
  ok('7 the item (its release names no tracked bill by number or name, so no tracker) is filed under its feed kind, federal', added && added.kind === 'federal' && added.check === checkLine('Rep. Sam Liccardo'));
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
  const before = { ...loadData(realData), news: clone(NEWS_BEFORE) }, item = (await draft({ lead: LEAD, release: RELEASE, writer: writerOf(GOOD), checker: yesChecker(), today: TODAY, runId: 'r', now: NOW })).item;
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

// ---------- 12. the audit of 28 Oct 2026 (lane2-news-scratch): each finding, as a case that failed before the fix ----------
const t = async (name, fn) => { let r; try { r = await fn(); } catch (e) { r = false; name += ` (threw: ${String(e.message).slice(0, 120)})`; } ok(name, r === true, typeof r === 'string' ? r : ''); };
const pad = (s) => s + '\nIssues:\nInnovation\n' + ' '.repeat(0);
// A Lieu release about H.R. 9917 (shape of the real ones), an off-topic Liccardo release naming H.R. 9917 in passing.
const KILL = pad('REPS LIEU AND MORAN INTRODUCE BILL TO REQUIRE KILL SWITCH FOR AI SYSTEMS\nTuesday, October 20, 2026\nWASHINGTON – Today, Reps. Ted Lieu (D-CA) and Jared Moran (R-KS) introduced H.R. 9917, the AI Kill Switch Act, which would require developers of the most capable artificial intelligence systems to build a way to shut them down. "We need a kill switch for AI systems that can cause catastrophic harm," said Lieu. The bill would direct the Department of Commerce to set standards for the shutdown capability.');
const KILL_LEAD = { id: 'k1', key: 'lieu.house.gov/kill', source_id: 'rep-lieu', publisher: 'Rep. Ted Lieu', kind: 'federal', sponsor: 'Lieu', primary: true, title: 'REPS LIEU AND MORAN INTRODUCE BILL', link: 'https://lieu.house.gov/media-center/press-releases/kill', release_url: 'https://lieu.house.gov/media-center/press-releases/kill', date: '2026-10-20', tracker: null, matches: [] };
const KILL_DRAFT = { newsworthy: true, date: '2026-10-20', title: 'Reps. Lieu and Moran introduce H.R. 9917, the AI Kill Switch Act', body: 'Reps. Ted Lieu (D-CA) and Jared Moran (R-KS) introduced H.R. 9917, the AI Kill Switch Act, on Oct 20, 2026. It would require developers of the most capable artificial intelligence systems to build a way to shut them down.', evidence: [{ quote: 'introduced H.R. 9917, the AI Kill Switch Act' }] };
const PASSING = pad('Rep. Liccardo Introduces Bill to Expand Apprenticeships in Advanced Manufacturing\nTuesday, October 20, 2026\nWASHINGTON – Today, Rep. Sam Liccardo (D-CA) introduced a bill to expand apprenticeships in advanced manufacturing across Silicon Valley. Liccardo has previously spoken about H.R. 9917, the AI Kill Switch Act, and about artificial intelligence and jobs. The bill would fund training grants for community colleges.');
const PASSING_DRAFT = { newsworthy: true, date: '2026-10-20', title: 'Rep. Liccardo introduces a bill to expand apprenticeships in advanced manufacturing', body: 'Rep. Sam Liccardo (D-CA) introduced a bill on Oct 20, 2026 to expand apprenticeships in advanced manufacturing across Silicon Valley.', evidence: [{ quote: 'introduced a bill to expand apprenticeships in advanced manufacturing' }] };
// A second reader that confirms every item claim with `quote`, and answers "This release is about ..." with `about` (true/false).
const readerOf = (quote, about) => scripted((req) => ({ results: [...req.prompt.matchAll(/^(\d+)\. \[([^\]]+)\] (.*)$/gm)].map((m) => (/This release is about/.test(m[3]) ? { n: +m[1], supported: about, quote: about ? quote : null, reason: about ? null : 'mentioned in passing only' } : { n: +m[1], supported: true, quote, reason: null })) }));
// The fixture's H.R. 9917 release is a fresh introduction on Oct 20, so its record (a copy of the real entries) shows that event: a
// dated bill event must agree with the entry's record (write.mjs eventDisagreements). The real record is used where that is the point.
const entries12 = clone(entries); entries12.find((e) => e.key === 'h-r-9917-ai-kill-switch-act').events.push({ date: '2026-10-20', precision: 'day', type: 'Introduced / published', text: 'Oct 20, 2026', clause: 'Oct 20, 2026', inferred_year: false, scheduled: false });
const ix12 = entryIndex(entries12), kindOf = () => 'federal';
const d12 = (o) => draftNews({ today: TODAY, runId: 'r', now: NOW, index: ix12, kindOf, maxAgeDays: 14, ...o });
{
  // 1. entry matching
  await t('12.1 an off-topic release on a sponsor\'s feed gets no tracker, even when its lead carried the sponsor\'s entry', async () => { const r = await d12({ lead: { ...LEAD, date: '2026-10-20', tracker: LICCARDO_KEY }, release: PASSING, writer: writerOf(PASSING_DRAFT), checker: readerOf('introduced a bill to expand apprenticeships in advanced manufacturing', false) }); return r.outcome === 'drafted' && r.item.tracker === null || JSON.stringify(r.item ? r.item.tracker : r.reason); });
  await t('12.1 a bill named in passing is only a candidate: the second reader is asked "This release is about H.R. 9917 ..." and says no, so no tracker', async () => { const c = readerOf('introduced a bill to expand apprenticeships in advanced manufacturing', false); const r = await d12({ lead: { ...LEAD, date: '2026-10-20', tracker: 'h-r-9917-ai-kill-switch-act' }, release: PASSING, writer: writerOf(PASSING_DRAFT), checker: c }); return r.outcome === 'drafted' && r.item.tracker === null && /This release is about H\.R\. 9917/.test(c.calls[0].prompt); });
  await t('12.1 a release that is about the bill, confirmed with a quote from the release, carries the tracker', async () => { const r = await d12({ lead: KILL_LEAD, release: KILL, writer: writerOf(KILL_DRAFT), checker: readerOf('introduced H.R. 9917, the AI Kill Switch Act', true) }); return r.outcome === 'drafted' && r.item.tracker === 'h-r-9917-ai-kill-switch-act' || JSON.stringify(r.problems || r.reason); });
  await t('12.1 the about-claim names the bill as the release writes it (by name only here, no number the release does not give)', async () => { const c = readerOf('introduced the AI Kill Switch Act', true); const rel = KILL.replace('introduced H.R. 9917, the AI Kill Switch Act', 'introduced the AI Kill Switch Act'); const r = await d12({ lead: KILL_LEAD, release: rel, writer: writerOf({ ...KILL_DRAFT, title: 'Reps. Lieu and Moran introduce the AI Kill Switch Act', body: 'Reps. Ted Lieu (D-CA) and Jared Moran (R-KS) introduced the AI Kill Switch Act on Oct 20, 2026.', evidence: [{ quote: 'introduced the AI Kill Switch Act' }] }), checker: c }); return /This release is about the AI Kill Switch Act: its main subject/.test(c.calls[0].prompt) && !/This release is about H\.R/.test(c.calls[0].prompt) && r.item && r.item.tracker === 'h-r-9917-ai-kill-switch-act' || JSON.stringify(r.problems || r.reason); });
  await t('12.1 a "yes" on the about-claim without a quote found in the release gives no tracker', async () => { const c = scripted((req) => ({ results: [...req.prompt.matchAll(/^(\d+)\. \[([^\]]+)\] (.*)$/gm)].map((m) => ({ n: +m[1], supported: true, quote: /This release is about/.test(m[3]) ? 'the release is about the AI Kill Switch Act' : 'introduced H.R. 9917, the AI Kill Switch Act' })) })); const r = await d12({ lead: KILL_LEAD, release: KILL, writer: writerOf(KILL_DRAFT), checker: c }); return r.outcome === 'drafted' && r.item.tracker === null; });
  await t('12.1 "Nevada SB 53" is not California\'s SB 53', () => matchEntries({ title: 'Attorney General Bonta urges Nevada SB 53 to align with California privacy law' }, ix12).tracker === null && matchEntries({ title: 'Nevada SB 53 advances' }, ix12).matches.length === 0);
  await t('12.1 on California\'s own feed, a release about "Nevada Senate Bill 53 (SB 53)" never matches California\'s SB 53, even where it writes "SB 53" bare', () => { const txt = 'California Attorney General Rob Bonta today sent a comment letter to the Nevada Attorney General regarding the implementation of Nevada Senate Bill 53 (SB 53), a Nevada law on consumer health data. SB 53 took effect July 1, 2026.'; return matchEntries({ text: txt, state: 'CA' }, ix12).tracker === null && L.releaseTracker({ release: txt, index: ix12, state: 'CA' }) === null && L.releaseTracker({ release: 'Bonta today enforced SB 53 against a frontier developer.', index: ix12, state: 'CA' }).key === 'ca-sb-53-tfaia'; });
  await t('12.1 a state bill number matches with its own state written next to it, or on that state\'s own feed', () => matchEntries({ title: 'California SB 53 report published' }, ix12).tracker === 'ca-sb-53-tfaia' && matchEntries({ title: 'Bonta enforces SB 53 against a developer', state: 'CA' }, ix12).tracker === 'ca-sb-53-tfaia' && matchEntries({ title: 'Politico: SB 53 in the news' }, ix12).tracker === null);
  await t('12.1 a federal number never matches a state entry ("H.R. 637" is not Pennsylvania\'s House resolution) unless the state is written', () => matchEntries({ title: 'Congress takes up H.R. 637 on AI' }, ix12).tracker === null && matchEntries({ title: 'Pennsylvania H.R. 637 adopted' }, ix12).tracker === 'pa-h-r-637-frontier-ai-resolution');
  await t('12.1 bare "S 2938", "A 5275" and the "S." of "U.S." are not bill numbers', () => billNumbers('S 2938 and A 5275').size === 0 && billNumbers('the U.S. 2026 plan').size === 0 && billNumbers('S. 2938 and A.5275').has('S2938'));

  // 2. press reposts
  const lieuSrc = { id: 'rep-lieu', url: 'https://lieu.house.gov/rss.xml', type: 'rss', publisher: 'Rep. Ted Lieu', primary: true, sponsor: 'Lieu', secondary_paths: JSON.parse(read('../../config/news-sources.json')).sources.find((s) => s.id === 'rep-lieu').secondary_paths };
  const repostItem = { title: '‘Bumper sticker bill’: AI kill switch rides the midterm elections wave', link: 'https://lieu.house.gov/node/9001', date: '2026-10-23', summary: '', links: ['https://lieu.house.gov/media-center/in-the-news/bumper-sticker-bill-ai-kill-switch-rides-midterm-elections-wave'] };
  await t('12.2 an "In the News" repost is press, tested on the release link as well as the feed link', () => L.isPrimary(lieuSrc, repostItem) === false && L.isPrimary(lieuSrc, { ...repostItem, link: repostItem.links[0], links: [] }) === false && L.isPrimary(lieuSrc, { ...repostItem, links: ['https://lieu.house.gov/media-center/press-releases/x'] }) === true);
  await t('12.2 every house.gov feed in the config treats /in-the-news/ as press', () => JSON.parse(read('../../config/news-sources.json')).sources.filter((s) => /house\.gov/.test(s.url)).every((s) => (s.secondary_paths || []).includes('/in-the-news/')));
  const REPOST = releaseText(read('lieu-in-the-news.html'));
  await t('12.2 a reposted press story (byline, outlet, "In The News") is never written, even reached by a path the config misses', async () => { const w = writerOf(GOOD); const r = await d12({ lead: { ...KILL_LEAD, date: '2026-10-23' }, release: REPOST, writer: w, checker: yesChecker() }); return r.outcome === 'secondary' && w.calls.length === 0; });
  await t('12.2 the official release itself is not taken for a repost', () => F.pressRepost(RELEASE) === false && F.pressRepost(KILL) === false && F.pressRepost(releaseText(read('release-nist-key-practices.html'))) === false);

  // 3. duplicates
  const item = (await d12({ lead: KILL_LEAD, release: KILL, writer: writerOf(KILL_DRAFT), checker: readerOf('introduced H.R. 9917, the AI Kill Switch Act', true) })).item;
  await t('12.3 the same release by another form of its URL is a duplicate', () => !!W.duplicateOf(item, [{ date: '2026-10-01', title: 'Something else entirely', body: 'x', links: [{ t: 'x', u: 'http://www.lieu.house.gov/media-center/press-releases/kill/?utm_source=feed' }] }]));
  await t('12.3 a sponsor\'s release the day after the Lane 1 record item on the same bill and event is a duplicate', () => !!W.duplicateOf(item, [{ date: '2026-10-19', kind: 'federal', tracker: 'h-r-9917-ai-kill-switch-act', origin: 'automated', title: 'H.R. 9917 introduced in the House', body: 'Congress.gov records that H.R. 9917 was introduced on Oct 19, 2026.', links: [{ t: 'Congress.gov', u: 'https://www.congress.gov/bill/119th-congress/house-bill/9917' }] }]));
  await t('12.3 the same event from two feeds (no tracker, near-identical words) is a duplicate', () => !!W.duplicateOf({ ...item, tracker: null }, [{ date: '2026-10-21', tracker: null, title: 'Reps. Lieu and Moran introduce the AI Kill Switch Act, H.R. 9917', body: 'Reps. Ted Lieu and Jared Moran introduced H.R. 9917, the AI Kill Switch Act, on Oct 20, 2026; it would require developers of the most capable artificial intelligence systems to build a way to shut them down.', links: [{ t: 'x', u: 'https://moran.house.gov/r/1' }] }]));
  await t('12.3 a different event on the same bill (a hearing) is not a duplicate', () => W.duplicateOf(item, [{ date: '2026-10-22', tracker: 'h-r-9917-ai-kill-switch-act', title: 'House Science holds a hearing on the AI Kill Switch Act', body: 'The committee heard testimony.', links: [{ t: 'x', u: 'https://science.house.gov/h' }] }]) === null);

  // 4. freshness from the release's own date
  const LETTER_HTML = read('release-liccardo-letter.html'), LETTER = releaseText(LETTER_HTML);
  await t('12.4 the release\'s own date is read', () => F.releaseDate(LETTER) === '2026-09-16' && F.releaseDate(RELEASE) === '2026-09-22' && F.releaseDate(releaseText(read('release-nist-key-practices.html'))) === '2026-10-16');
  const LETTER_DRAFT = { newsworthy: true, date: '2026-09-16', title: '107 House Democrats ask Speaker Johnson to cancel the recess to vote on AI safeguards', body: 'Reps. Sam Liccardo, George Whitesides, Ted Lieu and Lori Trahan led a letter, released Sept 16, 2026, in which 107 House Democrats demanded Speaker Mike Johnson cancel the upcoming recess to vote on legislation creating AI safeguards.', evidence: [{ quote: '107 House Democrats demanded Speaker Mike Johnson cancel the upcoming recess' }] };
  const LETTER_LEAD = { id: 'l1', key: 'liccardo.house.gov/letter', source_id: 'rep-liccardo', publisher: 'Rep. Sam Liccardo', kind: 'federal', sponsor: 'Liccardo', primary: true, title: 'Over a Hundred House Democrats Demand Congress Stay in Session to Confront AI Crisis', link: 'https://liccardo.house.gov/media/press-releases/over-hundred-house-democrats-demand-congress-stay-session-confront-ai-crisis', release_url: 'https://liccardo.house.gov/media/press-releases/over-hundred-house-democrats-demand-congress-stay-session-confront-ai-crisis', date: '2026-09-16', tracker: null, matches: [] };
  const letterReader = () => readerOf('107 House Democrats demanded Speaker Mike Johnson cancel the upcoming recess', false);
  await t('12.4 a Sept 16 release that the feed lists on Sept 25 is old news re-listed: refused', async () => { const r = await d12({ lead: { ...LETTER_LEAD, date: '2026-09-25' }, release: LETTER, writer: writerOf(LETTER_DRAFT), checker: letterReader(), today: '2026-09-26' }); return r.outcome === 'rejected' && /re-listed/.test(r.reason) || r.outcome; });
  await t('12.4 a release older than the window is refused whatever its feed date', async () => { const r = await d12({ lead: { ...LETTER_LEAD, date: '2026-10-27' }, release: LETTER, writer: writerOf(LETTER_DRAFT), checker: letterReader(), today: TODAY }); return r.outcome === 'rejected' && /older than the 14-day window/.test(r.reason) || r.outcome; });
  await t('12.4 a release with no date of its own is refused (freshness cannot be checked)', async () => { const r = await d12({ lead: KILL_LEAD, release: KILL.replace('Tuesday, October 20, 2026\n', ''), writer: writerOf(KILL_DRAFT), checker: yesChecker() }); return r.outcome === 'rejected' && /no date of its own/.test(r.reason); });
  await t('12.4 an item dated more than 7 days before its feed date is refused by code', () => checkNewsDraft({ draft: GOOD, release: RELEASE, lead: { ...LEAD, date: '2026-10-05' }, today: TODAY }).some((p) => /more than 7 days before/.test(p)));
  await t('12.4 the fresh letter, listed the day it was released, is drafted', async () => { const r = await d12({ lead: LETTER_LEAD, release: LETTER, writer: writerOf(LETTER_DRAFT), checker: letterReader(), today: '2026-09-20' }); return r.outcome === 'drafted' || JSON.stringify(r.problems || r.reason); });

  // 5. over-refusal: examples, prompt, and a second opinion before an AI-safety release on a member feed is dropped for good
  await t('12.5 the writer\'s examples include the letters the site publishes', () => { const ex = RUN.examplesFrom(NEWS_REAL.items); return ex.length >= 5 && ex.some((x) => /\b(ask|urge|demand)/i.test(x.title) && !/introduc/i.test(x.title)) || JSON.stringify(ex.map((x) => x.title)); });
  await t('12.5 the writer prompt says letters by members on AI safety are news', () => /letters and demands by members of Congress/.test(P.WRITER_SYSTEM) && /however many members sign/.test(P.WRITER_SYSTEM));
  const LETTER_URL = LETTER_LEAD.release_url;
  const letterFeed = `<rss><channel><item><title>${LETTER_LEAD.title}</title><link>${LETTER_URL}</link><pubDate>Wed, 16 Sep 2026 15:00:00 +0000</pubDate><description>Letter on AI safeguards</description></item></channel></rss>`;
  const LSRC = { user_agent: 'test', sources: [{ id: 'rep-liccardo', url: 'https://liccardo.house.gov/rss.xml', type: 'rss', publisher: 'Rep. Sam Liccardo', primary: true, kind: 'federal', sponsor: 'Liccardo' }] };
  const letterRun = (factory) => { const sb = sandbox(); return newsRun({ dataDir: sb.dataDir, docsDir: sb.docsDir, seenFile: sb.seenFile, config: { ...CONFIG(false), news_leads: { enabled: true, max_age_days: 14, max_drafts_per_run: 3, max_rounds: 2 } }, sources: LSRC, factory, today: '2026-09-20', now: NOW, runId: 'u', reader: fakeReader({ 'https://liccardo.house.gov/rss.xml': letterFeed, [LETTER_URL]: LETTER_HTML }) }).then((r) => ({ r, seen: JSON.parse(fs.readFileSync(sb.seenFile, 'utf8')).items })); };
  await t('12.5 an AI-safety letter the writer calls not newsworthy gets one second opinion (referee), which drafts it', async () => { const referee = writerOf(LETTER_DRAFT); const { r } = await letterRun(factoryOf({ screener: screenOf([/Hundred/]), writer: writerOf({ newsworthy: false }), checker: letterReader(), referee })); return referee.calls.length === 1 && r.drafted.length === 1 || JSON.stringify({ calls: referee.calls.length, d: r.drafted, l: r.leads }); });
  await t('12.5 ... when the referee also says no, it is marked seen as refereed', async () => { const { r, seen } = await letterRun(factoryOf({ screener: screenOf([/Hundred/]), writer: writerOf({ newsworthy: false }), checker: letterReader(), referee: writerOf({ newsworthy: false }) })); const s = Object.values(seen).find((v) => /Hundred/.test(v.title)); return r.drafted.length === 0 && s && s.outcome === 'not_newsworthy' && s.refereed === true && !s.retry; });
  await t('12.5 ... and with no referee available it is not lost: retried on a later run', async () => { const { seen } = await letterRun(factoryOf({ screener: screenOf([/Hundred/]), writer: writerOf({ newsworthy: false }), checker: letterReader() })); const s = Object.values(seen).find((v) => /Hundred/.test(v.title)); return !!s && s.retry === true; });

  // 6. CAISI coverage
  const CAISSI = read('nist-caissi.html'), teasers = F.parseTeaserPage ? F.parseTeaserPage(CAISSI, 'https://www.nist.gov/caissi') : [];
  await t('12.6 the CAISI page (recorded 28 Oct 2026) is read like a feed: its posts with their own dates and full links', () => teasers.length === 8 && teasers.some((i) => i.link === 'https://www.nist.gov/news-events/news/2026/09/caisis-assessment-zais-glm-53-cyber-capabilities' && i.date === '2026-09-17' && /GLM-5\.3/.test(i.title)) && teasers.every((i) => /^\d{4}-\d\d-\d\d$/.test(i.date)) || JSON.stringify(teasers.slice(0, 2)));
  await t('12.6 the config reads the CAISI page, and leads come from it', async () => { const src = JSON.parse(read('../../config/news-sources.json')).sources.find((s) => s.type === 'html_teasers' && /nist\.gov\/caiss?i/.test(s.url)); if (!src || !src.primary) return false; const r = await findLeads({ sources: [src], fetchFeed: async (u, accept) => (u === src.url && /html/.test(accept || '') ? CAISSI : ''), news: [], entries, screener: null, today: TODAY, maxAgeDays: 14 }); return r.feeds[0].ok && r.leads.some((l) => /Incident Readiness/.test(l.title) && l.primary) || JSON.stringify(r.feeds); });

  // 7. release text and long releases
  const NIST = releaseText(read('release-nist-key-practices.html'));
  await t('12.7 a NIST page without <main>: the .gov banner, share buttons and feedback box are dropped, the article kept', () => /Today, NIST’s Center for Advancing Innovation/.test(NIST) && !/Skip to main content|Official websites use \.gov|Secure \.gov websites|^Share$|^Facebook$|Was this page helpful/m.test(NIST) || NIST.slice(0, 400));
  const LONG = KILL.replace('The bill would direct', 'x '.repeat(20500) + 'The bill would direct');
  const LONG_DRAFT = { ...KILL_DRAFT, body: KILL_DRAFT.body + ' It would direct the Department of Commerce to set standards for the shutdown capability.', evidence: [...KILL_DRAFT.evidence, { quote: 'direct the Department of Commerce to set standards for the shutdown capability' }] };
  await t('12.7 a release over 40,000 characters whose claim lies past the cut is refused as too long, not checked against the cut text', async () => { const r = await d12({ lead: KILL_LEAD, release: LONG, writer: writerOf(LONG_DRAFT), checker: readerOf('introduced H.R. 9917, the AI Kill Switch Act', true) }); return r.outcome === 'rejected' && /longer than 40000/.test(r.reason) || r.reason; });
  await t('12.7 ... a long release whose claims are all in the part read is still drafted', async () => { const r = await d12({ lead: KILL_LEAD, release: LONG, writer: writerOf(KILL_DRAFT), checker: readerOf('introduced H.R. 9917, the AI Kill Switch Act', true) }); return r.outcome === 'drafted'; });

  // the stop rules: the publish check backs up the tracker and duplicate rules
  const before = { ...loadData(realData), entries: entries12, news: clone(NEWS_BEFORE) }, line = () => checkLine('Rep. Ted Lieu');
  const add = (n) => checkNewsAdded({ before, after: { ...before, news: { ...before.news, items: [...before.news.items, n] } }, expected: [n], checkLine: line });
  await t('12.8 a news item whose tracker is not a tracked entry stops the run', () => add({ ...item, tracker: 'no-such-entry' }).some((p) => /not a tracked entry/.test(p)) && add({ ...item, tracker: 'texas-traiga-hb-149' }).some((p) => /not a tracked entry/.test(p)) && add(item).length === 0);
  const onPage = NEWS_BEFORE.items.find((n) => (n.links || []).length);
  await t('12.8 a news item repeating a release already on the page (by any form of its URL) stops the run', () => { const u = onPage.links[0].u.replace(/^https:\/\/(www\.)?/, 'http://') + '/'; const dupe = { ...item, links: [{ t: item.links[0].t, u }], evidence: item.evidence.map((x) => ({ ...x, source_url: u })) }; return add(dupe).some((p) => /already on the news page/.test(p)); });
}

// ---------- 13. the second audit (29 Oct 2026, l2r2-ln-scratch): each wrong output, as a case that failed before the fix ----------
{
  const lieuLead = (id, date) => ({ ...KILL_LEAD, id, key: `lieu.house.gov/${id}`, date, link: `https://lieu.house.gov/media-center/press-releases/${id}`, release_url: `https://lieu.house.gov/media-center/press-releases/${id}` });
  const licLead = (id, date) => ({ ...LETTER_LEAD_13, id, key: `liccardo.house.gov/${id}`, date, link: `https://liccardo.house.gov/media/press-releases/${id}`, release_url: `https://liccardo.house.gov/media/press-releases/${id}` });
  const LETTER_LEAD_13 = { id: 'x', source_id: 'rep-liccardo', publisher: 'Rep. Sam Liccardo', kind: 'federal', sponsor: 'Liccardo', primary: true, title: 'x', tracker: null, matches: [] };
  const itemOf13 = (o) => ({ kind: 'federal', tracker: null, origin: 'automated', links: [{ t: 'x', u: `https://example.house.gov/${o.date}/${o.title.length}` }], ...o });
  const N4 = pad('REPS LIEU AND MORAN INTRODUCE BILL TO REQUIRE KILL SWITCH FOR AI SYSTEMS THAT CAN CAUSE CATASTROPHIC HARM\nOctober 25, 2026\nWASHINGTON – Today, Congressmen Ted W. Lieu (D-Los Angeles County) and Nathaniel Moran (R-TX) introduced H.R. 9917, the AI Kill Switch Act, which would require developers of covered frontier AI systems to maintain the ability to promptly shut down those systems.\n"If an AI system starts causing catastrophic harm, we need to be able to turn it off," said Lieu.\nThe bill would direct the Secretary of Commerce to set standards for shutdown capabilities and would apply to developers whose models were trained using more than 10^26 operations.');
  const N4_DRAFT = { newsworthy: true, date: '2026-10-25', title: 'Lieu and Moran introduce H.R. 9917, the AI Kill Switch Act, requiring frontier AI shutdown capability', body: 'Reps. Ted Lieu and Nathaniel Moran introduced H.R. 9917, the AI Kill Switch Act, on Oct 25, 2026. The bill would require developers of covered frontier AI systems to maintain the ability to promptly shut down those systems.', evidence: [{ quote: 'introduced H.R. 9917, the AI Kill Switch Act' }] };
  await t('13.1 N4: a release dated Oct 25 saying "Today ... introduced H.R. 9917", when the record shows it introduced months earlier, is refused before any writing', async () => { const w = writerOf(N4_DRAFT); const r = await d12({ lead: lieuLead('n4', '2026-10-25'), release: N4, writer: w, checker: readerOf('introduced H.R. 9917, the AI Kill Switch Act', true), today: TODAY }); return r.outcome === 'rejected' && /records no "Introduced \/ published" event/.test(r.reason) && w.calls.length === 0 || JSON.stringify(r.reason); });
  await t('13.1 ... the same with no tracker candidate at all: the bill number alone, in its jurisdiction, finds the entry', () => W.eventDisagreements({ text: N4, date: '2026-10-25', index: ix12 }).length === 1 && W.eventDisagreements({ text: N4.replace(/H\.R\. 9917/g, 'Pennsylvania H.R. 9917'), date: '2026-10-25', index: ix12 }).length === 0);
  await t('13.1 ... an item stating the re-dated introduction is refused by code, and by the publish check', () => { const it = itemOf13({ date: '2026-10-25', title: N4_DRAFT.title, body: N4_DRAFT.body }); return W.eventDisagreements({ text: `${it.title}. ${it.body}`, date: it.date, index: ix12 }).length > 0 && W.eventDisagreements({ text: N4_DRAFT.body, date: '2026-10-25', index: entryIndex(entries) }).length > 0; });
  await t('13.1 ... an event that agrees with the record within 3 days passes; a description without a date ("introduced by Reps. ...") is not an event claim', () => W.eventDisagreements({ text: N4.replace('October 25, 2026', 'October 22, 2026'), date: '2026-10-22', index: ix12 }).length === 0 && W.eventDisagreements({ text: 'H.R. 9917, the AI Kill Switch Act, introduced by Reps. Ted Lieu and Nathaniel Moran, would require a shutdown capability.', date: '2026-10-25', index: ix12 }).length === 0 && W.eventDisagreements({ text: 'Reps. Lieu and Jacobs welcomed the introduction of a Senate companion to H.R. 9917 today.', date: '2026-10-21', index: ix12 }).length === 0);
  await t('13.1 ... a release saying a tracked bill was signed into law, which its record does not show, is refused', () => W.eventDisagreements({ text: 'The release confirms that H.R. 9917, the AI Kill Switch Act, was signed into law on October 17, 2026.', date: '2026-10-17', index: ix12 }).some((p) => /Signed \/ enacted/.test(p)));

  await t('13.1 ... a Nevada bill written bare later in a California release ("Nevada Assembly Bill 1405 (AB 1405)" ... "AB 1405 was introduced") is never read against California\'s entry', () => { const ix = entryIndex(entries); const txt = 'Attorney General Bonta today submitted comments on Nevada Assembly Bill 1405 (AB 1405), a Nevada bill on AI auditors. AB 1405 was introduced in the Nevada Assembly on October 6, 2026.'; return W.eventDisagreements({ text: txt, date: '2026-10-22', index: ix, state: 'CA' }).length === 0 && W.eventDisagreements({ text: 'Bonta said California AB 1405 was signed on October 6, 2026.', date: '2026-10-22', index: ix, state: 'CA' }).length === (ix.some((x) => x.jur === 'CA' && x.bills.has('AB1405') && !x.events.some((v) => v.type === 'Signed / enacted' && Math.abs(Date.parse(v.date) - Date.parse('2026-10-06')) <= 3 * 864e5)) ? 1 : 0); });
  const N5A = itemOf13({ date: '2026-10-26', title: 'Liccardo, Lieu and 40 members of Congress ask Commerce to publish frontier AI incident reports', body: 'Representatives Sam Liccardo and Ted Lieu led 40 Members of Congress in a letter to Commerce Secretary Howard Lutnick urging the Department to publish the AI incident reports it has received from frontier AI developers. The letter asks the Department to respond by November 20, 2026, and to explain whether CAISSI has reviewed the reports.' });
  const N5B = itemOf13({ date: '2026-10-26', title: 'Lieu and Liccardo lead 40 members in letter asking Lutnick to make AI incident reports public', body: 'Reps. Ted Lieu and Sam Liccardo sent a letter, signed by 40 Members of Congress, to Commerce Secretary Howard Lutnick on Oct 26, 2026, requesting that the Department of Commerce make public the incident reports frontier AI companies have submitted. The Members requested a response by Nov 20, 2026, and asked about the role of the Department\'s AI safety center in reviewing them.' });
  await t('13.2 N5a/N5b: one 40-member letter released by two offices, in other words and without a tracker, is one event', () => !!W.duplicateOf(N5B, [N5A]) && !!W.duplicateOf(N5A, [N5B]));
  const N11 = itemOf13({ date: '2026-09-23', title: 'Liccardo and Kiley announce bill directing State Department to pursue US-China frontier AI safety talks', body: 'Reps. Sam Liccardo and Kevin Kiley announced bipartisan legislation on Sept 22, 2026, directing the State Department to pursue U.S.–China talks on frontier AI safety and crisis communication for AI incidents. The legislation would require a State Department report to Congress within 180 days.' });
  const onPage13 = NEWS_REAL.items.find((n) => n.title === 'Liccardo and Kiley announce a US–China frontier-AI safety bill');
  await t('13.2 N11: a second release about the Sept 22 bill announcement already on the page (hand-written, with a tracker) is a duplicate', () => !!onPage13 && !!W.duplicateOf(N11, [onPage13]));
  const N8I = itemOf13({ date: '2026-10-21', title: 'Lieu and Jacobs welcome Senate companion to H.R. 9917, the AI Kill Switch Act', body: 'Reps. Ted Lieu and Sara Jacobs welcomed the introduction of a Senate companion to H.R. 9917, the AI Kill Switch Act, by Senator Elizabeth Warren. Warren introduced the Senate bill on Tuesday with four cosponsors.' });
  const N9I = itemOf13({ date: '2026-10-22', title: 'Lieu urges Congress to pass H.R. 9917, the AI Kill Switch Act', body: 'Rep. Ted Lieu urged Congress to pass the AI Kill Switch Act, H.R. 9917, which he and Rep. Nathaniel Moran wrote.' });
  const N3I = itemOf13({ date: '2026-10-24', title: 'Lieu introduces Chip Location Verification Act requiring location checks on advanced AI chip exports', body: 'On Oct 24, 2026, Rep. Ted Lieu introduced the Chip Location Verification Act. It would direct the Bureau of Industry and Security to issue rules within 180 days of enactment.' });
  await t('13.2 ... different events by the same member on nearby days are not duplicates (Senate companion vs. a call to pass; a different bill)', () => W.duplicateOf(N8I, [N9I]) === null && W.duplicateOf(N3I, [N8I, N9I, N5A, N5B]) === null && W.duplicateOf(N5A, [N3I, N8I]) === null);
  await t('13.2 ... the publish check refuses two added items reporting one event', () => { const b = { ...loadData(realData), entries: entries12, news: clone(NEWS_BEFORE) }; const a5 = { ...N5A, verification: { method: 'agent' }, check: 'c', evidence: [{ field: 'body', quote: 'q', source_url: N5A.links[0].u }] }, b5 = { ...N5B, verification: { method: 'agent' }, check: 'c', evidence: [{ field: 'body', quote: 'q', source_url: N5B.links[0].u }] }; return checkNewsAdded({ before: b, after: { ...b, news: { ...b.news, items: [...b.news.items, a5, b5] } }, expected: [a5, b5] }).some((p) => /same event/.test(p)); });

  const N6 = pad('Kill switch bill gains Republican backers as midterms near\nOctober 27, 2026\nBrendan Bordelon reports for Politico that the AI Kill Switch Act, H.R. 9917, introduced by Reps. Ted Lieu and Nathaniel Moran, has picked up 12 new Republican cosponsors in the past month, according to two House aides granted anonymity to discuss internal deliberations.\nAides expect House Energy and Commerce Committee Chair Brett Guthrie to schedule a markup in November, the people said, though no date has been set.');
  await t('13.3 N6: a Politico story ("reports for Politico") on a press-releases path is press, never written', async () => { const w = writerOf(N4_DRAFT); const r = await d12({ lead: lieuLead('n6', '2026-10-27'), release: N6, writer: w, checker: yesChecker() }); return r.outcome === 'secondary' && w.calls.length === 0; });
  await t('13.3 ... and "writes for The Hill", "according to Axios", "(c) 2026 POLITICO", "Gabby Miller, Politico", "Originally published in" are press too', () => [N6.replace('reports for Politico', 'writes for The Hill'), 'Title\nOctober 27, 2026\nAccording to Axios, the bill gained cosponsors.', 'Title\nOctober 27, 2026\nText.\n(c) 2026 POLITICO', 'Title\nGabby Miller, Politico\nText', 'Title\nText.\nOriginally published in Roll Call.'].every((x) => F.pressRepost(x)));
  await t('13.3 ... while the official releases are not', () => [RELEASE, KILL, N4, releaseText(read('release-nist-key-practices.html')), releaseText(read('release-liccardo-letter.html'))].every((x) => !F.pressRepost(x)));

  const N9 = pad('WHY CONGRESS MUST PASS THE AI KILL SWITCH ACT THIS YEAR\nOctober 22, 2026\nI have spent a decade warning about the risks of artificial intelligence. This fall, those risks stopped being hypothetical.\nThat is why Rep. Nathaniel Moran and I wrote H.R. 9917, the AI Kill Switch Act. In my view, every frontier developer should be able to shut down its most capable systems within minutes.\nCongress should pass this bill before the end of the year.\nTed W. Lieu represents California\'s 36th District.');
  await t('13.4 N9: a first-person op-ed on a press-releases path is a lead, never written', async () => { const w = writerOf(N4_DRAFT); const r = await d12({ lead: lieuLead('n9', '2026-10-22'), release: N9, writer: w, checker: yesChecker() }); return r.outcome === 'secondary' && /opinion/.test(r.reason) && w.calls.length === 0; });
  await t('13.4 ... a labelled column is a lead; releases and statements quoting a member in the first person are not opinion pieces', () => F.opinionPiece('Op-Ed\nAI needs rules\nBy Rep. X') && [RELEASE, KILL, N4, releaseText(read('release-liccardo-letter.html')), releaseText(read('release-nist-key-practices.html')), 'Statement\nOctober 17, 2026\nWASHINGTON – Congressman Ted W. Lieu issued the following statement: "I am glad. I have long said my bill is needed. I will keep pushing."'].every((x) => !F.opinionPiece(x)));

  const OPEN = 'Committee update on AI safety\nOn October 2, 2026, the committee held a hearing on frontier AI, and members discussed next steps at length.';
  await t('13.5 the release date: an event date in the opening sentence is not the release date unless it agrees with the feed date within 2 days', () => F.releaseDate(OPEN, '2026-10-20') === null && F.releaseDate(OPEN) === null && F.releaseDate(OPEN, '2026-10-03') === '2026-10-02');
  await t('13.5 ... a date line or a dateline is the release date', () => F.releaseDate('Title\nWASHINGTON, D.C., October 16, 2026 – Today, the members announced a bill.', '2026-10-25') === '2026-10-16' && F.releaseDate('Title\nOctober 16, 2026 – WASHINGTON – Today, x.', null) === '2026-10-16' && F.releaseDate(N4, null) === '2026-10-25');
  await t('13.5 ... a release whose only date is an event in its opening, far from the feed date, is held (refused), not dated by that event', async () => { const r = await d12({ lead: lieuLead('open', '2026-10-20'), release: pad(OPEN + ' More text about the frontier AI hearing and the bill follows here, with several more words to make it long enough to read as a release of its own.'), writer: writerOf(N4_DRAFT), checker: yesChecker() }); return r.outcome === 'rejected' && /no date of its own/.test(r.reason); });
}

console.log(`news: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
