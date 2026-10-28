// CourtListener REST API v4 (https://www.courtlistener.com/api/rest/v4). Free token (COURTLISTENER_API_TOKEN), sent in the
// Authorization header so it never appears in a URL or a log. Its limits are tight (5 a minute, 50 an hour, 125 a day), so every
// request goes through a rate limiter, and a docket is read newest first only as far back as the last entry already seen.
// Plain code, no AI: what counts as a material docket event is decided by the fixed rules below.
export const BASE = 'https://www.courtlistener.com/api/rest/v4';
export const docketUrl = (id) => `https://www.courtlistener.com/docket/${id}/`;

// At most perMinute requests in any 60 seconds. now and sleep are injectable so the limiter can be tested without waiting.
export function createRateLimiter({ perMinute = 5, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const times = [];
  return async function wait() {
    for (;;) {
      const t = now();
      while (times.length && t - times[0] >= 60000) times.shift();
      if (times.length < perMinute) { times.push(t); return; }
      await sleep(60000 - (t - times[0]) + 50);
    }
  };
}

// http: grabber/lib/http.mjs (retries, request cap, secrets scrubbed). limiter: createRateLimiter().
export function createCourtListener(http, { limiter = async () => {} } = {}) {
  const get = async (url) => { await limiter(); return http.getJson(url); };
  return {
    // Docket entries filed on or after `since` (YYYY-MM-DD) that are not in `seen` (entry ids), oldest first. Pages newest first and
    // stops at the first page that reaches back before `since`, or after maxPages (then `complete` is false and the rest waits).
    async newEntries({ docketId, since, seen = [], pageSize = 20, maxPages = 3 }) {
      const known = new Set(seen.map(Number)), out = [];
      let url = `${BASE}/docket-entries/?docket=${encodeURIComponent(docketId)}&order_by=-date_filed&page_size=${pageSize}`, pages = 0, complete = false;
      while (url && pages < maxPages) {
        const r = await get(url); pages++;
        let older = false;
        for (const x of r.results || []) {
          if (!x.date_filed || x.date_filed < since) { older = true; continue; }
          if (!known.has(Number(x.id))) out.push(x);
        }
        if (older || !r.next) { complete = true; break; }
        url = r.next;
      }
      out.sort((a, b) => a.date_filed.localeCompare(b.date_filed) || (a.entry_number ?? 0) - (b.entry_number ?? 0) || a.id - b.id);
      return { entries: out, pages, complete };
    }
  };
}

// ---------- which docket entries matter ----------
// Routine filings never become events: appearances, transcripts and transcript orders, summons and service, pro hac vice,
// certificates, proposed orders, clerk's notices, referrals to a magistrate, counsel withdrawing or substituting.
const ROUTINE = [
  /^\W*(notice of )?(entry of )?appearance\b/i, /\bnotice of (entry of )?appearance\b/i, /^\W*transcript\b/i, /^\W*(amended )?transcript of proceedings\b/i, /\btranscript order\b/i,
  /\bsummons\b/i, /\bpro hac vice\b/i, /\bapplication for admission\b/i, /^\W*certificate\b/i, /\bcertificate of (service|interested|counsel)\b/i, /^\W*(corporate )?disclosure statement\b/i,
  /^\W*proposed order\b/i, /^\W*clerk'?s notice\b/i, /\border referring motion/i, /\bwithdraw(al)? (as|of) (attorney|counsel)\b/i, /\bmotion to withdraw as attorney\b/i,
  /\bsubstitution of (attorney|counsel)\b/i, /^\W*affidavit\b/i, /\breturn of service\b/i, /^\W*(electronic )?filing error\b/i
];
// Material kinds, in order (the first match wins). news: whether a fixed-wording news item is written for it.
const KINDS = [
  { kind: 'appeal', news: true, label: 'Notice of appeal filed', re: /\bnotice of (interlocutory )?appeal\b/i },
  { kind: 'judgment', news: true, label: 'Judgment entered', re: /^\W*(final |amended |clerk'?s )?judgment\b/i },
  { kind: 'withdrawal', news: false, label: 'Withdrawn', re: /\b(notice of )?(voluntary )?(dismissal|withdrawal of (the )?(motion|complaint|petition))\b|\bwithdraw(s|ing)? (its |the |their )?(motion|complaint|petition)\b|^\W*notice of withdrawal\b/i },
  { kind: 'order', news: true, label: 'Court order', re: /^\W*minute order\b[\s\S]*\b(granted|denied|granting|denying)\b/i }, // a minute order that rules on a motion
  { kind: 'deadline', news: false, label: 'Minute order setting a deadline', re: /^\W*minute (order|entry)\b(?=[\s\S]*\b(due|deadline|shall (file|respond|submit)|set for|reset|by (january|february|march|april|may|june|july|august|september|october|november|december) \d))/i },
  { kind: 'order', news: true, label: 'Court order', re: /^\W*((memorandum|opinion) (and|&) )?order\b|^\W*(stipulated|scheduling|protective) order\b/i },
  { kind: 'closed', news: false, label: 'Case closed', re: /\bcivil case terminated\b|\bcase (closed|terminated)\b/i }
];

// A docket entry -> null (routine, or no docket text) or { kind, news, label, text }. The text is the court's own words, trimmed of
// the clerk's tags ("(rfllc3, COURT STAFF) (Filed on 8/27/2026) (Entered: 08/27/2026)").
export function classifyEntry(x) {
  const raw = String((x && x.description) || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null; // an entry with no docket text (the RSS stub of a fuller entry the same day) is never used
  if (ROUTINE.some((re) => re.test(raw))) return null;
  const k = KINDS.find((c) => c.re.test(raw));
  // A minute order that only sets or moves a conference or hearing time is housekeeping, not a deadline anyone must meet.
  if (k && k.kind === 'deadline' && !FILING_DEADLINE.test(raw)) return null;
  // text: the court's words, trimmed for display; full: the same words untrimmed, for every quote (a quote is never cut).
  return k ? { kind: k.kind, news: k.news, label: k.label, text: trimDescription(raw), full: trimDescription(raw, Infinity) } : null;
}
const FILING_DEADLINE = /\b(due|deadline|shall (file|respond|submit|answer)|response to|reply to|status report)\b/i;
export function trimDescription(t, max = 300) {
  const s = String(t).replace(/\s+/g, ' ').replace(/^\W*\*+\s*/, '')
    .replace(/\s*\((Filed on|Entered:)[^)]*\)/gi, '').replace(/\s*\([a-z0-9]{2,12}, COURT STAFF\)/gi, '').replace(/\s*\(Main Document[^)]*\)/gi, '')
    .replace(/\s*\[Docketed[^\]]*\]/gi, '').replace(/\s*\([a-z]{2,10}\)\s*$/i, '').trim().replace(/[\s.;,]+$/, '');
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s;
}
