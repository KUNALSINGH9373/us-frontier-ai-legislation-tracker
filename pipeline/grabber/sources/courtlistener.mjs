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
// certificates, proposed orders, clerk's notices, referrals to a magistrate, counsel withdrawing or substituting; and the paperwork
// around an appeal or a deadline: transmission of a notice of appeal, the appeals court's case number, the appeal fee, motions for
// an extension of time (to file a notice of appeal or anything else), stipulations to extend time, scheduling orders.
const ROUTINE = [
  /^\W*(notice of )?(entry of )?appearance\b/i, /\bnotice of (entry of )?appearance\b/i, /^\W*transcript\b/i, /^\W*(amended )?transcript of proceedings\b/i, /\btranscript order\b/i,
  /\bsummons\b/i, /\bpro hac vice\b/i, /\bapplication for admission\b/i, /^\W*certificate\b/i, /\bcertificate of (service|interested|counsel)\b/i, /^\W*(corporate )?disclosure statement\b/i,
  /^\W*proposed order\b/i, /^\W*clerk'?s notice\b/i, /\border referring motion/i, /\bwithdraw(al)? (as|of) (attorney|counsel)\b/i, /\bmotion to withdraw as attorney\b/i,
  /\bsubstitution of (attorney|counsel)\b/i, /^\W*affidavit\b/i, /\breturn of service\b/i, /^\W*(electronic )?filing error\b/i,
  /\btransmission of (the )?(amended )?notice of appeal\b/i, /\bUSCA case number\b/i, /^\W*(notice of )?appeal (filing )?fee\b[^.]{0,40}\b(paid|received|due)\b|^\W*(appeal )?filing fee\b[^.]{0,60}\bappeal\b/i,
  /\bmotion\b[^.]{0,60}\b(for|to) (an )?(extension|enlargement) of time\b|\bmotion to (extend|enlarge)\b[^.]{0,40}\b(time|deadline)/i,
  /\bstipulat\w*\b[^.]{0,80}\b(to |and order to |and \[proposed\] order to )?(extend|enlarge|continue)\w*\b[^.]{0,40}\b(time|deadline|date|hearing)/i, /\bscheduling order\b/i,
  // Costs and fees: the clerk's judgment on costs, a bill of costs, the taxation of costs and any appeal of it.
  /^\W*(final |amended |clerk'?s )?judgment\b(\s*\([^)]*\))?\s*(on|for|of|re|taxing)\s+(attorneys?'?s?'? )?(costs|fees)\b/i, /\btaxation of costs\b|\bbill of costs\b/i
];
// A ruling the public cares about: on a dispositive motion, an injunction, a stay of a rule, an order or enforcement (not a stay of
// discovery or of a briefing deadline), summary judgment, dismissal or final relief.
const DISPOSITIVE = String.raw`summary judgment|dismiss\w*|(preliminary |permanent )?injunct\w*|temporary restraining order|\bTRO\b|\bstay(ed|ing|s)? (of )?(the )?(rule|regulation|order|agency action|enforcement|effective date|statute|law|injunction|judgment|proceedings pending appeal)\b|\bstay pending appeal\b|\benforcement\b[^.]{0,80}\bstayed\b|final (relief|judgment)|judgment on the pleadings|remand\w*|vacat\w* (the )?(rule|order|agency action)`;
const RULING_ORDER = new RegExp(String.raw`^\W*((memorandum|opinion) (and|&) )?(minute )?order\b[^.]{0,200}?\b(on|of|granting|denying|re|regarding|resolving)\b[^.]{0,200}?(${DISPOSITIVE})|^\W*minute (order|entry)\b(?=[\s\S]*\b(granted|denied|granting|denying)\b)[\s\S]*(${DISPOSITIVE})`, 'i');
// Material kinds, in order (the first match wins). news: whether a fixed-wording news item is written for it ('ruling': only for an
// order that rules on a dispositive motion, an injunction, a stay, summary judgment, dismissal or final relief; other orders are events
// without news). An ORDER granting a voluntary dismissal is an order (the case is dismissed), not a party's withdrawal.
// "Case dismissed" and "Withdrawn" say the whole case ended, so they need the court's or party's words to say so: never when the entry
// names one party, one claim, count or counterclaim, a part, or a denial (NOT_WHOLE_CASE); such an entry is a plain "Court order" or nothing.
const NOT_WHOLE_CASE = String.raw`^(?![\s\S]*\b(as to|den(y|ies|ied|ying)|counter-?claims?|cross-?claims?|claims?|counts?|defendants?|in part|partial(ly)?|only)\b)`;
const KINDS = [
  { kind: 'appeal', news: true, label: 'Notice of appeal filed', re: /^\W*(amended )?notice of (interlocutory )?appeal\b/i },
  { kind: 'judgment', news: true, label: 'Judgment entered', re: /^\W*(final |amended |clerk'?s )?judgment\b/i },
  { kind: 'order', news: true, label: 'Case dismissed', re: new RegExp(NOT_WHOLE_CASE + String.raw`(^\W*((memorandum|opinion) (and|&) )?(minute )?order\b[^.]{0,120}?\b(granting|approving)\b[^.]{0,80}?\bvoluntary dismissal\b|^\W*order (of )?dismissal( of (the )?(case|action|complaint))?\b|^\W*order dismissing (the )?(case|action|complaint)\b)`, 'i') },
  { kind: 'order', news: 'ruling', label: 'Court order', re: /^\W*minute order\b[\s\S]*\b(granted|denied|granting|denying)\b/i }, // a minute order that rules on a motion
  { kind: 'deadline', news: false, label: 'Minute order setting a deadline', re: /^\W*minute (order|entry)\b(?=[\s\S]*\b(due|deadline|shall (file|respond|submit)|set for|reset|by (january|february|march|april|may|june|july|august|september|october|november|december) \d))/i },
  { kind: 'order', news: 'ruling', label: 'Court order', re: /^\W*((memorandum|opinion) (and|&) )?order\b|^\W*(stipulated|protective) order\b/i },
  { kind: 'withdrawal', news: false, label: 'Withdrawn', re: new RegExp(NOT_WHOLE_CASE + String.raw`(^\W*(notice of )?(voluntary )?(dismissal|withdrawal)\b|^\W*(joint )?stipulat\w*( of| for)? (voluntary )?dismissal\b|^\W*(\S+ ){0,3}withdraw(s|ing)? (its |the |their )?(motion|complaint|petition)\b)`, 'i') }, // a filing that only mentions a dismissal (an opposition, a response) is not one
  { kind: 'closed', news: false, label: 'Case closed', re: /\bcivil case terminated\b|\bcase (closed|terminated)\b/i }
];

// A docket entry -> null (routine, or no docket text) or { kind, news, label, text, full, operative }. text and full are the court's own
// words, trimmed of the clerk's tags ("(rfllc3, COURT STAFF) (Filed on 8/27/2026) (Entered: 08/27/2026)"). operative is a short display
// line: the label and the operative clause, built only from words in the docket text (operativeText).
export function classifyEntry(x) {
  const raw = String((x && x.description) || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null; // an entry with no docket text (the RSS stub of a fuller entry the same day) is never used
  if (ROUTINE.some((re) => re.test(raw))) return null;
  const k = KINDS.find((c) => c.re.test(raw));
  if (!k) return null;
  // A minute order that only sets or moves a conference or hearing time is housekeeping, not a deadline anyone must meet.
  if (k.kind === 'deadline' && !FILING_DEADLINE.test(raw)) return null;
  const news = k.news === 'ruling' ? RULING_ORDER.test(raw) : k.news;
  // text: the court's words, trimmed for display; full: the same words untrimmed, for every quote (a quote is never cut).
  const full = trimDescription(raw, Infinity);
  return { kind: k.kind, news, label: k.label, text: trimDescription(raw), full, operative: operativeText(k, full) };
}

// The display line. A notice of appeal: "Notice of appeal to the 9th Circuit Court of Appeals: appeal of Order on Motion for Summary
// Judgment, ..., Judgment 252", the court and the appealed rulings copied from the docket text (the filers only when three or fewer);
// anything else: the label and the entry's first sentence. Never more than max characters; never a word not in the docket text
// besides the fixed label.
export function operativeText(k, full, max = 240) {
  const cap = (s) => (s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s);
  if (k.kind === 'appeal') {
    const court = /\bnotice of (?:interlocutory )?appeal\s+to\s+(the\s+[^.;,]*?(?:circuit|court of appeals|supreme court)[^.;,]*?)(?=\s+(?:filed by|from|re:?|as to)\b|[.;,(]|$)/i.exec(full);
    const from = /\b(?:appeal of|appeal from|appealing)\s+(.+?)(?=\s*\((?:appeal fee|fee)\b|\s*\([A-Z][a-z]+, [A-Z]|$)/i.exec(full);
    const by = /\bfiled by\s+(.+?)(?=\.\s+(?:appeal|\()|\s+appeal (?:of|from)\b|\s*\(|$)/i.exec(full), filers = by ? by[1].split(/,\s*(?![Jj]r\b)/) : [];
    return cap(`Notice of appeal${court ? ' to ' + court[1] : ''}${from ? ': appeal of ' + from[1].replace(/[\s.;,]+$/, '') : ''}${by && filers.length <= 3 ? `, filed by ${by[1].replace(/[\s.;,]+$/, '')}` : ''}`);
  }
  // The first sentence; when it is only a heading ("ORDER.", "JUDGMENT."), the next one too.
  const sentences = full.match(/.+?(?:(?<!\b(?:No|Nos|Dkt|ECF|Fed|R|Civ|P|U\.S|Inc|Corp|Co|Jr|Mr|Ms|Dr|v|Rep|Sen|[A-Z]))\.(?=\s+[A-Z("“]|$)|$)/g) || [full];
  const first = (/^[A-Z][A-Z\s&]{0,30}\.$/.test(sentences[0].trim()) && sentences[1] ? sentences[0] + sentences[1] : sentences[0]).trim().replace(/[\s.;,]+$/, '');
  return cap(`${k.label}: ${first}`);
}
const FILING_DEADLINE = /\b(due|deadline|shall (file|respond|submit|answer)|response to|reply to|status report)\b/i;
export function trimDescription(t, max = 300) {
  const s = String(t).replace(/\s+/g, ' ').replace(/^\W*\*+\s*/, '')
    .replace(/\s*\((Filed on|Entered:)[^)]*\)/gi, '').replace(/\s*\([a-z0-9]{2,12}, COURT STAFF\)/gi, '').replace(/\s*\(Main Document[^)]*\)/gi, '')
    .replace(/\s*\[Docketed[^\]]*\]/gi, '').replace(/\s*\([a-z]{2,10}\)\s*$/i, '').trim().replace(/[\s.;,]+$/, '');
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s;
}
