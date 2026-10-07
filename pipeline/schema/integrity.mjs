// Checks that cross-reference between files, which a per-file schema cannot see.
// Returns a list of problems; empty means the data set is consistent.
export function checkIntegrity({ entries, relationships, news, site }) {
  const problems = [];
  const keys = new Set(), ids = new Set();
  entries.forEach((e) => {
    if (keys.has(e.key)) problems.push(`duplicate entry key: ${e.key}`);
    if (ids.has(e.id)) problems.push(`duplicate entry id: ${e.id}`);
    keys.add(e.key); ids.add(e.id);
    // events: real calendar dates, oldest first
    let prev = '';
    e.events.forEach((ev, i) => {
      const d = new Date(ev.date + 'T00:00:00Z');
      if (Number.isNaN(+d) || d.toISOString().slice(0, 10) !== ev.date) problems.push(`${e.key} events[${i}]: not a real date: ${ev.date}`);
      if (prev && ev.date < prev) problems.push(`${e.key} events[${i}]: out of order`);
      prev = ev.date;
      if (ev.scheduled !== undefined && ev.scheduled !== (ev.date > site.updates_through)) problems.push(`${e.key} events[${i}]: scheduled flag disagrees with the cut-off date`);
    });
    if (e.last_changed > e.last_checked) problems.push(`${e.key}: last_changed is after last_checked`);
    if (e.last_checked > site.updates_through) problems.push(`${e.key}: last_checked is after the data cut-off`);
  });

  Object.entries(relationships.nodes).forEach(([k, n]) => {
    if (n.kind === 'entry' && !keys.has(n.entry_key)) problems.push(`relationship node ${k}: no such entry ${n.entry_key}`);
    if (n.column >= relationships.columns.length) problems.push(`relationship node ${k}: column ${n.column} does not exist`);
  });
  relationships.edges.forEach((e, i) => {
    ['from', 'to'].forEach((s) => { if (!relationships.nodes[e[s]]) problems.push(`edge #${i}: unknown node ${e[s]}`); });
    if (!relationships.types[e.type]) problems.push(`edge #${i}: unknown type ${e.type}`);
  });

  news.items.forEach((n, i) => { if (n.tracker && !keys.has(n.tracker)) problems.push(`news #${i}: no such entry ${n.tracker}`); });
  site.replay_milestones.forEach((m, i) => { if (!keys.has(m.entry_key)) problems.push(`milestone #${i}: no such entry ${m.entry_key}`); });
  if (site.comparison_matrix) {
    site.comparison_matrix.entry_keys.forEach((k) => { if (!keys.has(k)) problems.push(`comparison matrix: no such entry ${k}`); });
    site.comparison_matrix.rows.forEach((r) => Object.keys(r.values).forEach((k) => { if (!site.comparison_matrix.entry_keys.includes(k)) problems.push(`comparison row "${r.dimension}": ${k} is not a column`); }));
  }
  return problems;
}
