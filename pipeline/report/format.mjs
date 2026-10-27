// The Telegram message for one run report. Pure: report in, text out. Three kinds:
//   "✅ Updated ..."      the data changed: what changed, field by field
//   "✅ No changes ..."   nothing changed: counts, queries and cost, so a quiet run still proves it looked
//   "❌ FAILED at <step>" the run stopped: where, why, and that nothing was written
// Plain text (no markup), so nothing in a bill title can break the message.

const clip = (v, max = 90) => {
  const s = typeof v === 'string' ? v : v == null ? '(none)' : JSON.stringify(v);
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};
const num = (v) => (v == null ? '?' : Number(v).toLocaleString('en-US'));
const usd = (v) => (v == null ? 'unknown' : '$' + (v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const when = (iso) => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };
export const took = (s) => (s == null ? '' : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const plural = (k, one, many = one + 's') => `${num(k)} ${k === 1 ? one : many}`;

function sourceLine(s) {
  const c = s.counts, bits = [];
  if (c.listed) bits.push(`${num(c.listed)} listed`);
  if (c.tracked_checked != null) bits.push(`${num(c.tracked_checked)} tracked checked`);
  bits.push(`${num(s.verdicts.material + s.verdicts.minor)} tracked changed`);
  bits.push(`${num(s.verdicts.new_entry_candidate)} new candidates`);
  if (c.screened_out) bits.push(`${num(c.screened_out)} screened out`);
  if (c.waiting) bits.push(`${num(c.waiting)} waiting for the next run`);
  if (c.errors) bits.push(`${num(c.errors)} errors`);
  const q = s.requests != null ? ` · ${num(s.requests)} ${s.source === 'legiscan' ? 'queries' : 'requests'}` : '';
  return `• ${s.name}: ${bits.join(', ')}${q}${s.truncated ? ' · ⏸ stopped early, resumes next run' : ''}`;
}

function costLines(rep) {
  const c = rep.ai_cost, L = [];
  const tok = c.calls ? `${num(c.calls)} call${c.calls === 1 ? '' : 's'}, ${num(c.input_tokens)} in / ${num(c.output_tokens)} out tokens, ${c.unpriced_calls ? 'cost unknown (a model has no price set)' : usd(c.cost_usd)}` : 'no AI calls';
  const steps = Object.entries(c.by_step || {}).map(([k, v]) => `${k} ${usd(v.cost_usd)}`).join(', ');
  L.push(`• AI: ${tok}${steps ? ` (${steps})` : ''}`);
  const m = rep.month;
  if (m) {
    L.push(`• AI this month: ${usd(m.spent)}${m.cap ? ` of ${usd(m.cap)} (${Math.round((m.spent / m.cap) * 100)}%)` : ''}`);
    if (m.over) L.push('⛔ The monthly AI cap is reached: AI work is paused until next month.');
    else if (m.warn) L.push('⚠️ AI spending passed the warning level for this month.');
  }
  if (rep.legiscan && rep.legiscan.month_cap) L.push(`• LegiScan this month: ${num(rep.legiscan.month_used)} of ${num(rep.legiscan.month_cap)} queries`);
  return L;
}

const head = (rep, icon, text) => `${icon} ${text}${rep.dry_run ? ' · 🧪 dry run, nothing written' : ''}`.replace(/\s+/g, ' ').trim();
const foot = (rep) => `Run ${rep.id} · ${when(rep.finished_at || rep.started_at)}${rep.duration_s != null ? ` · took ${took(rep.duration_s)}` : ''}`;

export function formatFailed(rep) {
  const L = [head(rep, '❌', `FAILED at ${rep.failed_step || 'the update'}: ${clip(rep.error, 300)}`)];
  L.push(rep.dry_run ? 'A dry run writes nothing.' : 'Nothing was written: the site data was left as it was, and the next run starts from the same point.');
  if (rep.sources.length) { L.push('', 'Done before it stopped:', ...rep.sources.map(sourceLine)); }
  L.push('', ...costLines(rep), '', foot(rep));
  return L.join('\n');
}

export function formatNoChange(rep) {
  const t = rep.totals || {};
  const L = [head(rep, '✅', 'No changes')];
  L.push(`Looked at ${plural(rep.sources.length, 'source')}: nothing new to publish.`, '', ...rep.sources.map(sourceLine));
  const aiRan = rep.ai.runs.length;
  if (aiRan) L.push(`• AI step: ${t.ai_in_scope} in scope, ${t.ai_out_of_scope} out of scope, ${t.held} held`);
  else if (rep.ai.skipped_why) L.push(`• AI step skipped: ${rep.ai.skipped_why}`);
  L.push(...costLines(rep), '', foot(rep));
  return L.join('\n');
}

export function formatChanged(rep, names = {}) {
  const t = rep.totals, L = [];
  const parts = [t.entries_updated && plural(t.entries_updated, 'entry', 'entries') + ' updated', t.entries_added && plural(t.entries_added, 'new entry', 'new entries'), t.news_added && plural(t.news_added, 'news item') + ' added', t.links_added && plural(t.links_added, 'link') + ' added'].filter(Boolean);
  L.push(head(rep, '✅', `Updated: ${parts.join(', ')}`), '');
  for (const p of rep.publish.runs) {
    for (const e of p.entries_updated) {
      L.push(`• ${names[e.entry_key] || e.entry_key}${e.status ? ` (now ${e.status})` : ''}`);
      for (const a of e.actions.slice(0, 3)) L.push(`    ${a.date}: ${clip(a.text, 110)}`);
      for (const f of p.fields_changed.filter((x) => x.entry_key === e.entry_key).slice(0, 4)) L.push(`    ${f.field}: ${clip(f.old, 60)} → ${clip(f.new, 80)}`);
    }
    for (const e of p.entries_added) L.push(`• NEW: ${names[e.entry_key] || e.entry_key}`);
  }
  const cands = rep.sources.reduce((k, s) => k + s.verdicts.new_entry_candidate, 0);
  L.push('', 'Counts:', ...rep.sources.map(sourceLine));
  if (rep.ai.runs.length) L.push(`• AI step: ${t.ai_in_scope} in scope, ${t.ai_out_of_scope} out of scope, ${t.held} held${rep.ai.runs.some((a) => a.deferred) ? `, ${rep.ai.runs.reduce((k, a) => k + a.deferred, 0)} deferred (per-run limit)` : ''}`);
  else if (cands && rep.ai.skipped_why) L.push(`• AI step skipped: ${rep.ai.skipped_why}`);
  if (rep.held.length) { L.push('', `Held (${rep.held.length}):`, ...rep.held.slice(0, 8).map((h) => `• ${clip(h.item_id, 50)}: ${clip(h.reason, 120)}`)); if (rep.held.length > 8) L.push(`  …and ${rep.held.length - 8} more (see run-report.json)`); }
  L.push('', ...costLines(rep), '', foot(rep));
  return L.join('\n');
}

// Held items alone do not make a run "changed", but they are worth saying even on a quiet run.
export function formatReport(rep, { names = rep.names || {} } = {}) {
  if (rep.outcome === 'failed') return formatFailed(rep);
  const text = rep.changed ? formatChanged(rep, names) : formatNoChange(rep);
  if (!rep.changed && rep.held.length) return text.replace('\n\n' + foot(rep), `\n\nHeld (${rep.held.length}):\n${rep.held.slice(0, 5).map((h) => `• ${clip(h.item_id, 50)}: ${clip(h.reason, 120)}`).join('\n')}\n\n${foot(rep)}`);
  return text;
}
