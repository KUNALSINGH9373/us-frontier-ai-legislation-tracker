// Slot-based writing of a new entry (agents/slots.mjs; owner, 30 Oct 2026). Code only, no AI.
//   node agents/test-slots.mjs
import { renderSlots, coverageProblems, slotQuoteProblems, FIELD_LIMITS, THRESHOLD_KINDS, SLOTS_INSTRUCTIONS } from './slots.mjs';
import { factNumbers } from '../eval/run.mjs';
import { generatePatch } from './generator.mjs';
import { generatorPrompt } from './prompts.mjs';
import { runChecks } from './checks.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };

// IL H.B. 4705's tiers, as the 29 Oct field eval needed them
const IL = {
  mechanism: [
    { kind: 'duty', text: 'Large frontier developers must write, implement and publish a public safety and child protection plan', quote: 'shall write, implement, comply with, and clearly and conspicuously publish' },
    { kind: 'whistleblower', text: 'frontier developers may not prevent employees from making protected disclosures.', quote: 'shall not make, adopt, enforce, or enter into a rule' },
    { kind: 'incident_reporting', text: 'Frontier developers must report critical safety incidents to the Attorney General within 15 days', quote: 'within 15 days after discovering' }
  ],
  thresholds: [
    { kind: 'revenue', applies_to: 'Large frontier developer', text: 'annual revenue of at least $500,000,000 with affiliates', quote: 'annual revenue of at least $500,000,000' },
    { kind: 'compute', applies_to: 'Frontier model', text: 'trained with more than 10^26 operations', quote: 'more than 10^26 integer or floating-point operations' },
    { kind: 'derived_models', applies_to: 'Frontier model', text: 'including later fine-tuning or reinforcement learning', quote: 'fine-tuning, reinforcement learning' },
    { kind: 'revenue', applies_to: 'Large chatbot provider', text: 'annual revenue of at least $25,000,000', quote: 'annual revenue of at least $25,000,000' },
    { kind: 'users', applies_to: 'Covered chatbot', text: 'at least 1,000,000 monthly active users', quote: 'at least 1,000,000 monthly active users' }
  ],
  penalties: [
    { kind: 'civil', applies_to: 'Large chatbot provider', text: 'up to $50,000 per violation', quote: '$50,000 per violation', enforced_by: 'the Attorney General', enforced_by_quote: 'recovered in a civil action brought by the Attorney General' },
    { kind: 'civil', applies_to: 'Large frontier developer', text: 'civil penalty up to $1,000,000 per violation', quote: 'does not exceed $1,000,000 per violation', enforced_by: 'the Attorney General', enforced_by_quote: 'recovered in a civil action brought by the Attorney General' }
  ]
};

// ---------- 1. rendering ----------
{
  const r = renderSlots(IL);
  ok('1 duties first in SOURCE order, then features in a fixed order, one sentence each', r.fields.mechanism === 'Large frontier developers must write, implement and publish a public safety and child protection plan. Frontier developers may not prevent employees from making protected disclosures. Frontier developers must report critical safety incidents to the Attorney General within 15 days.', r.fields.mechanism);
  ok('1 thresholds: compute, then fine-tuning, revenue, users; grouped by the term each sets', r.fields.thresholds === 'Frontier model: trained with more than 10^26 operations; including later fine-tuning or reinforcement learning. Large frontier developer: annual revenue of at least $500,000,000 with affiliates. Large chatbot provider: annual revenue of at least $25,000,000. Covered chatbot: at least 1,000,000 monthly active users.', r.fields.thresholds);
  ok('1 every penalty tier, then the enforcer', r.fields.penalties === 'Large chatbot provider: up to $50,000 per violation; Large frontier developer: civil penalty up to $1,000,000 per violation; enforced by the Attorney General.', r.fields.penalties);
  ok('1 one evidence quote per slot, on its field, plus each tier enforcer quote', r.evidence.length === 12 && r.evidence.filter((e) => e.field === 'thresholds').length === 5 && r.evidence.filter((e) => e.field === 'penalties').length === 4);
  const split = renderSlots({ mechanism: [], thresholds: [], penalties: [{ kind: 'civil', applies_to: 'First violation', text: 'up to $1,000,000', quote: 'q', enforced_by: 'the Attorney General', enforced_by_quote: 'q2' }, { kind: 'per_day', applies_to: null, text: '$1,000 per day', quote: 'q', enforced_by: 'the Agency after notice and hearing', enforced_by_quote: 'q3' }] });
  ok('1 tiers with different enforcers each say their own (NY RAISE, PA HB 2800)', split.fields.penalties === 'First violation: up to $1,000,000, enforced by the Attorney General; $1,000 per day, enforced by the Agency after notice and hearing.', split.fields.penalties);
  ok('1 an enforcer without its quote is a problem', renderSlots({ mechanism: [], thresholds: [], penalties: [{ kind: 'civil', text: 'a', quote: 'q', enforced_by: 'the AG' }] }).problems.some((p) => /enforced_by_quote/.test(p)));
  ok('1 a text that repeats its term drops it ("Developer: Developer:")', renderSlots({ mechanism: [], thresholds: [{ kind: 'compute_cost', applies_to: 'Developer', text: 'Developer: trained with $100,000,000 of compute', quote: 'q' }], penalties: [] }).fields.thresholds === 'Developer: trained with $100,000,000 of compute.');
  ok('1 no problems', r.problems.length === 0, JSON.stringify(r.problems));
  const cap = renderSlots({ mechanism: [{ kind: 'program', text: 'Creates a program', quote: 'q' }], thresholds: [{ kind: 'capability', applies_to: null, text: 'covered AI technologies whose theft would pose a grave national security threat', quote: 'q' }], penalties: [], enforcer: null });
  ok('1 a figureless definition reads "Capability-based, no figure:"', cap.fields.thresholds === 'Capability-based, no figure: covered AI technologies whose theft would pose a grave national security threat.', cap.fields.thresholds);
  ok('1 no penalty slots: no penalties field (never "none")', !('penalties' in cap.fields));
  ok('1 an unknown kind is kept (as other), never dropped', renderSlots({ mechanism: [{ kind: 'mystery', text: 'Does a thing', quote: 'q' }], thresholds: [], penalties: [] }).fields.mechanism === 'Does a thing.');
}

// ---------- 2. problems sent back to the Generator ----------
{
  ok('2 no slots object: a problem', renderSlots(null).problems.length === 1);
  ok('2 a slot without a quote: a problem naming it', renderSlots({ mechanism: [{ kind: 'duty', text: 'Developers must test', quote: '' }], thresholds: [], penalties: [] }).problems.some((p) => /mechanism slot 1 .*no quote/.test(p)));
  const long = renderSlots({ mechanism: Array.from({ length: 14 }, (_, i) => ({ kind: 'duty', text: `Duty number ${i} requires the developer to do a long list of things in great detail and at length, every year`, quote: 'q' })), thresholds: [], penalties: [] });
  ok('2 too long from slots: "shorten, do not drop"', long.fields.mechanism.length > FIELD_LIMITS.mechanism && long.problems.some((p) => /shorten the "text" of its slots/.test(p) && /do not drop/.test(p)));
  ok('2 a slot quote not in SOURCE is named', slotQuoteProblems({ mechanism: [{ kind: 'duty', text: 'x', quote: 'words not there' }], thresholds: [], penalties: [] }, 'The developer shall test.').length === 1);
}

// ---------- 3. coverage ----------
{
  const SRC = '"Frontier model" means a model trained using greater than 10^26 integer or floating-point operations. "Large frontier developer" means a frontier developer that together with its affiliates had annual gross revenues in excess of $500,000,000. A covered chatbot has at least 1,000,000 monthly active users. A developer that violates this act shall be subject to a civil penalty of not more than $1,000,000 per violation.';
  const empty = { mechanism: [], thresholds: [], penalties: [] };
  const p = coverageProblems(empty, SRC);
  ok('3 compute, revenue, users and a penalty in SOURCE with no slot: four problems with excerpts', p.length === 4 && p.some((x) => /kind compute/.test(x)) && p.some((x) => /kind revenue/.test(x)) && p.some((x) => /kind users/.test(x)) && p.some((x) => /penalty/.test(x) && /\$1,000,000/.test(x)), JSON.stringify(p));
  const full = { mechanism: [], thresholds: [{ kind: 'compute', text: 'more than 10^26 operations', quote: 'y' }, { kind: 'revenue', text: 'revenue over $500,000,000', quote: 'y' }, { kind: 'users', text: '1,000,000 users', quote: 'y' }], penalties: [{ kind: 'civil', text: 'up to $1,000,000 per violation', quote: 'y' }] };
  ok('3 every kind and every amount given: no problem', coverageProblems(full, SRC).length === 0, JSON.stringify(coverageProblems(full, SRC)));
  const tiers = `${SRC} A developer that commits a subsequent violation shall be subject to a civil penalty of not more than $3,000,000 per violation.`;
  ok('3 a second penalty tier left out is caught (one slot of a kind is not enough)', coverageProblems(full, tiers).some((x) => /\$3,000,000/.test(x)));
  ok('3 a revenue figure that names no one covered (findings) is not demanded', coverageProblems(empty, 'The state collected revenues of $5,000,000 from fees last year.').length === 0);
  ok('3 "criminal penalties ... shall not be assessed" is not a penalty (IL HB 3506)', coverageProblems(empty, 'the provisions of the Whistleblower Act shall apply to this Act, except that the criminal penalties provided in the Whistleblower Act shall not be assessed.').length === 0);
  ok('3 per-day fines count (S. 2938)', coverageProblems(empty, 'A person that violates subsection (a) shall be fined not less than $1,000,000 per day of the violation.').length === 1);
  ok('3 "1,025 operations" alone is no compute figure', coverageProblems(empty, 'The agency logged 1,025 operations last year.').length === 0);
}

// ---------- 4. the Generator: fields come from the slots, whatever the model wrote ----------
{
  const answer = { operation: 'create', in_scope: true, scope_reason: 'Duties on frontier developers.', section: 'B', fields: { mechanism: 'MODEL PROSE THAT MUST BE IGNORED', thresholds: 'ALSO IGNORED' }, events_add: [], evidence: [{ field: 'mechanism', quote: 'ignored quote' }], notes: '', slots: IL };
  const llm = { calls: [], async generate(req) { this.calls.push(req); return { data: JSON.parse(JSON.stringify(answer)), usage: {} }; } };
  const item = { item_id: 'legiscan:IL-HB4705', source: 'legiscan', source_url: 'https://legiscan.com/x' };
  const g = await generatePatch({ llm, item, source: 'S', entry: null, reasons: [], operation: 'create', styleExamples: [], feedback: [], previousPatch: null, sections: ['B'] });
  ok('4 the patch is valid and its fields are the rendered slots', g.patch && g.patch.fields.mechanism === renderSlots(IL).fields.mechanism && g.patch.fields.thresholds === renderSlots(IL).fields.thresholds, JSON.stringify(g.problems));
  ok('4 the model\'s own evidence for those fields is replaced by the slot quotes', g.patch.evidence.length === 12 && !g.patch.evidence.some((e) => e.quote === 'ignored quote'));
  ok('4 the slots ride along, outside the patch JSON', g.patch.slots && !('slots' in JSON.parse(JSON.stringify(g.patch))));
  ok('4 the prompt asks for slots, not field prose', /In "slots"/.test(llm.calls[0].prompt) && !/In "fields" give ONLY/.test(llm.calls[0].prompt));
  const again = generatorPrompt({ operation: 'create', item, source: 'S', reasons: [], feedback: ['fix it'], previousPatch: g.patch, sections: ['B'] });
  ok('4 a retry shows the model its previous slots (not the rendered prose)', /"slots":\{"mechanism"/.test(again) && !/"thresholds":"Frontier model:/.test(again));
  const upd = { calls: [], async generate() { return { data: { operation: 'update', in_scope: true, scope_reason: 'Tracked; a committee action.', fields: { status_text: 'Referred Mar 3, 2026' }, events_add: [], evidence: [{ field: 'status_text', quote: 'Referred' }], notes: '' }, usage: {} }; } };
  const u = await generatePatch({ llm: upd, item, source: 'S', entry: { title: 't', sponsor_text: 's', mechanism: 'm', last_checked: '2026-10-01' }, reasons: [], operation: 'update', styleExamples: [], feedback: [], previousPatch: null });
  ok('4 an update is unchanged: no slots', u.patch && u.patch.fields.status_text === 'Referred Mar 3, 2026' && u.patch.slots === undefined);
}

// ---------- 5. the checks refuse an incomplete or unquoted slot set ----------
{
  const SRC = '"Frontier model" means a model trained using greater than 10^26 integer or floating-point operations. A large developer shall publish a safety and security protocol.';
  const patch = { operation: 'create', in_scope: true, scope_reason: 'Duties on frontier developers.', fields: { mechanism: 'A large developer must publish a safety and security protocol.' }, events_add: [], evidence: [{ field: 'mechanism', quote: 'A large developer shall publish a safety and security protocol' }] };
  Object.defineProperty(patch, 'slots', { value: { mechanism: [{ kind: 'duty', text: 'A large developer must publish a safety and security protocol', quote: 'A large developer shall publish a safety and security protocol' }], thresholds: [], penalties: [] }, enumerable: false });
  Object.defineProperty(patch, 'slotProblems', { value: [], enumerable: false });
  const after = { key: 'k' };
  const c = runChecks({ patch, before: null, after, assembleProblems: [], source: 'legiscan', sourceText: SRC, entries: [], operation: 'update' }).find((x) => x.name === 'slots_complete');
  ok('5 a compute figure with no compute slot fails slots_complete, and says which', c && !c.passed && /kind compute/.test(c.detail), JSON.stringify(c));
}

// ---------- 6. owner decisions of 30 Oct 2026 ----------
{
  ok('6 no harm kind in thresholds, and the prompt says to leave harm definitions out', !THRESHOLD_KINDS.includes('harm') && /Never put the definition of the harm/.test(SLOTS_INSTRUCTIONS));
  ok('6 thresholds may run to 1,300 characters', FIELD_LIMITS.thresholds === 1300);
  ok('6 the eval reads the author shorthand "$25M" and "1M" as the full figures', factNumbers('≥$25M revenue; ≥1M users').has('25000000') && factNumbers('≥$25M revenue; ≥1M users').has('1000000'));
}

// ---------- 7. independent review and fact-check, 30 Oct 2026 ----------
{
  const r = (thresholds, penalties = []) => renderSlots({ mechanism: [], thresholds, penalties });
  ok('7 an unknown threshold kind is sent back, never published as "Capability-based, no figure"', r([{ kind: 'flops', text: 'more than 10^26 operations', quote: 'q' }]).problems.some((p) => /not one of/.test(p)));
  ok('7 a figure in a capability slot is sent back (chip specs were labelled "no figure")', r([{ kind: 'capability', text: 'chips with total processing performance of 4,800 or more', quote: 'q' }]).problems.some((p) => /gives a figure/.test(p)));
  ok('7 a bill covering every developer reads "No threshold", not "Capability-based" (MN HF 4532)', r([{ kind: 'no_threshold', applies_to: null, text: 'a person that has trained at least one artificial intelligence model', quote: 'q' }]).fields.thresholds === 'No threshold: covers a person that has trained at least one artificial intelligence model.');
  const either = r([{ kind: 'compute', applies_to: 'Frontier model', text: 'trained using greater than 10^26 computational operations', quote: 'q', combine: 'or' }, { kind: 'compute_cost', applies_to: 'Frontier model', text: 'compute cost that exceeds $100,000,000', quote: 'q' }]);
  ok('7 either test is enough: said with "or" (IL SB 3444)', either.fields.thresholds === 'Frontier model: trained using greater than 10^26 computational operations; or compute cost that exceeds $100,000,000.' && !either.problems.length, either.fields.thresholds);
  ok('7 both tests needed: said with "and" (IL HB 3506)', r([{ kind: 'compute_cost', applies_to: 'Large developer', text: '$5,000,000 for one model', quote: 'q', combine: 'and' }, { kind: 'compute_cost', applies_to: 'Large developer', text: '$100,000,000 in 12 months', quote: 'q' }]).fields.thresholds === 'Large developer: $5,000,000 for one model; and $100,000,000 in 12 months.');
  ok('7 several tests for one term without "combine" are sent back', r([{ kind: 'compute', applies_to: 'X', text: 'a', quote: 'q' }, { kind: 'revenue', applies_to: 'X', text: 'b', quote: 'q' }]).problems.some((p) => /without "combine"/.test(p)));
  ok('7 a fine-tuning qualifier needs no "combine" and follows its compute test', r([{ kind: 'compute', applies_to: 'Frontier model', text: 'more than 10^26 operations', quote: 'q' }, { kind: 'derived_models', applies_to: 'Frontier model', text: 'including fine-tuning', quote: 'q' }]).fields.thresholds === 'Frontier model: more than 10^26 operations; including fine-tuning.');
  ok('7 "Developers with ..." under "Developer" keeps its words', r([{ kind: 'revenue', applies_to: 'Developer', text: 'Developers with revenue over $1,000,000', quote: 'q' }]).fields.thresholds === 'Developer: Developers with revenue over $1,000,000.');
  ok('7 the prompt asks for every alternative of a capability definition and for the whole enforcement section', /name EVERY alternative/.test(SLOTS_INSTRUCTIONS) && /read the WHOLE enforcement section/.test(SLOTS_INSTRUCTIONS));
  ok('7 the eval keeps "covered persons" clauses (harm filter narrowed)', factNumbers('x').size === 0 && /500000000/.test([...factNumbers(String((await import('../eval/run.mjs')).withoutHarm('Covered persons: revenue >$500M; catastrophic risk = 50 deaths')))].join()));
}

{
  ok('8 two tests in one slot are sent back (IL SB 3444, MI HB 4668)', renderSlots({ mechanism: [], thresholds: [{ kind: 'compute', applies_to: 'Frontier model', text: 'trained using greater than 10^26 operations; compute cost that exceeds $100,000,000', quote: 'q' }], penalties: [] }).problems.some((p) => /more than one test/.test(p)));
  ok('8 the prompt says one test per item', /never put two tests in one "text"/.test(SLOTS_INSTRUCTIONS));
  const { codeChecks } = await import('../eval/run.mjs');
  const p = { fields: {}, evidence: [], in_scope: true };
  Object.defineProperty(p, 'slots', { value: { mechanism: [], thresholds: [], penalties: [] }, enumerable: false });
  Object.defineProperty(p, 'slotProblems', { value: ['thresholds for "X" give several tests without "combine"'], enumerable: false });
  ok('8 the eval runs the slot checks production runs (they were missing from its own code checks)', codeChecks(p, 'A developer shall be subject to a civil penalty of not more than $1,000,000 per violation.').some((x) => /without "combine"/.test(x)) && codeChecks(p, 'A developer shall be subject to a civil penalty of not more than $1,000,000 per violation.').some((x) => /penalties slots are empty/.test(x)));
}

console.log(`slots: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
