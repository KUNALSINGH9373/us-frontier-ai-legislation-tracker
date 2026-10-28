// update.mjs tests: the whole chain on fixtures (the real S. 2938 hearing run against the site data of 8 Oct 2026), with the network
// steps replaced by fakes. A run that succeeds promotes the staged data, lists and state at once (web and docs byte-identical); a failure
// injected in any step leaves web, docs, the tracked-bill lists and the state byte-identical to before. Also the commit rules. No network.
//   node test-update.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { runUpdate } from './update.mjs';
import { publishRun } from './publish/run.mjs';
import { compareRun } from './compare/run.mjs';
import { writeChangeset, sha } from './grabber/lib/run-common.mjs';
import { heldDue } from './update.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, 'fixtures', 'publish');
const KEY = 's-2938-ai-risk-evaluation-act', RUN = 'run-20261006-1553-c59a';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const j = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// A repository in a temp folder: web and docs data, the tracked-bill lists, the state, and the work folder.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-'));
  const pipelineDir = path.join(root, 'pipeline');
  const P = { pipelineDir, root, dataDir: path.join(root, 'web', 'data', 'v2'), docsDir: path.join(root, 'docs', 'data', 'v2'), idsFile: path.join(pipelineDir, 'config', 'identifiers.json'), lsIdsFile: path.join(pipelineDir, 'config', 'identifiers-legiscan.json'), stateDir: path.join(pipelineDir, 'state'), workDir: path.join(pipelineDir, 'data') };
  for (const d of [P.dataDir, P.docsDir]) fs.cpSync(path.join(FX, 'data-2026-10-08'), d, { recursive: true });
  fs.mkdirSync(path.dirname(P.idsFile), { recursive: true });
  fs.copyFileSync(path.join(here, 'config', 'identifiers.json'), P.idsFile);
  fs.copyFileSync(path.join(here, 'config', 'identifiers-legiscan.json'), P.lsIdsFile);
  fs.mkdirSync(P.stateDir, { recursive: true });
  fs.writeFileSync(path.join(P.stateDir, 'state.json'), JSON.stringify({ version: 1, sources: {} }, null, 1) + '\n');
  fs.writeFileSync(path.join(P.stateDir, 'corrections.json'), '{"last_run":null,"items":{}}\n');
  fs.writeFileSync(path.join(P.stateDir, 'legiscan-usage.json'), '{"month":"2026-10","used":15000,"runs":9}\n');
  return P;
}

// Every file under web/, docs/, pipeline/config and pipeline/state, with its bytes (the work folder pipeline/data is left out).
function files(P) {
  const out = {};
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { out[p + '/'] = 'dir'; walk(p); } else out[p] = fs.readFileSync(p).toString('base64'); } };
  [path.join(P.root, 'web'), path.join(P.root, 'docs'), path.dirname(P.idsFile), P.stateDir].forEach(walk);
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The grabber, faked: the S. 2938 run for Congress.gov, empty runs for the Federal Register and LegiScan (LegiScan skipped on its cap),
// and next-state files written into the staging folder it is given.
function fakeGrab({ P, stateDir }) {
  const runs = path.join(P.workDir, 'runs');
  fs.cpSync(path.join(FX, 'run-20261006'), path.join(runs, RUN), { recursive: true });
  fs.writeFileSync(path.join(runs, RUN, 'grab-stats.json'), JSON.stringify({ source: 'congress_gov', run_id: RUN, items: 1, stats: {}, checked_keys: [KEY] }));
  const ids = [];
  for (const [src, n] of [['federal_register', 'aaaa'], ['legiscan', 'bbbb']]) {
    const id = `run-20261028-1200-${n}`;
    writeChangeset({ outDir: runs, runId: id, items: [] });
    fs.writeFileSync(path.join(runs, id, 'grab-stats.json'), JSON.stringify({ source: src, run_id: id, items: 0, stats: {}, checked_keys: [], ...(src === 'legiscan' ? { skipped_why: 'LegiScan monthly cap reached (15000/15000 in 2026-10); state bills not checked this run' } : {}) }));
    ids.push(id);
  }
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ version: 1, sources: { congress_gov: { last_success: '2026-10-28T12:00:00Z', cursor: '2026-10-28T11:58:00Z', hashes: {} } } }, null, 1) + '\n');
  fs.writeFileSync(path.join(stateDir, 'waiting-for-text.json'), '{"items":{}}\n');
  return [RUN, ...ids];
}
const quietGrab = ({ P }) => {
  const runs = path.join(P.workDir, 'runs');
  return ['cccc', 'dddd', 'eeee'].map((n, i) => { const id = `run-20261028-1200-${n}`; writeChangeset({ outDir: runs, runId: id, items: [] }); fs.writeFileSync(path.join(runs, id, 'grab-stats.json'), JSON.stringify({ source: ['congress_gov', 'federal_register', 'legiscan'][i], run_id: id, items: 0, stats: {}, checked_keys: [] })); return id; });
};

const CONFIG = { max_entries_changed_per_run: 15, max_new_entries_per_run: 0, news_from_official_actions: true, copy_to_docs: true, courts: { enabled: true }, ai_step: { enabled: false } };
const factory = { hasKey: false, keyName: 'ANTHROPIC_API_KEY', monthStatus: () => ({ over: false, spent: 0, cap: 50 }), spend: { between: () => [] } };
const okSteps = {
  grab: fakeGrab,
  // the fixture run keeps its recorded diff (its change set lists bills whose raw text the fixture does not carry)
  compareRun: (o) => (fs.existsSync(path.join(o.runDir, 'diff.json')) ? j(path.join(o.runDir, 'diff.json')) : compareRun(o)),
  courtsRun: async (o) => { fs.writeFileSync(o.stateFile, '{"dockets":{"69":{"last_date":"2026-10-27"}}}\n'); return { status: 'quiet', requests: 1, errors: [], read: [{ entry_key: 'court-case-key', docket_id: '69' }], result: { touched: [], data: null }, summary: '' }; },
  correctRun: async (o) => { fs.writeFileSync(o.stateFile, '{"last_run":"2026-10-28","items":{}}\n'); return { ran: true, skipped_why: null, status: 'quiet', checked: [], corrected: [], problems: [], summary: '' }; },
  linkRun: async () => ({ status: 'nothing', proposed: [], applied: [], companions: [], dropped: [], problems: [], summary: '' }),
  newsRun: async (o) => { fs.writeFileSync(o.seenFile, '{"items":{"x":{"first_seen":"2026-10-28"}}}\n'); return { skipped_why: null, status: 'quiet', leads: [], drafted: [], summary: '' }; },
  parity: () => {}
};
const run = (P, over = {}, config = {}, flags = {}) => runUpdate({ P, config: { ...CONFIG, ...config }, models: {}, factory, flags: { source: 'all', ...flags }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date('2026-10-28T12:00:00Z'), deps: { ...okSteps, ...over }, log: () => {}, logErr: () => {} });

// ---------- a run that succeeds ----------
{
  const P = setup(), b = files(P);
  const { code, rep } = await run(P);
  const e = j(path.join(P.dataDir, 'entries.json')).find((x) => x.key === KEY);
  ok('the run succeeds', code === 0, rep && rep.error);
  ok('the hearing is promoted to web/data/v2', e.events.some((v) => v.date === '2026-09-30' && v.text === 'Committee on Homeland Security and Governmental Affairs. Hearings held'));
  const v2 = fs.readdirSync(P.dataDir).filter((f) => f.endsWith('.json'));
  ok('web and docs hold the same bytes for every data file', v2.length >= 6 && v2.every((f) => fs.readFileSync(path.join(P.dataDir, f)).equals(fs.readFileSync(path.join(P.docsDir, f)))), v2.join());
  ok('the change log and status.json are new files in both', fs.existsSync(path.join(P.docsDir, 'changes.json')) && fs.existsSync(path.join(P.docsDir, 'status.json')));
  ok('the grabber state is promoted after the whole run', j(path.join(P.stateDir, 'state.json')).sources.congress_gov.cursor === '2026-10-28T11:58:00Z' && fs.existsSync(path.join(P.stateDir, 'waiting-for-text.json')));
  ok('courts, correction and news state are promoted', j(path.join(P.stateDir, 'courts-state.json')).dockets['69'] && j(path.join(P.stateDir, 'corrections.json')).last_run === '2026-10-28' && j(path.join(P.stateDir, 'news-seen.json')).items.x);
  ok('the tracked-bill lists are unchanged (no new entry)', fs.readFileSync(P.idsFile).toString('base64') === b[P.idsFile] && fs.readFileSync(P.lsIdsFile).toString('base64') === b[P.lsIdsFile]);
  const st = j(path.join(P.dataDir, 'status.json'));
  ok('status.json marks only the entries read this run (grab-stats per bill, the court docket read)', same(Object.keys(st.checked).sort(), ['court-case-key', KEY].sort()), JSON.stringify(st.checked));
  ok('the LegiScan cap skip is a note in the run report', rep.notes.some((n) => /legiscan skipped: LegiScan monthly cap reached/.test(n)), rep.notes.join(' | '));
  ok('the staging folder is removed and no temp file is left', !fs.existsSync(path.join(P.workDir, 'staging', rep.id)) && !Object.keys(files(P)).some((f) => f.endsWith('.tmp')));
  ok('the run report lists what was promoted', rep.promoted.includes('web/data/v2/entries.json') && rep.promoted.includes('docs/data/v2/entries.json') && rep.promoted.includes('pipeline/state/state.json'));
}

// ---------- a failure in any step: nothing is promoted ----------
const boom = (what) => async (o) => { throw new Error(what + ' failed'); };
const cases = [
  ['the second source\'s publish stops', { publishRun: (() => { let n = 0; return (o) => (n++ === 1 ? { status: 'stopped', summary: 'stopped\n', result: null } : publishRun(o)); })() }, {}, 'publish'],
  ['the court-docket step throws', { courtsRun: async (o) => { fs.writeFileSync(o.stateFile, '{"dockets":{}}'); throw new Error('CourtListener down'); } }, {}, 'court dockets'],
  ['the court-docket publish stops', { courtsRun: async () => ({ status: 'stopped', summary: 'x', requests: 0, errors: [], result: { touched: [] } }) }, {}, 'court dockets'],
  ['the self-correction throws', { correctRun: async (o) => { fs.writeFileSync(o.stateFile, '{}'); throw new Error('model service down'); } }, {}, 'self-correction'],
  ['the links step throws', { linkRun: async (o) => { const f = path.join(o.dataDir, 'relationships.json'), r = j(f); r.edges.pop(); fs.writeFileSync(f, JSON.stringify(r)); throw new Error('links failed'); } }, {}, 'links'],
  ['the news step throws', { newsRun: async (o) => { fs.writeFileSync(o.seenFile, '{"items":{"y":1}}'); throw new Error('feed down'); } }, {}, 'news'],
  ['status.json fails its schema', { validateStatus: () => ['/last_checked must match format'] }, {}, 'status'],
  ['the site check fails', { parity: () => { throw new Error('exit 1'); } }, {}, 'site check'],
  ['the final check finds a problem that names no entry (a step changed the site file)', { correctRun: async (o) => { const f = path.join(o.dataDir, 'site.json'), x = j(f); x.extra_field = 1; fs.writeFileSync(f, JSON.stringify(x, null, 1)); return { ran: true, skipped_why: null, status: 'quiet', checked: [], corrected: [], problems: [], summary: '' }; } }, {}, 'final check'],
  ['a publish stop that names no entry or item (unexplained)', { publishRun: (o) => { const r = publishRun({ ...o, dry: true }); return { ...r, status: 'stopped', summary: 'stopped\n', check: { problems: ['3 entries would change, over the limit of 2 per run'] } }; } }, {}, 'publish'],
  ['the per-run limit is crossed over the whole run, not in one step', { courtsRun: async (o) => { const f = path.join(o.dataDir, 'entries.json'), es = j(f), e = es.find((x) => x.key === 'h-r-9925-frontier-act'); e.status_text += '; x'; e.last_checked = '2026-10-28'; fs.writeFileSync(f, JSON.stringify(es, null, 1)); return { status: 'published', summary: 'x', requests: 0, errors: [], read: [], result: { touched: [], data: null } }; } }, { max_entries_changed_per_run: 1 }, 'final check'],
  ['the grabber stops', { grab: boom('the grabber') }, {}, 'grab'],
  ['a docs file cannot be written', { io: { ...fs, writeFileSync: (f, b) => { if (/docs[\\/]data[\\/]v2[\\/]entries\.json\.tmp$/.test(f)) throw new Error('EACCES: docs not writable'); return fs.writeFileSync(f, b); } } }, {}, 'promote'],
  ['a docs file cannot be renamed into place (after web was)', { io: { ...fs, renameSync: (a, b) => { if (/docs[\\/]data[\\/]v2[\\/]news\.json$/.test(b)) throw new Error('EBUSY'); return fs.renameSync(a, b); } } }, {}, 'promote']
];
for (const [name, over, config, stepName] of cases) {
  const P = setup(), b = files(P);
  const { code, rep } = await run(P, over, config);
  const a = files(P), diff = Object.keys({ ...a, ...b }).filter((f) => a[f] !== b[f]);
  ok(`${name}: exit 1 at that step`, code === 1 && rep.failed_step === stepName, `${code} ${rep && rep.failed_step} ${rep && rep.error}`);
  ok(`${name}: web, docs, lists and state are byte-identical to before`, diff.length === 0, diff.map((f) => path.relative(P.root, f)).join(', '));
}
{
  // a real directory where the temp file must go: the write fails without any hook
  const P = setup(); fs.mkdirSync(path.join(P.docsDir, 'entries.json.tmp')); const b = files(P);
  const { code, rep } = await run(P);
  const a = files(P);
  ok('docs write failure (a real one): nothing promoted', code === 1 && rep.failed_step === 'promote' && same(a, b), rep && rep.error);
}
{
  // a dry run never promotes
  const P = setup(), b = files(P);
  const { code } = await run(P, {}, {}, { dry: true });
  ok('a dry run changes no real file', code === 0 && same(files(P), b));
}

// ---------- a stop that names an entry holds it; everything else is promoted ----------
{
  // a step makes a change no step may make on one entry: that entry is put back and held, the rest of the run is promoted
  const P = setup(), b = files(P);
  const { code, rep } = await run(P, { correctRun: async (o) => { const f = path.join(o.dataDir, 'entries.json'), es = j(f); es.find((x) => x.key === KEY).title += ' (edited)'; fs.writeFileSync(f, JSON.stringify(es, null, 1)); return { ran: true, skipped_why: null, status: 'quiet', checked: [], corrected: [], problems: [], summary: '' }; } });
  const h = j(path.join(P.stateDir, 'held-items.json')).items, e = j(path.join(P.dataDir, 'entries.json')).find((x) => x.key === KEY);
  ok('final check: the run goes on without the refused entry (exit 0)', code === 0, rep && rep.error);
  ok('final check: nothing the check rejected is promoted (entries byte-identical)', fs.readFileSync(path.join(P.dataDir, 'entries.json')).toString('base64') === b[path.join(P.dataDir, 'entries.json')] && !/edited/.test(e.title));
  ok('final check: the entry\'s item is held with its stored copy', h['final check:congress_gov:119/s/2938'] && h['final check:congress_gov:119/s/2938'].replay && h['final check:congress_gov:119/s/2938'].tries === 1, JSON.stringify(Object.keys(h)));
  ok('final check: the rest is promoted (grabber state)', j(path.join(P.stateDir, 'state.json')).sources.congress_gov.cursor === '2026-10-28T11:58:00Z');
  ok('final check: the hold is reported', rep.held.some((x) => x.kind === 'stop' && /final check/.test(x.reason)) && rep.notes.some((n) => /held/.test(n)), JSON.stringify(rep.held));
}
{
  // a poison item next to a clean one, on consecutive runs; then the poison item becomes valid
  const P9925 = 'congress_gov:119/hr/9925', K9925 = 'h-r-9925-frontier-act';
  const RAW = JSON.stringify({ bill: { number: '9925', latestAction: { actionDate: '2026-10-01', text: 'Committee on Science, Space, and Technology. Hearings held.' } } });
  const poisonGrab = (withPoison) => (o) => {
    const ids = fakeGrab(o), dir = path.join(o.P.workDir, 'runs', RUN);
    if (!withPoison) return ids;
    fs.mkdirSync(path.join(dir, 'raw', 'congress_gov'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'raw', 'congress_gov', '119-hr-9925.json'), RAW);
    const cs = j(path.join(dir, 'changeset.json')); cs.items.find((i) => i.item_id === P9925).raw_hash = sha(RAW); fs.writeFileSync(path.join(dir, 'changeset.json'), JSON.stringify(cs));
    const df = j(path.join(dir, 'diff.json')); Object.assign(df.items.find((d) => d.item_id === P9925), { verdict: 'material', reasons: [{ kind: 'new_action', detail: '2026-10-01: Committee on Science, Space, and Technology. Hearings held.', api_value: 'Committee on Science, Space, and Technology. Hearings held.' }] });
    fs.writeFileSync(path.join(dir, 'diff.json'), JSON.stringify(df));
    return ids;
  };
  let poison = true;
  // the stop rule, as a guard would word it, while the item is bad
  const guarded = (o) => { const r = publishRun({ ...o, dry: true }); return poison && r.result.touched.includes(K9925) ? { ...r, status: 'stopped', check: { problems: [`field title changed on ${K9925}: Tier A may not change it`] } } : publishRun(o); };
  const at = (iso, over) => runUpdate({ P, config: CONFIG, models: {}, factory, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date(iso), deps: { ...okSteps, publishRun: guarded, ...over }, log: () => {}, logErr: () => {} });
  const P = setup();
  const r1 = await at('2026-10-28T12:00:00Z', { grab: poisonGrab(true) });
  const e1 = j(path.join(P.dataDir, 'entries.json')), h1 = j(path.join(P.stateDir, 'held-items.json')).items['publish:' + P9925];
  ok('poison run 1: exit 0', r1.code === 0, r1.rep.error);
  ok('poison run 1: the clean item is promoted', e1.find((x) => x.key === KEY).events.some((v) => v.date === '2026-09-30'));
  ok('poison run 1: the poison item is not', !e1.find((x) => x.key === K9925).events.some((v) => v.date === '2026-10-01'));
  ok('poison run 1: held with a stored copy, 1 try', h1 && h1.tries === 1 && h1.first_seen === '2026-10-28T12:00:00Z' && h1.replay && h1.replay.raw === RAW, JSON.stringify(h1 && { ...h1, replay: !!h1.replay }));
  ok('poison run 1: reported', r1.rep.held.some((x) => x.kind === 'stop' && x.item_id === P9925));
  // run 2: the site data back to the start, so the clean item is new again
  for (const d of [P.dataDir, P.docsDir]) fs.cpSync(path.join(FX, 'data-2026-10-08'), d, { recursive: true });
  for (const d of [P.dataDir, P.docsDir]) for (const f of ['changes.json', 'status.json']) fs.rmSync(path.join(d, f), { force: true });
  const r2 = await at('2026-10-28T16:00:00Z', { grab: poisonGrab(true) });
  const e2 = j(path.join(P.dataDir, 'entries.json')), h2 = j(path.join(P.stateDir, 'held-items.json')).items['publish:' + P9925];
  ok('poison run 2: the clean item is promoted again (not blocked)', r2.code === 0 && e2.find((x) => x.key === KEY).events.some((v) => v.date === '2026-09-30'), r2.rep.error);
  ok('poison run 2: still held, 2 tries, first seen kept', h2 && h2.tries === 2 && h2.first_seen === '2026-10-28T12:00:00Z' && h2.last_tried === '2026-10-28T16:00:00Z');
  ok('poison run 2: reported again', r2.rep.held.some((x) => x.kind === 'stop' && x.item_id === P9925 && /2 tries/.test(x.reason)), JSON.stringify(r2.rep.held));
  ok('held items: retried every run on the first day, then once a day', heldDue(h2, new Date('2026-10-29T08:00:00Z')) && !heldDue({ first_seen: '2026-10-26T12:00:00Z', last_tried: '2026-10-28T09:00:00Z' }, new Date('2026-10-28T16:00:00Z')) && heldDue({ first_seen: '2026-10-26T12:00:00Z', last_tried: '2026-10-27T20:00:00Z' }, new Date('2026-10-28T04:00:00Z')));
  // run 3: the item is valid now; the grabber does not bring it again, so it is published from its stored copy
  poison = false;
  const r3 = await at('2026-10-28T20:00:00Z', { grab: poisonGrab(false) });
  const e3 = j(path.join(P.dataDir, 'entries.json')), h3 = j(path.join(P.stateDir, 'held-items.json')).items;
  ok('poison run 3: the formerly held item is published', r3.code === 0 && e3.find((x) => x.key === K9925).events.some((v) => v.date === '2026-10-01' && /Hearings held/.test(v.text)), r3.rep.error);
  ok('poison run 3: and removed from held-items.json', Object.keys(h3).length === 0, JSON.stringify(Object.keys(h3)));
  ok('poison run 3: nothing reported as held', !r3.rep.held.some((x) => x.kind === 'stop'));
}
{
  // a court-docket stop that names one case: that case is held, the other cases are read again and promoted
  const P = setup(), calls = [];
  fs.copyFileSync(path.join(here, 'config', 'courts.json'), path.join(P.pipelineDir, 'config', 'courts.json'));
  const courts = async (o) => {
    calls.push(Object.keys(o.cases));
    if (o.cases['protect-democracy-v-oncd']) return { status: 'stopped', summary: 'x', requests: 0, errors: [], read: [], check: { problems: ['deleted event on protect-democracy-v-oncd: 2026-01-01 x'] }, result: { touched: [] } };
    fs.writeFileSync(o.stateFile, '{"dockets":{"69":{"last_date":"2026-10-27"}}}\n');
    return { status: 'quiet', requests: 1, errors: [], read: Object.keys(o.cases).filter((k) => !k.startsWith('_')).map((k) => ({ entry_key: k })), result: { touched: [], data: null }, summary: '' };
  };
  const { code, rep } = await run(P, { courtsRun: courts });
  const h = j(path.join(P.stateDir, 'held-items.json')).items;
  ok('courts stop: the run goes on (exit 0), the rest is read again without the held case', code === 0 && calls.length === 2 && !calls[1].includes('protect-democracy-v-oncd') && calls[1].length === calls[0].length - 1, `${rep.error} ${JSON.stringify(calls)}`);
  ok('courts stop: the case is held and reported', h['court dockets:protect-democracy-v-oncd'] && rep.held.some((x) => x.kind === 'stop' && /court dockets/.test(x.reason)));
}
{
  // S-8: the links allowance is the links step's own edges: an edge appended by another step is refused, and the network is put back
  const P = setup(), b = files(P), rel = path.join(P.dataDir, 'relationships.json');
  const r0 = j(rel), keys = Object.keys(r0.nodes);
  const edge = (from, to) => ({ from, to, type: Object.keys(r0.types)[0], label: 'related bill', quote: 'a quote long enough', source_url: 'https://example.com/a', origin: 'automated', src: 'pipeline:links:code' });
  const { code, rep } = await run(P, {
    linkRun: async (o) => { const f = path.join(o.dataDir, 'relationships.json'), r = j(f), e = edge(keys[0], keys[keys.length - 1]); r.edges.push(e); fs.writeFileSync(f, JSON.stringify(r, null, 1)); return { status: 'written', proposed: [e], applied: [{ from: e.from, to: e.to, type: e.type, label: e.label }], companions: [], dropped: [], problems: [], summary: 'links' }; },
    newsRun: async (o) => { const f = path.join(o.dataDir, 'relationships.json'), r = j(f); r.edges.push(edge(keys[1], keys[keys.length - 2])); fs.writeFileSync(f, JSON.stringify(r, null, 1)); return { skipped_why: null, status: 'quiet', leads: [], drafted: [], summary: '' }; }
  });
  ok('links: an extra edge from another step is refused by the final check and not promoted', code === 0 && fs.readFileSync(rel).toString('base64') === b[rel] && rep.held.some((x) => x.kind === 'stop' && /links/.test(x.reason)), `${code} ${rep.error} ${JSON.stringify(rep.held)}`);
}
{
  // web and docs differ after promotion: every promoted file goes back to its bytes before the promotion
  const P = setup(), b = files(P);
  const { code, rep } = await run(P, { readBack: (f) => (/web[\\/]data[\\/]v2[\\/]entries\.json$/.test(f) ? Buffer.from('x') : fs.readFileSync(f)) });
  const a = files(P), diff = Object.keys({ ...a, ...b }).filter((f) => a[f] !== b[f]);
  ok('web != docs after promotion: rolled back, exit 1', code === 1 && rep.failed_step === 'promote' && diff.length === 0, `${rep.error} ${diff.join(', ')}`);
}
{
  // a stray temp file from a crash is removed at startup; a file a step drops into staging is never promoted
  const P = setup(); fs.writeFileSync(path.join(P.dataDir, 'entries.json.tmp'), 'half'); fs.writeFileSync(path.join(P.stateDir, 'state.json.tmp'), 'half');
  const { code } = await run(P, { newsRun: async (o) => { fs.writeFileSync(path.join(o.dataDir, 'stray.json'), '{}'); return { skipped_why: null, status: 'quiet', leads: [], drafted: [], summary: '' }; } });
  ok('stray *.json.tmp removed at startup', code === 0 && !fs.existsSync(path.join(P.dataDir, 'entries.json.tmp')) && !fs.existsSync(path.join(P.stateDir, 'state.json.tmp')));
  ok('only the data files and status.json are promoted', !fs.existsSync(path.join(P.dataDir, 'stray.json')) && !fs.existsSync(path.join(P.docsDir, 'stray.json')));
}

// ---------- the commit ----------
function fakeGit(answers) {
  const calls = [];
  const git = (args, o = {}) => { calls.push({ args, input: o.input }); const k = args[0] === 'diff' ? 'diff' : args[0]; const q = answers[k]; const r = Array.isArray(q) ? q.shift() : q; return typeof r === 'object' ? r : { status: r ?? 0, stdout: '', stderr: '' }; };
  return { git, calls };
}
{
  const P = setup(), g = fakeGit({ add: 0, diff: [1, 1], log: { status: 0, stdout: '2026-10-28\n' }, commit: 0 });
  const { code } = await run(P, { git: g.git }, {}, { commit: true });
  const add = g.calls.find((c) => c.args[0] === 'add').args, commit = g.calls.find((c) => c.args[0] === 'commit');
  ok('commit: the full list is staged (data and relationships, docs copies, lists, state/)', code === 0 && ['web/data/v2/entries.json', 'web/data/v2/relationships.json', 'web/data/v2/changes.json', 'docs/data/v2/changes.json', 'docs/data/v2/relationships.json', 'pipeline/config/identifiers.json', 'pipeline/config/identifiers-legiscan.json', 'pipeline/state'].every((f) => add.includes(f)), add.join(' '));
  ok('commit: a data change commits with the publish summary', commit && /^data: /.test(commit.input));
  ok('commit: status.json goes in with a data change', g.calls.some((c) => c.args[0] === 'add' && c.args.includes('web/data/v2/status.json')));
}
{
  const P = setup(), g = fakeGit({ add: 0, diff: [1, 1], log: { status: 0, stdout: '' }, commit: { status: 128, stdout: '', stderr: 'Please tell me who you are' } });
  const { code, rep } = await run(P, { git: g.git }, {}, { commit: true });
  ok('commit: a real git failure fails the run (exit 1), never "nothing to commit"', code === 1 && rep.failed_step === 'commit' && /git commit failed \(exit 128\)/.test(rep.error), rep.error);
}
{
  const P = setup(), g = fakeGit({ add: 0, diff: { status: 129, stdout: '', stderr: 'bad' }, log: { status: 0, stdout: '' } });
  const { code, rep } = await run(P, { git: g.git }, {}, { commit: true });
  ok('commit: a failing git diff fails the run', code === 1 && /diff --cached failed/.test(rep.error), rep.error);
}
{
  // a quiet run whose status.json was already committed today: nothing staged, no commit
  const P = setup(), g = fakeGit({ add: 0, diff: [0, 0], log: { status: 0, stdout: '2026-10-28\n' }, commit: 0 });
  const { code } = await run(P, { git: g.git, grab: quietGrab, courtsRun: async () => ({ status: 'quiet', requests: 0, errors: [], read: [], result: { touched: [] } }), correctRun: async () => ({ skipped_why: 'already ran today', status: 'quiet', checked: [], corrected: [] }), newsRun: async () => ({ skipped_why: 'off', status: 'quiet', leads: [], drafted: [] }) }, {}, { commit: true });
  ok('commit: status.json alone is not committed twice in a day', code === 0 && !g.calls.some((c) => c.args[0] === 'commit') && !g.calls.some((c) => c.args[0] === 'add' && c.args.includes('web/data/v2/status.json')));
}
{
  const P = setup(), g = fakeGit({ add: 0, diff: [0, 1], log: { status: 0, stdout: '2026-10-27\n' }, commit: 0 });
  const { code } = await run(P, { git: g.git, grab: quietGrab, courtsRun: async () => ({ status: 'quiet', requests: 0, errors: [], read: [], result: { touched: [] } }), correctRun: async () => ({ skipped_why: 'already ran today', status: 'quiet', checked: [], corrected: [] }), newsRun: async () => ({ skipped_why: 'off', status: 'quiet', leads: [], drafted: [] }) }, {}, { commit: true });
  const commit = g.calls.find((c) => c.args[0] === 'commit');
  ok('commit: status.json alone is committed once a day', code === 0 && commit && /^status only: /.test(commit.input), commit && commit.input);
}
{
  const P = setup(), g = fakeGit({ add: 0, diff: [1], commit: 0 });
  const { code } = await run(P, { git: g.git, newsRun: boom('news') }, {}, { commit: true });
  const commit = g.calls.find((c) => c.args[0] === 'commit');
  ok('a failed run commits only the spend counters (LegiScan usage and AI ledger)', code === 1 && commit && commit.args.includes('pipeline/state/legiscan-usage.json') && !commit.args.some((x) => /web|docs|state\.json$/.test(x)), commit && commit.args.join(' '));
}

console.log(`update: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
