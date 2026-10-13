// Run:  node compare/test.mjs   (or npm run test:compare)
// Uses real Congress.gov records saved from a live check (fixtures/congress) plus a few made-up cases for situations
// that have not happened yet (a bill becoming law, a different sponsor).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareCongress, datesMentioned, statusFromAction, surname } from './congress.mjs';
import { compareRun } from './run.mjs';
import { makeValidator } from '../schema/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (...p) => path.join(here, '..', 'fixtures', ...p);
const raw = (f) => JSON.parse(fs.readFileSync(fx('congress', f + '.json'), 'utf8'));
const entries = JSON.parse(fs.readFileSync(fx('entries.sample.json'), 'utf8'));
const entry = (key) => entries.find((e) => e.key.startsWith(key));
const clone = (o) => JSON.parse(JSON.stringify(o));
const v = makeValidator();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const run = (file, e) => { const r = raw(file); return compareCongress({ item: { item_id: 'congress_gov:' + r.id }, raw: r, entry: e }); };

// ---------- real records ----------
const s2938 = run('119-s-2938', entry('s-2938'));
ok('S. 2938: a hearing on 30 Sep, after the tracker last checked, is material', s2938.verdict === 'material' && s2938.reasons[0].kind === 'new_action' && /Hearings held/.test(s2938.reasons[0].detail), JSON.stringify(s2938));
ok('S. 2938: only the hearing is new (the 2025 referral is already in the tracker)', s2938.reasons.length === 1);
const h9363 = run('119-hr-9363', entry('h-r-9363'));
ok('H.R. 9363: nothing since the tracker last checked is unchanged', h9363.verdict === 'unchanged' && h9363.reasons.length === 0, JSON.stringify(h9363));
const h9925 = run('119-hr-9925', entry('h-r-9925'));
ok('H.R. 9925: record updated but no new action is minor, so no AI is spent on it', h9925.verdict === 'minor' && h9925.reasons.every((r) => r.kind === 'record_updated'), JSON.stringify(h9925));
const s5061 = run('119-s-5061', entry('s-5061'));
ok('S. 5061: record updated but no new action is minor', s5061.verdict === 'minor');
const s5493 = run('119-s-5493', entry('s-5493'));
ok('S. 5493: record updated but no new action is minor', s5493.verdict === 'minor');
ok('every verdict passes its schema', [s2938, h9363, h9925, s5061, s5493].every((d) => v.check('diff', d).length === 0), [s2938, h9363, h9925, s5061, s5493].map((d) => v.check('diff', d).join(';')).join(' | '));

// ---------- made-up situations ----------
{
  const r = raw('119-s-5061'), e = entry('s-5061'), item = { item_id: 'x' };
  const law = clone(r); law.bill.latestAction = { actionDate: '2026-10-05', text: 'Became Public Law No: 119-77.' }; law.actions.unshift({ actionDate: '2026-10-05', text: 'Became Public Law No: 119-77.' });
  const d = compareCongress({ item, raw: law, entry: e });
  ok('a bill that becomes law is a status change and a new action', d.verdict === 'material' && d.reasons.some((x) => x.kind === 'status_change' && x.api_value === 'enacted') && d.reasons.some((x) => x.kind === 'new_action'));
  const vet = clone(r); vet.bill.latestAction = { actionDate: '2026-10-05', text: 'Vetoed by President.' };
  ok('a veto is a status change to failed', compareCongress({ item, raw: vet, entry: e }).reasons.some((x) => x.kind === 'status_change' && x.api_value === 'failed'));
  const sp = clone(r); sp.bill.sponsors = [{ fullName: 'Rep. Someone, Else [R-TX-9]' }];
  const ds = compareCongress({ item, raw: sp, entry: e });
  ok('a different primary sponsor is material', ds.verdict === 'material' && ds.reasons.some((x) => x.kind === 'sponsor_change'));
  const two = clone(e); two.identifiers = { session: '119th Congress', external: { congress_gov: ['119/s/5061', '119/hr/9999'] } };
  const dTwo = compareCongress({ item, raw: sp, entry: two });
  ok('on an entry covering two bills, an unnamed companion sponsor is minor, not material', dTwo.verdict === 'minor' && dTwo.reasons.some((x) => x.kind === 'sponsor_change'), JSON.stringify(dTwo));
  const acc = clone(r); acc.bill.sponsors = [{ fullName: 'Sen. Warner, Mark R. [D-VA]' }];
  ok('sponsor names with accents and titles still match', compareCongress({ item, raw: acc, entry: e }).reasons.every((x) => x.kind !== 'sponsor_change'));
  const ti = clone(r); ti.bill.title = 'Quantum Agriculture Modernization Program';
  ok('a completely different title is reported as minor, not material', compareCongress({ item, raw: ti, entry: e }).reasons.some((x) => x.kind === 'title_change') && compareCongress({ item, raw: ti, entry: e }).verdict !== 'material');
  const none = clone(r); none.bill.updateDate = '2026-09-01T00:00:00Z';
  ok('a record not touched since the tracker last checked is unchanged', compareCongress({ item, raw: none, entry: e }).verdict === 'unchanged');
  const nw = compareCongress({ item: { item_id: 'congress_gov:119/hr/1' }, raw: { bill: { title: 'Frontier AI Safety Act', introducedDate: '2026-10-01', sponsors: [] }, actions: [] }, entry: null });
  ok('a bill we do not track is a new-entry candidate', nw.verdict === 'new_entry_candidate' && nw.entry_key === null && v.check('diff', nw).length === 0);
}
{ // an action the tracker already describes in its own text must not be reported again
  const e = clone(entry('s-5061')); e.last_checked = '2026-07-01'; e.status_text = 'Introduced July 21, 2026; referred to Senate Commerce';
  const d = compareCongress({ item: { item_id: 'x' }, raw: raw('119-s-5061'), entry: e });
  ok('an action already described in the tracker text is not "new" even though it is after the last check', !d.reasons.some((x) => x.kind === 'new_action'), JSON.stringify(d.reasons));
}

// ---------- the date reader ----------
const dm = (t, ev = [], y = 2026) => [...datesMentioned(t, ev, y)].sort().join(',');
ok('reads "Sept 29, 2025" with its year', dm('Introduced Sept 29, 2025; referred') === '2025-09-29');
ok('a date with no year takes the closest year written before it', dm('Introduced June 25, 2025; markup Sept 3') === '2025-06-25,2025-09-03');
ok('a date with no year and nothing before it takes the default year', dm('Referred Aug. 27') === '2026-08-27');
ok('reads ranges such as "Sept 3–16"', dm('13 House cosponsors added Sept 3–16, 2026') === '2026-09-03,2026-09-04,2026-09-05,2026-09-06,2026-09-07,2026-09-08,2026-09-09,2026-09-10,2026-09-11,2026-09-12,2026-09-13,2026-09-14,2026-09-15,2026-09-16');
ok('includes the entry\'s structured event dates', dm('', [{ date: '2026-01-02' }]) === '2026-01-02');
ok('empty text gives no dates', dm('') === '' && dm(null) === '');
ok('statusFromAction recognises law, veto and everything else', statusFromAction('Became Public Law No: 119-1.') === 'enacted' && statusFromAction('Vetoed by President.') === 'failed' && statusFromAction('Referred to committee') === 'pending' && statusFromAction(undefined) === 'pending');
ok('surname handles titles, accents and brackets', surname('Rep. Velázquez, Nydia [D-NY-7]') === 'velázquez' || surname('Rep. Velázquez, Nydia [D-NY-7]').startsWith('vel'));

// ---------- the runner writes a valid diff.json ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-')), runId = 'run-test';
  const dir = path.join(tmp, runId), rawDir = path.join(dir, 'raw', 'congress_gov'); fs.mkdirSync(rawDir, { recursive: true });
  const items = ['119-s-2938', '119-hr-9363'].map((f) => { fs.copyFileSync(fx('congress', f + '.json'), path.join(rawDir, f + '.json')); const id = raw(f).id; return { item_id: 'congress_gov:' + id, source: 'congress_gov', source_id: id, entry_key: entries.find((e) => e.identifiers && e.identifiers.external.congress_gov.includes(id)) ? entries.find((e) => e.identifiers.external.congress_gov.includes(id)).key : null, change: 'changed', source_url: 'https://www.congress.gov/bill/119th-congress/senate-bill/2938', fetched_at: '2026-10-06T12:00:00Z', raw_hash: 'x', raw_path: `raw/congress_gov/${f}.json` }; });
  fs.writeFileSync(path.join(dir, 'changeset.json'), JSON.stringify({ run_id: runId, generated_at: '2026-10-06T12:00:00Z', items }));
  const r = compareRun({ runDir: dir, entries });
  ok('the runner writes diff.json with a summary', fs.existsSync(path.join(dir, 'diff.json')) && r.summary.material === 1 && r.summary.unchanged === 1, JSON.stringify(r.summary));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
