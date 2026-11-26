// New lawsuits (agents/lawsuit.mjs, publish/lawsuits.mjs) on the real California AG release of 16 Nov 2026 (fixtures/lawsuits/, read from
// oag.ca.gov on 26 Nov 2026) and the frozen site data of 26 Nov 2026, with fake writer and reviewer models. No network, no AI.
//   node publish/test-lawsuits.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WRITER_SYSTEM, REVIEWER_SYSTEM, isLawsuitLead, officialOf, writerProblems, readReview, writeLawsuit, lawsuitEntry } from '../agents/lawsuit.mjs';
import { lawsuitsRun, lawsuitLeads } from './lawsuits.mjs';
import { htmlToText } from '../grabber/lib/text.mjs';
import { HttpError } from '../grabber/lib/http.mjs';
import { checkNewEntry } from './guards.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { loadData } from './run.mjs';
import { coveredBy } from '../news/open-leads.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const URL1 = 'https://oag.ca.gov/news/press-releases/it%E2%80%99s-golden-state-not-wild-west-attorney-general-bonta-sues-openai-over';
const HTML = fs.readFileSync(path.join(here, '..', 'fixtures', 'lawsuits', 'ca-ag-v-openai-2026-11-16.html'), 'utf8');
const TITLE = 'It’s the Golden State, not the Wild West: Attorney General Bonta Sues OpenAI Over Cybersecurity Incidents';
const release = { url: URL1, title: TITLE, publisher: 'California Attorney General', date: '2026-11-16', text: htmlToText(HTML) };
const GOOD = {
  in_scope: true, scope_reason: 'A state lawsuit against a frontier AI developer over the testing of its models.',
  scope_quote: 'California Attorney General Rob Bonta today filed a lawsuit against OpenAI alleging the company misled and endangered the public',
  plaintiff: 'California Attorney General Rob Bonta', defendant: 'OpenAI', parties_quote: 'California Attorney General Rob Bonta today filed a lawsuit against OpenAI',
  court: 'San Francisco Superior Court', court_quote: 'In the lawsuit, filed today in San Francisco Superior Court',
  filed_date: '2026-11-16', date_quote: 'Rob Bonta today filed a lawsuit against OpenAI',
  claims: 'The Attorney General alleges that OpenAI tested advanced AI models without the safeguards and monitoring needed to protect the public, and that the Hugging Face attack, one of at least 80 cyber incidents, was foreseeable.',
  claims_quotes: ['knowingly developing and testing advanced artificial intelligence (AI) models without the safeguards and monitoring necessary to adequately protect the public', 'the Hugging Face attack — one of at least 80 cyber incidents — was entirely foreseeable'] };
const ALL_CHECKED = { checked: ['scope', 'plaintiff', 'defendant', 'court', 'filed_date', 'claims'], findings: [] };
const fakeLlm = (answers) => { const calls = []; return { calls, async generate(req) { calls.push(req); const a = answers.shift(); if (a instanceof Error) throw a; return { data: typeof a === 'function' ? a(req) : a }; } }; };

// ---------- 1. the lead screen ----------
ok('a release announcing a lawsuit against an AI developer is a lawsuit lead', isLawsuitLead({ title: TITLE }));
ok('an investigation, a settlement or an unrelated lawsuit is not', !isLawsuitLead({ title: 'Attorney General Opens Investigation Into OpenAI' }) && !isLawsuitLead({ title: 'Attorney General Davenport Sues to Protect Housing Assistance' }));
ok('only the listed official hosts are read', officialOf(URL1).state === 'CA' && officialOf('https://www.atg.wa.gov/news/news-releases/x').state === 'WA' && !officialOf('https://www.politico.com/x') && !officialOf('not a url'));

ok('scope: writer and reviewer both rule out facility, energy and permit cases even with a frontier lab as a party (owner, 26 Nov 2026)', [WRITER_SYSTEM, REVIEWER_SYSTEM].every((p) => /facilities, power supply, energy, environmental permits/.test(p) && /EVEN WHEN a frontier lab is a party/.test(p)));

// ---------- 2. code checks on the writer's answer ----------
ok('a correct answer passes every code check', writerProblems(GOOD, release).length === 0, writerProblems(GOOD, release).join('; '));
const bad = (patch) => writerProblems({ ...GOOD, ...patch }, release);
ok('an invented quote is refused', bad({ claims_quotes: ['OpenAI admitted it broke the law'] }).some((p) => /not in the release/.test(p)));
ok('a number not in the quotes is refused', bad({ claims: 'OpenAI had at least 95 incidents.' }).some((p) => /number 95/.test(p)));
ok('a date the quote does not state is refused', bad({ filed_date: '2026-11-14' }).some((p) => /does not state 2026-11-14/.test(p)));
ok('a court the court quote does not name is refused', bad({ court: 'Los Angeles Superior Court' }).length > 0);
ok('an out-of-scope answer needs no quotes', writerProblems({ in_scope: false, scope_reason: 'x' }, release).length === 0);

// ---------- 3. the reviewer ----------
ok('a finding the release does not prove is discarded', readReview({ ...ALL_CHECKED, findings: [{ field: 'court', severity: 'WRONG', problem: 'x', quote: 'not in the release at all' }] }, release).pass);
ok('a proved finding fails the draft', !readReview({ ...ALL_CHECKED, findings: [{ field: 'claims', severity: 'MISLEADING', problem: 'allegation stated as fact', quote: 'the Hugging Face attack — one of at least 80 cyber incidents' }] }, release).pass);
ok('a review that skips a field does not pass', !readReview({ checked: ['scope'], findings: [] }, release).pass);

// ---------- 4. write and review ----------
{
  const w = await writeLawsuit({ writer: fakeLlm([GOOD]), reviewer: fakeLlm([ALL_CHECKED]), release });
  ok('a clean draft and a clean review: publishable', w.decision === 'publishable', JSON.stringify(w.reason || w.trail));
  const retry = await writeLawsuit({ writer: fakeLlm([{ ...GOOD, claims_quotes: ['made up'] }, GOOD]), reviewer: fakeLlm([ALL_CHECKED]), release });
  ok('a draft that fails its checks is asked once more, with the problems', retry.decision === 'publishable' && retry.trail.writer_calls === 2);
  const twice = await writeLawsuit({ writer: fakeLlm([{ ...GOOD, claims_quotes: ['made up'] }, { ...GOOD, claims_quotes: ['made up'] }]), reviewer: fakeLlm([ALL_CHECKED]), release });
  ok('failing twice: held, never published', twice.decision === 'held' && /code checks/.test(twice.reason));
  const wrong = await writeLawsuit({ writer: fakeLlm([GOOD]), reviewer: fakeLlm([{ ...ALL_CHECKED, findings: [{ field: 'claims', severity: 'MISLEADING', problem: 'states an allegation as fact', quote: 'the Hugging Face attack — one of at least 80 cyber incidents' }] }]), release });
  ok('a proved reviewer finding: held', wrong.decision === 'held' && /MISLEADING claims/.test(wrong.reason));
  const scope = await writeLawsuit({ writer: fakeLlm([GOOD]), reviewer: fakeLlm([{ ...ALL_CHECKED, findings: [{ field: 'scope', severity: 'WRONG', problem: 'not frontier', quote: 'Rob Bonta today filed a lawsuit against OpenAI' }] }]), release });
  ok('the reviewer proving it out of scope: out of scope, no entry', scope.decision === 'out_of_scope');
  const out = await writeLawsuit({ writer: fakeLlm([{ ...GOOD, in_scope: false, scope_reason: 'not about frontier AI' }]), reviewer: fakeLlm([]), release });
  ok('the writer ruling it out: no review is spent', out.decision === 'out_of_scope');
}

// ---------- 5. the entry ----------
{
  const e = lawsuitEntry({ out: GOOD, release, today: '2026-11-26', runId: 'r', at: '2026-11-26T08:00:00Z', id: 999 });
  ok('the entry passes its schema', makeValidator().check('entry', e).length === 0, makeValidator().check('entry', e).join('; '));
  ok('the entry passes the new-entry guard', checkNewEntry(e).length === 0, checkNewEntry(e).join('; '));
  ok('a state AG case is on its state tile, G.2, litigation, automated', e.section === 'G.2' && e.level === 'state' && e.state === 'CA' && e.status === 'litigation' && e.origin === 'automated');
  ok('its event is the filing, dated and sourced', e.events.length === 1 && e.events[0].date === '2026-11-16' && e.events[0].text === 'California Attorney General Rob Bonta sues OpenAI in San Francisco Superior Court' && e.events[0].source_url === URL1);
  ok('every reading field has its quote; the release is the source', e.evidence.some((x) => x.field === 'mechanism') && e.sources[0].url === URL1 && e.confidence.basis === 'primary_record');
  ok('its title names the parties and the court', e.title === 'California Attorney General Rob Bonta v. OpenAI (San Francisco Superior Court)' && e.short_name === 'California v. OpenAI');
  const noDate = lawsuitEntry({ out: { ...GOOD, filed_date: '', date_quote: '' }, release, today: '2026-11-26', runId: 'r', at: '2026-11-26T08:00:00Z', id: 999 });
  ok('no filing date in the release: no event, the status says when it was announced', noDate.events.length === 0 && /^Announced Nov 16, 2026/.test(noDate.status_text) && makeValidator().check('entry', noDate).length === 0);
}

// ---------- 6. the step ----------
const LIVE = path.join(here, '..', 'fixtures', 'live-2026-11-26');
const setup = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lawsuits-'));
  for (const f of ['entries', 'news', 'site', 'relationships', 'changes']) fs.copyFileSync(path.join(LIVE, f + '.json'), path.join(d, f + '.json'));
  // the frozen data already has this case (added by hand on 25 Nov): take it out, as if it were new
  const ents = JSON.parse(fs.readFileSync(path.join(d, 'entries.json'), 'utf8')).filter((e) => e.key !== 'california-ag-v-openai-agent-cyberattacks');
  fs.writeFileSync(path.join(d, 'entries.json'), JSON.stringify(ents));
  const rel = JSON.parse(fs.readFileSync(path.join(d, 'relationships.json'), 'utf8'));
  const news = JSON.parse(fs.readFileSync(path.join(d, 'news.json'), 'utf8')); news.items = news.items.filter((n) => n.tracker !== 'california-ag-v-openai-agent-cyberattacks'); fs.writeFileSync(path.join(d, 'news.json'), JSON.stringify(news));
  for (const k of Object.keys(rel.nodes)) if (rel.nodes[k].entry_key === 'california-ag-v-openai-agent-cyberattacks') { rel.edges = rel.edges.filter((x) => x.from !== k && x.to !== k); delete rel.nodes[k]; }
  fs.writeFileSync(path.join(d, 'relationships.json'), JSON.stringify(rel));
  const leadsFile = path.join(d, 'news-open-leads.json'), stateFile = path.join(d, 'lawsuits.json');
  fs.writeFileSync(leadsFile, JSON.stringify({ items: { k1: { key: 'k1', title: TITLE, link: URL1, publisher: 'California Attorney General', date: '2026-11-16' }, k2: { key: 'k2', title: 'Attorney General Bonta Sues Over Housing', link: 'https://oag.ca.gov/news/x', date: '2026-11-17' }, k3: { key: 'k3', title: 'Politico: State sues OpenAI', link: 'https://www.politico.com/x', date: '2026-11-17' } } }));
  return { dir: d, leadsFile, stateFile };
};
const http = (over = {}) => ({ calls: [], async getText(u) { this.calls.push(u); if (over[u] instanceof Error) throw over[u]; return HTML; } });
const ON = { auto_publish: { lawsuits: true }, max_entries_changed_per_run: 15, max_new_entries_per_run: 3 };
{
  const s = setup(), h = http();
  ok('only the official lawsuit release is a lead (not the unrelated suit, not the press story)', lawsuitLeads(JSON.parse(fs.readFileSync(s.leadsFile, 'utf8')), { items: {} }).map((l) => l.key).join() === 'k1');
  const off = await lawsuitsRun({ http: h, writer: fakeLlm([]), reviewer: fakeLlm([]), dataDir: s.dir, leadsFile: s.leadsFile, stateFile: s.stateFile, config: { auto_publish: { lawsuits: false } }, now: new Date('2026-11-26T08:00:00Z'), runId: 'r0' });
  ok('switch off: nothing read, no AI, the waiting lead is counted', off.status === 'quiet' && off.waiting === 1 && h.calls.length === 0 && /off/.test(off.skipped_why));
  const before = loadData(s.dir);
  const r = await lawsuitsRun({ http: h, writer: fakeLlm([GOOD]), reviewer: fakeLlm([ALL_CHECKED]), dataDir: s.dir, leadsFile: s.leadsFile, stateFile: s.stateFile, config: ON, now: new Date('2026-11-26T08:00:00Z'), runId: 'r1' });
  const after = loadData(s.dir), e = after.entries.find((x) => x.key === r.added[0]?.entry_key);
  ok('switch on: the entry is added and written', r.status === 'written' && e && after.entries.length === before.entries.length + 1, JSON.stringify(r));
  ok('the change log records the new entry', after.changes.items.some((c) => c.entry_key === e.key && c.field === 'entry' && c.tier === 'B'));
  ok('the open lead is now covered by the entry\'s link', coveredBy({ link: URL1, title: TITLE }, { news: after.news, entries: after.entries }) !== null);
  const again = await lawsuitsRun({ http: h, writer: fakeLlm([]), reviewer: fakeLlm([]), dataDir: s.dir, leadsFile: s.leadsFile, stateFile: s.stateFile, config: ON, now: new Date('2026-11-26T12:00:00Z'), runId: 'r2' });
  ok('a lead is read once: the next run spends nothing on it', again.status === 'quiet' && again.waiting === 0 && h.calls.length === 1);
}
{
  const s = setup(), h = http({ [URL1]: new HttpError(503, URL1, '') });
  const r = await lawsuitsRun({ http: h, writer: fakeLlm([]), reviewer: fakeLlm([]), dataDir: s.dir, leadsFile: s.leadsFile, stateFile: s.stateFile, config: ON, now: new Date('2026-11-26T08:00:00Z'), runId: 'r3' });
  const st = JSON.parse(fs.readFileSync(s.stateFile, 'utf8'));
  ok('a release that cannot be read is tried again later, counted', r.errors.length === 1 && st.items.k1.outcome === 'unread' && st.items.k1.tries === 1 && lawsuitLeads(JSON.parse(fs.readFileSync(s.leadsFile, 'utf8')), st).length === 1);
  st.items.k1.tries = 3; fs.writeFileSync(s.stateFile, JSON.stringify(st));
  ok('after 3 tries it is no longer read (the open lead stays raised on the report)', lawsuitLeads(JSON.parse(fs.readFileSync(s.leadsFile, 'utf8')), st).length === 0);
  const s2 = setup();
  const held = await lawsuitsRun({ http: http(), writer: fakeLlm([GOOD]), reviewer: fakeLlm([{ ...ALL_CHECKED, findings: [{ field: 'court', severity: 'WRONG', problem: 'x', quote: 'In the lawsuit, filed today in San Francisco Superior Court' }] }]), dataDir: s2.dir, leadsFile: s2.leadsFile, stateFile: s2.stateFile, config: ON, now: new Date('2026-11-26T08:00:00Z'), runId: 'r4' });
  ok('a held draft writes nothing and is reported', held.added.length === 0 && held.held.length === 1 && held.status === 'quiet');
}

// ---------- 7. the measure's scoring, the gate and the report ----------
{
  const { scoreCase } = await import('../eval/lawsuits-set.mjs');
  const { gate } = await import('../eval/gate.mjs');
  const { watchLines } = await import('../report/format.mjs');
  const pos = { id: 'p', gold: { in_scope: true, defendant_includes: 'OpenAI', court_includes: 'San Francisco Superior Court', filed_date_any: ['2026-11-16'] } };
  ok('measure: a correct published case is right', !scoreCase(pos, { decision: 'publishable', out: GOOD }).wrong);
  ok('measure: a wrong court or date is wrong', scoreCase(pos, { decision: 'publishable', out: { ...GOOD, court: 'Alameda Superior Court' } }).wrong && scoreCase(pos, { decision: 'publishable', out: { ...GOOD, filed_date: '2026-11-15' } }).wrong);
  ok('measure: a published negative is wrong; a held positive is missed, not wrong', scoreCase({ id: 'n', gold: { in_scope: false } }, { decision: 'publishable', out: GOOD }).wrong && (() => { const s = scoreCase(pos, { decision: 'held' }); return !s.wrong && s.missed; })());
  ok('measure: a court the release does not name is wrong', scoreCase({ id: 'd', gold: { in_scope: true, defendant_includes_any: ['Colorado'], court_includes: null, filed_date_any: [''] } }, { decision: 'publishable', out: { ...GOOD, defendant: 'State of Colorado', court: 'D. Colo.', filed_date: '' } }).wrong);
  const models = { provider: 'anthropic', anthropic: { roles: { writer: { model: 'w' }, bill_reviewer: { model: 'r' } } } };
  const rep = (o) => ({ measure: 'lawsuits', run_at: '2026-11-26T00:00:00Z', checks_hash: 'h', writer: 'w', reviewer: 'r', cases: 11, published: 2, wrong: 0, errors: 0, ...o });
  const g = (r) => gate({ config: { auto_publish: { lawsuits: true } }, models, measures: r ? [r] : [], hashes: { lawsuits: 'h' }, expected: { lawsuits: 11 }, goldItems: 1 }).fields.lawsuits;
  ok('gate: a full passing report by the production models opens the switch', g(rep()).meets === true);
  ok('gate: no report, a wrong case, a partial run, other models or old code keep it closed', !g(null).meets && !g(rep({ wrong: 1 })).meets && !g(rep({ cases: 5 })).meets && !g(rep({ writer: 'x' })).meets && !g(rep({ checks_hash: 'old' })).meets && !g(rep({ published: 0 })).meets);
  const w = watchLines({ sources: [], held: [], ai: {}, notes: [], lawsuits: { waiting: 1, added: [{ title: 'California Attorney General Rob Bonta v. OpenAI' }], held: [{ title: 'X v. Y', why: 'the reviewer found 1 problem(s)' }], out_of_scope: [], errors: [] } });
  ok('report: added entries are listed, held ones are an alert', w.some((l) => /^1 lawsuit entry added from official releases/.test(l)) && w.some((l) => /^⚠️ 1 lawsuit release not published/.test(l)), w.join('\n'));
}

console.log(`lawsuits: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
