// Run:  node news/test-open-leads.mjs
// Every news lead ends resolved (covered, rejected with a reason, or expired after being raised); a lead left open is raised (26 Nov 2026).
import { updateOpenLeads, coveredBy, ALERT_RUNS, siteNear } from './open-leads.mjs';
import fsx from 'fs';

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
  const rd = reader((p) => [...p.matchAll(/key: (\S+)\nheadline: Headline (\S+)/g)].map((m) => ({ key: m[1], relevant: m[2] === 'rel', reason: m[2] === 'rel' ? 'a state AG lawsuit against a frontier developer' : 'a product launch' })));
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

// ---------- completeness-check leads the site already has (26 Nov 2026: 4 of 6 alerts were already on the site) ----------
{
  const live = (f) => JSON.parse(fsx.readFileSync(new URL('../fixtures/live-2026-11-26/' + f + '.json', import.meta.url), 'utf8'));
  const entries = live('entries'), news = live('news');
  const ca = { key: 'aud1', title: 'California AG sues OpenAI over undisclosed agent incidents', link: 'https://companyscope.io/register/air-2026-025', publisher: 'weekly completeness check', date: '2026-11-16', from_audit: true };
  const far = { key: 'aud2', title: 'Something on a quiet day', link: 'https://example.org/x', publisher: 'weekly completeness check', date: '2026-07-04', from_audit: true };
  const near = siteNear(ca, { news, entries });
  ok('the reader sees only site items dated within 5 days of the lead', near.some((c) => c.id === 'entry:california-ag-v-openai-agent-cyberattacks') && near.length <= 40);
  const reader = (answer) => ({ calls: 0, async generate() { this.calls++; return { data: { items: answer } }; } });
  const r1 = await updateOpenLeads({ register: { items: {} }, fresh: [ca, far], news, entries, today: '2026-11-26', screener: reader([{ key: 'L1', covered_by: 'entry:california-ag-v-openai-agent-cyberattacks', why: 'the same lawsuit' }, { key: 'L2', covered_by: '', why: 'none' }]) });
  ok('a lead the site already has is resolved as covered, with the item named', r1.resolved.some((x) => x.key === 'aud1' && x.outcome === 'covered' && /california-ag-v-openai/.test(x.why)) && !r1.alerts.some((l) => l.key === 'aud1'), JSON.stringify(r1.resolved));
  ok('a lead nothing covers stays raised', r1.alerts.some((l) => l.key === 'aud2'));
  const r2 = await updateOpenLeads({ register: { items: {} }, fresh: [ca], news, entries, today: '2026-11-26', screener: reader([{ key: 'L1', covered_by: 'entry:made-up-entry', why: 'x', relevant: true, reason: 'a lawsuit' }]) });
  ok('a name not in the shown list never counts', r2.alerts.some((l) => l.key === 'aud1') && !r2.resolved.length);
  const rd = reader([]);
  const r3 = await updateOpenLeads({ register: r2.register, fresh: [], news, entries, today: '2026-11-27', screener: rd });
  ok('checked again only after 3 days', rd.calls === 0 && r3.alerts.some((l) => l.key === 'aud1'));
  const r4 = await updateOpenLeads({ register: { items: {} }, fresh: [ca], news, entries, today: '2026-11-26', screener: null });
  ok('no AI: the lead stays raised (never assumed covered)', r4.alerts.some((l) => l.key === 'aud1'));
}

// ---------- 27 Nov 2026: press leads the site already has, and leads judged under an older reader text ----------
{
  const { TRIAGE_VERSION, TRIAGE_SYSTEM } = await import('./open-leads.mjs');
  const live = (f) => JSON.parse(fsx.readFileSync(new URL('../fixtures/live-2026-11-26/' + f + '.json', import.meta.url), 'utf8'));
  const entries = live('entries'), news = live('news');
  // the live case: a Route Fifty story on California suing OpenAI stayed raised for a week although the site has the case
  const press = { key: 'rf', title: "California is suing OpenAI over its 'rogue' AI agent hack", link: 'https://www.route-fifty.com/x', publisher: 'Route Fifty', date: '2026-11-17' };
  const both = (cov) => ({ calls: 0, async generate({ prompt }) { this.calls++; return { data: { items: /^LEAD /m.test(prompt) ? cov : [...prompt.matchAll(/key: (\S+)/g)].map((m) => ({ key: m[1], relevant: true, reason: 'a state AG lawsuit' })) } }; } });
  const rd = both([{ key: 'L1', covered_by: 'entry:california-ag-v-openai-agent-cyberattacks', why: 'the same lawsuit' }]);
  const r = await updateOpenLeads({ register: { items: {} }, fresh: [press], news, entries, today: '2026-11-26', screener: rd });
  ok('a press lead the reader keeps is checked against the site and resolved as covered', r.resolved.some((x) => x.key === 'rf' && x.outcome === 'covered') && !r.alerts.length, JSON.stringify(r.resolved));
  const rj = await updateOpenLeads({ register: { items: {} }, fresh: [lead('rej')], news, entries, today: '2026-11-26', screener: { calls: 0, async generate({ prompt }) { this.calls++; return { data: { items: /^LEAD /m.test(prompt) ? [] : [{ key: 'L1', relevant: false, reason: 'market reaction' }] } }; } } });
  ok('a rejected lead is not sent to the coverage check', rj.resolved.some((x) => x.key === 'rej' && x.outcome === 'rejected'));
  // a lead judged by the first reader text (no version) is judged again, once
  const old = { items: { o: { ...lead('o'), first_seen: '2026-11-20', runs: 5, triage: { relevant: true, reason: 'chip sales halted', at: '2026-11-20' } } } };
  const again = { calls: 0, async generate({ prompt }) { this.calls++; return { data: { items: /^LEAD /m.test(prompt) ? [] : [{ key: 'L1', relevant: false, reason: 'a company reaction, no government step' }] } }; } };
  const r2 = await updateOpenLeads({ register: old, fresh: [], news, entries, today: '2026-11-27', screener: again });
  ok('a lead judged under an older reader text is judged again and can be rejected', r2.resolved.some((x) => x.key === 'o' && x.outcome === 'rejected'), JSON.stringify(r2.resolved));
  const cur = { items: { c: { ...lead('c'), first_seen: '2026-11-20', runs: 5, triage: { v: TRIAGE_VERSION, relevant: true, reason: 'x', at: '2026-11-26' }, coverage: { checked: '2026-11-26', covered_by: null, why: '' } } } };
  const quiet = both([]);
  await updateOpenLeads({ register: cur, fresh: [], news, entries, today: '2026-11-27', screener: quiet });
  ok('a lead judged under the current text is not asked again', quiet.calls === 0);
  // the live case of 27 Nov: lead keys are URLs, the reader rewrote them, and its right answers were lost
  const urlKey = 'statescoop.com/new-york-attorney-general-creates-unit-to-oversee-ai-safety-and-enforcement';
  const seen = []; const rw = { async generate({ prompt }) { seen.push(prompt); return { data: { items: /^LEAD /m.test(prompt) ? [{ key: 'L1', covered_by: 'entry:california-ag-v-openai-agent-cyberattacks', why: 'same' }] : [{ key: 'L1', relevant: true, reason: 'a new AG unit' }] } }; } };
  const r3 = await updateOpenLeads({ register: { items: {} }, fresh: [{ ...press, key: urlKey }], news, entries, today: '2026-11-26', screener: rw });
  ok('the reader never sees a lead\'s own (URL) key, and its answers keyed L1 are matched back', seen.every((p) => !p.includes(urlKey)) && r3.resolved.some((x) => x.key === urlKey && x.outcome === 'covered'), JSON.stringify(r3.resolved));
  // completeness-check leads are judged too (27 Nov: "lawmakers push for tougher chip rules" stayed raised for 30 days); a G.4 flag never is
  const no = { async generate({ prompt }) { return { data: { items: /^LEAD /m.test(prompt) ? [] : [...prompt.matchAll(/key: (\S+)/g)].map((m) => ({ key: m[1], relevant: false, reason: 'a reaction, no government step' })) } }; } };
  const aud = { key: 'push', title: 'Lawmakers push for tougher AI chip rules', link: 'https://x.example/p', publisher: 'weekly completeness check', date: '2026-11-20', from_audit: true, summary: 'Members of Congress called for tougher rules.' };
  const g4 = { key: 'req', title: 'White House asks a lab to delay a model', link: 'https://x.example/r', publisher: 'P', date: '2026-11-20', request_flag: true };
  const r5 = await updateOpenLeads({ register: { items: {} }, fresh: [aud, g4], news, entries, today: '2026-11-26', screener: no });
  ok('a completeness-check lead the reader judges not relevant is rejected, with its reason', r5.resolved.some((x) => x.key === 'push' && x.outcome === 'rejected'), JSON.stringify(r5.resolved));
  ok('a possible government request (G.4) is still never rejected and stays raised', r5.alerts.some((l) => l.key === 'req') && !r5.resolved.some((x) => x.key === 'req'));
  ok('the reader text rejects market reactions, commentary, caucuses and single Entity List additions', /companies or markets react/.test(TRIAGE_SYSTEM) && /When unsure, answer relevant/.test(TRIAGE_SYSTEM) && /commentary/.test(TRIAGE_SYSTEM) && /caucus/.test(TRIAGE_SYSTEM) && /Entity List/.test(TRIAGE_SYSTEM));
}

console.log(`open leads: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
