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
// audit/completeness.mjs) is raised at once; since 27 Nov 2026 it is judged by the reader like any other lead (before, a completeness
// lead such as "lawmakers push for tougher chip rules", a reaction with no government step, stayed on the Watch list for 30 days). Never throws.
import { canonicalUrl } from './attach.mjs';

export const ALERT_RUNS = 2, EXPIRE_DAYS = 30, MAX_TRIAGE = 15;

// 27 Nov 2026: the first reader kept 12 of 13 leads, most of them market reactions and commentary (chip sales halted, data-center deals
// stalled, "faces obstacles in Congress"), so the Watch list repeated false alarms every run. The reader now rejects only named kinds of
// noise and keeps anything a government body or official did, said or is negotiating; a first stricter text rejected 6 of 65 real items
// on the site (a floor speech, reported negotiations, governors' AI orders), so it was measured on both sides: the site's own government
// news must stay relevant, the 27 Nov false alarms must go. TRIAGE_VERSION: a lead judged under an older text is judged again, once.
export const TRIAGE_VERSION = 3;
export const TRIAGE_SYSTEM = `You sort news headlines for a tracker of US AI policy, centred on frontier and advanced AI (safety, transparency, incidents, compute, chips and export controls, model weights, catastrophic risk, preemption of state AI laws), and also covering how governments organise their own AI oversight. A headline is relevant when it reports something a government body or official did, said or is negotiating on that policy: a bill, law, resolution or draft (introduced, moved, enacted, or pitched to lawmakers by a developer); an executive order, including a governor's order on AI governance or AI procurement; an agency rule, guidance or enforcement action; a new office or unit to oversee AI; a hearing, letter, investigation, floor speech or formal statement by legislators, governors, attorneys general or agency heads; reported negotiations over a bill or a committee chair's decision on one; a court filing or ruling about AI developers or these laws; an informal government request to an AI developer.
Not relevant, even when it mentions such a policy: how companies or markets react to it (sales halted, deals or financing stalled, effects on foreign models); company business, leadership or personnel news, and politicians' reactions to it; commentary, analysis or predictions by journalists or experts, including that a policy "faces obstacles"; lawmakers "pushing" or "urging" in general with no bill, letter, speech or hearing of their own named; the launch of a caucus or working group; routine additions of individual companies to a trade blacklist (the Entity List); research results and product launches; government action on AI used for unrelated purposes (policing, hiring, deepfakes, privacy of chatbot users' data, chatbots for children) unless it is about frontier-AI rules.
When unsure, answer relevant: a lead kept by mistake is only checked again, but a lead dropped by mistake is lost.
Answer for each item: relevant, and a short reason naming what was done or said, or which kind of noise it is.`;
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
  let made; const reader = () => (made === undefined ? (made = typeof screener === 'function' ? screener() : screener) : made); // one reader per run
  // the reader, on leads not yet judged (a G.4 request flag is never rejected, so it is not asked about)
  // The reader is shown short keys (L1, L2, ...), never a lead's own key: live keys are URLs, and on 27 Nov 2026 the reader answered with
  // paraphrased keys ("statescoop-ny-ag-unit"), so two right coverage answers matched no lead and were lost.
  const ask = Object.values(reg.items).filter((l) => (!l.triage || l.triage.v !== TRIAGE_VERSION) && !l.request_flag).slice(0, MAX_TRIAGE);
  if (ask.length && screener) {
    try {
      const rd = reader(); // made only now that there is something to ask
      if (!rd) throw new Error('no AI reader available');
      triage.asked = ask.length;
      const r = await rd.generate({ system: TRIAGE_SYSTEM, prompt: ask.map((l, i) => `key: L${i + 1}\nheadline: ${l.title}\npublisher: ${l.publisher || '?'}${l.summary ? `\nsummary: ${String(l.summary).slice(0, 300)}` : ''}`).join('\n\n'), itemId: `open-leads:${today}`, responseSchema: SCHEMA });
      const got = new Map((((r && r.data) || {}).items || []).map((x) => [String(x.key), x]));
      for (const [i, l] of ask.entries()) { const v = got.get(`L${i + 1}`); if (v && typeof v.relevant === 'boolean') l.triage = { v: TRIAGE_VERSION, relevant: v.relevant, reason: String(v.reason || '').slice(0, 200), at: today }; }
    } catch (e) { triage.why_not = String(e && e.message || e).slice(0, 200); log(`open-leads triage failed: ${triage.why_not}`); }
  } else if (ask.length) triage.why_not = 'no AI reader available';
  // A lead the weekly completeness check found often points to a third-party page about something the site already has (26 Nov 2026: four
  // of six alerts were the BIS chip rule, California v. OpenAI, H.R. 11157 and the SAFE AI outline, all on the site), so links and headlines
  // never match. A reader is shown only the site's entries and news items dated within COVER_DAYS of the lead and must name the one that is
  // the same development; code accepts only a name from that list. Asked again every RECHECK_DAYS while the lead stays open.
  // 27 Nov 2026: every lead that is not being rejected gets this check, not only completeness-check leads (a press story about California
  // suing OpenAI stayed raised for a week although the site has the case: the press link and headline match nothing on the site).
  const rejecting = (l) => l.triage && l.triage.relevant === false && !l.request_flag;
  const recheck = Object.values(reg.items).filter((l) => !rejecting(l) && (!l.coverage || dayGap(l.coverage.checked, today) >= RECHECK_DAYS)).slice(0, MAX_TRIAGE);
  if (recheck.length && screener) {
    try {
      const rd = reader();
      if (!rd) throw new Error('no AI reader available');
      const lists = new Map(recheck.map((l) => [l.key, siteNear(l, { news, entries })]));
      const prompt = recheck.map((l, i) => `LEAD L${i + 1}\nheadline: ${l.title}\ndate: ${l.date}\nsite items dated within ${COVER_DAYS} days:\n${lists.get(l.key).map((c) => `- ${c.id}: ${c.text}`).join('\n') || '- (none)'}`).join('\n\n');
      const r = await rd.generate({ system: COVER_SYSTEM, prompt, itemId: `open-leads:cover:${today}`, responseSchema: COVER_SCHEMA });
      const got = new Map((((r && r.data) || {}).items || []).map((x) => [String(x.key), x]));
      for (const [i, l] of recheck.entries()) {
        const v = got.get(`L${i + 1}`), ids = new Set(lists.get(l.key).map((c) => c.id));
        if (!v) continue;
        l.coverage = { checked: today, covered_by: v.covered_by && ids.has(String(v.covered_by)) ? String(v.covered_by) : null, why: String(v.why || '').slice(0, 200) };
      }
    } catch (e) { log(`open-leads coverage check failed: ${String(e && e.message || e).slice(0, 200)}`); }
  }
  const alerts = [];
  for (const l of Object.values(reg.items)) {
    const cov = coveredBy(l, { news, entries }) || (l.coverage && l.coverage.covered_by ? `the site already has it (${l.coverage.covered_by}: ${l.coverage.why})` : null);
    if (cov) { resolved.push({ key: l.key, outcome: 'covered', why: cov }); delete reg.items[l.key]; continue; }
    if (rejecting(l)) { triage.rejected++; resolved.push({ key: l.key, outcome: 'rejected', why: l.triage.reason }); delete reg.items[l.key]; continue; }
    if (!created.has(l.key)) l.runs = (l.runs || 1) + 1; // runs: how many runs it has been open in, this one included
    if (l.alerted && dayGap(l.first_seen, today) > EXPIRE_DAYS) { resolved.push({ key: l.key, outcome: 'expired', why: `open more than ${EXPIRE_DAYS} days after being raised` }); delete reg.items[l.key]; continue; }
    if (l.runs >= ALERT_RUNS || l.request_flag || l.from_audit) { alerts.push(l); l.alerted = l.alerted || today; }
    if (l.triage && l.triage.relevant) triage.kept++;
  }
  return { register: reg, alerts, resolved, triage };
}
