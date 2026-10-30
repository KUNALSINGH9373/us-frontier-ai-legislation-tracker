// Tier B: new entries. A bill or order the tracker does not have yet, drafted by the agents and marked "publishable" (every code check
// passed and the independent reader supported every claim), is added here after the publisher's own checks, run again on the stored
// record: the bill is not already tracked, the entry follows the section rules, and every evidence quote is in the record word for word.
// What the record states exactly (title, sponsor, dates, status) was written by code in agents/assemble.mjs; the reading fields came
// from the AI, each with its quote. Off until config auto_publish.new_entries is switched on (the accuracy bar); a run never adds
// more than max_new_entries_per_run, and the rest wait for the next run. No AI is used here.
// Pure: takes the current data (after Tier A) and the agents' drafts, returns new data plus the change log.
import { longDate, stateStatus } from '../agents/derive.mjs';
import { statusFor } from '../agents/rules.mjs';
import { sourceText, containsQuote } from '../agents/source-text.mjs';
import { statusFromAction } from '../compare/congress.mjs';
import { checkNewEntry } from './guards.mjs';
import { EVENT_RANK } from './status-rules.mjs';
import { checkDuties } from '../duties/check.mjs';
import { sha } from '../grabber/lib/run-common.mjs';
import { newsKind, advanceCutoff } from './tier-a.mjs';
import { trackerIndex, duplicateOf, relatedUnread, idsOf, programmeDuplicateOf, refileOf, companionOf, textKey } from '../agents/dedupe.mjs';
import { recordRefusals, measureKind, federalRefusals } from '../agents/record-kind.mjs';
import { DUTY_REQUIRED_SECTIONS } from '../agents/duties.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
// The status the record itself gives, worked out as agents/assemble.mjs does it.
const recordStatus = (e, item, raw) => statusFor(e.section, item.source === 'congress_gov' && raw.bill && raw.bill.latestAction ? statusFromAction(raw.bill.latestAction.text) : item.source === 'legiscan' ? stateStatus(raw.bill) : 'pending');
// Duplicates are found by agents/dedupe.mjs: every id and every bill number an entry holds, at any level (J and "none" entries too),
// LegiScan's links between bills (companions, other-chamber twins, the bill an amendment was folded into), Congress.gov "Identical bill"
// related bills, and a state bill whose text names a tracked bill. A match is never created.
export { idsOf };

// The facts a state entry takes from its LegiScan record, checked again against the stored record: the state, the session and the bill id.
function stateProblems(e, item, raw) {
  const b = raw.bill || {}, x = (e.identifiers && e.identifiers.external) || {}, out = [];
  if (e.jurisdiction !== b.state || e.state !== b.state) out.push(`jurisdiction/state ${e.jurisdiction}/${e.state} are not the record's state (${b.state})`);
  if (!(x.legiscan || []).includes(Number(item.source_id))) out.push(`not tracked by its LegiScan id ${item.source_id}`);
  const session = (e.identifiers || {}).session;
  if (!b.session || session !== b.session.session_name) out.push(`session "${session}" is not the record's (${b.session && b.session.session_name})`);
  return out;
}

// The "added to the tracker" news item, in fixed wording, dated the day it is added and describing the bill's CURRENT status as the record
// gives it (an enacted bill is reported as enacted, never as a backdated "introduced" item; round 2 audit, CT H.B. 5222).
// The current status is the latest event, the most important one on that date; the introduction is named after it.
const STATUS_WORDS = { 'Signed / enacted': ['enacted', 'was enacted'], 'Vetoed / failed / rescinded': ['vetoed or failed', 'was vetoed or failed'], 'Passed / advanced': ['advanced', 'advanced'], Effective: ['in effect', 'took effect'], 'Referred / stalled / hearing': ['in committee', 'was last in committee'], 'Introduced / published': ['introduced', 'was introduced'] };
export function currentStatusEvent(events = []) {
  return [...events].filter((v) => EVENT_RANK[v.type] && !v.scheduled).sort((a, b) => b.date.localeCompare(a.date) || EVENT_RANK[b.type] - EVENT_RANK[a.type])[0] || null;
}
// "General Law Committee" -> "the General Law Committee"; a person's name is left as it is.
const sponsorPhrase = (s) => (/^(?:the\s|Rep\.|Sen\.|Del\.|Asm\.|Assembly|President|Resident)/.test(s) || !/\b(?:committee|commission|caucus)\b/i.test(s) ? s : `the ${s}`);
const plain = (s) => String(s || '').trim().replace(/[\s.;:,]+$/, '');
export function newsFor(e, item, raw, runId, at, runDate = at.slice(0, 10)) {
  const first = e.events.find((v) => v.type === 'Introduced / published');
  if (!first) return null;
  // A state bill links the legislature's own page and names it as Tier A does ("CA Legislature").
  const fr = item.source === 'federal_register', st = item.source === 'legiscan', name = fr ? 'the Federal Register' : st ? `${e.state} Legislature` : 'Congress.gov';
  const official = fr ? raw.document && raw.document.title : raw.bill && raw.bill.title;
  const now = currentStatusEvent(e.events) || first, [label, verb] = STATUS_WORDS[now.type];
  // "H.B. 5222 — An Act ... Established." reads as "H.B. 5222 ("An Act ... Established")", so the official title never runs into the verb.
  const parts = String(e.title).split(' — '), what = parts.length > 1 ? `${parts[0]} ("${plain(parts.slice(1).join(' — '))}")` : plain(e.title), intro = now === first ? '' : ` It was introduced on ${longDate(first.date)}.`;
  const sponsor = e.sponsor_text ? ` It is sponsored by ${sponsorPhrase(plain(e.sponsor_text))}.` : '';
  const said = now === first ? '' : ` ("${plain(now.text)}")`;
  return {
    date: runDate, kind: newsKind(e), title: cut(`${e.short_name}: ${fr ? 'published in the Federal Register' : label}`, 140),
    body: fr ? `The Federal Register published ${what} on ${longDate(first.date)}.` : `As of ${longDate(runDate)}, ${st ? `the ${name}` : name} records that ${what} ${verb} on ${longDate(now.date)}${said}.${intro}${sponsor}`,
    links: [{ t: `${e.short_name} on ${fr ? 'the Federal Register' : st ? `the ${name} site` : 'Congress.gov'}`, u: item.source_url }],
    check: `From the official record (${name}), written by code in fixed wording; no AI was used for this item.`,
    tracker: e.key, origin: 'automated', verification: { method: 'agent', checked_at: at, run_id: runId, rounds: 0 },
    evidence: official ? [{ field: 'body', quote: official, source_url: item.source_url }] : []
  };
}

// A new state bill as config/identifiers-legiscan.json lists a confirmed mapping (the shape grabber/map-ids-legiscan.mjs writes), so the
// LegiScan grabber watches it from the next run on.
export function legiscanBill(b, runDate) {
  const s = b.session || {};
  return { bill_id: b.bill_id, number: b.bill_number, state: b.state, session_id: b.session_id, session_name: s.session_name, official_url: b.state_link || b.url, legiscan_url: b.url, year_end: s.year_end, session_open: s.year_end >= +runDate.slice(0, 4) };
}

// drafts: the agents' results for this run (results/<item>.json); itemById: the change-set items; readRaw(item): the stored record, parsed.
// tracked: item ids already watched outside the entries (config/identifiers-legiscan.json), so a tracked state bill is never added again.
export function applyTierB({ data, drafts, itemById, readRaw, runId, runDate, config = {}, tracked = [] }) {
  const out = { entries: clone(data.entries), news: clone(data.news), site: clone(data.site), changes: clone(data.changes || { items: [] }) };
  const added = [], skipped = [], log = [];
  const ready = drafts.filter((r) => r.outcome === 'publishable' && r.operation === 'create' && r.entry);
  if (!ready.length) return { data: out, added, skipped, log };
  if (!(config.auto_publish && config.auto_publish.new_entries)) {
    ready.forEach((r) => skipped.push({ item_id: r.item_id, why: 'ready; new-bill publishing is switched off' }));
    return { data: out, added, skipped, log };
  }
  const cap = config.max_new_entries_per_run ?? 0, at = runDate + 'T00:00:00Z';
  const idx = trackerIndex(out.entries, tracked), seenThisRun = [];

  for (const r of ready) {
    const skip = (why) => skipped.push({ item_id: r.item_id, why });
    if (added.length >= cap) { skip(`over the limit of ${cap} new entries per run; added on a later run`); continue; }
    const item = itemById.get(r.item_id);
    if (!item) { skip('no matching change-set item'); continue; }
    const e = clone(r.entry), raw = readRaw(item), text = sourceText(raw, item.source);
    const dup = duplicateOf({ item, raw, idx });
    if (dup) { skip(`${dup.why}${dup.key && !dup.key.startsWith('(') ? ` (entry ${dup.key})` : ''}; not created`); continue; }
    const unread = relatedUnread(item, raw);
    if (unread) { skip(`${unread}; not created`); continue; }
    // The same programme as a tracked entry of its state under another bill (agents/dedupe.mjs programmeDuplicateOf): never created.
    const prog = item.source === 'legiscan' ? programmeDuplicateOf(e, out.entries) : null;
    if (prog) { skip(`${prog.why} (entry ${prog.key}); not created`); continue; }
    // Round 3: a refile or companion of a tracked entry with no record link (its description nearly the same), and a companion or the
    // same text added earlier in this run (agents/dedupe.mjs refileOf, companionOf).
    const refile = refileOf(e, out.entries);
    if (refile) { skip(`${refile.why} (entry ${refile.key}); not created`); continue; }
    const twin = companionOf(raw, seenThisRun);
    if (twin) { skip(`${twin.why} (entry ${twin.key}); not created`); continue; }
    const refused = item.source === 'legiscan' ? recordRefusals(raw) : item.source === 'congress_gov' ? federalRefusals(item, raw) : [];
    if (refused.length) { skip('not created: ' + refused.join('; ')); continue; }
    const ctx = { ...(item.source === 'legiscan' ? { kind: measureKind(raw.bill, raw.text), text: raw.text || '' } : {}), source: text };
    const problems = [...checkNewEntry(e, ctx), ...(item.source === 'legiscan' ? stateProblems(e, item, raw) : []), ...(e.evidence || []).filter((x) => !containsQuote(text, x.quote)).map((x) => `the quote for ${x.field} is not in the stored record: "${cut(String(x.quote || ''), 60)}"`)];
    // An A or B entry (a frontier law or bill) goes out only with its duty answers, proved against this record.
    if (DUTY_REQUIRED_SECTIONS.includes(e.section) && (item.source === 'legiscan' || item.source === 'congress_gov') && !e.duties) problems.push(`a section ${e.section} entry needs its duty answers, and the duty step did not prove them`);
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
    idx.add(e);
    seenThisRun.push({ key: e.key, label: e.short_name || e.key, text: String(raw.text || ''), textKey: textKey(raw.text) });
    log.push({ entry_key: e.key, field: 'entry', old: null, new: { title: e.title, section: e.section, status: e.status }, date: runDate, run_id: runId, source_url: item.source_url, tier: 'B', note: 'new entry; reading fields written by the AI with quotes checked by code' });

    const n = config.news_from_official_actions !== false && newsFor(e, item, raw, runId, at);
    if (n) out.news.items.push(n);
    added.push({ item_id: r.item_id, entry_key: e.key, short_name: e.short_name, section: e.section, news: !!n, ...(item.source === 'legiscan' ? { legiscan: legiscanBill(raw.bill, runDate) } : {}) });
  }

  if (added.length) { advanceCutoff(out, runDate); out.changes.items.push(...log); }
  return { data: out, added, skipped, log };
}
