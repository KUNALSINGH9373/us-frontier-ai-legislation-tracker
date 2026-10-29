// Regression tests for the 28 Oct 2026 replay audit of the new-entries step (6 entries would have published, 0 correct). Each block
// is one finding, on the real LegiScan records the audit replayed (fixtures/legiscan/audit-2026-10-28) or a minimal stand-in.
//   node agents/test-audit.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { recordRefusals, measureKind, placeholderTitle, amendmentRecord } from './record-kind.mjs';
import { trackerIndex, duplicateOf, relatedUnread, numbersIn, statesOf } from './dedupe.mjs';
import { stateSectionProblems, frontierDutyPassage } from './rules.mjs';
import { deriveCreate, stateSponsorText } from './derive.mjs';
import { assembleEntry, dedupeEvents } from './assemble.mjs';
import { processItem } from './process-item.mjs';
import { SCOPE_CLAIM } from './prompts.mjs';
import { escalationBudget } from './budget.mjs';
import { checkNewEntry } from '../publish/guards.mjs';
import { applyTierB } from '../publish/tier-b.mjs';
import { createLedger, BudgetExceeded } from '../llm/gemini.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const J = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const fx = (n) => J(path.join(here, '..', 'fixtures', 'legiscan', 'audit-2026-10-28', n + '.json'));
const ENTRIES = J(path.join(here, '..', '..', 'web', 'data', 'v2', 'entries.json')); // read only
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const MA = fx('MA-S3224'), NJ = fx('NJ-SR52'), KS = fx('KS-HR6023'), OH = fx('OH-SCR14'), NE = fx('NE-LB1083');
const idx = trackerIndex(ENTRIES);

// ---------- 4. LegiScan facts are not trusted blindly ----------
ok('MA S3224: the placeholder title "Site Information & Links" is refused', placeholderTitle(MA.raw.bill.title) && recordRefusals(MA.raw).some((p) => /placeholder title/.test(p)));
ok('MA S3224: an amendment filed as its own record is refused', !!amendmentRecord(MA.raw.bill, MA.raw.text) && recordRefusals(MA.raw).some((p) => /amendment record/.test(p)));
ok('NE LB1083 (a real bill) is not refused', recordRefusals(NE.raw).length === 0 && measureKind(NE.raw.bill, NE.raw.text) === 'bill', JSON.stringify(recordRefusals(NE.raw)));
ok('NJ SR52: both sponsors are Senators (the text says so), not "Rep" as LegiScan has it', deriveCreate({ item: NJ.item, raw: NJ.raw }).fields.sponsor_text === 'Sen. Raj Mukherji (D); Sen. Joseph Lagana (D)', deriveCreate({ item: NJ.item, raw: NJ.raw }).fields.sponsor_text);
ok('a role that contradicts the chamber and is not in the text is left out, never guessed', stateSponsorText([{ role: 'Rep', name: 'A Person', last_name: 'Person', party: 'D', sponsor_type_id: 1 }], { bill_number: 'S12', text: 'no names here' }) === 'A Person (D)');
ok('KS HR6023: a committee sponsor is labelled as a committee', deriveCreate({ item: KS.item, raw: KS.raw }).fields.sponsor_text === 'Legislative Modernization (committee)', deriveCreate({ item: KS.item, raw: KS.raw }).fields.sponsor_text);

// ---------- 3. section by kind of measure ----------
for (const [n, x] of [['KS HR6023', KS], ['OH SCR14', OH], ['NJ SR52', NJ]]) {
  ok(`${n}: a resolution is refused before any AI is spent`, measureKind(x.raw.bill, x.raw.text) === 'resolution' && recordRefusals(x.raw).some((p) => /resolution/.test(p)));
  ok(`${n}: a resolution never goes in A, B or B.2`, ['A', 'B', 'B.2'].every((s) => stateSectionProblems(s, 'resolution', null).length === 1));
}
ok('a resolution with no LegiScan type is still read as one from its number', measureKind({ bill_number: 'HCR031' }) === 'resolution' && measureKind({ bill_number: 'HB2829' }) === 'bill');
const CT_TEXT = 'Sec. 47. (a) The Department of Consumer Protection shall, within available appropriations, develop and administer a pilot program for independent verification organizations to assess artificial intelligence models.';
const SB53_TEXT = 'A large frontier developer shall write, implement, comply with, and clearly and conspicuously publish on its internet website a frontier AI framework. "Frontier model" means a foundation model trained using a quantity of computing power greater than 10^26 integer or floating-point operations.';
ok('CT HB5222: A is refused when the enacted text has no frontier duties (only an IVO pilot)', !frontierDutyPassage(CT_TEXT) && stateSectionProblems('A', 'bill', CT_TEXT).some((p) => /section A needs/.test(p)));
ok('an enacted law with frontier-developer duties may go in A', !!frontierDutyPassage(SB53_TEXT) && stateSectionProblems('A', 'bill', SB53_TEXT).length === 0);
ok('the publish guard refuses a resolution-numbered title in B', checkNewEntry({ section: 'B', type: 'bill', level: 'state', status: 'pending', state: 'KS', jurisdiction: 'KS', title: 'H.R. 6023 — Opposing the federal preemption', identifiers: { external: { legiscan: [1] }, session: 's' }, origin: 'automated', verification: { method: 'agent' }, events: [], evidence: [] }).some((p) => /resolution/.test(p)));
ok('the publish guard refuses A for a text without frontier duties', checkNewEntry({ section: 'A', type: 'law', level: 'state', status: 'enacted', state: 'CT', jurisdiction: 'CT', title: 'H.B. 5222 — An Act', identifiers: { external: { legiscan: [1] }, session: 's' }, origin: 'automated', verification: { method: 'agent' }, events: [], evidence: [] }, { kind: 'bill', text: CT_TEXT }).some((p) => /section A needs/.test(p)));

// ---------- 2. duplicates ----------
{
  const d = duplicateOf({ item: MA.item, raw: MA.raw, idx });
  ok('MA S3224: LegiScan links it to S3178, already in an entry: a duplicate', d && d.key === 'ma-h-5576-s-3178', JSON.stringify(d));
  const dup = (state, number, extra = {}) => duplicateOf({ item: { item_id: 'legiscan:99999999', source: 'legiscan' }, raw: { bill: { state, bill_number: number, sasts: [], history: [], ...extra }, text: extra.text || '' }, idx });
  ok('J entries block too: TX HB149 (Texas TRAIGA)', dup('TX', 'HB149') && dup('TX', 'HB149').key === 'texas-traiga-hb-149');
  ok('J entries block too: NJ S1802', dup('NJ', 'S1802') && dup('NJ', 'S1802').key === 'nj-s-1802');
  ok('J entries block too: CO SB189 (written "SB 26-189")', dup('CO', 'SB189') && dup('CO', 'SB189').key === 'colorado-sb-24-205-sb-26-189');
  ok('a number written in an entry\'s status text blocks (MA S.3228)', dup('MA', 'S3228') && dup('MA', 'S3228').key === 'ma-h-5576-s-3178');
  ok('a LegiScan companion of a tracked bill blocks (OH SCR14 vs a tracked HCR)', !!duplicateOf({ item: { item_id: 'legiscan:1', source: 'legiscan' }, raw: { bill: { state: 'NJ', bill_number: 'S9999', sasts: [{ type: 'Same As', sast_bill_number: 'A5275', sast_bill_id: 5 }] } }, idx }));
  ok('a bill whose text names a tracked bill blocks (IL HB2949 amends IL SB 315)', dup('IL', 'HB2949', { text: 'Section 40-15. If and only if Senate Bill 315 of the 104th General Assembly becomes law' }) && dup('IL', 'HB2949', { text: 'Section 40-15. If and only if Senate Bill 315 of the 104th General Assembly becomes law' }).key.startsWith('il-sb-315'));
  ok('an untracked bill is not a duplicate', dup('WY', 'HB1') === null);
  ok('a Congress bill identical to a tracked one blocks', !!duplicateOf({ item: { item_id: 'congress_gov:119/hr/1', source: 'congress_gov' }, raw: { related_bills: [{ congress: 119, type: 'S', number: 2938, relationshipDetails: [{ type: 'Identical bill' }] }] }, idx }));
  ok('a Congress bill whose related bills were not read is not created', !!relatedUnread({ source: 'congress_gov' }, { bill: { relatedBills: { count: 1 } } }) && relatedUnread({ source: 'congress_gov' }, { bill: { relatedBills: { count: 0 } } }) === null);
  ok('numbers: ranges and Colorado year numbers', numbersIn('MI SB 757–760').includes('SB758') && numbersIn('SB 26-189').includes('SB189'));
  ok('states: a J entry with no state is read from its name', statesOf({ level: 'none', state: null, short_name: 'Texas TRAIGA (HB 149)', title: '' }).join() === 'TX');
}
{
  // Tier B itself refuses the MA S3224 draft as a duplicate (it was published as a new B entry in the replay).
  const e = { key: 'ma-s-3224', id: 999, section: 'B', status: 'pending', events: [], evidence: [] };
  const data = { entries: clone(ENTRIES), news: { items: [] }, site: {}, changes: { items: [] } };
  const r = applyTierB({ data, drafts: [{ item_id: MA.item.item_id, outcome: 'publishable', operation: 'create', entry: e }], itemById: new Map([[MA.item.item_id, MA.item]]), readRaw: () => MA.raw, runId: 'r', runDate: '2026-10-28', config: { auto_publish: { new_entries: true }, max_new_entries_per_run: 3 } });
  ok('tier B: MA S3224 is skipped as a duplicate of the S3178 entry, not created', r.added.length === 0 && /S3178/.test(r.skipped[0].why) && /not created/.test(r.skipped[0].why), JSON.stringify(r.skipped));
}

// ---------- 5. events the AI adds are checked ----------
{
  const patch = { operation: 'create', in_scope: true, scope_reason: 'x', fields: { section: 'B.2', mechanism: 'Large frontier developers shall write a plan.' }, events_add: [{ date: '2027-01-01', precision: 'day', type: 'Effective', text: 'Act becomes operative' }], evidence: [], notes: '' };
  const asm = assembleEntry({ entry: null, patch, item: NE.item, raw: NE.raw, today: '2026-10-28', runId: 'r', rounds: 1, entries: ENTRIES });
  const ev = asm.entry.events;
  ok('NE LB1083 (dead): the AI\'s future "Effective" event is dropped', asm.entry.status === 'failed' && !ev.some((x) => x.type === 'Effective'), JSON.stringify(ev.map((x) => x.date + ' ' + x.type)));
  ok('NE LB1083: "Indefinitely postponed" is one event, not two of different types', ev.filter((x) => x.text === 'Indefinitely postponed').length === 1 && ev.find((x) => x.text === 'Indefinitely postponed').type === 'Vetoed / failed / rescinded');
  const bad = clone(asm.entry); bad.events.push({ date: '2027-01-01', precision: 'day', type: 'Effective', text: 'Act becomes operative', inferred_year: false, scheduled: true }, { ...bad.events[0], type: 'Referred / stalled / hearing' });
  const probs = checkNewEntry(bad);
  ok('the publish guard refuses an "Effective" or scheduled event on a dead bill, and a doubled event', probs.some((p) => /"Effective" event/.test(p)) && probs.some((p) => /scheduled event/.test(p)) && probs.some((p) => /listed twice/.test(p)), JSON.stringify(probs));
  ok('dedupeEvents keeps the most decisive type', dedupeEvents([{ date: 'd', type: 'Referred / stalled / hearing', text: 'X.' }, { date: 'd', type: 'Vetoed / failed / rescinded', text: 'x' }]).map((x) => x.type).join() === 'Vetoed / failed / rescinded');
}

// ---------- 6. scope: the referee always confirms a new entry, with a quote code finds ----------
ok('SCOPE_CLAIM: the classification is the reader\'s own judgement from the provisions', /never a reason to mark this claim unsupported/.test(SCOPE_CLAIM) && /from what the provisions of SOURCE do/.test(SCOPE_CLAIM));
{
  const TEXT = 'SEC. 4. EXPORT CONTROLS. The Secretary shall require a license for the export of advanced AI chips classified under ECCN 3A090 to any country. SEC. 5. A frontier developer shall report incidents.';
  const raw = { bill: { title: 'Test Act', type: 'HR', number: '77777', introducedDate: '2026-06-24', sponsors: [{ fullName: 'Rep. Doe, Jane [D-NY-14]' }], latestAction: { actionDate: '2026-06-24', text: 'Referred to the Committee on Energy and Commerce.' } }, actions: [], text: TEXT };
  const item = { item_id: 'congress_gov:119/hr/77777', source: 'congress_gov', source_id: '119/hr/77777', source_url: 'https://www.congress.gov/bill/119th-congress/house-bill/77777', fetched_at: '2026-10-28T00:00:00Z' };
  const diff = { item_id: item.item_id, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'x' }] };
  const Q = 'The Secretary shall require a license for the export of advanced AI chips';
  const patch = () => ({ operation: 'create', in_scope: true, scope_reason: 'Export controls on AI chips.', fields: { mechanism: 'The Secretary shall require a license for the export of advanced AI chips classified under ECCN 3A090.' }, events_add: [], evidence: [{ field: 'mechanism', quote: Q }], notes: '' });
  const gen = (n = 3) => ({ calls: [], async generate(req) { this.calls.push(req); return { usage: {}, data: patch() }; } });
  const val = { calls: [], async generate(req) { this.calls.push(req); const ns = [...req.prompt.matchAll(/^(\d+)\. \[/gm)].map((m) => +m[1]); return { usage: {}, data: { results: ns.map((n) => ({ n, supported: true, quote: Q, reason: null })) } }; } };
  const ref = (supported, quote) => ({ calls: [], async generate(req) { this.calls.push(req); return { usage: {}, data: { results: [{ n: 1, supported, quote, reason: supported ? null : 'SOURCE does not state a scope classification.' }] } }; } });
  const go = (referee) => processItem({ generator: gen(), validator: val, referee, item, raw, diff, entries: ENTRIES, today: '2026-10-28', runId: 'r', now: new Date('2026-10-28T00:00:00Z') });
  const r1 = await go(ref(true, Q));
  ok('both readers and the referee say in scope, with a quote in the source: publishable, and the scope quote is kept as evidence', r1.outcome === 'publishable' && r1.entry.evidence.some((e) => e.field === 'in_scope' && e.quote === Q), `${r1.outcome} ${r1.reason}`);
  const r2 = await go(ref(false, null));
  ok('generator and reader say in scope but the referee says out: held and reported, not published', r2.outcome === 'held' && r2.escalate === true && /referee rules it out/.test(r2.reason), `${r2.outcome} ${r2.reason}`);
  const r3 = await go(ref(true, 'a quote that is nowhere in the bill'));
  ok('the referee says in scope with a quote code cannot find: held', r3.outcome === 'held' && /did not confirm/.test(r3.reason), `${r3.outcome} ${r3.reason}`);
  const r4 = await go(null);
  ok('no referee configured: a new entry is never published on one model\'s word', r4.outcome === 'held' && /no referee/.test(r4.reason));
  // Gated new entries OFF: the draft can never publish, so no referee call is made; it is reported as an unconfirmed proposal.
  const rf = ref(true, Q);
  const r5 = await processItem({ generator: gen(), validator: val, referee: rf, item, raw, diff, entries: ENTRIES, today: '2026-10-28', runId: 'r', now: new Date('2026-10-28T00:00:00Z'), newEntriesOn: false });
  ok('new entries switched off: no referee call, held (never publishable), reported as not confirmed', rf.calls.length === 0 && r5.outcome === 'held' && r5.escalate === true && r5.unconfirmed === true && /not confirmed: new entries are switched off/.test(r5.reason) && /not confirmed: new entries are switched off/.test(r5.proposal) && !(r5.entry && r5.entry.evidence || []).some((e) => e.field === 'in_scope'), JSON.stringify({ calls: rf.calls.length, o: r5.outcome, reason: r5.reason, p: r5.proposal }));
}

// ---------- 7. big bills: one escalated pass, within its own budget ----------
{
  const ledger = createLedger({ limits: { max_tokens_per_item: 1000 } });
  const b = escalationBudget({ ledger, perItem: 1000, total: 2500 });
  const llm = { role: 'g', model: 'm', async generate(req) { ledger.assertWithin(req.itemId); ledger.record({ role: 'g', model: 'm', itemId: req.itemId, usage: { promptTokenCount: 800, candidatesTokenCount: 0 } }); return { usage: {}, data: req.itemId }; } };
  const w = b.wrap(llm), keys = [];
  let err = null;
  try { for (let i = 0; i < 6; i++) keys.push((await w.generate({ itemId: 'x' })).data); } catch (e) { err = e; }
  ok('the escalated pass spends under the item\'s own sub-keys, each under the per-item cap', keys[0] === 'x#esc1' && keys[1] === 'x#esc2' && keys.every((k) => /^x#esc\d$/.test(k)), keys.join());
  ok('and stops at its own total as an item budget (never a run stop)', err instanceof BudgetExceeded && err.scope === 'item' && b.spent('x') >= 2400, String(err));
}
{
  // PA HB2829 / NC S735: held for the 60k item budget with nothing written. The held item is retried at once by the escalated pass.
  const TEXT = 'SEC. 4. Artificial intelligence models. SEC. 5. A frontier developer shall report incidents within 72 hours to the Attorney General.'; // round 4: a frontier term counts only about AI
  const raw = { bill: { title: 'Test Act', type: 'S', number: '88888', introducedDate: '2026-06-24', sponsors: [{ fullName: 'Sen. Doe, Jane [D-NY]' }], latestAction: { actionDate: '2026-06-24', text: 'Read twice and referred to the Committee on Commerce.' } }, actions: [], text: TEXT };
  const item = { item_id: 'congress_gov:119/s/88888', source: 'congress_gov', source_id: '119/s/88888', source_url: 'https://www.congress.gov/bill/119th-congress/senate-bill/88888', fetched_at: '2026-10-28T00:00:00Z' };
  const diff = { item_id: item.item_id, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'x' }] };
  const Q = 'A frontier developer shall report incidents within 72 hours to the Attorney General.';
  const okPatch = { operation: 'create', in_scope: true, scope_reason: 'Duties on frontier developers.', section: 'F', fields: { mechanism: 'A frontier developer shall report incidents within 72 hours to the Attorney General.' }, events_add: [], evidence: [{ field: 'mechanism', quote: Q }], notes: '' };
  const broke = { async generate() { throw new BudgetExceeded('60000 tokens for item ' + item.item_id, 'item'); } };
  const strong = { calls: 0, async generate() { this.calls++; return { usage: {}, data: clone(okPatch) }; } };
  const val = { async generate(req) { const ns = [...req.prompt.matchAll(/^(\d+)\. \[/gm)].map((m) => +m[1]); return { usage: {}, data: { results: ns.map((n) => ({ n, supported: true, quote: Q, reason: null })) } }; } };
  const budget = { spent: () => 0, wrap: (l) => l };
  const r = await processItem({ generator: broke, validator: val, referee: val, escalation: { generator: strong, validator: val, budget }, item, raw, diff, entries: ENTRIES, today: '2026-10-28', runId: 'r', now: new Date('2026-10-28T00:00:00Z') });
  ok('a bill held for its token budget is written by the escalated pass', r.outcome === 'publishable' && r.escalated === true && strong.calls >= 1, `${r.outcome} ${r.reason}`);
  const r2 = await processItem({ generator: broke, validator: val, referee: val, escalation: { generator: broke, validator: val, budget }, item, raw, diff, entries: ENTRIES, today: '2026-10-28', runId: 'r' });
  ok('still held after the escalated pass: escalate is set, and it is not retried again in a loop', r2.outcome === 'held' && r2.escalated === true && r2.escalate === true, JSON.stringify(r2));
  const strong2 = { calls: 0, async generate() { this.calls++; return { usage: {}, data: clone(okPatch) }; } };
  const r3 = await processItem({ generator: broke, validator: val, referee: val, escalation: { generator: strong2, validator: val, budget }, item, raw, diff, entries: ENTRIES, today: '2026-10-28', runId: 'r', newEntriesOn: false });
  ok('new entries switched off: the escalated pass is never run', strong2.calls === 0 && r3.outcome === 'held' && !r3.escalated, JSON.stringify(r3));
}

console.log(`audit regressions: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
