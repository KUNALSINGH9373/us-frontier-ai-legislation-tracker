// Accepted link proposals into relationships.json. Pure: data in, new data out, nothing written. Existing nodes and edges are
// never changed or removed: new edges go after the old ones, new nodes after the old ones, and only the nodes a new edge needs.
// Returns { relationships, added: { edges, nodes }, skipped: [{ proposal, why }], problems } ; problems non-empty = do not write.
import { checkIntegrity } from '../schema/integrity.mjs';
import { pairKey } from './propose.mjs';

// One proposal as a network edge: the first quote is the link's quote, and the pipeline is its origin.
export function edgeOf(p) {
  const ev = p.evidence[0];
  return { from: p.from, to: p.to, type: p.type, label: p.label, quote: ev.quote, source_url: ev.source_url, ...(p.dashed ? { dashed: true } : {}), origin: 'automated', src: p.method === 'ai' ? 'pipeline:links:ai' : 'pipeline:links:code' };
}

// data: { entries, relationships, news, site } (integrity needs them all). proposals, nodes: from propose.mjs.
export function applyLinks({ data, proposals, nodes = {} }) {
  const rel = data.relationships, out = { ...rel, nodes: { ...rel.nodes }, edges: [...rel.edges] };
  const seen = new Set(rel.edges.map((e) => pairKey(e.from, e.to, e.type)));
  const added = { edges: [], nodes: {} }, skipped = [];
  for (const p of proposals) {
    const why = !rel.types[p.type] ? `unknown type ${p.type}`
      : !(p.evidence || []).length || !p.evidence.every((x) => x.quote && String(x.quote).trim().length >= 8 && x.source_url) ? 'every link needs a quote and a source URL'
      : String(p.label || '').length < 3 ? 'no label'
      : p.from === p.to ? 'a link to itself'
      : seen.has(pairKey(p.from, p.to, p.type)) ? 'already in the network' : null;
    if (why) { skipped.push({ proposal: p, why }); continue; }
    const missing = [p.from, p.to].filter((k) => !out.nodes[k] && !nodes[k]);
    if (missing.length) { skipped.push({ proposal: p, why: `unknown node ${missing.join(', ')}` }); continue; }
    for (const k of [p.from, p.to]) if (!out.nodes[k]) { out.nodes[k] = nodes[k]; added.nodes[k] = nodes[k]; }
    const e = edgeOf(p);
    out.edges.push(e); added.edges.push(e); seen.add(pairKey(p.from, p.to, p.type));
  }
  const problems = checkIntegrity({ ...data, relationships: out });
  return { relationships: out, added, skipped, problems };
}
