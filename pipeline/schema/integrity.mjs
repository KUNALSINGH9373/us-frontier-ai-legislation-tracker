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
    problems.push(...pageFieldProblems(e));
    problems.push(...pressProblems(e));
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
    site.comparison_matrix.rows.forEach((r) => { if (!Object.keys(r.values).length && !r.note) problems.push(`comparison row "${r.dimension}": no values and no note`); });
    site.comparison_matrix.rows.forEach((r) => Object.keys(r.values).forEach((k) => { if (!site.comparison_matrix.entry_keys.includes(k)) problems.push(`comparison row "${r.dimension}": ${k} is not a column`); }));
  }
  return problems;
}

// The entry page's written fields (display_name, summary_line, thirty_seconds, key_facts, exec_checklist, claims): who checked
// them must be recorded, each belongs to its layout, and no number in them may be new. Every number must appear in the entry's own
// checked text (title, mechanism, thresholds, penalties, dates, status, the duty and checklist answers with their quotes, events);
// a display name's numbers must appear in the title or short name.
export const PAGE_FIELDS = ['display_name', 'summary_line', 'thirty_seconds', 'key_facts', 'exec_checklist', 'claims'];
const numbersIn = (s) => (String(s).replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) || []);
export function pageFieldProblems(e) {
  const out = [], set = PAGE_FIELDS.filter((f) => e[f] !== undefined);
  if (!set.length) return out;
  if (!e.page_verification) out.push(`${e.key}: page fields ${set.join(', ')} are set but page_verification (who checked them) is missing`);
  if (e.exec_checklist && !['executive', 'export'].includes(e.type)) out.push(`${e.key}: exec_checklist is only for executive actions and export rules, not ${e.type}`);
  if (e.claims && e.type !== 'litigation') out.push(`${e.key}: claims are only for lawsuits, not ${e.type}`);
  const answers = (o) => Object.values(o || {}).flatMap((d) => [d.summary, d.quote]);
  const own = [e.title, e.short_name, e.mechanism, e.thresholds, e.penalties, e.status_text, e.signed_text, e.effective_text, e.sponsor_text,
    ...answers(e.duties), ...answers(e.exec_checklist), ...(e.events || []).flatMap((v) => [v.date, v.text, v.clause]),
    ...(e.plain ? Object.values(e.plain.items || {}).flat().flatMap((i) => [i.text, i.quote]) : [])].filter(Boolean).join(' ');
  const known = new Set(numbersIn(own));
  const check = (where, text, pool = known) => numbersIn(text).forEach((n) => { if (!pool.has(n)) out.push(`${e.key}: ${where} has the number ${n}, which is not in the entry's own checked text`); });
  if (e.display_name) check('display_name', e.display_name, new Set(numbersIn(e.title + ' ' + e.short_name)));
  if (e.summary_line) check('summary_line', e.summary_line);
  if (e.thirty_seconds) Object.entries(e.thirty_seconds).forEach(([k, t]) => check('thirty_seconds.' + k, t));
  if (e.key_facts) Object.entries(e.key_facts).forEach(([k, t]) => check('key_facts.' + k, t));
  (e.claims || []).forEach((c, i) => check(`claims[${i}]`, c.label + ' ' + (c.note || '')));
  return out;
}

// In the press (entry.press): each link on its outlet's own site, no link twice, newest first.
const PRESS_HOSTS = { 'The New York Times': 'nytimes.com', 'The Washington Post': 'washingtonpost.com', CNN: 'cnn.com', 'The Independent': 'independent.co.uk', Politico: 'politico.com' };
export function pressProblems(e) {
  const out = [], list = e.press || [];
  list.forEach((x, i) => {
    let h = '';
    try { h = new URL(x.url).hostname.toLowerCase(); } catch { /* reported below */ }
    const d = PRESS_HOSTS[x.outlet];
    if (!d || !(h === d || h.endsWith('.' + d))) out.push(`${e.key}: press[${i}] link is not on ${x.outlet}'s own site`);
    if (list.findIndex((y) => y.url === x.url) !== i) out.push(`${e.key}: press[${i}] is listed twice`);
    if (i > 0 && String(list[i - 1].date) < String(x.date)) out.push(`${e.key}: press is not newest first`);
  });
  return out;
}
