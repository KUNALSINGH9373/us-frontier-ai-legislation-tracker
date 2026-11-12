// "In the press": links to credible outlets' coverage of one tracked entry (entry.press), shown on its page apart from the official
// record and labelled as press. Nothing is written about a story: only the outlet's own headline, its name, the date and the link.
// A story comes from the news step's press leads (news/leads.mjs: matched to exactly one entry by its bill number or name, never by a
// sponsor alone). Each is kept only if
//   1) code: an allowed outlet, the link on that outlet's own site, the feed headline unedited, dated within the window and not in the
//      future, not already listed;
//   2) the reviewer (role bill_reviewer) confirms the story is about that entry and its headline does not misstate the entry's status
//      or what it does, judged against the entry's checked record.
// A press link never changes the entry's status, timeline, checklist or any other field. Written only when auto_publish.press is on.
import { loadData, writeData } from '../publish/run.mjs';
import { makeValidator } from '../schema/validate.mjs';
import { checkIntegrity } from '../schema/integrity.mjs';
import { entryText } from '../pagefields/layout.mjs';
import { daysBefore } from './text.mjs';

// The outlets whose public feeds allow automated reading (checked 12 Nov 2026; Reuters and AP refuse it in robots.txt).
export const PRESS_OUTLETS = { 'The New York Times': ['nytimes.com'], 'The Washington Post': ['washingtonpost.com'], CNN: ['cnn.com'], 'The Independent': ['independent.co.uk'], Politico: ['politico.com'] };
// The publisher names the feeds carry (config/news-sources.json) -> the outlet shown.
const OUTLET_OF = { 'the new york times': 'The New York Times', 'new york times': 'The New York Times', nyt: 'The New York Times', 'the washington post': 'The Washington Post', 'washington post': 'The Washington Post', cnn: 'CNN', 'the independent': 'The Independent', independent: 'The Independent', politico: 'Politico' };
export const outletOf = (publisher) => OUTLET_OF[String(publisher || '').trim().toLowerCase()] || null;
export const hostOk = (outlet, url) => { try { const h = new URL(url).hostname.toLowerCase(); return new URL(url).protocol === 'https:' && (PRESS_OUTLETS[outlet] || []).some((d) => h === d || h.endsWith('.' + d)); } catch { return false; } };
export const PRESS_MAX = 5;

// Code checks on one candidate. Returns problems; empty means it may go to the reviewer.
export function checkPress({ lead, entry, today, maxAgeDays = 14 }) {
  const p = [], outlet = outletOf(lead.publisher), h = String(lead.title || '');
  if (!entry) p.push('no tracked entry');
  if (!outlet) p.push(`"${lead.publisher}" is not one of the press outlets`);
  else if (!hostOk(outlet, lead.link)) p.push(`the link is not on ${outlet}'s own site`);
  if (h.trim().length < 12 || h.length > 300 || /[\n<>{}]/.test(h)) p.push('the headline is missing, too long or has markup');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(lead.date || ''))) p.push('no date');
  else { if (lead.date > today) p.push('dated in the future'); if (lead.date < daysBefore(today, maxAgeDays)) p.push(`older than ${maxAgeDays} days`); }
  if (entry && (entry.press || []).some((x) => x.url === lead.link)) p.push('already listed');
  return p;
}

const S = (extra = {}) => ({ type: 'STRING', ...extra });
export const PRESS_SCHEMA = { type: 'OBJECT', required: ['about_entry', 'misleading', 'why'], properties: { about_entry: S({ enum: ['yes', 'no'] }), misleading: S({ enum: ['yes', 'no'] }), why: S() } };
export const PRESS_SYSTEM = `You check one news headline before a tracker of US frontier-AI law links it, as press coverage, on one entry's page. The link shows only the outlet's headline, its name and the date, labelled "press report, not confirmed by the official record".
Answer two questions against ENTRY TEXT, the entry's checked record:
- about_entry: "yes" only if the story is plainly about THIS law, bill, order or case (not merely about AI policy in general, not about a different bill with a similar name, not a passing mention). "no" otherwise or if unsure.
- misleading: "yes" if the headline, read on this entry's page, would give a false picture of the entry's status or what it does according to ENTRY TEXT (for example it calls a pending bill law, says a bill died when the record shows it moving, or claims a duty the record does not show). Opinion and analysis headlines are not misleading for being opinion. "no" otherwise.
In "why", one sentence.`;

export async function verifyPress({ llm, entry, lead, itemId }) {
  const r = await llm.generate({ system: PRESS_SYSTEM, prompt: [`OUTLET: ${outletOf(lead.publisher)}`, `DATE: ${lead.date}`, `HEADLINE: ${lead.title}`, '', 'ENTRY TEXT:', entryText(entry)].join('\n'), responseSchema: PRESS_SCHEMA, itemId });
  return { keep: r.data.about_entry === 'yes' && r.data.misleading === 'no', about: r.data.about_entry, misleading: r.data.misleading, why: r.data.why };
}

// The press list after adding one item: newest first, no duplicate link, at most PRESS_MAX.
export const addPress = (list, item) => [item, ...(list || []).filter((x) => x.url !== item.url)].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, PRESS_MAX);

// leads: the news step's leads this run (news/run.mjs rep.leads). Returns the step report.
export async function runPressStep({ dataDir, config, factory, aiOff = false, dry = false, leads = [], today, now = new Date(), log = () => {}, verify = verifyPress }) {
  const rep = { ran: false, status: 'skipped', publishing: !!(config.auto_publish && config.auto_publish.press), candidates: 0, added: [], refused: [], problems: [] };
  const cfg = config.press || {};
  if (cfg.enabled === false) { rep.skipped_why = 'press.enabled is false'; return rep; }
  const data = loadData(dataDir), byKey = new Map(data.entries.map((e) => [e.key, e]));
  const cands = leads.filter((l) => !l.primary && l.tracker && outletOf(l.publisher));
  rep.candidates = cands.length;
  if (!rep.publishing) { rep.skipped_why = 'auto_publish.press is off: no AI spent'; return rep; }
  if (aiOff || !factory) { rep.skipped_why = 'AI is off for this run'; return rep; }
  if (!cands.length) { rep.skipped_why = 'no press story matched one tracked entry'; return rep; }
  rep.ran = true;
  const llm = factory.make('bill_reviewer'), at = now.toISOString().replace(/\.\d+Z$/, 'Z'), touched = new Map();
  for (const l of cands.slice(0, cfg.max_checks_per_run ?? 8)) {
    const e = touched.get(l.tracker) || byKey.get(l.tracker);
    const p = checkPress({ lead: l, entry: e, today, maxAgeDays: cfg.max_age_days ?? 14 });
    if (p.length) { rep.refused.push({ entry_key: l.tracker, headline: l.title, why: 'code: ' + p[0] }); continue; }
    try {
      const v = await verify({ llm, entry: e, lead: l, itemId: 'press:' + l.tracker });
      if (!v.keep) { rep.refused.push({ entry_key: l.tracker, headline: l.title, why: `reviewer: about entry ${v.about}, misleading ${v.misleading}: ${v.why}` }); continue; }
      const item = { headline: l.title.trim(), outlet: outletOf(l.publisher), date: l.date, url: l.link, checked_at: at };
      touched.set(l.tracker, { ...e, press: addPress(e.press, item) });
      rep.added.push({ entry_key: l.tracker, ...item });
    } catch (err) { rep.problems.push(`${l.tracker}: ${String(err && err.message || err).slice(0, 160)}`); }
  }
  if (!touched.size) { rep.status = 'unchanged'; return rep; }
  const after = { ...data, entries: data.entries.map((e) => touched.get(e.key) || e) };
  const v = makeValidator(), problems = [];
  [...touched.values()].forEach((e) => v.check('entry', e).forEach((p) => problems.push(`${e.key}: ${p}`)));
  checkIntegrity(after).forEach((p) => problems.push('integrity: ' + p));
  if (problems.length) { rep.status = 'stopped'; rep.problems.push(...problems.slice(0, 10)); return rep; }
  if (!dry) writeData(dataDir, after, ['entries']);
  rep.status = dry ? 'dry-run' : 'written';
  rep.changed = [...touched.keys()];
  rep.summary = `In the press: ${rep.added.length} link(s) added (${rep.added.map((a) => `${a.entry_key}: ${a.outlet}`).join(', ')})`;
  log(rep.summary);
  return rep;
}
