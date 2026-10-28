// The links step: propose links for the entries a run added or changed, then either report them (auto_publish.relationships
// off, the default) or add them to relationships.json (on). Adding goes through links/apply.mjs and the publisher's stop rules
// (publish/guards.mjs, which allow the network to grow only by exactly the links applied here). Returns the run report's
// "Links proposed" section: { status, proposed, applied, companions, dropped, problems, summary }.
import { propose } from './propose.mjs';
import { applyLinks } from './apply.mjs';
import { checkPublish } from '../publish/guards.mjs';
import { loadData, writeData } from '../publish/run.mjs';

const brief = (p, names) => ({ from: p.from, to: p.to, type: p.type, label: p.label, method: p.method, quote: p.evidence[0].quote, source_url: p.evidence[0].source_url, names: [names[p.from] || p.from, names[p.to] || p.to] });

// changed: entry keys added or changed this run. reader / validator: AI clients, or null for code only. billIds, related, texts:
// see propose.mjs. A dry run proposes and checks but writes nothing.
export async function linkRun({ dataDir, docsDir = null, changed, config, runDate, maxEntries = 15, billIds, related, texts, reader = null, validator = null, dry = false, log = () => {} }) {
  const rep = { status: 'nothing', proposed: [], applied: [], companions: [], dropped: [], problems: [], summary: '' };
  if (!changed.length) return rep;
  const before = loadData(dataDir);
  const p = await propose({ entries: before.entries, relationships: before.relationships, changed, billIds, related, texts, reader, validator, log });
  const names = { ...Object.fromEntries(Object.entries(before.relationships.nodes).map(([k, n]) => [k, n.name])), ...Object.fromEntries(Object.entries(p.nodes).map(([k, n]) => [k, n.name])) };
  rep.proposed = p.proposals.map((x) => brief(x, names)); rep.companions = p.companions; rep.dropped = p.dropped;
  if (!p.proposals.length) { rep.summary = summaryOf(rep); return rep; }
  const on = !!(config.auto_publish && config.auto_publish.relationships);
  if (!on) { rep.status = 'proposed'; rep.summary = summaryOf(rep); return rep; }
  const a = applyLinks({ data: before, proposals: p.proposals, nodes: p.nodes });
  const after = { ...before, relationships: a.relationships };
  const check = checkPublish({ before, after, runDate, maxEntries, links: a.added });
  rep.problems = [...a.problems, ...check.problems];
  if (rep.problems.length) rep.status = 'stopped';
  else {
    rep.status = dry ? 'dry-run' : 'written';
    rep.applied = a.added.edges.map((e) => ({ from: e.from, to: e.to, type: e.type, label: e.label }));
    if (!dry && a.added.edges.length) { writeData(dataDir, after, ['relationships']); if (docsDir) writeData(docsDir, after, ['relationships']); }
  }
  rep.summary = summaryOf(rep);
  return rep;
}

function summaryOf(rep) {
  const L = [`Links: ${rep.proposed.length} proposed${rep.applied.length ? `, ${rep.applied.length} added to the network` : rep.status === 'proposed' ? ' (adding links is switched off; reported only)' : ''}`];
  rep.proposed.forEach((p) => L.push(`- ${p.names[0]} -> ${p.names[1]} (${p.type}, ${p.method}): ${p.label}`));
  rep.companions.forEach((c) => L.push(`- companion: ${c.entry_key} is the companion of ${c.companion_of} (${c.bill}); keep them in one entry`));
  if (rep.problems.length) { L.push('STOPPED, nothing written:'); rep.problems.forEach((x) => L.push(`- ${x}`)); }
  return L.join('\n') + '\n';
}
