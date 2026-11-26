// Press-based news (owner, 26 Nov 2026): a development reported by the press is published as a news item when an OFFICIAL source confirms it
// (a government, court or legislature page) OR TWO INDEPENDENT APPROVED OUTLETS report it. Scope: policy events (hearings, conferences,
// summits), official announcements, dealings between government and AI labs, lawsuits and investigations, about frontier AI.
// AI-lab and event-organiser pages never count as confirmation. Otherwise the story stays an open lead (news/open-leads.mjs).
//
// One run: the recent open leads from approved outlets and official sources (headline, outlet, link, date, the feed's summary) ->
//   grouper (role "validator"): which headlines report the same specific event, and is it in scope
//   code: a group qualifies only with an official source, or approved outlets of at least two different owners
//   writer (role "generator"): a title and a short body from those sources alone, attributed ("Politico and The Washington Post report
//     ..."), each statement backed by a word-for-word quote from a source's headline or summary; code checks every quote and number
//   reviewer (role "bill_reviewer"): same event, in scope, faithful (nothing added, allegations not stated as fact) -> only then published
// Items carry basis "press" (shown as "From press reports") or "official" ("From the official release"). Each group is tried once
// (state/press-news.json). Published only when auto_publish.press_news is on and its gate passes (eval/press-news-set.mjs).
import crypto from 'crypto';
import { containsQuote } from '../agents/source-text.mjs';
import { LlmOutputError } from '../llm/gemini.mjs';

// The owner's approved outlets (26 Nov 2026), with their sites and owners (two outlets of one owner are not independent).
export const APPROVED = {
  Politico: { domains: ['politico.com'], owner: 'Axel Springer' }, 'The New York Times': { domains: ['nytimes.com'], owner: 'New York Times Company' },
  'The Washington Post': { domains: ['washingtonpost.com'], owner: 'Nash Holdings' }, Reuters: { domains: ['reuters.com'], owner: 'Thomson Reuters' },
  AP: { domains: ['apnews.com'], owner: 'Associated Press' }, Bloomberg: { domains: ['bloomberg.com'], owner: 'Bloomberg L.P.' },
  'The Wall Street Journal': { domains: ['wsj.com'], owner: 'News Corp' }, Axios: { domains: ['axios.com'], owner: 'Cox Enterprises' },
  'The Verge': { domains: ['theverge.com'], owner: 'Vox Media' }, 'Ars Technica': { domains: ['arstechnica.com'], owner: 'Condé Nast' },
  Wired: { domains: ['wired.com'], owner: 'Condé Nast' }, 'MIT Technology Review': { domains: ['technologyreview.com'], owner: 'MIT' },
  Lawfare: { domains: ['lawfaremedia.org'], owner: 'Lawfare Institute' }, 'Tech Policy Press': { domains: ['techpolicy.press'], owner: 'Tech Policy Press' },
  StateScoop: { domains: ['statescoop.com'], owner: 'Scoop News Group' }, 'Route Fifty': { domains: ['route-fifty.com'], owner: 'GovExec' }
};
const host = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.hostname.toLowerCase() : null; } catch { return null; } };
const onDomain = (h, d) => h === d || h.endsWith('.' + d);
export const approvedOutlet = (lead) => { const a = APPROVED[lead.publisher], h = host(lead.link); return a && h && a.domains.some((d) => onDomain(h, d)) ? lead.publisher : null; };
// Official: a government, court or legislature site (.gov, a state .us site, the courts). An AI lab or event organiser never is.
export const officialSource = (lead) => { const h = host(lead.link); return !!h && !!lead.primary && (/\.gov$/.test(h) || /\.(?:state|ca|ny|tx|fl|wa|nj|il|ma|pa|mi|oh|co|ct|va|ga|nc|az|mn|or|wi|md|in|tn|mo)\.us$/.test(h) || /(^|\.)uscourts\.gov$/.test(h) || /(^|\.)supremecourt\.gov$/.test(h)); };
export const candidate = (lead) => !!(approvedOutlet(lead) || officialSource(lead));

// A group qualifies: an official source, or approved outlets of at least two owners.
export function qualifies(leads) {
  if (leads.some(officialSource)) return { ok: true, basis: 'official' };
  const owners = new Set(leads.map(approvedOutlet).filter(Boolean).map((o) => APPROVED[o].owner));
  return owners.size >= 2 ? { ok: true, basis: 'press' } : { ok: false, basis: null, why: owners.size ? 'only one independent approved outlet reports it' : 'no approved outlet or official source' };
}
export const signature = (keys) => crypto.createHash('sha256').update([...keys].sort().join('|')).digest('hex').slice(0, 16);

const SCOPE = `The tracker covers US frontier-AI policy: policy events (congressional hearings, official conferences and summits), official announcements (agencies, the White House, governors, legislators, attorneys general), dealings between the US government and AI labs or chip makers about frontier AI or AI chips (agreements, requests, pressure, export decisions), lawsuits and official investigations involving frontier AI developers or frontier-AI laws, and bills or rules on frontier AI. It does NOT cover business news (stock moves, funding, product launches), personal or corporate scandal without a government action, opinion and analysis pieces, or AI used for unrelated purposes.`;

export const GROUPER_SYSTEM = `You group news headlines for a tracker of US frontier-AI policy. ${SCOPE}
Put headlines in one group ONLY if they report the SAME specific event (the same hearing, the same announcement, the same lawsuit, the same government action), not merely the same topic or saga. A headline about a different step of a story is a different event. Leave out any headline that fits no in-scope event. For each group: the keys of its headlines, a one-line description of the event, in_scope (true only if the event itself is covered above) and why.`;
export const GROUPER_SCHEMA = { type: 'OBJECT', required: ['groups'], properties: { groups: { type: 'ARRAY', items: { type: 'OBJECT', required: ['keys', 'event', 'in_scope', 'why'], properties: { keys: { type: 'ARRAY', items: { type: 'STRING' } }, event: { type: 'STRING' }, in_scope: { type: 'BOOLEAN' }, why: { type: 'STRING' } } } } } };

export const WRITER_SYSTEM = `You write one short news item for a tracker of US frontier-AI policy from the sources given (headlines and summaries from news outlets and official sites).
Rules:
- Use ONLY what the sources say. No fact from memory, no background, no prediction.
- Attribute: when the facts come from outlets, say so ("Politico and The Washington Post report that ..."); name only outlets among the sources. Allegations stay allegations; a plan stays a plan.
- title: at most 120 characters, factual, no outlet name needed. body: 1 to 3 sentences, at most 450 characters.
- quotes: for every statement, the source key and the words copied exactly from that source's headline or summary that support it (8 to 200 characters each). Every number in the title and body must appear in a quote.`;
export const WRITER_SCHEMA = { type: 'OBJECT', required: ['title', 'body', 'quotes'], properties: { title: { type: 'STRING' }, body: { type: 'STRING' }, quotes: { type: 'ARRAY', items: { type: 'OBJECT', required: ['key', 'quote'], properties: { key: { type: 'STRING' }, quote: { type: 'STRING' } } } } } };

export const REVIEWER_SYSTEM = `You independently check one news item before a tracker of US frontier-AI policy publishes it. You see the sources it was written from (headlines and summaries) and the item. ${SCOPE}
Answer:
- same_event: true only if every source reports the same specific event.
- in_scope: true only if that event is covered by the tracker.
- faithful: true only if every statement in the title and body is supported by the sources, attributed to them, with no number, name, date or claim added or overstated (an allegation stated as fact, a plan as done, a report as confirmed are overstatements).
List every problem in "problems" (empty only when all three are true).`;
export const REVIEWER_SCHEMA = { type: 'OBJECT', required: ['same_event', 'in_scope', 'faithful', 'problems'], properties: { same_event: { type: 'BOOLEAN' }, in_scope: { type: 'BOOLEAN' }, faithful: { type: 'BOOLEAN' }, problems: { type: 'ARRAY', items: { type: 'STRING' } } } };

const srcBlock = (leads) => leads.map((l) => `<source key="${l.key}" outlet="${l.publisher}" date="${l.date || ''}" url="${l.link}"${officialSource(l) ? ' official="yes"' : ''}>\nheadline: ${l.title}\nsummary: ${l.summary || '(none)'}\n</source>`).join('\n');
const numbersIn = (s) => (String(s || '').replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) || []);
const KNOWN_OUTLETS = [...Object.keys(APPROVED), 'CNN', 'The Independent', 'Fox News', 'NBC', 'CBS', 'ABC', 'The Guardian', 'The Hill', 'Semafor', 'The Information', 'Business Insider', 'TechCrunch', 'CNBC'];

// Code checks on the writer's answer.
export function itemProblems(out, leads, basis) {
  const p = [], byKey = new Map(leads.map((l) => [l.key, l]));
  if (!out || !out.title || !out.body) return ['title and body are required'];
  if (out.title.length > 140) p.push('the title is over 140 characters');
  if (out.body.length > 600) p.push('the body is over 600 characters');
  const qs = Array.isArray(out.quotes) ? out.quotes : [];
  if (!qs.length) p.push('no quotes');
  for (const q of qs) { const l = byKey.get(q.key); if (!l) p.push(`quote names an unknown source ${q.key}`); else if (!containsQuote(`${l.title}\n${l.summary || ''}`, q.quote)) p.push(`quote not in source ${q.key}: "${String(q.quote).slice(0, 80)}"`); }
  const backed = qs.map((q) => q.quote).join(' ');
  numbersIn(`${out.title} ${out.body}`).filter((n) => !numbersIn(backed).includes(n)).forEach((n) => p.push(`the number ${n} is in no quote`));
  const named = KNOWN_OUTLETS.filter((o) => `${out.title} ${out.body}`.includes(o));
  named.filter((o) => !leads.some((l) => l.publisher === o)).forEach((o) => p.push(`names ${o}, which is not among the sources`));
  if (basis === 'press' && (named.length < 1 || !/\breport/i.test(out.body))) p.push('a press-based item must say which outlets report it ("X and Y report ...")');
  return p;
}

const again = async (llm, req) => { try { return await llm.generate(req); } catch (e) { if (!(e instanceof LlmOutputError)) throw e; return llm.generate(req); } };

// Group the candidate leads. Returns [{ keys, event, in_scope, why }] with only known keys, each key in at most one group.
export async function groupLeads({ grouper, leads, itemId = 'press-news:group' }) {
  if (leads.length < 1) return [];
  const r = await again(grouper, { system: GROUPER_SYSTEM, prompt: srcBlock(leads), itemId, responseSchema: GROUPER_SCHEMA });
  const known = new Set(leads.map((l) => l.key)), used = new Set(), out = [];
  for (const g of (r.data && r.data.groups) || []) {
    const keys = [...new Set((g.keys || []).filter((k) => known.has(k) && !used.has(k)))];
    if (!keys.length) continue;
    keys.forEach((k) => used.add(k)); out.push({ keys, event: String(g.event || ''), in_scope: g.in_scope === true, why: String(g.why || '') });
  }
  return out;
}

// One qualifying group -> { decision: publishable | held | out_of_scope, out, review, reason }.
export async function writePressItem({ writer, reviewer, leads, basis, itemId }) {
  const ask = async (extra = '') => (await again(writer, { system: WRITER_SYSTEM, prompt: srcBlock(leads) + extra, itemId, responseSchema: WRITER_SCHEMA })).data;
  let out, problems;
  try {
    out = await ask(); problems = itemProblems(out, leads, basis);
    if (problems.length) { out = await ask(`\n\n<previous_answer>${JSON.stringify(out)}</previous_answer>\nYour previous answer failed these checks; fix every one:\n- ${problems.join('\n- ')}`); problems = itemProblems(out, leads, basis); }
  } catch (e) { if (e instanceof LlmOutputError) return { decision: 'held', reason: `the writer gave an unusable answer twice: ${e.message}` }; throw e; }
  if (problems.length) return { decision: 'held', out, reason: `the item failed its code checks: ${problems.slice(0, 3).join('; ')}` };
  let rv;
  try { rv = (await again(reviewer, { system: REVIEWER_SYSTEM, prompt: `${srcBlock(leads)}\n\n<item>\ntitle: ${out.title}\nbody: ${out.body}\n</item>`, itemId, responseSchema: REVIEWER_SCHEMA })).data; }
  catch (e) { if (e instanceof LlmOutputError) return { decision: 'held', out, reason: `the reviewer gave an unusable answer twice: ${e.message}` }; throw e; }
  const problemsR = Array.isArray(rv && rv.problems) ? rv.problems : [];
  if (!rv || rv.in_scope !== true) return { decision: 'out_of_scope', out, review: rv, reason: `the reviewer: not in scope${problemsR.length ? ` (${problemsR[0]})` : ''}` };
  if (rv.same_event !== true || rv.faithful !== true || problemsR.length) return { decision: 'held', out, review: rv, reason: `the reviewer: ${rv.same_event !== true ? 'not one event; ' : ''}${rv.faithful !== true ? 'not faithful; ' : ''}${problemsR.join('; ')}`.slice(0, 300) };
  return { decision: 'publishable', out, review: rv };
}

// The news item. basis "press": "From press reports"; "official": "From the official release".
export function pressItem({ out, leads, basis, tracker = null, kind = 'federal', at, runId }) {
  const sorted = [...leads].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const outlets = [...new Set(leads.filter((l) => !officialSource(l)).map((l) => l.publisher))], off = leads.filter(officialSource);
  const check = basis === 'official'
    ? `From the official release (${[...new Set(off.map((l) => l.publisher))].join(', ')})${outlets.length ? `, with press reports (${outlets.join(', ')})` : ''}. Written by the pipeline from the sources' own words and checked by an independent reviewer.`
    : `From press reports (${outlets.join(', ')}); not confirmed by an official record. Written by the pipeline from the outlets' own words and checked by an independent reviewer.`;
  const byKey = new Map(leads.map((l) => [l.key, l]));
  return {
    date: sorted[0].date, kind, title: out.title, body: out.body, basis,
    links: sorted.map((l) => ({ t: `${l.publisher}: ${l.title}`.slice(0, 160), u: l.link })),
    check, ...(tracker ? { tracker } : {}), origin: 'automated', verification: { method: 'agent', checked_at: at, run_id: runId, rounds: 1 },
    evidence: out.quotes.map((q) => ({ field: 'body', quote: q.quote, source_url: byKey.get(q.key).link }))
  };
}

// ---------- the step (update.mjs 4d3) ----------
import fs from 'fs';
import path from 'path';
import { buildIndex, matchText } from './sources/match.mjs';
import { newsKind } from '../publish/tier-a.mjs';
import { checkPublish } from '../publish/guards.mjs';
import { loadData, writeData } from '../publish/run.mjs';

export const WINDOW_DAYS = 4, MAX_ITEMS_PER_RUN = 2, MAX_CANDIDATES = 60;
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const daysBefore = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);

// The recent open leads that can count: approved outlets and official sources, never used by a press item before.
export function pressCandidates(register, state, today, news) {
  const linked = new Set((news.items || []).flatMap((n) => (n.links || []).map((l) => l.u)));
  return Object.values((register && register.items) || {}).filter((l) => l && l.key && l.link && candidate(l) && String(l.date || '') >= daysBefore(today, WINDOW_DAYS) && !state.used[l.key] && !linked.has(l.link))
    .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, MAX_CANDIDATES);
}

export async function runPressNewsStep({ dataDir, leadsFile, stateFile, config = {}, factory = null, aiOff = false, dry = false, today, now = new Date(), runId, log = () => {} }) {
  const res = { status: 'quiet', candidates: 0, groups: 0, qualifying: 0, added: [], held: [], out_of_scope: [], waiting: 0, skipped_why: null, problems: [], summary: '' };
  const state = readJ(stateFile, null) || { _note: 'Press-based news (news/press-news.mjs): groups already tried and the leads they used. Do not edit by hand.', groups: {}, used: {} };
  const before = loadData(dataDir);
  const cands = pressCandidates(readJ(leadsFile, { items: {} }), state, today, before.news);
  res.candidates = cands.length;
  if (cands.length < 1) return res;
  if (!(config.auto_publish && config.auto_publish.press_news)) { res.skipped_why = 'auto_publish.press_news is off'; return res; }
  if (aiOff || !factory) { res.skipped_why = aiOff || 'no AI'; return res; }
  const groups = await groupLeads({ grouper: factory.make('validator'), leads: cands, itemId: `press-news:${runId}` });
  res.groups = groups.length;
  const byKey = new Map(cands.map((l) => [l.key, l])), index = buildIndex(before.entries), at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  let data = JSON.parse(JSON.stringify(before)), writes = 0;
  for (const g of groups) {
    const leads = g.keys.map((k) => byKey.get(k)), q = qualifies(leads), sig = signature(g.keys);
    // out of scope: settled (never sent again); in scope but not yet qualifying: waits for a second outlet or an official source
    if (!g.in_scope) { g.keys.forEach((k) => { state.used[k] = 'out_of_scope'; }); continue; }
    if (!q.ok || state.groups[sig]) { if (!q.ok) res.waiting++; continue; }
    if (writes >= MAX_ITEMS_PER_RUN) { res.waiting++; continue; }
    res.qualifying++; writes++;
    const w = await writePressItem({ writer: factory.make('generator'), reviewer: factory.make('bill_reviewer'), leads, basis: q.basis, itemId: `press-news:${sig}` });
    state.groups[sig] = { at: today, decision: w.decision, event: g.event, keys: g.keys, why: w.reason || null };
    if (w.decision === 'out_of_scope') { res.out_of_scope.push({ event: g.event, why: w.reason }); continue; }
    if (w.decision !== 'publishable') { res.held.push({ event: g.event, why: w.reason }); continue; }
    // filed under a tracked entry only when the sources name exactly one, by its number or official title
    const m = matchText(index, leads.map((l) => `${l.title}. ${l.summary || ''}`).join(' '), 'US');
    const entry = m.entry_id ? before.entries.find((e) => e.key === m.entry_id) : null;
    const item = pressItem({ out: w.out, leads, basis: q.basis, tracker: entry ? entry.key : null, kind: entry ? newsKind(entry) : (leads.some((l) => l.kind === 'state') ? 'state' : 'federal'), at, runId });
    const trial = JSON.parse(JSON.stringify(data)); trial.news.items.push(item); trial.news.items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const check = checkPublish({ before, after: { ...trial, relationships: before.relationships }, runDate: today, maxEntries: config.max_entries_changed_per_run ?? 15 });
    if (check.problems.length) { state.groups[sig].decision = 'held'; state.groups[sig].why = check.problems[0]; res.held.push({ event: g.event, why: check.problems[0] }); continue; }
    data = trial; g.keys.forEach((k) => { state.used[k] = sig; });
    res.added.push({ title: item.title, basis: q.basis, tracker: item.tracker || null, links: item.links.length });
  }
  if (res.added.length) { res.status = dry ? 'dry-run' : 'written'; if (!dry) writeData(dataDir, { ...data, relationships: before.relationships }, ['news']); }
  if (!dry) { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); const t = stateFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(state, null, 1) + '\n'); fs.renameSync(t, stateFile); }
  res.summary = `Press-based news: ${res.candidates} recent lead(s), ${res.groups} event group(s), ${res.qualifying} qualifying, ${res.added.length} item(s) added${res.added.length ? ': ' + res.added.map((x) => x.title).join('; ') : ''}`;
  log(res.summary);
  return res;
}
