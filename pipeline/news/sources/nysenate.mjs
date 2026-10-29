// NY Senate Open Legislation API v3 adapter (news/CONTRACT.md "Raw item"). Tracked NY bills only (RAISE Act etc.).
//   GET {base}/bills/{session}/{printNo}?view=default&key=K   -> { success, result: { basePrintNo, session, title, actions: { items: [...] },
//        votes: { items: [{ voteType, voteDate, committee, memberVotes: { items: { AYE: { size }, NAY: { size } } } }] }, signed, vetoed, ... } }
// NY action text is a fixed clerk vocabulary ("REFERRED TO ...", "PASSED SENATE", "DELIVERED TO GOVERNOR", "SIGNED CHAP.123"); each phrase
// below maps to one class; anything else is recorded with class null.
import fs from 'fs';
import { acceptDate, normNumber, trackedBills, loadStructuredConfig, IDS_PATH } from './openstates.mjs';

export const NY_ACTIONS = [
  [/^SIGNED CHAP\.?\s*\d+/i, 'executive-signature'],
  [/^VETOED MEMO\.?\s*\d+/i, 'executive-veto'],
  [/^DELIVERED TO GOVERNOR/i, 'executive-receipt'],
  [/^PASSED (SENATE|ASSEMBLY)/i, 'passage'],
  [/^REPASSED (SENATE|ASSEMBLY)/i, 'concurrence'],
  [/^ENACTING CLAUSE STRICKEN/i, 'withdrawal'],
  [/^(REPORTED|REPORTED AND COMMITTED TO .+|1ST REPORT CAL\.?.*)$/i, 'committee-passage'],
  [/^(AMEND(ED)? AND RECOMMIT(TED)? TO .+|AMENDED ON THIRD READING.*|PRINT NUMBER \d+[A-Z]?)$/i, 'new-text-version'],
  [/^REFERRED TO /i, 'referral-committee'],
];
export function mapNyAction(text) {
  const t = String(text || '').trim();
  for (const [re, cls] of NY_ACTIONS) if (re.test(t)) return cls;
  return null;
}
const CH = { SENATE: 'upper', ASSEMBLY: 'lower' };
// "S06953" / "S 6953" -> "S6953"
export const nyPrint = (n) => normNumber(n);
export const nySession = (b) => { const m = /(\d{4})/.exec(b.session_name || ''); const y = m ? +m[1] : null; return y && y % 2 === 0 ? y - 1 : y; };

function floorVote(votes, date) {
  const v = ((votes && votes.items) || []).find((x) => x.voteType === 'FLOOR' && String(x.voteDate || '').slice(0, 10) === date);
  if (!v) return null;
  const mv = (v.memberVotes && v.memberVotes.items) || {};
  const n = (k) => (mv[k] ? mv[k].size : 0);
  return { yes: n('AYE') + n('AYEWR'), no: n('NAY') };
}

// One bill record -> RawItems (pure). The first action of the base print (sequenceNo 1 / earliest) is the introduction.
export function billToItems(r, tracked, retrievedAt) {
  const items = [];
  const acts = ((r.actions && r.actions.items) || []).slice().sort((a, b) => (a.sequenceNo ?? 0) - (b.sequenceNo ?? 0));
  const number = `${r.basePrintNo.replace(/^([A-Z]+)(\d+)$/, '$1 $2')}`;
  const url = `https://www.nysenate.gov/legislation/bills/${r.session}/${r.basePrintNo}`;
  acts.forEach((a, i) => {
    const date = acceptDate(a.date, retrievedAt);
    if (!date) return;
    const cls = i === 0 && /^REFERRED TO /i.test(a.text) ? 'introduction' : mapNyAction(a.text);
    const facts = { chamber: CH[a.chamber] || null, number, title: r.title, action: a.text };
    if (cls === 'referral-committee' || cls === 'introduction') facts.committee = String(a.text).replace(/^REFERRED TO /i, '').trim();
    if (cls === 'passage' || cls === 'concurrence') { const v = floorVote(r.votes, date); if (v) facts.vote = v; }
    if (cls === 'executive-signature') facts.chapter = (/CHAP\.?\s*(\d+)/i.exec(a.text) || [])[1] || null;
    const items1 = { source: 'nysenate', source_id: `${r.session}-${r.basePrintNo}-${a.sequenceNo ?? i}`, jurisdiction: 'NY', entry_id: tracked.entry_id, class: cls, date, facts, url, title: `${number}: ${a.text}`, retrieved_at: retrievedAt };
    items.push(items1);
    // An introduction is also the referral to the first committee.
    if (cls === 'introduction') items.push({ ...items1, source_id: `${items1.source_id}-ref`, class: 'referral-committee' });
  });
  return items;
}

export async function fetchItems({ http, env = process.env, since = null, state = {}, entries = null, config = null, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const key = env && env.NYSENATE_API_KEY;
  if (!key) return { items: [], health: { ok: false, count: 0, newest: null, errors: ['no key'] } };
  const cfg = { max_requests_per_run: 40, min_interval_ms: 500, base: 'https://legislation.nysenate.gov/api/3', ...((config || loadStructuredConfig()).nysenate || {}) };
  let bills = entries;
  if (!bills) { try { bills = trackedBills(JSON.parse(fs.readFileSync(IDS_PATH, 'utf8')), { state: 'NY' }); } catch { bills = []; } }
  bills = bills.filter((b) => b.state === 'NY');
  const items = []; const errors = []; let used = 0; let truncated = false;
  const sinceDay = since ? String(since).slice(0, 10) : null;
  for (const b of bills) {
    if (used >= cfg.max_requests_per_run) { truncated = true; break; }
    if (used > 0 && cfg.min_interval_ms) await sleep(cfg.min_interval_ms);
    used++;
    const print = nyPrint(b.number);
    let res;
    try { res = await http.getJson(`${cfg.base}/bills/${nySession(b)}/${print}?view=default&key=${encodeURIComponent(key)}`); } catch (e) { errors.push(String(e && e.message || e).split(key).join('***')); continue; }
    if (!res || res.success === false || !res.result) { errors.push(`${print}: ${res && res.message || 'no result'}`); continue; }
    if (nyPrint(res.result.basePrintNo) !== print) { errors.push(`${print}: API answered ${res.result.basePrintNo}`); continue; }
    const retrieved = now().toISOString();
    items.push(...billToItems(res.result, b, retrieved).filter((x) => !sinceDay || x.date >= sinceDay));
  }
  if (truncated) errors.push(`request cap ${cfg.max_requests_per_run} reached; remaining bills next run`);
  const newest = items.reduce((m, x) => (x.date > (m || '') ? x.date : m), null);
  return { items, health: { ok: errors.filter((e) => !e.startsWith('request cap')).length === 0, count: items.length, newest, errors, requests: used, truncated } };
}
