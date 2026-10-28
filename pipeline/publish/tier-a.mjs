// Tier A: official facts, written by code. For every "material" item on a tracked entry this applies only what the
// official record states exactly: new dated actions (as events and in the status text), a status the record proves
// (became law, vetoed) and the checked / changed dates. It never touches mechanism, thresholds, penalties or any other
// reading field; those are Tier B (AI, behind the accuracy gate). No AI is used here.
// Pure: takes the current data and a run, returns new data plus the change log. Writing and stop rules are elsewhere.
import { longDate } from '../agents/derive.mjs';
import { datesMentioned, COSPONSOR_SUFFIX, cosponsorSuffix, actionKind } from '../compare/congress.mjs';
import { stateActionKind } from '../grabber/sources/legiscan.mjs';
import { statusFor } from '../agents/rules.mjs';

const FULL_MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const clone = (x) => JSON.parse(JSON.stringify(x));
const SOURCE_NAME = { congress_gov: 'Congress.gov', federal_register: 'the Federal Register' };
// State bills: the legislature's own record (found through LegiScan; the link is the legislature's page).
const sourceName = (item, e) => SOURCE_NAME[item.source] || (item.source === 'legiscan' ? `${e.state || 'state'} Legislature` : item.source);
// Only these reason kinds are facts Tier A may write. Anything else is reported and left for a person or Tier B.
const TIER_A = { congress_gov: ['new_action', 'status_change', 'cosponsors_change'], legiscan: ['new_action', 'status_change'] };

export const newsKind = (e) => (e.level === 'state' ? 'state' : e.section === 'G.2' ? 'litigation' : /^G/.test(e.section) && e.section !== 'G.3' ? 'executive' : 'federal');
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().replace(/(?<!\b[a-z]\.[a-z])\.$/i, ''); // keep "4 p.m."
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// The cosponsor total in the stored record (bill.cosponsors.count: current cosponsors; withdrawn ones are not counted). Null when absent.
const recordCosponsors = (raw) => { try { const c = JSON.parse(raw).bill.cosponsors.count; return Number.isInteger(c) ? c : null; } catch { return null; } };

// "2026-09-30: Committee on ... Hearings held."  ->  { date, text }
// "2026-04-16: TN HB1898: Passed House"  ->  { date, text: the official words only, bill: "TN HB1898" (the bill number, when given) }
const actionOf = (reason) => {
  const m = /^(\d{4}-\d{2}-\d{2}):\s*(.+)$/s.exec(reason.detail || '');
  if (!m) return null;
  const text = clean(reason.api_value || m[2]), label = clean(m[2]);
  const bill = label !== text && label.endsWith(text) ? label.slice(0, -text.length).replace(/[\s:]+$/, '') || null : null;
  return { date: m[1], text, bill };
};
// The stored record is JSON, so quotes and slashes in the action text are escaped there.
const inRaw = (raw, t) => raw.includes(t) || raw.includes(JSON.stringify(t).slice(1, -1));

// Each source's own classifier (compare/congress.mjs actionKind, grabber/sources/legiscan.mjs stateActionKind): the event type (null for a
// procedural step), and an importance on one scale (enacted 100 … hearing 40, introduced 30, referred 20, procedural 0).
const kindOf = (text, source) => (source === 'legiscan' ? stateActionKind(text) : actionKind(text));
const typeOf = (text, source) => kindOf(text, source).type;
// A milestone: a hearing or markup and everything above it (reported, passage, failure, veto, override, enactment). Only these get a
// status-text line and a news item; an introduction or a referral is an event only, and a procedural step is not written at all.
const MILESTONE_FROM = 40;
export const isMilestone = (text, source) => { const k = kindOf(text, source); return !!k.type && k.milestone && k.importance >= MILESTONE_FROM; };
// Within one date the most important action takes the date's status line and news item.
export const actionRank = (text, source) => kindOf(text, source).importance;

// The same verb (enrolled, passed, signed, reported, vetoed) on a date within 14 days, already in the status text: said, perhaps on
// another date. Returns that date (ISO) or null.
const VERBS = ['enrolled', 'passed', 'signed', 'reported', 'vetoed'];
const DAY = 86400000;
// An existing event of the same type whose text uses the same verb, on another date within 14 days (an author's "enrolled Sept 1" against
// the record's Sept 8): returns its date, or null.
function nearbyEvent(events, a, type) {
  const verb = VERBS.find((v) => new RegExp(`\\b${v}\\b`, 'i').test(a.text));
  if (!verb || !type) return null;
  const v = (events || []).find((x) => x.type === type && x.date !== a.date && Math.abs(Date.parse(x.date) - Date.parse(a.date)) <= 14 * DAY && new RegExp(`\\b${verb}\\b`, 'i').test(`${x.text} ${x.clause || ''}`));
  return v ? v.date : null;
}
function saidNearby(statusText, a) {
  const verb = VERBS.find((v) => new RegExp(`\\b${v}\\b`, 'i').test(a.text));
  if (!verb) return null;
  for (const clause of String(statusText || '').split(/;|\.\s+(?=[A-Z])/)) {
    if (!new RegExp(`\\b${verb}\\b`, 'i').test(clause)) continue;
    const near = [...datesMentioned(clause, [], +a.date.slice(0, 4))].find((d) => Math.abs(Date.parse(d) - Date.parse(a.date)) <= 14 * DAY);
    if (near) return near;
  }
  return null;
}
// "No action in 11+ months", "no further action since July 30": out of date once a new action is added. Only a whole clause is dropped.
const STALE = /(^|[;,.])\s*no (further )?action (in|for|since)\b[^;.]*/gi;
const dropStale = (t) => String(t || '').replace(STALE, '$1').replace(/^[\s;,.]+/, '').replace(/([;,.])(\s*[;,.])+/g, '$1');
// "...; nine more joined Oct 1-19, 2026, for 12 cosponsors in all": the author's running total in the status text.
const TOTAL_IN_TEXT = /\bfor (\d+) cosponsors? in all\b/g;
// How many bills the entry covers (its own identifiers, or those it is about to get).
const billsOf = (ids) => { const x = (ids && ids.external) || {}; return Math.max((x.congress_gov || []).length, (x.legiscan || []).length); };
// The record's own words for a status: Congress's latest action, or the state history step that proves it.
function statusQuote(item, raw, status) {
  let r; try { r = JSON.parse(raw); } catch { return null; }
  const b = r && r.bill;
  if (!b) return null;
  if (item.source === 'congress_gov') return b.latestAction && b.latestAction.text ? clean(b.latestAction.text) : null;
  const want = status === 'enacted' ? 'Signed / enacted' : 'Vetoed / failed / rescinded';
  const h = (b.history || []).filter((x) => typeOf(x.action, "legiscan") === want).sort((x, y) => String(x.date).localeCompare(String(y.date))).pop();
  return h ? clean(h.action) : null;
}
const OVER_VETO = /\bover (the )?(\w+'s )?veto\b|veto overrid|became public law/i;

export function applyTierA({ data, diff, changeset, readRaw, runId, runDate, config = {}, identifiersFor = () => null }) {
  const out = { entries: clone(data.entries), news: clone(data.news), site: clone(data.site), changes: clone(data.changes || { items: [] }) };
  const byKey = new Map(out.entries.map((e) => [e.key, e]));
  const itemById = new Map(changeset.items.map((i) => [i.item_id, i]));
  const applied = [], skipped = [], log = [], touched = new Set(), disagreements = [];
  const at = runDate + 'T00:00:00Z';
  // "Future" means after the later of the run date and the data's own cut-off (an older run can be replayed onto newer data).
  const cutoff = runDate > data.site.updates_through ? runDate : data.site.updates_through;

  for (const d of diff.items) {
    if (d.verdict !== 'material') continue; // new-bill candidates are the AI step's and Tier B's, which report on them
    const item = itemById.get(d.item_id), e = byKey.get(d.entry_key);
    if (!item || !e) { skipped.push({ item_id: d.item_id, why: 'no matching change-set item or entry (matched by key)' }); continue; }
    const allowed = TIER_A[item.source] || [];
    const raw = readRaw(item); // the exact text fetched at grab time; its hash was checked by the caller
    const name = sourceName(item, e);
    const before = { status: e.status, status_text: e.status_text, events: e.events.length, sponsor_text: e.sponsor_text, facts: JSON.stringify(e.record_facts || null) };
    const notes = [];
    // The bill number is shown only when the entry covers more than one bill. Dates the status text already reaches: an earlier
    // action is back-fill (an event, never a status line or news).
    const multi = billsOf(e.identifiers || identifiersFor(e.key)) > 1;
    const latestSaid = [...datesMentioned(before.status_text, [], +(e.last_checked || runDate).slice(0, 4))].sort().pop() || '';
    const lineDates = new Set(); // one status line and one news item per date: the most important action of that date
    const actionText = (r) => { const a = actionOf(r); return a ? a.text : ''; };
    const reasons = [...d.reasons.filter((r) => r.kind !== 'new_action'), ...d.reasons.filter((r) => r.kind === 'new_action').sort((x, y) => actionRank(actionText(y), item.source) - actionRank(actionText(x), item.source))];

    for (const r of reasons) {
      if (!allowed.includes(r.kind)) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: `${r.kind} is not a Tier A fact: ${r.detail}` }); continue; }
      if (r.kind === 'new_action') {
        const a = actionOf(r);
        if (!a) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: 'new action without a readable date' }); continue; }
        if (!inRaw(raw, a.text)) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: `action text not found in the stored record: ${a.text}` }); continue; }
        const type = typeOf(a.text, item.source), milestone = isMilestone(a.text, item.source); // each source's own rules
        if (!type && !milestone) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: `procedural action, not written: ${a.text}` }); continue; }
        const shown = multi && a.bill ? `${a.bill}: ${a.text}` : a.text;
        // Already said, perhaps in the author's own words: the status text names that date or the words; or the same verb within 14 days in
        // the status text or on an existing event of the same type. Then the dates disagree: that is reported, and nothing is written twice
        // (neither a status line nor a second event).
        const exact = (e.status_text || '').includes(a.text) || datesMentioned(e.status_text, [], +(e.last_checked || runDate).slice(0, 4)).has(a.date);
        const near = exact ? null : saidNearby(e.status_text, a) || nearbyEvent(e.events, a, type);
        if (near) {
          disagreements.push({ entry_key: e.key, date: a.date, said: near, text: a.text, source_url: item.source_url });
          skipped.push({ item_id: d.item_id, entry_key: e.key, why: `disagreement: the record dates "${a.text}" ${longDate(a.date)}, the entry says ${longDate(near)}; not written twice` });
          continue;
        }
        if (type && !e.events.some((v) => v.date === a.date && v.type === type)) {
          e.events.push({ date: a.date, precision: 'day', type, text: cut(shown, 200), clause: a.text, scheduled: a.date > cutoff, source_url: item.source_url });
          log.push({ entry_key: e.key, field: 'events', old: null, new: { date: a.date, type, text: a.text }, date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' });
        }
        (e.evidence = e.evidence || []).push({ field: 'events', quote: a.text, source_url: item.source_url });
        const backfill = a.date < latestSaid;
        const why = !milestone ? 'not a milestone' : backfill ? `earlier than ${longDate(latestSaid)}, the latest date in the status text (back-fill)` : lineDates.has(a.date) ? 'a more important action that day has the line' : near ? 'already said on a nearby date' : null;
        if (why) { notes.push({ date: a.date, text: `${shown} [event only: ${why}]`, quote: a.text, news: false }); continue; }
        lineDates.add(a.date);
        if (!exact) {
          const old = e.status_text, add = `${shown} (${longDate(a.date)}, ${name})`, kept = dropStale(old).replace(/[\s.;]+$/, '');
          e.status_text = kept ? `${kept}; ${add}` : add;
          log.push({ entry_key: e.key, field: 'status_text', old, new: e.status_text, date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' });
        }
        notes.push({ date: a.date, text: shown, quote: a.text, bill: multi ? a.bill : null, news: true });
      }
      if (r.kind === 'cosponsors_change') {
        // A record fact: the total is read from the stored record by code, and written in fixed wording. The hand-written part of the
        // sponsor text is never rewritten: only a fixed-wording end ("; N cosponsors in all (Congress.gov)") is replaced or added.
        const n = recordCosponsors(raw), multiBill = ((e.identifiers && e.identifiers.external && e.identifiers.external.congress_gov) || []).length > 1;
        if (n === null || String(n) !== r.api_value) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: `cosponsor total ${r.api_value} not found in the stored record` }); continue; }
        if (multiBill) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: 'cosponsor total of one bill on an entry that covers several' }); continue; }
        // Never older news over newer: a record fetched before the entry last changed, or older than the stored total, is not applied.
        const fetched = String(item.fetched_at || '').slice(0, 10), asOf = e.record_facts && e.record_facts.cosponsors && e.record_facts.cosponsors.as_of;
        if ((fetched && e.last_changed && fetched < e.last_changed) || (asOf && asOf > runDate)) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: `cosponsor total ${n} is from a record of ${fetched || runDate}, older than the entry (changed ${e.last_changed}${asOf ? `, total as of ${asOf}` : ''})` }); continue; }
        const totals = [...String(e.status_text || '').matchAll(TOTAL_IN_TEXT)].map((x) => x[1]);
        // A falling total means someone withdrew, whom the hand-written text may still name: reported, never written.
        const suffix = COSPONSOR_SUFFIX.exec(String(e.sponsor_text || ''));
        const was = (e.record_facts && e.record_facts.cosponsors && e.record_facts.cosponsors.count) ?? (suffix ? +suffix[1] : totals.length ? +totals[0] : null);
        if (was !== null && n < was) { disagreements.push({ entry_key: e.key, field: 'cosponsors', said: was, record: n, source_url: item.source_url }); skipped.push({ item_id: d.item_id, entry_key: e.key, why: `cosponsor total fell from ${was} to ${n} (a withdrawal): reported, not written` }); continue; }
        if (new Set(totals).size > 1) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: `cosponsor total ${n}: the status text gives more than one total (${totals.join(', ')}); not written` }); continue; }
        const old = e.record_facts && e.record_facts.cosponsors ? clone(e.record_facts.cosponsors) : null;
        if (old && old.count === n && !(totals.length && Number(totals[0]) !== n)) continue;
        if (!old || old.count !== n) {
          e.record_facts = { ...(e.record_facts || {}), cosponsors: { count: n, as_of: runDate, source_url: item.source_url } };
          log.push({ entry_key: e.key, field: 'record_facts.cosponsors', old, new: e.record_facts.cosponsors, date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' });
          // the evidence is the record's own field, as stored ("cosponsors": { "count": N, ... })
          const quote = JSON.stringify({ count: n }, null, 1).slice(2, -2).trim();
          if (inRaw(raw, quote)) (e.evidence = e.evidence || []).push({ field: 'record_facts.cosponsors', quote, source_url: item.source_url });
        }
        // No sponsor text (or nothing hand-written in it): the record fact stands alone, no fixed-wording end is added.
        const oldText = e.sponsor_text, m = COSPONSOR_SUFFIX.exec(oldText || '');
        if (oldText && (!m || Number(m[1]) !== n) && (m ? m.index > 0 : oldText.trim())) {
          e.sponsor_text = (m ? oldText.slice(0, m.index) : oldText.replace(/[\s.;]+$/, '')) + cosponsorSuffix(n);
          log.push({ entry_key: e.key, field: 'sponsor_text', old: oldText, new: e.sponsor_text, date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' });
        }
        // The author's running total in the status text says the same number.
        if (totals.length && Number(totals[0]) !== n) {
          const oldSt = e.status_text;
          e.status_text = oldSt.replace(TOTAL_IN_TEXT, `for ${n} cosponsor${n === 1 ? '' : 's'} in all`);
          log.push({ entry_key: e.key, field: 'status_text', old: oldSt, new: e.status_text, date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' });
        }
      }
      if (r.kind === 'status_change') {
        // The record's status (compare/congress.mjs statusFromAction, compare/legiscan.mjs) through the section's rule: G.3 stays
        // "export", an enacted bill has no status in B, and so on. Then only a change the record's own words prove.
        const api = ['enacted', 'failed'].includes(r.api_value) ? r.api_value : null;
        const next = api && statusFor(e.section, api);
        if (!next || next === e.status) { if (api && !next) skipped.push({ item_id: d.item_id, entry_key: e.key, why: `status ${api}: section ${e.section} has no such status by rule; the action is kept as an event` }); continue; }
        const quote = statusQuote(item, raw, next);
        if (!quote || (item.source === 'congress_gov' && !(next === 'enacted' ? /became public law|signed by president/i : /vetoed/i).test(quote))) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: `status ${next}: the record's own words do not say it${quote ? ` ("${quote}")` : ''}` }); continue; }
        if (e.status === 'failed' && next === 'enacted' && !OVER_VETO.test(quote)) { skipped.push({ item_id: d.item_id, entry_key: e.key, why: `status failed -> enacted only over a veto or as a public law; the record says "${quote}"` }); continue; }
        log.push({ entry_key: e.key, field: 'status', old: e.status, new: next, date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' });
        e.status = next;
        (e.evidence = e.evidence || []).push({ field: 'status', quote, source_url: item.source_url });
      }
    }

    const changed = e.status !== before.status || e.status_text !== before.status_text || e.events.length !== before.events || e.sponsor_text !== before.sponsor_text || JSON.stringify(e.record_facts || null) !== before.facts;
    if (!changed) continue;
    e.events.sort((x, y) => x.date.localeCompare(y.date));
    if (!e.identifiers && identifiersFor(e.key)) e.identifiers = identifiersFor(e.key); // a mixed entry must say how it is found
    if (e.origin === 'authored') { log.push({ entry_key: e.key, field: 'origin', old: 'authored', new: 'mixed', date: runDate, run_id: runId, source_url: item.source_url, tier: 'A' }); e.origin = 'mixed'; }
    e.verification = { method: 'agent', checked_at: at, run_id: runId, rounds: 0 };
    e.last_checked = runDate; e.last_changed = runDate;
    touched.add(e.key);
    applied.push({ item_id: d.item_id, entry_key: e.key, actions: notes.map(({ date, text }) => ({ date, text })), status: e.status !== before.status ? `${before.status} -> ${e.status}` : null, ...(JSON.stringify(e.record_facts || null) !== before.facts ? { cosponsors: e.record_facts.cosponsors.count } : {}) });

    // News: milestones only, never back-fill; the title is the short name and the official words (the bill number is not repeated);
    // the body quotes the official words only, with the bill number outside the quotes when the entry covers several bills.
    if (config.news_from_official_actions !== false) for (const n of notes.filter((x) => x.news && !out.news.items.some((y) => y.tracker === e.key && y.date === x.date))) {
      out.news.items.push({
        date: n.date, kind: newsKind(e), title: cut(`${e.short_name}: ${n.quote}`, 140),
        body: `${name} records this action on ${e.title}${n.bill ? ` (${n.bill})` : ''}: "${n.quote}" (${longDate(n.date)}).`,
        links: [{ t: `${e.short_name} on ${name}`, u: item.source_url }],
        check: `From the official record (${name}), copied word for word by code; no AI was used.`,
        tracker: e.key, origin: 'automated', verification: { method: 'agent', checked_at: at, run_id: runId, rounds: 0 },
        evidence: [{ field: 'body', quote: n.quote, source_url: item.source_url }]
      });
    }
  }

  if (touched.size) { advanceCutoff(out, runDate); out.changes.items.push(...log); }
  return { data: out, applied, skipped, touched: [...touched], log, disagreements };
}

// The cut-off moves to the run date, so every event's "scheduled" flag is recomputed against it.
export function advanceCutoff(out, runDate) {
  if (runDate > out.site.updates_through) out.site.updates_through = runDate;
  for (const e of out.entries) for (const v of e.events) if (v.scheduled !== undefined || v.date > out.site.updates_through) v.scheduled = v.date > out.site.updates_through;
  out.news.items.sort((a, b) => a.date.localeCompare(b.date));
  const [y, m, dd] = out.site.updates_through.split('-').map(Number);
  out.news.asof = `${FULL_MONTH[m - 1]} ${dd}, ${y}`; // never moves back when an older run is replayed
}
