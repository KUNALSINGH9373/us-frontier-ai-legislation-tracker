// A new-bills writer answer -> a tracker entry. Plain code. The answer becomes a patch for assembleEntry, which writes every official
// fact (title, number, status, events, sponsors, sources, identifiers, dates); the model's words go only into the reading fields. Then
// the AI name becomes the headline (the official number and title stay underneath on the page), the 13 rows become the duties, and
// the box and the quoted items go in `plain`, which the site shows item by item beside the bill's words.
import crypto from 'node:crypto';
import { ITEM_LISTS, ROW_KEYS, itemsOf } from './newbill-prompts.mjs';

const clean = (s) => String(s || '').trim();
const join = (xs) => [...new Set(xs.map(clean).filter(Boolean))].join('; ');
// Which reading field each list supports, for the evidence the validator and self-correction read.
const FIELD = { coverage: 'thresholds', definitions: 'thresholds', exclusions: 'thresholds', duties: 'mechanism', penalties: 'penalties', effective: 'effective_text', other_provisions: 'mechanism' };
// The order "What it does" lists duties in: bans and catastrophic-risk duties before reporting and process duties (the box rule).
const KIND_ORDER = ['shutdown', 'framework', 'third_party_audit', 'imminent_risk_reporting', 'incident_reporting', 'transparency_report', 'whistleblower', 'registration', 'records', 'rulemaking', 'agency', 'other'];
const byKind = (a, b) => (a.force === 'ban' ? -1 : 0) - (b.force === 'ban' ? -1 : 0) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);

// The reading fields every entry has (the v2 site and the older readers use them), built from the items.
export function readingFields(out) {
  const duties = [...(out.duties || [])].sort(byKind);
  const mechanism = join(duties.map((d) => d.text)) || clean(out.box && out.box.requires && out.box.requires.text);
  const cover = join([...(out.coverage || []), ...(out.definitions || [])].map((x) => x.text));
  const excl = join((out.exclusions || []).map((x) => x.text));
  const thresholds = [cover, excl && `Excludes: ${excl}`].filter(Boolean).join('. ') || null;
  return {
    short_name: clean(out.name).slice(0, 100) || null,
    mechanism,
    thresholds,
    penalties: join((out.penalties || []).map((x) => x.text)) || null,
    effective_text: join((out.effective || []).filter((x) => x.type !== 'agency').map((x) => x.text)) || clean(out.box && out.box.effective && out.box.effective.text) || null
  };
}

// The patch assembleEntry takes (agents/generator.mjs shape): reading fields, the section, and evidence quotes (each a span of the bill).
export function toPatch(out) {
  const evidence = [];
  for (const x of itemsOf(out)) {
    evidence.push({ field: FIELD[x._list], quote: clean(x.quote) });
    if (clean(x.lead_in).length >= 8) evidence.push({ field: FIELD[x._list], quote: clean(x.lead_in) });
  }
  if (clean(out.name_quote).length >= 8) evidence.push({ field: 'short_name', quote: clean(out.name_quote) });
  return { operation: 'create', in_scope: true, scope_reason: clean(out.scope_reason), fields: { ...readingFields(out), section: out.tracker_section }, events_add: [], evidence: evidence.filter((e) => e.quote.length >= 8), notes: '' };
}

// The 13 rows as the entry's duties (common.schema.json duty): a marked row keeps its quote and section; an empty row has neither.
export function toDuties(out, sourceUrl) {
  return Object.fromEntries(ROW_KEYS.map((k) => {
    const r = (out.rows || {})[k] || { value: 'not_in_bill' };
    if (r.value === 'not_in_bill') return [k, { value: 'not_in_bill', summary: 'Not in the bill text.' }];
    return [k, { value: r.value, summary: clean(r.summary).slice(0, 600), section: clean(r.sec).slice(0, 80) || 'not stated', quote: clean(r.quote).slice(0, 2000), source_url: sourceUrl }];
  }));
}

const KEEP = ['id', 'text', 'quote', 'lead_in', 'sec', 'party', 'term', 'kind', 'force', 'deadline', 'conditions'];
export function toPlain(out) {
  const items = Object.fromEntries(ITEM_LISTS.map((l) => [l, (out[l] || []).map((x) => Object.fromEntries(KEEP.filter((k) => x[k] != null && x[k] !== '' && !(Array.isArray(x[k]) && !x[k].length)).map((k) => [k, x[k]])))]));
  const b = out.box || {}, t = (s) => clean(s && s.text);
  return { name_quote: clean(out.name_quote), box: { applies_to: t(b.applies_to), requires_lead: b.requires_lead === 'Directs' ? 'Directs' : 'Requires them to', requires: t(b.requires), enforcement: t(b.enforcement), effective: t(b.effective) }, items, text_problems: (out.text_problems || []).map(clean).filter(Boolean) };
}

// The assembled entry, finished: the AI name as the headline, the duties with the text they were read from, and the plain page.
export function finishEntry(entry, out, { sourceUrl, source, now }) {
  const name = clean(out.name).slice(0, 100);
  return {
    ...entry,
    ...(name.length >= 2 ? { short_name: name } : {}),
    duties: toDuties(out, sourceUrl),
    duties_basis: { source_url: sourceUrl, sha256: crypto.createHash('sha256').update(String(source)).digest('hex'), chars: String(source).length, method: 'agent', checked_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z') },
    plain: toPlain(out)
  };
}

// A facts-only entry: the bill is in scope (the reviewer raised no scope objection) but its description did not pass, so the page
// shows the official facts and says the description is pending; retried on the next run.
export const FACTS_ONLY_MECHANISM = 'A plain-English description of this bill is not yet available: the automated description did not pass its checks and will be tried again. The official record and full text are linked below.';
export function factsOnlyPatch(out) {
  return { operation: 'create', in_scope: true, scope_reason: clean(out && out.scope_reason), fields: { mechanism: FACTS_ONLY_MECHANISM, section: out && out.tracker_section }, events_add: [], evidence: [], notes: '' };
}
