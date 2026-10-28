// Stop rules for a publish. Any problem means nothing is written: with no human reviewer, an odd-looking run is
// stopped, not published. Each check returns readable problems; empty means the run may be written.
import { makeValidator } from '../schema/validate.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { SECTION_RULES, AUTO_CREATE_SECTIONS, statusFor, NEGATIVE_FINDING, stateSectionProblems } from '../agents/rules.mjs';
import { FACT_FIELDS } from '../agents/checks.mjs';
import { COSPONSOR_SUFFIX, cosponsorSuffix } from '../compare/congress.mjs';
import { containsQuote } from '../agents/source-text.mjs';
import { trackerUrl, ENTRY_FIELDS, edgeShapeProblem } from '../links/rules.mjs';
import { linkKey } from '../news/feeds.mjs';

// Fields only a reading of the text can supply. On a new entry each one that is filled needs a quote from the record.
export const READING_FIELDS = ['mechanism', 'thresholds', 'penalties'];

// The stricter path for a new entry (Tier B): everything the rules decide must match the rules, and every reading field
// must carry evidence. The quotes themselves are checked against the stored record in tier-b.mjs, which can read it.
// ctx (optional, from tier-b.mjs, which holds the stored record): { kind } the measure's kind (agents/record-kind.mjs measureKind) and
// { text } the record's text; with them the section is checked against the kind of measure and, for A, against the enacted text.
export function checkNewEntry(e, ctx = {}) {
  const problems = [], rule = SECTION_RULES[e.section];
  if (rule && rule.level === 'state') stateSectionProblems(e.section, ctx.kind || null, ctx.text != null ? ctx.text : null).forEach((p) => problems.push(p));
  // A resolution or memorial named as one in its own title ("H.R. 6023 — Opposing ...", "S.C.R. 14", "A RESOLUTION") is never A, B or B.2.
  if (['A', 'B', 'B.2'].includes(e.section) && /^(?:[HSA]\.\s?(?:[CJ]\.\s?)?[RM]\.\s?\d|[HSA](?:C|J)?[RM]\s?\d)/.test(String(e.title || '')) && !(ctx.kind === 'bill')) problems.push(`"${String(e.title).slice(0, 30)}" is numbered as a resolution or memorial, which never goes in section ${e.section}`);
  // Events: none that contradicts the status, and no day with the same event twice.
  const ev = e.events || [];
  if (['pending', 'failed', 'stalled'].includes(e.status)) ev.filter((x) => x.type === 'Signed / enacted' || x.type === 'Effective').forEach((x) => problems.push(`a ${e.status} bill has a "${x.type}" event (${x.date})`));
  if (e.status === 'failed') ev.filter((x) => x.scheduled).forEach((x) => problems.push(`a failed bill has a scheduled event (${x.date}: ${String(x.text).slice(0, 60)})`));
  const seen = new Set();
  for (const x of ev) { const k = `${x.date}|${String(x.text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`; if (seen.has(k)) problems.push(`the same event is listed twice on ${x.date} ("${String(x.text).slice(0, 60)}")`); seen.add(k); }
  if (!AUTO_CREATE_SECTIONS.includes(e.section)) problems.push(`section ${e.section} needs a person`);
  else if (e.type !== rule.type || e.level !== rule.level) problems.push(`type/level ${e.type}/${e.level} do not follow the rule for section ${e.section}`);
  if (e.status !== statusFor(e.section, e.status)) problems.push(`status ${e.status} does not follow the rule for section ${e.section}`);
  // A state entry (the four state sections the pipeline may create in) is on its state's tile and tracked by its LegiScan record and session,
  // so the grabber keeps it current; a federal one is on no state tile. tier-b.mjs checks these against the stored record too.
  if (rule && rule.level === 'state') {
    const x = (e.identifiers && e.identifiers.external) || {};
    if (!/^[A-Z]{2}$/.test(e.state || '') || e.jurisdiction !== e.state) problems.push(`a state entry needs its two-letter state as both jurisdiction and state (has ${e.jurisdiction}/${e.state})`);
    if (!(x.legiscan || []).length || !e.identifiers.session) problems.push('a new state entry needs its LegiScan id and session in identifiers');
  } else if (rule && rule.level === 'federal' && (e.jurisdiction !== 'Federal' || e.state != null)) problems.push(`a federal entry has jurisdiction Federal and no state (has ${e.jurisdiction}/${e.state})`);
  if (e.origin !== 'automated' || !e.verification || e.verification.method !== 'agent') problems.push('not marked as written and checked by the pipeline');
  READING_FIELDS.filter((f) => e[f] && !(e.evidence || []).some((x) => x.field === f && x.quote)).forEach((f) => problems.push(`no evidence quote for ${f}`));
  FACT_FIELDS.filter((f) => e[f] && NEGATIVE_FINDING.test(e[f])).forEach((f) => problems.push(`${f} states a search finding ("none located"), which only a person may write`));
  // Duties on a new entry come only from the agents' duty step, with the text they were read from (tier-b.mjs re-checks them against it).
  if (e.duties && !(e.duties_basis && e.duties_basis.method === 'agent')) problems.push('duties without a duties_basis from the pipeline (method agent)');
  if (!e.duties && e.duties_basis) problems.push('duties_basis without duties');
  if (e.duties && e.duties_basis && e.sources && !e.sources.some((s) => s.url === e.duties_basis.source_url)) problems.push(`duties read from ${e.duties_basis.source_url}, which is not one of the entry's sources`);
  return problems;
}

// The stricter path for news items written from official releases (news/run.mjs): the run may only ADD the items it drafted and
// checked; each must be automated, carry evidence from its release, and say how it was checked. Existing items, entries,
// links and the change log are covered by checkPublish, which runs too.
export function checkNewsAdded({ before, after, expected, checkLine }) {
  const problems = [];
  const old = new Set(before.news.items.map((x) => JSON.stringify(x))), want = new Set(expected.map((x) => JSON.stringify(x)));
  const added = after.news.items.filter((x) => !old.has(JSON.stringify(x)));
  for (const n of added) {
    if (!want.has(JSON.stringify(n))) { problems.push(`news item not drafted by this run: ${n.date} ${String(n.title).slice(0, 80)}`); continue; }
    if (n.origin !== 'automated' || !n.verification || n.verification.method !== 'agent') problems.push(`news item ${n.date} ${n.title.slice(0, 60)}: not marked as written and checked by the pipeline`);
    if (!(n.evidence || []).length || n.evidence.some((x) => !(n.links || []).some((l) => l.u === x.source_url))) problems.push(`news item ${n.date} ${n.title.slice(0, 60)}: evidence must come from its own linked release`);
    if (checkLine && n.check !== checkLine(n)) problems.push(`news item ${n.date} ${n.title.slice(0, 60)}: check line is not the fixed wording`);
  }
  // A tracker must name a tracked entry (never the excluded list), and no added item may repeat a release already on the page, or one
  // another added item links, by any form of its URL (http or https, www, trailing slash, tracking parameters).
  const entryOf = new Map((after.entries || []).map((e) => [e.key, e]));
  const onPage = new Set(before.news.items.flatMap((x) => (x.links || []).map((l) => linkKey(l.u)))), thisRun = new Set();
  for (const n of added) {
    if (n.tracker != null && (!entryOf.has(n.tracker) || entryOf.get(n.tracker).section === 'J')) problems.push(`news item ${n.date} ${String(n.title).slice(0, 60)}: tracker ${n.tracker} is not a tracked entry`);
    for (const k of new Set((n.links || []).map((l) => linkKey(l.u)))) {
      if (onPage.has(k)) problems.push(`news item ${n.date} ${String(n.title).slice(0, 60)}: its release ${k} is already on the news page`);
      if (thisRun.has(k)) problems.push(`news item ${n.date} ${String(n.title).slice(0, 60)}: its release ${k} is linked by another item added in this run`);
      thisRun.add(k);
    }
  }
  if (added.length !== expected.length) problems.push(`${added.length} news items added, expected ${expected.length}`);
  if (JSON.stringify(before.entries) !== JSON.stringify(after.entries)) problems.push('entries changed: the news step may not change them');
  return problems;
}

// A status may only move forward. Authored judgement calls ("stalled") may still become law or fail.
const FORWARD = { pending: ['stalled', 'enacted', 'failed'], stalled: ['pending', 'enacted', 'failed'] };
// Fields Tier A may change on an entry. Everything else (mechanism, thresholds, penalties, title, ...) must be identical.
const TIER_A_FIELDS = new Set(['events', 'status', 'status_text', 'last_checked', 'last_changed', 'origin', 'verification', 'evidence', 'identifiers', 'record_facts']); // identifiers: added once, when an entry first becomes mixed
// The sponsor text is written by hand. Tier A may change only its fixed-wording end ("; N cosponsors in all (Congress.gov)"), to the
// total in record_facts.cosponsors; every other character must stay as it was.
const handPart = (t) => { const m = COSPONSOR_SUFFIX.exec(t || ''); return m ? t.slice(0, m.index) : String(t || '').replace(/[\s.;]+$/, ''); };
export function sponsorTextProblem(o, n) {
  if (o.sponsor_text === n.sponsor_text) return null;
  const f = n.record_facts && n.record_facts.cosponsors;
  if (!f || !Number.isInteger(f.count)) return 'sponsor_text changed without a cosponsor total in record_facts';
  if (typeof n.sponsor_text !== 'string') return 'sponsor_text removed (only its fixed-wording end may change)';
  if (!n.sponsor_text.endsWith(cosponsorSuffix(f.count))) return `sponsor_text does not end with the fixed wording for ${f.count} cosponsors`;
  if (handPart(n.sponsor_text) !== handPart(o.sponsor_text)) return 'sponsor_text: the hand-written part changed';
  return null;
}
const evKey = (v) => `${v.date}|${v.type}|${v.text}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A failed bill may still become law, but only on a record that says so (a veto overridden, or the law's own number).
const OVERRIDE = /\bover(ridden|ride\b|.{0,40}\bveto)|became public law|became law/i;

// The status text is the author's; the pipeline may only add to its end. The new text must start with the old one (its closing
// punctuation aside), allowing exactly the two edits Tier A makes inside it (publish/tier-a.mjs): a stale "No (further) action in N
// months / since <date>" clause is dropped, only on an entry that gained a new event in this change, and the total in "for N cosponsors
// in all" becomes the record's total, only when record_facts.cosponsors changed in this change.
// Only a whole clause, ended by ; , . or the end of the text: "no action in the House since, because ..." is never matched.
const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
export const STALE = new RegExp(`(^|[;,.])\\s*no (further )?action (?:(?:in|for) \\d+\\+? ?(?:months?|weeks?|years?)|since (?:${MONTH}\\.? \\d{1,2}(?:, \\d{4})?|\\d{4}-\\d{2}-\\d{2}))\\s*(?=[;,.]|$)`, 'gi');
// Drops stale clauses and nothing else: each match carries its own leading separator, so the author's text around it is untouched (no
// punctuation is collapsed anywhere else: "the Act... was referred" stays as written). Shared with publish/tier-a.mjs.
export const removeStale = (t) => { const s = String(t || ''), r = s.replace(STALE, ''); return r === s ? s : r.replace(/^[\s;,.]+/, ''); };
const newEvent = (o, n) => { const had = new Set((o.events || []).map(evKey)); return (n.events || []).some((x) => !had.has(evKey(x))); };
export function statusTextProblem(o, n) {
  if (o.status_text === n.status_text || !o.status_text) return null;
  // Compared against the author's exact text (no tidying on either side), so no change to their punctuation can slip through.
  const now = String(n.status_text || '');
  const olds = [String(o.status_text)];
  if (newEvent(o, n)) olds.push(removeStale(olds[0]));
  // (No exception for the author's "for N cosponsors in all": Tier A never edits it; a new total is appended, dated.)
  for (const old of olds) if (now.startsWith(old.replace(/[\s.;,:]+$/, ''))) return null;
  return 'status_text: the existing text was rewritten (only additions at its end are allowed)';
}

// Existing events and evidence are append-only. An event (matched by date, type and text) keeps every field; only "scheduled" may flip,
// and only to what the data's cut-off says (publish/tier-a.mjs advanceCutoff). Evidence items are never edited or removed, except the
// evidence of a field a self-correction replaced (correct/apply.mjs).
const bare = (v) => { const { scheduled, ...rest } = v; return rest; };
export function appendOnlyProblems(o, n, { updatesThrough, fixed = new Set() } = {}) {
  const problems = [], pool = [...(n.events || [])];
  for (const x of o.events || []) {
    const i = pool.findIndex((y) => evKey(y) === evKey(x) && same(bare(y), bare(x)) && (y.scheduled === x.scheduled || y.scheduled === (y.date > updatesThrough)));
    if (i >= 0) { pool.splice(i, 1); continue; }
    if (pool.some((y) => evKey(y) === evKey(x))) problems.push(`existing event edited: ${x.date} ${String(x.text).slice(0, 60)}`);
  }
  const ev = (n.evidence || []).map((x) => JSON.stringify(x));
  for (const x of o.evidence || []) {
    if (fixed.has(x.field)) continue;
    const i = ev.indexOf(JSON.stringify(x));
    if (i >= 0) ev.splice(i, 1); else problems.push(`existing evidence edited or removed (${x.field}: "${String(x.quote || '').slice(0, 50)}")`);
  }
  return problems;
}

// Identifiers are set once (absent -> set, when an entry first becomes mixed) and afterwards only gain ids: nothing is edited or removed.
export function identifiersProblem(o, n) {
  if (same(o.identifiers, n.identifiers) || o.identifiers == null) return null;
  if (n.identifiers == null) return 'identifiers removed';
  const a = o.identifiers, b = n.identifiers;
  const bad = Object.keys({ ...a, ...b }).filter((k) => k !== 'external' && !same(a[k], b[k]));
  if (bad.length) return `identifiers edited (${bad.join(', ')})`;
  const xa = a.external || {}, xb = b.external || {};
  const lost = Object.keys(xa).filter((k) => { const now = (Array.isArray(xb[k]) ? xb[k] : [xb[k]]).map(String); return (Array.isArray(xa[k]) ? xa[k] : [xa[k]]).map(String).some((id) => !now.includes(id)); });
  return lost.length ? `identifiers edited: ids removed or changed in ${lost.join(', ')} (only additions are allowed)` : null;
}

// Fields a self-correction (correct/) may also change, on the entries and fields it names. Never a fact the record states exactly.
const CORRECTABLE = new Set(READING_FIELDS);

// newKeys: the entries Tier B added this run (any other new entry stops the run); maxNew: the per-run limit on them.
// corrected: { entry key: [fields] } the self-correction step changed this run (correct/apply.mjs); only reading fields are allowed.
// links: { edges, nodes, texts?, created? } links/apply.mjs added this run; the network may grow by exactly these and nothing
// else (texts: { url: official text } for AI links; created: entry keys created this run).
export function checkPublish({ before, after, runDate, maxEntries, maxNew = 0, newKeys = [], rawHashOk = [], corrected = {}, links = null }) {
  const problems = [];
  // 1. every output file passes its schema, and the files agree with each other
  const v = makeValidator();
  after.entries.forEach((e) => v.check('entry', e).forEach((p) => problems.push(`schema: entry ${e.key}: ${p}`)));
  [['news', after.news], ['site', after.site], ['relationships', after.relationships], ['changes', after.changes]].forEach(([n, d]) => v.check(n, d).forEach((p) => problems.push(`schema: ${n}: ${p}`)));
  checkIntegrity(after).forEach((p) => problems.push('integrity: ' + p));

  const old = new Map(before.entries.map((e) => [e.key, e]));
  const now = new Map(after.entries.map((e) => [e.key, e]));
  let changed = 0;
  const cutoff = runDate > after.site.updates_through ? runDate : after.site.updates_through;
  for (const [key, o] of old) {
    const n = now.get(key);
    // 3. nothing is ever deleted: entries, events, sources, links
    if (!n) { problems.push(`deleted entry: ${key}`); continue; }
    const evs = new Set(n.events.map(evKey));
    o.events.filter((x) => !evs.has(evKey(x))).forEach((x) => problems.push(`deleted event on ${key}: ${x.date} ${x.text}`));
    const urls = new Set([...(n.sources || []), ...(n.more_links || [])].map((s) => s.url || s.u));
    [...(o.sources || []), ...(o.more_links || [])].map((s) => s.url || s.u).filter((u) => !urls.has(u)).forEach((u) => problems.push(`deleted link on ${key}: ${u}`));
    // 2. no status goes backwards; a new status follows the section's rule and is quoted from its record
    if (o.status !== n.status) {
      const quotes = (n.evidence || []).filter((x) => x.field === 'status' && x.quote && !(o.evidence || []).some((y) => same(x, y)));
      const override = o.status === 'failed' && n.status === 'enacted' && quotes.some((x) => OVERRIDE.test(x.quote));
      if (!(FORWARD[o.status] || []).includes(n.status) && !override) problems.push(`status went backwards on ${key}: ${o.status} -> ${n.status}`);
      if (n.status !== statusFor(n.section, n.status)) problems.push(`status ${n.status} does not follow the rule for section ${n.section} on ${key}`);
      if (!quotes.length) problems.push(`status changed on ${key} (${o.status} -> ${n.status}) without a status evidence quote`);
    }
    // the author's status text is only added to, identifiers only gain ids, and an entry only moves from authored to mixed
    const st = statusTextProblem(o, n); if (st) problems.push(`${st} on ${key}`);
    const idp = identifiersProblem(o, n); if (idp) problems.push(`${idp} on ${key}`);
    if (o.origin !== n.origin && !(o.origin === 'authored' && n.origin === 'mixed')) problems.push(`origin changed on ${key}: ${o.origin} -> ${n.origin} (only authored -> mixed is allowed)`);
    // every new event names its source, and that source is one the entry's evidence quotes
    const had = new Set(o.events.map(evKey));
    n.events.filter((x) => !had.has(evKey(x))).forEach((x) => { if (!x.source_url || !(n.evidence || []).some((y) => y.source_url === x.source_url && y.quote)) problems.push(`new event on ${key} (${x.date} ${String(x.text).slice(0, 60)}) has no source_url matching an evidence quote`); });
    // only Tier A fields may change
    // A corrected entry may also gain the bill text as a source (removing one is caught by the deleted-link check above).
    const fixed = new Set((corrected[key] || []).filter((f) => CORRECTABLE.has(f)));
    (corrected[key] || []).filter((f) => !CORRECTABLE.has(f)).forEach((f) => problems.push(`self-correction named ${f} on ${key}: only ${READING_FIELDS.join(', ')} may be corrected`));
    if (fixed.size) fixed.add('sources');
    Object.keys({ ...o, ...n }).filter((f) => f !== 'sponsor_text' && !TIER_A_FIELDS.has(f) && !fixed.has(f) && !same(o[f], n[f])).forEach((f) => problems.push(`field ${f} changed on ${key}: ${fixed.size ? 'a self-correction' : 'Tier A'} may not change it`));
    const sp = sponsorTextProblem(o, n); if (sp) problems.push(`${sp} on ${key}`);
    appendOnlyProblems(o, n, { updatesThrough: after.site.updates_through, fixed }).forEach((p) => problems.push(`${p} on ${key}`));
    if (!same(o, n)) changed++;
    // 6. no event in the future unless it is marked scheduled
    n.events.filter((x) => x.date > cutoff && !x.scheduled).forEach((x) => problems.push(`future event not marked scheduled on ${key}: ${x.date}`));
  }
  const added = [...now.keys()].filter((key) => !old.has(key));
  for (const key of added) {
    if (!newKeys.includes(key)) { problems.push(`new entry ${key}: not created by Tier B`); continue; }
    checkNewEntry(now.get(key)).forEach((p) => problems.push(`new entry ${key}: ${p}`));
    now.get(key).events.filter((x) => x.date > cutoff && !x.scheduled).forEach((x) => problems.push(`future event not marked scheduled on ${key}: ${x.date}`));
  }
  if (added.length > maxNew) problems.push(`${added.length} new entries, over the limit of ${maxNew} per run`);
  const oldNews = new Set(before.news.items.map((x) => JSON.stringify(x)));
  const keptNews = after.news.items.filter((x) => oldNews.has(JSON.stringify(x))).length;
  if (keptNews < before.news.items.length) problems.push(`news items deleted or edited: ${before.news.items.length - keptNews}`);
  // every new news item carries evidence, each quote from a page the item links to
  after.news.items.filter((x) => !oldNews.has(JSON.stringify(x))).forEach((x) => {
    if (!(x.evidence || []).length || x.evidence.some((y) => !y.quote || !y.source_url || !(x.links || []).some((l) => l.u === y.source_url))) problems.push(`new news item ${x.date} ${String(x.title).slice(0, 60)}: needs evidence quoted from one of its own links`);
  });
  if ((after.changes.items || []).length < (before.changes.items || []).length) problems.push('change log entries deleted');
  if (!links) { if (!same(before.relationships, after.relationships)) problems.push('relationships changed: Tier A does not change them'); }
  else checkLinks(before.relationships, after.relationships, links, after.entries).forEach((p) => problems.push(p));
  // 4. a run that changes too much at once is an anomaly
  if (changed > maxEntries) problems.push(`${changed} entries would change, over the limit of ${maxEntries} per run`);
  // 5. the source text read now is the text fetched at grab time
  rawHashOk.filter((r) => !r.ok).forEach((r) => problems.push(`stored source changed since it was fetched: ${r.item_id}`));
  return { problems, changed };
}

// The network after a links step: the old network unchanged, plus exactly the edges and nodes links/apply.mjs added, each from the
// pipeline with a quote and a source URL. Any edit, deletion, reordering or other addition stops the run. Each added edge must
// also mean what it says (links/rules.mjs): both ends are nodes, the ends' kinds and the entry's type fit the label, the quote is
// word for word in the source it names (the entry's field at src, with that entry's tracker page as source_url; or the official
// text at source_url for an AI link), the entry it is for was made by the automation, and no edge joins the pair the other way.
export function checkLinks(b, a, links, entries = []) {
  const problems = [], addE = links.edges || [], addN = links.nodes || {}, texts = links.texts || {}, created = links.created || [];
  if (!same(b.types, a.types) || !same(b.columns, a.columns)) problems.push('relationships changed: link types or columns may not change');
  Object.keys(b.nodes).filter((k) => !same(b.nodes[k], a.nodes[k])).forEach((k) => problems.push(`relationships changed: node ${k} edited or deleted`));
  Object.keys(a.nodes).filter((k) => !b.nodes[k] && !same(a.nodes[k], addN[k])).forEach((k) => problems.push(`relationships changed: node ${k} was not added by links/apply.mjs`));
  Object.keys(addN).filter((k) => b.nodes[k]).forEach((k) => problems.push(`relationships changed: added node ${k} already existed`));
  b.edges.forEach((e, i) => { if (!same(e, a.edges[i])) problems.push(`relationships changed: edge #${i} (${e.from} -> ${e.to}) edited, moved or deleted`); });
  if (!same(a.edges.slice(b.edges.length), addE)) problems.push('relationships changed: the new edges are not exactly the ones links/apply.mjs added');
  const pair = (e) => [e.from, e.to].sort().join('|') + '|' + e.type, old = new Set(b.edges.map(pair)), dir = new Set(b.edges.map((e) => e.from + '>' + e.to));
  const byKey = new Map(entries.map((e) => [e.key, e])), entryOf = (k) => byKey.get(k);
  addE.forEach((e) => {
    const at = `added link ${e.from} -> ${e.to}`;
    if (e.origin !== 'automated' || !e.source_url || !e.quote) problems.push(`${at}: not marked automated with a quote and source URL`);
    if (old.has(pair(e))) problems.push(`${at}: the network already has it`);
    if (dir.has(e.to + '>' + e.from)) problems.push(`${at}: the network already links them the other way`);
    old.add(pair(e)); dir.add(e.from + '>' + e.to);
    const shape = edgeShapeProblem(e, a.nodes, entryOf); if (shape) problems.push(`${at}: ${shape}`);
    // where the quote sits
    const src = a.nodes[e.src], ent = src && src.kind === 'entry' ? entryOf(src.entry_key) : null;
    if (!ent || (e.src !== e.from && e.src !== e.to)) { problems.push(`${at}: src ${e.src} is not the entry at one end of the link`); return; }
    if (ENTRY_FIELDS.includes(e.col)) {
      if (typeof ent[e.col] !== 'string' || !e.quote || !ent[e.col].includes(e.quote)) problems.push(`${at}: the quote is not word for word in ${ent.key} ${e.col}`);
      if (e.source_url !== trackerUrl(ent)) problems.push(`${at}: the quote is the tracker's own text, so its source must be the entry's tracker page (${trackerUrl(ent)}), not ${e.source_url}`);
    } else if (e.col === 'text') {
      if (!texts[e.source_url] || !containsQuote(texts[e.source_url], e.quote)) problems.push(`${at}: the quote is not in the official text at ${e.source_url}`);
    } else problems.push(`${at}: col ${e.col} is not a source the pipeline quotes`);
    if (ent.origin !== 'automated' && !created.includes(ent.key)) problems.push(`${at}: entry ${ent.key} is hand-written (origin ${ent.origin}); its links are reported, never added automatically`);
  });
  return problems;
}
