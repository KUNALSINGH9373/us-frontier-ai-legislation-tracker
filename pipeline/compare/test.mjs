// Run:  node compare/test.mjs   (or npm run test:compare)
// Uses real Congress.gov records saved from a live check (fixtures/congress) plus a few made-up cases for situations
// that have not happened yet (a bill becoming law, a different sponsor).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareCongress, datesMentioned, statusFromAction, surname, actionKind } from './congress.mjs';
import { compareRun } from './run.mjs';
import { compareLegiScan } from './legiscan.mjs';
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

// ---------- which Congress actions are milestones (actionKind) ----------
{
  const kinds = JSON.parse(fs.readFileSync(fx('congress', 'action-kinds.json'), 'utf8')).kinds;
  const all = Object.entries(kinds).flatMap(([k, texts]) => texts.map((t) => [k, t]));
  const wrong = all.filter(([k, t]) => actionKind(t).kind !== k);
  ok(`every distinct action text in the stored Congress.gov records (${all.length}) has its reviewed kind`, all.length >= 90 && !wrong.length, wrong.map(([k, t]) => `${t} -> ${actionKind(t).kind}, want ${k}`).join(' | '));
  ok('procedural kinds are never milestones and have no event type; milestone kinds always have one', all.every(([k, t]) => { const a = actionKind(t); return k === 'procedural' ? !a.milestone && a.type === null && a.importance === 0 : a.milestone && !!a.type && a.importance > 0; }));
  const K = (t) => actionKind(t).kind;
  const proc = ['Cloture motion on the motion to proceed not agreed to', 'Amendment SA 1234 not agreed to in Senate by Yea-Nay Vote. 45 - 52.', 'Motion to reconsider laid on the table Agreed to without objection.', 'Held at the desk.', 'Message on Senate action sent to the House.',
    'Sponsor introductory remarks on measure. (CR S4512)', 'Star Print ordered on the reported bill.', 'Cloture on the motion to proceed to the measure invoked in Senate by Yea-Nay Vote. 68 - 30.', 'Motion to proceed to consideration of measure agreed to in Senate by Unanimous Consent.',
    'S.Amdt.3001 Amendment SA 3001 proposed by Senator Cruz.', 'Amendment SA 3001 agreed to in Senate by Unanimous Consent.', 'H.Amdt.512 Amendment (A003) offered by Mr. Obernolte.', 'On agreeing to the Obernolte amendment (A003) Agreed to by voice vote.', 'Motion to table the motion to recommit agreed to.',
    'On motion to recommit Failed by the Yeas and Nays: 200 - 215.', 'Motion to reconsider laid on the table Agreed to without objection.', 'Presented to President.', 'Cleared for White House.', 'Placed on the Union Calendar, Calendar No. 741.', 'Received in the Senate.', 'Veto message received in Senate.'];
  const badProc = proc.filter((t) => K(t) !== 'procedural');
  ok('procedural steps from the review (cloture, amendments, motions, held at the desk, messages, remarks, star prints) are not milestones', !badProc.length, badProc.join(' | '));
  ok('"not agreed to" and "failed" never mean passage', ['Cloture motion on the motion to proceed not agreed to', 'Amendment SA 1234 not agreed to', 'On motion to recommit Failed by the Yeas and Nays: 200 - 215.', 'On passage Failed by the Yeas and Nays: 190 - 230.', 'On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: 250 - 170.', 'Resolution not agreed to in Senate by Yea-Nay Vote. 40 - 58.'].every((t) => K(t) !== 'passed' && actionKind(t).type !== 'Passed / advanced'));
  ok('a failed vote on the bill itself is a failed passage (a milestone), not a procedural step', K('On passage Failed by the Yeas and Nays: 190 - 230.') === 'failed_passage' && K('On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: 250 - 170.') === 'failed_passage' && K('Failed of passage in Senate by Yea-Nay Vote. 45 - 53.') === 'failed_passage');
  ok('chamber passage, in Senate and House wordings', ['Passed Senate with an amendment by Unanimous Consent.', 'Passed/agreed to in House: On passage Passed by the Yeas and Nays: 300 - 120.', 'On passage Passed without objection.', 'Passed House (Amended) by Yea-Nay Vote. 250 - 170.', 'On motion to suspend the rules and pass the bill, as amended Agreed to by the Yeas and Nays: (2/3 required): 380 - 30.', 'Submitted in the Senate, considered, and agreed to without amendment and with a preamble by Unanimous Consent.', 'Resolution agreed to in House.', 'On motion that the House agree to the Senate amendment Agreed to without objection.'].every((t) => K(t) === 'passed'));
  ok('reported and ordered reported', K('Ordered to be Reported by the Yeas and Nays: 22 - 0.') === 'reported' && K('Committee on Commerce, Science, and Transportation. Reported by Senator Cruz with amendments. With written report No. 119-154.') === 'reported' && K('Reported (Amended) by the Committee on Small Business. H. Rept. 119-851.') === 'reported' && K('Committee on Energy and Natural Resources. Ordered to be reported without amendment favorably.') === 'reported');
  ok('hearings and markups', K('Committee on Homeland Security and Governmental Affairs. Hearings held.') === 'hearing' && K('Subcommittee Hearings Held') === 'hearing' && K('Committee Consideration and Mark-up Session Held') === 'markup' && K('Subcommittee Consideration and Mark-up Session Held') === 'markup');
  ok('introduced and referred', K('Introduced in House') === 'introduced' && K('Submitted in Senate') === 'introduced' && K('Read twice and referred to the Committee on Finance.') === 'referred' && K('Referred to the Subcommittee on Oversight and Investigations.') === 'referred');
  ok('signed, became law, vetoed and veto override', K('Became Public Law No: 119-77.') === 'enacted' && K('Signed by President.') === 'enacted' && K('Vetoed by President.') === 'vetoed' && K('Pocket Vetoed by President.') === 'vetoed' && K('Passed Senate over veto by Yea-Nay Vote. 70 - 28.') === 'veto_override' && K('On passage, the objections of the President to the contrary notwithstanding Passed by the Yeas and Nays: (2/3 required): 300 - 120.') === 'veto_override' && K('On passage, the objections of the President to the contrary notwithstanding Failed by the Yeas and Nays: (2/3 required): 250 - 170.') === 'failed_passage');
  const imp = (t) => actionKind(t).importance;
  ok('importance orders a date: law > override > veto > passage > failed vote > reported > markup > hearing > introduced > referred > procedural', imp('Became Public Law No: 119-77.') > imp('Passed Senate over veto by Yea-Nay Vote. 70 - 28.') && imp('Passed Senate over veto by Yea-Nay Vote. 70 - 28.') > imp('Vetoed by President.') && imp('Vetoed by President.') > imp('Passed Senate with an amendment by Unanimous Consent.') && imp('Passed Senate with an amendment by Unanimous Consent.') > imp('On passage Failed by the Yeas and Nays: 190 - 230.') && imp('On passage Failed by the Yeas and Nays: 190 - 230.') > imp('Ordered to be Reported by the Yeas and Nays: 22 - 0.') && imp('Ordered to be Reported by the Yeas and Nays: 22 - 0.') > imp('Committee Consideration and Mark-up Session Held') && imp('Committee Consideration and Mark-up Session Held') > imp('Committee on Energy and Natural Resources. Hearings held.') && imp('Committee on Energy and Natural Resources. Hearings held.') > imp('Introduced in House') && imp('Introduced in House') > imp('Referred to the House Committee on Armed Services.') && imp('Referred to the House Committee on Armed Services.') > imp('Held at the desk.'));
  ok('statusFromAction: a failed override and a veto message are not a veto; an override is not a veto', statusFromAction('Passed Senate over veto by Yea-Nay Vote. 70 - 28.') === 'pending' && statusFromAction('Veto message received in Senate.') === 'pending' && statusFromAction('Pocket Vetoed by President.') === 'failed');
}
{ // compareCongress: only milestones are material; a veto on a multi-bill entry is minor; a veto followed by an override is not final
  const r = raw('119-s-5061'), e = entry('s-5061'), item = { item_id: 'x' };
  const proc = clone(r); proc.bill.updateDate = '2026-10-06T00:00:00Z'; proc.actions.unshift({ actionDate: '2026-10-05', text: 'Held at the desk.' }, { actionDate: '2026-10-05', text: 'Message on Senate action sent to the House.' }, { actionDate: '2026-10-06', text: 'Cloture motion on the motion to proceed not agreed to in Senate by Yea-Nay Vote. 45 - 52.' });
  const dp = compareCongress({ item, raw: proc, entry: e });
  ok('procedural actions alone are minor (a record_updated note), never material', dp.verdict === 'minor' && dp.reasons.filter((x) => x.kind === 'record_updated' && /procedural step/.test(x.detail)).length === 3 && !dp.reasons.some((x) => x.kind === 'new_action'), JSON.stringify(dp));
  const mix = clone(r); mix.actions.unshift({ actionDate: '2026-10-05', text: 'Motion to reconsider laid on the table Agreed to without objection.' }, { actionDate: '2026-10-05', text: 'Passed Senate with an amendment by Unanimous Consent.' }, { actionDate: '2026-10-05', text: 'Amendment SA 1234 not agreed to in Senate by Voice Vote.' });
  const dm2 = compareCongress({ item, raw: mix, entry: e });
  ok('on a date with a passage and procedural lines, only the passage is material', dm2.verdict === 'material' && dm2.reasons.filter((x) => x.kind === 'new_action').length === 1 && /Passed Senate/.test(dm2.reasons.find((x) => x.kind === 'new_action').api_value), JSON.stringify(dm2.reasons));
  const vet = clone(r); vet.bill.latestAction = { actionDate: '2026-10-05', text: 'Vetoed by President.' }; vet.actions.unshift({ actionDate: '2026-10-05', text: 'Vetoed by President.' });
  const two = clone(e); two.identifiers = { session: '119th Congress', external: { congress_gov: ['119/s/5061', '119/hr/9999'] } };
  const dv = compareCongress({ item, raw: vet, entry: two });
  ok('a veto of one bill on a multi-bill entry is minor (companion_status), not a status change', !dv.reasons.some((x) => x.kind === 'status_change') && dv.reasons.some((x) => x.kind === 'companion_status'), JSON.stringify(dv));
  ok('billsOfEntry > 1 also makes a veto minor', !compareCongress({ item, raw: vet, entry: e, billsOfEntry: 2 }).reasons.some((x) => x.kind === 'status_change'));
  ok('a veto of the entry\'s only bill is still a status change to failed', compareCongress({ item, raw: vet, entry: e }).reasons.some((x) => x.kind === 'status_change' && x.api_value === 'failed'));
  const ov = clone(vet); ov.actions.unshift({ actionDate: '2026-10-05', text: 'Passed Senate over veto by Yea-Nay Vote. 70 - 28.' });
  const dov = compareCongress({ item, raw: ov, entry: e });
  ok('a veto followed by an override vote is not final: no status change to failed, the override is material', !dov.reasons.some((x) => x.kind === 'status_change') && dov.reasons.some((x) => x.kind === 'new_action' && /over veto/.test(x.api_value)), JSON.stringify(dov.reasons));
  ok('every new verdict passes its schema', [dp, dm2, dv, dov].every((d) => v.check('diff', d).length === 0), [dp, dm2, dv, dov].map((d) => v.check('diff', d).join(';')).join(' | '));
}
{ // compareLegiScan re-derives events with the current rules: an old record's "Amendment No. 2 failed" event is not material
  const e = { key: 'x', status: 'pending', last_checked: '2026-10-01', status_text: 'Introduced Jan 5, 2026', events: [] };
  const old = { bill: { state: 'CA', bill_number: 'SB1', status: 1, history: [{ date: '2026-10-05', action: 'Amendment No. 2 failed', chamber: 'S' }, { date: '2026-10-05', action: 'Withdrawn from committee.', chamber: 'S' }] },
    derived: { status: 'pending', events: [{ date: '2026-10-05', type: 'Vetoed / failed / rescinded', text: 'Amendment No. 2 failed' }] } };
  const d = compareLegiScan({ item: { item_id: 'legiscan:1' }, raw: old, entry: e });
  ok('LegiScan: an amendment failing and a withdrawal from committee are minor, even when an old record calls them failures', d.verdict === 'minor' && !d.reasons.some((x) => x.kind === 'new_action'), JSON.stringify(d));
  const real = clone(old); real.bill.history.push({ date: '2026-10-05', action: 'Failed passage in committee', chamber: 'S' });
  ok('LegiScan: the bill\'s own failed passage on that date is material', compareLegiScan({ item: { item_id: 'legiscan:1' }, raw: real, entry: e }).reasons.some((x) => x.kind === 'new_action' && /Failed passage/.test(x.api_value)));
}
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
