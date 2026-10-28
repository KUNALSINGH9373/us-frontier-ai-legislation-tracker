// The run report: what one update run did, in one JSON file (data/updates/<id>/run-report.json) that the Telegram message is made from.
// Pure functions: update.mjs gathers what each step produced and passes it in; nothing here touches the network or the data.
import fs from 'fs';
import path from 'path';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const SOURCE_NAMES = { congress_gov: 'Congress.gov', federal_register: 'Federal Register', legiscan: 'LegiScan (states)' };

// The same few counts for every source, whatever the source calls them. The raw numbers stay in `stats`.
export function normaliseStats(source, stats = {}) {
  if (source === 'legiscan') {
    return { listed: n(stats.precise_hits) + n(stats.wide_hits), tracked_checked: n(stats.tracked_changed) + n(stats.tracked_unchanged), tracked_changed: n(stats.tracked_changed), candidates: n(stats.candidates),
      screened_out: n(stats.intent_no), unchanged: n(stats.tracked_unchanged), waiting: n(stats.waiting_for_next_run), errors: n(stats.text_missing) };
  }
  if (source === 'federal_register') return { listed: n(stats.found), tracked_checked: n(stats.tracked), tracked_changed: Math.max(0, n(stats.tracked) - n(stats.unchanged)), candidates: n(stats.candidates), screened_out: n(stats.screened_out), unchanged: n(stats.unchanged), waiting: n(stats.over_candidate_cap), errors: n(stats.errors) };
  return { listed: n(stats.listed), tracked_checked: null, tracked_changed: n(stats.tracked_changed), candidates: n(stats.candidates), screened_out: n(stats.screened_out), unchanged: n(stats.unchanged), waiting: n(stats.over_candidate_cap), errors: n(stats.errors) };
}

// One source: its grab stats (grab-stats.json, saved by the grabber) plus the compare verdict counts (diff.json).
export function sourceEntry({ runDir, source }) {
  const g = readJson(path.join(runDir, 'grab-stats.json')) || {}, diff = readJson(path.join(runDir, 'diff.json')) || { summary: {}, items: [] };
  const verdicts = { unchanged: 0, minor: 0, material: 0, new_entry_candidate: 0, ...diff.summary };
  return {
    source, name: SOURCE_NAMES[source] || source, run_id: g.run_id || path.basename(runDir), requests: g.requests ?? null, truncated: !!g.truncated, fallback_used: !!(g.stats && g.stats.list_fallback), items_in_change_set: g.items ?? diff.items.length,
    month_used: g.month_used ?? null, month_cap: g.month_cap ?? null, counts: normaliseStats(source, g.stats), stats: g.stats || {}, verdicts,
    new_candidates: diff.items.filter((d) => d.verdict === 'new_entry_candidate').map((d) => ({ item_id: d.item_id, title: d.title || (d.reasons && d.reasons[0] && d.reasons[0].detail) || d.item_id })),
    material: diff.items.filter((d) => d.verdict === 'material').map((d) => ({ item_id: d.item_id, entry_key: d.entry_key }))
  };
}

// The AI step for one run folder: results.json written by agents/run.mjs.
export function aiEntry({ runDir, results }) {
  const r = results || readJson(path.join(runDir, 'results.json'));
  if (!r) return null;
  const by = r.outcomes || {};
  return {
    run_id: r.run_id, eligible: r.eligible_items ?? null, processed: r.items.length, deferred: r.deferred_items ?? 0, outcomes: by,
    publishable: n(by.publishable), out_of_scope: n(by.out_of_scope), held: n(by.held), not_processed: n(by.not_processed),
    held_items: r.items.filter((i) => i.outcome === 'held' || i.outcome === 'not_processed').map((i) => ({ item_id: i.item_id, reason: i.reason || i.outcome })),
    stopped_by_month_cap: !!r.stopped_by_month_cap, stopped_by_budget: !!r.stopped_by_budget, stopped_by_service_errors: !!r.stopped_by_service_errors
  };
}

// What publishing did: entries touched, the fields changed (old -> new), news added.
export function publishEntry({ result, newsBefore = 0, newsAfter = 0, status }) {
  const log = (result && result.log) || [];
  return {
    status: status || null,
    entries_updated: ((result && result.applied) || []).map((a) => ({ entry_key: a.entry_key, status: a.status || null, actions: (a.actions || []).map((x) => ({ date: x.date, text: x.text })) })),
    entries_added: ((result && result.added) || []).map((a) => ({ entry_key: a.entry_key, item_id: a.item_id, section: a.section })), links_added: 0, news_added: Math.max(0, newsAfter - newsBefore),
    fields_changed: log.map((c) => ({ entry_key: c.entry_key, field: c.field, old: c.old, new: c.new, source_url: c.source_url })),
    not_applied: ((result && result.skipped) || []).map((s) => ({ ref: s.entry_key || s.item_id, why: s.why }))
  };
}

export function newReport({ id, now = new Date(), dry = false, sources = [] }) {
  return { id, started_at: now.toISOString(), finished_at: null, duration_s: null, dry_run: dry, outcome: 'ok', failed_step: null, error: null, sources: [], ai: { enabled: false, skipped_why: null, runs: [] }, publish: { runs: [] }, corrections: null, links: null, held: [], notes: [], planned_sources: sources };
}

// Roll the per-run pieces up into the totals the message and the JSON file lead with.
export function finalize(rep, { now = new Date(), spend = null, month = null } = {}) {
  rep.finished_at = now.toISOString();
  rep.duration_s = Math.round((+now - +new Date(rep.started_at)) / 1000);
  const sum = (f) => rep.sources.reduce((t, s) => t + n(f(s)), 0);
  const pubs = rep.publish.runs, ais = rep.ai.runs;
  rep.totals = {
    requests: sum((s) => s.requests), listed: sum((s) => s.counts.listed), screened_out: sum((s) => s.counts.screened_out), candidates: sum((s) => s.verdicts.new_entry_candidate),
    tracked_changed: sum((s) => s.verdicts.material + s.verdicts.minor), material: sum((s) => s.verdicts.material), minor: sum((s) => s.verdicts.minor), unchanged: sum((s) => s.verdicts.unchanged),
    ai_in_scope: ais.reduce((t, a) => t + a.publishable + a.held, 0), ai_out_of_scope: ais.reduce((t, a) => t + a.out_of_scope, 0),
    published: pubs.reduce((t, p) => t + p.entries_updated.length + p.entries_added.length, 0), held: ais.reduce((t, a) => t + a.held + a.not_processed, 0),
    entries_updated: pubs.reduce((t, p) => t + p.entries_updated.length, 0), entries_added: pubs.reduce((t, p) => t + p.entries_added.length, 0), news_added: pubs.reduce((t, p) => t + p.news_added, 0), links_added: pubs.reduce((t, p) => t + p.links_added, 0) + (rep.links && rep.links.status === 'written' ? rep.links.applied.length : 0),
    fields_changed: pubs.reduce((t, p) => t + p.fields_changed.length, 0),
    entries_rechecked: rep.corrections ? rep.corrections.checked.length : 0, fields_corrected: rep.corrections && rep.corrections.status === 'written' ? rep.corrections.corrected.length : 0
  };
  rep.held = [...ais.flatMap((a) => a.held_items.map((h) => ({ ...h, kind: 'ai' }))), ...pubs.flatMap((p) => p.not_applied.map((x) => ({ item_id: x.ref, reason: x.why, kind: 'publish' })))];
  // A readable name for each held item: the candidate's title, or the tracked entry's key.
  const nameOf = {};
  for (const s of rep.sources) { s.new_candidates.forEach((c) => { nameOf[c.item_id] = c.title; }); s.material.forEach((m) => { nameOf[m.item_id] = m.entry_key; }); }
  rep.held = rep.held.map((h) => ({ ...h, title: nameOf[h.item_id] || null }));
  rep.changed = rep.totals.entries_updated + rep.totals.entries_added + rep.totals.news_added + rep.totals.links_added + rep.totals.fields_corrected > 0;
  rep.ai_cost = spend ? { calls: spend.calls, input_tokens: spend.input_tokens, output_tokens: spend.output_tokens, cost_usd: spend.cost_usd, unpriced_calls: spend.unpriced_calls, by_step: spend.by_step, by_model: spend.by_model } : { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0, by_step: {}, by_model: {} };
  rep.month = month;
  const ls = rep.sources.find((s) => s.source === 'legiscan');
  rep.legiscan = ls ? { queries_this_run: ls.requests, month_used: ls.month_used, month_cap: ls.month_cap } : null;
  return rep;
}

export function writeReport(rep, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'run-report.json');
  fs.writeFileSync(f, JSON.stringify(rep, null, 1) + '\n');
  return f;
}
