// The answer shape every AI call asks for, in one form for both providers. Callers write a Gemini-style schema (type 'OBJECT',
// 'STRING', ..., nullable, enum, required); toJsonSchema turns it into the JSON Schema the Claude API constrains its output to
// (lower-case types, nullable as a null type, additionalProperties false), and schemaProblems checks an answer against it in code,
// so an answer of the wrong shape is unusable on either provider and the caller asks once more.

const TYPES = { OBJECT: 'object', ARRAY: 'array', STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean' };
const typeOf = (s) => TYPES[String(s.type || '').toUpperCase()] || String(s.type || '').toLowerCase();

export function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const t = typeOf(s), out = {};
  // a nullable enum is anyOf [enum, null]: since 5 Nov 2026 the Claude API refuses a type list with an enum ("Enum value 'or' does
  // not match declared type")
  if (s.nullable && s.enum) return { anyOf: [toJsonSchema({ ...s, nullable: false }), { type: 'null' }] };
  out.type = s.nullable ? [t, 'null'] : t;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = [...s.enum];
  if (t === 'object') {
    // An optional text property is sent as required, and an empty string stands for "not given": the Claude API refuses a schema
    // with many optional properties (Nov 2026: "too many optional parameters (27)", the 13 duties' section and quote) and also one
    // with many null unions. dropOptionalNulls takes those empty strings (and any null) out of the answer again, so callers see the
    // same answer as before. Other optional properties stay optional.
    const req = new Set(s.required || []);
    const asText = (k, v) => !req.has(k) && !v.enum && typeOf(v) === 'string';
    out.properties = Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, asText(k, v) ? { ...toJsonSchema({ ...v, nullable: false }), description: ((v.description ? v.description + ' ' : '') + 'Empty string if not given.') } : toJsonSchema(v)]));
    const sent = Object.keys(s.properties || {}).filter((k) => req.has(k) || asText(k, s.properties[k]));
    if (sent.length) out.required = sent;
    out.additionalProperties = false;
  }
  if (t === 'array' && s.items) out.items = toJsonSchema(s.items);
  return out;
}

// Readable problems with `value` against a Gemini-style schema: missing required keys, wrong types, values outside an enum.
// Extra keys are not a problem (the Claude API already refuses them; Gemini may add one and the callers ignore it).
export function schemaProblems(s, value, at = 'answer') {
  if (!s || typeof s !== 'object') return [];
  if (value === null) return s.nullable ? [] : [`${at} is null`];
  const t = typeOf(s), out = [];
  const actual = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const fits = t === actual || (t === 'number' && actual === 'integer');
  if (!fits) return [`${at} should be ${t}, got ${actual}`];
  if (s.enum && !s.enum.includes(value)) out.push(`${at} is "${value}", not one of ${s.enum.join(', ')}`);
  if (t === 'object') {
    for (const k of s.required || []) if (!(k in value)) out.push(`${at}.${k} is missing`);
    for (const [k, v] of Object.entries(s.properties || {})) if (k in value && value[k] !== undefined) out.push(...schemaProblems(v, value[k], `${at}.${k}`));
  }
  if (t === 'array' && s.items) value.forEach((x, i) => out.push(...schemaProblems(s.items, x, `${at}[${i}]`)));
  return out;
}

// The empty strings (and nulls) toJsonSchema allowed for optional properties, removed: an optional property left empty is simply absent.
export function dropOptionalNulls(s, value) {
  if (!s || typeof s !== 'object' || value === null || typeof value !== 'object') return value;
  const t = typeOf(s);
  if (t === 'array' && Array.isArray(value)) return value.map((x) => dropOptionalNulls(s.items, x));
  if (t !== 'object' || Array.isArray(value)) return value;
  const req = new Set(s.required || []), out = {};
  for (const [k, v] of Object.entries(value)) {
    const p = (s.properties || {})[k];
    if (p && !req.has(k) && ((v === null && !p.nullable) || (v === '' && typeOf(p) === 'string'))) continue;
    out[k] = p ? dropOptionalNulls(p, v) : v;
  }
  return out;
}
