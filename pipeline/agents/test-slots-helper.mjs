// Tests only: the older agent tests script a new entry's answer the way the Generator wrote it before slots (fields + evidence).
// asSlots turns such an answer into the slot form the Generator now returns (one slot per field, kind from its wording, with that
// field's evidence quote), so those tests run through agents/slots.mjs like production. Answers that already have slots, updates and
// anything that is not a patch pass through unchanged.
const kindOf = (field, text) => {
  const t = String(text || '');
  if (field === 'mechanism') return 'duty';
  if (field === 'penalties') return /criminal|misdemeanor|felony/i.test(t) ? 'criminal' : 'civil';
  if (/10\s?\^\s?2\d|operations|FLOP/i.test(t)) return 'compute';
  if (/revenue/i.test(t)) return 'revenue';
  if (/users/i.test(t)) return 'users';
  if (/cost|\$/i.test(t)) return 'compute_cost';
  return 'capability';
};
export function asSlots(data) {
  if (!data || typeof data !== 'object' || data.operation !== 'create' || data.slots || !data.fields) return data;
  const slots = { mechanism: [], thresholds: [], penalties: [], enforcer: null };
  for (const f of ['mechanism', 'thresholds', 'penalties']) {
    const v = data.fields[f];
    if (typeof v !== 'string' || !v) continue;
    const ev = (data.evidence || []).find((e) => e.field === f || e.field === `fields.${f}`);
    slots[f].push({ kind: kindOf(f, v), ...(f === 'mechanism' ? {} : { applies_to: null }), text: v, quote: ev ? ev.quote : '' });
  }
  return { ...data, slots };
}
