// The lawsuit step of update.mjs (owner, 26 Nov 2026): open news leads (news/open-leads.mjs) that are an official release announcing a
// lawsuit about frontier AI become G.2 litigation entries (agents/lawsuit.mjs). Each lead is read once: its outcome is remembered in
// state/lawsuits.json, so no AI is spent on it again; a lead that could not be read is tried again on later runs (at most MAX_TRIES).
// Entries are added only when auto_publish.lawsuits is on (its gate: eval/lawsuits-set.mjs at zero wrong); while off, no AI is spent and
// the report counts the leads that wait. Every added entry goes through the publish guards (checkPublish, checkNewEntry); the open lead
// is then covered by the entry's link to the release (news/open-leads.mjs coveredBy).
//   lawsuitsRun({ http, factory | writer + reviewer, aiOff, dataDir, leadsFile, stateFile, config, now, runId, dry, log })
import fs from 'fs';
import path from 'path';
import { isLawsuitLead, officialOf, writeLawsuit, lawsuitEntry } from '../agents/lawsuit.mjs';
import { htmlToText } from '../grabber/lib/text.mjs';
import { HttpError, NetworkError, QuotaExceeded } from '../grabber/lib/http.mjs';
import { checkPublish } from './guards.mjs';
import { advanceCutoff } from './tier-a.mjs';
import { loadData, writeData } from './run.mjs';

export const MAX_PER_RUN = 2, MAX_TRIES = 3;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// The leads to read: open, official (a host in agents/lawsuit.mjs OFFICIAL), announcing a lawsuit, not yet settled in our state.
export function lawsuitLeads(register, state) {
  return Object.values((register && register.items) || {}).filter((l) => l && l.link && officialOf(l.link) && isLawsuitLead(l))
    .filter((l) => { const s = state.items[l.key]; return !s || (s.outcome === 'unread' && (s.tries || 0) < MAX_TRIES); })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

export async function lawsuitsRun({ http, writer = null, reviewer = null, factory = null, aiOff = false, dataDir, leadsFile, stateFile, config = {}, now = new Date(), runId, dry = false, log = () => {} }) {
  const today = now.toISOString().slice(0, 10), at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const state = readJson(stateFile, null) || { _note: 'Lawsuit leads already read (publish/lawsuits.mjs): each is read once. Do not edit by hand.', items: {} };
  const leads = lawsuitLeads(readJson(leadsFile, { items: {} }), state);
  const on = !!(config.auto_publish && config.auto_publish.lawsuits);
  const res = { status: 'quiet', waiting: leads.length, read: [], added: [], held: [], out_of_scope: [], errors: [], summary: '', changed: [] };
  if (!leads.length) return res;
  if (!on) { res.skipped_why = 'auto_publish.lawsuits is off'; return res; }
  // the models are made only when there is a release to read (no AI is touched otherwise)
  if (!writer && factory && !aiOff) { writer = factory.make('writer'); reviewer = factory.make('bill_reviewer'); }
  if (!writer || !reviewer) { res.skipped_why = aiOff || 'no AI (cap reached or no key)'; return res; }
  const before = loadData(dataDir);
  let data = JSON.parse(JSON.stringify(before)), nextId = Math.max(...before.entries.map((e) => Number(e.id) || 0)) + 1;
  for (const l of leads.slice(0, MAX_PER_RUN)) {
    const off = officialOf(l.link);
    let text;
    try { const r = await http.getText(l.link); text = htmlToText(typeof r === 'string' ? r : r.text || ''); }
    catch (e) {
      if (!(e instanceof HttpError || e instanceof NetworkError || e instanceof QuotaExceeded)) throw e;
      const s = state.items[l.key] || { tries: 0 }; state.items[l.key] = { outcome: 'unread', tries: (s.tries || 0) + 1, at: today, why: String(e.message).slice(0, 120) };
      res.errors.push(`${l.title}: ${String(e.message).slice(0, 100)}`); continue;
    }
    const release = { url: l.link, title: l.title, publisher: off.publisher, date: l.date || today, text: text.slice(0, 60000) };
    res.read.push(l.key);
    const w = await writeLawsuit({ writer, reviewer, release, itemId: `lawsuit:${l.key}`, log });
    if (w.decision === 'out_of_scope') { state.items[l.key] = { outcome: 'out_of_scope', at: today, why: String(w.reason).slice(0, 200) }; res.out_of_scope.push({ title: l.title, why: w.reason }); continue; }
    if (w.decision !== 'publishable') { state.items[l.key] = { outcome: 'held', at: today, why: String(w.reason).slice(0, 240) }; res.held.push({ title: l.title, url: l.link, why: w.reason }); continue; }
    const e = lawsuitEntry({ out: w.out, release, today, runId, at, id: nextId });
    if (data.entries.some((x) => x.key === e.key) || data.entries.some((x) => (x.sources || []).some((s) => s.url === release.url))) { state.items[l.key] = { outcome: 'covered', at: today, why: 'an entry already links this release' }; continue; }
    const trial = JSON.parse(JSON.stringify(data)); trial.entries.push(e); advanceCutoff(trial, today);
    trial.changes.items.push({ entry_key: e.key, field: 'entry', old: null, new: { title: e.title, section: e.section, status: e.status }, note: 'new entry from an official release; written by the AI writer, checked by code and an independent reviewer (publish/lawsuits.mjs)', date: today, run_id: runId, source_url: release.url, tier: 'B' });
    const check = checkPublish({ before, after: { ...trial, relationships: before.relationships }, runDate: today, maxEntries: config.max_entries_changed_per_run ?? 15, maxNew: config.max_new_entries_per_run ?? 0, newKeys: [...res.added.map((x) => x.entry_key), e.key] });
    if (check.problems.length) { state.items[l.key] = { outcome: 'held', at: today, why: `a publish check failed: ${check.problems[0]}`.slice(0, 240) }; res.held.push({ title: l.title, url: l.link, why: check.problems[0] }); continue; }
    data = trial; nextId++;
    state.items[l.key] = { outcome: 'added', at: today, entry_key: e.key };
    res.added.push({ entry_key: e.key, title: e.title, url: release.url });
  }
  if (res.added.length && !dry) { writeData(dataDir, { ...data, relationships: before.relationships }, ['entries', 'news', 'site', 'changes']); res.status = 'written'; res.changed = res.added.map((x) => x.entry_key); }
  else if (res.added.length) res.status = 'dry-run';
  if (!dry) { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); const t = stateFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(state, null, 1) + '\n'); fs.renameSync(t, stateFile); }
  res.summary = `Lawsuits: ${res.read.length} release(s) read, ${res.added.length} entr${res.added.length === 1 ? 'y' : 'ies'} added${res.added.length ? ': ' + res.added.map((x) => x.title).join('; ') : ''}`;
  log(res.summary);
  return res;
}
