// Stop rules for a publish. Any problem means nothing is written: with no human reviewer, an odd-looking run is
// stopped, not published. Each check returns readable problems; empty means the run may be written.
import { makeValidator } from '../schema/validate.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { SECTION_RULES, AUTO_CREATE_SECTIONS, statusFor, NEGATIVE_FINDING } from '../agents/rules.mjs';
import { FACT_FIELDS } from '../agents/checks.mjs';
import { COSPONSOR_SUFFIX, cosponsorSuffix } from '../compare/congress.mjs';

// Fields only a reading of the text can supply. On a new entry each one that is filled needs a quote from the record.
export const READING_FIELDS = ['mechanism', 'thresholds', 'penalties'];

// The stricter path for a new entry (Tier B): everything the rules decide must match the rules, and every reading field
// must carry evidence. The quotes themselves are checked against the stored record in tier-b.mjs, which can read it.
export function checkNewEntry(e) {
  const problems = [], rule = SECTION_RULES[e.section];
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
const COSPONSORS_IN_ALL = /\bfor \d+ cosponsors? in all\b/gi;
const tidy = (t) => String(t || '').replace(/^[\s;,.]+/, '').replace(/([;,.])(\s*[;,.])+/g, '$1');
const newEvent = (o, n) => { const had = new Set((o.events || []).map(evKey)); return (n.events || []).some((x) => !had.has(evKey(x))); };
export function statusTextProblem(o, n) {
  if (o.status_text === n.status_text || !o.status_text) return null;
  const now = tidy(n.status_text), f = n.record_facts && n.record_facts.cosponsors;
  const olds = [String(o.status_text)];
  if (newEvent(o, n)) olds.push(olds[0].replace(STALE, '$1'));
  if (f && Number.isInteger(f.count) && !same(o.record_facts && o.record_facts.cosponsors, f)) olds.push(...olds.map((t) => t.replace(COSPONSORS_IN_ALL, `for ${f.count} cosponsor${f.count === 1 ? '' : 's'} in all`)));
  for (const old of olds) if (now.startsWith(tidy(old).replace(/[\s.;,:]+$/, ''))) return null;
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
// links: { edges, nodes } links/apply.mjs added this run; the network may grow by exactly these and nothing else.
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
  else checkLinks(before.relationships, after.relationships, links).forEach((p) => problems.push(p));
  // 4. a run that changes too much at once is an anomaly
  if (changed > maxEntries) problems.push(`${changed} entries would change, over the limit of ${maxEntries} per run`);
  // 5. the source text read now is the text fetched at grab time
  rawHashOk.filter((r) => !r.ok).forEach((r) => problems.push(`stored source changed since it was fetched: ${r.item_id}`));
  return { problems, changed };
}

// The network after a links step: the old network unchanged, plus exactly the edges and nodes links/apply.mjs added, each from the
// pipeline with a quote and a source URL. Any edit, deletion, reordering or other addition stops the run.
export function checkLinks(b, a, links) {
  const problems = [], addE = links.edges || [], addN = links.nodes || {};
  if (!same(b.types, a.types) || !same(b.columns, a.columns)) problems.push('relationships changed: link types or columns may not change');
  Object.keys(b.nodes).filter((k) => !same(b.nodes[k], a.nodes[k])).forEach((k) => problems.push(`relationships changed: node ${k} edited or deleted`));
  Object.keys(a.nodes).filter((k) => !b.nodes[k] && !same(a.nodes[k], addN[k])).forEach((k) => problems.push(`relationships changed: node ${k} was not added by links/apply.mjs`));
  Object.keys(addN).filter((k) => b.nodes[k]).forEach((k) => problems.push(`relationships changed: added node ${k} already existed`));
  b.edges.forEach((e, i) => { if (!same(e, a.edges[i])) problems.push(`relationships changed: edge #${i} (${e.from} -> ${e.to}) edited, moved or deleted`); });
  if (!same(a.edges.slice(b.edges.length), addE)) problems.push('relationships changed: the new edges are not exactly the ones links/apply.mjs added');
  const pair = (e) => [e.from, e.to].sort().join('|') + '|' + e.type, old = new Set(b.edges.map(pair));
  addE.forEach((e) => {
    if (e.origin !== 'automated' || !e.source_url || !e.quote) problems.push(`added link ${e.from} -> ${e.to}: not marked automated with a quote and source URL`);
    if (old.has(pair(e))) problems.push(`added link ${e.from} -> ${e.to}: the network already has it`);
    old.add(pair(e));
  });
  return problems;
}
