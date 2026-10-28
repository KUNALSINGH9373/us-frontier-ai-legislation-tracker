// The Telegram message for one run report, formatted with Telegram's HTML tags. Pure: report in, { text, silent } out.
//   🟢 all good   🟡 something needs a look   🔴 the run failed
// Built for a phone: short lines (about 35 characters), one idea per line, no tables. The only code block is the exact error.
// Every piece of data goes through esc(), so a bill title can never break the markup.
import { when, took, watchLines } from './format.mjs';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v) => (v == null ? '?' : Number(v).toLocaleString('en-US'));
const usd = (v) => (v == null ? 'unknown' : '$' + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)));
const clip = (s, max) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
const SHORT = { 'Congress.gov': 'Congress', 'Federal Register': 'FedReg', 'LegiScan (states)': 'LegiScan' };

const head = (rep, icon, text) => `${icon} <b>${text}</b>\n<i>${esc(when(rep.finished_at || rep.started_at))}${rep.duration_s != null ? ' · ' + took(rep.duration_s) : ''}</i>${rep.dry_run ? '\n<i>dry run, nothing saved</i>' : ''}`;

// Cost and queries: one short line each.
function numbers(rep) {
  const c = rep.ai_cost, m = rep.month, L = [];
  L.push(`💰 <b>AI cost</b>  ${c.unpriced_calls ? 'unknown (a model has no price)' : usd(c.cost_usd)}`);
  if (m && m.cap) L.push(`📅 <b>This month</b>  ${usd(m.spent)} of ${usd(m.cap)} (${((m.spent / m.cap) * 100).toFixed(1)}%)`);
  const ss = rep.sources.filter((s) => s.requests != null);
  if (ss.length) { L.push(`🔎 <b>Free queries</b>  ${num(ss.reduce((t, s) => t + s.requests, 0))}`); if (ss.length > 1) L.push(`<i>${ss.map((s) => `${SHORT[s.name] || s.name} ${num(s.requests)}`).join(' · ')}</i>`); }
  const ls = rep.legiscan;
  if (ls && ls.month_cap) L.push(`🏛 <b>LegiScan month</b>  ${num(ls.month_used)} / ${num(ls.month_cap)}`);
  return L.join('\n');
}

function failed(rep) {
  const L = [head(rep, '🔴', 'Update failed'), '', `<b>Failed at:</b> ${esc(rep.failed_step || 'an unknown step')}`, `<pre>${esc(clip(rep.error, 1500))}</pre>`,
    rep.dry_run ? 'A dry run saves nothing.' : 'Nothing was changed.\nThe next run starts from the same point.', '', numbers(rep)];
  return { text: L.join('\n'), silent: false };
}

// What changed in one bill: the new status line, kept short.
const detailOf = (rep, key) => {
  const f = rep.publish.runs.flatMap((p) => p.fields_changed).find((c) => c.entry_key === key && c.field === 'status_text');
  if (f && f.new) return f.new;
  const a = rep.publish.runs.flatMap((p) => p.entries_updated).find((e) => e.entry_key === key);
  return a && a.actions[0] ? a.actions[0].text : '';
};

const bullets = (items, max, each) => [...items.slice(0, max).map(each), ...(items.length > max ? [`▸ and ${items.length - max} more`] : [])];

function done(rep) {
  const names = rep.names || {};
  // Held items get their own short block below, so the one-line version from the plain report is left out here.
  const watch = watchLines(rep).filter((w) => !/^LegiScan this month/.test(w) && !/items? on hold:/.test(w));
  const warn = watch.some((w) => w.startsWith('⚠️')) || rep.held.length > 0;
  const L = [head(rep, warn ? '🟡' : '🟢', rep.changed ? 'Update complete' : 'Update complete, no changes'), ''];
  const updated = rep.publish.runs.flatMap((p) => p.entries_updated), added = rep.publish.runs.flatMap((p) => p.entries_added);
  if (updated.length) L.push(`<b>Bills updated (${updated.length})</b>`, ...bullets(updated, 6, (e) => { const d = clip(detailOf(rep, e.entry_key), 42); return `▸ ${esc(clip(names[e.entry_key] || e.entry_key, 34))}${d ? `\n      <i>${esc(d)}</i>` : ''}`; }), '');
  else L.push('<b>Bills updated (0)</b>', '');
  if (added.length) L.push(`<b>New bills added (${added.length})</b>`, ...bullets(added, 6, (e) => `▸ ${esc(clip(names[e.entry_key] || e.entry_key, 34))}`), '');
  const addedIds = new Set(added.map((e) => e.item_id));
  const found = rep.sources.flatMap((s) => s.new_candidates.filter((c) => !addedIds.has(c.item_id)).map((c) => clip(c.title, 34)));
  if (found.length) L.push(`<b>New bills spotted (${found.length})</b>`, '<i>not published yet</i>', ...bullets(found, 4, (t) => `▸ ${esc(t)}`), '');
  const c = rep.corrections;
  if (c && c.ran) {
    const fixed = c.status === 'written' || c.status === 'dry-run' ? c.corrected : [];
    L.push(`<b>Self-check (${fixed.length} fixed)</b>`, `<i>${c.checked.length} entr${c.checked.length === 1 ? 'y' : 'ies'} re-read</i>`, ...bullets(fixed, 4, (x) => `▸ ${esc(clip(names[x.entry_key] || x.entry_key, 30))}, ${esc(x.field)}\n      <i>${esc(clip(x.problem, 80))}</i>`), '');
  }
  const nw = rep.news;
  if (nw && nw.ran) {
    if (nw.drafted.length) L.push(`<b>News drafted (${nw.drafted.length})</b>`, `<i>${nw.drafted.some((d) => d.written) ? 'from official releases, published' : 'not published: switched off'}</i>`, ...bullets(nw.drafted, 4, (d) => `▸ ${esc(clip(d.title, 34))}\n      <i>${esc(clip(d.publisher, 30))}</i>`), '');
    if (nw.leads.length) L.push(`<b>News leads (${nw.leads.length})</b>`, '<i>not published</i>', ...bullets(nw.leads, 4, (l) => `▸ ${esc(clip(l.title, 34))}\n      <i>${esc(clip(l.publisher, 30))}</i>`), '');
  }
  L.push(numbers(rep));
  if (rep.held.length || watch.length) {
    L.push('', '<b>⚠️ Watch</b>');
    for (const h of rep.held.slice(0, 4)) L.push(`▸ ${esc(clip(h.title || h.item_id, 34))}`, `      <i>${esc(clip(h.reason, 42))}</i>`);
    if (rep.held.length > 4) L.push(`▸ and ${rep.held.length - 4} more on hold`);
    for (const w of watch) L.push(esc(w.replace(/^(⚠️|ℹ️)\s*/, '')));
  }
  return { text: L.join('\n'), silent: !rep.changed && !warn };
}

export function formatHtml(rep) { return rep.outcome === 'failed' ? failed(rep) : done(rep); }
