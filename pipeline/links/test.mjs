// Run:  node links/test.mjs
// The links step with scripted models (no AI, no network) on copies of the real site data: the code proposer finds sponsor and
// amendment links with zero false links on the real network (backtest), AI links need both quotes and the validator, applying
// only ever adds, the stop rules refuse any other change to the network, and the link map can draw everything added.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { proposeByCode, proposeByAI, propose, citations, clauses, leadSponsors, nodeFor, companions, LABEL } from './propose.mjs';
import { applyLinks } from './apply.mjs';
import { linkRun } from './run.mjs';
import { backtest } from './backtest.mjs';
import { checkPublish } from '../publish/guards.mjs';
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
  return { ...base, id: Math.max(...ids) + 1, key: 'test-new-bill', title: 'S.99999 — test bill', short_name: 'NY S.99999 (test)', sponsor_text: 'Sen. Jane Doe (D)', mechanism: 'Requires reports.', thresholds: null, sources: [{ label: 'text', url: 'https://www.nysenate.gov/legislation/bills/2025/S99999', kind: 'primary' }], ...o };
}
const withEntry = (e) => ({ ...clone(real), entries: [...clone(real.entries), e] });

// ---------- 1. the backtest on the real network: zero false links ----------
{
  const b = backtest({ entries: real.entries, relationships: real.relationships });
  ok('1 the code proposer makes no false link on the real network', b.falseLinks.length === 0, b.falseLinks.map((f) => `${f.from} -> ${f.to}`).join(', '));
  ok('1 it recovers at least the 36 links it recovered when built (33 sponsors, 3 amendments)', b.recovered.size >= 36, `recovered ${b.recovered.size}`);
  ok('1 every succession link it recovers is a bill amending the RAISE Act', [...b.recovered].filter((k) => k.endsWith('|succession')).every((k) => k.includes('RAISE')));
  const fresh = backtest({ entries: real.entries, relationships: real.relationships, asNew: true });
  ok('1 as brand-new bills (their node removed too) still no false link and the same recall', fresh.falseLinks.length === 0 && fresh.recovered.size === b.recovered.size);
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
  const d = withEntry(e);
  const r = proposeByCode({ entries: d.entries, relationships: d.relationships, changed: [e.key] });
  const dup = { ...clone(r.proposals[0]) }, old = real.relationships.edges[0];
  const reverse = { from: old.to, to: old.from, type: old.type, label: 'Same link the other way', evidence: [{ entry_key: 'x', quote: 'a quote that is long', source_url: 'https://example.gov/x' }], method: 'code' };
  const noQuote = { ...clone(r.proposals[0]), type: 'template', evidence: [{ entry_key: e.key, quote: '', source_url: null }] };
  const a = applyLinks({ data: d, proposals: [...r.proposals, dup, reverse, noQuote], nodes: { ...r.nodes, UNUSED: { name: 'never used', column: 4, kind: 'entry', entry_key: e.key } } });
  ok('5 the sponsor and amendment links are added', a.added.edges.length === 2 && a.added.edges.every((x) => x.origin === 'automated' && x.source_url && x.quote.length >= 8), JSON.stringify(a.skipped.map((s) => s.why)));
  ok('5 a duplicate, an existing link reversed, and a link without a quote are skipped', a.skipped.length === 3 && a.skipped.filter((s) => s.why === 'already in the network').length === 2);
  ok('5 only nodes a new link uses are added', Object.keys(a.added.nodes).length === 1 && !a.relationships.nodes.UNUSED);
  ok('5 every old node and edge is unchanged and in place', JSON.stringify(a.relationships.edges.slice(0, real.relationships.edges.length)) === JSON.stringify(real.relationships.edges) && Object.keys(real.relationships.nodes).every((k) => JSON.stringify(a.relationships.nodes[k]) === JSON.stringify(real.relationships.nodes[k])));
  ok('5 the result passes integrity and the relationships schema', !a.problems.length && !checkIntegrity({ ...d, relationships: a.relationships }).length && !makeValidator().check('relationships', a.relationships).length, a.problems.join('; '));
  const m = await mapCheck({ ...d, relationships: a.relationships });
  ok('5 the link map draws every end of every link, with no duplicate node', !m.problems.length, m.problems.join('; '));
  const ghost = applyLinks({ data: d, proposals: [{ ...r.proposals[0], from: 'NO-SUCH-NODE' }] });
  ok('5 a link to an unknown node is skipped', !ghost.added.edges.length && /unknown node/.test(ghost.skipped[0].why));

  // ---------- 6. the stop rules: the network may only grow by exactly what apply added ----------
  const before = d, after = { ...d, relationships: a.relationships };
  const run = (aft, links) => checkPublish({ before, after: aft, runDate: '2026-10-28', maxEntries: 15, newKeys: [e.key], maxNew: 1, links }).problems.filter((p) => /relationships|added link/.test(p));
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
  return { dir, dataDir: path.join(dir, 'data'), docsDir: path.join(dir, 'docs'), key: e.key };
}
{
  const sb = sandbox(), relFile = path.join(sb.dataDir, 'relationships.json'), was = fs.readFileSync(relFile, 'utf8');
  const off = await linkRun({ dataDir: sb.dataDir, docsDir: sb.docsDir, changed: [sb.key], config: { auto_publish: { relationships: false } }, runDate: '2026-10-28' });
  ok('7 switched off: the links are proposed and nothing is written', off.status === 'proposed' && off.proposed.length === 2 && !off.applied.length && fs.readFileSync(relFile, 'utf8') === was);
  ok('7 the report names both ends and the quote', off.proposed.every((p) => p.names[0] && p.names[1] && p.quote) && /reported only/.test(off.summary));
  const rep = newReport({ id: 'update-test', now: new Date('2026-10-28T06:00:00Z') }); rep.links = off; finalize(rep, { now: new Date('2026-10-28T06:01:00Z') });
  const text = formatReport(rep);
  ok('7 the Telegram report lists them under "Links proposed"', /Links proposed: 2 \(reported only/.test(text) && /NY S\.99999 \(test\) → NY RAISE Act/.test(text), text);
  const on = await linkRun({ dataDir: sb.dataDir, docsDir: sb.docsDir, changed: [sb.key], config: { auto_publish: { relationships: true } }, runDate: '2026-10-28' });
  const written = JSON.parse(fs.readFileSync(relFile, 'utf8')), docs = JSON.parse(fs.readFileSync(path.join(sb.docsDir, 'relationships.json'), 'utf8'));
  ok('7 switched on: the links are added to the data and the live copy', on.status === 'written' && on.applied.length === 2 && written.edges.length === real.relationships.edges.length + 2 && docs.edges.length === written.edges.length, on.problems.join('; '));
  ok('7 the written network keeps every old edge in place', JSON.stringify(written.edges.slice(0, real.relationships.edges.length)) === JSON.stringify(real.relationships.edges));
  const again = await linkRun({ dataDir: sb.dataDir, docsDir: sb.docsDir, changed: [sb.key], config: { auto_publish: { relationships: true } }, runDate: '2026-10-28' });
  ok('7 a second run adds nothing (dedupe)', again.status === 'nothing' && JSON.parse(fs.readFileSync(relFile, 'utf8')).edges.length === written.edges.length);
  const dry = sandbox();
  const dr = await linkRun({ dataDir: dry.dataDir, changed: [dry.key], config: { auto_publish: { relationships: true } }, runDate: '2026-10-28', dry: true });
  ok('7 a dry run checks but writes nothing', dr.status === 'dry-run' && JSON.parse(fs.readFileSync(path.join(dry.dataDir, 'relationships.json'), 'utf8')).edges.length === real.relationships.edges.length);
  for (const s of [sb, dry]) fs.rmSync(s.dir, { recursive: true, force: true });
}

console.log(`\nlinks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
