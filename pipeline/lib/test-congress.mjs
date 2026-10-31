// Which Congress a date, a bill or an entry belongs to (lib/congress.mjs), and every place that used to write "119" in. Code only.
//   node lib/test-congress.mjs
import { congressOn, congressesBetween, ordinal, sessionLabel, congressOfId, congressOfEntry } from './congress.mjs';
import { proposeIds } from '../grabber/map-ids.mjs';
import { assembleEntry } from '../agents/assemble.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail === undefined ? '' : detail); } };

ok('the 119th Congress runs from 3 Jan 2025 to 2 Jan 2027', congressOn('2025-01-03') === 119 && congressOn('2026-10-31') === 119 && congressOn('2027-01-02T23:59:00Z') === 119);
ok('the day before it is the 118th', congressOn('2025-01-02') === 118);
ok('the 120th begins on 3 Jan 2027, the 121st on 3 Jan 2029', congressOn('2027-01-03') === 120 && congressOn('2028-12-31') === 120 && congressOn('2029-01-03') === 121);
ok('a run window spanning 3 January lists both Congresses; a normal one lists one', congressesBetween('2027-01-01T00:00:00Z', '2027-01-05T00:00:00Z').join() === '119,120' && congressesBetween('2026-10-19', '2026-10-28').join() === '119');
ok('ordinals', ['111th', '112th', '113th', '119th', '120th', '121st', '122nd', '123rd'].join() === [111, 112, 113, 119, 120, 121, 122, 123].map(ordinal).join() && sessionLabel(120) === '120th Congress');
ok('a bill id names its Congress', congressOfId('120/hr/12') === 120 && congressOfId('S. 5') === null);
ok('an entry\'s Congress: its stored session, else its earliest event', congressOfEntry({ identifiers: { session: '119th Congress' }, events: [{ date: '2027-02-01' }] }) === 119 && congressOfEntry({ events: [{ date: '2027-02-01' }, { date: '2027-01-20' }] }) === 120 && congressOfEntry({}) === null);

// map-ids: a 120th-Congress entry is looked up as 120/..., a tracked 119th one as 119/...
ok('map-ids proposes each entry\'s own Congress', proposeIds({ title: 'H.R. 12 — A bill', short_name: 'H.R. 12', events: [{ date: '2027-01-15' }] }).join() === '120/hr/12' && proposeIds({ title: 'S. 4656 — A bill', short_name: 'S. 4656', identifiers: { session: '119th Congress' } }).join() === '119/s/4656');
ok('map-ids falls back to the current Congress for an entry with no session or event', proposeIds({ title: 'S. 9 — A bill', short_name: 'S. 9' }, new Date('2027-03-01')).join() === '120/s/9');

// a new federal entry's session is its own Congress, read from its id
const raw = { bill: { congress: 120, type: 'HR', number: '12', title: 'Frontier Model Safety Act', introducedDate: '2027-01-15', sponsors: [{ fullName: 'Rep. Alex Rivera [D-OK-1]', party: 'D', state: 'OK', bioguideId: 'R000001' }], actions: [], latestAction: { actionDate: '2027-01-15', text: 'Referred to the Committee on Energy and Commerce.' } }, text: 'A developer of a frontier model trained using more than 10^26 operations shall publish a safety plan.' };
const item = { item_id: 'congress_gov:120/hr/12', source: 'congress_gov', source_id: '120/hr/12', source_url: 'https://www.congress.gov/bill/120th-congress/house-bill/12', fetched_at: '2027-01-16T00:00:00Z' };
const patch = { operation: 'create', in_scope: true, fields: { mechanism: 'A developer of a frontier model must publish a safety plan.', section: 'D' }, events_add: [], evidence: [{ field: 'mechanism', quote: 'A developer of a frontier model trained using more than 10^26 operations shall publish a safety plan.' }], notes: '' };
const asm = assembleEntry({ entry: null, patch, item, raw, today: '2027-01-16', runId: 't', rounds: 1, entries: [], now: new Date('2027-01-16T00:00:00Z') });
ok('a new 120th-Congress entry is labelled "120th Congress", not 119th', asm.entry && asm.entry.identifiers.session === '120th Congress', JSON.stringify(asm.problems || (asm.entry && asm.entry.identifiers)));

console.log(`congress: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
