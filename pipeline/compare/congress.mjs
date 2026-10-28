// The comparison step: plain code, no AI. For each item the Grabber collected, decide whether the tracker
// needs to change, so the Generator (the only step that costs money) runs only on real differences.
//
//   new_entry_candidate  a bill we do not track yet that passed the title screen
//   material             a new action, a status change, or a different sponsor
//   minor                the record changed or the title was reworded, but nothing the tracker states is wrong
//   unchanged            nothing to do
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep)[a-z]*\.?\s+(\d{1,2})\b(?:\s*[–-]\s*(\d{1,2}))?(?:,?\s*(20\d\d))?|\b(Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b(?:\s*[–-]\s*(\d{1,2}))?(?:,?\s*(20\d\d))?/g;
const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Every date the entry's own text and events already mention, as YYYY-MM-DD. A date written without a year takes
// the year of the closest year written before it in the same text, else the year given as the default.
export function datesMentioned(text, events = [], defaultYear) {
  const known = new Set(events.map((e) => e.date));
  let year = defaultYear, m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(text || ''))) {
    const mon = (m[1] || m[5]).slice(0, 3).toLowerCase(), d1 = +(m[2] || m[6]), d2 = m[3] || m[7], y = m[4] || m[8];
    if (y) year = +y;
    for (let d = d1; d <= (d2 ? +d2 : d1); d++) known.add(iso(year, MONTHS[mon], d));
  }
  return known;
}

export const surname = (fullName) => (fullName || '').replace(/^(Rep\.|Sen\.|Del\.|Resident Commissioner)\s*/, '').split(',')[0].trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const words = (s) => new Set((norm(s).match(/[a-z]{4,}/g) || []));

// A Congress.gov action -> { kind, type, milestone, importance }. type is the tracker's event type (null for a procedural step);
// milestone: whether the action belongs in status_text and news; importance orders actions on the same date (highest first).
// Milestones: introduced, referred, hearing held, markup, reported / ordered reported, forwarded by a subcommittee, passage of a
// chamber, a failed passage vote, vetoed, veto override, signed / became law. Everything else is procedural: cloture, amendments,
// motions to proceed / reconsider / table / recommit, held at the desk, messages between chambers, calendars, introductory remarks,
// star prints, cosponsors, presentation to the President. "Not agreed to" and "failed" never mean passage.
// Checked against every action text in the stored Congress.gov records (compare/test.mjs). Order matters: the first rule that fits wins.
const PROCEDURAL = { kind: 'procedural', type: null, milestone: false, importance: 0 };
const ACTION_RULES = [
  [/became public law|signed by (the )?president/i, 'enacted', 'Signed / enacted', 100],
  // A veto override vote (the passage "over veto", or "the objections of the President to the contrary notwithstanding").
  [/^(?!.*\b(failed|not agreed to|not sustained)\b).*(\bover (the )?(president'?s )?veto\b|\bveto overrid|objections of the president[^.]*notwithstanding)/i, 'veto_override', 'Passed / advanced', 95],
  [/^(?!.*\bveto message\b)(?!.*\bover (the )?veto\b).*\b(pocket )?vetoed\b/i, 'vetoed', 'Vetoed / failed / rescinded', 90],
  // A failed vote on the bill itself, or a failed override (the veto stands). Not a failed cloture, amendment or motion.
  [/^(?!.*\b(cloture|motion to (proceed|reconsider|table|recommit|instruct|discharge|concur)|amendment (SA|S\.? ?Amdt|H\.? ?Amdt|No\.)|amdt\.)).*(\b(on |failed of )passage\b|suspend the rules and pass|over (the )?veto|objections of the president|veto overrid)[^.]*\b(failed|not agreed to|not sustained)\b|^\W*failed of passage\b/i, 'failed_passage', 'Vetoed / failed / rescinded', 70]
];
const PROCEDURAL_RE = /\bnot agreed to\b|\bfailed\b|\bcloture\b|\bmotion to (proceed|reconsider|table|recommit|instruct|discharge|concur)\b|\blaid on the table\b|\btabled\b|^\W*(S\.?|H\.?) ?Amdt\.?|\bamendment (SA|S\.? ?Amdt|H\.? ?Amdt|No\.)\s*\d|^\W*amendment\b|\bon agreeing to the [^.]*\bamendments?\b|\bheld at the desk\b|\bmessage on (senate|house) action\b|\bintroductory remarks\b|\bstar print\b|\bcosponsor|\bplaced on (the )?(senate legislative|union|house) calendar\b|\breceived in the (house|senate)\b|\blaid before (the )?(senate|house)\b|\bpresented to (the )?president\b|\bcleared for (the )?white house\b|\bsubstitute withdrawn\b|\bdischarged\b/i;
const MILESTONE_RULES = [
  [/\bpassed (the )?(house|senate)\b|\bpassed\/agreed to in (house|senate)\b|\bon passage\b[^.]*\b(passed|agreed to)\b|suspend the rules and pass[^.]*\bagreed to\b|\b(considered,? and )?agreed to (without amendment|with (an )?amendments?|by (unanimous consent|voice vote|yea-nay vote|recorded vote|the yeas and nays))|\bresolution agreed to\b|\bagree to the (senate|house) amendments?\b[^.]*\bagreed to\b/i, 'passed', 'Passed / advanced', 80],
  [/\bordered to be reported\b|\breported (\(amended\) )?(by|with|favorabl|without)\b/i, 'reported', 'Passed / advanced', 60],
  [/\bmark-?up session held\b|\bmarkup\b/i, 'markup', 'Referred / stalled / hearing', 50],
  [/\bforwarded by subcommittee\b/i, 'forwarded', 'Passed / advanced', 45],
  [/\bhearings? held\b/i, 'hearing', 'Referred / stalled / hearing', 40],
  [/^\W*introduced in (the )?(house|senate)\b|^\W*submitted in (the )?(house|senate)\W*$/i, 'introduced', 'Introduced / published', 30],
  [/\breferred to\b/i, 'referred', 'Referred / stalled / hearing', 20]
];
export function actionKind(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  for (const [re, kind, type, importance] of ACTION_RULES) if (re.test(t)) return { kind, type, milestone: true, importance };
  if (PROCEDURAL_RE.test(t)) return { ...PROCEDURAL };
  for (const [re, kind, type, importance] of MILESTONE_RULES) if (re.test(t)) return { kind, type, milestone: true, importance };
  return { ...PROCEDURAL };
}

// What the API's latest action means for the tracker's status. Federal bills stay "pending" until they become law.
export function statusFromAction(text) {
  const k = actionKind(text).kind;
  return k === 'enacted' ? 'enacted' : k === 'vetoed' ? 'failed' : 'pending';
}

// Cosponsor totals are a record fact (bill.cosponsors.count: current cosponsors, withdrawn ones not counted). An entry states its
// total in a structured field (record_facts.cosponsors) or in the fixed-wording end of its sponsor text, "...; 11 cosponsors in all
// (Congress.gov)". Hand-written wording ("twelve as of Oct 27") is never parsed: such an entry has no known total here.
export const COSPONSOR_SUFFIX = /;\s*(\d+)\s+cosponsors?(?:\s+in\s+all)?\s*\(Congress\.gov\)\s*$/;
export const cosponsorSuffix = (n) => `; ${n} cosponsor${n === 1 ? '' : 's'} in all (Congress.gov)`;
export function knownCosponsors(entry) {
  const f = entry && entry.record_facts && entry.record_facts.cosponsors;
  if (f && Number.isInteger(f.count)) return f.count;
  const m = COSPONSOR_SUFFIX.exec((entry && entry.sponsor_text) || '');
  return m ? Number(m[1]) : null;
}

export function compareCongress({ item, raw, entry, billsOfEntry = 1 }) {
  const bill = raw.bill || {}, reasons = [], minor = [];
  if (!entry) {
    return { item_id: item.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: `New bill "${bill.title}" (introduced ${bill.introducedDate || 'unknown'}) matches the title screen and is not in the tracker.` }] };
  }
  const baseline = entry.last_checked; // the date the tracker last verified this entry
  const known = datesMentioned(entry.status_text, entry.events, +baseline.slice(0, 4));
  // An entry that covers a House and a Senate bill (or more): one bill's veto or sponsor does not decide the entry.
  const multi = Math.max(billsOfEntry, ((entry.identifiers && entry.identifiers.external && entry.identifiers.external.congress_gov) || []).length) > 1;

  // Only a milestone (actionKind) is material. A procedural step (cloture, an amendment, a motion, held at the desk, a message between
  // chambers) is noted as minor, so it never becomes a status line or a news item. Same date: the most important action first.
  (raw.actions || []).filter((a) => a.actionDate > baseline && !known.has(a.actionDate))
    .sort((a, b) => a.actionDate.localeCompare(b.actionDate) || actionKind(b.text).importance - actionKind(a.text).importance)
    .forEach((a) => {
      const k = actionKind(a.text);
      if (!k.milestone) minor.push({ kind: 'record_updated', detail: `${a.actionDate}: procedural step, not a milestone: ${a.text}` });
      else if (k.kind === 'vetoed' && multi) minor.push({ kind: 'companion_status', detail: `${a.actionDate}: ${a.text} (one of the bills in this entry)`, api_value: a.text, our_value: entry.status_text || '' });
      else reasons.push({ kind: 'new_action', detail: `${a.actionDate}: ${a.text}`, api_value: a.text, our_value: entry.status_text || '' });
    });

  // Became law: one enacted bill is enough. Vetoed: only when the entry is this one bill, and not while an override vote on or after
  // the veto has passed (the other chamber may still vote).
  const la = bill.latestAction, apiStatus = statusFromAction(la && la.text), vetoDate = (la && la.actionDate) || '';
  const overridden = (raw.actions || []).some((a) => actionKind(a.text).kind === 'veto_override' && (a.actionDate || '') >= vetoDate);
  if (apiStatus === 'enacted' && entry.status !== 'enacted') reasons.push({ kind: 'status_change', detail: `Latest action implies "${apiStatus}", the tracker says "${entry.status}".`, api_value: apiStatus, our_value: entry.status });
  if (apiStatus === 'failed' && entry.status !== 'failed' && !overridden) {
    (multi ? minor : reasons).push({ kind: multi ? 'companion_status' : 'status_change', detail: `Latest action implies "${apiStatus}"${multi ? ' for one of the bills in this entry' : ''}, the tracker says "${entry.status}".`, api_value: apiStatus, our_value: entry.status });
  }

  // An entry that covers a House and a Senate bill often names only one sponsor and says "House companion":
  // an unnamed companion sponsor is worth a note, but it does not mean the tracker is wrong.
  const primary = (bill.sponsors || [])[0];
  if (primary && entry.sponsor_text && !norm(entry.sponsor_text).includes(surname(primary.fullName))) {
    (multi ? minor : reasons).push({ kind: 'sponsor_change', detail: `Sponsor on Congress.gov is ${primary.fullName}, not named in the tracker.`, api_value: primary.fullName, our_value: entry.sponsor_text });
  }

  // A changed cosponsor total, on an entry that covers this one bill and states a total the code can read (else totals would mix).
  const count = bill.cosponsors && bill.cosponsors.count, stated = knownCosponsors(entry);
  if (!multi && Number.isInteger(count) && stated !== null && count !== stated) reasons.push({ kind: 'cosponsors_change', detail: `Congress.gov lists ${count} current cosponsor${count === 1 ? '' : 's'}; the tracker says ${stated}.`, api_value: String(count), our_value: String(stated) });

  if (reasons.length) return { item_id: item.item_id, entry_key: entry.key, verdict: 'material', reasons };

  const updated = (bill.updateDate || '').slice(0, 10);
  if (updated && updated > baseline) minor.push({ kind: 'record_updated', detail: `Congress.gov record updated ${updated}; no new action.` });
  const a = words(bill.title), b = words(entry.title + ' ' + entry.short_name);
  if (a.size && [...a].filter((w) => b.has(w)).length / a.size < 0.5) minor.push({ kind: 'title_change', detail: `Title now reads "${bill.title}".`, api_value: bill.title, our_value: entry.short_name });
  return { item_id: item.item_id, entry_key: entry.key, verdict: minor.length ? 'minor' : 'unchanged', reasons: minor };
}
