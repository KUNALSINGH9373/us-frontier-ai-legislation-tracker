// The page-fields step of update.mjs: keeps every entry page's written fields (display_name, summary_line, thirty_seconds, key_facts)
// in step with the entry's checked text. Each run picks, in this order and up to page_fields.max_entries_per_run:
//   1) entries this run added or changed whose checked text differs from the text their page fields were written from
//      (page_verification.basis_sha256), or that have none yet
//   2) any other entry whose text changed since (a correction on an earlier run) or that never had page fields
// Each goes through pagefields/write.mjs (writer -> code -> reviewer, one rewrite round). A field that does not pass is left off, and
// one the entry already had is removed when its text changed (it no longer matches the record). The whole data set must then pass the
// entry schema and the integrity rules; anything else stops the step and nothing is written.
// While auto_publish.page_fields is off (or its gate report fails), no AI is spent: the step only reports how many pages wait.
import path from 'path';
import { loadData, writeData } from '../publish/run.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { writePageFields } from './write.mjs';
import { basisOf } from './layout.mjs';

export const WRITTEN = ['display_name', 'summary_line', 'thirty_seconds', 'key_facts'];
const eligible = (e) => e.section !== 'J';

// Which entries to do this run: this run's touched entries first, then the rest, oldest-checked first.
export function pickEntries(entries, touched, max) {
  const t = new Set(touched || []);
  const want = entries.filter((e) => eligible(e) && (!e.page_verification || e.page_verification.basis_sha256 !== basisOf(e)));
  // Entries written before checksums were kept (page_verification without basis_sha256) are not redone just for that: the checksum is
  // added the next time their text changes or they are touched.
  const due = want.filter((e) => t.has(e.key) || !e.page_verification || !!e.page_verification.basis_sha256 || !WRITTEN.some((f) => e[f] !== undefined));
  return [...due.filter((e) => t.has(e.key)), ...due.filter((e) => !t.has(e.key)).sort((a, b) => String((a.page_verification || {}).checked_at || '').localeCompare(String((b.page_verification || {}).checked_at || '')))].slice(0, max);
}

// One entry with its new page fields: the old written fields are replaced; page_verification records the reviewer and the checksum.
export function withFields(e, r, at) {
  const n = { ...e };
  WRITTEN.forEach((f) => { delete n[f]; });
  Object.assign(n, r.fields);
  const has = WRITTEN.some((f) => n[f] !== undefined) || n.exec_checklist !== undefined || n.claims !== undefined;
  if (has) n.page_verification = { method: 'agent', checked_at: at, reviewer: r.reviewerModel || 'reviewer', basis_sha256: basisOf(e) };
  else delete n.page_verification;
  return n;
}

export async function runPageFieldsStep({ dataDir, config, factory, aiOff = false, dry = false, touched = [], now = new Date(), log = () => {}, writeImpl = writePageFields }) {
  const cfg = config.page_fields || {}, max = cfg.max_entries_per_run ?? 3;
  const rep = { ran: false, status: 'skipped', publishing: !!(config.auto_publish && config.auto_publish.page_fields), checked: [], written: [], dropped: [], waiting: 0, problems: [] };
  if (cfg.enabled === false) { rep.skipped_why = 'page_fields.enabled is false'; return rep; }
  const data = loadData(dataDir);
  const picks = pickEntries(data.entries, touched, max);
  rep.waiting = data.entries.filter((e) => eligible(e) && (!e.page_verification || e.page_verification.basis_sha256 !== basisOf(e))).length;
  if (!rep.publishing) { rep.skipped_why = 'auto_publish.page_fields is off: no AI spent'; return rep; }
  if (aiOff || !factory) { rep.skipped_why = 'AI is off for this run'; return rep; }
  if (!picks.length) { rep.skipped_why = 'every page is up to date'; return rep; }
  rep.ran = true;
  const writer = factory.make('generator'), reviewer = factory.make('bill_reviewer');
  const at = now.toISOString().replace(/\.\d+Z$/, 'Z'), byKey = new Map();
  for (const e of picks) {
    try {
      const r = await writeImpl({ entry: e, writer, reviewer, log });
      byKey.set(e.key, withFields(e, r, at));
      rep.checked.push(e.key);
      if (Object.keys(r.fields).length) rep.written.push({ entry_key: e.key, fields: Object.keys(r.fields) });
      Object.entries(r.dropped || {}).forEach(([field, why]) => rep.dropped.push({ entry_key: e.key, field, why: String(why).slice(0, 200) }));
    } catch (err) {
      // a model or budget failure costs only this entry's page fields this run; they are tried again on a later run
      rep.problems.push(`${e.key}: ${String(err && err.message || err).slice(0, 160)}`);
    }
  }
  if (!byKey.size) { rep.status = rep.problems.length ? 'stopped' : 'unchanged'; return rep; }
  const after = { ...data, entries: data.entries.map((e) => byKey.get(e.key) || e) };
  const v = makeValidator(), problems = [];
  [...byKey.values()].forEach((e) => v.check('entry', e).forEach((p) => problems.push(`${e.key}: ${p}`)));
  checkIntegrity(after).forEach((p) => problems.push('integrity: ' + p));
  if (problems.length) { rep.status = 'stopped'; rep.problems.push(...problems.slice(0, 10)); return rep; }
  if (!dry) writeData(dataDir, after, ['entries']);
  rep.status = dry ? 'dry-run' : 'written';
  rep.changed = [...byKey.keys()].filter((k) => JSON.stringify(byKey.get(k)) !== JSON.stringify(data.entries.find((e) => e.key === k)));
  rep.summary = `Page fields: ${rep.written.length} entr${rep.written.length === 1 ? 'y' : 'ies'} written (${rep.written.map((w) => w.entry_key).join(', ') || 'none'})${rep.dropped.length ? `; ${rep.dropped.length} field(s) left off` : ''}`;
  log(rep.summary);
  return rep;
}
