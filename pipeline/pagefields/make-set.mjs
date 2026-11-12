// Builds eval/pagefields-set/cases.json from reviewed page-field drafts (pagefields/run.mjs output a person read against the record)
// and the entries they were written from. Each case carries a snapshot of the entry's checked fields, so the set does not move when the
// live data does. Run again only to rebuild the set on purpose:
//   node pagefields/make-set.mjs <reviewed drafts.json>
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { kindOf, needsName } from './layout.mjs';
import { checkDraft } from './write.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');
const SNAP = ['key', 'title', 'short_name', 'type', 'status', 'state', 'section', 'sponsor_text', 'mechanism', 'thresholds', 'penalties', 'signed_text', 'effective_text', 'status_text', 'events', 'duties', 'exec_checklist', 'plain'];
const snap = (e) => Object.fromEntries(SNAP.filter((k) => e[k] !== undefined && e[k] !== null).map((k) => [k, e[k]]));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const drafts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).results;
  const entries = JSON.parse(fs.readFileSync(path.join(P, '..', 'web', 'data', 'v2', 'entries.json'), 'utf8'));
  const cases = [];
  for (const e of entries) {
    const r = drafts[e.key];
    if (!r || !r.fields) continue;
    const layout = kindOf(e), want = needsName(e), entry = snap(e);
    // keep only fields today's code accepts (what apply.mjs wrote)
    const ok = checkDraft({ entry: e, draft: { key_facts: {}, ...r.fields }, kind: layout, wantName: want }).fields;
    const base = { entry, layout, want_name: want };
    if (ok.summary_line) {
      const s = ok.summary_line;
      cases.push({ id: `${e.key}:summary:good`, kind: 'good', field: 'summary_line', draft: { summary_line: s }, ...base });
      cases.push({ id: `${e.key}:summary:number`, kind: 'bad', field: 'summary_line', draft: { summary_line: s.replace(/\.$/, '') + ' within 913 days.' }, ...base });
      cases.push({ id: `${e.key}:summary:meta`, kind: 'bad', field: 'summary_line', draft: { summary_line: 'The entry text does not say much, but ' + s.charAt(0).toLowerCase() + s.slice(1) }, ...base });
      cases.push({ id: `${e.key}:summary:two`, kind: 'bad', field: 'summary_line', draft: { summary_line: s.replace(/\.$/, '') + '. It also does more.' }, ...base });
      cases.push({ id: `${e.key}:summary:describes`, kind: 'bad', field: 'summary_line', draft: { summary_line: 'Describes ' + s.charAt(0).toLowerCase() + s.slice(1) }, ...base });
      cases.push({ id: `${e.key}:summary:markup`, kind: 'bad', field: 'summary_line', draft: { summary_line: s.replace(/\.$/, '') + ' <b>now</b>.' }, ...base });
      if (layout === 'bill' && ['pending', 'stalled', 'failed'].includes(e.status)) cases.push({ id: `${e.key}:summary:tense`, kind: 'bad', field: 'summary_line', draft: { summary_line: 'Requires ' + s.replace(/^Would (have )?\w+\s*/, '').replace(/^./, (c) => c.toLowerCase()) }, ...base });
    }
    if (ok.thirty_seconds) {
      cases.push({ id: `${e.key}:thirty:good`, kind: 'good', field: 'thirty_seconds', draft: { thirty_seconds: ok.thirty_seconds }, ...base });
      const filled = ['a', 'b', 'c'].find((k) => ok.thirty_seconds[k]);
      cases.push({ id: `${e.key}:thirty:meta`, kind: 'bad', field: 'thirty_seconds', draft: { thirty_seconds: { ...ok.thirty_seconds, [filled]: 'The entry text does not say who is covered.' } }, ...base });
      cases.push({ id: `${e.key}:thirty:number`, kind: 'bad', field: 'thirty_seconds', draft: { thirty_seconds: { ...ok.thirty_seconds, [filled]: ok.thirty_seconds[filled] + ' Fines reach $7,777,777.' } }, ...base });
    }
    Object.entries(ok.key_facts || {}).forEach(([k, v]) => {
      cases.push({ id: `${e.key}:fact:${k}:good`, kind: 'good', field: 'key_facts.' + k, draft: { key_facts: { [k]: v } }, ...base });
      cases.push({ id: `${e.key}:fact:${k}:invented`, kind: 'bad', field: 'key_facts.' + k, draft: { key_facts: { [k]: 'Zorbian Oversight Directorate' } }, ...base });
      cases.push({ id: `${e.key}:fact:${k}:explained`, kind: 'bad', field: 'key_facts.' + k, draft: { key_facts: { [k]: v + ' (civil action; §1)' } }, ...base });
    });
    if (ok.display_name) {
      cases.push({ id: `${e.key}:name:good`, kind: 'good', field: 'display_name', draft: { display_name: ok.display_name }, ...base });
      cases.push({ id: `${e.key}:name:invented`, kind: 'bad', field: 'display_name', draft: { display_name: 'Frontier Guardian Act' }, ...base });
    }
    if (want) cases.push({ id: `${e.key}:name:formal`, kind: 'bad', field: 'display_name', draft: { display_name: 'An Act relative to ' + e.short_name }, ...base });
    // reviewer verdicts: a refusal drops the field; an "ok" with a quote not in the record drops it too
    if (ok.summary_line) {
      cases.push({ id: `${e.key}:review:misleading`, kind: 'review', field: 'summary_line', fields: { summary_line: ok.summary_line }, verdicts: [{ field: 'summary_line', verdict: 'misleading', problem: 'drops a condition', support: [] }], entry, layout });
      cases.push({ id: `${e.key}:review:fakequote`, kind: 'review', field: 'summary_line', fields: { summary_line: ok.summary_line }, verdicts: [{ field: 'summary_line', verdict: 'ok', problem: '', support: ['the moon is made of green cheese'] }], entry, layout });
    }
  }
  const out = path.join(P, 'eval', 'pagefields-set', 'cases.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ _note: 'Built by pagefields/make-set.mjs from the page-field drafts of 11-12 Nov 2026 that a person reviewed against the record, and planted faults. See eval/pagefields-set.mjs.', built: new Date().toISOString().slice(0, 10), cases }, null, 1) + '\n');
  console.log(`${cases.length} cases: ${['good', 'bad', 'review'].map((k) => cases.filter((c) => c.kind === k).length + ' ' + k).join(', ')}`);
}
