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
import { heldDue, namedIn, isLimit, applyGate, gateInputsFor } from './update.mjs';

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
  const cg = j(path.join(P.stateDir, 'state.json')).sources.congress_gov;
  ok('final check: the rest is promoted (grabber state), the cursor moved back to the held bill\'s own date so it is fetched again', cg.last_success === '2026-10-28T12:00:00Z' && cg.cursor === '2026-10-02T11:03:19Z', JSON.stringify(cg));
  ok('final check: the hold is reported', rep.held.some((x) => x.kind === 'stop' && /final check/.test(x.reason)) && rep.notes.some((n) => /held/.test(n)), JSON.stringify(rep.held));
}
{
  // a poison item next to a clean one, on consecutive runs; then the poison item becomes valid
  const P9925 = 'congress_gov:119/hr/9925', K9925 = 'h-r-9925-frontier-act';
  const RAW = JSON.stringify({ bill: { number: '9925', latestAction: { actionDate: '2026-10-01', text: 'Committee on Science, Space, and Technology. Hearings held.' } } });
  const poisonGrab = (withPoison) => (o) => {
    const ids = fakeGrab(o), dir = path.join(o.P.workDir, 'runs', RUN);
    if (!withPoison) {
      // not fetched this run (a bill fetched again with no material change would leave the held list)
      for (const f of ['changeset.json', 'diff.json']) { const x = j(path.join(dir, f)); x.items = x.items.filter((i) => i.item_id !== P9925); fs.writeFileSync(path.join(dir, f), JSON.stringify(x)); }
      return ids;
    }
    fs.mkdirSync(path.join(dir, 'raw', 'congress_gov'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'raw', 'congress_gov', '119-hr-9925.json'), RAW);
    const cs = j(path.join(dir, 'changeset.json')); Object.assign(cs.items.find((i) => i.item_id === P9925), { raw_hash: sha(RAW), fetched_at: '2026-10-28T11:59:00Z' }); fs.writeFileSync(path.join(dir, 'changeset.json'), JSON.stringify(cs));
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
  // The accuracy gate is enforced at run time: a switch that is on in config/publish.json is OFF for the run unless the latest full
  // test-set report for the production model passes; the run report says why. The links step gets the run's records and new entries.
  const P = setup(); let seenCfg = null, linkOpts = null;
  const models = { provider: 'anthropic', anthropic: { roles: { generator: { model: 'claude-haiku-5-5' } } } };
  const { code, rep } = await runUpdate({ P, config: { ...CONFIG, auto_publish: { mechanism: false, new_entries: true, relationships: true, news: true }, eval_bar: { pass_rate: 1, unsupported_fields: 0, scope_agreement: 1 } }, models, factory, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date('2026-10-28T12:00:00Z'),
    deps: { ...okSteps, gateInputs: { reports: [{ generator: 'claude-haiku-5-5', run_at: '2026-10-27T00:00:00Z', summary: { items: 5, scope_agreement: 1, fields: { mechanism: { pass_rate: 1, unsupported_fields: 0 } } } }], goldItems: 48 },
      publishRun: (o) => { seenCfg = o.config; return (okSteps.publishRun || publishRun)(o); }, linkRun: async (o) => { linkOpts = o; return okSteps.linkRun(o); } }, log: () => {}, logErr: () => {} });
  ok('gate: new_entries, relationships and news are OFF for the run without a passing full test-set report', code === 0 && seenCfg && seenCfg.auto_publish.new_entries === false && seenCfg.auto_publish.relationships === false && seenCfg.auto_publish.news === false, `${code} ${rep.error} ${JSON.stringify(seenCfg && seenCfg.auto_publish)}`);
  ok('gate: the run report says which switches were turned off and why', rep.gate && rep.gate.off.map((x) => x.field).sort().join() === 'new_entries,news,relationships' && rep.notes.some((n) => /auto_publish\.new_entries is on in config\/publish\.json but treated as OFF/.test(n) && /every reading field must meet the bar|Tier B replay|new-bills report/.test(n)), JSON.stringify(rep.gate)); // the reason names the engine's own measure (config/pipeline.json new_bills.engine)
  // An unreadable report or gold file: every switch off with a note, and the run goes on (round 2, code review S7).
  const P2 = setup(); let cfg2 = null;
  const u2 = await runUpdate({ P: P2, config: { ...CONFIG, auto_publish: { mechanism: true, new_entries: true, relationships: true, news: true }, eval_bar: { pass_rate: 1, unsupported_fields: 0, scope_agreement: 1 } }, models, factory, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date('2026-10-28T12:00:00Z'),
    deps: { ...okSteps, gateInputs: { reports: [], goldItems: 0, error: 'eval/gold.json is unreadable' }, publishRun: (o) => { cfg2 = o.config; return (okSteps.publishRun || publishRun)(o); } }, log: () => {}, logErr: () => {} });
  ok('gate: unreadable gate inputs turn every switch off with a note, and the run continues', u2.code === 0 && cfg2 && Object.values(cfg2.auto_publish).every((v) => v === false) && u2.rep.notes.some((n) => /could not be read/.test(n)), `${u2.code} ${u2.rep && u2.rep.error} ${JSON.stringify(cfg2 && cfg2.auto_publish)}`);
  ok('links: the links step is given the records of the run and the entries created this run', linkOpts && typeof linkOpts.records === 'object' && Array.isArray(linkOpts.created));
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

// ---------- BL-1: a per-run limit holds the entries over it and promotes the rest ----------
const HEARING = 'Committee on Science, Space, and Technology. Hearings held.';
// The fixture run with `n` more tracked bills (one per entry) each bringing a hearing; `drop`: items not fetched this run.
const manyGrab = (n, drop = []) => (o) => {
  const ids = fakeGrab(o), dir = path.join(o.P.workDir, 'runs', RUN);
  const cs = j(path.join(dir, 'changeset.json')), df = j(path.join(dir, 'diff.json')), seen = new Set([KEY]);
  const extra = df.items.filter((d) => d.entry_key && !seen.has(d.entry_key) && seen.add(d.entry_key)).slice(0, n);
  for (const d of extra) {
    const raw = JSON.stringify({ bill: { latestAction: { actionDate: '2026-10-01', text: HEARING } } }), item = cs.items.find((i) => i.item_id === d.item_id);
    item.raw_path = `raw/congress_gov/${d.item_id.replace(/\W+/g, '-')}.json`;
    fs.mkdirSync(path.join(dir, 'raw', 'congress_gov'), { recursive: true }); fs.writeFileSync(path.join(dir, item.raw_path), raw);
    Object.assign(item, { raw_hash: sha(raw), fetched_at: '2026-10-28T11:59:00Z' });
    Object.assign(d, { verdict: 'material', reasons: [{ kind: 'new_action', detail: `2026-10-01: ${HEARING}`, api_value: HEARING }] });
  }
  cs.items = cs.items.filter((i) => !drop.includes(i.item_id)); df.items = df.items.filter((i) => !drop.includes(i.item_id));
  fs.writeFileSync(path.join(dir, 'changeset.json'), JSON.stringify(cs)); fs.writeFileSync(path.join(dir, 'diff.json'), JSON.stringify(df));
  o.extra = extra; return ids;
};
{
  const P = setup(), at = (iso, grab) => runUpdate({ P, config: CONFIG, models: {}, factory, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date(iso), deps: { ...okSteps, grab }, log: () => {}, logErr: () => {} });
  let extra = [];
  const r1 = await at('2026-10-28T12:00:00Z', (o) => { const ids = manyGrab(15)(o); extra = o.extra; return ids; });
  const start = j(path.join(FX, 'data-2026-10-08', 'entries.json')), e1 = j(path.join(P.dataDir, 'entries.json'));
  const changed = e1.filter((e) => JSON.stringify(e) !== JSON.stringify(start.find((x) => x.key === e.key))).map((e) => e.key);
  const all = [KEY, ...extra.map((d) => d.entry_key)].sort(), last = all[all.length - 1], heldItem = extra.find((d) => d.entry_key === last);
  const h1 = j(path.join(P.stateDir, 'held-items.json')).items;
  ok('limit: 16 material items in one run, exit 0', r1.code === 0, r1.rep.error);
  ok('limit: 15 entries promoted, the last in rank order (same rank: by key) held', changed.length === 15 && !changed.includes(last), JSON.stringify(changed));
  ok('limit: the held item is listed at the limit step and reported', h1['limit:' + heldItem.item_id] && r1.rep.held.some((x) => x.kind === 'stop' && /over the limit of 15/.test(x.reason)), JSON.stringify(Object.keys(h1)));
  ok('limit: the commit summary does not claim the held entry', !r1.rep.publish.runs.some((p) => p.entries_updated.some((u) => u.entry_key === last)));
  const r2 = await at('2026-10-28T16:00:00Z', manyGrab(0, extra.map((d) => d.item_id)));
  const e2 = j(path.join(P.dataDir, 'entries.json')).find((x) => x.key === last), ch = j(path.join(P.dataDir, 'changes.json')).items.filter((x) => x.entry_key === last);
  ok('limit: the next run publishes the held one from its copy (less than a day old)', r2.code === 0 && e2.events.some((v) => v.date === '2026-10-01' && /Hearings held/.test(v.text)) && !Object.keys(j(path.join(P.stateDir, 'held-items.json')).items).length, `${r2.rep.error} ${JSON.stringify(r2.rep.notes)} ${JSON.stringify(j(path.join(P.stateDir, 'held-items.json')).items, (k, v) => (k === 'replay' ? '-' : v))}`);
  ok('replay: the change log of a replayed item names the run that published it', ch.length && ch.every((x) => x.run_id === r2.rep.id), JSON.stringify(ch.map((x) => x.run_id)));
}
{
  // the whole-run limit crossed by a later step: the lower-ranked entry is put back and held, the rest promoted
  const P = setup();
  const { code, rep } = await run(P, { courtsRun: async (o) => { const f = path.join(o.dataDir, 'entries.json'), es = j(f), e = es.find((x) => x.key === 'h-r-9925-frontier-act'); e.status_text += '; x'; fs.writeFileSync(f, JSON.stringify(es, null, 1)); return { status: 'published', summary: 'x', requests: 0, errors: [], read: [], result: { touched: [], data: null } }; } }, { max_entries_changed_per_run: 1 });
  const es = j(path.join(P.dataDir, 'entries.json')), h = j(path.join(P.stateDir, 'held-items.json')).items;
  ok('whole-run limit: exit 0, the hearing (rank 40) is promoted', code === 0 && es.find((x) => x.key === KEY).events.some((v) => v.date === '2026-09-30'), rep.error);
  ok('whole-run limit: the unranked change is put back and held', !/; x$/.test(es.find((x) => x.key === 'h-r-9925-frontier-act').status_text) && h['limit:h-r-9925-frontier-act'], JSON.stringify(Object.keys(h)));
}

// ---------- SF-1: an entry put back takes the links to it along ----------
{
  const P = setup(), b = files(P), rel = path.join(P.dataDir, 'relationships.json'), NEW = 'zz-new-test-entry', NITEM = 'congress_gov:119/hr/1';
  const r0 = j(rel), oldNode = Object.keys(r0.nodes)[0];
  const tierB = (o) => {
    const r = publishRun(o);
    if (!/run-20261006/.test(o.runDir)) return r;
    const f = path.join(o.dataDir, 'entries.json'), es = j(f), e = JSON.parse(JSON.stringify(es.find((x) => x.key === KEY)));
    Object.assign(e, { key: NEW, id: NEW, section: 'J' }); es.push(e); fs.writeFileSync(f, JSON.stringify(es, null, 1));
    r.result.added = [{ entry_key: NEW, item_id: NITEM, section: 'J' }];
    return r;
  };
  const node = { name: 'New', column: 0, kind: 'entry', entry_key: NEW }, edge = { from: 'NEWN', to: oldNode, type: Object.keys(r0.types)[0], label: 'related', quote: 'a quote long enough', source_url: 'https://example.com/a', origin: 'automated', src: 'pipeline:links:code' };
  const { code, rep } = await run(P, {
    publishRun: tierB,
    linkRun: async (o) => { const f = path.join(o.dataDir, 'relationships.json'), r = j(f); r.nodes.NEWN = node; r.edges.push(edge); fs.writeFileSync(f, JSON.stringify(r, null, 1)); return { status: 'written', proposed: [edge], applied: [edge], added: { edges: [edge], nodes: { NEWN: node } }, companions: [], dropped: [], problems: [], summary: 'links' }; }
  }, { max_new_entries_per_run: 1 });
  const r1 = j(rel), h = j(path.join(P.stateDir, 'held-items.json')).items;
  ok('links: a refused new entry is put back with its node and edge (exit 0)', code === 0 && !r1.nodes.NEWN && r1.edges.length === r0.edges.length && fs.readFileSync(rel).toString('base64') === b[rel], `${rep.error} ${JSON.stringify(rep.final_check)}`);
  ok('links: the entry is gone and its item held; the rest promoted', !j(path.join(P.dataDir, 'entries.json')).some((x) => x.key === NEW) && h['final check:' + NITEM] && j(path.join(P.dataDir, 'entries.json')).find((x) => x.key === KEY).events.some((v) => v.date === '2026-09-30'), JSON.stringify(Object.keys(h)));
}

// ---------- new entries switched off by the gate: the AI step is told, so no escalation or referee confirmation is spent ----------
{
  const P = setup();
  let opts = null;
  const runAgents = async (o) => { opts = o; return { items: [], outcomes: {}, proposals: ['congress_gov:119/hr/1 (X, section F): proposal from the readers, not confirmed: new entries are switched off; not created'], llm: { calls: 0 } }; };
  // auto_publish.new_entries is on in the config, but the gate cannot be read (no model config): treated as off
  const { code, rep } = await runUpdate({ P, config: { ...CONFIG, ai_step: { enabled: true }, auto_publish: { new_entries: true } }, models: {}, factory: { ...factory, hasKey: true }, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date('2026-10-28T12:00:00Z'), deps: { ...okSteps, runAgents }, log: () => {}, logErr: () => {} });
  ok('gated new entries off: the AI step is run with newEntriesOn false', code === 0 && opts && opts.newEntriesOn === false, `${code} ${rep && rep.error} ${opts && opts.newEntriesOn}`);
  ok('gated new entries off: the unconfirmed draft is reported as a proposal, not as confirmed', rep.notes.some((n) => /proposal \(held, not created\): .*not confirmed: new entries are switched off/.test(n)), JSON.stringify(rep.notes));
}

// ---------- applyGate: a gate bug forces every switch off, never throws ----------
{
  const cfg = { auto_publish: { new_entries: true, relationships: true, news: false } };
  let out, threw = null;
  try { out = applyGate(cfg, { anthropic: {} }, { get reports() { throw new Error('gate bug'); } }); } catch (e) { threw = e; }
  ok('applyGate: a throwing gate does not throw', !threw, threw && threw.message);
  ok('applyGate: a throwing gate turns every switch off with a note', out && Object.values(out.config.auto_publish).every((v) => v === false) && out.off.length === 2 && out.off.every((x) => /gate bug/.test(x.why)) && cfg.auto_publish.new_entries === true, JSON.stringify(out));
}

// ---------- SF-2: held items are retried from fresh data, or expire with a report line ----------
{
  // a held item's copy is three days old: it is not published as current; its hash and cursor are forgotten so the grab fetches it again
  const P = setup(), P9925 = 'congress_gov:119/hr/9925';
  const raw = JSON.stringify({ bill: { updateDate: '2026-10-25T10:00:00Z', latestAction: { actionDate: '2026-10-01', text: HEARING } } });
  const replay = { run_id: 'run-old', item: { item_id: P9925, source: 'congress_gov', source_id: '119/hr/9925', entry_key: 'h-r-9925-frontier-act', change: 'changed', raw_path: 'raw/congress_gov/x.json', raw_hash: sha(raw), fetched_at: '2026-10-25T10:00:00Z' }, diff: { item_id: P9925, entry_key: 'h-r-9925-frontier-act', verdict: 'material', reasons: [{ kind: 'new_action', detail: `2026-10-01: ${HEARING}`, api_value: HEARING }] }, raw, result: null };
  fs.writeFileSync(path.join(P.stateDir, 'held-items.json'), JSON.stringify({ items: { ['publish:' + P9925]: { item_id: P9925, entry_key: 'h-r-9925-frontier-act', step: 'publish', reason: 'x', first_seen: '2026-10-25T10:00:00Z', last_tried: '2026-10-27T10:00:00Z', tries: 3, replay }, 'publish:legiscan:77': { item_id: 'legiscan:77', step: 'publish', reason: 'y', first_seen: '2026-10-27T10:00:00Z', last_tried: '2026-10-27T10:00:00Z', tries: 1 } } }));
  const grab = (o) => { const ids = fakeGrab(o); const dir = path.join(o.P.workDir, 'runs', RUN); for (const f of ['changeset.json', 'diff.json']) { const x = j(path.join(dir, f)); x.items = x.items.filter((i) => i.item_id !== P9925); fs.writeFileSync(path.join(dir, f), JSON.stringify(x)); } fs.writeFileSync(path.join(o.stateDir, 'state.json'), JSON.stringify({ version: 1, sources: { congress_gov: { last_success: '2026-10-28T12:00:00Z', cursor: '2026-10-28T11:58:00Z', hashes: { '119/hr/9925': 'abc', '119/s/1': 'def' } }, legiscan: { last_success: '2026-10-28T12:00:00Z', hashes: { 77: 'h' } } } })); fs.writeFileSync(path.join(o.stateDir, 'legiscan-seen.json'), '{"77":{"hash":"h"},"78":{"hash":"g"}}'); return ids; };
  const { code, rep } = await run(P, { grab });
  const e = j(path.join(P.dataDir, 'entries.json')).find((x) => x.key === 'h-r-9925-frontier-act'), st = j(path.join(P.stateDir, 'state.json')), h = j(path.join(P.stateDir, 'held-items.json')).items;
  ok('stale copy: not published as current facts', code === 0 && !e.events.some((v) => v.date === '2026-10-01'), rep.error);
  ok('stale copy: still held, waiting for the fresh fetch', h['publish:' + P9925] && h['publish:legiscan:77'], JSON.stringify(Object.keys(h)));
  ok('stale copy: its hash forgotten and the cursor moved back to its date', !('119/hr/9925' in st.sources.congress_gov.hashes) && st.sources.congress_gov.hashes['119/s/1'] === 'def' && st.sources.congress_gov.cursor === '2026-10-25T09:59:59Z', JSON.stringify(st.sources.congress_gov));
  ok('no copy at all: the LegiScan item is fetched again (hash and screening record forgotten)', !('77' in st.sources.legiscan.hashes) && !j(path.join(P.stateDir, 'legiscan-seen.json'))['77'] && j(path.join(P.stateDir, 'legiscan-seen.json'))['78']);
  // fourteen days on, still not published: dropped with a report line
  const r2 = await runUpdate({ P, config: CONFIG, models: {}, factory, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date('2026-11-08T12:00:00Z'), deps: { ...okSteps, grab }, log: () => {}, logErr: () => {} });
  ok('expiry: an item held 14 days is dropped and reported, never silently', r2.code === 0 && !j(path.join(P.stateDir, 'held-items.json')).items['publish:' + P9925] && r2.rep.notes.some((n) => n.includes(P9925) && /expired/.test(n)), JSON.stringify(r2.rep.notes));
}
{
  // a held item fetched again with no material change leaves the list, with a report line
  const P = setup(), P9925 = 'congress_gov:119/hr/9925';
  fs.writeFileSync(path.join(P.stateDir, 'held-items.json'), JSON.stringify({ items: { ['publish:' + P9925]: { item_id: P9925, step: 'publish', reason: 'x', first_seen: '2026-10-28T08:00:00Z', last_tried: '2026-10-28T08:00:00Z', tries: 1 } } }));
  const { code, rep } = await run(P);
  ok('fetched again, nothing left: no longer held, reported', code === 0 && !j(path.join(P.stateDir, 'held-items.json')).items['publish:' + P9925] && rep.notes.some((n) => n.includes(P9925) && /nothing left to publish/.test(n)), JSON.stringify(rep.notes));
}

{
  // a fresh copy retried that has nothing left to publish (its fact is already there) leaves the list with a report line
  const P = setup();
  await run(P);
  const cs = j(path.join(FX, 'run-20261006', 'changeset.json')), item = { ...cs.items.find((i) => i.item_id === 'congress_gov:119/s/2938'), fetched_at: '2026-10-28T11:00:00Z' };
  const replay = { run_id: RUN, item, diff: j(path.join(FX, 'run-20261006', 'diff.json')).items.find((d) => d.item_id === item.item_id), raw: fs.readFileSync(path.join(FX, 'run-20261006', item.raw_path), 'utf8'), result: null };
  fs.writeFileSync(path.join(P.stateDir, 'held-items.json'), JSON.stringify({ items: { ['publish:' + item.item_id]: { item_id: item.item_id, step: 'publish', reason: 'x', first_seen: '2026-10-28T11:00:00Z', last_tried: '2026-10-28T11:00:00Z', tries: 1, replay } } }));
  const { code, rep } = await runUpdate({ P, config: CONFIG, models: {}, factory, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date('2026-10-28T16:00:00Z'), deps: { ...okSteps, grab: quietGrab }, log: () => {}, logErr: () => {} });
  ok('retried, nothing left: no longer held, never silently', code === 0 && !Object.keys(j(path.join(P.stateDir, 'held-items.json')).items).length && rep.notes.some((n) => n.includes(item.item_id) && /nothing left to publish/.test(n)), `${rep.error} ${JSON.stringify(rep.notes)}`);
}

// ---------- SF-5: nothing reverted leaves a trace ----------
{
  const P = setup(), g = fakeGit({ add: 0, diff: [1, 1], log: { status: 0, stdout: '2026-10-27\n' }, commit: 0 });
  fs.writeFileSync(path.join(P.stateDir, 'news-seen.json'), '{"items":{"old":{"first_seen":"2026-10-01","outcome":"drafted"}}}\n');
  fs.writeFileSync(path.join(P.stateDir, 'corrections.json'), JSON.stringify({ last_run: null, items: { [KEY]: { sha: 'old' } } }) + '\n');
  const { code, rep } = await run(P, {
    git: g.git,
    correctRun: async (o) => { fs.writeFileSync(o.stateFile, JSON.stringify({ last_run: '2026-10-28', items: { [KEY]: { sha: 'new' }, other: { sha: 'o' } } })); const f = path.join(o.dataDir, 'entries.json'), es = j(f); es.find((x) => x.key === KEY).title += ' (edited)'; fs.writeFileSync(f, JSON.stringify(es, null, 1)); return { ran: true, skipped_why: null, status: 'quiet', checked: [], corrected: [], problems: [], summary: '' }; },
    newsRun: async (o) => { fs.writeFileSync(o.seenFile, '{"items":{"old":{"first_seen":"2026-10-01","outcome":"drafted"},"lead1":{"first_seen":"2026-10-28","outcome":"drafted"},"lead2":{"first_seen":"2026-10-28","outcome":"not_newsworthy"}}}\n'); return { skipped_why: null, status: 'written', leads: [], drafted: [{ tracker: KEY, written: true }], summary: 'news' }; }
  }, {}, { commit: true });
  const st = j(path.join(P.dataDir, 'status.json')), seen = j(path.join(P.stateDir, 'news-seen.json')).items, corr = j(path.join(P.stateDir, 'corrections.json')), commit = g.calls.find((c) => c.args[0] === 'commit');
  ok('revert leftovers: status.json last_change is not the reverted change\'s date, and the entry is not marked checked', code === 0 && st.last_change !== '2026-09-30' && !st.checked[KEY], `${rep.error} ${JSON.stringify(st)}`);
  ok('revert leftovers: the commit message does not claim the reverted entry', commit && !commit.input.includes(KEY), commit && commit.input);
  ok('revert leftovers: the self-correction record of the reverted entry goes back (others kept)', corr.items[KEY].sha === 'old' && corr.items.other && corr.last_run === '2026-10-28', JSON.stringify(corr));
  ok('revert leftovers: leads drafted this run are not marked seen; older and other marks kept', !seen.lead1 && seen.old && seen.lead2, JSON.stringify(seen));
}

// ---------- namedIn: only the guards' own positions name an entry ----------
{
  const K = 'h-r-9925-frontier-act', O = 's-2938-ai-risk-evaluation-act';
  const t = (p, want) => { const r = namedIn([p], [K, O]); return JSON.stringify([...r.named.keys()]) === JSON.stringify(want); };
  ok('namedIn: "deleted event on KEY: <text>" names KEY only, not a key quoted in the text', t(`deleted event on ${K}: 2026-01-01 Referred on ${O}: x`, [K]));
  ok('namedIn: "existing event edited: <text> on KEY" names the closing KEY', t(`existing event edited: 2026-01-01 see ${O} on ${K}`, [K]));
  ok('namedIn: schema, new-entry, integrity positions', t(`schema: entry ${K}: /x must be string`, [K]) && t(`new entry ${K}: no evidence quote for mechanism`, [K]) && t(`integrity: relationship node X: no such entry ${K}`, [K]) && t(`integrity: ${K} events[2]: out of order`, [K]));
  ok('namedIn: a key only inside quoted text names nothing', t(`news items deleted or edited: 1 (${K})`, []) && t(`new news item 2026-10-01 About ${K}: needs evidence quoted from one of its own links`, []));
  ok('namedIn: limits are not attributed by name', isLimit('16 entries would change, over the limit of 15 per run') && isLimit('2 new entries, over the limit of 1 per run') && !isLimit(`field title changed on ${K}: Tier A may not change it`));
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

// ---------- commit message after a revert: news and self-correction summaries rebuilt from what is promoted ----------
{
  const P = setup(), g = fakeGit({ add: 0, diff: [1, 1], log: { status: 0, stdout: '2026-10-27\n' }, commit: 0 }), OTHER = 'h-r-9925-frontier-act';
  const corr = (k) => ({ entry_key: k, field: 'mechanism', kind: 'error', problem: `wrong reading on ${k}` });
  const { code, rep } = await run(P, {
    git: g.git,
    // a change no step may make on KEY: the final check puts KEY back
    correctRun: async (o) => { const f = path.join(o.dataDir, 'entries.json'), es = j(f); es.find((x) => x.key === KEY).title += ' (edited)'; fs.writeFileSync(f, JSON.stringify(es, null, 1)); return { ran: true, skipped_why: null, status: 'written', checked: [{ entry_key: KEY }, { entry_key: OTHER }], corrected: [corr(KEY), corr(OTHER)], problems: [], summary: `Self-correction: 2 entries re-checked, 2 fields corrected\n- ${KEY} mechanism (error): x\n- ${OTHER} mechanism (error): y` }; },
    newsRun: async () => ({ skipped_why: null, status: 'written', leads: [], drafted: [{ tracker: KEY, written: true, date: '2026-10-28', title: 'NewsAboutKeyItem', publisher: 'Senate' }, { tracker: OTHER, written: true, date: '2026-10-28', title: 'NewsAboutOtherItem', publisher: 'House' }], summary: 'News: 0 new official events, 0 confirmed, 2 items ready from official records, 2 published; 0 leads\n- 2026-10-28 NewsAboutKeyItem (Senate)\n- 2026-10-28 NewsAboutOtherItem (House)' })
  }, {}, { commit: true });
  const commit = g.calls.find((c) => c.args[0] === 'commit'), m = commit ? commit.input : '';
  ok('revert, news: the commit has no line for the put-back tracker and says "1 published"', code === 0 && !m.includes('NewsAboutKeyItem') && m.includes('NewsAboutOtherItem') && /2 items ready from official records, 1 published/.test(m), `${rep.error} ${m}`);
  ok('revert, self-correction: the commit counts 1 field corrected and has no line for the put-back entry', /Self-correction: 2 entries re-checked, 1 field corrected/.test(m) && m.includes(`- ${OTHER} mechanism`) && !m.includes(`- ${KEY} mechanism`), m);
}
{
  // every news item put back: the news part leaves the commit message
  const P = setup(), g = fakeGit({ add: 0, diff: [1, 1], log: { status: 0, stdout: '2026-10-27\n' }, commit: 0 });
  await run(P, {
    git: g.git,
    correctRun: async (o) => { const f = path.join(o.dataDir, 'entries.json'), es = j(f); es.find((x) => x.key === KEY).title += ' (edited)'; fs.writeFileSync(f, JSON.stringify(es, null, 1)); return { ran: true, skipped_why: null, status: 'quiet', checked: [], corrected: [], problems: [], summary: '' }; },
    newsRun: async () => ({ skipped_why: null, status: 'written', leads: [], drafted: [{ tracker: KEY, written: true, date: '2026-10-28', title: 'NewsAboutKeyItem', publisher: 'Senate' }], summary: 'News: x\n- 2026-10-28 NewsAboutKeyItem (Senate)' })
  }, {}, { commit: true });
  const m = (g.calls.find((c) => c.args[0] === 'commit') || {}).input || '';
  ok('revert, news: all put back, no news part in the commit', !/News:/.test(m) && !m.includes('NewsAboutKeyItem'), m);
}

// ---------- held items not due: not fetched (or read by the AI) again every run; forgotten by the run before they are due ----------
{
  const P = setup(), P9925 = 'congress_gov:119/hr/9925';
  // held since 26 Oct, tried today at 00:00: not due again until 29 Oct
  fs.writeFileSync(path.join(P.stateDir, 'held-items.json'), JSON.stringify({ items: { ['publish:' + P9925]: { item_id: P9925, entry_key: 'h-r-9925-frontier-act', step: 'publish', reason: 'x', first_seen: '2026-10-26T10:00:00Z', last_tried: '2026-10-28T00:00:00Z', tries: 3 } } }));
  fs.writeFileSync(path.join(P.stateDir, 'state.json'), JSON.stringify({ version: 1, sources: { congress_gov: { last_success: '2026-10-28T00:00:00Z', hashes: { '119/hr/9925': 'h1' } } } }));
  let fetched = 0, ai = 0;
  // the grab fetches the item only while its hash is not recorded (as the real grabber does), and records it
  const grab = (o) => {
    const ids = quietGrab(o), sf = path.join(o.stateDir, 'state.json'), st = j(sf);
    const cg = (st.sources.congress_gov = st.sources.congress_gov || {}); cg.hashes = cg.hashes || {};
    if (!('119/hr/9925' in cg.hashes)) fetched++;
    cg.hashes['119/hr/9925'] = 'h1'; fs.writeFileSync(sf, JSON.stringify(st));
    return ids;
  };
  const at = (iso) => runUpdate({ P, config: CONFIG, models: {}, factory, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date(iso), deps: { ...okSteps, grab, runAgents: async () => { ai++; return {}; } }, log: () => {}, logErr: () => {} });
  const hashes = () => j(path.join(P.stateDir, 'state.json')).sources.congress_gov.hashes;
  let quiet = true;
  for (const t of ['04', '08', '12', '16']) { const r = await at(`2026-10-28T${t}:00:00Z`); quiet = quiet && r.code === 0 && '119/hr/9925' in hashes(); }
  ok('held, not due (runs 2-5): its hash is not forgotten, it is not fetched again, no AI call', quiet && fetched === 0 && ai === 0, `${fetched} ${ai} ${JSON.stringify(hashes())}`);
  const r6 = await at('2026-10-28T20:00:00Z');
  ok('held, the run before it is due: its hash is forgotten', r6.code === 0 && !('119/hr/9925' in hashes()) && fetched === 0, `${r6.rep.error} ${JSON.stringify(hashes())}`);
  const r7 = await at('2026-10-29T00:00:00Z');
  ok('held, the due run: it is fetched fresh', r7.code === 0 && fetched === 1, `${fetched} ${r7.rep.error}`);
}

// ---------- expiry: reported once; the same unchanged item is not held again; a changed item is new ----------
{
  const P9925 = 'congress_gov:119/hr/9925', K9925 = 'h-r-9925-frontier-act';
  const rawOf = (text) => JSON.stringify({ bill: { number: '9925', latestAction: { actionDate: '2026-10-01', text } } });
  const grabWith = (raw, fetchedAt) => (o) => {
    const ids = fakeGrab(o), dir = path.join(o.P.workDir, 'runs', RUN);
    fs.mkdirSync(path.join(dir, 'raw', 'congress_gov'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'raw', 'congress_gov', '119-hr-9925.json'), raw);
    const cs = j(path.join(dir, 'changeset.json')); Object.assign(cs.items.find((i) => i.item_id === P9925), { raw_path: 'raw/congress_gov/119-hr-9925.json', raw_hash: sha(raw), fetched_at: fetchedAt }); fs.writeFileSync(path.join(dir, 'changeset.json'), JSON.stringify(cs));
    const df = j(path.join(dir, 'diff.json')); Object.assign(df.items.find((d) => d.item_id === P9925), { verdict: 'material', reasons: [{ kind: 'new_action', detail: `2026-10-01: ${HEARING}`, api_value: HEARING }] }); fs.writeFileSync(path.join(dir, 'diff.json'), JSON.stringify(df));
    return ids;
  };
  const guarded = (o) => { const r = publishRun({ ...o, dry: true }); return r.result.touched.includes(K9925) ? { ...r, status: 'stopped', check: { problems: [`field title changed on ${K9925}: Tier A may not change it`] } } : publishRun(o); };
  const P = setup();
  const at = (iso, raw) => runUpdate({ P, config: CONFIG, models: {}, factory, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date(iso), deps: { ...okSteps, publishRun: guarded, grab: grabWith(raw, new Date(Date.parse(iso) - 60e3).toISOString()) }, log: () => {}, logErr: () => {} });
  const RAW1 = rawOf(HEARING), RAW2 = rawOf(HEARING + ' Again.');
  const replay = { run_id: 'run-old', item: { item_id: P9925, source: 'congress_gov', source_id: '119/hr/9925', entry_key: K9925, change: 'changed', raw_path: 'raw/congress_gov/x.json', raw_hash: sha(RAW1), fetched_at: '2026-11-08T10:00:00Z' }, diff: null, raw: RAW1, result: null };
  fs.writeFileSync(path.join(P.stateDir, 'held-items.json'), JSON.stringify({ items: { ['publish:' + P9925]: { item_id: P9925, entry_key: K9925, step: 'publish', reason: 'x', first_seen: '2026-10-26T10:00:00Z', last_tried: '2026-11-08T10:00:00Z', tries: 13, replay } } }));
  const hf = () => j(path.join(P.stateDir, 'held-items.json'));
  const r1 = await at('2026-11-09T12:00:00Z', RAW1);
  const n1 = r1.rep.notes.filter((n) => n.includes(P9925) && /expired/.test(n));
  ok('expiry: reported once with what happens next, and an expiry marker kept (item id, raw hash, date)', r1.code === 0 && n1.length === 1 && /needs attention/.test(n1[0]) && /left out of every run without being held or reported again; if the record changes it is treated as a new item/.test(n1[0]) && !hf().items['publish:' + P9925] && hf().expired && hf().expired[P9925].raw_hash === sha(RAW1) && hf().expired[P9925].date === '2026-11-09', `${r1.rep.error} ${JSON.stringify(n1)} ${JSON.stringify(hf(), (k, v) => (k === 'replay' ? '-' : v))}`);
  const r2 = await at('2026-11-09T16:00:00Z', RAW1);
  ok('expiry: the same unchanged item refused again is not held again or reported again', r2.code === 0 && !Object.keys(hf().items).length && hf().expired[P9925] && !r2.rep.notes.some((n) => n.includes(P9925)) && !(r2.rep.held || []).some((x) => x.item_id === P9925), `${r2.rep.error} ${JSON.stringify(r2.rep.notes)} ${JSON.stringify(hf(), (k, v) => (k === 'replay' ? '-' : v))}`);
  ok('expiry: and it is left out, not published', !j(path.join(P.dataDir, 'entries.json')).find((x) => x.key === K9925).events.some((v) => v.date === '2026-10-01' && /Hearings held/.test(v.text)));
  const r3 = await at('2026-11-10T12:00:00Z', RAW2);
  const h3 = hf(), h3i = h3.items['publish:' + P9925];
  ok('expiry: the item changed (new hash) is a new item: held afresh (1 try, first seen now), marker gone', r3.code === 0 && h3i && h3i.tries === 1 && h3i.first_seen === '2026-11-10T12:00:00Z' && !(h3.expired && h3.expired[P9925]), `${r3.rep.error} ${JSON.stringify(h3, (k, v) => (k === 'replay' ? '-' : v))}`);
}

{
  // Round 3 (relationships audit item 1, blocker): with relationships ON (the gate passing), one record-proved sponsor edge goes through
  // the REAL links step and the final check of the whole run and is promoted: the final check is given the records, created entries and
  // actor ids the links step proved it against (before, it got only the edges and nodes and refused every record-proved edge).
  const P = setup(), rel = path.join(P.dataDir, 'relationships.json');
  for (const d of [P.dataDir, P.docsDir]) {
    const ef = path.join(d, 'entries.json'), E = j(ef), list = Array.isArray(E) ? E : E.entries;
    list.find((e) => e.key === KEY).origin = 'automated';
    fs.writeFileSync(ef, JSON.stringify(E, null, 1));
    const rf = path.join(d, 'relationships.json'), R = j(rf); R.edges = R.edges.filter((e) => !(e.from === 'act-hawley' && e.to === 'S2938')); fs.writeFileSync(rf, JSON.stringify(R, null, 1));
  }
  const edgesBefore = j(rel).edges.length;
  const models = { provider: 'anthropic', anthropic: { roles: { generator: { model: 'g' }, validator: { model: 'v' }, referee: { model: 'r' } } } };
  const { readGateInputs } = await import('./eval/gate.mjs');
  const real = readGateInputs();
  const linksRep = { measure: 'links', run_at: '2026-10-28T00:00:00Z', checks_hash: real.hashes.relationships, cases: 4, wrong: 0, errors: 0, applied_wrong: 0, backtest: { proposals: 1, as_new_proposals: 1 }, suite_passed: 2, suite_failed: 0, suite_note: null };
  let linkOut = null;
  const { code, rep } = await runUpdate({ P, config: { ...CONFIG, auto_publish: { mechanism: false, new_entries: false, relationships: true, news: false }, eval_bar: { pass_rate: 1, unsupported_fields: 0, scope_agreement: 1 } }, models, factory, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date('2026-10-28T12:00:00Z'),
    deps: { ...okSteps, gateInputs: { reports: [], goldItems: 1, measures: [linksRep], hashes: real.hashes, expected: real.expected }, linkRun: async (o) => (linkOut = await (await import('./links/run.mjs')).linkRun(o)) }, log: () => {}, logErr: () => {} });
  const after = j(rel);
  ok('links e2e: relationships ON, one record-proved sponsor edge is added by the real links step and promoted past the final check', code === 0 && linkOut && linkOut.status === 'written' && linkOut.applied.length === 1 && after.edges.length === edgesBefore + 1 && after.edges.some((e) => e.from === 'act-hawley' && e.to === 'S2938' && e.col === 'record') && !rep.held.some((x) => /links/.test(x.reason || '')), `${code} ${rep.error} ${linkOut && linkOut.status} ${JSON.stringify(linkOut && linkOut.problems)} ${JSON.stringify(rep.held)} ${JSON.stringify(rep.final_check)}`);
}
{
  // A partial links revert: a new entry is refused at the final check and put back with its own sponsor edge; the other record-proved
  // edge survives, so the links summary stays in the commit message (before, 'links' was dropped on every partial revert).
  const P = setup(), rel = path.join(P.dataDir, 'relationships.json'), NEW = 'zz-new-test-entry', NITEM = 'congress_gov:119/hr/1';
  for (const d of [P.dataDir, P.docsDir]) {
    const ef = path.join(d, 'entries.json'), E = j(ef), list = Array.isArray(E) ? E : E.entries;
    list.find((e) => e.key === KEY).origin = 'automated';
    fs.writeFileSync(ef, JSON.stringify(E, null, 1));
    const rf = path.join(d, 'relationships.json'), R = j(rf); R.edges = R.edges.filter((e) => !(e.from === 'act-hawley' && e.to === 'S2938')); fs.writeFileSync(rf, JSON.stringify(R, null, 1));
  }
  const tierB = (o) => {
    const r = publishRun(o);
    if (!/run-20261006/.test(o.runDir)) return r;
    const f = path.join(o.dataDir, 'entries.json'), es = j(f), e = JSON.parse(JSON.stringify(es.find((x) => x.key === KEY)));
    Object.assign(e, { key: NEW, id: 990001, jurisdiction: 'Federal', state: null }); es.push(e); fs.writeFileSync(f, JSON.stringify(es, null, 1));
    r.result.added = [{ entry_key: NEW, item_id: NITEM, section: 'J' }];
    return r;
  };
  const edgesBefore = j(rel).edges.length, g = fakeGit({ add: 0, diff: [1, 1], log: { status: 0, stdout: '2026-10-27\n' }, commit: 0 });
  const models = { provider: 'anthropic', anthropic: { roles: { generator: { model: 'g' }, validator: { model: 'v' }, referee: { model: 'r' } } } };
  const { readGateInputs } = await import('./eval/gate.mjs');
  const real = readGateInputs();
  const linksRep = { measure: 'links', run_at: '2026-10-28T00:00:00Z', checks_hash: real.hashes.relationships, cases: 4, wrong: 0, errors: 0, applied_wrong: 0, backtest: { proposals: 1, as_new_proposals: 1 }, suite_passed: 2, suite_failed: 0, suite_note: null };
  const linkRun = async (o) => {
    const l = await (await import('./links/run.mjs')).linkRun(o);
    if (l.status !== 'written' || l.applied.length !== 1) return l;
    // a second record-proved edge, on the new entry (same sponsor, same record): it goes when the entry is put back
    const e = j(path.join(o.dataDir, 'relationships.json')).edges.slice(-1)[0], node = { name: 'New', column: 0, kind: 'entry', entry_key: NEW };
    const gone = { ...e, to: 'NEWN', src: 'NEWN' };
    const f = path.join(o.dataDir, 'relationships.json'), r = j(f); r.nodes.NEWN = node; r.edges.push(gone); fs.writeFileSync(f, JSON.stringify(r, null, 1));
    const out = { ...l, applied: [...l.applied, gone], added: { edges: [...(l.added ? l.added.edges : [e]), gone], nodes: { ...(l.added ? l.added.nodes : {}), NEWN: node } }, proposed: [...l.proposed, { ...l.proposed[0], names: [l.proposed[0].names[0], 'New'] }] };
    Object.defineProperty(out, 'proof', { value: { ...l.proof, records: { ...l.proof.records, [NEW]: l.proof.records[KEY] }, created: [...(l.proof.created || []), NEW] }, enumerable: false });
    return out;
  };
  const { code, rep } = await runUpdate({ P, config: { ...CONFIG, max_new_entries_per_run: 0, auto_publish: { mechanism: false, new_entries: false, relationships: true, news: false }, eval_bar: { pass_rate: 1, unsupported_fields: 0, scope_agreement: 1 } }, models, factory, flags: { source: 'all', commit: true }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date('2026-10-28T12:00:00Z'),
    deps: { ...okSteps, git: g.git, publishRun: tierB, gateInputs: { reports: [], goldItems: 1, measures: [linksRep], hashes: real.hashes, expected: real.expected }, linkRun }, log: () => {}, logErr: () => {} });
  const after = j(rel), commit = g.calls.find((c) => c.args[0] === 'commit');
  ok('links partial revert: the new entry and its edge are put back, the other edge promoted', code === 0 && !after.nodes.NEWN && after.edges.length === edgesBefore + 1 && after.edges.some((e) => e.from === 'act-hawley' && e.to === 'S2938'), `${code} ${rep.error} ${after.edges.length - edgesBefore} ${JSON.stringify(rep.held)} ${rep.links.status} ${JSON.stringify(rep.links.applied)} ${JSON.stringify(rep.links.problems)} ${JSON.stringify(rep.gate)}`);
  ok('links partial revert: the commit message keeps the links summary of the surviving edge', commit && /Links: .*1 added to the network/.test(commit.input), commit && commit.input);
}
// the links measure is run on each run's own data for the gate (gateInputsFor), so relationships never wait on a report made by hand
{
  const P = setup();
  const fresh = { measure: 'links', run_at: '2026-11-01T00:00:00Z', checks_hash: 'now', cases: 250, wrong: 0 };
  let seen = null;
  const g = gateInputsFor({ P, config: { auto_publish: { relationships: true } }, deps: { linksMeasure: (o) => { seen = o; return fresh; }, runLinksSuite: () => ({ passed: 202, failed: 0 }) } });
  ok('relationships on: the links measure runs on the run\'s own data and replaces any older links report', g.links === fresh && seen && Array.isArray(seen.entries) && seen.entries.length > 0 && seen.relationships && seen.suite.passed === 202 && g.inputs.measures.filter((r) => r.measure === 'links').length === 1 && g.inputs.measures.includes(fresh));
  const bad = gateInputsFor({ P, config: { auto_publish: { relationships: true } }, deps: { linksMeasure: () => { throw new Error('boom'); }, runLinksSuite: () => null } });
  ok('a links measure that cannot run leaves no links report (relationships off this run) and says why', !bad.links && /boom/.test(bad.linksError) && !bad.inputs.measures.some((r) => r.measure === 'links'));
  let ran = false;
  const off = gateInputsFor({ P, config: { auto_publish: { relationships: false } }, deps: { linksMeasure: () => { ran = true; return fresh; } } });
  ok('relationships off: no measure is run', !ran && !off.links);
  ok('test inputs (deps.gateInputs) are used as given', gateInputsFor({ P, config: { auto_publish: { relationships: true } }, deps: { gateInputs: { reports: [], x: 1 } } }).inputs.x === 1);
}
console.log(`update: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
