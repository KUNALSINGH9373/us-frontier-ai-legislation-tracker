// CBO publications feed (keyless). A publication whose title names a tracked bill's number is a cbo-estimate for that entry (an
// official record); any other item about AI is a statement candidate (class null, facts.role 'statement').
// Number only: a title that merely shares an official short title is not enough for an estimate.
import { statementAdapter } from './rss.mjs';
import { billTokens, matchNumbers } from './match.mjs';
export const FEED = 'https://www.cbo.gov/publications/all/rss.xml';
export function classify(it, index) {
  const entry_id = matchNumbers(index, it.title, 'US');
  if (!entry_id) return null;
  return { class: 'cbo-estimate', role: 'official', entry_id, number: billTokens(it.title, 'US').join('; ') };
}
export const fetchItems = statementAdapter({ source: 'cbo', url: FEED, jurisdiction: 'US', publisher: 'Congressional Budget Office', classify });
