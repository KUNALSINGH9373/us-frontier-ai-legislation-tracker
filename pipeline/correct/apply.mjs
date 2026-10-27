// Applies confirmed self-corrections to the site data. Pure: current data and review results in, new data and the change log out.
// Each corrected field gets its new text and its new evidence (the old evidence for that field is replaced), the entry is marked as
// checked by the pipeline, and every change goes to changes.json (tier "C": old -> new, with the problem found and the quotes).
import { advanceCutoff } from '../publish/tier-a.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));

// results: [{ key, corrections: [...] }] from review.mjs. identifiersFor(key): how a state entry is found, for an entry becoming mixed.
export function applyCorrections({ data, results, runId, runDate, now = new Date(), identifiersFor = () => null }) {
  const out = { entries: clone(data.entries), news: clone(data.news), site: clone(data.site), changes: clone(data.changes || { items: [] }) };
  const byKey = new Map(out.entries.map((e) => [e.key, e]));
  const log = [], corrected = {};
  for (const r of results) {
    const e = byKey.get(r.key);
    if (!e || !r.corrections.length) continue;
    for (const c of r.corrections) {
      e[c.field] = c.new;
      e.evidence = [...(e.evidence || []).filter((x) => x.field !== c.field), ...c.evidence.map((q) => ({ field: c.field, quote: q, source_url: c.url }))];
      log.push({ entry_key: e.key, field: c.field, old: c.old, new: c.new, date: runDate, run_id: runId, source_url: c.url, tier: 'C', note: `self-correction (${c.kind}): ${c.problem} Quote: "${c.evidence[0]}"` });
    }
    if (!e.identifiers && identifiersFor(e.key)) e.identifiers = identifiersFor(e.key); // a mixed entry must say how it is found
    if (!(e.sources || []).some((s) => s.url === r.corrections[0].url)) e.sources = [...(e.sources || []), { label: 'Bill text (official)', url: r.corrections[0].url, kind: 'primary' }];
    if (e.origin === 'authored') { log.push({ entry_key: e.key, field: 'origin', old: 'authored', new: 'mixed', date: runDate, run_id: runId, source_url: r.corrections[0].url, tier: 'C' }); e.origin = 'mixed'; }
    e.verification = { method: 'agent', checked_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), run_id: runId, rounds: 1 };
    e.last_checked = runDate; e.last_changed = runDate;
    corrected[e.key] = r.corrections.map((c) => c.field);
  }
  if (log.length) { advanceCutoff(out, runDate); out.changes.items.push(...log); }
  return { data: out, log, corrected };
}
