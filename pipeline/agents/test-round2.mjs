// Round 2 regressions (29 Oct 2026 audit of Tier B new entries and the gate). No AI, no network.
//   node agents/test-round2.mjs
import { asSlots } from './test-slots-helper.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { programmeDuplicateOf, duplicateOf, trackerIndex } from './dedupe.mjs';
import { sectionsByCode, quoteMeetsSection } from './rules.mjs';
import { deriveCreate, stateSections, stateStatus } from './derive.mjs';
import { thresholdNumberProblems, normaliseExponents } from './checks.mjs';
import { digitRuns } from './source-text.mjs';
import { measureKind } from './record-kind.mjs';
import { processItem, refereeSection } from './process-item.mjs';
import { runAgents, memoSkip, memoRecord } from './run.mjs';
import { newsFor } from '../publish/tier-b.mjs';
import { checkNewEntry } from '../publish/guards.mjs';
import { createCongress, relatedBill } from '../grabber/sources/congress.mjs';
import { runTierBSet } from '../eval/tierb-set.mjs';
import { runNewsSet, NEWS_SET } from '../eval/news-set.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const J = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const SET = path.join(here, '..', 'eval', 'tierb-set');
const rec = (n) => J(path.join(SET, 'records', n + '.json')), draft = (n) => J(path.join(SET, 'drafts', n + '.json'));
const ENTRIES = J(path.join(here, '..', '..', 'web', 'data', 'v2', 'entries.json'));
// The live site data without any entry that already tracks this record (by its LegiScan id, or its state and number in the entry's key),
// for a test that uses a real bill as an example NEW bill: the test keeps measuring what it means to as the site adds bills (AZ H.B. 4098
// was added by hand on 31 Oct 2026, and the duplicate check then held it before the step this test checks).
const asNew = (r) => { const b = (r.raw && r.raw.bill) || {}, tag = `${b.state || ''}${b.bill_number || ''}`.toLowerCase(); return ENTRIES.filter((e) => !(((e.identifiers || {}).external || {}).legiscan || []).map(String).includes(String(r.item.source_id)) && !(tag && e.key.replace(/-/g, '').includes(tag))); };
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const scripted = (queue) => ({ calls: 0, async generate() { this.calls++; const r = queue.shift(); if (!r) throw new Error('unexpected AI call'); return { data: asSlots(typeof r === 'function' ? r() : r), usage: {} }; } });
const trap = () => ({ calls: 0, async generate() { this.calls++; throw new Error('AI must not be called'); } });
const diffOf = (item) => ({ item_id: item.item_id, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'test' }] });

// 1. the same programme under another bill
{
  const ct = draft('CT-HB5222'), p = programmeDuplicateOf(ct, ENTRIES);
  ok('1 CT HB5222 is the IVO pilot of P.A. 26-15 re-enacted: a possible duplicate, never created', p && /^ct-p-a-26-15/.test(p.key) && p.possible, JSON.stringify(p));
  ok('1 a different programme of another state is not a duplicate (AZ HB4098 draft)', programmeDuplicateOf(draft('AZ-HB4098'), ENTRIES) === null);
  const r = rec('CT-HB5222'), g = scripted([{ operation: 'create', in_scope: true, scope_reason: 'An IVO pilot program.', fields: { mechanism: ct.mechanism, thresholds: ct.thresholds }, events_add: [], evidence: [], notes: '' }]), v = trap();
  const out = await processItem({ generator: g, validator: v, referee: trap(), item: r.item, raw: r.raw, diff: diffOf(r.item), entries: ENTRIES, today: '2026-10-29', runId: 't' });
  ok('1 the agents hold it right after the draft, with no reader or referee spent, and report it', out.outcome === 'held' && out.possible_duplicate && v.calls === 0 && g.calls === 1 && out.escalate && /duplicate or update/.test(out.proposal), `${out.outcome} ${out.reason}`);
}
// 2. section criteria in code
{
  const code = (n) => { const r = rec(n).raw; return sectionsByCode(r.text, stateSections(stateStatus(r.bill))).join(); };
  ok('2 NJ A2478, WA HB2503, VA SB365 (both ids), NY A03356 meet no section', ['NJ-A2478', 'WA-HB2503', 'VA-SB365-2085502', 'VA-SB365-2160653', 'NY-A03356'].every((n) => code(n) === ''));
  ok('2 AZ HB4098, NE LB1083, PA HB2829 are B by code; CT HB5222 (enacted, IVO pilot) is C', code('AZ-HB4098') === 'B' && code('NE-LB1083-r2') === 'B' && code('PA-HB2829') === 'B' && code('CT-HB5222') === 'C');
  ok('2 code sets the section when exactly one qualifies', deriveCreate({ item: rec('AZ-HB4098').item, raw: rec('AZ-HB4098').raw }).section === 'B');
  ok('2 a referee quote must show the section\'s own criterion', quoteMeetsSection('B', 'frontier model means an artificial intelligence model') && quoteMeetsSection('B.2', 'shall assess catastrophic risk') && !quoteMeetsSection('C', 'The board shall assess impact') && !quoteMeetsSection('B.2', 'catastrophic risk of a frontier model'));
  const ref = scripted([{ results: [{ n: 1, supported: true, quote: 'artificial intelligence business shall conduct', reason: null }] }]);
  const s = await refereeSection(ref, rec('AZ-HB4098').raw.text, 'B', 'x');
  ok('2 a referee "yes" whose quote lacks the criterion holds the entry', !s.ok && /does not show/.test(s.why), JSON.stringify(s));
  for (const n of ['NJ-A2478', 'WA-HB2503', 'VA-SB365-2085502']) {
    const r = rec(n), g = trap(), out = await processItem({ generator: g, validator: trap(), referee: trap(), item: r.item, raw: r.raw, diff: diffOf(r.item), entries: ENTRIES, today: '2026-10-29', runId: 't' });
    ok(`2 ${n} is held before any AI is spent (no section), and reported`, out.outcome === 'held' && out.no_section && g.calls === 0 && !!out.proposal);
  }
  ok('2 the publisher refuses a state entry without a section quote meeting its criterion', checkNewEntry({ ...draft('NJ-A2478'), evidence: (draft('NJ-A2478').evidence || []).filter((x) => x.field !== 'section') }).some((p) => /criterion/.test(p)));
}
// 3. numeric sanity
{
  ok('3 a lost exponent is caught', thresholdNumberProblems('thresholds', 'greater than 10.26 computational operations').length > 0 && thresholdNumberProblems('thresholds', '1026 operations').length > 0);
  ok('3 and normalised only when unambiguous', normaliseExponents('greater than 10.26 computational operations') === 'greater than 10^26 computational operations' && normaliseExponents('10.5 operations') === '10.5 operations');
  ok('3 an implausible magnitude is caught; a correct threshold passes', thresholdNumberProblems('t', '10^12 operations').length === 1 && thresholdNumberProblems('t', '5,000 floating-point operations').length === 1 && thresholdNumberProblems('t', 'more than 10^26 integer or floating-point operations').length === 0 && thresholdNumberProblems('t', '10 ^ 26 operations').length === 0);
  ok('3 the source\'s "10.26 computational operations" reads as 10 and 26 for the number check', digitRuns('using greater than 10.26 computational operations').has('26'));
  ok('3 the AZ draft as recorded ("10.26") is refused by the publisher', checkNewEntry(draft('AZ-HB4098')).some((p) => /lost exponent/.test(p)));
}
// 4. Congress related bills
{
  const pages = { 'relatedbills?format=json&limit=250&offset=0': { relatedBills: [{ congress: 119, type: 'S', number: 2938, title: 'x', relationshipDetails: [{ type: 'Related bill', identifiedBy: 'CRS' }] }] } };
  const c = createCongress({ getJson: async (u) => pages[Object.keys(pages).find((k) => u.endsWith(k))] || {} });
  const rel = await c.getRelatedBills({ congress: 119, type: 'hr', number: 1 });
  ok('4 the grabber reads related bills with their relationship type and number', rel.length === 1 && rel[0].type === 's' && rel[0].number === 2938 && rel[0].relationshipDetails[0].type === 'Related bill' && relatedBill({ type: 'HR', number: 5 }).type === 'hr');
  const idx = trackerIndex(ENTRIES), item = { item_id: 'congress_gov:119/hr/1', source: 'congress_gov' };
  const d = duplicateOf({ item, raw: { related_bills: rel }, idx });
  ok('4 a bill related (not identical) to a tracked bill is held as a possible duplicate', d && d.possible, JSON.stringify(d));
  const r = rec('HR9442'), g = trap(), out = await processItem({ generator: g, validator: trap(), referee: trap(), item: r.item, raw: r.raw, diff: diffOf(r.item), entries: ENTRIES, today: '2026-10-29', runId: 't' });
  ok('4 related bills not read: held before any AI is spent', out.outcome === 'held' && g.calls === 0 && /not read/.test(out.reason));
  const r2 = JSON.parse(JSON.stringify(r)); r2.raw.related_bills = Array.from({ length: r2.raw.bill.relatedBills.count }, (_, k) => ({ congress: 119, type: 'HR', number: 1 + k, relationshipDetails: [{ type: 'Related bill' }] })); // round 3: the whole list, as many as the count
  r2.raw.bill.title = 'Artificial Intelligence Moratorium Act'; // round 4: a "Data Center" title is held as one of F's OUT subjects
  const g2 = trap(); let reached = false; try { await processItem({ generator: g2, validator: trap(), referee: trap(), item: r2.item, raw: r2.raw, diff: diffOf(r2.item), entries: ENTRIES, today: '2026-10-29', runId: 't' }); } catch { reached = true; }
  ok('4 with its related bills stored (none tracked), it goes on to the readers', reached && g2.calls === 1);
}
// 5. a failed scope quote is never "out"
{
  const r = rec('AZ-HB4098'), d = draft('AZ-HB4098');
  const patch = { operation: 'create', in_scope: true, scope_reason: 'Frontier model duties.', fields: { mechanism: 'An artificial intelligence business must submit a transparency report to the attorney general.' }, events_add: [], evidence: [{ field: 'mechanism', quote: 'shall submit a transparency report to the attorney general' }], notes: '' };
  const claimsIn = (p) => [...p.matchAll(/^(\d+)\. \[([^\]]+)\]/gm)].map((m) => ({ n: +m[1], field: m[2] }));
  const val = (retryQuote) => ({ calls: 0, async generate(req) { this.calls++; const retry = /previous answer to this claim/.test(req.prompt); return { usage: {}, data: { results: claimsIn(req.prompt).map((c) => ({ n: c.n, supported: true, quote: c.field === 'in_scope' ? (retry ? retryQuote : 'words that are not in the bill at all') : 'shall submit a transparency report to the attorney general', reason: null })) } }; } });
  const refOut = scripted([{ results: [{ n: 1, supported: false, quote: null, reason: 'not about frontier AI' }] }]);
  const out = await processItem({ generator: scripted([patch]), validator: val('also not in the bill'), referee: refOut, item: r.item, raw: r.raw, diff: diffOf(r.item), entries: asNew(r), today: '2026-10-29', runId: 't' });
  ok('5 a supported verdict with a failed quote: retry, then referee, then held and reported (not "out")', out.outcome === 'held' && /scope was not proved/.test(out.reason) && !!out.proposal && !/person/.test(out.reason), `${out.outcome} ${out.reason}`);
  const v2 = val('frontier model of artificial intelligence that is owned or operated by a large developer');
  const out2 = await processItem({ generator: scripted([patch, () => { throw new Error('stop'); }]), validator: v2, referee: scripted([{ results: [{ n: 1, supported: true, quote: 'frontier model of artificial intelligence that is owned or operated by a large developer', reason: null }] }, { results: [{ n: 1, supported: true, quote: 'frontier model of artificial intelligence that is owned or operated by a large developer', reason: null }] }]), item: r.item, raw: r.raw, diff: diffOf(r.item), entries: ENTRIES, today: '2026-10-29', runId: 't' }).catch((e) => ({ outcome: 'reached-duties', e }));
  ok('5 an exact quote on the retry settles the scope (the item goes on, never "out")', out2.outcome !== 'out_of_scope' && !/scope/.test(out2.reason || ''), `${out2.outcome} ${out2.reason || ''}`);
  void d;
}
// 6 + N1. held items are not read again until their record changes; dead bills not while they stay dead
{
  const memo = { items: {} }, item = { item_id: 'legiscan:1', raw_hash: 'h1', source: 'legiscan' }, raw = { bill: { status: 6 } };
  memoRecord(memo, item, raw, { outcome: 'held', escalate: true, reason: 'duties unproved', proposal: 'p' }, '2026-10-29');
  ok('6 a held item is remembered; same record: skipped', !!memoSkip(memo, item, raw));
  ok('6 a dead bill is not read again while it stays dead, even if its record changes', !!memoSkip(memo, { ...item, raw_hash: 'h2' }, raw) && !memoSkip(memo, { ...item, raw_hash: 'h2' }, { bill: { status: 1 } }));
  { // a draft held only because new entries were switched off is not read again while they stay off, and is read again once they are on
    const m = { items: {} }; memoRecord(m, item, raw, { outcome: 'held', escalate: true, unconfirmed: true, reason: 'not confirmed: new entries are switched off', proposal: 'p' }, '2026-10-29');
    ok('6 an unconfirmed draft (new entries off) is skipped while off, read again when on', !!memoSkip(m, item, raw, { newEntriesOn: false }) && !memoSkip(m, item, raw, { newEntriesOn: true }) && !memoSkip(m, item, raw));
  }
  ok('6 a model-service failure is never remembered', (() => { const m = { items: {} }; memoRecord(m, item, raw, { outcome: 'held', escalate: false, service_error: true }, 'x'); return !m.items['legiscan:1']; })());
  // runAgents end to end: the CT duplicate spends a generator call on run 1, nothing on run 2, and is read again when its record changes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-memo-')), memoFile = path.join(dir, 'memo.json'), r = rec('CT-HB5222'), ct = draft('CT-HB5222');
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true }); fs.writeFileSync(path.join(dir, 'raw', 'ct.json'), JSON.stringify(r.raw));
  const run = async (hash) => {
    fs.writeFileSync(path.join(dir, 'changeset.json'), JSON.stringify({ run_id: 'run-t', items: [{ ...r.item, raw_path: 'raw/ct.json', raw_hash: hash }] }));
    fs.writeFileSync(path.join(dir, 'diff.json'), JSON.stringify({ items: [diffOf(r.item)] }));
    const g = scripted([{ operation: 'create', in_scope: true, scope_reason: 'IVO pilot.', fields: { mechanism: ct.mechanism }, events_add: [], evidence: [], notes: '' }]);
    // No "writer" role: this memo test scripts the generator loop (the simple build has its own tests, agents/test-newbill.mjs).
    const factory = { keyName: 'K', ledger: { itemTokens: () => g.calls * 1000, totals: () => ({}) }, make: (role) => (role === 'generator' ? g : role === 'writer' ? null : trap()) };
    const s = await runAgents({ runDir: dir, entries: ENTRIES, config: {}, factory, today: '2026-10-29', memoFile });
    return { s, g };
  };
  const a = await run('hash-1'), b = await run('hash-1'), c = await run('hash-2');
  ok('N1 run 1 reads it once, holds it and reports the proposal once', a.g.calls === 1 && a.s.items[0].outcome === 'held' && a.s.proposals.length === 1);
  ok('N1 run 2 (record unchanged) spends no tokens and reports nothing again', b.g.calls === 0 && b.s.items[0].tokens === 0 && b.s.not_reread === 1 && b.s.proposals.length === 0);
  ok('N1 a changed record is read again', c.g.calls === 1);
}
// 8. news for a new entry describes its current status today
{
  const r = rec('CT-HB5222'), d = deriveCreate({ item: r.item, raw: r.raw });
  const e = { key: 'ct-hb-5222', section: 'C', level: 'state', state: 'CT', title: d.fields.title, short_name: d.fields.short_name, sponsor_text: d.fields.sponsor_text, events: d.events };
  const n = newsFor(e, r.item, r.raw, 'run', '2026-10-29T00:00:00Z');
  ok('8 an enacted bill is reported as enacted, dated today, not as a backdated "introduced"', n.date === '2026-10-29' && n.title === 'CT HB 5222: enacted' && /was enacted on June 2, 2026 \("Signed by the Governor"\)/.test(n.body), n.body);
  ok('8 the item reads cleanly (no "Established. was", "the General Law Committee")', !/\.\s+was\b|\.\)?\s*was introduced/.test(n.body.replace(/"[^"]*"/g, '""')) && /sponsored by the General Law Committee/.test(n.body), n.body);
}
// 10. record kind
{
  ok('10 a record numbered as a resolution is refused whatever LegiScan\'s type says', measureKind({ bill_number: 'HR6023', bill_type_id: 1 }) === 'resolution' && measureKind({ bill_number: 'HB12', bill_type_id: 1 }, 'BE IT RESOLVED by the House') === 'resolution');
  ok('10 the resolution-number rule is a state rule: a federal H.R. bill is not refused by it', !checkNewEntry({ section: 'D', type: 'bill', level: 'federal', jurisdiction: 'Federal', state: null, status: 'pending', title: 'H.R. 9442 — A bill', origin: 'automated', verification: { method: 'agent' }, events: [] }).some((p) => /resolution/.test(p)));
}
// 9. the measure sets run at zero wrong on the current code
{
  const t = await runTierBSet();
  ok('9 the Tier B replay set: zero wrong', t.cases >= 15 && t.wrong === 0, JSON.stringify(t.rows.filter((x) => x.wrong)));
  const n = await runNewsSet({ cases: J(NEWS_SET).cases });
  ok('9 the recorded news leads set: zero wrong', n.cases >= 5 && n.wrong === 0, JSON.stringify(n.rows.filter((x) => x.wrong)));
}
console.log(`round 2: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
