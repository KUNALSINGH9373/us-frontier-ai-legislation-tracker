// Applies a Generator patch to produce a full candidate entry (v2). Plain code.
// Everything the model must not decide is decided here: status, type, level, jurisdiction, confidence, identifiers,
// sources, verification and dates of checking.
import { SECTION_RULES, AUTO_CREATE_SECTIONS, SECTION_NAMES, statusFor, confidenceFor } from './rules.mjs';
import { statusFromAction } from '../compare/congress.mjs';
import { deriveCreate } from './derive.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
const UPDATE_FIELDS = ['sponsor_text', 'mechanism', 'thresholds', 'penalties', 'status_text', 'signed_text', 'effective_text'];
const CREATE_REQUIRED = ['title', 'short_name', 'section', 'sponsor_text', 'mechanism'];

export function assembleEntry({ entry, patch: patchIn, item, raw, today, runId, rounds, entries = [], now = new Date() }) {
  let patch = patchIn;
  const problems = [], source = item.source;
  const sourceRef = { label: source === 'congress_gov' ? `Congress.gov record: ${(raw.bill && raw.bill.title) || item.source_id}` : `Federal Register: ${(raw.document && raw.document.title) || item.source_id}`, url: item.source_url, kind: 'primary', retrieved_at: item.fetched_at };
  const identifiers = (base) => {
    const id = clone(base || { external: {} }); id.external = id.external || {};
    if (source === 'congress_gov') id.external.congress_gov = [...new Set([...(id.external.congress_gov || []), item.source_id])];
    else id.external.federal_register_doc = item.source_id;
    if (source === 'congress_gov' && !id.session) id.session = '119th Congress';
    return id;
  };
  const addEvents = (events) => {
    const out = clone(events || []);
    for (const e of patch.events_add) {
      if (out.some((x) => x.date === e.date && x.type === e.type)) continue;
      out.push({ ...e, inferred_year: false, scheduled: e.date > today });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  };
  const common = (o) => {
    o.evidence = [...(o.evidence || []), ...patch.evidence.map((e) => ({ field: e.field, quote: e.quote, source_url: e.source_url || item.source_url }))];
    o.sources = (o.sources || []).some((s) => s.url === sourceRef.url) ? o.sources : [...(o.sources || []), sourceRef];
    o.verification = { method: 'agent', checked_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), run_id: runId, rounds };
    o.last_checked = today; o.last_changed = today;
    o.tags = { ...(o.tags || {}), updated_after_verification: true };
    return o;
  };

  if (patch.operation === 'update') {
    if (!entry) { problems.push('an update needs an existing entry'); return { entry: null, problems }; }
    const bad = Object.keys(patch.fields).filter((k) => !UPDATE_FIELDS.includes(k));
    if (bad.length) problems.push(`an update may not change: ${bad.join(', ')}`);
    if (entry.confidence && entry.confidence.basis === 'search_negative') problems.push('this entry holds a search-qualified "none located" finding; only a person can update it');
    const o = clone(entry);
    for (const k of UPDATE_FIELDS) if (k in patch.fields) o[k] = patch.fields[k];
    o.events = addEvents(o.events);
    if (source === 'congress_gov' && raw.bill && raw.bill.latestAction) o.status = statusFor(o.section, statusFromAction(raw.bill.latestAction.text)) || o.status;
    o.identifiers = identifiers(o.identifiers);
    o.origin = o.origin === 'automated' ? 'automated' : 'mixed';
    return { entry: common(o), problems, changed: [...Object.keys(patch.fields).filter((k) => UPDATE_FIELDS.includes(k)), ...patch.events_add.map((_, i) => `events_add[${i}]`)] };
  }

  // create: what the record states exactly is written by code; the model supplies what needs reading (mechanism, who it covers, section when no rule decides it)
  const derived = deriveCreate({ item, raw });
  const f = { ...patch.fields, ...Object.fromEntries(Object.entries(derived.fields).filter(([, v]) => v != null)), ...(derived.section ? { section: derived.section } : {}) };
  patch = { ...patch, events_add: [...derived.events, ...patch.events_add.filter((e) => !derived.events.some((d) => d.date === e.date && d.type === e.type))] };
  for (const k of CREATE_REQUIRED) if (f[k] == null || f[k] === '') problems.push(`a new entry needs "${k}"`);
  if (problems.length) return { entry: null, problems };
  if (!AUTO_CREATE_SECTIONS.includes(f.section)) { problems.push(`new entries in section ${f.section} need a person (the pipeline may create only in ${AUTO_CREATE_SECTIONS.join(', ')})`); return { entry: null, problems }; }
  const rule = SECTION_RULES[f.section];
  const apiStatus = source === 'congress_gov' && raw.bill && raw.bill.latestAction ? statusFromAction(raw.bill.latestAction.text) : 'pending';
  const existingKeys = new Set(entries.map((e) => e.key));
  let key = slug(f.short_name) || 'entry'; if (!/^[a-z0-9]/.test(key)) key = 'e-' + key;
  if (existingKeys.has(key)) key = `${key}-${(entries.reduce((m, e) => Math.max(m, e.id), 0) + 1)}`;
  const conf = confidenceFor([sourceRef.kind]);
  const o = {
    id: entries.reduce((m, e) => Math.max(m, e.id), 0) + 1, key, section: f.section, type: rule.type, level: rule.level, jurisdiction: 'Federal', state: null,
    status: statusFor(f.section, apiStatus), title: f.title, short_name: f.short_name, sponsor_text: f.sponsor_text, mechanism: f.mechanism,
    thresholds: f.thresholds || null, penalties: f.penalties || null, status_text: f.status_text || null, signed_text: f.signed_text || null, effective_text: f.effective_text || null,
    events: [], sources: [], confidence: { level: conf.level, basis: conf.basis }, tags: { found_via: 'api' }, evidence: [],
    origin: 'automated', identifiers: identifiers(null), legacy: { section_name: SECTION_NAMES[f.section] }
  };
  o.events = addEvents([]);
  return { entry: common(o), problems, changed: [...Object.keys(f), ...patch.events_add.map((_, i) => `events_add[${i}]`)] };
}
