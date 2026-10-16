// Publisher tests: the real S. 2938 hearing (run of 6 Oct 2026) against the site data of 8 Oct 2026, every stop rule,
// the key match, dedupe and a quiet run. No network.
//   node publish/test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { publishRun, loadData } from './run.mjs';
import { checkPublish } from './guards.mjs';

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
  ok('the status text keeps the author\'s words and adds the action with date and source', e.status_text.startsWith(before.status_text) && /Hearings held \(Sept 30, 2026, Congress\.gov\)$/.test(e.status_text));
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
  const m = s.mtimes(), r = publish(s);
  ok('stop: a status going backwards (enacted -> failed)', r.status === 'stopped' && r.check.problems.some((p) => /status went backwards/.test(p)) && s.mtimes() === m);
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
  ok('stop: an entry deleted', variant((a) => { a.entries.pop(); }).some((p) => /deleted entry/.test(p)));
  ok('stop: a news item deleted or edited', variant((a) => { a.news.items[0].title += '!'; }).some((p) => /news items deleted or edited/.test(p)));
  ok('stop: a future event not marked scheduled', variant((a) => { const e = a.entries.find((x) => x.status === 'pending'); e.events.push({ date: '2026-12-01', precision: 'day', type: 'Passed / advanced', text: 'x', scheduled: false }); }).some((p) => /future event not marked scheduled/.test(p)));
  ok('stop: a file that fails its schema', variant((a) => { a.entries[0].status = 'maybe'; }).some((p) => /^schema:/.test(p)));
  ok('stop: relationships changed', variant((a) => { a.relationships.edges.pop(); }).some((p) => /relationships changed/.test(p)));
}

console.log(`publisher: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
