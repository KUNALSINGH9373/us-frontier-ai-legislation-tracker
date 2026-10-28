// Stop rules for a publish. Any problem means nothing is written: with no human reviewer, an odd-looking run is
// stopped, not published. Each check returns readable problems; empty means the run may be written.
import { makeValidator } from '../schema/validate.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { SECTION_RULES, AUTO_CREATE_SECTIONS, statusFor, NEGATIVE_FINDING } from '../agents/rules.mjs';
import { FACT_FIELDS } from '../agents/checks.mjs';

// Fields only a reading of the text can supply. On a new entry each one that is filled needs a quote from the record.
export const READING_FIELDS = ['mechanism', 'thresholds', 'penalties'];

// The stricter path for a new entry (Tier B): everything the rules decide must match the rules, and every reading field
// must carry evidence. The quotes themselves are checked against the stored record in tier-b.mjs, which can read it.
export function checkNewEntry(e) {
  const problems = [], rule = SECTION_RULES[e.section];
  if (!AUTO_CREATE_SECTIONS.includes(e.section)) problems.push(`section ${e.section} needs a person`);
  else if (e.type !== rule.type || e.level !== rule.level) problems.push(`type/level ${e.type}/${e.level} do not follow the rule for section ${e.section}`);
  if (e.status !== statusFor(e.section, e.status)) problems.push(`status ${e.status} does not follow the rule for section ${e.section}`);
  if (e.origin !== 'automated' || !e.verification || e.verification.method !== 'agent') problems.push('not marked as written and checked by the pipeline');
  READING_FIELDS.filter((f) => e[f] && !(e.evidence || []).some((x) => x.field === f && x.quote)).forEach((f) => problems.push(`no evidence quote for ${f}`));
  FACT_FIELDS.filter((f) => e[f] && NEGATIVE_FINDING.test(e[f])).forEach((f) => problems.push(`${f} states a search finding ("none located"), which only a person may write`));
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
const TIER_A_FIELDS = new Set(['events', 'status', 'status_text', 'last_checked', 'last_changed', 'origin', 'verification', 'evidence', 'identifiers']); // identifiers: added once, when an entry first becomes mixed
const evKey = (v) => `${v.date}|${v.type}|${v.text}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Fields a self-correction (correct/) may also change, on the entries and fields it names. Never a fact the record states exactly.
const CORRECTABLE = new Set(READING_FIELDS);

// newKeys: the entries Tier B added this run (any other new entry stops the run); maxNew: the per-run limit on them.
// corrected: { entry key: [fields] } the self-correction step changed this run (correct/apply.mjs); only reading fields are allowed.
export function checkPublish({ before, after, runDate, maxEntries, maxNew = 0, newKeys = [], rawHashOk = [], corrected = {} }) {
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
    // 2. no status goes backwards
    if (o.status !== n.status && !(FORWARD[o.status] || []).includes(n.status)) problems.push(`status went backwards on ${key}: ${o.status} -> ${n.status}`);
    // only Tier A fields may change
    // A corrected entry may also gain the bill text as a source (removing one is caught by the deleted-link check above).
    const fixed = new Set((corrected[key] || []).filter((f) => CORRECTABLE.has(f)));
    (corrected[key] || []).filter((f) => !CORRECTABLE.has(f)).forEach((f) => problems.push(`self-correction named ${f} on ${key}: only ${READING_FIELDS.join(', ')} may be corrected`));
    if (fixed.size) fixed.add('sources');
    Object.keys({ ...o, ...n }).filter((f) => !TIER_A_FIELDS.has(f) && !fixed.has(f) && !same(o[f], n[f])).forEach((f) => problems.push(`field ${f} changed on ${key}: ${fixed.size ? 'a self-correction' : 'Tier A'} may not change it`));
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
  if ((after.changes.items || []).length < (before.changes.items || []).length) problems.push('change log entries deleted');
  if (!same(before.relationships, after.relationships)) problems.push('relationships changed: Tier A does not change them');
  // 4. a run that changes too much at once is an anomaly
  if (changed > maxEntries) problems.push(`${changed} entries would change, over the limit of ${maxEntries} per run`);
  // 5. the source text read now is the text fetched at grab time
  rawHashOk.filter((r) => !r.ok).forEach((r) => problems.push(`stored source changed since it was fetched: ${r.item_id}`));
  return { problems, changed };
}
