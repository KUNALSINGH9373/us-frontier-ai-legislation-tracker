// The new-bills path through the whole update chain (update.mjs), as a 4-hourly run would take it: grab -> compare -> AI step
// (runAgents -> processItem -> agents/newbill.mjs) -> gate -> publish (Tier B) -> final guards -> promote to web and docs. Only the
// network grab and the two model answers are scripted; compare, the AI step's code, the gate, the publisher, the guards and the promote
// are the real ones. The bill is invented. No network, no AI.
//   node test-newbill-e2e.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { runUpdate } from './update.mjs';
import { writeChangeset, sha } from './grabber/lib/run-common.mjs';
import { currentHashes } from './eval/hash.mjs';
import { reviewTargets } from './agents/newbill-checks.mjs';
import { ROW_KEYS } from './agents/newbill-prompts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), FX = path.join(here, 'fixtures', 'publish');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail === undefined ? '' : detail); } };
const j = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ---------- a sandbox repository (as test-update.mjs) ----------
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newbill-e2e-')), pipelineDir = path.join(root, 'pipeline');
  const P = { pipelineDir, root, dataDir: path.join(root, 'web', 'data', 'v2'), docsDir: path.join(root, 'docs', 'data', 'v2'), idsFile: path.join(pipelineDir, 'config', 'identifiers.json'), lsIdsFile: path.join(pipelineDir, 'config', 'identifiers-legiscan.json'), stateDir: path.join(pipelineDir, 'state'), workDir: path.join(pipelineDir, 'data') };
  for (const d of [P.dataDir, P.docsDir]) fs.cpSync(path.join(FX, 'data-2026-10-08'), d, { recursive: true });
  fs.mkdirSync(path.dirname(P.idsFile), { recursive: true });
  fs.copyFileSync(path.join(here, 'config', 'identifiers.json'), P.idsFile);
  fs.copyFileSync(path.join(here, 'config', 'identifiers-legiscan.json'), P.lsIdsFile);
  fs.mkdirSync(P.stateDir, { recursive: true });
  fs.writeFileSync(path.join(P.stateDir, 'state.json'), JSON.stringify({ version: 1, sources: {} }, null, 1) + '\n');
  fs.writeFileSync(path.join(P.stateDir, 'corrections.json'), '{"last_run":null,"items":{}}\n');
  fs.writeFileSync(path.join(P.stateDir, 'legiscan-usage.json'), '{"month":"2026-11","used":100,"runs":1}\n');
  return P;
}

// ---------- an invented new federal bill, as Congress.gov would give it ----------
const TEXT = [
  'A BILL To require developers of frontier artificial intelligence models to publish safety plans.',
  'SECTION 1. SHORT TITLE. This Act may be cited as the "Frontier Model Accountability Act".',
  'SEC. 2. DEFINITIONS. In this Act: (1) COVERED MODEL.--The term "covered model" means an artificial intelligence model trained using a quantity of computing power greater than 10^26 integer or floating-point operations. (2) DEVELOPER.--The term "developer" means a person that trains a covered model.',
  'SEC. 3. SAFETY PLANS. Before deploying a covered model, a developer shall publish a safety plan describing how the developer assesses and mitigates risks of critical harm.',
  'SEC. 4. ENFORCEMENT. The Attorney General may bring a civil action against a developer that violates section 3 for a civil penalty of not more than $500,000 for each violation.'
].join('\n');
const ID = '119/hr/99901', ITEM_ID = `congress_gov:${ID}`, RUN = 'run-20261101-1200-e2e1';
const raw = { bill: { congress: 119, type: 'HR', number: '99901', title: 'Frontier Model Accountability Act', introducedDate: '2026-10-30', originChamber: 'House', sponsors: [{ fullName: 'Rep. Alex Rivera [D-OK-1]', firstName: 'Alex', lastName: 'Rivera', party: 'D', state: 'OK', bioguideId: 'R000901' }], cosponsors: { count: 0 }, latestAction: { actionDate: '2026-10-30', text: 'Referred to the Committee on Energy and Commerce.' }, actions: [{ actionDate: '2026-10-30', text: 'Introduced in House' }] }, text: TEXT };

function grab({ P, stateDir }) {
  const runs = path.join(P.workDir, 'runs'), dir = path.join(runs, RUN), rawText = JSON.stringify(raw);
  const item = { item_id: ITEM_ID, source: 'congress_gov', source_id: ID, source_url: 'https://www.congress.gov/bill/119th-congress/house-bill/99901', entry_key: null, change: 'new', reason: 'discovery', title: raw.bill.title, raw_path: 'raw/congress_gov/119-hr-99901.json', raw_hash: sha(rawText), fetched_at: '2026-11-01T11:59:00Z' };
  writeChangeset({ outDir: runs, runId: RUN, items: [item] });
  fs.mkdirSync(path.join(dir, 'raw', 'congress_gov'), { recursive: true });
  fs.writeFileSync(path.join(dir, item.raw_path), rawText);
  fs.writeFileSync(path.join(dir, 'grab-stats.json'), JSON.stringify({ source: 'congress_gov', run_id: RUN, items: 1, stats: { candidates: 1 }, checked_keys: [] }));
  const ids = [RUN];
  for (const [src, n] of [['federal_register', 'e2e2'], ['legiscan', 'e2e3']]) { const id = `run-20261101-1200-${n}`; writeChangeset({ outDir: runs, runId: id, items: [] }); fs.writeFileSync(path.join(runs, id, 'grab-stats.json'), JSON.stringify({ source: src, run_id: id, items: 0, stats: {}, checked_keys: [] })); ids.push(id); }
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ version: 1, sources: { congress_gov: { last_success: '2026-11-01T12:00:00Z', cursor: '2026-11-01T11:58:00Z', hashes: {} } } }, null, 1) + '\n');
  fs.writeFileSync(path.join(stateDir, 'waiting-for-text.json'), '{"items":{}}\n');
  return ids;
}

// ---------- the writer's and reviewer's answers (scripted) ----------
const Q = { cov: '(1) COVERED MODEL.--The term "covered model" means an artificial intelligence model trained using a quantity of computing power greater than 10^26 integer or floating-point operations.', duty: 'Before deploying a covered model, a developer shall publish a safety plan describing how the developer assesses and mitigates risks of critical harm.', pen: 'The Attorney General may bring a civil action against a developer that violates section 3 for a civil penalty of not more than $500,000 for each violation.' };
const rows = Object.fromEntries(ROW_KEYS.map((k) => [k, { value: 'not_in_bill', items: [], quote: '', sec: '', summary: '' }]));
rows.framework = { value: 'yes', items: ['u1'], quote: Q.duty, sec: 'Sec. 3', summary: 'A developer must publish a safety plan before deploying a covered model.' };
rows.compute_threshold = { value: 'yes', items: ['c1'], quote: Q.cov, sec: 'Sec. 2(1)', summary: 'Models trained using greater than 10^26 operations.' };
rows.penalties = { value: 'yes', items: ['p1'], quote: Q.pen, sec: 'Sec. 4', summary: 'Civil penalty of not more than $500,000 for each violation, sought by the Attorney General.' };
const answer = {
  inventory: [{ sec: 'Sec. 3', provision_type: 'duty', party: 'developer' }], readable: true, text_problems: [],
  in_scope: true, scope_reason: 'Sec. 2(1) limits the bill to models trained using greater than 10^26 operations and Sec. 3 puts a safety-plan duty on their developers (type 1).', tracker_section: 'D',
  name_quote: 'This Act may be cited as the "Frontier Model Accountability Act".', name: 'Frontier Model Accountability Act',
  coverage: [{ id: 'c1', lead_in: '', quote: Q.cov, sec: 'Sec. 2(1)', party: 'developer', conditions: ['greater than 10^26'], headline: true, text: 'Covers developers of models trained using greater than 10^26 integer or floating-point operations.' }],
  definitions: [], exclusions: [],
  duties: [{ id: 'u1', lead_in: '', quote: Q.duty, sec: 'Sec. 3', party: 'developer', force: 'duty', kind: 'framework', conditions: ['before deploying a covered model'], deadline: '', text: 'Before deploying a covered model, a developer must publish a safety plan describing how it assesses and mitigates risks of critical harm.' }],
  penalties: [{ id: 'p1', lead_in: '', quote: Q.pen, sec: 'Sec. 4', applies_to: 'developer', trigger: 'violating section 3', amount: 'not more than $500,000', unit: 'for each violation', enforcer: 'the Attorney General', conditions: [], text: 'The Attorney General may bring a civil action for a civil penalty of not more than $500,000 for each violation of section 3.' }],
  effective: [], other_provisions: [], rows,
  box: { main_party: 'developer', applies_to: { based_on: ['c1'], text: 'developers of models trained using greater than 10^26 operations' }, requires_lead: 'Requires them to', requires: { based_on: ['u1'], text: 'publish a safety plan before deploying a covered model' }, enforcement: { based_on: ['p1'], text: 'the Attorney General, by civil action; civil penalty of not more than $500,000 for each violation' }, effective: { based_on: [], text: 'Not stated in the bill' } }
};
const calls = { writer: 0, reviewer: 0, trap: 0 };
const writer = { model: 'w', async generate() { calls.writer++; return { data: JSON.parse(JSON.stringify(answer)), usage: {} }; } };
const reviewer = { model: 'r', async generate() { calls.reviewer++; return { data: { reviewer_map: [], checked: reviewTargets(answer), findings: [] }, usage: {} }; } };
const trap = { model: 't', async generate() { calls.trap++; throw new Error('the older loop must not run'); } };
const judge = { model: 'j', async generate() { calls.judge = (calls.judge || 0) + 1; return { data: { considered: [], in_scope: true, sec: 'Sec. 2(1)', quote: Q.cov, reason: 'limited to models trained using greater than 10^26 operations' }, usage: {} }; } };
const factory = { hasKey: true, keyName: 'ANTHROPIC_API_KEY', ledger: { itemTokens: () => 0, totals: () => ({}) }, monthStatus: () => ({ over: false, spent: 0, cap: 50 }), spend: { between: () => [] },
  make: (role) => (role === 'writer' ? writer : role === 'bill_reviewer' ? reviewer : role === 'scope_judge' ? judge : trap) };

// ---------- the gate's inputs: passing reports made by the current code and the production writer and reviewer ----------
const models = { provider: 'anthropic', anthropic: { roles: { generator: { model: 'g' }, validator: { model: 'v' }, referee: { model: 'f' }, writer: { model: 'w' }, bill_reviewer: { model: 'r' } } } };
const H = currentHashes(), pin = { items: 26, gold_sha256: 'G', references_sha256: 'R' };
const nb = (set) => ({ measure: 'new_bills', method: 'simple', set, run_at: '2026-11-01T00:00:00Z', writer: 'w', reviewer: 'r', checks_hash: H.new_entries, partial: false, set_size: set === 'test' ? 48 : 26, gold_sha256: set === 'unseen' ? 'G' : 'x', references_sha256: set === 'unseen' ? 'R' : null, summary: { items: set === 'test' ? 48 : 26, published: 10, wrong: 0, scope_errors: 0, errors: 0, no_text: 0, misleading: 5 } });
const gateInputs = (on) => ({ reports: [], goldItems: 48, hashes: H, expected: { tierb: 1, news: 1, news_writer: 1, links: null, unseen: pin }, measures: on ? [{ measure: 'tierb', run_at: '2026-11-01T00:00:00Z', checks_hash: H.new_entries, cases: 1, wrong: 0 }, nb('test'), nb('unseen')] : [] });

const CONFIG = { max_entries_changed_per_run: 15, max_new_entries_per_run: 1, news_from_official_actions: true, copy_to_docs: true, courts: { enabled: false }, ai_step: { enabled: true, max_items_per_run: 5 }, auto_publish: { new_entries: true } };
const steps = {
  grab,
  courtsRun: async () => ({ status: 'quiet', requests: 0, errors: [], read: [], result: { touched: [], data: null }, summary: '' }),
  correctRun: async (o) => { fs.writeFileSync(o.stateFile, '{"last_run":"2026-11-01","items":{}}\n'); return { ran: true, skipped_why: null, status: 'quiet', checked: [], corrected: [], problems: [], summary: '' }; },
  linkRun: async () => ({ status: 'nothing', proposed: [], applied: [], companions: [], dropped: [], problems: [], summary: '' }),
  newsRun: async (o) => { fs.writeFileSync(o.seenFile, '{"items":{}}\n'); return { skipped_why: null, status: 'quiet', leads: [], drafted: [], summary: '' }; },
  parity: () => {}
};
const run = (P, on) => runUpdate({ P, config: CONFIG, models, factory, flags: { source: 'all' }, env: { COURTLISTENER_API_TOKEN: 'token-for-tests-123' }, now: () => new Date('2026-11-01T12:00:00Z'), deps: { ...steps, gateInputs: gateInputs(on) }, log: () => {}, logErr: () => {} });

{
  const P = setup(), before = j(path.join(P.dataDir, 'entries.json')).length;
  const { code, rep } = await run(P, true);
  const after = j(path.join(P.dataDir, 'entries.json')), e = after.find((x) => x.plain && x.short_name === 'Frontier Model Accountability Act');
  ok('the run succeeds', code === 0, `${code} ${rep && rep.error}`);
  ok('the new path ran: one writer answer, one scope check, one review; the older loop untouched', calls.writer === 1 && calls.judge === 1 && calls.reviewer === 1 && calls.trap === 0, JSON.stringify(calls));
  ok('the new bill is promoted to the site data, with its plain page', after.length === before + 1 && !!e && e.plain.items.duties[0].quote === Q.duty && e.section === 'D', e ? '' : `entries ${before} -> ${after.length}`);
  ok('official facts come from the record (number, sponsor, session); the name from the bill', !!e && /99901/.test(e.title) && /Rivera/.test(e.sponsor_text) && e.identifiers.session === '119th Congress' && e.origin === 'automated');
  ok('web and docs carry the same bytes', fs.readFileSync(path.join(P.dataDir, 'entries.json')).equals(fs.readFileSync(path.join(P.docsDir, 'entries.json'))));
  ok('the final guards and the run report agree it was published', rep && !rep.error && JSON.stringify(rep).includes('Frontier Model Accountability Act'));
}
{
  // the same run with no passing new-bills reports: the gate keeps new entries off, so the reviewer is not asked and nothing is created
  calls.writer = 0; calls.reviewer = 0; const judgedBefore = calls.judge;
  const P = setup(), before = fs.readFileSync(path.join(P.dataDir, 'entries.json'));
  const { code, rep } = await run(P, false);
  ok('without passing reports the gate turns new entries off for the run', code === 0 && rep.gate && rep.gate.off.some((x) => x.field === 'new_entries'), JSON.stringify(rep && rep.gate && rep.gate.off));
  ok('and only the writer runs: its draft is a reported proposal, no scope check or reviewer (Opus) spend, nothing published', calls.writer === 1 && calls.reviewer === 0 && calls.judge === judgedBefore && fs.readFileSync(path.join(P.dataDir, 'entries.json')).equals(before) && rep.notes.some((n) => /proposal/.test(n) && /99901|Frontier Model Accountability Act/.test(n)), JSON.stringify(calls));
}

console.log(`newbill e2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
