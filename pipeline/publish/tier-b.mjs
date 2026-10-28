// Tier B: new entries. A bill or order the tracker does not have yet, drafted by the agents and marked "publishable" (every code check
// passed and the independent reader supported every claim), is added here after the publisher's own checks, run again on the stored
// record: the bill is not already tracked, the entry follows the section rules, and every evidence quote is in the record word for word.
// What the record states exactly (title, sponsor, dates, status) was written by code in agents/assemble.mjs; the reading fields came
// from the AI, each with its quote. Off until config auto_publish.new_entries is switched on (the accuracy bar); a run never adds
// more than max_new_entries_per_run, and the rest wait for the next run. No AI is used here.
// Pure: takes the current data (after Tier A) and the agents' drafts, returns new data plus the change log.
import { longDate } from '../agents/derive.mjs';
import { statusFor } from '../agents/rules.mjs';
import { sourceText, containsQuote } from '../agents/source-text.mjs';
import { statusFromAction } from '../compare/congress.mjs';
import { checkNewEntry } from './guards.mjs';
import { checkDuties } from '../duties/check.mjs';
import { sha } from '../grabber/lib/run-common.mjs';
import { newsKind, advanceCutoff } from './tier-a.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
// The status the record itself gives, worked out as agents/assemble.mjs does it.
const recordStatus = (e, item, raw) => statusFor(e.section, item.source === 'congress_gov' && raw.bill && raw.bill.latestAction ? statusFromAction(raw.bill.latestAction.text) : 'pending');
// Every record an entry is tracked by, in the item_id form the grabber uses.
const idsOf = (e) => { const x = (e.identifiers && e.identifiers.external) || {}; return [...(x.congress_gov || []).map((i) => 'congress_gov:' + i), ...(x.federal_register_doc ? ['federal_register:' + x.federal_register_doc] : [])]; };

// The "added to the tracker" news item, in fixed wording. Its date is the day the record gives for introduction or publication.
function newsFor(e, item, raw, runId, at) {
  const first = e.events.find((v) => v.type === 'Introduced / published');
  if (!first) return null;
  const fr = item.source === 'federal_register', name = fr ? 'the Federal Register' : 'Congress.gov';
  const official = fr ? raw.document && raw.document.title : raw.bill && raw.bill.title;
  return {
    date: first.date, kind: newsKind(e), title: cut(`${e.short_name}: ${fr ? 'published in the Federal Register' : 'introduced'}`, 140),
    body: fr ? `The Federal Register published ${e.title} on ${longDate(first.date)}.` : `Congress.gov records that ${e.title} was introduced on ${longDate(first.date)}${e.sponsor_text ? `, sponsored by ${e.sponsor_text}` : ''}.`,
    links: [{ t: `${e.short_name} on ${fr ? 'the Federal Register' : 'Congress.gov'}`, u: item.source_url }],
    check: `From the official record (${name}), written by code in fixed wording; no AI was used for this item.`,
    tracker: e.key, origin: 'automated', verification: { method: 'agent', checked_at: at, run_id: runId, rounds: 0 },
    evidence: official ? [{ field: 'body', quote: official, source_url: item.source_url }] : []
  };
}

// drafts: the agents' results for this run (results/<item>.json); itemById: the change-set items; readRaw(item): the stored record, parsed.
export function applyTierB({ data, drafts, itemById, readRaw, runId, runDate, config = {} }) {
  const out = { entries: clone(data.entries), news: clone(data.news), site: clone(data.site), changes: clone(data.changes || { items: [] }) };
  const added = [], skipped = [], log = [];
  const ready = drafts.filter((r) => r.outcome === 'publishable' && r.operation === 'create' && r.entry);
  if (!ready.length) return { data: out, added, skipped, log };
  if (!(config.auto_publish && config.auto_publish.new_entries)) {
    ready.forEach((r) => skipped.push({ item_id: r.item_id, why: 'ready; new-bill publishing is switched off' }));
    return { data: out, added, skipped, log };
  }
  const cap = config.max_new_entries_per_run ?? 0, at = runDate + 'T00:00:00Z';
  const known = new Set(out.entries.flatMap(idsOf));

  for (const r of ready) {
    const skip = (why) => skipped.push({ item_id: r.item_id, why });
    if (added.length >= cap) { skip(`over the limit of ${cap} new entries per run; added on a later run`); continue; }
    const item = itemById.get(r.item_id);
    if (!item) { skip('no matching change-set item'); continue; }
    if (known.has(r.item_id)) { skip('already tracked'); continue; }
    const e = clone(r.entry), raw = readRaw(item), text = sourceText(raw, item.source);
    const problems = [...checkNewEntry(e), ...(e.evidence || []).filter((x) => !containsQuote(text, x.quote)).map((x) => `the quote for ${x.field} is not in the stored record: "${cut(String(x.quote || ''), 60)}"`)];
    if (e.status !== recordStatus(e, item, raw)) problems.push(`status ${e.status} is not what the record gives (${recordStatus(e, item, raw)})`);
    // Duties, when the agents wrote them: read from this very record (same URL, same text hash) and every answer passes duties/check.mjs again.
    if (e.duties && e.duties_basis) {
      if (e.duties_basis.source_url !== item.source_url) problems.push(`duties were read from ${e.duties_basis.source_url}, not this record`);
      if (e.duties_basis.sha256 !== sha(text)) problems.push('duties were read from a different text than the stored record (hash differs)');
      checkDuties(e.duties, text, { sourceUrl: item.source_url }).forEach((p) => problems.push('duty ' + p));
    }
    if (problems.length) { skip('not proved: ' + problems.join('; ')); continue; }

    // Numbered against the data as it is now: the agents numbered each draft on its own, so two drafts in one run can share an id or key.
    e.id = out.entries.reduce((m, x) => Math.max(m, x.id), 0) + 1;
    if (out.entries.some((x) => x.key === e.key)) e.key = `${e.key}-${e.id}`;
    e.last_checked = runDate; e.last_changed = runDate;
    e.verification = { ...e.verification, run_id: runId };
    out.entries.push(e);
    idsOf(e).forEach((id) => known.add(id));
    log.push({ entry_key: e.key, field: 'entry', old: null, new: { title: e.title, section: e.section, status: e.status }, date: runDate, run_id: runId, source_url: item.source_url, tier: 'B', note: 'new entry; reading fields written by the AI with quotes checked by code' });

    const n = config.news_from_official_actions !== false && newsFor(e, item, raw, runId, at);
    if (n) out.news.items.push(n);
    added.push({ item_id: r.item_id, entry_key: e.key, short_name: e.short_name, section: e.section, news: !!n });
  }

  if (added.length) { advanceCutoff(out, runDate); out.changes.items.push(...log); }
  return { data: out, added, skipped, log };
}
