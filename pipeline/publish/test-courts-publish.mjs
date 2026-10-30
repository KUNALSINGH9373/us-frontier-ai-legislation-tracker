// Court docket display (publish/courts.mjs): the real notice of appeal in Anthropic v. Department of War (N.D. Cal., Dkt. 253, filed
// 26 Oct 2026, recorded in fixtures/courts/) against the site data of 8 Oct 2026. The event and news show the operative clause, the
// parties named by rule; the court's full words stay in the clause and the evidence, never altered. No network.
//   node publish/test-courts-publish.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyCourts, partsOf, partiesOf, eventText, bodyQuote } from './courts.mjs';
import { loadData } from './run.mjs';
import { checkPublish } from './guards.mjs';
import { classifyEntry, docketUrl } from '../grabber/sources/courtlistener.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, '..', 'fixtures');
const KEY = 'fl-anthropic-v-department-of-war-n-d-cal';
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const entries = JSON.parse(fs.readFileSync(path.join(FX, 'courts', 'docket-entries-72379655.json'), 'utf8')).results;
const appeal = entries.find((x) => x.entry_number === 253), order = entries.find((x) => x.entry_number === 239);

// ---------- the rules ----------
{
  const c = classifyEntry(appeal), p = partsOf(c.full);
  ok('the notice of appeal splits into the operative clause, the filers and what is appealed', p.head === 'NOTICE OF APPEAL to the 9th Circuit Court of Appeals' && p.filers.length === 35 && p.filers[0] === 'Paul S. Atkins' && p.filers.includes('Robert F. Kennedy, Jr') && p.filers.at(-1) === 'Chris Wright' && p.rest === 'Appeal of Order on Motion for Summary Judgment, Order on Motion for Miscellaneous Relief, 250, Judgment 252, Order 251', JSON.stringify(p));
  ok('every part is the court\'s own words', c.full.includes(p.head) && c.full.includes(p.rest));
  ok('a long list with federal agencies is "the federal defendants"', partiesOf(p.filers, c.full) === 'the federal defendants');
  ok('a short list is named as written', partiesOf(['Anthropic PBC']) === 'Anthropic PBC' && partiesOf(['A', 'B']) === 'A and B');
  ok('a long federal list filed as plaintiffs is "the federal plaintiffs"', partiesOf(p.filers, 'Notice filed by Intervenor Plaintiff United States, x') === 'the federal plaintiffs');
  ok('a long private list: the first and a count', partiesOf(['Ann Lee', 'Bo Kim', 'Cy Fox', 'Di Ray']) === 'Ann Lee and 3 others');
  ok('an order names no filers', partsOf(classifyEntry(order).full) === null);
  // company suffixes and initials are not the end of the filer list
  const q = partsOf('MOTION to Dismiss filed by OpenAI, Inc., Microsoft Corp., Acme Holdings Ltd., Beta Labs LLC., Gamma L.L.C., U.S. Department of Commerce. Responses due by 11/2/2026 (Attachments: # 1 Exhibit)');
  ok('filers: Inc., Corp., Ltd., LLC., L.L.C. and U.S. do not end the list; the next sentence does', q && JSON.stringify(q.filers) === JSON.stringify(['OpenAI, Inc.', 'Microsoft Corp.', 'Acme Holdings Ltd.', 'Beta Labs LLC.', 'Gamma L.L.C.', 'U.S. Department of Commerce']) && q.rest === 'Responses due by 11/2/2026', JSON.stringify(q));
}

// ---------- the publish ----------
{
  const data = loadData(path.join(FX, 'publish', 'data-2026-10-08'));
  const found = [{ entry_key: KEY, docket_id: '72379655', court: 'N.D. Cal.', entry: appeal }];
  const a = applyCourts({ data, found, runDate: '2026-10-28', runId: 'update-20261028-1200', config: { news_from_official_actions: true } });
  const e = a.data.entries.find((x) => x.key === KEY), v = e.events.find((x) => x.date === '2026-10-26'), c = classifyEntry(appeal);
  ok('the event shows the operative clause and what is appealed, not the party list', v && v.text === eventText(c) && /^Notice of appeal to the 9th Circuit/.test(v.text) && /Judgment 252/.test(v.text) && !v.text.includes('Atkins'), v && v.text);
  ok('the event keeps the court\'s full words in its clause, and the evidence quotes them whole', v.clause === c.full && e.evidence.some((x) => x.field === 'events' && x.quote === c.full));
  const n = a.data.news.items.find((x) => x.tracker === KEY && x.date === '2026-10-26');
  ok('the news body quotes the operative clause and names the filers by rule', n && n.body === `The court docket (N.D. Cal.) records this entry in ${e.title} on Oct 26, 2026: "NOTICE OF APPEAL to the 9th Circuit Court of Appeals", filed by the federal defendants: "Appeal of Order on Motion for Summary Judgment, Order on Motion for Miscellaneous Relief, 250, Judgment 252, Order 251".`, n && n.body);
  ok('every quoted span in the body is the court\'s words, unaltered', [...n.body.matchAll(/"([^"]+)"/g)].every((m) => c.full.includes(m[1])));
  ok('the news evidence keeps the full docket text', n.evidence[0].quote === c.full && n.links[0].u === docketUrl('72379655'));
  const problems = checkPublish({ before: data, after: { ...a.data, relationships: data.relationships }, runDate: '2026-10-28', maxEntries: 15 }).problems;
  ok('it passes every guard', problems.length === 0, problems.join('; '));
  const again = applyCourts({ data: { ...a.data, relationships: data.relationships }, found, runDate: '2026-10-28', runId: 'x' });
  ok('the same docket entry is not added twice', again.touched.length === 0 && again.skipped.some((s) => /253/.test(s.why)));
}
{
  // an order: no filers, so the whole text is the operative clause (as before)
  const data = loadData(path.join(FX, 'publish', 'data-2026-10-08'));
  const a = applyCourts({ data, found: [{ entry_key: KEY, docket_id: '72379655', court: 'N.D. Cal.', entry: order }], runDate: '2026-10-28', runId: 'x', config: {} });
  const n = a.data.news.items.find((x) => x.tracker === KEY && x.date === '2026-07-20'), c = classifyEntry(order);
  ok('an order that does not rule on a dispositive motion (Dkt. 239, a proposed-order instruction) gets no news item', !n && c && c.news === false);
  ok('an order: the event is the label and the trimmed words', a.data.entries.find((x) => x.key === KEY).events.some((x) => x.date === '2026-07-20' && x.text.startsWith('Court order: ORDER. By July 24, 2026')));
}
{
  // a classifier that gives an operative clause: it is used as given, for the event and the quote
  const c = { ...classifyEntry(appeal), operative: 'NOTICE OF APPEAL to the 9th Circuit Court of Appeals' };
  ok('the operative clause is shown on the event but never quoted: every quoted span is the court\'s own words', eventText(c) === c.operative && [...bodyQuote({ ...c, operative: 'A LABEL NOT IN THE DOCKET' }).matchAll(/"([^"]+)"/g)].every((m) => c.full.includes(m[1])));
  ok('without it: label and the court\'s words', eventText(classifyEntry(order)).startsWith('Court order: ORDER.'));
}

console.log(`courts publish: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
