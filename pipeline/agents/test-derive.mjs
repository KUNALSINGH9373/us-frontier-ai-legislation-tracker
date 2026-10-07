// Run:  node agents/test-derive.mjs   (or npm run test:derive)
// What code derives exactly from the official record, using real saved records.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { deriveCreate, sponsorText, longDate } from './derive.mjs';

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
let err; try { deriveCreate({ item: { source: 'unknown' }, raw: {} }); } catch (e) { err = e; }
ok('an unknown source is an error, not a guess', !!err);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
