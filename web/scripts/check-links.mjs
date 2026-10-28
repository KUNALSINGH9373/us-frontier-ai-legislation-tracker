// Checks that the link map can draw every link: the site data plus the links the pipeline proposes, applied as the pipeline
// would (pipeline/links/apply.mjs), then built with the UI's own model (tracker-lib.js buildV2).
//   node web/scripts/check-links.mjs [v2 folder] [--proposals <file>]
// Without --proposals, the code proposer is run for every entry. With it, the file holds { proposals, nodes } (links/propose.mjs).
// Every link end must be a node the map draws (an actor, or an entry node tied to a real entry), with a column the map has; no
// two nodes may stand for the same entry; no link may be listed twice. Problems are printed; the exit code is 1 if any are found.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), at = args.indexOf('--proposals');
const v2dir = path.resolve(args.find((a, i) => !a.startsWith('--') && i !== at + 1) || path.join(web, 'data', 'v2'));
const read = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const pipe = (f) => import(pathToFileURL(path.join(web, '..', 'pipeline', ...f.split('/'))).href);

// data: { entries, relationships, news, site }. Returns readable problems; empty means the map can draw every link.
export async function checkLinks(data) {
  const { buildV2 } = await import(pathToFileURL(path.join(web, 'tracker-lib.js')).href + '?links');
  const D = buildV2(data.entries, data.news, data.relationships, data.site);
  const R = D.rel, problems = [], rel = data.relationships;
  const drawn = (k) => (R.actors[k] != null || D.keyToId[k] != null) && R.columnOf[k] != null && R.columnOf[k] < R.columns.length;
  D.edges.forEach((e, i) => ['from', 'to'].forEach((s) => { if (!drawn(e[s])) problems.push(`link #${i} ${e.from} -> ${e.to}: the ${s} end "${e[s]}" is not a node the map draws`); }));
  D.edges.forEach((e, i) => { if ((e.from !== e.to) && R.actors[e.from] == null && R.actors[e.to] == null && (e.fromId == null || e.toId == null)) problems.push(`link #${i} ${e.from} -> ${e.to}: not tied to an entry on both ends`); });
  const owner = {};
  Object.entries(rel.nodes).filter(([, n]) => n.kind === 'entry').forEach(([k, n]) => { if (owner[n.entry_key]) problems.push(`nodes ${owner[n.entry_key]} and ${k} both stand for ${n.entry_key}`); owner[n.entry_key] = k; });
  const names = {}; Object.entries(rel.nodes).forEach(([k, n]) => { if (names[n.name]) problems.push(`nodes ${names[n.name]} and ${k} have the same name "${n.name}"`); names[n.name] = k; });
  const seen = new Set();
  rel.edges.forEach((e, i) => { const k = [e.from, e.to, e.type, e.label].join('|'); if (seen.has(k)) problems.push(`link #${i} ${e.from} -> ${e.to} is listed twice`); seen.add(k); });
  return { problems, edges: D.edges.length, nodes: Object.keys(rel.nodes).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = { entries: read(v2dir, 'entries.json'), relationships: read(v2dir, 'relationships.json'), news: read(v2dir, 'news.json'), site: read(v2dir, 'site.json') };
  const { proposeByCode } = await pipe('links/propose.mjs'), { applyLinks } = await pipe('links/apply.mjs');
  const p = at >= 0 ? JSON.parse(fs.readFileSync(args[at + 1], 'utf8')) : proposeByCode({ entries: data.entries, relationships: data.relationships, changed: data.entries.map((e) => e.key) });
  const a = applyLinks({ data, proposals: p.proposals || [], nodes: p.nodes || {} });
  const before = await checkLinks(data), after = await checkLinks({ ...data, relationships: a.relationships });
  const problems = [...before.problems.map((x) => 'site data: ' + x), ...a.problems.map((x) => 'apply: ' + x), ...after.problems.map((x) => 'with proposals: ' + x)];
  problems.forEach((x) => console.log('PROBLEM  ' + x));
  console.log(`link map: ${before.edges} links on ${before.nodes} nodes; with ${a.added.edges.length} proposed link(s) and ${Object.keys(a.added.nodes).length} new node(s): ${after.edges} links on ${after.nodes} nodes; ${problems.length ? problems.length + ' problem(s)' : 'every link end is drawn'}`);
  process.exit(problems.length ? 1 : 0);
}
