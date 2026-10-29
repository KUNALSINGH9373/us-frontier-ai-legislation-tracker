// Run:  node news/test-events.mjs
// The news event model (news/events.mjs) over real official records (fixtures/news/sources/: a Congress.gov bill record, a LegiScan
// record and CourtListener docket entries, as the pipeline stores them): keys and dedupe, the date rules, confirmation over runs,
// corrections and withdrawals (never a deletion), statement attachment (+3 days, key must agree), rendering into news.json next to
// untouched hand-written items, the site's own model reading the automated items, and the auto_publish.news switch.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { attachStatements } from './attach.mjs';
import { eventKey, checkItem, upsertItems, renderNews, renderItem, checkNewsEvents, emptyState, visible, markShown, loadEvents, normalizeItem } from './events.mjs';
import { templateFor } from './templates.mjs';
import { eventsStep, newsRun, recordsFromRuns } from './run.mjs';
import * as congressGov from './sources/congress_gov.mjs';
import * as legiscanSrc from './sources/legiscan.mjs';
import * as courtSrc from './sources/courtlistener.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { checkPublish } from '../publish/guards.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..'), root = path.resolve(P, '..');
const FIX = path.join(P, 'fixtures', 'news', 'sources'), realData = path.join(root, 'web', 'data', 'v2');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const j = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const ENTRIES = j(path.join(realData, 'entries.json'));
const NEWS = j(path.join(realData, 'news.json'));

const HR = { source: 'congress_gov', source_id: '119/hr/3460', entry_key: 's-1792-h-r-3460-ai-whistleblower-protection-act', source_url: 'https://www.congress.gov/bill/119th-congress/house-bill/3460', fetched_at: '2026-10-26T06:54:59Z', raw: j(path.join(FIX, 'congress_gov', '119-hr-3460.json')) };
const AB = { source: 'legiscan', source_id: '1980302', entry_key: 'ca-ab-1405-auditor-registry', source_url: 'https://leginfo.legislature.ca.gov/faces/billStatusClient.xhtml?bill_id=202520260AB1405', fetched_at: '2026-10-13T05:40:19Z', raw: j(path.join(FIX, 'legiscan', 'CA-AB1405.json')) };
const FOUND = j(path.join(FIX, 'courtlistener', 'found.json')).found;
const T1 = new Date('2026-10-26T08:00:00Z'), T2 = new Date('2026-10-26T12:00:00Z'), T3 = new Date('2026-10-27T08:00:00Z');

// ---------- 1. adapters over the stored records ----------
{
  const c = await congressGov.fetchItems({ records: [HR] });
  ok('1 congress_gov: one item per action, with class, date, official url and retrieval time', c.items.length === HR.raw.actions.length && c.items.every((i) => i.url === HR.source_url && i.retrieved_at === HR.fetched_at && i.jurisdiction === 'US' && i.entry_id === HR.entry_key));
  ok('1 congress_gov: "Introduced in House" is an introduction in the House; the referral a referral', c.items.some((i) => i.class === 'introduction' && i.facts.chamber === 'House' && i.date === '2025-05-15') && c.items.some((i) => i.class === 'referral-committee'));
  ok('1 congress_gov: the bill number and title are the record\'s', c.items.every((i) => i.facts.number === 'H.R. 3460' && i.facts.title === 'AI Whistleblower Protection Act'));
  ok('1 congress_gov: health and the record read in full', c.health.ok && c.health.count === c.items.length && c.fetched.length === 1 && c.fetched[0].record === '119/hr/3460');
  const l = await legiscanSrc.fetchItems({ records: [AB] });
  ok('1 legiscan: the legislature\'s page is the link; CA chaptering is became-law, approval a signature', l.items.every((i) => /leginfo\.legislature\.ca\.gov/.test(i.url)) && l.items.some((i) => i.class === 'became-law' && i.date === '2026-09-09') && l.items.some((i) => i.class === 'executive-signature') && l.items.some((i) => i.class === 'executive-receipt'));
  ok('1 legiscan: per-action source ids are distinct and stable', new Set(l.items.map((i) => i.source_id)).size === l.items.length && JSON.stringify((await legiscanSrc.fetchItems({ records: [AB] })).items.map((i) => i.source_id)) === JSON.stringify(l.items.map((i) => i.source_id)));
  const k = await courtSrc.fetchItems({ found: FOUND, now: T1 });
  ok('1 courtlistener: a notice of appeal is a court-filing, an order on summary judgment a court-ruling, routine entries no class', k.items.some((i) => i.class === 'court-filing') && k.items.some((i) => i.class === 'court-ruling') && k.items.some((i) => i.class === null) && k.items.every((i) => /courtlistener\.com\/docket\//.test(i.url)));
  ok('1 missing input: no items, never a throw', (await congressGov.fetchItems({})).items.length === 0 && (await legiscanSrc.fetchItems()).items.length === 0 && (await courtSrc.fetchItems()).items.length === 0);
}

// ---------- 2. keys, dedupe, date rules ----------
{
  const it = { source: 'congress_gov', source_id: 'a', jurisdiction: 'US', entry_id: 'x', class: 'passage', date: '2026-10-20', facts: { action: 'Passed Senate without amendment by Unanimous Consent.', chamber: 'Senate' }, url: 'https://www.congress.gov/bill/1', title: 't', retrieved_at: '2026-10-21T00:00:00Z' };
  ok('2 the key is jurisdiction|entry|class|date', eventKey(it) === 'US|x|passage|2026-10-20' && eventKey({ ...it, entry_id: null }) === 'US|-|passage|2026-10-20');
  const now = new Date('2026-10-21T06:00:00Z');
  ok('2 a future date is refused', /future/.test(checkItem({ ...it, date: '2026-10-22' }, { now })));
  ok('2 a date more than a day after retrieval is refused', /after retrieval/.test(checkItem({ ...it, date: '2026-10-21', retrieved_at: '2026-10-19T00:00:00Z' }, { now })));
  ok('2 a url off the official hosts is refused; a class outside the contract is refused', /not an official/.test(checkItem({ ...it, url: 'https://www.politico.com/x' }, { now })) && /not in the contract/.test(checkItem({ ...it, class: 'rumour' }, { now })));
  ok('2 a good item passes', checkItem(it, { now }) === null);
  const s = emptyState();
  const r = upsertItems(s, [it, { ...it, source_id: 'b', facts: { ...it.facts } }, { ...it, source_id: 'c', facts: { action: 'Passed Senate with an amendment by Unanimous Consent.', chamber: 'Senate' } }], { runId: 'r1', now });
  const ev = s.events['US|x|passage|2026-10-20'];
  ok('2 three items with one key are one event; the different official words are both kept, sorted', r.added.length === 1 && Object.keys(s.events).length === 1 && ev.facts.actions.length === 2 && ev.sources.filter((x) => x.role === 'official').length === 3);
  const r2 = upsertItems(s, [it, { ...it, source_id: 'b' }, { ...it, source_id: 'c', facts: { action: 'Passed Senate with an amendment by Unanimous Consent.', chamber: 'Senate' } }], { runId: 'r1', now });
  ok('2 the same items again: no new event', r2.added.length === 0 && Object.keys(s.events).length === 1);
  const s2 = emptyState();
  upsertItems(s2, [{ ...it, date: '2026-01-02', retrieved_at: '2026-10-21T00:00:00Z' }], { runId: 'r1', now, since: '2026-10-07' });
  ok('2 history before the window is never back-filled', Object.keys(s2.events).length === 0);
  const s3 = emptyState();
  upsertItems(s3, [{ ...it, class: null }], { runId: 'r1', now });
  ok('2 an unmapped action is recorded with class null and is never shown', Object.values(s3.events)[0].class === null && !visible(Object.values(s3.events)[0]));
}

// ---------- 3. confirmation, corrections, withdrawal ----------
{
  const s = emptyState();
  const run = async (recs, now, runId) => (await eventsStep({ state: s, records: recs, now, runId, sinceDays: 800 })).up;
  const a = await run([HR], T1, 'r1');
  const intro = 'US|s-1792-h-r-3460-ai-whistleblower-protection-act|introduction|2025-05-15#HR3460';
  ok('3 run 1: events created pending', a.added.includes(intro) && s.events[intro].status === 'pending');
  const b = await run([HR], T2, 'r2');
  ok('3 run 2, the record unchanged: confirmed by 2 stable runs (no independent source for this class)', b.confirmed.includes('US|s-1792-h-r-3460-ai-whistleblower-protection-act|referral-committee|2025-05-15#HR3460') && s.events['US|s-1792-h-r-3460-ai-whistleblower-protection-act|referral-committee|2025-05-15#HR3460'].status === 'confirmed');
  const hr2 = clone(HR); hr2.raw.actions = hr2.raw.actions.filter((x) => !/Referred to the House Committee/.test(x.text));
  const refKey = 'US|s-1792-h-r-3460-ai-whistleblower-protection-act|referral-committee|2025-05-15#HR3460';
  markShown(s, [refKey], T2.toISOString());
  const c = await run([hr2], T3, 'r3');
  ok('3 the record read again in full no longer shows the referral: withdrawn, with history, not deleted', c.withdrawn.includes(refKey) && s.events[refKey].status === 'withdrawn' && s.events[refKey].history.some((h) => h.to === 'withdrawn'));
  ok('3 a withdrawn event that was shown stays visible (as a correction)', visible(s.events[refKey]));
  await run([HR], new Date('2026-10-28T08:00:00Z'), 'r4');
  ok('3 back in the record: pending again (the shown card stays withdrawn until the return is confirmed), history kept', s.events[refKey].status === 'pending' && s.events[refKey].pending_correction && s.events[refKey].history.some((h) => h.change === 'back in the official record'));
  // a fact correction on a confirmed event
  const sc = emptyState();
  const it = { source: 'congress_gov', source_id: 'x#1', record: 'x', jurisdiction: 'US', entry_id: HR.entry_key, class: 'passage', date: '2026-10-20', facts: { action: 'Passed House by recorded vote: 300 - 100.', chamber: 'House', vote: { yes: 300, no: 100 } }, url: 'https://www.congress.gov/bill/1', title: 't', retrieved_at: '2026-10-21T00:00:00Z' };
  upsertItems(sc, [it], { runId: 'a', now: new Date('2026-10-21T06:00:00Z') }); upsertItems(sc, [it], { runId: 'b', now: new Date('2026-10-21T10:00:00Z') });
  const k = eventKey(it);
  ok('3 (setup) confirmed after two runs', sc.events[k].status === 'confirmed');
  const fixed = { ...it, facts: { ...it.facts, action: 'Passed House by recorded vote: 301 - 99.', vote: { yes: 301, no: 99 } } };
  const r = upsertItems(sc, [fixed], { runId: 'c', now: new Date('2026-10-22T06:00:00Z') });
  ok('3 the official vote changed: pending again (a new confirmation cycle), old and new facts in history, never deleted', !r.corrected.includes(k) && sc.events[k].status === 'pending' && sc.events[k].pending_correction && sc.events[k].last_confirmed.facts.vote.yes === 300 && sc.events[k].history.some((h) => h.change === 'facts' && h.from.vote.yes === 300 && h.to.vote.yes === 301));
  ok('3 a corrected event that was never shown is not put on the page', !visible(sc.events[k]));
  // facts.withdrawn from an adapter (Open States / NY Senate style)
  const sw = emptyState();
  upsertItems(sw, [it], { runId: 'a', now: new Date('2026-10-21T06:00:00Z') });
  const w = upsertItems(sw, [{ ...it, facts: { ...it.facts, withdrawn: true } }], { runId: 'b', now: new Date('2026-10-21T10:00:00Z') });
  ok('3 an adapter\'s facts.withdrawn marks the event withdrawn', w.withdrawn.includes(k) && sw.events[k].status === 'withdrawn');
  // state bill: LegiScan alone never confirms; an independent state record does
  const sl = emptyState();
  await eventsStep({ state: sl, records: [AB], now: new Date('2026-10-13T08:00:00Z'), runId: 'a', sinceDays: 800 });
  await eventsStep({ state: sl, records: [AB], now: new Date('2026-10-13T12:00:00Z'), runId: 'b', sinceDays: 800 });
  const law = 'CA|ca-ab-1405-auditor-registry|became-law|2026-09-09#AB1405';
  ok('3 a state event from LegiScan alone stays pending (an independent state source exists for the class)', sl.events[law] && sl.events[law].status === 'pending');
  const os1 = { source: 'openstates', source_id: 'ocd-x', jurisdiction: 'CA', entry_id: 'ca-ab-1405-auditor-registry', class: 'became-law', date: '2026-09-09', facts: { action: 'Chaptered by Secretary of State - Chapter 178, Statutes of 2026.' }, url: 'https://leginfo.legislature.ca.gov/x', title: 'AB 1405', retrieved_at: '2026-10-13T12:00:00Z' };
  upsertItems(sl, [os1], { runId: 'c', now: new Date('2026-10-13T14:00:00Z') });
  ok('3 an Open States record of the same class and date confirms it', sl.events[law].status === 'confirmed' && sl.events[law].confirmations.includes('openstates'));
}

// ---------- 4. statements (news/attach.mjs attachStatements: the one rule) ----------
{
  const s = emptyState();
  const it = { source: 'congress_gov', source_id: 'x#1', record: 'x', jurisdiction: 'US', entry_id: 'e1', class: 'passage', date: '2026-10-20', facts: { action: 'Passed Senate without amendment.', chamber: 'Senate' }, url: 'https://www.congress.gov/bill/1', title: 't', retrieved_at: '2026-10-21T00:00:00Z' };
  upsertItems(s, [it, { ...it, source_id: 'x#2', class: 'hearing-held', date: '2026-10-10', facts: { action: 'Hearings held.', committee: 'Committee on Commerce, Science, and Transportation' } }], { runId: 'a', now: new Date('2026-10-21T06:00:00Z') });
  const st = (o) => ({ source: 'release', source_id: o.url || 'https://senator.senate.gov/r/1', jurisdiction: 'US', entry_id: 'e1', class: null, date: '2026-10-22', facts: { role: 'statement', publisher: 'Sen. X' }, url: 'https://senator.senate.gov/r/1', title: 'Senate passes the bill', retrieved_at: '2026-10-22T00:00:00Z', ...o });
  const att = (sts, events = Object.values(s.events)) => attachStatements(events, sts, { allowHosts: ['senate.gov'] });
  const onEv = (r, k) => r.events.find((e) => e.key === k).sources.filter((x) => x.role === 'statement').length;
  const k = eventKey(it);
  ok('4 a release 2 days after the event attaches to it', onEv(att([st({})]), k) === 1);
  ok('4 a release 4 days after is not attached', onEv(att([st({ date: '2026-10-24', url: 'https://senator.senate.gov/r/2' })]), k) === 0);
  ok('4 a release before the event is not attached', onEv(att([st({ date: '2026-10-19', url: 'https://senator.senate.gov/r/3' })]), k) === 0);
  ok('4 another entry: not attached (the key must agree)', onEv(att([st({ entry_id: 'e2', url: 'https://senator.senate.gov/r/4' })]), k) === 0);
  ok('4 a headline naming the other chamber does not attach ("House passes" is not the Senate passage)', onEv(att([st({ title: 'House passes the bill', url: 'https://senator.senate.gov/r/5' })]), k) === 0);
  ok('4 a host not on the configured list is dropped', att([st({ url: 'https://evil.example/r', source_id: 'e' })], Object.values(s.events)).dropped.some((d) => /host/.test(d.why)));
  upsertItems(s, [{ ...it, source_id: 'x#3', class: 'committee-passage', date: '2026-10-19', facts: { action: 'Ordered to be reported.' } }], { runId: 'b', now: new Date('2026-10-21T08:00:00Z') });
  const two = att([st({ title: 'Bill passes', url: 'https://senator.senate.gov/r/6' })]);
  ok('4 two events could match: held on the timeline, not guessed', onEv(two, k) === 0 && onEv(two, eventKey({ ...it, class: 'committee-passage', date: '2026-10-19' })) === 0 && two.timeline.length === 1 && /not guessed/.test(two.timeline[0].held));
}

// ---------- 5. rendering, the site, the switch ----------
const validate = makeValidator();
function stateWithConfirmed() {
  const s = emptyState();
  return (async () => {
    for (const [now, id] of [[T1, 'r1'], [T2, 'r2']]) await eventsStep({ state: s, records: [HR], courtFound: FOUND, now, runId: id, sinceDays: 800 });
    return s;
  })();
}
{
  const s = await stateWithConfirmed();
  const r = renderNews(NEWS, s, ENTRIES, { at: T2.toISOString(), maxAgeDays: 1000 });
  const auto = r.news.items.filter((n) => n.event_key);
  ok('5 confirmed events are appended; every hand-written item untouched and in order', r.added.length > 0 && JSON.stringify(r.news.items.slice(0, NEWS.items.length)) === JSON.stringify(NEWS.items));
  ok('5 an event on an entry and date that already has an item (Lane 1 or by hand) is not added again', r.held.some((h) => /already has an item/.test(h.why)) || !auto.some((n) => NEWS.items.some((o) => !o.event_key && o.tracker === n.tracker && o.date === n.date)));
  const intro = auto.find((n) => n.class === 'referral-committee'); // the introduction waits for govinfo (news/confirm.mjs)
  ok('5 the item: contract fields, official-record badge, jurisdiction, stage, history, template text quoting the record', intro && intro.origin === 'automated' && intro.verification.method === 'official-record' && intro.jurisdiction === 'US' && !('stage' in intro) && intro.status === 'confirmed' && Array.isArray(intro.history) && Array.isArray(intro.statements) && /"Referred to the House Committee on Education and Workforce"/.test(intro.body) && /^H.R. 3460 referred to committee$/.test(intro.title), JSON.stringify(intro));
  const errs = validate.check('news', r.news);
  ok('5 the rendered news.json passes its schema', !errs.length, errs.slice(0, 3).join(' | '));
  ok('5 the stop rules pass on the honest render', checkNewsEvents({ before: { news: NEWS, entries: ENTRIES }, after: { news: r.news, entries: ENTRIES }, state: s, entries: ENTRIES }).length === 0);
  const tampered = clone(r.news); tampered.items.find((n) => n.event_key).title = 'Bill passes Congress';
  ok('5 the stop rules catch an item that is not the render of its event', checkNewsEvents({ before: { news: NEWS, entries: ENTRIES }, after: { news: tampered, entries: ENTRIES }, state: s, entries: ENTRIES }).some((p) => /not the render/.test(p)));
  const handEdit = clone(r.news); handEdit.items[0].title += ' x';
  ok('5 the stop rules catch a change to a hand-written item', checkNewsEvents({ before: { news: NEWS, entries: ENTRIES }, after: { news: handEdit, entries: ENTRIES }, state: s, entries: ENTRIES }).some((p) => /not written by the event model/.test(p)));
  const dropped = { ...r.news, items: r.news.items.filter((n) => n !== intro) };
  ok('5 the stop rules catch a removed event item', checkNewsEvents({ before: { news: r.news, entries: ENTRIES }, after: { news: dropped, entries: ENTRIES }, state: s, entries: ENTRIES }).some((p) => /removed/.test(p)));
  // the site's own model (web/tracker-lib.js buildV2) reads the automated items
  const lib = await import(pathToFileURL(path.join(root, 'web', 'tracker-lib.js')).href);
  const D = lib.buildV2(j(path.join(realData, 'entries.json')), r.news, j(path.join(realData, 'relationships.json')), j(path.join(realData, 'site.json')));
  const mine = D.N.filter((n) => n.event_key);
  ok('5 the site builds its news model with the automated items linked to their entries', mine.length === auto.length && mine.every((n) => n.entryId && n.title && n.body && n.links.length && n.d instanceof Date && !Number.isNaN(+n.d)));
  // a withdrawn item stays, marked, with a correction line the site flags
  markShown(s, r.added, T2.toISOString());
  const k = intro.event_key; s.events[k].status = 'withdrawn'; s.events[k].history.push({ at: T3.toISOString(), change: 'status', from: 'confirmed', to: 'withdrawn' });
  const r2 = renderNews(r.news, s, ENTRIES, { at: T3.toISOString(), maxAgeDays: 1000 });
  const w = r2.news.items.find((n) => n.event_key === k);
  ok('5 withdrawn after it was shown: kept in place, status withdrawn, "Correction" in the check line, a status note', w && w.status === 'withdrawn' && /^Withdrawn: /.test(w.title) && /Correction/.test(w.check) && w.status_note && r2.news.items.indexOf(w) === r.news.items.indexOf(intro) && r2.updated.includes(k));
  ok('5 the AI card is used only while its facts are current; otherwise the template', (() => { const ev = clone(s.events[k]); ev.status = 'confirmed'; ev.card = { written_by: 'ai', headline: 'AI headline here', body: 'AI body text that is long enough.', facts_hash: ev.facts_digest }; const a1 = renderItem(ev, ENTRIES.find((e) => e.key === ev.entry_id)); ev.card.facts_hash = 'old'; const a2 = renderItem(ev, ENTRIES.find((e) => e.key === ev.entry_id)); return a1.title === 'AI headline here' && a2.title === templateFor(ev, ENTRIES.find((e) => e.key === ev.entry_id)).headline; })());
  ok('5 a passage whose record names no chamber is held (the template needs it)', templateFor({ class: 'passage', jurisdiction: 'IL', date: '2026-05-01', facts: { action: 'Passed Both Houses' }, sources: [] }, { short_name: 'X', title: 'X' }) === null);
}

// ---------- 6. the whole step and the switch ----------
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-events-'));
  for (const d of ['data', 'docs', 'state']) fs.mkdirSync(path.join(dir, d));
  for (const f of ['entries', 'news', 'site', 'changes', 'relationships']) if (fs.existsSync(path.join(realData, f + '.json'))) fs.copyFileSync(path.join(realData, f + '.json'), path.join(dir, 'data', f + '.json'));
  return { dir, dataDir: path.join(dir, 'data'), eventsFile: path.join(dir, 'state', 'news-events.json'), healthFile: path.join(dir, 'state', 'news-health.json'), seenFile: path.join(dir, 'state', 'news-seen.json') };
}
const CFG = (on) => ({ max_entries_changed_per_run: 15, auto_publish: { news: on }, news_leads: { enabled: false } });
{
  // the stored H.R. 3460 record with its actions re-dated to 25 Oct 2026, so they fall inside the 14-day window of a real run
  const HRN = clone(HR); HRN.raw.actions.forEach((a) => { a.actionDate = '2026-10-25'; });
  const sb = sandbox(), newsBefore = fs.readFileSync(path.join(sb.dataDir, 'news.json'), 'utf8');
  const go = (on, now, id) => newsRun({ dataDir: sb.dataDir, seenFile: sb.seenFile, eventsFile: sb.eventsFile, healthFile: sb.healthFile, config: CFG(on), factory: null, today: now.toISOString().slice(0, 10), now, runId: id, records: [HRN], courtFound: FOUND });
  const a = await go(false, T1, 'r1'); const b = await go(false, T2, 'r2');
  ok('6 switch off: events computed, stored and reported; news.json byte-identical', a.events.added.length > 0 && b.events.confirmed.length > 0 && b.drafted.length > 0 && b.drafted.every((d) => !d.written) && b.status === 'reported' && fs.readFileSync(path.join(sb.dataDir, 'news.json'), 'utf8') === newsBefore && Object.keys(loadEvents(sb.eventsFile).events).length > 0);
  ok('6 switch off: the summary names the events', /new official event/.test(b.summary));
  const c = await go(true, T3, 'r3');
  const after = j(path.join(sb.dataDir, 'news.json'));
  ok('6 switch on: the confirmed events are written, alongside every hand-written item', c.status === 'written' && c.drafted.every((d) => d.written) && after.items.filter((n) => n.event_key).length === c.drafted.length && JSON.stringify(after.items.filter((n) => !n.event_key)) === JSON.stringify(j(path.join(realData, 'news.json')).items), JSON.stringify(c.problems));
  ok('6 switch on: the whole data passes checkPublish', checkPublish({ before: { entries: ENTRIES, news: NEWS, site: j(path.join(realData, 'site.json')), changes: j(path.join(realData, 'changes.json')), relationships: j(path.join(realData, 'relationships.json')) }, after: { entries: ENTRIES, news: after, site: j(path.join(realData, 'site.json')), changes: j(path.join(realData, 'changes.json')), relationships: j(path.join(realData, 'relationships.json')) }, runDate: '2026-10-27', maxEntries: 15 }).problems.length === 0);
  const d = await go(true, new Date('2026-10-28T08:00:00Z'), 'r4');
  ok('6 the next run changes nothing (idempotent)', d.drafted.length === 0 && JSON.stringify(j(path.join(sb.dataDir, 'news.json'))) === JSON.stringify(after));
  fs.rmSync(sb.dir, { recursive: true, force: true });
  // records from the grabber's run folders
  const rd = fs.mkdtempSync(path.join(os.tmpdir(), 'news-run-'));
  fs.mkdirSync(path.join(rd, 'raw', 'legiscan'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'legiscan', 'CA-AB1405.json'), path.join(rd, 'raw', 'legiscan', 'CA-AB1405.json'));
  fs.writeFileSync(path.join(rd, 'changeset.json'), JSON.stringify({ items: [{ item_id: 'legiscan:1980302', source: 'legiscan', source_id: '1980302', entry_key: AB.entry_key, source_url: AB.source_url, fetched_at: AB.fetched_at, raw_path: 'raw/legiscan/CA-AB1405.json' }, { item_id: 'x', source: 'legiscan', source_id: '9', raw_path: 'raw/legiscan/missing.json' }] }));
  const recs = recordsFromRuns([rd]);
  ok('6 records are read from the run folders the grabber wrote (a missing raw file is skipped)', recs.length === 1 && recs[0].entry_key === AB.entry_key && recs[0].raw.bill.bill_number === 'AB1405');
  fs.rmSync(rd, { recursive: true, force: true });
}

// ---------- 7. cards for the writer, the milestone fact ----------
{
  const { refreshCards, milestoneFor } = await import('./events.mjs');
  const { writeCards } = await import('./run.mjs');
  const s = await stateWithConfirmed();
  refreshCards(s, ENTRIES);
  const shown = Object.values(s.events).filter(visible);
  ok('7 every renderable event carries template_headline/template_body (the writer falls back to them)', shown.length > 0 && shown.every((e) => e.card && e.card.template_headline && e.card.template_body && e.card.written_by === 'template'));
  const bad = { make: () => ({ async generate() { return { data: { headline: 'Unanimously passed landmark bill', body: 'It passed unanimously.' }, usage: {} }; } }) };
  // the AI path is reachable only with news.ai_writer true (config/publish.json)
  const AI = { news: { ai_writer: true } };
  const w = await writeCards({ state: s, entries: ENTRIES, keys: shown.map((e) => e.key), factory: bad, today: '2026-10-27', config: AI });
  ok('7 a card the checks refuse stays the template; nothing written by AI', w.written === 0 && w.tried > 0 && shown.every((e) => s.events[e.key].card.written_by === 'template'));
  ok('7 no writer roles: nothing tried, never a throw', (await writeCards({ state: s, entries: ENTRIES, keys: shown.map((e) => e.key), factory: { make: () => { throw new Error('no role'); } }, today: '2026-10-27', config: AI })).tried === 0);
  // default (news.ai_writer false): the phrase bank writes every card, code only; no AI factory is touched
  let made = 0;
  const wb = await writeCards({ state: s, entries: ENTRIES, keys: shown.map((e) => e.key), factory: { make: () => { made++; return bad.make(); } }, today: '2026-10-27' });
  ok('7 phrase bank by default: cards written by code, no AI client made, kept while facts are current', made === 0 && wb.mode === 'bank' && wb.written > 0 && shown.every((e) => ['bank', 'template'].includes(s.events[e.key].card.written_by)) && (refreshCards(s, ENTRIES), shown.some((e) => s.events[e.key].card.written_by === 'bank')));
  ok('7 milestone: only for a state law, computed from tracker data, else null', milestoneFor({ class: 'passage', jurisdiction: 'CA', entry_id: 'ca-ab-1405-auditor-registry', date: '2026-09-09' }, ENTRIES) === null && milestoneFor({ class: 'became-law', jurisdiction: 'US', entry_id: HR.entry_key, date: '2026-09-09' }, ENTRIES) === null && [null, 'string'].includes(milestoneFor({ class: 'became-law', jurisdiction: 'CA', entry_id: 'ca-ab-1405-auditor-registry', date: '2026-09-09' }, ENTRIES) === null ? null : 'string'));
}

// ---------- 8. review r2 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'news-r2-'));
  // #6 the step never throws
  const bad = path.join(tmp, 'news-events.json'); fs.writeFileSync(bad, '{ not json');
  const q = loadEvents(bad, { now: T1 });
  ok('r2#6 an unreadable events file is moved aside and the state starts empty', Object.keys(q.events).length === 0 && q.quarantined && fs.existsSync(q.quarantined) && !fs.existsSync(bad));
  fs.writeFileSync(bad, JSON.stringify({ events: { a: null, b: { key: 'b' }, c: 7 } }));
  const q2 = loadEvents(bad);
  ok('r2#6 null and malformed stored events are dropped, not crashed on', Object.keys(q2.events).length === 0 && q2.dropped_malformed === 3);
  const s6 = emptyState(); s6.events.x = null; s6.events.y = { key: 'y' };
  let threw = false, r6;
  try { r6 = upsertItems(s6, [null, 7, { source: 'congress_gov', source_id: { a: 1 } }, { source: 'congress_gov', source_id: 42, jurisdiction: 'US', entry_id: 'e', class: 'passage', date: '2026-10-25', facts: { action: 'Passed Senate.', chamber: 'Senate' }, url: 'https://www.congress.gov/b', title: 't', retrieved_at: '2026-10-25T00:00:00Z' }], { runId: 'a', now: T1 }); } catch { threw = true; }
  ok('r2#6 null events, non-object items and a non-string source_id never throw; a numeric source_id is used as text', !threw && r6.refused.length === 3 && r6.added.length === 1 && Object.keys(s6.events).length === 1);
  const sb = sandbox(); fs.writeFileSync(sb.eventsFile, '][');
  const rn = await newsRun({ dataDir: sb.dataDir, seenFile: sb.seenFile, eventsFile: sb.eventsFile, healthFile: sb.healthFile, config: CFG(false), factory: null, today: '2026-10-26', now: T1, runId: 'r', records: [HR] });
  ok('r2#6 newsRun with an unreadable events file runs on and says so', rn.status !== 'stopped' && rn.problems.some((p) => /moved to/.test(p)));
  const rx = await newsRun({ dataDir: path.join(tmp, 'missing'), config: CFG(true), factory: null, today: '2026-10-26', now: T1, runId: 'r', records: [] });
  ok('r2#6 any error inside the news step is a stopped report, never a throw', rx.status === 'stopped' && /news step failed/.test(rx.problems[0]) && Array.isArray(rx.drafted));
  fs.rmSync(sb.dir, { recursive: true, force: true });

  // #3 signature then became-law on later runs: one card, updated in place
  const base = { source: 'legiscan', record: 'b1', jurisdiction: 'CA', entry_id: 'ca-ab-1405-auditor-registry', url: 'https://leginfo.legislature.ca.gov/x', title: 'AB 1405' };
  const sig = { ...base, source_id: 'b1#sig', class: 'executive-signature', date: '2026-10-20', facts: { action: 'Approved by the Governor.' }, retrieved_at: '2026-10-21T00:00:00Z' };
  const law = { ...base, source_id: 'b1#law', class: 'became-law', date: '2026-10-21', facts: { action: 'Chaptered by Secretary of State - Chapter 178, Statutes of 2026.' }, retrieved_at: '2026-10-22T00:00:00Z' };
  const conf = (it, src = 'openstates') => ({ ...it, source: src, source_id: `os-${it.source_id}`, record: undefined });
  const s3 = emptyState();
  upsertItems(s3, [sig, conf(sig)], { runId: 'a', now: new Date('2026-10-21T06:00:00Z') });
  let page = { ...NEWS, items: [...NEWS.items] };
  let r = renderNews(page, s3, ENTRIES, { at: '2026-10-21T06:00:00Z' }); s3.events = r.state.events; markShown(s3, r.added, '2026-10-21'); page = r.news;
  ok('r2#3 (setup) the signature card is published', r.added.length === 1 && r.added[0].includes('executive-signature'));
  upsertItems(s3, [law, conf(law)], { runId: 'b', now: new Date('2026-10-22T06:00:00Z') });
  r = renderNews(page, s3, ENTRIES, { at: '2026-10-22T06:00:00Z' }); s3.events = r.state.events;
  const card = r.news.items.filter((n) => n.event_key && n.tracker === 'ca-ab-1405-auditor-registry');
  ok('r2#3 the next run\'s became-law is merged into the same card (one card, now showing became-law), not a second card', r.added.length === 0 && card.length === 1 && card[0].class === 'became-law' && /becomes law/.test(card[0].title) && r.updated.length === 1);
  ok('r2#3 the merged render passes the stop rules', checkNewsEvents({ before: { news: page, entries: ENTRIES }, after: { news: r.news, entries: ENTRIES }, state: r.state, entries: ENTRIES }).length === 0);
  const s3b = emptyState(); upsertItems(s3b, [sig, conf(sig), law, conf(law)], { runId: 'a', now: new Date('2026-10-22T06:00:00Z') });
  const r3b = renderNews(NEWS, s3b, ENTRIES, { at: '2026-10-22T06:00:00Z' });
  ok('r2#3 both in one run: one card', r3b.added.length === 1 && r3b.merged.length === 1);

  // #4 the same executive order from the White House, the FR public inspection desk and the FR document: one event
  const fr = { source: 'federal_register', source_id: '2026-21001', jurisdiction: 'US', entry_id: null, class: 'executive-order', date: '2026-10-14', facts: { title: 'Ensuring a National Policy Framework for Artificial Intelligence', document_number: '2026-21001', eo_number: 14999, signing_date: '2026-10-09', publication_date: '2026-10-14' }, url: 'https://www.federalregister.gov/d/2026-21001', title: 'Ensuring a National Policy Framework for Artificial Intelligence', retrieved_at: '2026-10-14T12:00:00Z' };
  const wh = { source: 'whitehouse', source_id: 'https://www.whitehouse.gov/presidential-actions/2026/10/x/', jurisdiction: 'US', entry_id: null, class: 'executive-order', date: '2026-10-10', facts: { title: fr.title }, url: 'https://www.whitehouse.gov/presidential-actions/2026/10/x/', title: fr.title, retrieved_at: '2026-10-10T12:00:00Z' };
  const pi = { ...fr, source_id: 'pi:2026-21001', date: '2026-10-11', facts: { ...fr.facts, public_inspection: true } };
  const s4 = emptyState(); const r4 = upsertItems(s4, [wh, pi, fr], { runId: 'a', now: new Date('2026-10-14T13:00:00Z') });
  ok('r2#4 White House + public inspection + FR document of one order: one event keyed on the EO number', Object.keys(s4.events).length === 1 && Object.keys(s4.events)[0] === 'US|-|executive-order|EO14999' && r4.refused.some((x) => /public inspection/.test(x.why)));
  const s4b = emptyState(); upsertItems(s4b, [fr], { runId: 'a', now: new Date('2026-10-14T13:00:00Z') }); upsertItems(s4b, [wh], { runId: 'b', now: new Date('2026-10-14T15:00:00Z') });
  ok('r2#4 the White House posting on a later run joins the stored FR event (signing date, EO number)', Object.keys(s4b.events).length === 1);

  // #5 chambers in one vocabulary: Open States "upper" confirms LegiScan "Senate"; a contradicting failure holds it
  const ls = { source: 'legiscan', source_id: 'b2#p', record: 'b2', jurisdiction: 'CA', entry_id: 'ca-ab-1405-auditor-registry', class: 'passage', date: '2026-10-20', facts: { action: 'Read third time. Passed. (Ayes 30. Noes 6.)', chamber: 'S' }, url: 'https://leginfo.legislature.ca.gov/x', title: 'AB 1405', retrieved_at: '2026-10-21T00:00:00Z' };
  const os5 = { source: 'openstates', source_id: 'ocd-act-1', jurisdiction: 'CA', entry_id: 'ca-ab-1405-auditor-registry', class: 'passage', date: '2026-10-20', facts: { action: 'Read third time. Passed.', chamber: 'upper' }, url: 'https://leginfo.legislature.ca.gov/x', title: 'AB 1405', retrieved_at: '2026-10-21T00:00:00Z' };
  const s5 = emptyState(); upsertItems(s5, [ls, os5], { runId: 'a', now: new Date('2026-10-21T06:00:00Z') });
  const e5 = Object.values(s5.events)[0];
  ok('r2#5 LegiScan "S" and Open States "upper" are both the Senate: confirmed', Object.keys(s5.events).length === 1 && e5.facts.chamber === 'Senate' && e5.status === 'confirmed' && e5.confirmations.includes('openstates'));
  ok('r2#5 an Assembly state: "lower" is the Assembly', normalizeItem({ ...os5, facts: { chamber: 'lower' } }).item.facts.chamber === 'Assembly' && normalizeItem({ ...os5, jurisdiction: 'TX', facts: { chamber: 'lower' } }).item.facts.chamber === 'House');
  const s5b = emptyState(); upsertItems(s5b, [ls, { ...os5, source_id: 'ocd-act-2', class: 'failure', facts: { action: 'Failed passage.', chamber: 'upper' } }], { runId: 'a', now: new Date('2026-10-21T06:00:00Z') });
  const e5b = s5b.events[eventKey({ ...ls, facts: {} })];
  ok('r2#5 an Open States failure on the same day in the same chamber: disagreement, held', e5b.status === 'pending' && (e5b.disagreements || []).some((d) => d.conflict === 'class') && !visible(e5b));

  // #9 a public law confirmed by govinfo on its number, whatever dateIssued says
  const cg = { source: 'congress_gov', source_id: 'hr1#law', record: 'hr1', jurisdiction: 'US', entry_id: HR.entry_key, class: 'became-law', date: '2026-10-10', facts: { action: 'Became Public Law No: 119-77.' }, url: 'https://www.congress.gov/bill/x', title: 't', retrieved_at: '2026-10-20T00:00:00Z' };
  const gi = { source: 'govinfo', source_id: 'PLAW-119publ77', jurisdiction: 'US', entry_id: HR.entry_key, class: 'became-law', date: '2026-10-17', facts: { role: 'confirmation', public_law: '119-77' }, url: 'https://www.govinfo.gov/app/details/PLAW-119publ77', title: 't', retrieved_at: '2026-10-20T00:00:00Z' };
  const s9 = emptyState(); upsertItems(s9, [cg, gi], { runId: 'a', now: new Date('2026-10-20T06:00:00Z') });
  const e9 = Object.values(s9.events);
  ok('r2#9 govinfo (dateIssued a week later) confirms the public law by number; it creates no event of its own', e9.length === 1 && e9[0].status === 'confirmed' && e9[0].facts.public_law === '119-77');
  const s9b = emptyState(); upsertItems(s9b, [cg, { ...gi, facts: { role: 'confirmation', public_law: '119-78' } }], { runId: 'a', now: new Date('2026-10-20T06:00:00Z') });
  ok('r2#9 a different public-law number is a disagreement', Object.values(s9b.events)[0].status === 'pending');

  // #11 the backlog when publishing is first switched on
  const s11 = emptyState(); upsertItems(s11, [{ ...cg, source_id: 'o#1', class: 'passage', date: '2026-08-01', facts: { action: 'Passed House.', chamber: 'House' }, retrieved_at: '2026-08-01T00:00:00Z' }], { runId: 'a', now: new Date('2026-08-01T06:00:00Z') });
  upsertItems(s11, [], { runId: 'b', now: new Date('2026-08-01T10:00:00Z') });
  const r11 = renderNews(NEWS, s11, ENTRIES, { at: '2026-10-29T06:00:00Z' });
  ok('r2#11 a confirmed event older than 14 days is not published on switch-on (timeline only)', r11.added.length === 0 && r11.held.some((h) => /older than 14 days/.test(h.why)));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- 9. review r3 ----------
{
  const E = HR.entry_key, URL = 'https://www.congress.gov/bill/119th-congress/house-bill/3460';
  const item = (o) => ({ source: 'congress_gov', record: 'hr3460', jurisdiction: 'US', entry_id: E, url: URL, title: 'AI Whistleblower Protection Act', ...o });
  const day = (d, h) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00Z`);
  // runs: [{ now, items, fetched? }] -> the page after each run (published whenever something renders)
  const play = (runs, page0 = NEWS) => {
    const s = emptyState(); let page = page0; const pages = [];
    for (const [i, r] of runs.entries()) {
      upsertItems(s, r.items, { runId: `r${i}`, now: r.now, fetched: r.fetched || [] });
      const out = renderNews(page, s, ENTRIES, { at: r.now.toISOString() });
      { const pr = checkNewsEvents({ before: { news: page, entries: ENTRIES }, after: { news: out.news, entries: ENTRIES }, state: out.state, entries: ENTRIES }); if (pr.length) throw new Error('stop rules failed: ' + pr.join('; ')); }
      s.events = out.state.events; markShown(s, out.added, r.now.toISOString()); page = out.news; pages.push(page.items.filter((n) => n.event_key && n.tracker === E));
    }
    return { s, pages };
  };
  // #1 a changed vote waits for confirmation
  const p300 = item({ source_id: 'hr3460#2026-10-20#a', class: 'passage', date: '2026-10-20', facts: { action: 'On passage Passed by the Yeas and Nays: 300 - 100.', chamber: 'House', vote: { yes: 300, no: 100 } }, retrieved_at: '2026-10-20T20:00:00Z' });
  const p100 = { ...p300, facts: { ...p300.facts, action: 'On passage Passed by the Yeas and Nays: 100 - 300.', vote: { yes: 100, no: 300 } } };
  const a = play([{ now: day('2026-10-21', 6), items: [p300] }, { now: day('2026-10-21', 10), items: [p300] }, { now: day('2026-10-22', 6), items: [p100] }, { now: day('2026-10-22', 10), items: [p100] }, { now: day('2026-10-23', 6), items: [p100] }]);
  ok('r3#1 (setup) the 300-100 passage is published', a.pages[1].length === 1 && /300 - 100/.test(a.pages[1][0].body));
  ok('r3#1 the record changes to 100-300: the card still shows 300-100, with an "under review" note and no new facts', a.pages[2].length === 1 && /300 - 100/.test(a.pages[2][0].body) && !/100 - 300/.test(JSON.stringify(a.pages[2][0])) && /being confirmed/.test(a.pages[2][0].status_note));
  ok('r3#1 confirmed by the same rules (two stable runs): then corrected, showing 100-300', a.pages[4].length === 1 && /100 - 300/.test(a.pages[4][0].body) && a.pages[4][0].status === 'corrected' && /Correction/.test(a.pages[4][0].check));
  // #2 a re-dated action: one card, with a note saying what changed
  const r20 = item({ source_id: 'hr3460#2026-10-20#r', class: 'referral-committee', date: '2026-10-20', facts: { action: 'Referred to the House Committee on Education and Workforce.' }, retrieved_at: '2026-10-20T20:00:00Z' });
  const r19 = { ...r20, source_id: 'hr3460#2026-10-19#r', date: '2026-10-19' };
  const F = [{ source: 'congress_gov', record: 'hr3460' }];
  const b = play([{ now: day('2026-10-21', 6), items: [r20], fetched: F }, { now: day('2026-10-21', 10), items: [r20], fetched: F }, { now: day('2026-10-22', 6), items: [r19], fetched: F }, { now: day('2026-10-22', 10), items: [r19], fetched: F }]);
  ok('r3#2 the record re-dates the referral: still one card, now Oct 19, saying what changed (no "it now reads as above")', b.pages[3].length === 1 && b.pages[3][0].date === '2026-10-19' && /now dates this Oct 19, 2026 \(first published as Oct 20, 2026\)/.test(b.pages[3][0].check) && !/reads as above/.test(b.pages[3][0].check) && b.pages[3][0].status === 'corrected', JSON.stringify(b.pages.map((p) => p.map((n) => [n.date, n.status, n.check]))));
  ok('r3#2 until the new date is confirmed, the card is the withdrawn one (never two cards)', b.pages[2].length === 1 && b.pages[2][0].status === 'withdrawn');
  // #4 Lane 1's item a day earlier: no second card
  const lane1 = { ...NEWS, items: [...NEWS.items, { date: '2026-10-19', kind: 'federal', title: 'S. 1792 / H.R. 3460: Passed House', body: 'Congress.gov records this action on the bill: "Passed House" (Oct 19, 2026).', links: [{ t: 'x', u: URL }], tracker: E, origin: 'automated', verification: { method: 'agent', checked_at: '2026-10-19T00:00:00Z' }, evidence: [{ field: 'body', quote: 'Passed House', source_url: URL }] }] };
  const c = play([{ now: day('2026-10-21', 6), items: [p300] }, { now: day('2026-10-21', 10), items: [p300] }], lane1);
  ok('r3#4 an item written by Lane 1 a day before the event: no second card', c.pages[1].length === 0);
  // #5 signature, then the law weeks later: one card
  const sig = item({ source_id: 'hr3460#sig', class: 'executive-signature', date: '2026-09-25', facts: { action: 'Signed by President.', number: 'H.R. 3460' }, retrieved_at: '2026-09-25T20:00:00Z' });
  const law = item({ source_id: 'hr3460#law', class: 'became-law', date: '2026-10-16', facts: { action: 'Became Public Law No: 119-77.', number: 'H.R. 3460' }, retrieved_at: '2026-10-16T20:00:00Z' });
  const gi = { source: 'govinfo', source_id: 'PLAW-119publ77', jurisdiction: 'US', entry_id: E, class: 'became-law', date: '2026-10-17', facts: { role: 'confirmation', public_law: '119-77' }, url: 'https://www.govinfo.gov/app/details/PLAW-119publ77', title: 'Public Law 119-77', retrieved_at: '2026-10-17T05:00:00Z' };
  const d = play([{ now: day('2026-09-26', 6), items: [sig] }, { now: day('2026-09-26', 10), items: [sig] }, { now: day('2026-10-17', 6), items: [law, gi] }, { now: day('2026-10-17', 10), items: [law] }]);
  ok('r3#5 a public law three weeks after the signature: merged into the one card, no window', d.pages[3].length === 1 && d.pages[3][0].class === 'became-law', JSON.stringify(d.pages.map((p) => p.map((n) => n.class))));
  // #6 held for sharing entry and date: still held on the next run
  const intro = item({ source_id: 'hr3460#i', class: 'hearing-held', date: '2026-10-20', facts: { action: 'Committee on Education and Workforce. Hearings held.' }, retrieved_at: '2026-10-20T20:00:00Z' });
  const e = play([{ now: day('2026-10-21', 6), items: [p300, intro] }, { now: day('2026-10-21', 10), items: [p300, intro] }, { now: day('2026-10-22', 6), items: [p300, intro] }, { now: day('2026-10-22', 10), items: [p300, intro] }]);
  ok('r3#6 a second event on the same entry and date stays held on later runs (checked against the page, not only the run)', e.pages.every((p) => p.length <= 1));
  // #7 exact hosts
  const now = day('2026-10-21', 6);
  ok('r3#7 legislature.attacker.com and any .gov are refused; the source\'s own hosts are accepted', /not an official host/.test(checkItem({ ...p300, source: 'legiscan', url: 'https://legislature.attacker.com/x' }, { now })) && /not an official host/.test(checkItem({ ...p300, url: 'https://evil.gov/x' }, { now })) && /not an official host/.test(checkItem({ ...p300, url: 'https://congress.gov.attacker.com/x' }, { now })) && checkItem(p300, { now }) === null && checkItem({ ...p300, source: 'legiscan', url: 'https://leginfo.legislature.ca.gov/x' }, { now }) === null);
  // #9 New York: the legislature's own API confirms the aggregators
  const { confirmersFor } = await import('./confirm.mjs');
  ok('r3#9 New York state bills: nysenate confirms LegiScan / Open States, and they confirm it; elsewhere nysenate is never a confirmer', JSON.stringify(confirmersFor({ jurisdiction: 'NY', class: 'passage' }, 'legiscan')) === '["nysenate"]' && confirmersFor({ jurisdiction: 'NY', class: 'passage' }, 'nysenate').includes('legiscan') && !confirmersFor({ jurisdiction: 'CA', class: 'passage' }, 'legiscan').includes('nysenate'));
}

// ---------- 10. review r4 ----------
{
  const { summaryOf } = await import('./factsheet.mjs');
  ok('r4a an aside or a tracker note is never quoted as "What it does"', summaryOf('Requires large developers to publish a safety framework and report incidents (earlier drafts said 2027).') === null && summaryOf('IVO proposes which specific risks it will verify; the state approves it.') === null && summaryOf('The tracker reads this as a disclosure law; see the text.') === null);
  ok('r4a a whole sentence about what the measure does is quoted', summaryOf('Requires frontier developers to publish a safety framework and report critical incidents to the state within 15 days.') === 'Requires frontier developers to publish a safety framework and report critical incidents to the state within 15 days.');
  // (b) the bank writes at most max_cards_per_run cards a run
  const { writeCards } = await import('./run.mjs'); const { refreshCards } = await import('./events.mjs');
  const s = await stateWithConfirmed(); refreshCards(s, ENTRIES);
  const keys = Object.values(s.events).filter(visible).map((e) => e.key);
  const w = await writeCards({ state: s, entries: ENTRIES, keys, factory: null, today: '2026-10-27', max: 1, config: { news: { ai_writer: false } } });
  ok('r4b the phrase bank writes at most max_cards_per_run cards', keys.length > 1 && w.tried <= 1 && w.mode === 'bank');
}

// ---------- 11. review round 4 (fact sheet and phrase bank) ----------
{
  const FS = await import('./factsheet.mjs'), PB = await import('./phrasebank.mjs'), M = await import('../eval/news-bank-matrix.mjs');
  const sn = (j, number, chamber, cls = 'passage', proven = null) => FS.stageOf(cls, j, { number, chamber }, proven);
  ok('r5 no next step anywhere: the fact sheet has none, the bank has no next-step lines', !('next' in FS.buildFactSheet({ key: 'k', jurisdiction: 'CA', class: 'passage', date: '2026-10-27', facts: { number: 'AB 1018', chamber: 'Assembly' } }, null)) && !('NEXT_BANK' in PB) && !('stageAndNext' in FS));
  ok('r4#3 Nebraska: "Passed the Legislature", never both chambers', sn('NE', 'LB 1405', 'Legislature', 'enrolled').stage === undefined && sn('NE', 'LB 1405', 'Legislature', 'enrolled') === 'Passed the Legislature' && sn('NE', 'LB 1405', 'Legislature', 'concurrence') === 'Concurred in the Legislature');
  ok('r6 a concurrence states only its own chamber; stage codes come only from the own class', sn('CA', 'AB 1018', 'Senate', 'concurrence') === 'Concurred in the Senate' && FS.ownStageCode('concurrence', 'CA', 'AB 1018') === null && FS.ownStageCode('enrolled', 'CA', 'AB 1018') === 'passed-both' && FS.ownStageCode('enrolled', 'MN', 'HR 5') === null && FS.ownStageCode('enrolled', 'NE', 'LB 1') === null && FS.ownStageCode('became-law', 'CA', 'SCR 12') === null && FS.ownStageCode('became-law', 'CA', 'AB 1018') === 'law' && FS.ownStageCode('executive-signature', 'CA', 'AB 1018') === 'signed' && FS.ownStageCode('executive-signature', 'PR', 'PC 5') === null && !('provenStage' in FS));
  ok('r4#4 DC: the Mayor, and no "into law"', FS.executiveOf('DC') === 'the Mayor' && sn('DC', 'B 26-0123', 'Council', 'executive-signature') === 'Signed');
  ok('r4#6 the summary label: "would do" for a live bill, "does" for a law', PB.summaryLabel('passage') === 'What the bill would do' && PB.summaryLabel('executive-signature') === 'What it does' && PB.summaryLabel('became-law') === 'What it does');
  ok('r4#8 resolutions are told apart from bills', FS.isResolution('KS HR6023', 'KS') && FS.isResolution('H.Res. 12', 'US') && !FS.isResolution('H.R. 3460', 'US') && !FS.isResolution('CA SB53', 'CA'));
  // the matrix traps catch each of the round-4 errors on a hand-made card
  const sheetOf = (cls, j, f) => FS.buildFactSheet({ key: 'k', jurisdiction: j, class: cls, date: '2026-10-27', facts: f }, null, { today: '2026-10-29' });
  const trap = (cls, j, f, card) => M.trapProblems(card, sheetOf(cls, j, f));
  ok('r4 traps: a signer the record does not name; a resolution into law; DC with a governor; "the the"; both chambers in Nebraska',
    trap('executive-signature', 'CA', { number: 'SB 53' }, { headline: 'The Governor signs SB 53', body: 'The Governor signed SB 53 on October 27, 2026.' }).some((p) => /signer/.test(p))
    && trap('executive-signature', 'KS', { number: 'HR 6023', executive: 'Governor Laura Kelly' }, { headline: 'HR 6023 signed into law', body: 'HR 6023 was signed into law on October 27, 2026.' }).some((p) => /resolution/.test(p))
    && trap('executive-signature', 'DC', { number: 'B 26-0123' }, { headline: 'B 26-0123 signed', body: 'The Governor signed B 26-0123.' }).some((p) => /DC/.test(p))
    && trap('referral-committee', 'CA', { number: 'SB 53', committee: 'Judiciary' }, { headline: 'SB 53 referred to the the Judiciary', body: 'x' }).some((p) => /the the/.test(p))
    && trap('enrolled', 'NE', { number: 'LB 1405' }, { headline: 'LB 1405 enrolled', body: 'LB 1405 was enrolled after passing both chambers.' }).some((p) => /both chambers/.test(p)));
  const cards = PB.candidates(sheetOf('executive-signature', 'CA', { number: 'SB 53' }), 'k');
  ok('r4#5 with no signer in the record, no card names one', cards.length > 0 && cards.every((c) => !/\b(Governor|President)\b/.test(c.headline + c.body)));
  const comm = PB.slotsOf(sheetOf('referral-committee', 'CA', { number: 'SB 53', committee: 'the Senate Judiciary Committee' }));
  ok('r4#8 a committee name that starts with "the" is not doubled', comm.committee === 'Senate Judiciary Committee');
}

// ---------- 12. review round 5 ----------
{
  // H1: a scheduled hearing seen on three days, then cancelled: one event, withdrawn
  const day = (d) => new Date(`${d}T08:00:00Z`);
  const hs = (d, extra = {}) => ({ source: 'congress_gov', source_id: 'meeting:119/house/117001', jurisdiction: 'US', entry_id: 'x', class: 'hearing-scheduled', date: d, facts: { hearing_date: '2026-11-04', committee: 'House Committee on Science', ...extra }, url: 'https://www.congress.gov/event/119th-congress/house-event/117001', title: 'Hearing', retrieved_at: `${d}T07:00:00Z` });
  const s = emptyState();
  upsertItems(s, [hs('2026-10-20')], { runId: 'd1', now: day('2026-10-20') });
  upsertItems(s, [hs('2026-10-21')], { runId: 'd2', now: day('2026-10-21') });
  const ks = Object.keys(s.events);
  ok('r5 H1 a scheduled hearing seen on two days is one event, keyed by its hearing day, dated the day first seen, confirmed', ks.length === 1 && /\|HD2026-11-04@house-committee-on-science$/.test(ks[0]) && s.events[ks[0]].date === '2026-10-20' && s.events[ks[0]].status === 'confirmed');
  upsertItems(s, [hs('2026-10-22')], { runId: 'd3', now: day('2026-10-22') });
  ok('r5 H1 seen a third day: still one event, nothing superseded', Object.keys(s.events).length === 1 && s.events[ks[0]].status === 'confirmed');
  markShown(s, ks, '2026-10-22');
  const r = upsertItems(s, [hs('2026-10-23', { withdrawn: true, meeting_status: 'Cancelled' })], { runId: 'd4', now: day('2026-10-23') });
  ok('r5 H1 cancelled: the one event is withdrawn (never masked by a carried copy), no second event', Object.keys(s.events).length === 1 && s.events[ks[0]].status === 'withdrawn' && r.withdrawn.includes(ks[0]));
  // a stored event under the old date key (or any other key) with the same source id: the cancellation still withdraws it
  const s2 = emptyState();
  upsertItems(s2, [hs('2026-10-20')], { runId: 'd1', now: day('2026-10-20') });
  const [k0] = Object.keys(s2.events), old = 'US|x|hearing-scheduled|2026-10-20';
  s2.events[old] = { ...s2.events[k0], key: old }; delete s2.events[k0];
  upsertItems(s2, [hs('2026-10-21', { hearing_date: '2026-11-05', withdrawn: true })], { runId: 'd2', now: day('2026-10-21') });
  ok('r5 H1 a cancellation is applied by source id across keys; a fresh item wins over the carried copy', s2.events[old].status === 'withdrawn');
  const { applyRun } = await import('./confirm.mjs');
  const evx = { key: 'k', jurisdiction: 'US', entry_id: 'x', class: 'hearing-scheduled', date: '2026-10-20', status: 'confirmed', facts: { hearing_date: '2026-11-04' }, history: [], sources: [{ role: 'official', source: 'congress_gov', source_id: 'm1' }] };
  const base = { source: 'congress_gov', source_id: 'm1', jurisdiction: 'US', entry_id: 'x', class: 'hearing-scheduled', date: '2026-10-20' };
  for (const order of [[{ ...base, facts: { hearing_date: '2026-11-04' }, carried: true }, { ...base, facts: { hearing_date: '2026-11-04', withdrawn: true } }], [{ ...base, facts: { hearing_date: '2026-11-04', withdrawn: true } }, { ...base, facts: { hearing_date: '2026-11-04' }, carried: true }]]) {
    ok('r5 H1 applyRun: a fresh cancellation wins over a carried copy in either order', applyRun([evx], order).events[0].status === 'withdrawn');
  }
  // Open States: the adapter dates an upcoming hearing the day it is seen; the key does not move
  const os = await import('./sources/openstates.mjs');
  const oev = { id: 'ocd-event/1', start_date: '2026-11-04T10:00:00', status: 'confirmed', name: 'Hearing', participants: [{ name: 'Senate Judiciary' }] };
  const a1 = os.eventToItem(oev, { state: 'CA', entry_id: 'ca-x' }, '2026-10-20T06:00:00Z'), a2 = os.eventToItem(oev, { state: 'CA', entry_id: 'ca-x' }, '2026-10-21T06:00:00Z');
  ok('r5 H1 Open States: two days, one key', a1.date !== a2.date && eventKey(a1) === eventKey(a2));

  // M6: companion bills under one entry, same-day actions: separate events, never confirming each other
  const comp = (n, src = 'legiscan', sid = n) => ({ source: src, source_id: `${src}-${sid}`, jurisdiction: 'NY', entry_id: 'ny-raise', class: 'passage', date: '2026-06-10', facts: { chamber: 'Senate', number: n, action: 'Passed Senate' }, url: 'https://www.nysenate.gov/legislation/bills/2025/x', title: n, retrieved_at: '2026-06-11T00:00:00Z' });
  const s3 = emptyState();
  upsertItems(s3, [comp('NY S6953'), comp('NY A6453'), comp('A 6453', 'nysenate', 'a')], { runId: 'm1', now: new Date('2026-06-11T06:00:00Z') });
  const keys3 = Object.keys(s3.events).sort();
  const evA = Object.values(s3.events).find((e) => /#A6453$/.test(e.key)), evS = Object.values(s3.events).find((e) => /#S6953$/.test(e.key));
  ok('r5 M6 two companions passing on one day are two events (the bill number is in the key)', keys3.length === 2 && evA && evS);
  ok('r5 M6 a record of one companion never confirms the other', evA.status === 'confirmed' && evS.status !== 'confirmed');
  const { compare } = await import('./confirm.mjs');
  ok('r5 M6 compare: different bill numbers are unrelated', compare({ ...evS }, { ...comp('A6453', 'nysenate'), facts: { chamber: 'Senate', number: 'A6453' } }) === null && compare({ ...evA }, { ...comp('A6453B', 'nysenate'), facts: { chamber: 'Senate', number: 'A 6453B' } }) === 'agree');

  // L2: Open States votes need the event's own chamber and a result that agrees with the action
  const vote = (o) => ({ start_date: '2026-06-10', motion_text: 'Third Reading', result: 'pass', organization: { classification: 'upper' }, counts: [{ option: 'yes', value: 40 }, { option: 'no', value: 20 }], ...o });
  ok('r5 L2 a matching vote is used', JSON.stringify(os.voteFacts([vote({})], '2026-06-10', 'upper', 'passage')) === JSON.stringify({ yes: 40, no: 20, result: 'pass' }));
  ok('r5 L2 no organization, the other chamber, no chamber on the action, or a result that disagrees: no vote', os.voteFacts([vote({ organization: null })], '2026-06-10', 'upper', 'passage') === null
    && os.voteFacts([vote({ organization: { classification: 'lower' } })], '2026-06-10', 'upper', 'passage') === null && os.voteFacts([vote({})], '2026-06-10', null, 'passage') === null
    && os.voteFacts([vote({ result: 'fail' })], '2026-06-10', 'upper', 'passage') === null && os.voteFacts([vote({ result: 'pass' })], '2026-06-10', 'upper', 'failure') === null
    && JSON.stringify(os.voteFacts([vote({ result: 'fail' })], '2026-06-10', 'upper', 'failure')) === JSON.stringify({ yes: 40, no: 20, result: 'fail' }));

  // M5: the template fallback uses the fact-sheet rules (DC Mayor, one chamber, resolutions)
  const T = (j, cls, facts, short = 'Measure X') => templateFor({ key: 'k', jurisdiction: j, entry_id: 'x', class: cls, date: '2026-10-27', facts: { action: 'Official action words here.', ...facts }, sources: [{ role: 'official', source: 'legiscan' }] }, { short_name: short, title: short });
  const dc = T('DC', 'executive-receipt', { number: 'B 26-0123' }), ne = T('NE', 'concurrence', { number: 'LB 1405', chamber: 'Legislature' }), res = T('CA', 'executive-receipt', { number: 'ACA 1' }), sig = T('MT', 'executive-signature', { number: 'HJ 4' }), ca = T('CA', 'executive-receipt', { number: 'AB 1018' });
  ok('r5 M5 template: DC is the Mayor; Nebraska never "both chambers"; a resolution is never sent to the Governor or signed into law', dc && /Mayor/.test(dc.headline) && !/Governor/.test(dc.headline)
    && (!ne || !/both chambers/i.test(ne.headline)) && res === null && sig && !/into law|Governor/i.test(sig.headline) && ca && /Governor/.test(ca.headline) && !/signs or vetoes/.test(JSON.stringify([dc, ne, sig, ca])));
}

console.log(`news events: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
