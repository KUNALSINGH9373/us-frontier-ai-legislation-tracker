// Washington Attorney General news feed (keyless; verified 26 Nov 2026: allowed by robots.txt, a real RSS feed). The feed also lists
// data-breach notices (atg.wa.gov/<company>): only the office's news releases (atg.wa.gov/news/news-releases/...) are kept.
// Statements only: class null, facts.role 'statement'. Items about AI or naming a tracked Washington entry.
import { statementAdapter } from './rss.mjs';
export const FEED = 'https://www.atg.wa.gov/rss.xml';
export const isRelease = (it) => /^https:\/\/www\.atg\.wa\.gov\/news\/news-releases\//.test(it.link || '');
export const fetchItems = statementAdapter({ source: 'wa_ag', url: FEED, jurisdiction: 'WA', publisher: 'Washington Attorney General', keep: isRelease });
