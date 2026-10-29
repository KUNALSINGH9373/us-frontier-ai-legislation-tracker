// Run:  node links/backtest.mjs [--data <dir>] [--verbose]
// How well the code proposer finds the links the tracker already has. For every entry that has links in the network, all its
// links are removed and the proposer is run on that entry alone. Each proposal is scored strictly:
//   right            the network has the same edge (same from, same to, same type) and the label means the same (labelOk);
//   wrong label      same edge, but the label says something else (e.g. "Sponsor" where the network says "Cosponsor");
//   wrong direction  the network has the pair the other way round;
//   conflict         the network has the pair the other way round, and that hand-written edge breaks the direction convention
//                    itself (links/rules.mjs: an amendment edge whose label names its own `from` as the law amended); listed,
//                    never counted right;
//   false link       anything else.
// Prints precision and recall on the real data, and exits 1 on any false link, wrong direction or wrong label (the code
// proposer's bar is zero).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { proposeByCode, pairKey, aliases, isApplicable } from './propose.mjs';
import { loadRunRecords } from './records.mjs';
import { loadData } from '../publish/run.mjs';
import { AMEND_PREFIX } from './rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

// Does a proposed label mean what the network's label for the same edge says?
export function labelOk(proposed, existing, type) {
  if (type === 'actor') {
    if (proposed === 'Sponsor') return /^(?:lead |chief |house |senate )?sponsor\b(?!s )/i.test(existing) && !/co-?sponsor/i.test(existing);
    if (proposed === 'Draft author') return /^draft author\b/i.test(existing);
    return false;
  }
  if (type === 'succession' && proposed.startsWith(AMEND_PREFIX)) return /\bamend|^adds\b/i.test(existing);
  return proposed === existing;
}
// A hand-written edge that breaks the convention itself: "Would amend <X>" where X is the edge's own `from`.
export function selfContradicting(edge, rel, entries) {
  if (edge.type !== 'succession' || !String(edge.label).startsWith(AMEND_PREFIX)) return false;
  const n = rel.nodes[edge.from], e = n && entries.find((x) => x.key === n.entry_key);
  return !!e && aliases(e).some((a) => edge.label.includes(a.replace(/^NY\s+/, '')));
}

// Returns { runs, edges, edgesByType, recovered: Set of edge keys, falseLinks, wrongDirection, wrongLabel, conflicts, proposals, byType }.
// asNew: also remove the entry's node, as for a bill the network has never seen (the proposer then places a new node, which is
// mapped back to the old key for scoring). proposer: the function to score (default proposeByCode).
// records: { entry key: [raw official records] } (links/records.mjs loadRunRecords), so record-proved sponsor links can be scored.
// Every proposal is also scored in its bucket: `applied` (record-proved sponsor links, the only kind ever added; the bar is zero
// wrong) and `reportOnly` (everything else: proposals in the run report).
export function backtest({ entries, relationships: rel, sample = null, asNew = false, proposer = proposeByCode, records = {}, actorIds = undefined }) {
  const nodeOf = {}; Object.entries(rel.nodes).forEach(([k, n]) => { if (n.kind === 'entry') nodeOf[n.entry_key] = k; });
  const keys = (sample || entries.map((e) => e.key)).filter((k) => nodeOf[k] && rel.edges.some((e) => e.from === nodeOf[k] || e.to === nodeOf[k]));
  const exact = new Map(rel.edges.map((e) => [e.from + '>' + e.to + '|' + e.type, e]));
  const recovered = new Set(), falseLinks = [], wrongDirection = [], wrongLabel = [], conflicts = [], byType = {};
  let proposals = 0;
  const bucket = () => ({ proposals: 0, right: 0, wrong: [], conflicts: 0, recovered: new Set() });
  const applied = bucket(), reportOnly = bucket();
  for (const key of keys) {
    const n = nodeOf[key], stripped = { ...rel, nodes: { ...rel.nodes }, edges: rel.edges.filter((e) => e.from !== n && e.to !== n) };
    if (asNew) delete stripped.nodes[n];
    const r = proposer({ entries, relationships: stripped, changed: [key], records, ...(actorIds ? { actorIds } : {}) });
    const back = (k) => (r.nodes[k] && r.nodes[k].entry_key === key ? n : k);
    for (const p0 of r.proposals) {
      const p = { ...p0, from: back(p0.from), to: back(p0.to) }, bk = isApplicable(p0) ? applied : reportOnly;
      proposals++; bk.proposals++;
      const t = (byType[p.type] = byType[p.type] || { proposed: 0, right: 0 });
      t.proposed++;
      const same = exact.get(p.from + '>' + p.to + '|' + p.type), rev = exact.get(p.to + '>' + p.from + '|' + p.type);
      if (same && labelOk(p.label, same.label, p.type)) { recovered.add(pairKey(p.from, p.to, p.type)); bk.recovered.add(pairKey(p.from, p.to, p.type)); t.right++; bk.right++; }
      else if (same) { wrongLabel.push({ entry: key, ...p, existing: same.label }); bk.wrong.push({ entry: key, ...p, why: 'wrong label', existing: same.label }); }
      else if (rev && selfContradicting(rev, rel, entries)) { conflicts.push({ entry: key, ...p, existing: rev }); bk.conflicts++; if (bk === applied) bk.wrong.push({ entry: key, ...p, why: 'conflict' }); }
      else if (rev) { wrongDirection.push({ entry: key, ...p, existing: rev.label }); bk.wrong.push({ entry: key, ...p, why: 'wrong direction', existing: rev.label }); }
      else { falseLinks.push({ entry: key, ...p }); bk.wrong.push({ entry: key, ...p, why: 'false link' }); }
    }
  }
  // recall over the links that touch a sampled entry (each counted once)
  const sampled = new Set(keys.map((k) => nodeOf[k]));
  const reachable = rel.edges.filter((e) => sampled.has(e.from) || sampled.has(e.to));
  const edgesByType = {}; reachable.forEach((e) => { edgesByType[e.type] = (edgesByType[e.type] || 0) + 1; });
  return { runs: keys.length, edges: new Set(reachable.map((e) => pairKey(e.from, e.to, e.type))).size, edgesByType, recovered, falseLinks, wrongDirection, wrongLabel, conflicts, proposals, byType, applied, reportOnly };
}
export const errorsOf = (b) => b.falseLinks.length + b.wrongDirection.length + b.wrongLabel.length;

export function printBacktest(dir, entries, relationships, proposer = proposeByCode, log = console.log, records = {}) {
  const fresh = backtest({ entries, relationships, asNew: true, proposer, records });
  const b = backtest({ entries, relationships, proposer, records });
  const right = b.proposals - errorsOf(b) - b.conflicts.length;
  const pct = (a, n) => (n ? ((100 * a) / n).toFixed(1) + '%' : 'n/a');
  log(`Backtest of the code link proposer on ${dir} (strict: same direction, same type, same meaning of label)`);
  log(`  as new bills (node removed too): ${fresh.proposals} proposals, ${errorsOf(fresh)} wrong (${fresh.falseLinks.length} false, ${fresh.wrongDirection.length} wrong direction, ${fresh.wrongLabel.length} wrong label), ${fresh.conflicts.length} conflicts, ${fresh.recovered.size} of ${fresh.edges} recovered`);
  log(`  ${b.runs} entries with links, each run with all its links removed`);
  log(`  proposals: ${b.proposals}, right: ${right}, false links: ${b.falseLinks.length}, wrong direction: ${b.wrongDirection.length}, wrong label: ${b.wrongLabel.length}, conflicts with a hand-written edge that breaks the convention: ${b.conflicts.length}`);
  log(`  precision: ${pct(right, b.proposals)}`);
  log(`  recall: ${b.recovered.size} of ${b.edges} links recovered (${pct(b.recovered.size, b.edges)})`);
  const rec = {}; [...b.recovered].forEach((k) => { const t = k.split('|')[2]; rec[t] = (rec[t] || 0) + 1; });
  Object.entries(b.edgesByType).sort().forEach(([t, n]) => log(`    ${t.padEnd(11)} ${String(rec[t] || 0).padStart(3)} of ${String(n).padStart(3)} (${pct(rec[t] || 0, n)})`));
  if (args.includes('--verbose')) [...b.recovered].sort().forEach((k) => log('  recovered ' + k));
  b.falseLinks.forEach((f) => log(`  FALSE LINK ${f.from} -> ${f.to} (${f.type}, "${f.label}") from ${f.entry}: "${f.evidence[0].quote}"`));
  b.wrongDirection.forEach((f) => log(`  WRONG DIRECTION ${f.from} -> ${f.to} (${f.type}, "${f.label}"); the network has ${f.to} -> ${f.from} "${f.existing}"`));
  b.wrongLabel.forEach((f) => log(`  WRONG LABEL ${f.from} -> ${f.to} (${f.type}): "${f.label}"; the network says "${f.existing}"`));
  b.conflicts.forEach((f) => log(`  CONFLICT ${f.from} -> ${f.to} (${f.type}, "${f.label}"); the hand-written ${f.existing.from} -> ${f.existing.to} "${f.existing.label}" names its own from as the amended law`));
  for (const [name, x] of [['APPLIED (record-proved sponsor links, the only kind ever added)', b.applied], ['REPORT-ONLY proposals', b.reportOnly], ['as new bills, APPLIED', fresh.applied], ['as new bills, REPORT-ONLY', fresh.reportOnly]]) {
    log(`  ${name}: ${x.proposals} proposals, ${x.right} right, ${x.wrong.length} wrong, ${x.conflicts} conflicts`);
    if (x === b.applied || x === fresh.applied) x.wrong.forEach((f) => log(`    WRONG APPLIED ${f.from} -> ${f.to} (${f.label}, ${f.why}) from ${f.entry}: "${f.evidence[0].quote}"`));
  }
  return { b, fresh };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = arg('--data', path.join(here, '..', '..', 'web', 'data', 'v2'));
  const d = loadData(dir), runs = arg('--runs', path.join(here, '..', 'data', 'runs'));
  const records = loadRunRecords(runs, d.entries);
  console.log(`official records read from ${runs} for ${Object.keys(records).length} entries`);
  const { b, fresh } = printBacktest(dir, d.entries, d.relationships, proposeByCode, console.log, records);
  // the bar: zero wrong among applied links; report-only proposals are scored and listed, and the code proposer's own bar (zero
  // false links over all proposals) still holds
  process.exit(b.applied.wrong.length || fresh.applied.wrong.length || errorsOf(b) || errorsOf(fresh) ? 1 : 0);
}
