// Publisher tests: the real S. 2938 hearing (run of 6 Oct 2026) against the site data of 8 Oct 2026, every stop rule,
// the key match, dedupe and a quiet run. No network.
//   node publish/test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { publishRun, loadData } from './run.mjs';
import { checkPublish } from './guards.mjs';
import { applyTierA } from './tier-a.mjs';
import { makeValidator } from '../schema/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, '..', 'fixtures', 'publish');
const CONFIG = { max_entries_changed_per_run: 15, news_from_official_actions: true };
const KEY = 's-2938-ai-risk-evaluation-act';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };

// A fresh copy of the data and the run in a temp folder; edit(data, run) may change either before publishing.
function setup(edit = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  const dataDir = path.join(dir, 'data'), docsDir = path.join(dir, 'docs'), runDir = path.join(dir, 'run');
  fs.cpSync(path.join(FX, 'data-2026-10-08'), dataDir, { recursive: true });
  fs.cpSync(path.join(FX, 'run-20261006'), runDir, { recursive: true });
  const j = (f) => JSON.parse(fs.readFileSync(f, 'utf8')), w = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 1));
  const data = { entries: j(path.join(dataDir, 'entries.json')), site: j(path.join(dataDir, 'site.json')) };
  const run = { diff: j(path.join(runDir, 'diff.json')), changeset: j(path.join(runDir, 'changeset.json')) };
  edit(data, run, runDir);
  w(path.join(dataDir, 'entries.json'), data.entries); w(path.join(dataDir, 'site.json'), data.site);
  w(path.join(runDir, 'diff.json'), run.diff); w(path.join(runDir, 'changeset.json'), run.changeset);
  const mtimes = () => fs.readdirSync(dataDir).map((f) => fs.statSync(path.join(dataDir, f)).mtimeMs + f).join();
  return { dir, dataDir, docsDir, runDir, mtimes };
}
const publish = (s, over = {}) => publishRun({ runDir: s.runDir, dataDir: s.dataDir, docsDir: s.docsDir, config: { ...CONFIG, ...over } });
const entry = (dir, key = KEY) => loadData(dir).entries.find((e) => e.key === key);

// ---------- the real case ----------
{
  const s = setup(), before = entry(s.dataDir);
  const r = publish(s), e = entry(s.dataDir), d = loadData(s.dataDir);
  ok('the S. 2938 run publishes', r.status === 'published', r.summary);
  ok('the hearing becomes an event with its official wording and source', e.events.some((v) => v.date === '2026-09-30' && v.type === 'Referred / stalled / hearing' && v.text === 'Committee on Homeland Security and Governmental Affairs. Hearings held' && /congress\.gov/.test(v.source_url)));
  // the author's "No action in 11+ months" is out of date once the hearing is added, so that clause (only) is dropped
  ok('the status text keeps the author\'s words, drops the stale "No action in 11+ months" and adds the action with date and source', before.status_text.endsWith('. No action in 11+ months') && e.status_text === 'Introduced / status: Sept 29, 2025; referred to Senate Commerce; Committee on Homeland Security and Governmental Affairs. Hearings held (Sept 30, 2026, Congress.gov)', e.status_text);
  ok('reading fields are untouched', e.mechanism === before.mechanism && e.thresholds === before.thresholds && e.penalties === before.penalties && e.title === before.title);
  ok('the entry is marked mixed, checked by the agent run', e.origin === 'mixed' && e.verification.method === 'agent' && e.verification.run_id === 'run-20261006-1553-c59a' && e.last_checked === '2026-10-06' && e.last_changed === '2026-10-06');
  ok('evidence quotes the official action', e.evidence.some((x) => x.quote === 'Committee on Homeland Security and Governmental Affairs. Hearings held'));
  const n = d.news.items.filter((x) => x.origin === 'automated');
  ok('one news item in fixed wording, linked to the entry and the official page', n.length === 1 && n[0].tracker === KEY && n[0].kind === 'federal' && n[0].date === '2026-09-30' && /no AI/.test(n[0].check) && n[0].evidence.length === 1);
  ok('the change log records every changed field', ['events', 'status_text', 'origin'].every((f) => d.changes.items.some((c) => c.entry_key === KEY && c.field === f && c.tier === 'A')));
  ok('the data cut-off does not move back for an older run', d.site.updates_through === '2026-10-08' && d.news.asof === 'October 8, 2026');
  ok('only that entry changed', loadData(s.dataDir).entries.filter((x) => x.origin !== 'authored').length === 1);
  ok('the same files are written for the live site (docs)', fs.readFileSync(path.join(s.docsDir, 'entries.json'), 'utf8') === fs.readFileSync(path.join(s.dataDir, 'entries.json'), 'utf8'));
  ok('a summary is written in the run folder', /1 entry updated/.test(fs.readFileSync(path.join(s.runDir, 'publish-summary.md'), 'utf8')));
  // the same run again: everything is already there, so nothing is written
  const m = s.mtimes(), r2 = publish(s);
  ok('publishing the same run twice adds nothing (dedupe) and writes nothing', r2.status === 'quiet' && s.mtimes() === m && entry(s.dataDir).events.length === e.events.length, r2.status);
}

// ---------- quiet run ----------
{
  const s = setup((d, run) => { run.diff.items.forEach((i) => { if (i.verdict === 'material') { i.verdict = 'minor'; i.reasons = []; } }); });
  const m = s.mtimes(), r = publish(s);
  ok('a run with nothing material writes nothing', r.status === 'quiet' && s.mtimes() === m && !fs.existsSync(path.join(s.docsDir, 'entries.json')));
}

// ---------- entries are matched by key, never by row number ----------
{
  const s = setup((d) => { const a = d.entries.find((e) => e.key === KEY), b = d.entries[0]; [a.id, b.id] = [b.id, a.id]; d.entries.reverse(); });
  publish(s);
  ok('a reordered, renumbered data set still updates the right entry', entry(s.dataDir).origin === 'mixed' && loadData(s.dataDir).entries.filter((x) => x.origin === 'mixed').length === 1);
}

// ---------- stop rules ----------
{
  const s = setup((d, run, runDir) => fs.appendFileSync(path.join(runDir, 'raw', 'congress_gov', '119-s-2938.json'), ' '));
  const m = s.mtimes(), r = publish(s);
  ok('stop: a stored source that changed after it was fetched', r.status === 'stopped' && r.check.problems.some((p) => /stored source changed/.test(p)) && s.mtimes() === m);
}
{
  const s = setup(), m = s.mtimes(), r = publish(s, { max_entries_changed_per_run: 0 });
  ok('stop: more entries than the per-run limit', r.status === 'stopped' && r.check.problems.some((p) => /over the limit/.test(p)) && s.mtimes() === m);
}
{
  const s = setup((d, run) => { d.entries.find((e) => e.key === KEY).status = 'enacted'; run.diff.items.find((i) => i.entry_key === KEY).reasons.push({ kind: 'status_change', detail: 'Latest action implies "failed".', api_value: 'failed', our_value: 'enacted' }); });
  const r = publish(s), e = entry(s.dataDir);
  // the record's latest action is the hearing, which proves no veto: the status is not written (the guard below stops it if it were)
  ok('a status the record\'s own words do not prove is not written (enacted -> failed on a hearing)', e.status === 'enacted' && r.result.skipped.some((x) => x.entry_key === KEY && /status failed: the record's own words do not say it/.test(x.why)), r.summary);
}
{
  const s = setup((d, run) => { run.diff.items.find((i) => i.entry_key === KEY).reasons = [{ kind: 'sponsor_change', detail: 'Sponsor differs.', api_value: 'x', our_value: 'y' }]; });
  const r = publish(s);
  ok('a reason that is not a Tier A fact is reported, not applied', r.status === 'quiet' && r.result.skipped.some((x) => /sponsor_change is not a Tier A fact/.test(x.why)));
}
{
  const s = setup((d, run) => { const it = run.diff.items.find((i) => i.entry_key === KEY); it.reasons[0].api_value = 'Passed Senate with an amendment by Unanimous Consent'; it.reasons[0].detail = '2026-09-30: Passed Senate with an amendment by Unanimous Consent'; });
  const r = publish(s);
  ok('an action the stored record does not contain is not applied', r.status === 'quiet' && r.result.skipped.some((x) => /not found in the stored record/.test(x.why)));
}
{
  // checkPublish directly, for changes Tier A itself never makes
  const before = loadData(path.join(FX, 'data-2026-10-08'));
  const variant = (f) => { const a = JSON.parse(JSON.stringify(before)); f(a); return checkPublish({ before, after: a, runDate: '2026-10-08', maxEntries: 15 }).problems; };
  ok('the unchanged data set passes every rule', variant(() => {}).length === 0, variant(() => {}).join('; '));
  ok('stop: a reading field changed (mechanism)', variant((a) => { a.entries[0].mechanism += ' x'; }).some((p) => /field mechanism changed/.test(p)));
  ok('stop: an event deleted', variant((a) => { a.entries[0].events.pop(); }).some((p) => /deleted event/.test(p)));
  ok('stop: a source link deleted', variant((a) => { a.entries[0].sources = a.entries[0].sources.slice(1); }).some((p) => /deleted link|schema/.test(p)));
  const withStatus = (s) => { const a = JSON.parse(JSON.stringify(before)); a.entries.find((x) => x.key === KEY).status = s; return a; };
  ok('stop: a status going backwards (enacted -> failed)', checkPublish({ before: withStatus('enacted'), after: withStatus('failed'), runDate: '2026-10-08', maxEntries: 15 }).problems.some((p) => /status went backwards/.test(p)));
  ok('stop: an entry deleted',variant((a) => { a.entries.pop(); }).some((p) => /deleted entry/.test(p)));
  ok('stop: a news item deleted or edited', variant((a) => { a.news.items[0].title += '!'; }).some((p) => /news items deleted or edited/.test(p)));
  ok('stop: a future event not marked scheduled', variant((a) => { const e = a.entries.find((x) => x.status === 'pending'); e.events.push({ date: '2026-12-01', precision: 'day', type: 'Passed / advanced', text: 'x', scheduled: false }); }).some((p) => /future event not marked scheduled/.test(p)));
  ok('stop: a file that fails its schema', variant((a) => { a.entries[0].status = 'maybe'; }).some((p) => /^schema:/.test(p)));
  ok('stop: relationships changed', variant((a) => { a.relationships.edges.pop(); }).some((p) => /relationships changed/.test(p)));
}

// ---------- Tier A rules on the real S. 2938 record, with chosen actions and latest action (applyTierA, then the guards) ----------
const S2938 = JSON.parse(fs.readFileSync(path.join(FX, 'run-20261006', 'raw', 'congress_gov', '119-s-2938.json'), 'utf8'));
const URL_2938 = 'https://www.congress.gov/bill/119th-congress/senate-bill/2938';
const act = (date, text) => ({ kind: 'new_action', detail: `${date}: ${text}`, api_value: text });
function tierA({ key = KEY, editEntry = () => {}, latest = null, actions = [], reasons, identifiersFor }) {
  const data = loadData(path.join(FX, 'data-2026-10-08')), e = data.entries.find((x) => x.key === key);
  editEntry(e);
  const raw = JSON.parse(JSON.stringify(S2938));
  raw.actions = [...actions.map(([actionDate, text]) => ({ actionDate, text })), ...raw.actions];
  if (latest) raw.bill.latestAction = { actionDate: latest[0], text: latest[1] };
  const text = JSON.stringify(raw, null, 1);
  const item = { item_id: 'congress_gov:119/s/2938', source: 'congress_gov', entry_key: key, source_url: URL_2938, fetched_at: '2026-10-06T15:53:30Z', raw_path: 'raw/congress_gov/119-s-2938.json' };
  const a = applyTierA({ data, diff: { items: [{ item_id: item.item_id, entry_key: key, verdict: 'material', reasons }] }, changeset: { items: [item] }, readRaw: () => text, runId: 'run-20261006-1553-c59a', runDate: '2026-10-06', config: CONFIG, identifiersFor });
  const after = { ...a.data, relationships: data.relationships };
  return { a, e: a.data.entries.find((x) => x.key === key), before: e, news: a.data.news.items.filter((x) => x.origin === 'automated'), problems: checkPublish({ before: data, after, runDate: '2026-10-06', maxEntries: 15 }).problems };
}
{
  // within one date the most important action takes the line and the news item, whatever the API's order
  const ref = 'Referred to the Subcommittee on Emerging Threats and Spending Oversight.', rep = 'Committee on Homeland Security and Governmental Affairs. Ordered to be reported without amendment favorably.';
  const { e, news, problems } = tierA({ actions: [['2026-10-01', ref], ['2026-10-01', rep]], reasons: [act('2026-10-01', ref), act('2026-10-01', rep)] });
  ok('same date: the more important action (reported) gets the status line, the referral does not', e.status_text.endsWith(`; ${rep.replace(/\.$/, '')} (Oct 1, 2026, Congress.gov)`) && !e.status_text.includes('Subcommittee on Emerging'), e.status_text);
  ok('same date: one news item, for the reported action; both are events', news.length === 1 && news[0].title.includes('Ordered to be reported') && e.events.filter((v) => v.date === '2026-10-01').length === 2, JSON.stringify(news));
  ok('same date: it passes every guard', problems.length === 0, problems.join('; '));
}
{
  // procedural steps: never a status line or news
  const tab = 'Motion to reconsider laid on the table Agreed to without objection.', msg = 'Message on Senate action sent to the House.';
  const { a, e, before, news } = tierA({ actions: [['2026-10-02', tab], ['2026-10-02', msg]], reasons: [act('2026-10-02', tab), act('2026-10-02', msg)] });
  ok('procedural actions: no status line and no news', e.status_text === before.status_text && news.length === 0, e.status_text);
  ok('an action no rule types is not written at all, and reported', !e.events.some((v) => v.clause === msg.replace(/\.$/, '')) && a.skipped.some((x) => /procedural action, not written: Message on Senate/.test(x.why)));
}
{
  // back-fill: the status text already reaches Oct 3, 2026, so the Sept 30 hearing is an event only
  const { e, before, news, a } = tierA({ editEntry: (x) => { x.status_text = 'Introduced / status: Sept 29, 2025; referred to Senate Commerce; staff briefing Oct 3, 2026'; }, reasons: [act('2026-09-30', 'Committee on Homeland Security and Governmental Affairs. Hearings held.')] });
  ok('back-filled action: added as an event, no status line, no news', e.events.some((v) => v.date === '2026-09-30') && e.status_text === before.status_text && news.length === 0 && /event only: earlier than Oct 3, 2026/.test(a.applied[0].actions[0].text), JSON.stringify(a.applied));
}
{
  // the same verb within 14 days is already said; the disagreement is reported, not written twice
  const pass = 'Passed Senate without amendment by Unanimous Consent.';
  const { e, before, news, a } = tierA({ editEntry: (x) => { x.status_text = 'Introduced / status: Sept 29, 2025; passed the Senate Oct 1, 2026'; }, actions: [['2026-10-03', pass]], reasons: [act('2026-10-03', pass)] });
  ok('same verb on a date within 14 days: not duplicated, reported as a disagreement', e.status_text === before.status_text && news.length === 0 && a.disagreements.length === 1 && a.disagreements[0].said === '2026-10-01' && a.skipped.some((x) => /^disagreement:/.test(x.why)), JSON.stringify(a.disagreements));
}
{
  // R2 B2: a G.3 entry stays "export" when its bill becomes law; the action is kept
  const law = 'Became Public Law No: 119-60.';
  const { e, a, problems } = tierA({ key: 'ai-overwatch-act-fy27-ndaa', latest: ['2026-10-05', law], actions: [['2026-10-05', law]], reasons: [{ kind: 'status_change', detail: 'Latest action implies "enacted", the tracker says "export".', api_value: 'enacted', our_value: 'export' }, act('2026-10-05', law)] });
  ok('export -> enacted: the status stays export by the section rule, the law is an event, and the guards pass', e.status === 'export' && e.events.some((v) => v.date === '2026-10-05' && v.type === 'Signed / enacted') && a.log.every((c) => c.field !== 'status') && problems.length === 0, problems.join('; ') + JSON.stringify(a.skipped));
}
{
  const { e, a } = tierA({ editEntry: (x) => { x.section = 'B'; }, latest: ['2026-10-05', 'Became Public Law No: 119-60.'], reasons: [{ kind: 'status_change', detail: 'x', api_value: 'enacted', our_value: 'pending' }] });
  ok('B/B.2 -> enacted: no status by rule, nothing written, reported', e.status === 'pending' && a.touched.length === 0 && a.skipped.some((x) => /section B has no such status by rule/.test(x.why)), JSON.stringify(a.skipped));
}
{
  const st = { kind: 'status_change', detail: 'x', api_value: 'enacted', our_value: 'failed' };
  const law = tierA({ editEntry: (x) => { x.status = 'failed'; }, latest: ['2026-10-05', 'Became Public Law No: 119-61.'], reasons: [st] });
  ok('failed -> enacted when the record says it became public law (over the veto), with the status quote and a change-log line', law.e.status === 'enacted' && law.e.evidence.some((x) => x.field === 'status' && x.quote === 'Became Public Law No: 119-61') && law.a.log.some((c) => c.field === 'status' && c.old === 'failed' && c.new === 'enacted'), JSON.stringify(law.a.skipped));
  const signed = tierA({ editEntry: (x) => { x.status = 'failed'; }, latest: ['2026-10-05', 'Signed by President.'], reasons: [st] });
  ok('failed -> enacted is refused without "over veto" or "Became Public Law"', signed.e.status === 'failed' && signed.a.skipped.some((x) => /only over a veto or as a public law/.test(x.why)));
  const pend = tierA({ latest: ['2026-10-05', 'Became Public Law No: 119-61.'], reasons: [{ ...st, our_value: 'pending' }] });
  ok('pending -> enacted: status written with the record\'s words as evidence, and the guards pass', pend.e.status === 'enacted' && pend.e.evidence.some((x) => x.field === 'status' && /Became Public Law/.test(x.quote)) && pend.problems.length === 0, pend.problems.join('; '));
}
{
  // R2 B7: an authored Congress entry with no identifiers gets them from config/identifiers.json when it first becomes mixed
  const K = 's-5576-warner-schatz-kim-ai-risk-management-and-security-act';
  const s = setup((d, run) => { run.diff.items.find((i) => i.entry_key === KEY).entry_key = K; run.changeset.items.find((i) => i.entry_key === KEY).entry_key = K; d.entries.find((x) => x.key === K).status_text = 'Introduced / status: Oct 1, 2025'; });
  const before = entry(path.join(FX, 'data-2026-10-08'), K), r = publish(s), e = entry(s.dataDir, K);
  ok('an authored Congress entry with no identifiers publishes, with identifiers from config/identifiers.json, and passes its schema', !before.identifiers && r.status === 'published' && e.origin === 'mixed' && JSON.stringify(e.identifiers) === JSON.stringify({ session: '119th Congress', external: { congress_gov: ['119/s/5576'] } }) && makeValidator().check('entry', e).length === 0, r.summary);
}

console.log(`publisher: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
