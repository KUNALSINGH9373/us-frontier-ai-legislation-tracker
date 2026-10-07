// Run:  node compare/test-federal-register.mjs   (or npm run test:compare-fr)
import { compareFederalRegister } from './federal-register.mjs';
import { makeValidator } from '../schema/validate.mjs';

const v = makeValidator();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };

const eo = { key: 'eo-14365-state-law-framework', title: 'EO 14365: Ensuring a National Policy Framework for Artificial Intelligence', short_name: 'EO 14365 (state-law framework)', last_checked: '2026-09-05', status_text: 'Signed Dec. 11, 2025; directs agencies to challenge state AI laws', events: [{ date: '2025-12-11' }] };
const item = (n) => ({ item_id: 'federal_register:' + n });
const raw = (d, text = '') => ({ document: { document_number: 'x', title: 'T', type: 'Notice', publication_date: '2026-10-02', ...d }, text });
const run = (d, entry, text) => compareFederalRegister({ item: item(d.document_number || 'x'), raw: raw(d, text), entry });

{
  const r = run({ type: 'Presidential Document', title: 'Ensuring a National Policy Framework for Artificial Intelligence', executive_order_number: '14365', signing_date: '2025-12-11', publication_date: '2025-12-16' }, eo);
  ok('the tracked order itself is unchanged: it is already in the tracker', r.verdict === 'unchanged' && r.reasons.length === 0, JSON.stringify(r));
}
{
  // Orders are published in the Federal Register several days after they are signed. The tracker records the signing date.
  const e3 = { ...eo, key: 'eo-14500-new-order', title: 'EO 14500: A New Order', short_name: 'EO 14500', status_text: 'Signed Sept 18, 2026', events: [{ date: '2026-09-18' }] };
  const r = run({ type: 'Presidential Document', title: 'A New Order', executive_order_number: '14500', signing_date: '2026-09-18', publication_date: '2026-09-23' }, e3);
  ok('a tracked order published days after the signing date the tracker records is unchanged', r.verdict === 'unchanged', JSON.stringify(r));
}
{
  const r = run({ type: 'Presidential Document', title: 'Revocation of Executive Order 14365', publication_date: '2026-10-02' }, eo, 'Executive Order 14365 is hereby revoked.');
  ok('a later document that revokes a tracked order is material', r.verdict === 'material' && r.reasons.some((x) => x.kind === 'new_action'));
  ok('and it is flagged as a possible status change', r.reasons.some((x) => x.kind === 'status_change'), JSON.stringify(r.reasons));
}
{
  const r = run({ type: 'Rule', title: 'Implementation of Executive Order 14365: reporting requirements', publication_date: '2026-09-20' }, eo, 'This rule implements the order.');
  ok('a follow-up rule naming the order is material but not a status change', r.verdict === 'material' && !r.reasons.some((x) => x.kind === 'status_change'), JSON.stringify(r.reasons));
}
{
  const e2 = { ...eo, status_text: 'Signed Dec. 11, 2025; implementing rule published Sept 20, 2026' };
  const r = run({ type: 'Rule', title: 'Implementation of Executive Order 14365', publication_date: '2026-09-20' }, e2);
  ok('a document the tracker text already describes is not reported again', r.verdict === 'unchanged', JSON.stringify(r));
}
{
  const r = run({ type: 'Notice', title: 'Old notice about Executive Order 14365', publication_date: '2026-08-01' }, eo);
  ok('a document from before the tracker last checked is unchanged', r.verdict === 'unchanged');
}
{
  const r = run({ document_number: '2026-20321', type: 'Presidential Document', title: 'Inaugurating the Era of Super Intelligence', executive_order_number: '14434', signing_date: '2026-09-29', publication_date: '2026-10-02' }, null);
  ok('a document with no matching entry is a new-entry candidate that names the order number', r.verdict === 'new_entry_candidate' && r.entry_key === null && /EO 14434/.test(r.reasons[0].detail) && /2026-10-02/.test(r.reasons[0].detail), JSON.stringify(r));
  ok('and every verdict passes its schema', [r].every((d) => v.check('diff', d).length === 0));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
