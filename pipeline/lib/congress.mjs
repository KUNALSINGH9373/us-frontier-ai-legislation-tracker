// Which Congress a date or a bill belongs to, worked out rather than written in (the 120th Congress begins on 3 January 2027, and every
// later one two years after). A Congress begins at noon on 3 January of an odd year (20th Amendment); a run's dates are taken in UTC, so
// 3 January itself already counts as the new Congress (a bill cannot be introduced before it convenes that day).
//   congressOn(date)            -> 119 for any day from 3 Jan 2025 to 2 Jan 2027, 120 from 3 Jan 2027
//   congressesBetween(a, b)     -> every Congress a time window touches (a run that spans 3 January lists both)
//   ordinal(n) / sessionLabel   -> "119th" / "119th Congress"
//   congressOfId("119/hr/9925") -> 119
const FIRST_YEAR = 1789; // the 1st Congress
export function congressOn(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${date}`);
  const y = d.getUTCFullYear(), beforeStart = y % 2 === 1 && d.getUTCMonth() === 0 && d.getUTCDate() < 3;
  return Math.floor((y - FIRST_YEAR) / 2) + 1 - (beforeStart ? 1 : 0);
}
export function congressesBetween(from, to) {
  const a = congressOn(from), b = congressOn(to), out = [];
  for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.push(n);
  return out;
}
export function ordinal(n) {
  const v = Number(n), t = v % 100;
  return `${v}${t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th')}`;
}
export const sessionLabel = (n) => `${ordinal(n)} Congress`;
export const congressOfId = (id) => { const m = /^(\d+)\//.exec(String(id || '')); return m ? Number(m[1]) : null; };
// An entry's Congress: its stored session ("119th Congress"), else the Congress of its earliest dated event, else null.
export function congressOfEntry(e) {
  const m = /^(\d+)(?:st|nd|rd|th) Congress$/.exec(String((e && e.identifiers && e.identifiers.session) || ''));
  if (m) return Number(m[1]);
  const first = ((e && e.events) || []).map((x) => x.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')).sort()[0];
  return first ? congressOn(first) : null;
}
