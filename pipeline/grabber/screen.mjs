// Cheap, plain-code screen: is a new bill worth a closer look? Matches its title against the draft term list.
// It only decides what gets FETCHED, never what gets published.
export function makeScreen(scope) {
  const res = scope.title_terms.map((t) => new RegExp(t.startsWith('\\b') ? t : t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  return (title) => !!title && res.some((r) => r.test(title));
}
