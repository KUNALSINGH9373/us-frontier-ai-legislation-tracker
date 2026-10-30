// California Attorney General news feed (keyless). Statements only: class null, facts.role 'statement'. Items about AI or naming a
// tracked California entry (bill numbers read as California's).
import { statementAdapter } from './rss.mjs';
export const FEED = 'https://oag.ca.gov/news/feed';
export const fetchItems = statementAdapter({ source: 'ca_ag', url: FEED, jurisdiction: 'CA', publisher: 'California Attorney General' });
