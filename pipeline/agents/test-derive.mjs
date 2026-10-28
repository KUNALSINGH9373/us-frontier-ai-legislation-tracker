// Run:  node agents/test-derive.mjs   (or npm run test:derive)
// What code derives exactly from the official record, using real saved records.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { deriveCreate, sponsorText, longDate, stateNumber, stateSponsorText, stateStatus, stateSections, eventFor, actionKind } from './derive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const J = (...p) => JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', ...p), 'utf8'));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };

ok('dates use the tracker\'s own month spellings', longDate('2026-09-29') === 'Sept 29, 2026' && longDate('2026-06-05') === 'June 5, 2026' && longDate('2026-07-01') === 'July 1, 2026' && longDate('2026-01-09') === 'Jan 9, 2026');
ok('sponsor names are turned into the tracker\'s style', sponsorText([{ fullName: 'Sen. Sanders, Bernard [I-VT]' }]) === 'Sen. Bernard Sanders (I-VT)' && sponsorText([{ fullName: 'Rep. Obernolte, Jay [R-CA-23]' }]) === 'Rep. Jay Obernolte (R-CA)');
ok('no sponsor gives null, an unrecognised format is kept as written', sponsorText([]) === null && sponsorText([{ fullName: 'Someone Unusual' }]) === 'Someone Unusual');

const eo = deriveCreate({ item: { source: 'federal_register' }, raw: J('federal-register', '2026-20321.json') });
ok('executive order: title, short name, sponsor and section', eo.fields.title === 'Executive Order 14434: Inaugurating the Era of Super Intelligence' && eo.fields.short_name === 'EO 14434 (Inaugurating the Era of Super Intelligence)' && eo.fields.sponsor_text === 'President' && eo.section === 'G');
ok('executive order: signing and publication dates and the status line', eo.fields.signed_text === 'Sept 29, 2026' && /^Signed Sept 29, 2026; published in the Federal Register Oct 2, 2026/.test(eo.fields.status_text));
ok('executive order: two events, signing then publication', eo.events.length === 2 && eo.events[0].type === 'Signed / enacted' && eo.events[0].date === '2026-09-29' && eo.events[1].type === 'Introduced / published' && eo.events[1].date === '2026-10-02');
{
  const raw = J('federal-register', '2026-20321.json'); raw.document.signing_date = null;
  const d = deriveCreate({ item: { source: 'federal_register' }, raw });
  ok('if the signing date field is missing it is read from the text "Executive Order 14434 of September 29, 2026"', d.events[0].date === '2026-09-29' && d.fields.signed_text === 'Sept 29, 2026');
}
{
  const raw = J('federal-register', '2026-20321.json'); raw.document.type = 'Rule'; raw.document.executive_order_number = null; raw.document.signing_date = null; raw.document.effective_on = '2026-12-01'; raw.document.agency_names = ['Commerce Department', 'Industry and Security Bureau']; raw.text = 'A rule.';
  const d = deriveCreate({ item: { source: 'federal_register' }, raw });
  ok('a rule: sponsor is the agencies, section G.3 for the Bureau of Industry and Security, effective date and event included', d.fields.sponsor_text === 'Commerce Department; Industry and Security Bureau' && d.section === 'G.3' && d.fields.effective_text === 'Dec 1, 2026' && d.events.some((e) => e.type === 'Effective' && e.date === '2026-12-01') && /effective Dec 1, 2026/.test(d.fields.status_text));
  const raw2 = J('federal-register', '2026-20321.json'); raw2.document.type = 'Notice'; raw2.document.executive_order_number = null; raw2.document.agency_names = ['Some Agency'];
  ok('an ordinary notice has no rule-based section', deriveCreate({ item: { source: 'federal_register' }, raw: raw2 }).section === null);
}

const bill = deriveCreate({ item: { source: 'congress_gov' }, raw: J('congress', '119-s-5493.json') });
ok('bill: title and short name carry the citation', bill.fields.title === 'S. 5493 — Ban Artificial Superintelligence Act of 2026' && bill.fields.short_name === 'S. 5493 Ban Artificial Superintelligence Act of 2026');
ok('bill: sponsor in the tracker\'s style, and no section (a person or the model decides D or F)', bill.fields.sponsor_text === 'Sen. Bernard Sanders (I-VT)' && bill.section === null);
ok('bill: status line states the introduction and the latest action', bill.fields.status_text === 'Introduced / status: Sept 23, 2026; Read twice and referred to the Committee on Commerce, Science, and Transportation (Sept 23, 2026)', bill.fields.status_text);
ok('bill: the introduction is an event; a same-day referral is not duplicated', bill.events.length === 1 && bill.events[0].type === 'Introduced / published');
{
  const hearing = deriveCreate({ item: { source: 'congress_gov' }, raw: J('congress', '119-s-2938.json') });
  ok('bill: a later latest action becomes an event of the right kind', hearing.events.length === 2 && hearing.events[1].type === 'Referred / stalled / hearing' && hearing.events[1].date === '2026-09-30', JSON.stringify(hearing.events));
  const lawRaw = J('congress', '119-s-5061.json'); lawRaw.bill.latestAction = { actionDate: '2026-10-05', text: 'Became Public Law No: 119-77.' };
  ok('bill: becoming law is a Signed / enacted event', deriveCreate({ item: { source: 'congress_gov' }, raw: lawRaw }).events.some((e) => e.type === 'Signed / enacted'));
}
{ // procedural Congress actions are never "Passed / advanced" (eventFor uses compare/congress.mjs actionKind)
  ok('eventFor: cloture, a rejected amendment and a motion to reconsider are not events', [
    'Cloture motion on the motion to proceed not agreed to in Senate by Yea-Nay Vote. 45 - 52.', 'Amendment SA 1234 not agreed to in Senate by Yea-Nay Vote. 45 - 52.', 'Motion to reconsider laid on the table Agreed to without objection.',
    'Held at the desk.', 'Message on Senate action sent to the House.', 'Sponsor introductory remarks on measure. (CR S4512)'].every((t) => eventFor({ text: t }) === null));
  ok('eventFor: milestones keep their event types', eventFor({ text: 'On passage Passed by the Yeas and Nays: 300 - 120.' }) === 'Passed / advanced' && eventFor({ text: 'Ordered to be Reported by the Yeas and Nays: 22 - 0.' }) === 'Passed / advanced' && eventFor({ text: 'Committee on Energy and Natural Resources. Hearings held.' }) === 'Referred / stalled / hearing' && eventFor({ text: 'Became Public Law No: 119-77.' }) === 'Signed / enacted' && eventFor({ text: 'Vetoed by President.' }) === 'Vetoed / failed / rescinded' && eventFor({ text: 'On passage Failed by the Yeas and Nays: 190 - 230.' }) === 'Vetoed / failed / rescinded');
  ok('actionKind is re-exported for tier-a', actionKind('Held at the desk.').milestone === false && actionKind('Passed Senate with an amendment by Unanimous Consent.').importance === 80);
  const desk = J('congress', '119-s-2938.json'); desk.bill.latestAction = { actionDate: '2026-10-02', text: 'Held at the desk.' };
  const d = deriveCreate({ item: { source: 'congress_gov' }, raw: desk });
  ok('bill: a procedural latest action is neither the status line nor an event; the latest milestone is', /Hearings held/.test(d.fields.status_text) && !/desk/.test(d.fields.status_text) && !d.events.some((e) => /desk/.test(e.text)), d.fields.status_text);
}
let err; try { deriveCreate({ item: { source: 'unknown' }, raw: {} }); } catch (e) { err = e; }
ok('an unknown source is an error, not a guess', !!err);

// ---------- state bills (LegiScan records saved by the grabber, fixtures/legiscan) ----------
ok('state bill numbers in the tracker\'s styles', JSON.stringify([stateNumber('SB00086'), stateNumber('S10373'), stateNumber('HB4098'), stateNumber('LB1185')]) === JSON.stringify([{ dotted: 'S.B. 86', short: 'SB 86' }, { dotted: 'S.10373', short: 'S.10373' }, { dotted: 'H.B. 4098', short: 'HB 4098' }, { dotted: 'L.B. 1185', short: 'LB 1185' }]));
{
  const bills = J('legiscan', 'bills.json'), ut = J('legiscan', 'candidates', 'UT-SB0205-2094829.json').bill;
  ok('state sponsors: primary first with party, co-sponsors counted, joint sponsors named', stateSponsorText(bills['NY-S10373'].sponsors) === 'Sen. Andrew Gounardes (D)' && stateSponsorText(ut.sponsors) === 'Sen. Stephanie Pitcher (D); joint sponsor Rep. Matthew Gwynn (R)', `${stateSponsorText(bills['NY-S10373'].sponsors)} | ${stateSponsorText(ut.sponsors)}`);
  ok('state sponsors: co-sponsors are counted in fixed wording, a committee is named alone, none gives null', stateSponsorText([{ role: 'Rep', name: 'A B', party: 'R', sponsor_type_id: 1, sponsor_order: 1 }, { role: 'Rep', name: 'C D', party: 'D', sponsor_type_id: 2, sponsor_order: 2 }, { role: 'Rep', name: 'E F', party: 'D', sponsor_type_id: 2, sponsor_order: 3 }]) === 'Rep. A B (R) with 2 co-sponsors' && stateSponsorText([{ name: 'General Law Committee', committee_sponsor: 1, sponsor_type_id: 1 }]) === 'General Law Committee' && stateSponsorText([]) === null);
  ok('state status by the comparison step\'s rule: passed = enacted, vetoed or failed = failed, else pending', stateStatus(bills['CA-SB53']) === 'enacted' && stateStatus({ status: 5 }) === 'failed' && stateStatus({ status: 6 }) === 'failed' && stateStatus(bills['NY-S10373']) === 'pending' && stateStatus({ status: 2 }) === 'pending');
  ok('state sections by status: an enacted bill A or C, any other B, B.2 or C', stateSections('enacted').join() === 'A,C' && stateSections('pending').join() === 'B,B.2,C' && stateSections('failed').join() === 'B,B.2,C');
  const ca = deriveCreate({ item: { source: 'legiscan' }, raw: { bill: bills['CA-SB53'] } });
  ok('an enacted state bill: status enacted, its sections A or C, the chaptering as the last action', ca.status === 'enacted' && ca.sections.join() === 'A,C' && ca.section === null && /Chaptered by Secretary of State\. Chapter 138, Statutes of 2025 \(Sept 29, 2025\)$/.test(ca.fields.status_text) && ca.events.some((e) => e.type === 'Signed / enacted' && e.date === '2025-09-29'), ca.fields.status_text);
  const ny = deriveCreate({ item: { source: 'legiscan' }, raw: { bill: bills['NY-S10373'] } });
  ok('a one-action state bill: introduced and referred the same day, one status clause', ny.fields.title.startsWith('S.10373 — ') && ny.fields.short_name === 'NY S.10373' && ny.jurisdiction === 'NY' && ny.state === 'NY' && ny.session === '2025-2026 General Assembly' && /^Status: Introduced May 15, 2026/.test(ny.fields.status_text), `${ny.fields.short_name} | ${ny.fields.status_text} | ${ny.session}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
