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
  const c = rep.corrections;
  if (c && c.status === 'stopped') w.push(`⚠️ Self-check corrections were not written (a stop rule failed: ${clip(c.problems[0], 120)}); they are retried next run.`);
  else if (c && c.problems && c.problems.length) w.push(`⚠️ Self-check: ${clip(c.problems[0], 140)}`);
  const nw = rep.news;
  if (nw && nw.feeds_failed && nw.feeds_failed.length) w.push(`⚠️ ${nw.feeds_failed.length} news feed${nw.feeds_failed.length === 1 ? '' : 's'} could not be read: ${list(nw.feeds_failed.map((f) => f.id), 3)}`);
  if (nw && nw.status === 'stopped') w.push(`⚠️ News items were not written (a stop rule failed: ${clip(nw.problems[0], 120)}); they are retried next run.`);
  else if (nw && nw.problems && nw.problems.length) w.push(`⚠️ News: ${clip(nw.problems[0], 140)}`);
  for (const n of rep.notes || []) w.push(`ℹ️ ${n}`);
  return w;
}

// Was an auto_publish switch turned off for this run by the accuracy gate (on in config, below the bar)? The reason, or null.
const gatedOff = (rep, field) => { const x = ((rep.gate && rep.gate.off) || []).find((g) => g.field === field); return x ? x.why || 'the accuracy gate is below the bar' : null; };
// Why record-proved links were not added, from the links step's own state.
function linksNotAddedWhy(rep, lk) {
  if (lk.status === 'stopped') return `stopped by a check: ${clip((lk.problems || [])[0] || 'a stop rule failed', 120)}`;
  if (lk.status === 'held') return 'put back by the final check';
  if (lk.status === 'dry-run') return 'dry run, nothing saved';
  const g = gatedOff(rep, 'relationships');
  if (g) return `adding links is switched off this run by the accuracy gate: ${clip(g, 100)}`;
  return 'adding links is switched off';
}
// The suffix of the "Links proposed" line: what happened to the record-proved ones, in the step's real state.
function linksSuffix(rep, lk) {
  const can = lk.proposed.filter((p) => p.applies).length;
  if (lk.status === 'written' && lk.applied.length) return `, ${lk.applied.length} added to the network`;
  if (lk.status === 'dry-run') return `, ${can} would be added (dry run, nothing saved)`;
  if (lk.status === 'stopped' || lk.status === 'held') return `, none added (${linksNotAddedWhy(rep, lk)})`;
  if (!can) return ' (reported only: none is proved by an official record)';
  return ` (reported only: ${can} proved by an official record, not added: ${linksNotAddedWhy(rep, lk)})`;
}
// Why drafted news items were not published, from the news step's real state (the switch after the gate, a dry run, a stop rule,
// or the final check putting them back).
function newsNotPublishedWhy(rep, nw) {
  if (nw.status === 'dry-run') return 'dry run, nothing saved';
  if (nw.status === 'stopped') return `stopped by a check: ${clip((nw.problems || [])[0] || 'a stop rule failed', 120)}`;
  if (nw.status === 'written') return 'put back by the final check';
  const g = gatedOff(rep, 'news');
  if (g) return `news publishing is switched off this run by the accuracy gate: ${clip(g, 100)}`;
  if (!nw.publishing) return 'news publishing is switched off';
  return 'not written this run';
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
  const addedIds = new Set(rep.publish.runs.flatMap((p) => p.entries_added.map((e) => e.item_id)));
  const found = rep.sources.flatMap((s) => s.new_candidates.filter((c) => !addedIds.has(c.item_id)).map((c) => clip(c.title, 60)));
  if (found.length) L.push(`New bills spotted: ${found.length} (${list(found, 3)}) — not published yet`);
  const c = rep.corrections;
  if (c && c.ran) {
    const fixed = c.status === 'written' || c.status === 'dry-run' ? c.corrected : [];
    L.push(`Self-check: ${c.checked.length} entr${c.checked.length === 1 ? 'y' : 'ies'} re-read against the bill text, ${fixed.length} field${fixed.length === 1 ? '' : 's'} corrected`);
    fixed.forEach((x) => L.push(`- ${clip(names[x.entry_key] || x.entry_key, 40)}, ${x.field} (${x.kind}): ${clip(x.problem, 160)}`));
  }
  const lk = rep.links;
  if (lk && (lk.proposed.length || lk.companions.length || (lk.notes || []).length)) {
    L.push(`Links proposed: ${lk.proposed.length}${linksSuffix(rep, lk)}`);
    const added = lk.status === 'written' && lk.applied.length, wouldAdd = lk.status === 'dry-run';
    lk.proposed.slice(0, 6).forEach((p) => L.push(`- ${clip(p.names[0], 30)} → ${clip(p.names[1], 30)}: ${clip(p.label, 80)} — ${p.applies ? (added ? 'added' : wouldAdd ? 'would be added (dry run)' : `not added (${linksNotAddedWhy(rep, lk)})`) : `proposal only (${clip(p.why || 'not proved by an official record', 90)})`}`));
    if (lk.proposed.length > 6) L.push(`- and ${lk.proposed.length - 6} more`);
    (lk.notes || []).slice(0, 3).forEach((n) => L.push(`- not proposed: ${clip(names[n.entry_key] || n.entry_key, 40)}: ${clip(n.why, 160)}`));
    if ((lk.notes || []).length > 3) L.push(`- and ${lk.notes.length - 3} more not proposed`);
    lk.companions.forEach((x) => L.push(`- companion bill: ${clip(names[x.entry_key] || x.entry_key, 40)} = ${x.bill} (${x.companion_of})`));
  }
  const nw = rep.news;
  if (nw && nw.ran) {
    if (nw.drafted.length) {
      const live = nw.drafted.filter((d) => d.written).length;
      L.push(`News drafted: ${nw.drafted.length} from official releases, ${live ? `${live} published${live < nw.drafted.length ? `, ${nw.drafted.length - live} not published (${newsNotPublishedWhy(rep, nw)})` : ''}` : `not published (${newsNotPublishedWhy(rep, nw)})`}`);
      nw.drafted.slice(0, 4).forEach((d) => L.push(`- ${clip(d.title, 80)} (${clip(d.publisher, 30)})`));
    }
    const wr = nw.waiting_record || [];
    if (wr.length) L.push(`News waiting for the official record: ${wr.length} (${list(wr.map((w) => `${clip(w.title, 50)}, ${clip(w.publisher, 24)}`), 3)}) — retried next run`);
    if (nw.leads.length) L.push(`News leads: ${nw.leads.length} (${list(nw.leads.map((l) => `${clip(l.title, 50)}, ${clip(l.publisher, 24)}`), 3)}) — not published`);
  }
  L.push(costLine(rep), queriesLine(rep));
  const w = watchLines(rep);
  if (w.length) L.push('', ...w);
  return L.join('\n');
}

export function formatReport(rep, { names = rep.names || {} } = {}) {
  return rep.outcome === 'failed' ? formatFailed(rep) : formatDone(rep, names);
}
export const formatChanged = formatDone, formatNoChange = formatDone;
