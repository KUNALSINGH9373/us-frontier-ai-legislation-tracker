// The Telegram message for one run report: short, plain English. Pure: report in, text out.
//   ✅ Update done      what was updated, new bills found, AI cost, free queries used, and a ⚠️ line only if something needs a look
//   ❌ Update FAILED    the step and the exact error, and that nothing was changed
// Plain text (no markup), so nothing in a bill title can break the message.

const num = (v) => (v == null ? '?' : Number(v).toLocaleString('en-US'));
const usd = (v) => (v == null ? 'unknown' : '$' + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const when = (iso) => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`; };
export const took = (s) => (s == null ? '' : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const clip = (s, max) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
const list = (items, max = 4) => (items.length > max ? items.slice(0, max).join(', ') + ` and ${items.length - max} more` : items.join(', '));

const title = (rep, ok, text) => `${ok ? '✅' : '❌'} ${text} · ${when(rep.finished_at || rep.started_at)}${rep.duration_s != null ? ' · ' + took(rep.duration_s) : ''}${rep.dry_run ? ' · 🧪 dry run, nothing saved' : ''}`;

// "Free API queries": every source's requests (Congress.gov, Federal Register, LegiScan all have free tiers).
function queriesLine(rep) {
  const ss = rep.sources.filter((s) => s.requests != null);
  if (!ss.length) return 'Free API queries used: none';
  const total = ss.reduce((t, s) => t + s.requests, 0);
  return `Free API queries used: ${num(total)} (${ss.map((s) => `${s.name.replace(' (states)', '')} ${num(s.requests)}`).join(', ')})`;
}

function costLine(rep) {
  const c = rep.ai_cost, m = rep.month;
  const run = c.unpriced_calls ? 'unknown (a model has no price set)' : usd(c.cost_usd);
  return `AI cost: ${run} this run${m ? ` · ${usd(m.spent)}${m.cap ? ` of ${usd(m.cap)}` : ''} this month` : ''}`;
}

// Only what needs a look. Silence means everything is fine.
export function watchLines(rep) {
  const w = [], m = rep.month, t = rep.totals || {};
  if (m && m.over) w.push('⚠️ The monthly AI limit is reached: AI work is paused until next month.');
  else if (m && m.warn) w.push(`⚠️ AI spending is at ${Math.round((m.spent / m.cap) * 100)}% of the monthly limit.`);
  const ls = rep.legiscan;
  if (ls && ls.month_cap && ls.month_used / ls.month_cap >= 0.8) w.push(`⚠️ LegiScan queries are at ${Math.round((ls.month_used / ls.month_cap) * 100)}% of this month's limit (${num(ls.month_used)} of ${num(ls.month_cap)}).`);
  else if (ls && ls.month_cap) w.push(`LegiScan this month: ${num(ls.month_used)} of ${num(ls.month_cap)} queries`);
  for (const s of rep.sources) if (s.truncated) w.push(`⚠️ ${s.name} stopped early and will carry on next run.`);
  const errs = rep.sources.reduce((k, s) => k + (s.counts.errors || 0), 0);
  if (errs) w.push(`⚠️ ${num(errs)} item${errs === 1 ? '' : 's'} had a read error while checking sources.`);
  if (rep.held.length) w.push(`⚠️ ${rep.held.length} item${rep.held.length === 1 ? '' : 's'} on hold: ${list(rep.held.map((h) => `${clip(h.title || h.item_id, 40)} (${clip(h.reason, 70)})`), 3)}`);
  if (rep.ai.skipped_why && !rep.dry_run && !/--no-ai|turned off/.test(rep.ai.skipped_why)) w.push(`⚠️ The AI step did not run: ${rep.ai.skipped_why}.`);
  for (const n of rep.notes || []) w.push(`ℹ️ ${n}`);
  return w;
}

export function formatFailed(rep) {
  const L = [title(rep, false, `Update FAILED at ${rep.failed_step || 'an unknown step'}`), '', `Error: ${clip(rep.error, 1500)}`, ''];
  L.push(rep.dry_run ? 'A dry run saves nothing.' : 'Nothing was changed. The next run starts from the same point.');
  L.push('', costLine(rep), queriesLine(rep));
  return L.join('\n');
}

export function formatDone(rep, names = {}) {
  const t = rep.totals, updated = rep.publish.runs.flatMap((p) => p.entries_updated.map((e) => names[e.entry_key] || e.entry_key)), added = rep.publish.runs.flatMap((p) => p.entries_added.map((e) => names[e.entry_key] || e.entry_key));
  const L = [title(rep, true, rep.changed ? 'Update done' : 'Update done, no changes'), ''];
  L.push(`Bills updated: ${t.entries_updated}${updated.length ? ' (' + list(updated) + ')' : ''}`);
  if (added.length) L.push(`New bills added: ${added.length} (${list(added)})`);
  const found = rep.sources.flatMap((s) => s.new_candidates.map((c) => clip(c.title, 60)));
  if (found.length) L.push(`New bills spotted: ${found.length} (${list(found, 3)}) — not published yet`);
  L.push(costLine(rep), queriesLine(rep));
  const w = watchLines(rep);
  if (w.length) L.push('', ...w);
  return L.join('\n');
}

export function formatReport(rep, { names = rep.names || {} } = {}) {
  return rep.outcome === 'failed' ? formatFailed(rep) : formatDone(rep, names);
}
export const formatChanged = formatDone, formatNoChange = formatDone;
