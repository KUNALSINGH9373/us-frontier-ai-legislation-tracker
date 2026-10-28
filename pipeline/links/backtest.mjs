// Run:  node links/backtest.mjs [--data <dir>] [--verbose]
// How well the code proposer finds the links the tracker already has. For every entry that has links in the network, all its
// links are removed and the proposer is run on that entry alone; a proposal that matches a removed link (same pair, same type,
// either direction) is recovered, any other proposal is a false link. Prints precision and recall on the real data, and exits 1
// on any false link (the code proposer's bar is zero).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { proposeByCode, pairKey } from './propose.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

// Returns { runs, edges, recovered: Set of edge keys, falseLinks: [...], proposals, byType }.
// asNew: also remove the entry's node, as for a bill the network has never seen (the proposer then places a new node, which is
// mapped back to the old key for scoring).
export function backtest({ entries, relationships: rel, sample = null, asNew = false }) {
  const nodeOf = {}; Object.entries(rel.nodes).forEach(([k, n]) => { if (n.kind === 'entry') nodeOf[n.entry_key] = k; });
  const keys = (sample || entries.map((e) => e.key)).filter((k) => nodeOf[k] && rel.edges.some((e) => e.from === nodeOf[k] || e.to === nodeOf[k]));
  const all = new Set(rel.edges.map((e) => pairKey(e.from, e.to, e.type)));
  const recovered = new Set(), falseLinks = [], byType = {};
  let proposals = 0;
  for (const key of keys) {
    const n = nodeOf[key], stripped = { ...rel, nodes: { ...rel.nodes }, edges: rel.edges.filter((e) => e.from !== n && e.to !== n) };
    if (asNew) delete stripped.nodes[n];
    const r = proposeByCode({ entries, relationships: stripped, changed: [key] });
    const back = (k) => (r.nodes[k] && r.nodes[k].entry_key === key ? n : k);
    for (const p0 of r.proposals) {
      const p = { ...p0, from: back(p0.from), to: back(p0.to) };
      proposals++;
      const k = pairKey(p.from, p.to, p.type), t = (byType[p.type] = byType[p.type] || { proposed: 0, right: 0 });
      t.proposed++;
      if (all.has(k)) { recovered.add(k); t.right++; } else falseLinks.push({ entry: key, ...p });
    }
  }
  // recall over the links that touch a sampled entry (each counted once)
  const sampled = new Set(keys.map((k) => nodeOf[k]));
  const reachable = rel.edges.filter((e) => sampled.has(e.from) || sampled.has(e.to));
  const edgesByType = {}; reachable.forEach((e) => { edgesByType[e.type] = (edgesByType[e.type] || 0) + 1; });
  return { runs: keys.length, edges: new Set(reachable.map((e) => pairKey(e.from, e.to, e.type))).size, edgesByType, recovered, falseLinks, proposals, byType };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = arg('--data', path.join(here, '..', '..', 'web', 'data', 'v2'));
  const entries = read(dir, 'entries.json'), relationships = read(dir, 'relationships.json');
  const fresh = backtest({ entries, relationships, asNew: true });
  const b = backtest({ entries, relationships });
  const right = b.proposals - b.falseLinks.length;
  const pct = (a, n) => (n ? ((100 * a) / n).toFixed(1) + '%' : 'n/a');
  console.log(`Backtest of the code link proposer on ${dir}`);
  console.log(`  as new bills (node removed too): ${fresh.proposals} proposals, ${fresh.falseLinks.length} false links, ${fresh.recovered.size} of ${fresh.edges} recovered`);
  fresh.falseLinks.forEach((f) => console.log(`  FALSE LINK (as new) ${f.from} -> ${f.to} (${f.type}) from ${f.entry}`));
  console.log(`  ${b.runs} entries with links, each run with all its links removed`);
  console.log(`  proposals: ${b.proposals}, right: ${right}, false links: ${b.falseLinks.length}`);
  console.log(`  precision: ${pct(right, b.proposals)}`);
  console.log(`  recall: ${b.recovered.size} of ${b.edges} links recovered (${pct(b.recovered.size, b.edges)})`);
  const rec = {}; [...b.recovered].forEach((k) => { const t = k.split('|')[2]; rec[t] = (rec[t] || 0) + 1; });
  Object.entries(b.edgesByType).sort().forEach(([t, n]) => console.log(`    ${t.padEnd(11)} ${String(rec[t] || 0).padStart(3)} of ${String(n).padStart(3)} (${pct(rec[t] || 0, n)})`));
  if (args.includes('--verbose')) [...b.recovered].sort().forEach((k) => console.log('  recovered ' + k));
  b.falseLinks.forEach((f) => console.log(`  FALSE LINK ${f.from} -> ${f.to} (${f.type}, "${f.label}") from ${f.entry}: "${f.evidence[0].quote}"`));
  process.exit(b.falseLinks.length || fresh.falseLinks.length ? 1 : 0);
}
