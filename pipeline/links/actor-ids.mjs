// Run:  node links/actor-ids.mjs [--runs <pipeline/data/runs>] [--data <web/data/v2>] [--write]
// Builds config/actor-ids.json: the official id of each legislator node in the network (Congress.gov bioguideId, LegiScan
// people_id), read from the raw official records in pipeline/data/runs. A node gets an id only when the match is unambiguous: the
// same full first and last name, chamber and state (and party, where the node states one), exactly one id matching the node, and
// that id matching no other node. Every legislator node left without an id is listed, with why.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { legislatorOf } from './rules.mjs';
import { recordPeople, ACTOR_IDS_FILE } from './records.mjs';
import { loadData } from '../publish/run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// people: [{ id, kind, v, chamber, first, last, party, state, federal }]; nodes: relationships.nodes.
export function matchActorIds(nodes, people) {
  const leg = Object.entries(nodes).filter(([, n]) => n.kind === 'actor').map(([k, n]) => ({ k, ...(legislatorOf(n.name) || {}), name: n.name })).filter((a) => a.chamber);
  const fits = (a, p) => a.federal === p.federal && a.chamber === p.chamber && same(a.first, p.first) && same(a.last, p.last) && a.state === p.state && (!a.party || same(a.party, p.party));
  const byNode = {}, byId = {};
  for (const a of leg) for (const p of people) if (fits(a, p)) { (byNode[a.k] = byNode[a.k] || new Map()).set(p.id, p); (byId[p.id] = byId[p.id] || new Set()).add(a.k); }
  const ids = {}, unmatched = [];
  for (const a of leg) {
    const m = byNode[a.k];
    if (!m || !m.size) { unmatched.push({ node: a.k, name: a.name, why: 'no official record names this legislator (full name, chamber and state)' }); continue; }
    if (m.size > 1) { unmatched.push({ node: a.k, name: a.name, why: `ambiguous: ${[...m.keys()].join(', ')}` }); continue; }
    const [p] = m.values();
    if (byId[p.id].size > 1) { unmatched.push({ node: a.k, name: a.name, why: `${p.id} also matches ${[...byId[p.id]].filter((x) => x !== a.k).join(', ')}` }); continue; }
    ids[a.k] = { [p.kind]: p.kind === 'legiscan' ? Number(p.v) : String(p.v) };
  }
  return { ids, unmatched, legislators: leg.length };
}

export function peopleInRuns(runsDir) {
  const out = []; let runs = []; try { runs = fs.readdirSync(runsDir); } catch { return out; }
  for (const run of runs) for (const src of ['congress_gov', 'legiscan']) {
    const dir = path.join(runsDir, run, 'raw', src); let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) { try { out.push(...recordPeople(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))); } catch { /* skipped */ } }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const runsDir = arg('--runs', path.join(here, '..', 'data', 'runs')), dataDir = arg('--data', path.join(here, '..', '..', 'web', 'data', 'v2'));
  const people = peopleInRuns(runsDir), r = matchActorIds(loadData(dataDir).relationships.nodes, people);
  console.log(`${people.length} people read from records in ${runsDir}; ${Object.keys(r.ids).length} of ${r.legislators} legislator nodes matched`);
  Object.entries(r.ids).forEach(([k, v]) => console.log(`  ${k}: ${JSON.stringify(v)}`));
  r.unmatched.forEach((u) => console.log(`  UNMATCHED ${u.node} (${u.name}): ${u.why}`));
  if (args.includes('--write')) {
    const out = { _comment: 'Official ids of legislator nodes (relationships.json), built by links/actor-ids.mjs from the raw official records in pipeline/data/runs: only unambiguous matches (full name, chamber, state, and party where the node states one). A sponsor link is applied automatically only when an entry\'s official record names one of these ids as its primary sponsor.', ids: r.ids, unmatched: r.unmatched };
    fs.writeFileSync(ACTOR_IDS_FILE, JSON.stringify(out, null, 2) + '\n');
    console.log('written ' + ACTOR_IDS_FILE);
  }
}
