// Congress.gov API v3, the records the bill adapter (congress_gov) does not read. Key: CONGRESS_API_KEY (an api.data.gov key; the
// limit is 5,000 calls an hour, and a run makes at most 1 + MAX_MEETINGS + 1 + MAX_CRS + 1 calls, incremental via `since`).
//   GET /v3/committee-meeting?fromDateTime   -> detail for 119th-Congress meetings -> hearing-scheduled / hearing-held, only when a
//                                               related bill is a tracked entry (structured relatedItems, never the title)
//   GET /v3/crsreport?fromDateTime           -> detail for reports whose title is about AI -> crs-report, only when the report names a
//                                               tracked bill (relatedMaterials or a bill number / official title in its summary)
//   GET /v3/nomination?fromDateTime          -> nomination, only for the AI-relevant positions in POSITIONS (code list)
import { collect, get, isAI, plain, sourceConfig, safely, iso, addDays, etDate, noKey } from './common.mjs';
import { buildIndex, matchBill, matchText } from './match.mjs';

const API = 'https://api.congress.gov/v3';
export const MAX_MEETINGS = 15, MAX_CRS = 10;
// Positions whose nominee matters to frontier-AI policy. Matched against the nomination's official description.
export const POSITIONS = [
  /Director of the Office of Science and Technology Policy/i,
  /Associate Director of the Office of Science and Technology Policy/i,
  /Under Secretary of Commerce for Standards and Technology/i,
  /Director of the National Institute of Standards and Technology/i,
  /Under Secretary of Commerce for Industry and Security/i,
  /Assistant Secretary of Commerce for (?:Communications and Information|Export Administration|Export Enforcement)/i,
  /Chief Technology Officer of the United States/i,
  /National Cyber Director/i,
  /Federal Trade Commissioner|Member of the Federal Trade Commission/i,
  /Director of the National Science Foundation/i,
  /Under Secretary of Defense for Research and Engineering/i,
  /Director of the Cybersecurity and Infrastructure Security Agency/i,
];
const BILL_TYPES = { 'H.R.': 'HR', HR: 'HR', S: 'S', 'S.': 'S', HRES: 'HRES', SRES: 'SRES', HJRES: 'HJRES', SJRES: 'SJRES' };
const billType = (t) => BILL_TYPES[String(t || '').toUpperCase().replace(/\s/g, '')] || String(t || '').toUpperCase().replace(/[.\s]/g, '');
const eventUrl = (congress, chamber, id) => `https://www.congress.gov/event/${congress}th-Congress/${String(chamber).toLowerCase()}-event/${id}`;

export async function fetchItems({ http, env = {}, since, state = {}, entries = [], now } = {}) {
  const key = env.CONGRESS_API_KEY;
  if (!key) return noKey();
  return safely(async () => {
    const retrievedAt = iso(now || new Date());
    const today = retrievedAt.slice(0, 10);
    const from = String(since || state.since || addDays(today, -7)).slice(0, 10) + 'T00:00:00Z';
    const c = collect('congress_extra', { retrievedAt, hosts: sourceConfig('congress_extra').hosts });
    const index = buildIndex(entries);
    const q = (p, extra = '') => `${API}/${p}?format=json&api_key=${encodeURIComponent(key)}${extra}`;
    const keys = [key];

    // Committee meetings.
    const ml = await get(http, q('committee-meeting', `&limit=50&fromDateTime=${from}`), { keys });
    if (!ml.ok) c.errors.push(ml.error);
    else for (const m of (ml.data.committeeMeetings || []).filter((x) => +x.congress >= 119).slice(0, MAX_MEETINGS)) {
      const dr = await get(http, q(`committee-meeting/${m.congress}/${String(m.chamber).toLowerCase()}/${m.eventId}`), { keys });
      if (!dr.ok) { c.errors.push(dr.error); continue; }
      const d = dr.data.committeeMeeting || {};
      const bills = d.relatedItems?.bills || [];
      const hits = [...new Set(bills.map((b) => matchBill(index, { jurisdiction: 'US', type: billType(b.type), number: b.number, congress: b.congress })).filter(Boolean))];
      if (hits.length !== 1) continue;
      // A rescheduled meeting did not take place on this date (Congress.gov keeps the old date): like a cancellation (review r9 #2).
      const withdrawn = /cancel|postpon|resched/i.test(d.meetingStatus || '');
      const meetingDate = etDate(d.date);
      if (!meetingDate) continue;
      const hearing = /hearing/i.test(d.type || '');
      // held only when the record shows it happened (review r8 L5, r9 #2): its status says so, or the meeting day is before today in
      // Washington and its status is still plain "Scheduled" (Congress.gov changes it on a cancellation, postponement or new date).
      // Any other status is no proof, so no card.
      const status = String(d.meetingStatus || '').trim();
      const held = !withdrawn && (/\b(held|completed?|concluded)\b/i.test(status) || (meetingDate < (etDate(retrievedAt) || today) && /^scheduled$/i.test(status)));
      const cls = hearing ? (held ? 'hearing-held' : 'hearing-scheduled') : null;
      c.add({ source_id: `meeting:${d.congress}/${String(d.chamber).toLowerCase()}/${d.eventId}`, entry_id: hits[0], class: cls,
        date: held ? meetingDate : etDate(d.updateDate) || today,
        facts: { title: d.title, chamber: d.chamber, committee: (d.committees || []).map((x) => x.name).join('; '), hearing_date: meetingDate, withdrawn: withdrawn || null, meeting_type: d.type,
          meeting_status: d.meetingStatus, bills: bills.map((b) => `${b.type} ${b.number}`).join('; ') },
        url: eventUrl(d.congress, d.chamber, d.eventId), title: d.title });
    }

    // CRS reports.
    const cl = await get(http, q('crsreport', `&limit=100&fromDateTime=${from}`), { keys });
    if (!cl.ok) c.errors.push(cl.error);
    else for (const r of (cl.data.CRSReports || []).filter((x) => isAI(x.title) || matchText(index, x.title, 'US').entry_id).slice(0, MAX_CRS)) {
      const dr = await get(http, q(`crsreport/${encodeURIComponent(r.id)}`), { keys });
      if (!dr.ok) { c.errors.push(dr.error); continue; }
      const d = dr.data.CRSReport || {};
      const rel = (d.relatedMaterials || []).map((b) => matchBill(index, { jurisdiction: 'US', type: billType(b.type), number: b.number, congress: b.congress })).filter(Boolean);
      const relSet = [...new Set(rel)];
      const entry_id = relSet.length === 1 ? relSet[0] : relSet.length > 1 ? null : matchText(index, `${d.title || r.title}. ${plain(d.summary)}`, 'US').entry_id;
      if (!entry_id) continue;
      c.add({ source_id: `crs:${r.id}:${d.currentVersion || r.version || 1}`, entry_id, class: 'crs-report', date: etDate(d.publishDate || r.publishDate),
        facts: { title: d.title || r.title, number: r.id, content_type: r.contentType, version: d.currentVersion || r.version, authors: (d.authors || []).map((a) => a.author).join('; ') },
        url: `https://www.congress.gov/crs-product/${encodeURIComponent(r.id)}`, title: d.title || r.title });
    }

    // Nominations to AI-relevant positions.
    const nl = await get(http, q('nomination', `&limit=100&fromDateTime=${from}`), { keys });
    if (!nl.ok) c.errors.push(nl.error);
    else for (const n of nl.data.nominations || []) {
      if (+n.congress < 119 || !POSITIONS.some((re) => re.test(n.description || ''))) continue;
      c.add({ source_id: `nomination:${n.congress}/${n.citation}`, entry_id: null, class: 'nomination', date: n.receivedDate,
        facts: { title: n.description, number: n.citation, organization: n.organization, latest_action: n.latestAction?.text, latest_action_date: n.latestAction?.actionDate },
        url: `https://www.congress.gov/nomination/${n.congress}th-congress/${n.number}`, title: n.description });
    }
    return c.result({ state: { since: addDays(today, -1) } });
  });
}
