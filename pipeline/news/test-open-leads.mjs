// Run:  node news/test-open-leads.mjs
// Every news lead ends resolved (covered, rejected with a reason, or expired after being raised); a lead left open is raised (26 Nov 2026).
import { updateOpenLeads, coveredBy, ALERT_RUNS } from './open-leads.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const news = { items: [{ title: 'Existing item on the page', links: [{ t: 'x', u: 'https://www.example.gov/covered-release?utm_source=feed' }] }] };
const entries = [{ key: 'e1', sources: [{ url: 'https://oag.ca.gov/news/press-releases/bonta-sues' }] }];
const lead = (key, o = {}) => ({ key, title: `Headline ${key} about frontier AI rules`, link: `https://news.example.com/${key}`, publisher: 'Example News', date: '2026-11-20', ...o });
const reader = (fn) => ({ generate: async ({ prompt }) => ({ data: { items: fn(prompt) } }) });

// open, then raised after ALERT_RUNS runs (several runs on the same day count)
{
  let r = await updateOpenLeads({ register: null, fresh: [lead('a')], news, entries, today: '2026-11-20' });
  ok('a new lead is open and not raised on its first run', r.register.items.a && r.register.items.a.runs === 1 && r.alerts.length === 0, JSON.stringify(r.register.items.a));
  ok('no AI: the lead gets no verdict and stays open (never assumed irrelevant)', r.triage.why_not && !r.register.items.a.triage);
  r = await updateOpenLeads({ register: r.register, fresh: [], news, entries, today: '2026-11-20' });
  ok(`still open on run ${ALERT_RUNS} (same day): raised on the Watch list`, r.alerts.some((l) => l.key === 'a') && r.register.items.a.runs === ALERT_RUNS && r.register.items.a.alerted === '2026-11-20', JSON.stringify(r.register.items.a));
  r = await updateOpenLeads({ register: r.register, fresh: [lead('a')], news, entries, today: '2026-11-21' });
  ok('seen again in a feed: not duplicated, still raised', Object.keys(r.register.items).length === 1 && r.alerts.length === 1);
  r = await updateOpenLeads({ register: r.register, fresh: [], news, entries, today: '2026-12-22' });
  ok('open more than 30 days after being raised: expired (recorded, not dropped unseen)', !r.register.items.a && r.resolved.some((x) => x.key === 'a' && x.outcome === 'expired'));
}
// covered by the site
{
  const r = await updateOpenLeads({ register: null, fresh: [lead('b', { link: 'https://example.gov/covered-release' }), lead('c', { link: 'https://oag.ca.gov/news/press-releases/bonta-sues' }), lead('d', { title: 'Existing item on the page' })], news, entries, today: '2026-11-20' });
  ok('a lead whose page a news item links to is covered', r.resolved.some((x) => x.key === 'b' && x.outcome === 'covered'), JSON.stringify(r.resolved));
  ok('a lead whose page an entry cites is covered', r.resolved.some((x) => x.key === 'c' && x.outcome === 'covered'));
  ok('a lead with the same headline as a news item is covered', r.resolved.some((x) => x.key === 'd' && x.outcome === 'covered'));
  ok('a very short headline is not matched on the title alone', coveredBy(lead('s', { title: 'AI bill' }), { news: { items: [{ title: 'AI bill', links: [] }] }, entries: [] }) === null);
  ok('coveredBy: an unrelated lead is not covered', coveredBy(lead('z'), { news, entries }) === null);
}
// the reader: not relevant -> rejected with its reason; relevant -> kept and raised later; a G.4 flag is never rejected and raised at once
{
  const rd = reader((p) => [...p.matchAll(/key: (\S+)/g)].map((m) => ({ key: m[1], relevant: m[1] === 'rel', reason: m[1] === 'rel' ? 'a state AG lawsuit against a frontier developer' : 'a product launch' })));
  let r = await updateOpenLeads({ register: null, fresh: [lead('rel'), lead('launch'), lead('g4', { request_flag: true })], news, entries, today: '2026-11-20', screener: rd });
  ok('not relevant: rejected, with the reader\'s reason on record', r.resolved.some((x) => x.key === 'launch' && x.outcome === 'rejected' && /product launch/.test(x.why)) && !r.register.items.launch);
  ok('relevant: kept open with its reason', r.register.items.rel && r.register.items.rel.triage.relevant === true);
  ok('a possible informal government request (G.4) is never sent to the reader and is raised at once', r.register.items.g4 && !r.register.items.g4.triage && r.alerts.some((l) => l.key === 'g4'));
  r = await updateOpenLeads({ register: r.register, fresh: [], news, entries, today: '2026-11-20', screener: rd });
  ok('a relevant lead still not on the site after two runs is raised', r.alerts.some((l) => l.key === 'rel'));
  ok('a lead already judged is not asked about again', r.triage.asked === 0);
}
// a reader that fails gives no verdict
{
  const boom = { generate: async () => { throw new Error('API down'); } };
  const r = await updateOpenLeads({ register: null, fresh: [lead('e')], news, entries, today: '2026-11-20', screener: boom });
  ok('a failed reader call: the lead stays open with no verdict, and the failure is reported', r.register.items.e && !r.register.items.e.triage && /API down/.test(r.triage.why_not));
}
// the reader is made only when a lead needs a verdict
{
  let made = 0; const lazy = () => { made++; return reader(() => []); };
  await updateOpenLeads({ register: null, fresh: [], news, entries, today: '2026-11-20', screener: lazy });
  ok('no lead to judge: no AI reader is made', made === 0);
  await updateOpenLeads({ register: null, fresh: [lead('f')], news, entries, today: '2026-11-20', screener: lazy });
  ok('a lead to judge: the reader is made once', made === 1);
}
console.log(`open leads: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
