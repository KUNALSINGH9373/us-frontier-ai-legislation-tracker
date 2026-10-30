// NIST news feed (keyless). Statements only: class null, facts.role 'statement'. Items about AI or naming a tracked entry.
import { statementAdapter } from './rss.mjs';
export const FEED = 'https://www.nist.gov/news-events/news/rss.xml';
export const fetchItems = statementAdapter({ source: 'nist', url: FEED, jurisdiction: 'US', publisher: 'NIST' });
