// Open leads (26 Nov 2026): every news lead must end resolved, never just listed once and forgotten. Before this, a lead (a press story
// with no official record behind it yet: a governor's recommendations, a draft outline, a state AG's lawsuit) appeared in one run's
// Telegram report, was marked "seen" and never looked at again, so real developments went missing from the site with no one told.
//
// A lead stays in state/news-open-leads.json until one of:
//   covered   the site now has it: a news item or entry links to the lead's page, or a news item carries the same headline
//   rejected  a reader (role "screener") judged it is not a development the tracker covers, and said why (kept on record)
//   expired   older than EXPIRE_DAYS, and it was raised on the Watch list first (never dropped unseen)
// A lead still open after ALERT_RUNS runs is raised on the run report's Watch list. A lead marked request_flag (a possible informal
// government request to a developer, section G.4) is never rejected by the reader: only covered or expired. No AI: no verdict, the lead
// stays open and is raised (missing coverage is reported, never assumed away). A lead the weekly completeness check found (from_audit:
// audit/completeness.mjs) is treated like a G.4 flag: never sent to the reader or rejected, raised at once. Never throws.
import { canonicalUrl } from './attach.mjs';

export const ALERT_RUNS = 2, EXPIRE_DAYS = 30, MAX_TRIAGE = 15;

export const TRIAGE_SYSTEM = `You sort news headlines for a tracker of US frontier-AI policy. The tracker covers: bills, laws and resolutions on frontier or advanced AI (safety, transparency, incidents, compute, chips, model weights, catastrophic risk, preemption of state AI laws); executive orders and agency rules or actions on them; official proposals and drafts by legislators, governors or attorneys general; court cases about frontier AI developers or these laws; informal government requests to AI developers. It does not cover general AI business news, product launches, research results, opinion pieces, or AI used for unrelated purposes (policing, hiring, deepfakes, chatbots for children) unless the item is about frontier-AI rules.
Answer for each item: relevant (true if the item reports such a development), and a short reason.`;
const SCHEMA = { type: 'OBJECT', required: ['items'], properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', required: ['key', 'relevant', 'reason'], properties: { key: { type: 'STRING' }, relevant: { type: 'BOOLEAN' }, reason: { type: 'STRING' } } } } } };

export const COVER_DAYS = 5, RECHECK_DAYS = 3;
export const COVER_SYSTEM = `You check whether a tracker of US frontier-AI policy already has a development. For each LEAD (a headline found by a web search) you see the tracker's own entries and news items dated close to it. Name the one item that reports the SAME development (the same bill's introduction, the same lawsuit, the same rule, the same announcement), or "" if none does. A related item about a different step (a hearing vs. the bill's introduction, a later update vs. the original) is NOT the same development. Use only the ids given. Give a short reason.`;
const COVER_SCHEMA = { type: 'OBJECT', required: ['items'], properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', required: ['key', 'covered_by', 'why'], properties: { key: { type: 'STRING' }, covered_by: { type: 'STRING' }, why: { type: 'STRING' } } } } } };
// The site items a lead could be: entries with an event dated within COVER_DAYS, and news items dated within COVER_DAYS.
export function siteNear(lead, { news, entries }) {
  const near = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && Math.abs(dayGap(d, lead.date)) <= COVER_DAYS;
  const out = [];
  for (const e of entries || []) { const ev = (e.events || []).filter((v) => near(v.date)); if (ev.length) out.push({ id: `entry:${e.key}`, text: `${e.title} — ${ev.map((v) => `${v.date}: ${v.text}`).join('; ').slice(0, 300)}` }); }
  (news.items || []).forEach((n, i) => { if (near(n.date)) out.push({ id: `news:${i}`, text: `${n.date}: ${n.title}` }); });
  return out.slice(0, 40);
}

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const dayGap = (a, b) => Math.round((+new Date(b) - +new Date(a)) / 864e5);

// Whether the site already carries the lead: a link to the same page from a news item or an entry, or a news item with the same headline.
export function coveredBy(lead, { news, entries }) {
  const u = canonicalUrl(lead.link);
  const urls = new Set([...(news.items || []).flatMap((n) => (n.links || []).map((l) => canonicalUrl(l.u))), ...(entries || []).flatMap((e) => [...(e.sources || []).map((s) => s.url), ...(e.more_links || []).map((l) => l.u)].filter(Boolean).map(canonicalUrl))]);
  if (u && urls.has(u)) return 'a news item or entry links to it';
  const t = norm(lead.title);
  if (t.length >= 20 && (news.items || []).some((n) => norm(n.title) === t)) return 'a news item has the same headline';
  return null;
}

// register: { _note, items: { key: open lead } }. fresh: this run's unattached leads ({ key, title, link, publisher, date, request_flag }).
// Returns { register, alerts: [open leads to raise], resolved: [{ key, outcome, why }], triage: { asked, rejected, kept, why_not } }.
export async function updateOpenLeads({ register, fresh, news, entries, today, screener = null, log = () => {} }) {
  const reg = { last_audit: (register && register.last_audit) || null, _note: 'Open news leads (news/open-leads.mjs): each stays until covered, rejected with a reason, or expired after being raised. Do not edit by hand.', items: { ...((register && register.items) || {}) } };
  const created = new Set();
  for (const l of fresh) if (!reg.items[l.key]) { reg.items[l.key] = { key: l.key, title: l.title, link: l.link, publisher: l.publisher || null, date: l.date || today, first_seen: today, runs: 1, request_flag: !!l.request_flag, primary: !!l.primary, summary: l.summary || '', from_audit: !!l.from_audit, alerted: null, triage: null }; created.add(l.key); }
  const resolved = [], triage = { asked: 0, rejected: 0, kept: 0, why_not: null };
  // the reader, on leads not yet judged (a G.4 request flag is never rejected, so it is not asked about)
  const ask = Object.values(reg.items).filter((l) => !l.triage && !l.request_flag && !l.from_audit).slice(0, MAX_TRIAGE);
  if (ask.length && screener) {
    try {
      const rd = typeof screener === 'function' ? screener() : screener; // made only now that there is something to ask
      if (!rd) throw new Error('no AI reader available');
      triage.asked = ask.length;
      const r = await rd.generate({ system: TRIAGE_SYSTEM, prompt: ask.map((l) => `key: ${l.key}\nheadline: ${l.title}\npublisher: ${l.publisher || '?'}`).join('\n\n'), itemId: `open-leads:${today}`, responseSchema: SCHEMA });
      const got = new Map((((r && r.data) || {}).items || []).map((x) => [String(x.key), x]));
      for (const l of ask) { const v = got.get(l.key); if (v && typeof v.relevant === 'boolean') l.triage = { relevant: v.relevant, reason: String(v.reason || '').slice(0, 200), at: today }; }
    } catch (e) { triage.why_not = String(e && e.message || e).slice(0, 200); log(`open-leads triage failed: ${triage.why_not}`); }
  } else if (ask.length) triage.why_not = 'no AI reader available';
  // A lead the weekly completeness check found often points to a third-party page about something the site already has (26 Nov 2026: four
  // of six alerts were the BIS chip rule, California v. OpenAI, H.R. 11157 and the SAFE AI outline, all on the site), so links and headlines
  // never match. A reader is shown only the site's entries and news items dated within COVER_DAYS of the lead and must name the one that is
  // the same development; code accepts only a name from that list. Asked again every RECHECK_DAYS while the lead stays open.
  const recheck = Object.values(reg.items).filter((l) => l.from_audit && (!l.coverage || dayGap(l.coverage.checked, today) >= RECHECK_DAYS)).slice(0, MAX_TRIAGE);
  if (recheck.length && screener) {
    try {
      const rd = typeof screener === 'function' ? screener() : screener;
      if (!rd) throw new Error('no AI reader available');
      const lists = new Map(recheck.map((l) => [l.key, siteNear(l, { news, entries })]));
      const prompt = recheck.map((l) => `LEAD ${l.key}\nheadline: ${l.title}\ndate: ${l.date}\nsite items dated within ${COVER_DAYS} days:\n${lists.get(l.key).map((c) => `- ${c.id}: ${c.text}`).join('\n') || '- (none)'}`).join('\n\n');
      const r = await rd.generate({ system: COVER_SYSTEM, prompt, itemId: `open-leads:cover:${today}`, responseSchema: COVER_SCHEMA });
      const got = new Map((((r && r.data) || {}).items || []).map((x) => [String(x.key), x]));
      for (const l of recheck) {
        const v = got.get(l.key), ids = new Set(lists.get(l.key).map((c) => c.id));
        if (!v) continue;
        l.coverage = { checked: today, covered_by: v.covered_by && ids.has(String(v.covered_by)) ? String(v.covered_by) : null, why: String(v.why || '').slice(0, 200) };
      }
    } catch (e) { log(`open-leads coverage check failed: ${String(e && e.message || e).slice(0, 200)}`); }
  }
  const alerts = [];
  for (const l of Object.values(reg.items)) {
    const cov = coveredBy(l, { news, entries }) || (l.from_audit && l.coverage && l.coverage.covered_by ? `the site already has it (${l.coverage.covered_by}: ${l.coverage.why})` : null);
    if (cov) { resolved.push({ key: l.key, outcome: 'covered', why: cov }); delete reg.items[l.key]; continue; }
    if (l.triage && l.triage.relevant === false && !l.request_flag && !l.from_audit) { triage.rejected++; resolved.push({ key: l.key, outcome: 'rejected', why: l.triage.reason }); delete reg.items[l.key]; continue; }
    if (!created.has(l.key)) l.runs = (l.runs || 1) + 1; // runs: how many runs it has been open in, this one included
    if (l.alerted && dayGap(l.first_seen, today) > EXPIRE_DAYS) { resolved.push({ key: l.key, outcome: 'expired', why: `open more than ${EXPIRE_DAYS} days after being raised` }); delete reg.items[l.key]; continue; }
    if (l.runs >= ALERT_RUNS || l.request_flag || l.from_audit) { alerts.push(l); l.alerted = l.alerted || today; }
    if (l.triage && l.triage.relevant) triage.kept++;
  }
  return { register: reg, alerts, resolved, triage };
}
