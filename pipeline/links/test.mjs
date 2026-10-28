// Run:  node links/test.mjs
// The links step with scripted models (no AI, no network) on copies of the real site data: the code proposer finds sponsor and
// amendment links with zero false links on the real network (backtest), AI links need both quotes and the validator, applying
// only ever adds, the stop rules refuse any other change to the network, and the link map can draw everything added.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { proposeByCode, proposeByAI, propose, citations, clauses, leadSponsors, nodeFor, companions, LABEL, isApplicable, recordProofProblem } from './propose.mjs';
import { recordUrl, loadActorIds, nodeOfId, recordBillProblem } from './records.mjs';
import { matchActorIds } from './actor-ids.mjs';
import { applyLinks, edgeOf } from './apply.mjs';
import { linkRun } from './run.mjs';
import { backtest, errorsOf, labelOk } from './backtest.mjs';
import { checkPublish, checkLinks } from '../publish/guards.mjs';
import { loadData } from '../publish/run.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { containsQuote } from '../agents/source-text.mjs';
import { formatReport } from '../report/format.mjs';
import { newReport, finalize } from '../report/build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const realData = path.join(here, '..', '..', 'web', 'data', 'v2');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const real = loadData(realData);
const { checkLinks: mapCheck } = await import(pathToFileURL(path.join(here, '..', '..', 'web', 'scripts', 'check-links.mjs')).href);
function scripted(fn) { return { calls: [], async generate(req) { this.calls.push(req); const r = fn(req, this.calls.length); if (r instanceof Error) throw r; return { data: r, usage: {} }; } }; }

// A new entry, shaped like the real ones, added to a copy of the data.
const RAISE = real.entries.find((e) => e.key === 'ny-raise-act-ch-699-ch-96');
function newEntry(o) {
  const base = clone(real.entries.find((e) => e.key === 'ny-s-10373-verification'));
  const ids = real.entries.map((e) => e.id);
  return { ...base, id: Math.max(...ids) + 1, key: 'test-new-bill', title: 'S.99999 — test bill', short_name: 'NY S.99999 (test)', sponsor_text: 'Sen. Jane Doe (D)', mechanism: 'Requires reports.', thresholds: null, sources: [{ label: 'text', url: 'https://www.nysenate.gov/legislation/bills/2025/S99999', kind: 'primary' }], identifiers: { ...base.identifiers, external: { legiscan: [99001] } }, ...o };
}
const withEntry = (e) => ({ ...clone(real), entries: [...clone(real.entries), e] });
// Official records shaped like the raw ones (trimmed to the fields the links step reads; no keys or tokens).
const lsRec = (state, people, billId = 99001) => ({ bill: { bill_id: billId, url: `https://legiscan.com/${state}/bill/S99999/2025`, state, sponsors: people.map((p, i) => ({ sponsor_type_id: 1, committee_sponsor: 0, name: `${p.first_name} ${p.last_name}`, ...p, sponsor_order: i + 1 })) } });
const cgRec = (people, number = 99999, type = 'S') => ({ bill: { congress: 119, type, number, sponsors: people } });
const GOUNARDES = { people_id: 20262, first_name: 'Andrew', last_name: 'Gounardes', role: 'Sen', party: 'D' };
const WIENER = { people_id: 18068, first_name: 'Scott', last_name: 'Wiener', role: 'Sen', party: 'D' };
const LIEU = { bioguideId: 'L000582', firstName: 'Ted', lastName: 'Lieu', fullName: 'Rep. Lieu, Ted [D-CA-36]', party: 'D', state: 'CA' };
const proseEdges = (r) => r.proposals.map(edgeOf);

// ---------- 1. the backtest on the real network: zero false links ----------
{
  const b = backtest({ entries: real.entries, relationships: real.relationships });
  ok('1 the code proposer makes no false link, no wrong direction and no wrong label on the real network (strict scoring)', errorsOf(b) === 0, [...b.falseLinks, ...b.wrongDirection, ...b.wrongLabel].map((f) => `${f.from} -> ${f.to} ${f.label}`).join(', '));
  ok('1 the only conflict is NYTERM -> RAISE against the hand-written RAISE -> NYTERM, whose label names its own from', b.conflicts.length === 1 && b.conflicts[0].from === 'NYTERM' && b.conflicts[0].to === 'RAISE', JSON.stringify(b.conflicts.map((c) => c.from + '>' + c.to)));
  ok('1 it recovers at least the 24 links it recovered on 28 Oct 2026 with full-name sponsor matching (23 sponsors, 1 amendment)', b.recovered.size >= 24, `recovered ${b.recovered.size}`);
  ok('1 every succession link it recovers is a bill amending the RAISE Act', [...b.recovered].filter((k) => k.endsWith('|succession')).every((k) => k.includes('RAISE')));
  const fresh = backtest({ entries: real.entries, relationships: real.relationships, asNew: true });
  ok('1 as brand-new bills (their node removed too) still no false link and the same recall', errorsOf(fresh) === 0 && fresh.recovered.size === b.recovered.size);
  const all = proposeByCode({ entries: real.entries, relationships: real.relationships, changed: real.entries.map((e) => e.key) });
  ok('1 on the full network nothing new is proposed (every true link is already there)', all.proposals.length === 0, JSON.stringify(all.proposals[0]));
}

// ---------- 2. code: amendments ----------
{
  ok('2 "Section 1422 of the General Business Law" is a GBL citation', citations('amends Section 1422 of the General Business Law').some((c) => c.code === 'gbl' && c.from === 1422));
  ok('2 "Gov. Code §§11549.80–.86" is a range', citations('(Gov. Code §§11549.80–.86)').some((c) => c.code === 'gov' && c.from === 11549.8 && c.to === 11549.86));
  ok('2 "chapter 93M" and "15 U.S.C. §278h-1" are read', citations('amends chapter 93M').some((c) => c.chapter === '93M') && citations('Amends the NIST Act (15 U.S.C. §278h-1)').some((c) => c.code === 'usc:15' && c.sec === '278h-1'));
  ok('2 abbreviations do not split clauses', clauses('Chapter 96 repeals the original Gen. Bus. Law Art. 44-B and enacts a new Art. 44-B (§§1420–1429). Next clause here').length === 2);
  const e = newEntry({ mechanism: 'Amends Section 1422 of the General Business Law to shorten the incident deadline to 48 hours' });
  const d = withEntry(e), r = proposeByCode({ entries: d.entries, relationships: d.relationships, changed: [e.key] });
  const p = r.proposals.find((x) => x.type === 'succession');
  ok('2 a NY bill amending GBL §1422 links to the RAISE Act', p && p.to === 'RAISE' && p.method === 'code', JSON.stringify(r.proposals));
  ok('2 the link quotes both texts word for word', p && p.evidence.length === 2 && containsQuote(e.mechanism, p.evidence[0].quote) && containsQuote(RAISE.title + '. ' + RAISE.mechanism, p.evidence[1].quote) && p.evidence.every((x) => x.source_url));
  ok('2 the new bill gets a node in the state-bills column', r.nodes[p.from] && r.nodes[p.from].column === 4 && r.nodes[p.from].entry_key === e.key);
  const named = newEntry({ mechanism: 'Amends the RAISE Act to add a whistleblower channel' });
  ok('2 naming the enacted law next to "amends" is enough', proposeByCode({ ...withEntry(named), relationships: real.relationships, changed: [named.key] }).proposals.some((x) => x.to === 'RAISE'));
  const neg = newEntry({ mechanism: 'A state order cannot amend the RAISE Act or GBL §1422; it asks the legislature to act' });
  ok('2 a negated amendment is no link', !proposeByCode({ ...withEntry(neg), relationships: real.relationships, changed: [neg.key] }).proposals.some((x) => x.type === 'succession'));
  const other = newEntry({ jurisdiction: 'MN', state: 'MN', mechanism: 'Amends Section 1422 of the General Business Law and the RAISE Act' });
  ok('2 a bill in another state never amends a NY law', !proposeByCode({ ...withEntry(other), relationships: real.relationships, changed: [other.key] }).proposals.some((x) => x.type === 'succession'));
  const ma = clone(real.entries.find((x) => x.key === 'ma-h-5576-s-3178'));
  const maBill = newEntry({ jurisdiction: 'MA', state: 'MA', short_name: 'MA S.9999 (test)', sponsor_text: 'Sen. Jane Doe (D)', mechanism: 'Amends chapter 93M to require quarterly reports' });
  ok('2 "amends chapter 93M" links to the MA bill that creates chapter 93M', proposeByCode({ ...withEntry(maBill), relationships: real.relationships, changed: [maBill.key] }).proposals.some((x) => x.to === 'MA' && x.type === 'succession'), ma.mechanism.slice(-120));
}

// ---------- 3. code: sponsors, companions, placement ----------
{
  ok('3 the lead sponsor segment stops at co-sponsors', leadSponsors('Sen. Chuck Grassley (R-IA) with Coons, Blackburn, Hawley; 13 cosponsors') === 'Sen. Chuck Grassley (R-IA)');
  const ca = newEntry({ jurisdiction: 'CA', state: 'CA', title: 'S.B. 999 — test', short_name: 'CA SB 999', sponsor_text: 'Sen. Scott Wiener (D); coauthors Asm. Bauer-Kahan', mechanism: 'Requires reports.' });
  const r = proposeByCode({ ...withEntry(ca), relationships: real.relationships, changed: [ca.key] });
  ok('3 a CA bill by Sen. Wiener gets his Sponsor link', r.proposals.some((x) => x.from === 'act-wiener' && x.type === 'actor' && x.label === LABEL.sponsor));
  ok('3 a coauthor after ";" is not linked', !r.proposals.some((x) => x.from === 'act-bauerkahan'));
  ok('3 its node key follows the network (SB999) in the state-bills column', r.nodes.SB999 && r.nodes.SB999.column === 4);
  const ny = newEntry({ sponsor_text: 'Sen. Scott Wiener (D)' });
  ok('3 the same surname in another state is not linked', !proposeByCode({ ...withEntry(ny), relationships: real.relationships, changed: [ny.key] }).proposals.some((x) => x.from === 'act-wiener'));
  const fed = newEntry({ level: 'federal', state: null, jurisdiction: 'US', section: 'D', type: 'bill', title: 'H.R. 99999 — test', short_name: 'H.R. 99999 test', sponsor_text: 'Rep. Ted Lieu (D-CA)' });
  const rf = proposeByCode({ ...withEntry(fed), relationships: real.relationships, changed: [fed.key] });
  ok('3 a federal bill by Rep. Lieu links to him, placed in the federal-bills column', rf.proposals.some((x) => x.from === 'act-lieu') && rf.nodes.HR99999 && rf.nodes.HR99999.column === 2);
  // placement agrees with the existing network: each existing node, removed, is put back in its own column
  let same = 0, n = 0;
  for (const [k, nd] of Object.entries(real.relationships.nodes)) { if (nd.kind !== 'entry') continue; n++; const r2 = { ...real.relationships, nodes: { ...real.relationships.nodes } }; delete r2.nodes[k]; if (nodeFor(real.entries.find((e) => e.key === nd.entry_key), r2, real.entries).node.column === nd.column) same++; }
  ok('3 automatic placement puts at least 83 of the 84 existing entry nodes in their own column', same >= 83, `${same} of ${n}`);
  const s2938 = real.entries.find((e) => e.key === 's-2938-ai-risk-evaluation-act');
  const comp = companions({ entries: [...real.entries, fed], changed: [fed.key], billIds: { [s2938.key]: ['119/s/2938'] }, related: { [fed.key]: [{ congress: 119, type: 'S', number: 2938, relationshipDetails: [{ type: 'Identical bill', identifiedBy: 'CRS' }] }, { congress: 119, type: 'HR', number: 1, relationshipDetails: [{ type: 'Related bill' }] }] } });
  ok('3 a Congress.gov "Identical bill" is reported as a companion of the entry that tracks it', comp.length === 1 && comp[0].companion_of === s2938.key);
  const rc = proposeByCode({ ...withEntry(fed), relationships: real.relationships, changed: [fed.key], billIds: { [s2938.key]: ['119/s/2938'] }, related: { [fed.key]: [{ congress: 119, type: 'S', number: 2938, relationshipDetails: [{ type: 'Identical bill' }] }] } });
  ok('3 a companion is never drawn as a link', rc.companions.length === 1 && !rc.proposals.some((x) => x.to === 'S2938' || x.from === 'S2938'));
  const titled = newEntry({ level: 'federal', state: null, jurisdiction: 'US', section: 'D', title: 'H.R. 77777 — House companion of S. 2938', short_name: 'H.R. 77777', sponsor_text: 'Rep. Nobody (D-OH)' });
  ok('3 a title naming another entry\'s bill as its companion is reported', companions({ entries: [...real.entries, titled], changed: [titled.key] }).some((c) => c.companion_of === s2938.key));
}

// ---------- 4. AI: both quotes checked by code, and a second reader ----------
const A_TEXT = 'SEC. 3. A large frontier developer shall write, implement, comply with, and clearly and conspicuously publish on its internet website a frontier AI framework.';
const B_TEXT = 'Sec. 22757.12. (a) A large frontier developer shall write, implement, comply with, and clearly and conspicuously publish on its internet website a frontier AI framework that applies to the developer.';
const QA = 'shall write, implement, comply with, and clearly and conspicuously publish on its internet website a frontier AI framework';
{
  const e = newEntry({});
  const d = withEntry(e), sb53 = real.entries.find((x) => x.key === 'ca-sb-53-tfaia');
  const code = proposeByCode({ entries: d.entries, relationships: d.relationships, changed: [e.key] });
  const texts = { [e.key]: { text: A_TEXT, url: 'https://www.nysenate.gov/legislation/bills/2025/S99999' }, [sb53.key]: { text: B_TEXT, url: 'https://leginfo.legislature.ca.gov/sb53' } };
  const good = { links: [{ to: sb53.key, kind: 'copies', label: 'Same framework duty', quote_from: QA, quote_to: QA }] };
  const yes = () => ({ confirmed: true, reason: 'Same operative words.' });
  const reader = scripted(() => good), validator = scripted(yes);
  const r = await proposeByAI({ entries: d.entries, relationships: d.relationships, changed: [e.key], texts, reader, validator, nodes: code.nodes });
  const p = r.proposals[0];
  ok('4 a confirmed AI link with both quotes is proposed, dashed, as a template link', p && p.method === 'ai' && p.type === 'template' && p.dashed === true && p.to === 'SB53' && p.label === LABEL.copies);
  ok('4 it carries a quote from each bill, each found in that bill\'s text', p && containsQuote(A_TEXT, p.evidence[0].quote) && containsQuote(B_TEXT, p.evidence[1].quote));
  ok('4 the reader only saw bills with a text', reader.calls.length === 1 && /ca-sb-53-tfaia/.test(reader.calls[0].prompt) && !/il-sb-315/.test(reader.calls[0].prompt));
  const fake = await proposeByAI({ entries: d.entries, relationships: d.relationships, changed: [e.key], texts, reader: scripted(() => ({ links: [{ ...good.links[0], quote_to: 'shall publish a safety and security protocol on its website' }] })), validator: scripted(yes), nodes: code.nodes });
  ok('4 a quote not in the other bill\'s text is dropped before the validator', !fake.proposals.length && /other bill/.test(fake.dropped[0].why));
  const v2 = scripted(() => ({ confirmed: false, reason: 'Common wording in the field.' }));
  const no = await proposeByAI({ entries: d.entries, relationships: d.relationships, changed: [e.key], texts, reader: scripted(() => good), validator: v2, nodes: code.nodes });
  ok('4 the validator saying no drops the link', !no.proposals.length && /did not confirm/.test(no.dropped[0].why) && v2.calls.length === 1);
  const kind = await proposeByAI({ entries: d.entries, relationships: d.relationships, changed: [e.key], texts, reader: scripted(() => ({ links: [{ ...good.links[0], kind: 'inspired' }] })), validator: scripted(yes), nodes: code.nodes });
  ok('4 a kind the network does not draw is dropped', !kind.proposals.length);
  const both = await propose({ entries: d.entries, relationships: d.relationships, changed: [e.key], texts, reader: scripted(() => good), validator: scripted(yes) });
  ok('4 propose() returns code and AI links together, AI links on the new node', both.proposals.some((x) => x.method === 'ai') && both.proposals.filter((x) => x.method === 'ai').every((x) => both.nodes[x.from]));
}

// ---------- 5. apply: additions only, deduped, integrity kept ----------
{
  const e = newEntry({ mechanism: 'Amends Section 1422 of the General Business Law to shorten the incident deadline to 48 hours', sponsor_text: 'Sen. Andrew Gounardes (D)' });
  const d = withEntry(e), records = { [e.key]: [lsRec('NY', [GOUNARDES])] };
  const r = proposeByCode({ entries: d.entries, relationships: d.relationships, changed: [e.key], records });
  const sp0 = r.proposals.find((x) => x.type === 'actor'), am0 = r.proposals.find((x) => x.type === 'succession');
  ok('5 the record proves the sponsor link; the amendment link is a proposal only', sp0 && isApplicable(sp0) && am0 && !isApplicable(am0), JSON.stringify(r.proposals));
  const dup = { ...clone(sp0) }, old = real.relationships.edges[0];
  const reverse = { from: old.to, to: old.from, type: old.type, label: 'Same link the other way', evidence: [{ entry_key: 'x', node: old.to, field: 'mechanism', quote: 'a quote that is long', source_url: 'https://example.gov/x' }], method: 'code' };
  const noQuote = { ...clone(sp0), evidence: [{ entry_key: e.key, node: sp0.to, field: 'record', quote: '', source_url: null }] };
  const a = applyLinks({ data: d, proposals: [...r.proposals, dup, reverse, noQuote], nodes: { ...r.nodes, UNUSED: { name: 'never used', column: 4, kind: 'entry', entry_key: e.key } } });
  ok('5 only the record-proved sponsor link is added, quoting the record and citing it', a.added.edges.length === 1 && a.added.edges.every((x) => x.origin === 'automated' && x.type === 'actor' && x.col === 'record' && x.quote === 'Andrew Gounardes' && x.source_url === 'https://legiscan.com/NY/bill/S99999/2025'), JSON.stringify(a.skipped.map((s) => s.why)));
  ok('5 the amendment link and the reversed edge are skipped as report-only, the duplicate as already there, the quoteless one too', a.skipped.length === 4 && a.skipped.filter((s) => /report-only/.test(s.why)).length === 2 && a.skipped.filter((s) => s.why === 'already in the network').length === 1 && a.skipped.some((s) => /needs a quote/.test(s.why)), JSON.stringify(a.skipped.map((s) => s.why)));
  ok('5 only nodes a new link uses are added', Object.keys(a.added.nodes).length === 1 && !a.relationships.nodes.UNUSED);
  ok('5 every old node and edge is unchanged and in place', JSON.stringify(a.relationships.edges.slice(0, real.relationships.edges.length)) === JSON.stringify(real.relationships.edges) && Object.keys(real.relationships.nodes).every((k) => JSON.stringify(a.relationships.nodes[k]) === JSON.stringify(real.relationships.nodes[k])));
  ok('5 the result passes integrity and the relationships schema', !a.problems.length && !checkIntegrity({ ...d, relationships: a.relationships }).length && !makeValidator().check('relationships', a.relationships).length, a.problems.join('; '));
  const m = await mapCheck({ ...d, relationships: a.relationships });
  ok('5 the link map draws every end of every link, with no duplicate node', !m.problems.length, m.problems.join('; '));
  const ghost = applyLinks({ data: d, proposals: [{ ...sp0, from: 'NO-SUCH-NODE' }] });
  ok('5 a link to an unknown node is skipped', !ghost.added.edges.length && /unknown node/.test(ghost.skipped[0].why));

  // ---------- 6. the stop rules: the network may only grow by exactly what apply added ----------
  const before = d, after = { ...d, relationships: a.relationships };
  const run = (aft, links) => checkPublish({ before, after: aft, runDate: '2026-10-28', maxEntries: 15, newKeys: [e.key], maxNew: 1, links: links && { ...links, created: [e.key], records } }).problems.filter((p) => /relationships|added link/.test(p));
  ok('6 without the entry\'s record the same addition stops the run (nothing proves it)', checkPublish({ before, after, runDate: '2026-10-28', maxEntries: 15, newKeys: [e.key], maxNew: 1, links: { ...a.added, created: [e.key] } }).problems.some((p) => /not proved by the official record/.test(p)));
  ok('6 additions from links/apply.mjs pass', run(after, a.added).length === 0, run(after, a.added).join('; '));
  ok('6 without the links list, any change still stops the run', run(after, null).some((p) => /relationships changed: Tier A/.test(p)));
  const edited = clone(after); edited.relationships.edges[0].label = 'edited';
  ok('6 editing an old edge stops the run', run(edited, a.added).some((p) => /edge #0/.test(p)));
  const deleted = clone(after); deleted.relationships.edges.splice(3, 1);
  ok('6 deleting an old edge stops the run', run(deleted, a.added).length > 0);
  const extra = clone(after); extra.relationships.edges.push({ ...extra.relationships.edges[0], to: 'SB315', label: 'smuggled in' });
  ok('6 an edge apply did not add stops the run', run(extra, a.added).some((p) => /not exactly the ones/.test(p)));
  const node = clone(after); node.relationships.nodes.SB53.column = 2;
  ok('6 moving an old node stops the run', run(node, a.added).some((p) => /node SB53/.test(p)));
  const authored = clone(after); authored.relationships.edges[authored.relationships.edges.length - 1].origin = 'authored';
  const authLinks = { ...a.added, edges: authored.relationships.edges.slice(real.relationships.edges.length) };
  ok('6 an added edge not marked automated stops the run', run(authored, authLinks).some((p) => /not marked automated/.test(p)));
}

// ---------- 7. the step: reported while switched off, written when on ----------
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-test-'));
  for (const d of ['data', 'docs']) { fs.mkdirSync(path.join(dir, d)); for (const f of ['entries', 'news', 'site', 'changes', 'relationships']) if (fs.existsSync(path.join(realData, f + '.json'))) fs.copyFileSync(path.join(realData, f + '.json'), path.join(dir, d, f + '.json')); }
  const e = newEntry({ mechanism: 'Amends Section 1422 of the General Business Law to shorten the incident deadline to 48 hours', sponsor_text: 'Sen. Andrew Gounardes (D)' });
  const ents = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'entries.json'), 'utf8')); ents.push(e);
  fs.writeFileSync(path.join(dir, 'data', 'entries.json'), JSON.stringify(ents, null, 1));
  return { dir, dataDir: path.join(dir, 'data'), docsDir: path.join(dir, 'docs'), key: e.key, records: { [e.key]: [lsRec('NY', [GOUNARDES])] } };
}
{
  const sb = sandbox(), relFile = path.join(sb.dataDir, 'relationships.json'), was = fs.readFileSync(relFile, 'utf8');
  const off = await linkRun({ dataDir: sb.dataDir, docsDir: sb.docsDir, changed: [sb.key], created: [sb.key], config: { auto_publish: { relationships: false } }, runDate: '2026-10-28', records: sb.records });
  ok('7 switched off: the links are proposed and nothing is written', off.status === 'proposed' && off.proposed.length === 2 && !off.applied.length && fs.readFileSync(relFile, 'utf8') === was);
  ok('7 the report names both ends and the quote, and says which link the record proves', off.proposed.every((p) => p.names[0] && p.names[1] && p.quote) && /reported only/.test(off.summary) && off.proposed.filter((p) => p.applies).length === 1 && off.proposed.find((p) => !p.applies).type === 'succession' && /proposal only/.test(off.summary));
  const rep = newReport({ id: 'update-test', now: new Date('2026-10-28T06:00:00Z') }); rep.links = off; finalize(rep, { now: new Date('2026-10-28T06:01:00Z') });
  const text = formatReport(rep);
  ok('7 the Telegram report lists them under "Links proposed"', /Links proposed: 2 \(reported only/.test(text) && /NY S\.99999 \(test\) → NY RAISE Act/.test(text), text);
  const on = await linkRun({ dataDir: sb.dataDir, docsDir: sb.docsDir, changed: [sb.key], created: [sb.key], config: { auto_publish: { relationships: true } }, runDate: '2026-10-28', records: sb.records });
  const written = JSON.parse(fs.readFileSync(relFile, 'utf8')), docs = JSON.parse(fs.readFileSync(path.join(sb.docsDir, 'relationships.json'), 'utf8'));
  ok('7 switched on: only the record-proved sponsor link is added to the data and the live copy; the amendment stays a proposal', on.status === 'written' && on.applied.length === 1 && on.applied[0].type === 'actor' && written.edges.length === real.relationships.edges.length + 1 && docs.edges.length === written.edges.length && on.proposed.some((p) => p.type === 'succession' && !p.applies), on.problems.join('; '));
  ok('7 the written network keeps every old edge in place', JSON.stringify(written.edges.slice(0, real.relationships.edges.length)) === JSON.stringify(real.relationships.edges));
  const again = await linkRun({ dataDir: sb.dataDir, docsDir: sb.docsDir, changed: [sb.key], created: [sb.key], config: { auto_publish: { relationships: true } }, runDate: '2026-10-28', records: sb.records });
  ok('7 a second run adds nothing (dedupe)', !again.applied.length && again.status !== 'written' && JSON.parse(fs.readFileSync(relFile, 'utf8')).edges.length === written.edges.length);
  const norec = sandbox();
  const nr = await linkRun({ dataDir: norec.dataDir, changed: [norec.key], created: [norec.key], config: { auto_publish: { relationships: true } }, runDate: '2026-10-28' });
  ok('7 switched on but no official record: nothing is added, both links are proposals', nr.status === 'proposed' && !nr.applied.length && nr.proposed.length === 2 && nr.proposed.every((p) => !p.applies) && JSON.parse(fs.readFileSync(path.join(norec.dataDir, 'relationships.json'), 'utf8')).edges.length === real.relationships.edges.length);
  fs.rmSync(norec.dir, { recursive: true, force: true });
  const dry = sandbox();
  const dr = await linkRun({ dataDir: dry.dataDir, changed: [dry.key], created: [dry.key], config: { auto_publish: { relationships: true } }, runDate: '2026-10-28', dry: true, records: dry.records });
  ok('7 a dry run checks but writes nothing', dr.status === 'dry-run' && JSON.parse(fs.readFileSync(path.join(dry.dataDir, 'relationships.json'), 'utf8')).edges.length === real.relationships.edges.length);
  for (const s of [sb, dry]) fs.rmSync(s.dir, { recursive: true, force: true });
}

// ---------- 8. audit cases (28 Oct 2026): each a false link the old code made, kept as a permanent test ----------
const code = (e, extra = {}) => proposeByCode({ ...withEntry(e), relationships: extra.relationships || real.relationships, changed: [e.key], ...extra });
const fedBill = (o) => newEntry({ level: 'federal', state: null, jurisdiction: 'US', section: 'D', type: 'bill', title: 'S. 99999 — test', short_name: 'S. 99999 test', identifiers: { external: { congress_gov: ['119/s/99999', '119/hr/99999', '119/hr/99998'] }, session: '119th Congress' }, ...o });
const ilBill = (o) => newEntry({ jurisdiction: 'IL', state: 'IL', title: 'H.B. 9999 — test', short_name: 'IL HB 9999', ...o });
{
  // 8.1 sponsors are matched on the whole person, never the surname alone
  const jerry = code(fedBill({ sponsor_text: 'Sen. Jerry Moran (R-KS)' }));
  ok('8.1 "Sen. Jerry Moran (R-KS)" is not linked to "Rep. Nathaniel Moran (R-TX)"', !jerry.proposals.some((x) => x.from === 'act-moran'), JSON.stringify(jerry.proposals));
  const kelly = code(ilBill({ sponsor_text: 'Rep. Kelly Cunningham (D)' }));
  ok('8.1 IL "Rep. Kelly Cunningham" is not linked to "Sen. Bill Cunningham"', !kelly.proposals.some((x) => x.from === 'act-cunningham'));
  const bill = code(ilBill({ sponsor_text: 'Sen. Bill Cunningham (D)' }));
  ok('8.1 IL "Sen. Bill Cunningham (D)" is linked to him', bill.proposals.some((x) => x.from === 'act-cunningham' && x.label === 'Sponsor'));
  const party = code(fedBill({ sponsor_text: 'Rep. Nathaniel Moran (D-TX)' }));
  ok('8.1 the same name with another party is not linked (the node states R)', !party.proposals.some((x) => x.from === 'act-moran'));
  const st = code(fedBill({ sponsor_text: 'Rep. Nathaniel Moran (R-OK)' }));
  ok('8.1 the same name from another state is not linked', !st.proposals.some((x) => x.from === 'act-moran'));
  const nat = code(fedBill({ sponsor_text: 'Rep. Nathaniel Moran (R-TX)' }));
  ok('8.1 the full match "Rep. Nathaniel Moran (R-TX)" is linked', nat.proposals.some((x) => x.from === 'act-moran'));
  // two nodes for the same person: ambiguous, nothing proposed, reported
  const twin = clone(real.relationships); twin.nodes['act-moran2'] = { ...twin.nodes['act-moran'] };
  const amb = code(fedBill({ sponsor_text: 'Rep. Nathaniel Moran (R-TX)' }), { relationships: twin });
  ok('8.1 two matching actor nodes: no proposal, a note says why', !amb.proposals.some((x) => x.type === 'actor') && amb.notes.some((n) => /ambiguous/.test(n.why)));
  // from the official record: Congress.gov sponsors with bioguideId decide; the text is not used for identity
  const recJerry = cgRec([{ bioguideId: 'M000934', firstName: 'Jerry', lastName: 'Moran', fullName: 'Sen. Moran, Jerry [R-KS]', party: 'R', state: 'KS' }]);
  const e1 = fedBill({ sponsor_text: 'Rep. Nathaniel Moran (R-TX)' });
  ok('8.1 the Congress.gov record\'s sponsor (Jerry Moran, bioguide M000934) overrides the text: no link to Nathaniel Moran', !code(e1, { records: { [e1.key]: [recJerry] } }).proposals.some((x) => x.from === 'act-moran'));
  const recNat = cgRec([{ bioguideId: 'M001224', firstName: 'Nathaniel', lastName: 'Moran', fullName: 'Rep. Moran, Nathaniel [R-TX-1]', party: 'R', state: 'TX' }]);
  const e2 = fedBill({ sponsor_text: 'Reps. Sara Jacobs (D-CA), Nathaniel Moran (R-TX)' });
  const r2 = code(e2, { records: { [e2.key]: [recNat] } });
  // 29 Oct 2026: the record's primary sponsor must BE the entry's stated lead sponsor; when they differ nothing is drawn (reported)
  ok('8.1 the record\'s primary sponsor (Moran) is not the entry\'s stated lead (Jacobs): no sponsor link at all, reported', !r2.proposals.some((x) => x.type === 'actor') && r2.notes.some((n) => n.kind === 'sponsor'), JSON.stringify(r2.proposals));
  const e2b = fedBill({ sponsor_text: 'Rep. Nathaniel Moran (R-TX), with Rep. Sara Jacobs (D-CA)' });
  const r2b = code(e2b, { records: { [e2b.key]: [recNat] } });
  ok('8.1 the record\'s primary sponsor who is the stated lead is linked, record-proved, quoting the record\'s sponsor field and citing the record', r2b.proposals.some((x) => x.from === 'act-moran' && x.record_id === 'bioguide:M001224' && isApplicable(x) && x.evidence[0].quote === 'Rep. Moran, Nathaniel [R-TX-1]' && x.evidence[0].source_url === 'https://www.congress.gov/bill/119th-congress/senate-bill/99999') && !r2b.proposals.some((x) => x.from === 'act-jacobs'), JSON.stringify(r2b.proposals));
  const e3 = fedBill({ sponsor_text: 'Rep. Moran (R-TX)' });
  const r3 = code(e3, { records: { [e3.key]: [recNat] } });
  ok('8.1 a record sponsor the entry text does not name in full: nothing proposed, reported', !r3.proposals.some((x) => x.type === 'actor') && r3.notes.some((n) => /names no lead sponsor/.test(n.why)));
  const ls = lsRec('CA', [{ people_id: 1, first_name: 'Rebecca', last_name: 'Bauer-Kahan', role: 'Rep', party: 'D', sponsor_type_id: 2 }, WIENER]);
  const e4 = newEntry({ jurisdiction: 'CA', state: 'CA', title: 'S.B. 999 — test', short_name: 'CA SB 999', sponsor_text: 'Sen. Scott Wiener (D); coauthor Asm. Rebecca Bauer-Kahan (D)' });
  const r4 = code(e4, { records: { [e4.key]: [ls] } });
  ok('8.1 LegiScan: only the primary sponsor (sponsor_type_id 1, people_id) is linked, not the co-sponsor', r4.proposals.some((x) => x.from === 'act-wiener' && x.record_id === 'legiscan:18068') && !r4.proposals.some((x) => x.from === 'act-bauerkahan'));
}
{
  // 8.2 only the lead sponsor as stated
  for (const t of ['Cosponsored by Sen. Josh Hawley (R-MO)', 'Opposed by Sen. Josh Hawley (R-MO)', 'Supported by Sen. Josh Hawley (R-MO)', 'Introduced by request; cosponsored by Hawley', 'Sen. Chuck Grassley (R-IA), cosponsored by Sen. Josh Hawley (R-MO)', 'Sen. Chuck Grassley (R-IA); opposed by Sen. Josh Hawley (R-MO)', 'Sen. Chuck Grassley (R-IA), Sen. Josh Hawley (R-MO), Sen. Mark Warner (D-VA)']) {
    const r = code(fedBill({ sponsor_text: t }));
    ok(`8.2 "${t}": no Sponsor link to Hawley or Warner`, !r.proposals.some((x) => x.from === 'act-hawley' || x.from === 'act-warner'), JSON.stringify(r.proposals.map((x) => x.from)));
  }
  ok('8.2 leadSponsors reads only the first person', leadSponsors('Sens. Josh Hawley (R-MO), Richard Blumenthal (D-CT)') === 'Sens. Josh Hawley (R-MO)' && leadSponsors('Opposed by Sen. Josh Hawley (R-MO)') === '');
}
{
  // 8.3 amendments: an explicit amend verb whose object is the law
  const ca = (m) => newEntry({ jurisdiction: 'CA', state: 'CA', title: 'S.B. 999 — test', short_name: 'CA SB 999', sponsor_text: 'Sen. Jane Doe (D)', mechanism: m });
  for (const m of ['Unlike TFAIA, adds duties for large developers', 'Adds duties that TFAIA lacks', 'Amends the Labor Code, unlike TFAIA, to protect whistleblowers', 'Builds on TFAIA and adds an audit duty', 'Amends the Labor Code to add duties like those in TFAIA']) {
    ok(`8.3 "${m}": no amendment link to SB 53`, !code(ca(m)).proposals.some((x) => x.type === 'succession'), JSON.stringify(code(ca(m)).proposals));
  }
  const rep = newEntry({ mechanism: 'Repeals the RAISE Act and replaces it with a licensing regime' });
  const rr = code(rep);
  ok('8.3 a repeal is not drawn as "would amend"; it is reported', !rr.proposals.some((x) => x.type === 'succession') && rr.notes.some((n) => n.kind === 'amendment' && /repeal/.test(n.why)), JSON.stringify(rr));
  const both = newEntry({ mechanism: 'Amends and repeals the RAISE Act' });
  ok('8.3 a clause that amends and repeals the same law draws nothing', !code(both).proposals.some((x) => x.type === 'succession'));
  ok('8.3 "Amends the RAISE Act" still links', code(newEntry({ mechanism: 'Amends the RAISE Act to add a whistleblower channel' })).proposals.some((x) => x.to === 'RAISE'));
  ok('8.3 "Adds GBL §1425" (a section the RAISE Act occupies) still links', code(newEntry({ mechanism: 'Adds GBL §1425: annual third-party verification' })).proposals.some((x) => x.to === 'RAISE'));
  // federal: a tracked law that occupies a U.S. Code section, and a bill amending it (en dash, "§ ", subsection)
  const base = clone(real.entries.find((e) => e.key === 's-2938-ai-risk-evaluation-act'));
  const law = { ...base, id: 9001, key: 'test-fed-law', status: 'enacted', type: 'law', title: 'National AI Initiative Act (15 U.S.C. §278h-1)', short_name: 'NAII Act', mechanism: 'Creates an office.' };
  const rel = clone(real.relationships); rel.nodes.NAII = { name: 'NAII Act', column: 2, kind: 'entry', entry_key: law.key };
  for (const m of ['Amends 15 U.S.C. §278h-1 to add reporting', 'Amends 15 U.S.C. § 278h–1(b) to add reporting', 'Amends section 5 of the NAII Act to add reporting']) {
    const b = fedBill({ mechanism: m, sponsor_text: 'Rep. Nobody (D-OH)' });
    const r = proposeByCode({ entries: [...real.entries, law, b], relationships: rel, changed: [b.key] });
    ok(`8.3 federal "${m}" links to the law that occupies that section`, r.proposals.some((x) => x.to === 'NAII' && x.type === 'succession' && x.label === 'Would amend NAII Act'), JSON.stringify(r.proposals));
  }
  const cod = { ...law, key: 'test-fed-law2', title: 'National AI Initiative Act', mechanism: 'Codified at 15 U.S.C. 278h-1.' };
  const rel2 = clone(real.relationships); rel2.nodes.NAII = { name: 'NAII Act', column: 2, kind: 'entry', entry_key: cod.key };
  const b2 = fedBill({ mechanism: 'Amends 15 U.S.C. 278h-1 to add reporting' });
  ok('8.3 a law "codified at" a section owns it', proposeByCode({ entries: [...real.entries, cod, b2], relationships: rel2, changed: [b2.key] }).proposals.some((x) => x.to === 'NAII'));
  const b3 = fedBill({ mechanism: 'Unlike 15 U.S.C. §278h-1, adds an audit duty' });
  ok('8.3 a federal citation without an amend verb tied to it draws nothing', !proposeByCode({ entries: [...real.entries, law, b3], relationships: rel, changed: [b3.key] }).proposals.some((x) => x.type === 'succession'));
}
{
  // 8.4 evidence is honest: the quote is the tracker's own text, so the source is the entry's tracker page, and checkLinks verifies it
  const e = newEntry({ mechanism: 'Amends Section 1422 of the General Business Law to shorten the incident deadline to 48 hours', sponsor_text: 'Sen. Andrew Gounardes (D)' });
  const d = withEntry(e), r = code(e);
  ok('8.4 every code proposal quotes the entry and cites its tracker page, never the bill URL', r.proposals.length === 2 && r.proposals.every((p) => p.evidence[0].source_url === 'https://usfrontierlaw.com/#/bill/' + e.id && e[p.evidence[0].field].includes(p.evidence[0].quote) && p.evidence[0].node === (p.type === 'actor' ? p.to : p.from)), JSON.stringify(r.proposals.map((p) => p.evidence[0])));
  const a = applyLinks({ data: d, proposals: r.proposals, nodes: r.nodes });
  ok('8.4 prose links (no official record) are never applied', a.added.edges.length === 0 && a.skipped.every((s) => /report-only/.test(s.why)));
  // the same proposals forced in as edges, to show checkLinks refuses them all
  const pe = proseEdges(r), nodes = r.nodes;
  ok('8.4 the edge says where its quote sits (src = the entry\'s node, col = the field)', pe.every((x) => x.src && x.col && ['sponsor_text', 'mechanism'].includes(x.col) && x.source_url.startsWith('https://usfrontierlaw.com/#/bill/')));
  const chk = (edges, extra = {}) => checkLinks(d.relationships, { ...d.relationships, nodes: { ...d.relationships.nodes, ...nodes }, edges: [...d.relationships.edges, ...edges] }, { edges, nodes, created: [e.key], ...extra }, d.entries);
  ok('8.4 prose edges forced past apply stop the run: report-only, only a record-proved sponsor link may be added', pe.length === 2 && pe.every((x) => chk([x]).some((p) => /report-only/.test(p))), chk(pe).join('; '));
  ok('8.4 ... and their meaning checks still pass (the only problem is that they are report-only)', chk(pe).every((p) => /report-only/.test(p)), chk(pe).join('; '));
  const billUrl = pe.map((x) => ({ ...x, source_url: 'https://www.nysenate.gov/legislation/bills/2025/S99999' }));
  ok('8.4 entry prose with the bill URL as its source stops the run', chk(billUrl).some((p) => /tracker page/.test(p)));
  const notThere = pe.map((x) => ({ ...x, quote: x.quote + ' and more words' }));
  ok('8.4 a quote not word for word in the stated field stops the run', chk(notThere).some((p) => /not word for word/.test(p)));
  const noSrc = pe.map(({ src, ...x }) => x);
  ok('8.4 an edge that does not say where its quote sits stops the run', chk(noSrc).some((p) => /src/.test(p)));
  const nk = Object.keys(nodes)[0];
  const ai = [{ from: nk, to: 'SB53', type: 'template', label: LABEL.copies, dashed: true, quote: QA, source_url: 'https://www.nysenate.gov/legislation/bills/2025/S99999', src: nk, col: 'text', origin: 'automated' }];
  ok('8.4 an AI edge whose quote is not in an official text the step read stops the run', chk(ai).some((p) => /official text/.test(p)));
  const withText = chk(ai, { texts: { 'https://www.nysenate.gov/legislation/bills/2025/S99999': A_TEXT } });
  ok('8.4 the same AI edge with that text still stops the run: AI links are report-only', withText.length > 0 && withText.every((p) => /report-only/.test(p)), withText.join('; '));
  // the record-proved sponsor edge: passes, and every part of the proof is checked
  const records = { [e.key]: [lsRec('NY', [GOUNARDES])] };
  const rr = code(e, { records }), ar = applyLinks({ data: d, proposals: rr.proposals, nodes: rr.nodes }), rec = ar.added.edges[0];
  const chkR = (edges, extra = {}) => checkLinks(d.relationships, { ...d.relationships, nodes: { ...d.relationships.nodes, ...rr.nodes }, edges: [...d.relationships.edges, ...edges] }, { edges, nodes: rr.nodes, created: [e.key], records, ...extra }, d.entries);
  ok('8.4 the record-proved sponsor edge passes checkLinks', rec && rec.col === 'record' && chkR([rec]).length === 0, chkR(rec ? [rec] : []).join('; '));
  ok('8.4 a record edge without the record stops the run', chkR([rec], { records: {} }).some((p) => /not proved by the official record/.test(p)));
  ok('8.4 a record edge whose quote is not the record\'s sponsor field stops the run', chkR([{ ...rec, quote: 'Sen. Andrew Gounardes' }]).some((p) => /sponsor field/.test(p)));
  ok('8.4 a record edge citing another URL stops the run', chkR([{ ...rec, source_url: 'https://legiscan.com/NY/bill/S1/2025' }]).some((p) => /no record at/.test(p)));
  ok('8.4 a record edge from another actor stops the run', chkR([{ ...rec, from: 'act-bores' }]).some((p) => /official id stored/.test(p)));
  ok('8.4 a record edge when the stored ids do not give that id stops the run', chkR([rec], { actorIds: {} }).some((p) => /official id stored/.test(p)));
  const other = { ...e, sponsor_text: 'Sen. Kristen Gonzalez (D), with Sen. Andrew Gounardes (D)' }, d2 = withEntry(other);
  ok('8.4 a record edge whose record sponsor is not the entry\'s stated lead stops the run', checkLinks(d2.relationships, { ...d2.relationships, nodes: { ...d2.relationships.nodes, ...rr.nodes }, edges: [...d2.relationships.edges, rec] }, { edges: [rec], nodes: rr.nodes, created: [e.key], records }, d2.entries).some((p) => /not named as the entry's lead/.test(p)));
}
{
  // 8.5 hand-written entries never gain links automatically: reported only
  const sb = sandbox(), relFile = path.join(sb.dataDir, 'relationships.json'), was = fs.readFileSync(relFile, 'utf8');
  const on = await linkRun({ dataDir: sb.dataDir, changed: [sb.key], config: { auto_publish: { relationships: true } }, runDate: '2026-10-28' });
  ok('8.5 an entry not created by automation (origin authored): its links are reported only, nothing written', on.applied.length === 0 && on.proposed.length === 0 && on.report_only.length === 2 && fs.readFileSync(relFile, 'utf8') === was && /report only/.test(on.summary), JSON.stringify(on));
  const gou = await linkRun({ dataDir: realData, changed: ['ny-s-10373-verification'], config: { auto_publish: { relationships: true } }, runDate: '2026-10-28', dry: true });
  ok('8.5 a hand-written entry Tier A touched gains nothing', gou.applied.length === 0 && gou.status !== 'written');
  const withRec = await linkRun({ dataDir: sb.dataDir, changed: [sb.key], config: { auto_publish: { relationships: true } }, runDate: '2026-10-28', records: sb.records });
  ok('8.5 even a record-proved sponsor link for a hand-written entry is reported only', withRec.applied.length === 0 && withRec.report_only.length === 2 && fs.readFileSync(relFile, 'utf8') === was);
  const d = loadData(sb.dataDir), r = proposeByCode({ entries: d.entries, relationships: d.relationships, changed: [sb.key], records: sb.records });
  const sp = r.proposals.filter(isApplicable).map(edgeOf), rel2 = { ...d.relationships, nodes: { ...d.relationships.nodes, ...r.nodes }, edges: [...d.relationships.edges, ...sp] };
  ok('8.5 checkLinks stops an added link for a hand-written entry, even record-proved', sp.length === 1 && checkLinks(d.relationships, rel2, { edges: sp, nodes: r.nodes, records: sb.records }, d.entries).some((p) => /hand-written/.test(p)));
  fs.rmSync(sb.dir, { recursive: true, force: true });
}
{
  // 8.6 one direction and label convention (links/rules.mjs)
  const draft = newEntry({ level: 'federal', state: null, jurisdiction: 'US', section: 'E', type: 'draft', status: 'pending', title: 'Draft — test', short_name: 'Test draft', sponsor_text: 'Sen. Marsha Blackburn (R-TN)' });
  const rd = code(draft);
  ok('8.6 a discussion draft\'s author is labelled "Draft author", not "Sponsor"', rd.proposals.some((x) => x.from === 'act-blackburn' && x.label === 'Draft author') && !rd.proposals.some((x) => x.label === 'Sponsor'));
  const exec = newEntry({ level: 'federal', state: null, jurisdiction: 'US', section: 'G', type: 'executive', status: 'executive', title: 'Order — test', short_name: 'Test order', sponsor_text: 'Sen. Marsha Blackburn (R-TN)' });
  ok('8.6 no sponsor link for an executive action', !code(exec).proposals.some((x) => x.type === 'actor'));
  const am = code(newEntry({ mechanism: 'Amends the RAISE Act to add a whistleblower channel' })).proposals.find((x) => x.type === 'succession');
  ok('8.6 an amendment goes from the amending bill to the law', am && am.to === 'RAISE' && am.from !== 'RAISE');
  // the reverse already exists: never proposed, reported
  const n = clone(real.relationships), e = newEntry({ mechanism: 'Amends the RAISE Act to add a whistleblower channel' });
  const placed = proposeByCode({ ...withEntry(e), changed: [e.key] }).nodes, nk = Object.keys(placed)[0];
  n.nodes[nk] = placed[nk]; n.edges.push({ from: 'RAISE', to: nk, type: 'succession', label: 'Would amend the RAISE Act', quote: 'Amends the RAISE Act', origin: 'authored' });
  const rv = code(e, { relationships: n });
  ok('8.6 an edge whose reverse exists is not proposed, and the note says so', !rv.proposals.some((x) => x.type === 'succession') && rv.notes.some((x) => x.kind === 'reverse'), JSON.stringify(rv));
  // backtest scores direction and label
  const fake = (p) => ({ entries, relationships, changed }) => ({ proposals: [p(relationships)], nodes: {}, companions: [], notes: [] });
  const entries = real.entries, sample = ['ny-s-10373-verification'];
  const wrongDir = backtest({ entries, relationships: real.relationships, sample, proposer: fake(() => ({ from: 'RAISE', to: 'S10373', type: 'succession', label: 'Would amend S10373', evidence: [{ quote: 'x' }] })) });
  ok('8.6 backtest: the right pair the wrong way round is a wrong direction, not right', wrongDir.wrongDirection.length === 1 && !wrongDir.recovered.size);
  const wrongLab = backtest({ entries, relationships: real.relationships, sample: ['gaaia-discussion-draft'], proposer: fake(() => ({ from: 'act-obernolte', to: 'GAAIA', type: 'actor', label: 'Sponsor', evidence: [{ quote: 'x' }] })) });
  ok('8.6 backtest: "Sponsor" where the network says "Draft author" is a wrong label', wrongLab.wrongLabel.length === 1 && !wrongLab.recovered.size);
  ok('8.6 labelOk: "Sponsor" is not "Cosponsor" or "Coauthor"; "Chief sponsor" is', !labelOk('Sponsor', 'Cosponsor', 'actor') && !labelOk('Sponsor', 'Coauthor', 'actor') && !labelOk('Sponsor', 'House cosponsor', 'actor') && labelOk('Sponsor', 'Chief sponsor', 'actor'));
}
{
  // 8.7 checkLinks checks meaning, not only shape
  const e = newEntry({ mechanism: 'Amends Section 1422 of the General Business Law to shorten the incident deadline to 48 hours', sponsor_text: 'Sen. Andrew Gounardes (D)' });
  const d = withEntry(e), r = code(e), pe = proseEdges(r);
  const [sp, am] = [pe.find((x) => x.type === 'actor'), pe.find((x) => x.type === 'succession')];
  const chk = (edges, nodes = r.nodes) => checkLinks(d.relationships, { ...d.relationships, nodes: { ...d.relationships.nodes, ...nodes }, edges: [...d.relationships.edges, ...edges] }, { edges, nodes, created: [e.key] }, d.entries);
  ok('8.7 an edge to a node that does not exist stops the run', chk([{ ...am, to: 'NO-SUCH' }]).some((p) => /not a node/.test(p)));
  ok('8.7 a sponsor edge from an entry (not an actor) stops the run', chk([{ ...sp, from: 'SB53' }]).some((p) => /from an actor/.test(p)));
  ok('8.7 a sponsor edge from a non-legislator actor stops the run', chk([{ ...sp, from: 'act-anthropic' }]).some((p) => /not a legislator/.test(p)));
  ok('8.7 a "Sponsor" label on a draft stops the run', chk([{ ...sp, to: 'GAAIA', src: 'GAAIA' }]).some((p) => /Draft author/.test(p)));
  ok('8.7 an amendment label that does not name the law at its end stops the run', chk([{ ...am, label: 'Would amend CA SB 53' }]).some((p) => /does not name/.test(p)));
  ok('8.7 an amendment across jurisdictions stops the run', chk([{ ...am, to: 'SB53', label: 'Would amend ' + real.relationships.nodes.SB53.name }]).some((p) => /one jurisdiction/.test(p)));
  const s10373 = real.entries.find((x) => x.key === 'ny-s-10373-verification');
  const back = { from: 'RAISE', to: 'S10373', type: 'template', label: LABEL.copies, dashed: true, quote: s10373.mechanism.slice(0, 40), source_url: 'https://usfrontierlaw.com/#/bill/' + s10373.id, src: 'S10373', col: 'mechanism', origin: 'automated' };
  ok('8.7 an edge the network has the other way round (S10373 -> RAISE) stops the run', chk([back]).some((p) => /other way/.test(p)));
  ok('8.7 two added edges joining the same pair both ways stop the run', chk([am, { ...am, from: am.to, to: am.from, type: 'template', label: LABEL.copies, dashed: true }]).some((p) => /other way/.test(p)));
  ok('8.7 a label the pipeline never writes stops the run', chk([{ ...am, label: 'Related bill' }]).some((p) => /not one the pipeline writes/.test(p)));
}

// ---------- 9. second audit (29 Oct 2026, synthetic cases): each a wrong link the code made, kept as a permanent test ----------
{
  const noAmend = (m, why) => { const r = code(newEntry({ mechanism: m })); ok(`9 ${why}: "${m}" draws no amendment link`, !r.proposals.some((x) => x.type === 'succession'), JSON.stringify(r.proposals.filter((x) => x.type === 'succession'))); };
  // case 17: "to amend" in a study clause; case 23: an agency (not the bill) is the subject of "amending"
  noAmend('Directs the Attorney General to report by 2027 on whether to amend the RAISE Act. Creates no duties.', 'case 17, a study of whether to amend');
  noAmend('Requires developers to follow rules adopted by the Department amending GBL §1425 reporting forms.', 'case 23, the Department amends, not the bill');
  // case 22: the object is the first law cited (Public Health Law), not a law cross-referenced after it
  noAmend('Amends Public Health Law § 2805 cross-referenced in GBL Art. 44-B for hospitals.', 'case 22, the object is the Public Health Law');
  // case 28: a different act whose name starts with the law's name
  noAmend('Amends the RAISE Act for Kids of 2024 (Education Law §3038).', 'case 28, a different act named "RAISE Act for Kids"');
  // case 29: negation earlier in the sentence, verb not at the head of a clause the bill is the subject of
  noAmend('This bill is not a revision of earlier statutes but amends the RAISE Act to add whistleblower rules.', 'case 29, negated sentence');
  // operative forms still link
  for (const m of ['Amends the RAISE Act to add a whistleblower channel', 'This act amends the RAISE Act to add a whistleblower channel', 'This bill would amend the RAISE Act to add a whistleblower channel', 'Amends the RAISE Act (GBL Article 44-B) by adding GBL §1431'])
    ok(`9 operative "${m}" links to the RAISE Act`, code(newEntry({ mechanism: m })).proposals.some((x) => x.to === 'RAISE' && x.type === 'succession'));
  // case 24: §8898.10 is not §8898.1 and lies outside SB 813's §§8898–8898.4
  const ca = newEntry({ jurisdiction: 'CA', state: 'CA', title: 'S.B. 999 — test', short_name: 'CA SB 999', sponsor_text: 'Sen. Jane Doe (D)', mechanism: 'Amends Gov. Code §8898.10 to add a new fund.' });
  ok('9 case 24, "Gov. Code §8898.10" is outside §§8898–8898.4: no link to SB 813', !code(ca).proposals.some((x) => x.type === 'succession'), JSON.stringify(code(ca).proposals));
  const c = citations('Gov. Code §8898.10').find((x) => x.code === 'gov');
  ok('9 citations keep the section parts as integers (8898.10 -> [8898, 10])', c && JSON.stringify(c.fromP) === '[8898,10]');
}
{
  // cases 13, 14, 16: the record's sponsor must be the entry's stated lead sponsor
  const caE = (s) => newEntry({ jurisdiction: 'CA', state: 'CA', title: 'S.B. 999 — test', short_name: 'CA SB 999', sponsor_text: s });
  const e13 = caE('Asm. Jane Doe (D); opposed by Sen. Scott Wiener');
  const r13 = code(e13, { records: { [e13.key]: [{ bill: { sponsors: [{ people_id: 1, sponsor_type_id: 1, first_name: 'Scott', last_name: 'Wiener', role: 'Sen', party: 'D' }] } }] } });
  ok('9 case 13, record primary Wiener whom the entry names only as an opponent: no link', !r13.proposals.some((x) => x.type === 'actor'), JSON.stringify(r13.proposals));
  const e14 = caE('Asm. Jane Doe (D), coauthor Sen. Scott Wiener (D)');
  const r14 = code(e14, { records: { [e14.key]: [{ bill: { sponsors: [{ people_id: 1, sponsor_type_id: 2, first_name: 'Scott', last_name: 'Wiener', role: 'Sen' }, { people_id: 2, sponsor_type_id: 2, first_name: 'Jane', last_name: 'Doe', role: 'Rep' }] } }] } });
  ok('9 case 14, LegiScan marks no primary: the first-listed coauthor is never used', !r14.proposals.some((x) => x.type === 'actor'), JSON.stringify(r14.proposals));
  const e16 = fedBill({ sponsor_text: 'Sen. Tim Kaine (D-VA), with Sen. Mark Warner (D-VA)' });
  const r16 = code(e16, { records: { [e16.key]: [{ bill: { sponsors: [{ bioguideId: 'W000805', firstName: 'Mark', lastName: 'Warner', fullName: 'Sen. Warner, Mark R. [D-VA]', party: 'D', state: 'VA' }] } }] } });
  ok('9 case 16, record primary Warner whom the entry names only after "with": no link', !r16.proposals.some((x) => x.type === 'actor'), JSON.stringify(r16.proposals));
}
{
  // checkLinks checks the quote's meaning: the lead-sponsor clause for Sponsor, an operative amend clause naming the law for Would amend
  const e = newEntry({ mechanism: 'Amends Section 1422 of the General Business Law to shorten the incident deadline to 48 hours. Directs the Attorney General to report on whether to amend the RAISE Act', sponsor_text: 'Sen. Andrew Gounardes (D), with Sen. Kristen Gonzalez (D)' });
  const d = withEntry(e), r = code(e), pe = proseEdges(r);
  const [sp, am] = [pe.find((x) => x.type === 'actor'), pe.find((x) => x.type === 'succession')];
  const chk = (edges) => checkLinks(d.relationships, { ...d.relationships, nodes: { ...d.relationships.nodes, ...r.nodes }, edges: [...d.relationships.edges, ...edges] }, { edges, nodes: r.nodes, created: [e.key] }, d.entries);
  ok('9 checkLinks: the proposer\'s own prose edges pass the meaning check, and are refused only as report-only', sp && am && chk(pe).length > 0 && chk(pe).every((p) => /report-only/.test(p)), chk(pe).join('; '));
  ok('9 checkLinks: a Sponsor quote that is not the lead clause stops the run', chk([{ ...sp, quote: 'Sen. Kristen Gonzalez (D)' }, am]).some((p) => /lead sponsor/.test(p)));
  ok('9 checkLinks: a Sponsor quote that is only the name stops the run', chk([{ ...sp, quote: 'Andrew Gounardes' }, am]).some((p) => /lead sponsor/.test(p)));
  ok('9 checkLinks: a Would amend quote that is a study clause stops the run', chk([sp, { ...am, quote: 'Directs the Attorney General to report on whether to amend the RAISE Act' }]).some((p) => /operative/.test(p)));
  ok('9 checkLinks: a Would amend quote from the sponsor text stops the run', chk([sp, { ...am, col: 'sponsor_text', quote: 'Sen. Andrew Gounardes (D)' }]).some((p) => /operative/.test(p)));
}

// ---------- 10. third audit (29 Oct 2026): prose rules never converge, so only record-proved sponsor links are applied ----------
// Each round-3 case published a wrong link from the tracker's prose. They are kept to document that such links are now proposals,
// reported, never applied, with the switch on and the entry automated.
function caseBox(e) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-r3-'));
  fs.mkdirSync(path.join(dir, 'data'));
  for (const f of ['entries', 'news', 'site', 'changes', 'relationships']) if (fs.existsSync(path.join(realData, f + '.json'))) fs.copyFileSync(path.join(realData, f + '.json'), path.join(dir, 'data', f + '.json'));
  const ents = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'entries.json'), 'utf8')); ents.push(e); // created this run (linkRun created), so its links count as the automation's
  fs.writeFileSync(path.join(dir, 'data', 'entries.json'), JSON.stringify(ents, null, 1));
  return dir;
}
async function appliedFor(e, records) {
  const dir = caseBox(e), rel = path.join(dir, 'data', 'relationships.json'), was = fs.readFileSync(rel, 'utf8');
  const r = await linkRun({ dataDir: path.join(dir, 'data'), changed: [e.key], created: [e.key], config: { auto_publish: { relationships: true } }, runDate: '2026-10-29', records });
  const same = fs.readFileSync(rel, 'utf8') === was;
  fs.rmSync(dir, { recursive: true, force: true });
  return { r, same };
}
{
  const caE = (o) => newEntry({ jurisdiction: 'CA', state: 'CA', title: 'S.B. 999 — test', short_name: 'CA SB 999', sponsor_text: 'Sen. Nobody Here (D)', ...o });
  const nyE = (m) => newEntry({ mechanism: m, sponsor_text: 'Sen. Nobody Here (D)' });
  const maE = (m) => newEntry({ jurisdiction: 'MA', state: 'MA', short_name: 'MA S.9999 (test)', sponsor_text: 'Sen. Nobody Here (D)', mechanism: m });
  const cases = [
    ['06 committee bill: "Sen. Scott Wiener (D), Chair, on behalf of the Senate Housing Committee"', caE({ sponsor_text: 'Sen. Scott Wiener (D), Chair, on behalf of the Senate Housing Committee (committee bill)' })],
    ['12 "Sen. Scott Wiener (Independent)": wrong party', caE({ sponsor_text: 'Sen. Scott Wiener (Independent)' })],
    ['13 original author removed, now authored by McNerney', caE({ sponsor_text: 'Sen. Scott Wiener (D) (original author; removed as author June 2026), now authored by Sen. Jerry McNerney (D)' })],
    ['17 "Sen. Scott Wiener (Dem., formerly Asm.)"', caE({ sponsor_text: 'Sen. Scott Wiener (Dem., formerly Asm.)' })],
    ['21 NY "Amends the RAISE Act (Cal. Bus. & Prof. Code §22757.10)"', nyE('Amends the RAISE Act (Cal. Bus. & Prof. Code §22757.10) to add reporting.')],
    ['25 MA "Amends chapter 93M" whose owner is a pending bill', maE('Amends chapter 93M of the General Laws to add a frontier model registry.')],
    ['26 CA enacted law "Amends Gov. Code §8898.2" (tense)', caE({ mechanism: 'Amends Gov. Code §8898.2 to change IVO certification terms.', status: 'enacted', type: 'law' })],
    ['27 NY "Amends the RAISE Act (repealed in its entirety by section 3 of this act)"', nyE('Amends the RAISE Act (repealed in its entirety by section 3 of this act) and enacts a new Article 44-C.')],
    ['39 NY "Amends the RAISE Act (by striking Article 44-B in its entirety)"', nyE('Amends the RAISE Act (by striking Article 44-B in its entirety).')],
    ['R2 "Sen. Scott Wiener (R)"', caE({ sponsor_text: 'Sen. Scott Wiener (R)' })],
    ['R2 "Del. Ted Lieu (D-CA)"', fedBill({ sponsor_text: 'Del. Ted Lieu (D-CA)' })]
  ];
  for (const [name, e] of cases) {
    const { r, same } = await appliedFor(e);
    ok(`10 case ${name}: nothing applied with the switch on, the network unchanged; any link is a proposal`, r.applied.length === 0 && same && !r.problems.length && r.status !== 'written' && r.proposed.every((p) => !p.applies), JSON.stringify({ status: r.status, applied: r.applied, proposed: r.proposed.map((p) => [p.from, p.to, p.applies]) }));
  }
  // with the official record the prose disagrees with, nothing at all (not even a proposal), and a note says why
  const withRec = [
    ['12 record party D, entry "(Independent)"', caE({ sponsor_text: 'Sen. Scott Wiener (Independent)' }), lsRec('CA', [WIENER]), /party I, the record gives D/],
    ['13 record primary McNerney, entry lead Wiener', caE({ sponsor_text: 'Sen. Scott Wiener (D) (original author; removed as author June 2026), now authored by Sen. Jerry McNerney (D)' }), lsRec('CA', [{ people_id: 25355, first_name: 'Jerry', last_name: 'McNerney', role: 'Sen', party: 'D' }]), /not named as the entry's lead/],
    ['06 record names only the committee', caE({ sponsor_text: 'Sen. Scott Wiener (D), Chair, on behalf of the Senate Housing Committee (committee bill)' }), lsRec('CA', [{ people_id: 0, first_name: '', last_name: '', committee_sponsor: 1, committee_id: 7, name: 'Senate Housing Committee' }]), /marks no primary/],
    ['R2 record party D, entry "(R)"', caE({ sponsor_text: 'Sen. Scott Wiener (R)' }), lsRec('CA', [WIENER]), /party R, the record gives D/],
    ['R2 record "Rep. Lieu", entry "Del. Ted Lieu"', fedBill({ sponsor_text: 'Del. Ted Lieu (D-CA)' }), cgRec([LIEU]), /^chamber mismatch: .*House\/Assembly.*Delegate/]
  ];
  for (const [name, e, rec, why] of withRec) {
    const { r, same } = await appliedFor(e, { [e.key]: [rec] });
    ok(`10 case ${name}: no link of any kind, the note says why`, r.applied.length === 0 && same && !r.proposed.some((p) => p.type === 'actor') && r.notes.some((n) => why.test(n.why)), JSON.stringify({ proposed: r.proposed, notes: r.notes }));
  }
  // the record-proved path, end to end
  const good = caE({ sponsor_text: 'Sen. Scott Wiener (D); coauthor Asm. Rebecca Bauer-Kahan (D)' });
  const g = await appliedFor(good, { [good.key]: [lsRec('CA', [WIENER, { people_id: 19716, first_name: 'Rebecca', last_name: 'Bauer-Kahan', role: 'Rep', party: 'D', sponsor_type_id: 2 }])] });
  ok('10 a record whose primary (people_id 18068) is the stated lead Wiener: that one sponsor link is applied', g.r.status === 'written' && g.r.applied.length === 1 && g.r.applied[0].from === 'act-wiener' && !g.same, JSON.stringify(g.r));
  const fed = fedBill({ sponsor_text: 'Rep. Ted Lieu (D-CA), with Rep. Nathaniel Moran (R-TX)' });
  const f = await appliedFor(fed, { [fed.key]: [cgRec([LIEU], 99999, 'HR')] });
  ok('10 a Congress.gov record whose sponsor (bioguide L000582) is the stated lead Lieu: applied, citing the Congress.gov page', f.r.applied.length === 1 && f.r.applied[0].from === 'act-lieu' && f.r.proposed[0].source_url === 'https://www.congress.gov/bill/119th-congress/house-bill/99999' && f.r.proposed[0].quote === 'Rep. Lieu, Ted [D-CA-36]', JSON.stringify(f.r));
  const twoRecs = await appliedFor(fed, { [fed.key]: [cgRec([LIEU], 99999, 'HR'), cgRec([{ bioguideId: 'M001224', firstName: 'Nathaniel', lastName: 'Moran', fullName: 'Rep. Moran, Nathaniel [R-TX-1]', party: 'R', state: 'TX' }], 99998, 'HR')] });
  ok('10 two records naming different primary sponsors: nothing applied', twoRecs.r.applied.length === 0 && twoRecs.same);
  const noUrl = await appliedFor(fed, { [fed.key]: [{ bill: { sponsors: [LIEU] } }] });
  ok('10 a record that names no bill (so no URL and no bill identity): nothing applied, nothing proposed, a note says why', noUrl.r.applied.length === 0 && noUrl.same && !noUrl.r.proposed.some((p) => p.type === 'actor') && noUrl.r.notes.some((n) => /does not name its bill/.test(n.why)));
  // a LegiScan record of the entry's own bill whose URL is not a LegiScan page: still a proposal only (no URL to cite)
  const caNoUrl = caE({ sponsor_text: 'Sen. Scott Wiener (D)' });
  const lsNoUrl = await appliedFor(caNoUrl, { [caNoUrl.key]: [{ bill: { ...lsRec('CA', [WIENER]).bill, url: 'https://legiscan.com.evil.example/x' } }] });
  ok('10 a record of the entry\'s own bill with no public URL to cite: a proposal only', lsNoUrl.r.applied.length === 0 && lsNoUrl.same && lsNoUrl.r.proposed.some((p) => p.type === 'actor' && !p.applies), JSON.stringify(lsNoUrl.r));
  // bill identity (audit L02, L12): a record attached to the entry for ANOTHER bill proves nothing and cites nothing
  const l02 = await appliedFor(fed, { [fed.key]: [cgRec([LIEU], 4242, 'HR')] });
  ok('10 L02: a Congress.gov record of HR 4242 on an entry whose bills are S/HR 99999: nothing applied or proposed, the note names the wrong bill', l02.r.applied.length === 0 && l02.same && !l02.r.proposed.some((p) => p.type === 'actor') && l02.r.notes.some((n) => /HR 4242 \(119th Congress\), which is not one of the entry's bills/.test(n.why)), JSON.stringify(l02.r.notes));
  const l12e = caE({ sponsor_text: 'Sen. Scott Wiener (D)' });
  const l12 = await appliedFor(l12e, { [l12e.key]: [{ bill: { ...lsRec('CA', [WIENER], 12345).bill, url: 'https://legiscan.com/CA/bill/SB1047/2024' } }] });
  ok('10 L12: the LegiScan record of CA SB 1047 (2024, bill 12345) on an entry whose bill is 99001: nothing applied or proposed, with a note', l12.r.applied.length === 0 && l12.same && !l12.r.proposed.some((p) => p.type === 'actor') && l12.r.notes.some((n) => /LegiScan bill 12345 \(CA\), which is not one of the entry's bills \(legiscan 99001\)/.test(n.why)), JSON.stringify(l12.r.notes));
  const mixed = await appliedFor(l12e, { [l12e.key]: [lsRec('CA', [WIENER]), { bill: { ...lsRec('CA', [WIENER], 12345).bill, url: 'https://legiscan.com/CA/bill/SB1047/2024' } }] });
  ok('10 the right record plus one for another bill: nothing applied (any foreign record refuses)', mixed.r.applied.length === 0 && mixed.same);
  const otherState = await appliedFor(l12e, { [l12e.key]: [lsRec('NY', [WIENER])] });
  ok('10 a LegiScan record with the entry\'s bill_id but another state: refused, with a note', otherState.r.applied.length === 0 && otherState.same && otherState.r.notes.some((n) => /NY bill, the entry is a CA bill/.test(n.why)));
  // the guard refuses the same thing on its own: a record-proved edge whose entry's records include another bill's record
  {
    const ge = caE({ sponsor_text: 'Sen. Scott Wiener (D)' }), gd = withEntry(ge), good = { [ge.key]: [lsRec('CA', [WIENER])] };
    const gp = proposeByCode({ entries: gd.entries, relationships: gd.relationships, changed: [ge.key], records: good });
    const ga = applyLinks({ data: gd, proposals: gp.proposals.filter(isApplicable), nodes: gp.nodes });
    const after = ga.relationships;
    const okRun = checkLinks(gd.relationships, after, { ...ga.added, created: [ge.key], records: good }, gd.entries);
    const foreign = { [ge.key]: [{ bill: { ...lsRec('CA', [WIENER], 12345).bill, url: 'https://legiscan.com/CA/bill/S99999/2025' } }] };
    const bad = checkLinks(gd.relationships, after, { ...ga.added, created: [ge.key], records: foreign }, gd.entries);
    const ent = gd.entries.find((x) => x.key === ge.key), edge = ga.added.edges[0];
    ok('10 guard: the same edge passes with its own bill\'s record and stops the run when the record is for another bill (same URL, other bill_id)', ga.added.edges.length === 1 && okRun.length === 0 && bad.some((p) => /not proved by the official record: the record is for LegiScan bill 12345/.test(p)), JSON.stringify({ okRun, bad }));
    ok('10 guard helper: recordProofProblem names the bill mismatch', /not one of the entry's bills/.test(recordProofProblem(edge, ent, after.nodes, foreign, loadActorIds()) || ''));
  }
  const unstored = proposeByCode({ ...withEntry(fed), relationships: real.relationships, changed: [fed.key], records: { [fed.key]: [cgRec([LIEU], 99999, 'HR')] }, actorIds: {} });
  ok('10 a record sponsor with no stored official id: a prose proposal only, with a note', unstored.proposals.every((p) => !isApplicable(p)) && unstored.notes.some((n) => /no stored official id/.test(n.why)));
  // "Del." is its own chamber: never read as a Representative
  ok('10 "Del. Ted Lieu" is not proposed for "Rep. Ted Lieu", with or without a record', !code(fedBill({ sponsor_text: 'Del. Ted Lieu (D-CA)' })).proposals.some((x) => x.from === 'act-lieu'));
}
{
  // actor-ids.json: only unambiguous matches, and the committed file agrees with the matcher
  const nodes = { a: { name: 'Sen. Scott Wiener (CA)', kind: 'actor', column: 5 }, b: { name: 'Rep. Ted Lieu (D-CA)', kind: 'actor', column: 1 }, c: { name: 'Sen. Bill Cunningham (IL)', kind: 'actor', column: 5 }, d: { name: 'Rep. Jane Roe (D-OH)', kind: 'actor', column: 1 }, x: { name: 'Anthropic', kind: 'actor', column: 6 } };
  const P = (id, o) => ({ id, kind: id.split(':')[0], v: id.split(':')[1], ...o });
  const people = [
    P('legiscan:18068', { chamber: 'upper', first: 'Scott', last: 'Wiener', state: 'CA', federal: false, party: 'D' }),
    P('bioguide:L000582', { chamber: 'lower', first: 'Ted', last: 'Lieu', state: 'CA', federal: true, party: 'D' }),
    P('legiscan:1', { chamber: 'upper', first: 'William', last: 'Cunningham', state: 'IL', federal: false }),
    P('bioguide:R1', { chamber: 'lower', first: 'Jane', last: 'Roe', state: 'OH', federal: true, party: 'D' }),
    P('bioguide:R2', { chamber: 'lower', first: 'Jane', last: 'Roe', state: 'OH', federal: true, party: 'D' })
  ];
  const m = matchActorIds(nodes, people);
  ok('10 actor ids: full-name, chamber and state matches get their id', m.ids.a && m.ids.a.legiscan === 18068 && m.ids.b && m.ids.b.bioguide === 'L000582');
  ok('10 actor ids: a nickname (Bill / William) is not matched, and two ids for one node are ambiguous: both listed as unmatched', !m.ids.c && !m.ids.d && m.unmatched.some((u) => u.node === 'c') && m.unmatched.some((u) => u.node === 'd' && /ambiguous/.test(u.why)) && !m.ids.x);
  const stored = loadActorIds();
  ok('10 the committed config/actor-ids.json gives each id to one node only, and only to legislator nodes of the network', Object.keys(stored).length >= 15 && Object.entries(stored).every(([k, v]) => real.relationships.nodes[k] && /^(Sen|Rep|Asm|Del)\./.test(real.relationships.nodes[k].name) && nodeOfId(v.bioguide ? 'bioguide:' + v.bioguide : 'legiscan:' + v.legiscan, stored) === k));
  ok('10 recordUrl: Congress.gov bill page, LegiScan page, nothing for a record without either', recordUrl(cgRec([LIEU], 9917, 'HR')) === 'https://www.congress.gov/bill/119th-congress/house-bill/9917' && recordUrl(lsRec('CA', [WIENER])) === 'https://legiscan.com/CA/bill/S99999/2025' && recordUrl({ bill: { sponsors: [] } }) === null);
}
{
  // backtest: applied (record-proved) and report-only proposals scored separately; applied must be 0 wrong
  const records = { 'h-r-9917-ai-kill-switch-act': [cgRec([LIEU], 9917, 'HR')], 'ca-sb-53-tfaia': [lsRec('CA', [WIENER])] };
  // the test record for SB 53 is LegiScan bill 99001: the entry is given that id so the record is for its own bill
  const withIds = real.entries.map((x) => (x.key === 'ca-sb-53-tfaia' ? { ...x, identifiers: { ...(x.identifiers || {}), external: { ...((x.identifiers && x.identifiers.external) || {}), legiscan: [99001] } } } : x));
  const b = backtest({ entries: withIds, relationships: real.relationships, records });
  const other = backtest({ entries: real.entries.map((x) => (x.key === 'ca-sb-53-tfaia' ? { ...x, identifiers: { external: { legiscan: [12345] } } } : x)), relationships: real.relationships, records });
  ok('10 backtest: a record for another bill (LegiScan 99001 on an entry whose bill is 12345) proves nothing', other.applied.proposals === b.applied.proposals - 1 && other.applied.wrong.length === 0, JSON.stringify(other.applied));
  ok('10 backtest with records: the record-proved sponsor links are applied and right, 0 wrong', b.applied.proposals >= 2 && b.applied.right === b.applied.proposals && b.applied.wrong.length === 0, JSON.stringify(b.applied));
  ok('10 backtest: every other proposal is scored as report-only', b.reportOnly.proposals === b.proposals - b.applied.proposals && b.reportOnly.wrong.length === 0);
  const none = backtest({ entries: real.entries, relationships: real.relationships });
  ok('10 backtest without records: nothing is applied', none.applied.proposals === 0 && none.reportOnly.proposals === none.proposals);
  const lie = backtest({ entries: real.entries, relationships: real.relationships, records: { 'h-r-9917-ai-kill-switch-act': [cgRec([{ ...LIEU, party: 'R' }], 9917, 'HR')] }, sample: ['h-r-9917-ai-kill-switch-act'] });
  ok('10 backtest: a record whose party contradicts the entry proves nothing', lie.applied.proposals === 0);
}

{
  // recordBillProblem: the record's bill must be one of the entry's own bills
  const ent = { state: 'CA', identifiers: { external: { congress_gov: ['119/s/5105', '119/hr/9914'], legiscan: [2015571] } } };
  ok('11 recordBillProblem: a companion bill the entry lists is its own; another number, Congress or LegiScan id is not', recordBillProblem(cgRec([], 9914, 'HR'), ent) === null && recordBillProblem(cgRec([], 5105, 'S'), ent) === null && /not one of/.test(recordBillProblem(cgRec([], 9915, 'HR'), ent)) && /not one of/.test(recordBillProblem({ bill: { congress: 118, type: 'HR', number: 9914 } }, ent)) && recordBillProblem(lsRec('CA', [], 2015571), ent) === null && /not one of/.test(recordBillProblem(lsRec('CA', [], 1), ent)) && /does not name its bill/.test(recordBillProblem({ bill: {} }, ent)));
}
{
  // the Telegram links and news lines say what really happened
  const P = (applies, why) => ({ names: ['Sen. A', 'Bill B'], label: 'Sponsor', applies, why, type: 'actor', method: 'code' });
  const lines = (links, news, extra = {}) => { const rep = newReport({ id: 'u', now: new Date('2026-10-29T06:00:00Z') }); rep.links = links; if (news) rep.news = news; Object.assign(rep, extra); finalize(rep, { now: new Date('2026-10-29T06:01:00Z') }); return formatReport(rep); };
  const base = { proposed: [P(true), P(false, 'sponsor read from the tracker\'s prose, not proved by an official record: a proposal, never added automatically')], applied: [], report_only: [], notes: [], companions: [], problems: [] };
  const w = lines({ ...base, status: 'written', applied: [{ from: 'a', to: 'b' }] });
  ok('11 report, written: "1 added", the proved link marked added, the other "proposal only (reason)"', /Links proposed: 2, 1 added to the network/.test(w) && /Sponsor — added/.test(w) && /Sponsor — proposal only \(sponsor read from the tracker's prose/.test(w), w);
  const off = lines({ ...base, status: 'proposed' });
  ok('11 report, switched off: says so, and the proved link is "not added (adding links is switched off)"', /Links proposed: 2 \(reported only: 1 proved by an official record, not added: adding links is switched off\)/.test(off) && /not added \(adding links is switched off\)/.test(off), off);
  const gated = lines({ ...base, status: 'proposed' }, null, { gate: { off: [{ field: 'relationships', why: 'pass rate 0.9 below 1' }] } });
  ok('11 report, switched off by the gate: names the gate and its reason', /switched off this run by the accuracy gate: pass rate 0\.9 below 1/.test(gated), gated);
  const st = lines({ ...base, status: 'stopped', problems: ['added link a -> b: not proved'] });
  ok('11 report, stopped: "none added (stopped by a check: ...)", never "switched off"', /none added \(stopped by a check: added link a -> b: not proved\)/.test(st) && !/switched off/.test(st), st);
  const held = lines({ ...base, status: 'held' });
  ok('11 report, held: "put back by the final check"', /none added \(put back by the final check\)/.test(held) && !/switched off/.test(held), held);
  const dry = lines({ ...base, status: 'dry-run' });
  ok('11 report, dry run: "would be added (dry run)"', /1 would be added \(dry run, nothing saved\)/.test(dry) && /Sponsor — would be added \(dry run\)/.test(dry) && !/switched off/.test(dry), dry);
  const none = lines({ ...base, proposed: [base.proposed[1]], status: 'proposed', notes: [{ entry_key: 'k', kind: 'sponsor', why: 'chamber mismatch: the record gives ...' }] });
  ok('11 report: nothing record-proved says so, and a refusal note gives its real reason', /reported only: none is proved by an official record/.test(none) && /not proposed: k: chamber mismatch/.test(none) && !/switched off/.test(none), none);
  // news
  const d = (written) => ({ title: 'T', publisher: 'P', written });
  const N = (o) => ({ ran: true, status: 'reported', publishing: false, drafted: [d(false)], leads: [], waiting_record: [], feeds_failed: [], problems: [], ...o });
  const nOff = lines({ ...base, proposed: [], status: 'nothing' }, N({}));
  ok('11 news, switch off: "news publishing is switched off"', /not published \(news publishing is switched off\)/.test(nOff), nOff);
  const nGate = lines({ ...base, proposed: [], status: 'nothing' }, N({}), { gate: { off: [{ field: 'news', why: 'below the bar' }] } });
  ok('11 news, gate: names the gate', /switched off this run by the accuracy gate: below the bar/.test(nGate), nGate);
  const nDry = lines({ ...base, proposed: [], status: 'nothing' }, N({ status: 'dry-run', publishing: true }));
  ok('11 news, dry run with the switch on: "dry run", never "switched off"', /not published \(dry run, nothing saved\)/.test(nDry) && !/switched off/.test(nDry), nDry);
  const nStop = lines({ ...base, proposed: [], status: 'nothing' }, N({ status: 'stopped', publishing: true, problems: ['duplicate event'] }));
  ok('11 news, stopped: the stop rule, never "switched off"', /not published \(stopped by a check: duplicate event\)/.test(nStop) && !/news publishing is switched off/.test(nStop), nStop);
  const nBack = lines({ ...base, proposed: [], status: 'nothing' }, N({ status: 'written', publishing: true, drafted: [d(true), d(false)] }));
  ok('11 news, final check put one back: "1 published, 1 not published (put back by the final check)"', /1 published, 1 not published \(put back by the final check\)/.test(nBack), nBack);
  const nWait = lines({ ...base, proposed: [], status: 'nothing' }, N({ drafted: [], waiting_record: [{ title: 'Release X', publisher: 'Sen. Y', release_date: '2026-10-28' }] }));
  ok('11 news: items waiting for the official record are shown', /News waiting for the official record: 1 \(Release X, Sen\. Y\) — retried next run/.test(nWait), nWait);
}

console.log(`\nlinks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
