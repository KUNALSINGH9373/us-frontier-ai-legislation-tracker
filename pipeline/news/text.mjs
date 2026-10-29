// Plain text helpers for the card writer (kept from the removed news/write.mjs): dates written in words, and sentence splitting.
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})\b/g;
export const datesIn = (s) => [...String(s || '').matchAll(DATE)].map((m) => `${m[3]}-${String(MON.indexOf(m[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`);
const ABBREV = /(?:\b(?:Reps?|Sens?|Gov|Lt|Dr|Mr|Mrs|Ms|Jr|Sr|St|No|Nos|Inc|Co|Corp|vs|Dept|Jan|Feb|Aug|Sept?|Oct|Nov|Dec)|\b[A-Z](?:\.[A-Z])*)\.$/;
export function sentences(text) {
  const out = [];
  for (const piece of String(text || '').trim().split(/(?<=[.!?][”"]?)\s+(?=[A-Z“"])/)) {
    if (out.length && ABBREV.test(out[out.length - 1])) out[out.length - 1] += ' ' + piece; else out.push(piece);
  }
  return out.map((s) => s.trim()).filter((s) => s.length > 3);
}
