// New Jersey Attorney General news feed (keyless; verified 26 Nov 2026: allowed by robots.txt, a real RSS feed of the office's releases).
// Statements only: class null, facts.role 'statement'. Items about AI or naming a tracked New Jersey entry (bill numbers read as New Jersey's).
import { statementAdapter } from './rss.mjs';
export const FEED = 'https://www.njoag.gov/feed/';
export const fetchItems = statementAdapter({ source: 'nj_ag', url: FEED, jurisdiction: 'NJ', publisher: 'New Jersey Attorney General' });
