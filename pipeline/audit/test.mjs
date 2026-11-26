// Run:  node audit/test.mjs
// The weekly completeness check (audit/completeness.mjs), with a stand-in for the web-search reader: no network, no key.
import { completenessCheck, onSite } from './completeness.mjs';
import { updateOpenLeads } from '../news/open-leads.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const entries = [
  { key: 'h-r-9917-ai-kill-switch-act', title: 'H.R. 9917 — AI Kill Switch Act', short_name: 'H.R. 9917 AI Kill Switch Act', level: 'federal', jurisdiction: 'US', section: 'D', identifiers: { external: { congress_gov: ['119/hr/9917'] } }, sources: [{ url: 'https://www.congress.gov/bill/119th-congress/house-bill/9917' }] },
  { key: 'ca-ag', title: 'California AG v. OpenAI', short_name: 'CA AG v. OpenAI', level: 'state', state: 'CA', jurisdiction: 'US', section: 'G.2', sources: [{ url: 'https://oag.ca.gov/news/press-releases/bonta-sues' }] }
];
const news = { items: [{ title: 'Commerce restricts remote access to advanced AI chips', links: [{ u: 'https://www.federalregister.gov/documents/2026/11/19/2026-23529/x' }] }] };
const TODAY = '2026-11-25';
const reader = (items, searchedUrls) => ({ search: async () => ({ text: `Here is what I found.\n${JSON.stringify(items)}`, searchedUrls, searches: 6 }) });
const it = (title, url, date = '2026-11-24', extra = {}) => ({ title, url, date, kind: 'federal bill', jurisdiction: 'US', bill_number: null, ...extra });

{
  const items = [
    it('H.R. 11157 RSI Safety Act introduced', 'https://www.congress.gov/bill/119th-congress/house-bill/11157'),
    it('A development with a link the searches never returned', 'https://made-up.example.com/x'),
    it('An old development', 'https://www.congress.gov/old', '2026-10-01'),
    it('AI Kill Switch Act hearing', 'https://www.congress.gov/x', '2026-11-20', { bill_number: 'H.R. 9917' }),
    it('California sues OpenAI', 'https://oag.ca.gov/news/press-releases/bonta-sues'),
    it('Commerce restricts remote access to advanced AI chips', 'https://news.example.com/chips')
  ];
  const searched = ['https://www.congress.gov/bill/119th-congress/house-bill/11157', 'https://www.congress.gov/old', 'https://www.congress.gov/x', 'https://oag.ca.gov/news/press-releases/bonta-sues', 'https://news.example.com/chips'];
  const r = await completenessCheck({ client: reader(items, searched), entries, news, today: TODAY });
  ok('a development the site does not have is reported missing, as an audit lead', r.ran && r.missing.length === 1 && r.missing[0].title === 'H.R. 11157 RSI Safety Act introduced' && r.missing[0].from_audit === true, JSON.stringify(r));
  const why = (t) => (r.dropped.find((d) => d.title === t) || {}).why || '';
  ok('an item whose link was not in this call\'s search results is dropped (nothing invented)', /not among this call's search results/.test(why('A development with a link the searches never returned')));
  ok('an item dated outside the window is dropped', /dated outside/.test(why('An old development')));
  ok('an item on a tracked bill is not missing', /the bill is tracked \(h-r-9917-ai-kill-switch-act\)/.test(why('AI Kill Switch Act hearing')));
  ok('an item whose page an entry already links is not missing', /already linked/.test(why('California sues OpenAI')));
  ok('an item with the same headline as a news item is not missing', /same headline/.test(why('Commerce restricts remote access to advanced AI chips')));
  ok('the search count is reported', r.searches === 6 && r.found === 6);
  // into the register: raised at once, never sent to the triage reader, never rejected
  // the reader may be asked only whether the site already has it (news/open-leads.mjs coverage check), never to triage (reject) it
  let asked = 0, covered = 0; const triage = { generate: async (req) => { if (/already has a development/.test(req.system)) covered++; else asked++; return { data: { items: [] } }; } };
  const ol = await updateOpenLeads({ register: null, fresh: r.missing, news, entries, today: TODAY, screener: triage });
  ok('an audit lead is raised on the Watch list at once, never sent to the triage reader (only the coverage check may ask)', ol.alerts.length === 1 && ol.alerts[0].from_audit && asked === 0 && covered <= 1);
}
{
  const r = await completenessCheck({ client: null, entries, news, today: TODAY });
  ok('no reader with web search: not run, and says why', !r.ran && /no AI reader/.test(r.why));
  const boom = { search: async () => { throw new Error('the monthly AI cost cap of $50 is reached'); } };
  const r2 = await completenessCheck({ client: boom, entries, news, today: TODAY });
  ok('a failed search: not run, the reason kept, nothing reported missing', !r2.ran && /cost cap/.test(r2.why) && r2.missing.length === 0);
  const r3 = await completenessCheck({ client: { search: async () => ({ text: 'No JSON here.', searchedUrls: [], searches: 3 }) }, entries, news, today: TODAY });
  ok('an answer without the JSON list: counted as run, nothing missing, says why', r3.ran && r3.missing.length === 0 && /no JSON list/.test(r3.why));
}
ok('onSite: an unrelated item is not on the site', onSite(it('Something new', 'https://example.org/new'), { entries, news }) === null);

console.log(`completeness: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
