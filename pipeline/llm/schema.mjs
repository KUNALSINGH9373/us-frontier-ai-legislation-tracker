// The answer shape every AI call asks for, in one form for both providers. Callers write a Gemini-style schema (type 'OBJECT',
// 'STRING', ..., nullable, enum, required); toJsonSchema turns it into the JSON Schema the Claude API constrains its output to
// (lower-case types, nullable as a null type, additionalProperties false), and schemaProblems checks an answer against it in code,
// so an answer of the wrong shape is unusable on either provider and the caller asks once more.

const TYPES = { OBJECT: 'object', ARRAY: 'array', STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean' };
const typeOf = (s) => TYPES[String(s.type || '').toUpperCase()] || String(s.type || '').toLowerCase();

export function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const t = typeOf(s), out = {};
  out.type = s.nullable ? [t, 'null'] : t;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.nullable ? [...s.enum, null] : [...s.enum];
  if (t === 'object') {
    out.properties = Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, toJsonSchema(v)]));
    if (s.required && s.required.length) out.required = [...s.required];
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
