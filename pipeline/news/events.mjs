// The news event model (pipeline/news/CONTRACT.md). Only official structured records create events; a statement (a release: verbatim
// headline + link) only attaches to an event that already exists. Code only, no AI.
//   eventKey(x)                         `${jurisdiction}|${entry_id||'-'}|${class}|${date}`
//   checkItem(item, { now })            why a raw item is refused (bad shape, future date, date after retrieval, host not official), or null
//   upsertItems(state, items, opts)     new events, fact corrections, withdrawals (never a deletion), confirmations; returns what changed
//   attachStatement(state, st)          a release onto the one event it is about (+3 days, the key must agree), or held with why
//   renderNews(news, state, entries)    news.json with automated items appended alongside untouched hand-written items
//   checkNewsEvents({ before, after, state, entries, at })  the stop rules for that render
// State file: pipeline/state/news-events.json { _note, events: { key: Event } }.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EVENT_CLASSES } from './classify.mjs';
import { applyRun, showable } from './confirm.mjs';
import { templateFor, stageOf, nextOf, quoteOf } from './templates.mjs';
import { newsKind } from '../publish/tier-a.mjs';

export const STATEMENT_DAYS = 3;
// Hosts an official record may link to. A raw item whose url is elsewhere is refused.
export const OFFICIAL_HOSTS = /(^|\.)(congress\.gov|courtlistener\.com|federalregister\.gov|govinfo\.gov|regulations\.gov|whitehouse\.gov|nist\.gov|cbo\.gov|legiscan\.com|[a-z]{2}\.gov|state\.[a-z]{2}\.us|legislature\.[a-z.]+|leg\.[a-z.]+|legis\.[a-z.]+|[a-z]+leg\.gov|[a-z]+legislature\.gov|nysenate\.gov|nyassembly\.gov|capitol\.[a-z.]+|gov)$/i;
const DAY = 864e5;
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } };
const dayGap = (a, b) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY;
const sha = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const sortObj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortObj(o[k])])) : Array.isArray(o) ? o.map(sortObj) : o);
export const factsHash = (facts) => sha(sortObj(facts || {}));

// Which source is the official record when several give the same event first time: the body's own record before an aggregator.
export const OFFICIAL_ORDER = ['congress_gov', 'federal_register', 'whitehouse', 'courtlistener', 'nysenate', 'legiscan', 'openstates', 'govinfo'];
const rank = (s) => { const i = OFFICIAL_ORDER.indexOf(s); return i < 0 ? OFFICIAL_ORDER.length : i; };

export const eventKey =(x) => `${x.jurisdiction}|${x.entry_id || '-'}|${x.class}|${x.date}`;

export function emptyState() { return { _note: 'News events (news/events.mjs), from official records only. Never edit by hand; corrections are status changes, never deletions.', events: {} }; }
export function loadEvents(file) {
  if (!file || !fs.existsSync(file)) return emptyState();
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...emptyState(), ...s, events: s.events || {} };
}
export function saveEvents(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(state, null, 1) + '\n'); fs.renameSync(t, file);
}

// A raw item the contract refuses, with why; null when it may be used.
export function checkItem(it, { now = new Date() } = {}) {
  if (!it || typeof it !== 'object') return 'not an object';
  for (const f of ['source', 'source_id', 'jurisdiction', 'date', 'url', 'retrieved_at']) if (!it[f]) return `no ${f}`;
  if (it.class !== null && !EVENT_CLASSES.includes(it.class)) return `class ${it.class} is not in the contract`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date) || Number.isNaN(Date.parse(it.date + 'T00:00:00Z'))) return `date ${it.date} is not YYYY-MM-DD`;
  const today = now.toISOString().slice(0, 10), got = String(it.retrieved_at).slice(0, 10);
  if (it.date > today) return `date ${it.date} is in the future`;
  if (dayGap(got, it.date) > 1) return `date ${it.date} is more than a day after retrieval (${got})`;
  const h = hostOf(it.url);
  if (!h || !OFFICIAL_HOSTS.test(h)) return `url host ${h} is not an official source`;
  return null;
}

const officialSource = (it) => ({ role: 'official', source: it.source, source_id: it.source_id, ...(it.record ? { record: it.record } : {}), url: it.url, title: it.title || null, publisher: null, retrieved_at: it.retrieved_at, hash: sha({ facts: sortObj(it.facts || {}), url: it.url, title: it.title || null }) });
// Several items of one run with one key (two referrals on one day, a House and a Senate line for the same step): one event; the
// official words of each are kept in facts.actions, sorted, so the merged facts are the same every run.
function mergeGroup(items) {
  const xs = [...items].sort((a, b) => JSON.stringify(sortObj(a.facts)).localeCompare(JSON.stringify(sortObj(b.facts))) || a.source_id.localeCompare(b.source_id) || a.url.localeCompare(b.url));
  const first = xs[0];
  const actions = [...new Set(xs.map((x) => x.facts && x.facts.action).filter(Boolean))].sort();
  const facts = { ...first.facts, ...(actions.length > 1 ? { actions } : {}) };
  const seenSrc = new Set(), sources = [];
  for (const x of xs) { const k = `${x.source}|${x.source_id}|${x.url}`; if (!seenSrc.has(k)) { seenSrc.add(k); sources.push(officialSource(x)); } }
  return { first, facts, sources };
}

// state: loaded events; items: RawItem[] from the adapters this run. opts:
//   runId, now, since (YYYY-MM-DD: no new event older than this; existing ones are still corrected or withdrawn),
//   fetched: [{ source, record }] whose full record was read this run (an event of such a record that is no longer in it is withdrawn),
//   okSources: sources whose fetch was ok this run (news/confirm.mjs applyRun).
// This file creates events and records fact corrections; news/confirm.mjs applyRun owns confirmation (stable runs, independent
// confirmations, disagreements) and withdrawal (an item with facts.withdrawn). An event whose record was not read again this run (the
// grabber's cursor says the record did not change, or a docket read only for new entries) is carried into applyRun as unchanged.
// Returns { added, corrected, withdrawn, restored, confirmed, refused: [{ source, source_id, date, why }], report }.
export function upsertItems(state, items, { runId, now = new Date(), since = null, fetched = [], okSources = null } = {}) {
  const at = now.toISOString(), out = { added: [], corrected: [], withdrawn: [], restored: [], confirmed: [], refused: [], report: [] };
  const groups = new Map(), good = [];
  for (const it of items) {
    const why = checkItem(it, { now });
    if (why) { out.refused.push({ source: it && it.source, source_id: it && it.source_id, date: it && it.date, why }); continue; }
    good.push(it);
    const k = eventKey({ ...it, entry_id: it.entry_id || null });
    (groups.get(k) || groups.set(k, []).get(k)).push(it);
  }
  const present = new Set();
  for (const [key, g] of groups) {
    present.add(key);
    const ev = state.events[key];
    // one source is the event's official record (the existing one's, else by OFFICIAL_ORDER); records of other sources with the same key
    // only confirm or disagree (news/confirm.mjs), they never replace it
    const offSrc = ev ? (ev.sources.find((s) => s.role === 'official') || {}).source : [...new Set(g.map((x) => x.source))].sort((a, b) => rank(a) - rank(b))[0];
    const mine = g.filter((x) => x.source === offSrc);
    if (!mine.length) continue;
    const { first, facts, sources } = mergeGroup(mine), fh = factsHash(facts);
    if (!ev) {
      if (since && first.date < since) continue; // history before the window is never back-filled
      state.events[key] = { key, jurisdiction: first.jurisdiction, entry_id: first.entry_id || null, class: first.class, date: first.date, facts, sources,
        status: 'pending', confirmations: [], stable_runs: 0, first_seen: at, last_seen: at, facts_digest: fh,
        history: [{ at, change: 'created', from: null, to: 'pending' }], card: null };
      out.added.push(key);
      continue;
    }
    ev.last_seen = at;
    ev.sources = [...sources, ...ev.sources.filter((s) => s.role !== 'official')]; // statements and confirmations stay
    if (ev.status === 'withdrawn') {
      const to = ev.shown ? 'corrected' : 'pending';
      ev.history.push({ at, change: 'back in the official record', from: 'withdrawn', to });
      ev.status = to; ev.stable_runs = 0; ev.facts = facts; ev.facts_digest = fh; ev.card = null;
      out.restored.push(key);
      continue;
    }
    if (ev.facts_digest !== fh) {
      ev.history.push({ at, change: 'facts', from: ev.facts, to: facts });
      ev.facts = facts; ev.facts_digest = fh; ev.card = null;
      if (ev.status === 'confirmed') { ev.history.push({ at, change: 'status', from: 'confirmed', to: 'corrected' }); ev.status = 'corrected'; out.corrected.push(key); }
    }
  }
  // The items applyRun compares each event's official record against: this run's, plus a carried copy for an event whose record was not
  // read again, plus a withdrawn marker for an event whose record was read in full and no longer shows it.
  const read = new Set(fetched.map((f) => `${f.source}|${f.record}`));
  const runItems = [...good];
  for (const ev of Object.values(state.events)) {
    if (present.has(ev.key) || ev.status === 'withdrawn' || ev.status === 'corrected') continue;
    const off = ev.sources.find((s) => s.role === 'official');
    if (!off) continue;
    const base = { source: off.source, source_id: off.source_id, jurisdiction: ev.jurisdiction, entry_id: ev.entry_id, class: ev.class, date: ev.date, url: off.url, title: off.title, retrieved_at: off.retrieved_at };
    if (off.record && read.has(`${off.source}|${off.record}`)) runItems.push({ ...base, facts: { ...ev.facts, withdrawn: true } });
    else runItems.push({ ...base, facts: ev.facts });
  }
  const before = new Map(Object.values(state.events).map((e) => [e.key, e.status]));
  const r = applyRun(Object.values(state.events), runItems, { at, okSources });
  state.events = Object.fromEntries(r.events.map((e) => [e.key, e]));
  out.report = r.report;
  for (const e of r.events) {
    if (before.get(e.key) !== 'confirmed' && e.status === 'confirmed') out.confirmed.push(e.key);
    if (before.get(e.key) !== 'withdrawn' && e.status === 'withdrawn') { out.withdrawn.push(e.key); if (e.card && e.card.written_by === 'ai') e.card = null; }
  }
  return out;
}

// A statement (a release, by its verbatim headline and link) attaches to the single event it can be about: same jurisdiction and entry,
// a release dated on the event's day or up to STATEMENT_DAYS after it, and the class when the caller names one (classHint). Similarity of
// words may only have suggested the event; the key must agree. Zero or several candidates: held, with why. Returns { attached } | { held }.
export function attachStatement(state, st) {
  if (!st || !st.entry_id || !st.jurisdiction || !st.date || !st.url || !st.title) return { held: 'a statement needs entry, jurisdiction, date, link and headline' };
  const cands = Object.values(state.events).filter((e) => e.class && e.status !== 'withdrawn' && e.jurisdiction === st.jurisdiction && e.entry_id === st.entry_id
    && dayGap(e.date, st.date) >= 0 && dayGap(e.date, st.date) <= STATEMENT_DAYS && (!st.class_hint || e.class === st.class_hint));
  if (!cands.length) return { held: 'no official event for this entry in the 3 days before the release' };
  if (cands.length > 1) return { held: `${cands.length} official events could match (${cands.map((c) => c.class).join(', ')}): not guessed` };
  const ev = cands[0];
  if (!ev.sources.some((s) => s.role === 'statement' && s.url === st.url)) {
    ev.sources.push({ role: 'statement', source: st.source || 'release', source_id: st.source_id || st.url, url: st.url, title: st.title, publisher: st.publisher || null, retrieved_at: st.retrieved_at || null, hash: sha({ url: st.url, title: st.title }) });
    ev.history.push({ at: st.retrieved_at || new Date().toISOString(), change: 'statement', from: null, to: st.url });
  }
  return { attached: ev.key };
}

// ---------- rendering ----------
// An event the page may show: a mapped class, a tracked entry, and confirmed or corrected; a withdrawn event only if it was shown before
// (it then stays, marked withdrawn).
export const visible = (ev) => !!ev.entry_id && (showable(ev) || ((ev.status === 'corrected' || ev.status === 'withdrawn') && !!ev.shown));

// The card: the writer's text (news/writer.mjs) when present, else the template. Template fields are always recomputed.
export function cardFor(ev, entry) {
  const t = templateFor(ev, entry);
  if (!t) return null;
  const c = ev.card || {};
  const ai = c.written_by === 'ai' && c.headline && c.body && c.facts_hash === ev.facts_digest;
  return { headline: ai ? c.headline : t.headline, body: ai ? c.body : t.body, template_headline: t.headline, template_body: t.body, written_by: ai ? 'ai' : 'template', facts_hash: ev.facts_digest };
}

// Stores the template text on every event that has an entry (card.template_headline/template_body: news/writer.mjs falls back to them),
// and the code-computed milestone fact. An AI card stays only while its facts are current.
export function refreshCards(state, entries) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  for (const ev of Object.values(state.events)) {
    const entry = ev.entry_id && byKey.get(ev.entry_id);
    if (!entry || !ev.class) continue;
    const m = milestoneFor(ev, entries);
    if (m && ev.facts.milestone !== m) ev.facts = { ...ev.facts, milestone: m };
    const t = templateFor(ev, entry);
    if (!t) continue;
    const c = ev.card || {};
    const ai = c.written_by === 'ai' && c.facts_hash === ev.facts_digest;
    ev.card = { headline: ai ? c.headline : t.headline, body: ai ? c.body : t.body, template_headline: t.headline, template_body: t.body, written_by: ai ? 'ai' : 'template', facts_hash: ai ? c.facts_hash : ev.facts_digest };
  }
}

// facts.milestone (contract): computed by code from tracker data only, never by AI. For a state law (became-law / executive-signature):
// "the Nth state" among states whose tracked entries in the same section are enacted, ordered by the enactment date in their events.
// null whenever any date is unknown (never guessed).
export function milestoneFor(ev, entries) {
  if (!['became-law', 'executive-signature'].includes(ev.class) || ev.jurisdiction === 'US') return null;
  const me = entries.find((e) => e.key === ev.entry_id);
  if (!me || !me.section || me.level !== 'state') return null;
  const firstBy = new Map();
  for (const e of entries.filter((x) => x.level === 'state' && x.section === me.section && x.status === 'enacted' && x.key !== me.key)) {
    const d = (e.events || []).filter((v) => v.type === 'Signed / enacted' && /^\d{4}-\d{2}-\d{2}$/.test(v.date)).map((v) => v.date).sort()[0];
    if (!d || !e.state) return null;
    if (!firstBy.has(e.state) || d < firstBy.get(e.state)) firstBy.set(e.state, d);
  }
  if (firstBy.has(ev.jurisdiction) && firstBy.get(ev.jurisdiction) <= ev.date) return null; // this state already had one
  const n = [...firstBy.values()].filter((d) => d < ev.date).length + 1;
  const ord = (k) => { const s = ['th', 'st', 'nd', 'rd'], v = k % 100; return k + (s[(v - 20) % 10] || s[v] || s[0]); };
  return `${ord(n)} state with an enacted law in this tracker section (${me.section})`;
}

const fmtDay = (iso) => iso.slice(0, 10);
// One news.json item for one event (backwards compatible; see the contract and the site agent's additions).
export function renderItem(ev, entry, { at } = {}) {
  const card = cardFor(ev, entry);
  if (!card) return null;
  const off = ev.sources.find((s) => s.role === 'official');
  const statements = ev.sources.filter((s) => s.role === 'statement').map((s) => ({ t: s.title, u: s.url, publisher: s.publisher || null }));
  const quote = String(ev.facts.action || ev.facts.text || '').replace(/\s+/g, ' ').trim();
  const corr = ev.history.filter((h) => h.to === 'corrected' || h.to === 'withdrawn').pop();
  let check = card.written_by === 'ai' ? `From the official record (${off ? off.source : 'official'}): written from its fields by the AI writer, every fact checked by code and a second reader.` : `From the official record (${off ? off.source : 'official'}), written by code from its fields; the official words are quoted as recorded.`;
  if (ev.status === 'corrected' && corr) check += ` Correction (${fmtDay(corr.at)}): the official record changed after this item was first published; it now reads as above.`;
  if (ev.status === 'withdrawn' && corr) check += ` Correction (${fmtDay(corr.at)}): the official record no longer shows this action.`;
  const item = {
    date: ev.date, kind: ev.class.startsWith('court-') ? 'litigation' : newsKind(entry),
    title: ev.status === 'withdrawn' ? `Withdrawn: ${card.headline}`.slice(0, 140) : card.headline, body: card.body,
    links: [{ t: `${entry.short_name || entry.title} — official record`, u: off.url }, ...statements.map((s) => ({ t: s.publisher ? `${s.publisher}: ${s.t}` : s.t, u: s.u }))],
    check, tracker: ev.entry_id, origin: 'automated',
    verification: { method: 'official-record', checked_at: at || ev.last_seen },
    evidence: [{ field: 'body', quote: quote.length >= 8 ? quote : String(off.title || quote), source_url: off.url }],
    event_key: ev.key, class: ev.class, status: ev.status, jurisdiction: ev.jurisdiction, statements,
    ...(stageOf(ev) ? { stage: stageOf(ev) } : {}), next: nextOf(ev),
    ...(ev.facts.comments_close ? { comments_close: ev.facts.comments_close } : {}),
    history: ev.history.map((h) => ({ at: h.at, change: h.change, ...(typeof h.from === 'string' || h.from === null ? { from: h.from } : {}), ...(typeof h.to === 'string' || h.to === null ? { to: h.to } : {}) })),
    ...(ev.status === 'corrected' || ev.status === 'withdrawn' ? { status_note: ev.status === 'withdrawn' ? 'The official record no longer shows this action.' : 'Corrected from the official record.' } : {})
  };
  return item;
}

// news: news.json as it is; state: events; entries: the entries list. Items without event_key are never touched, nor reordered.
// Items with event_key are re-rendered in place; new visible events are appended. An event whose entry and date already have an item
// written another way (by hand, or by Lane 1's official-action news) is not added again.
// Returns { news, added: [key], updated: [key], held: [{ key, why }] }.
export function renderNews(news, state, entries, { at } = {}) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const out = { ...news, items: [] }, added = [], updated = [], held = [];
  const onPage = new Set();
  for (const n of news.items) {
    if (!n.event_key) { out.items.push(n); continue; }
    onPage.add(n.event_key);
    const ev = state.events[n.event_key], entry = ev && byKey.get(ev.entry_id);
    const fresh = ev && entry ? renderItem(ev, entry, { at: n.verification && n.verification.checked_at }) : null;
    if (!fresh) { out.items.push(n); held.push({ key: n.event_key, why: 'event or entry missing: item left as it was' }); continue; }
    if (JSON.stringify(fresh) !== JSON.stringify(n)) { fresh.verification.checked_at = at || fresh.verification.checked_at; updated.push(ev.key); }
    out.items.push(fresh);
  }
  const other = new Set(news.items.filter((n) => !n.event_key && n.tracker).map((n) => `${n.tracker}|${n.date}`));
  const evs = Object.values(state.events).filter((e) => visible(e) && !onPage.has(e.key) && e.status !== 'withdrawn').sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  const thisRun = new Set();
  for (const ev of evs) {
    const entry = byKey.get(ev.entry_id);
    if (!entry || entry.section === 'J') { held.push({ key: ev.key, why: 'not a tracked entry' }); continue; }
    if (other.has(`${ev.entry_id}|${ev.date}`)) { held.push({ key: ev.key, why: 'the page already has an item on this entry and date' }); continue; }
    if (thisRun.has(`${ev.entry_id}|${ev.date}`)) { held.push({ key: ev.key, why: 'another event on this entry and date is added this run' }); continue; }
    const item = renderItem(ev, entry, { at });
    if (!item) { held.push({ key: ev.key, why: 'the template needs a fact the record does not give' }); continue; }
    thisRun.add(`${ev.entry_id}|${ev.date}`);
    out.items.push(item); added.push(ev.key);
  }
  return { news: out, added, updated, held };
}

// Marks rendered events as shown (after a successful write), so a later withdrawal stays on the page as a correction.
export function markShown(state, keys, at) { for (const k of keys) if (state.events[k] && !state.events[k].shown) state.events[k].shown = at; }

// The stop rules for an event render: hand-written and Lane 1 items exactly as before and in order; every automated event item exactly
// the render of its event; entries untouched; nothing removed.
export function checkNewsEvents({ before, after, state, entries, at }) {
  const problems = [];
  const plainB = before.news.items.filter((n) => !n.event_key), plainA = after.news.items.filter((n) => !n.event_key);
  if (JSON.stringify(plainB) !== JSON.stringify(plainA)) problems.push('news items not written by the event model changed');
  const keysB = before.news.items.filter((n) => n.event_key).map((n) => n.event_key), keysA = new Set(after.news.items.filter((n) => n.event_key).map((n) => n.event_key));
  keysB.filter((k) => !keysA.has(k)).forEach((k) => problems.push(`news item ${k} was removed (corrections never delete)`));
  const byKey = new Map(entries.map((e) => [e.key, e]));
  for (const n of after.news.items.filter((x) => x.event_key)) {
    const ev = state.events[n.event_key], entry = ev && byKey.get(ev.entry_id);
    if (!ev || !entry) { if (!keysB.includes(n.event_key)) problems.push(`news item ${n.event_key}: no such event or entry`); continue; }
    if (!visible(ev)) problems.push(`news item ${n.event_key}: event is ${ev.status}, not publishable`);
    const want = renderItem(ev, entry, { at: n.verification.checked_at });
    if (JSON.stringify(want) !== JSON.stringify(n)) problems.push(`news item ${n.event_key}: not the render of its event`);
    if (n.origin !== 'automated' || n.verification.method !== 'official-record') problems.push(`news item ${n.event_key}: not marked automated / official-record`);
    if (!n.links.some((l) => n.evidence.every((e) => e.source_url === l.u))) problems.push(`news item ${n.event_key}: evidence is not from its own linked record`);
  }
  if (JSON.stringify(before.entries) !== JSON.stringify(after.entries)) problems.push('entries changed: the news step may not change them');
  return problems;
}
