// Tests for the test-set scoring and the gate. No network, no model.
//   node eval/test.mjs
import { scoreItem, summarise, factNumbers, codeChecks } from './run.mjs';
import { gate } from './gate.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const TEXT = 'Sec. 2. A frontier model is trained using greater than 10^26 integer or floating-point operations. A large developer has annual revenue over $500,000,000. Reports are due within 72 hours. Penalty: up to $1,000,000 per violation. Effective 2027.';
const gold = { key: 'x', in_scope: true, mechanism: 'Requires reports within 72 hours; effective 2027', thresholds: '10²⁶ ops; >$500M revenue ($500,000,000)', penalties: 'Up to $1,000,000 per violation; $3,000,000 for repeats' };

ok('exponents read the same however printed; years and single digits are not facts', [...factNumbers('10²⁶ ops in 2027, 3 times')].join() === '10,26');
{
  const s = scoreItem({ gold, text: TEXT, result: { outcome: 'published', in_scope: true, fields: { mechanism: 'Developers report incidents within 72 hours.', thresholds: 'Trained on more than 10^26 operations; revenue over $500,000,000', penalties: 'Up to $1,000,000 per violation' } } });
  ok('thresholds pass when every provable number is stated', s.fields.thresholds.pass && s.fields.thresholds.recall === 1, JSON.stringify(s.fields.thresholds));
  ok('a number the author took from elsewhere ($3,000,000) is not held against the model', s.fields.penalties.pass && !s.fields.penalties.provable.includes('3000000'));
  ok('mechanism passes on support; its number recall is reported', s.fields.mechanism.pass && s.fields.mechanism.recall === 1);
}
{
  const s = scoreItem({ gold, text: TEXT, result: { outcome: 'published', in_scope: true, fields: { mechanism: 'Reports.', thresholds: 'Revenue over $500,000,000', penalties: null } } });
  ok('thresholds missing the compute figure fail', !s.fields.thresholds.pass && s.fields.thresholds.found.join() === '500000000' && s.fields.thresholds.provable.join() === '10,26,500000000');
  ok('penalties left out when the text states one fail', !s.fields.penalties.pass);
}
{
  const s = scoreItem({ gold, text: TEXT, result: { outcome: 'published', in_scope: true, fields: { mechanism: 'Due within 48 hours.', thresholds: '10^26 operations; $500,000,000', penalties: '$1,000,000' } } });
  ok('a number not in the official text is unsupported and fails the field', !s.fields.mechanism.pass && s.fields.mechanism.unsupported.includes('48'));
}
{
  const held = scoreItem({ gold, text: TEXT, result: { outcome: 'held', fields: {} } });
  ok('a held item publishes nothing, so no field passes', Object.values(held.fields).every((f) => !f.pass && !f.got));
  ok('scope: dropping an in-scope bill is wrong', !scoreItem({ gold, text: TEXT, result: { outcome: 'out_of_scope', fields: {} } }).scope_ok);
  const ex = { ...gold, in_scope: false };
  ok('scope: an excluded bill held or dropped is right; published is wrong', scoreItem({ gold: ex, text: TEXT, result: { outcome: 'held', fields: {} } }).scope_ok && scoreItem({ gold: ex, text: TEXT, result: { outcome: 'out_of_scope', fields: {} } }).scope_ok && !scoreItem({ gold: ex, text: TEXT, result: { outcome: 'published', fields: {} } }).scope_ok);
}
{
  const p = codeChecks({ fields: { thresholds: 'more than 10^27 operations' }, evidence: [{ field: 'thresholds', quote: 'greater than 10^27 integer' }] }, TEXT);
  ok('code checks catch an invented quote and an invented number', p.some((x) => /not in the source/.test(x) && /quote/.test(x)) && p.some((x) => /number 27/.test(x)));
  ok('code checks catch stray foreign-script text (a published Bengali tail, 16 Oct)', codeChecks({ fields: { thresholds: 'more than 10^26 operations খেলতে হবে' }, evidence: [{ field: 'thresholds', quote: 'greater than 10^26 integer or floating-point operations' }] }, TEXT).some((x) => /letters that do not occur/.test(x)));
  ok('code checks pass a faithful field', codeChecks({ fields: { thresholds: 'more than 10^26 operations' }, evidence: [{ field: 'thresholds', quote: 'greater than 10^26 integer or floating-point operations' }] }, TEXT).length === 0);
}
{
  const rows = [scoreItem({ gold, text: TEXT, result: { outcome: 'published', in_scope: true, fields: { mechanism: 'Within 72 hours.', thresholds: '10^26; $500,000,000', penalties: '$1,000,000' } } }), scoreItem({ gold, text: TEXT, result: { outcome: 'held', fields: {} } })].map((s) => ({ ...s, gold_in_scope: true }));
  const sum = summarise(rows);
  ok('summary: pass rate over in-scope items', sum.fields.thresholds.pass_rate === 0.5 && sum.fields.thresholds.items === 2);
  const config = { auto_publish: { mechanism: true, thresholds: false, penalties: false, new_entries: false }, eval_bar: { pass_rate: 1, unsupported_fields: 0, scope_agreement: 1 } };
  const models = { provider: 'gemini', roles: { generator: { model: 'm' } } };
  const g = gate({ config, models, reports: [{ generator: 'm', run_at: '2026-10-16', summary: sum }], goldItems: 2 });
  ok('gate: a switch on below the bar is a violation', g.violations.includes('mechanism') && !g.fields.thresholds.meets);
  const g2 = gate({ config, models, reports: [{ generator: 'm', run_at: '2026-10-16', summary: { ...sum, items: 1 } }], goldItems: 2 });
  ok('gate: a partial run does not count', g2.report === null);
  const g3 = gate({ config, models: { provider: 'anthropic', anthropic: { roles: { generator: { model: 'claude' } } } }, reports: [{ generator: 'm', run_at: '2026-10-16', summary: sum }], goldItems: 2 });
  ok('gate: a report for another model does not count', g3.report === null);
}

console.log(`eval: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
