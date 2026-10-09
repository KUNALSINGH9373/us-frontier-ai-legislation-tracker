// Run:  node schema/test.mjs   (or npm test, from pipeline/)
// 1) the real, converted data passes every schema and the cross-file checks
// 2) bad input is rejected, so the guard rails are proven and not just assumed
import { makeValidator } from './validate.mjs';
import { convert } from './legacy-to-v2.mjs';
import { checkIntegrity } from './integrity.mjs';

const v = makeValidator();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- 1. real data ----------
const data = await convert();
const bad = data.entries.map((e) => ({ id: e.id, errs: v.check('entry', e) })).filter((r) => r.errs.length);
ok(`all ${data.entries.length} converted entries pass the entry schema`, bad.length === 0, bad.slice(0, 3).map((b) => `#${b.id}: ${b.errs.join('; ')}`).join('\n      '));
ok('news passes', v.check('news', data.news).length === 0, v.check('news', data.news).join('; '));
ok('relationships pass', v.check('relationships', data.relationships).length === 0, v.check('relationships', data.relationships).join('; '));
ok('site settings pass', v.check('site', data.site).length === 0, v.check('site', data.site).join('; '));
ok('reference content passes', v.check('content', data.content).length === 0, v.check('content', data.content).join('; '));
ok('comparison matrix has all 16 rows of tracker.md section K', data.site.comparison_matrix.rows.length === 16);
ok('handbook has its 21 chapters', data.content.handbook.chapters.length === 21);
ok('section notes for A, B.2, C, G.2 and G.3', ['A', 'B.2', 'C', 'G.2', 'G.3'].every((k) => (data.content.section_notes[k] || []).length));
{ const d = clone(data.content); d.about.blocks[0].type = 'script'; ok('content schema rejects an unknown block type', v.check('content', d).length > 0); }
const integrity = checkIntegrity(data);
ok('cross-file references are consistent', integrity.length === 0, integrity.slice(0, 5).join('\n      '));
ok('90 entries, 178 events, 133 edges (matches the live UI)', data.entries.length === 90 && data.entries.reduce((n, e) => n + e.events.length, 0) === 178 && data.relationships.edges.length === 133);

// ---------- 2. the schema rejects bad input ----------
const good = data.entries.find((e) => e.section === 'A');
const state = data.entries.find((e) => e.level === 'state' && e.section === 'B');
const fed = data.entries.find((e) => e.level === 'federal' && e.section === 'D');
const sectionJ = data.entries.find((e) => e.section === 'J');

const automated = (() => {
  const e = clone(good);
  e.origin = 'automated';
  e.identifiers = { bill_number: 'S.B. 53', external: { legiscan_bill_id: 1234567 } };
  e.evidence = [{ field: 'mechanism', quote: 'Frontier AI framework; transparency reports', source_url: 'https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB53' }];
  e.verification = { method: 'agent', checked_at: '2026-10-06T05:17:00Z', run_id: 'run-2026-10-06-0517', rounds: 1 };
  e.confidence = { level: 'HIGH', basis: 'primary_record' };
  e.sources = [{ label: 'Bill text', url: 'https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260SB53', kind: 'primary' }];
  return e;
})();
ok('a well-formed automated entry is accepted', v.check('entry', automated).length === 0, v.check('entry', automated).join('; '));

const rejects = (name, schema, obj) => ok('rejects: ' + name, v.check(schema, obj).length > 0);
{ const e = clone(automated); delete e.evidence; rejects('automated entry with no evidence', 'entry', e); }
{ const e = clone(automated); e.evidence = []; rejects('automated entry with empty evidence', 'entry', e); }
{ const e = clone(automated); delete e.identifiers; rejects('automated entry with no API identifiers', 'entry', e); }
{ const e = clone(automated); e.verification = { method: 'author', checked_at: '2026-10-06T05:17:00Z' }; rejects('automated entry marked as author-verified', 'entry', e); }
{ const e = clone(automated); e.confidence = { level: 'SEARCH-QUALIFIED', basis: 'search_negative' }; rejects('automated "none located" claim', 'entry', e); }
{ const e = clone(automated); e.confidence = { level: 'LOW', basis: 'primary_record' }; rejects('primary-record basis with LOW level', 'entry', e); }
{ const e = clone(automated); e.confidence = { level: 'HIGH', basis: 'secondary' }; rejects('secondary basis with HIGH level', 'entry', e); }
{ const e = clone(automated); e.evidence[0].quote = 'short'; rejects('evidence quote too short to be meaningful', 'entry', e); }
{ const e = clone(automated); e.sources = []; rejects('automated entry with no sources', 'entry', e); }
{ const e = clone(good); e.status = 'approved'; rejects('unknown status', 'entry', e); }
{ const e = clone(good); e.section = 'Z'; rejects('unknown section', 'entry', e); }
{ const e = clone(good); e.events[0].date = '2026-9-29'; rejects('date not in YYYY-MM-DD form', 'entry', e); }
{ const e = clone(good); e.events[0].type = 'Signed'; rejects('unknown event type', 'entry', e); }
{ const e = clone(good); e.extra_field = 1; rejects('unknown extra field', 'entry', e); }
{ const e = clone(good); e.key = 'CA SB 53'; rejects('key that is not a slug', 'entry', e); }
{ const e = clone(good); delete e.mechanism; rejects('missing mechanism', 'entry', e); }
{ const e = clone(good); e.sources = [{ label: 'x', url: 'not a url', kind: 'primary' }]; rejects('source with an invalid URL', 'entry', e); }
{ const e = clone(fed); e.state = 'CA'; rejects('federal entry placed on a state tile', 'entry', e); }
{ const e = clone(state); e.state = null; rejects('state entry with no state', 'entry', e); }
if (sectionJ) { const e = clone(sectionJ); e.status = 'pending'; rejects('excluded (J) entry that is not "excluded"', 'entry', e); const f = clone(sectionJ); f.confidence = { level: 'HIGH', basis: 'primary_record' }; rejects('excluded (J) entry given a confidence rating', 'entry', f); }

{ const n = clone(data.news); n.items[0].origin = 'automated'; rejects('automated news item with no evidence', 'news', n); }
{ const n = clone(data.news); n.items[0].links = []; rejects('news item with no link', 'news', n); }
{ const n = clone(data.news); n.items[0].kind = 'sports'; rejects('unknown news kind', 'news', n); }
{ const r = clone(data.relationships); r.edges[0].origin = 'automated'; delete r.edges[0].source_url; rejects('automated link with no source URL', 'relationships', r); }
{ const r = clone(data.relationships); delete r.edges[0].quote; rejects('link with no quote', 'relationships', r); }
{ const r = clone(data.relationships); r.edges[0].type = 'friendship'; rejects('unknown link type', 'relationships', r); }
{ const r = clone(data.relationships); const k = Object.keys(r.nodes).find((x) => r.nodes[x].kind === 'entry'); delete r.nodes[k].entry_key; rejects('entry node with no entry key', 'relationships', r); }

// pipeline files
const run = 'run-2026-10-06-0517';
const verdictOk = { run_id: run, item_id: 'i1', attempt: 1, passed: false, code_checks: [{ name: 'quote_in_source', passed: true }], claims: [{ field: 'thresholds', claim: 'covers developers above $500M revenue', supported: false, reason: 'Section 4(b) says $100M, not $500M.' }] };
ok('a well-formed validator verdict is accepted', v.check('verdict', verdictOk).length === 0, v.check('verdict', verdictOk).join('; '));
{ const x = clone(verdictOk); delete x.claims[0].reason; rejects('unsupported claim with no reason (the generator could not fix it)', 'verdict', x); }
{ const x = clone(verdictOk); x.attempt = 4; rejects('a 4th attempt (cap is 3)', 'verdict', x); }
{ const x = { version: 1, sources: { congress_gov: { last_success: '2026-10-06T05:17:00Z', cursor: null } } }; ok('a well-formed state file is accepted', v.check('state', x).length === 0, v.check('state', x).join('; ')); const y = clone(x); y.sources.congress_gov.last_success = 'yesterday'; rejects('state file with a bad timestamp', 'state', y); }
{ const x = { run_id: run, generated_at: '2026-10-06T05:17:00Z', items: [{ item_id: 'i1', source: 'congress_gov', source_id: '119/hr/9925', entry_key: null, change: 'new', source_url: 'https://www.congress.gov/bill/119th-congress/house-bill/9925', fetched_at: '2026-10-06T05:17:00Z', raw_hash: 'abc', raw_path: 'raw/i1.json' }] }; ok('a well-formed change set is accepted', v.check('changeset', x).length === 0, v.check('changeset', x).join('; ')); const y = clone(x); y.items[0].change = 'deleted'; rejects('change set with an unknown change kind', 'changeset', y); }
{ const x = { run_id: run, started_at: '2026-10-06T05:17:00Z', finished_at: '2026-10-06T05:20:00Z', status: 'success', counts: { fetched: 10, changed: 2, published: 1, held: 1 } }; ok('a well-formed run log is accepted', v.check('runlog', x).length === 0, v.check('runlog', x).join('; ')); const y = clone(x); y.counts.held = -1; rejects('run log with a negative count', 'runlog', y); }

// ---------- 3. cross-file checks catch broken references ----------
{ const d = clone(data); d.news.items.find((n) => n.tracker).tracker = 'no-such-entry'; ok('integrity: catches a news item pointing at a missing entry', checkIntegrity(d).length > 0); }
{ const d = clone(data); d.relationships.edges[0].from = 'NOPE'; ok('integrity: catches a link to an unknown node', checkIntegrity(d).length > 0); }
{ const d = clone(data); d.entries[1].key = d.entries[0].key; ok('integrity: catches a duplicate key', checkIntegrity(d).length > 0); }
{ const d = clone(data); d.entries[0].events[0].date = '2026-02-31'; ok('integrity: catches an impossible calendar date', checkIntegrity(d).length > 0); }
{ const d = clone(data); d.site.replay_milestones[0].entry_key = 'gone'; ok('integrity: catches a milestone pointing at a missing entry', checkIntegrity(d).length > 0); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
