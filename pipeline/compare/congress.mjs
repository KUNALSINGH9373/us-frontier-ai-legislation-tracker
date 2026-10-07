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

// What the API's latest action means for the tracker's status. Federal bills stay "pending" until they become law.
export function statusFromAction(text) {
  if (/became public law|signed by president/i.test(text || '')) return 'enacted';
  if (/vetoed|pocket vetoed/i.test(text || '')) return 'failed';
  return 'pending';
}

export function compareCongress({ item, raw, entry }) {
  const bill = raw.bill || {}, reasons = [];
  if (!entry) {
    return { item_id: item.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: `New bill "${bill.title}" (introduced ${bill.introducedDate || 'unknown'}) matches the title screen and is not in the tracker.` }] };
  }
  const baseline = entry.last_checked; // the date the tracker last verified this entry
  const known = datesMentioned(entry.status_text, entry.events, +baseline.slice(0, 4));

  (raw.actions || []).filter((a) => a.actionDate > baseline && !known.has(a.actionDate))
    .sort((a, b) => a.actionDate.localeCompare(b.actionDate))
    .forEach((a) => reasons.push({ kind: 'new_action', detail: `${a.actionDate}: ${a.text}`, api_value: a.text, our_value: entry.status_text || '' }));

  const apiStatus = statusFromAction(bill.latestAction && bill.latestAction.text);
  if (apiStatus !== 'pending' && apiStatus !== entry.status) reasons.push({ kind: 'status_change', detail: `Latest action implies "${apiStatus}", the tracker says "${entry.status}".`, api_value: apiStatus, our_value: entry.status });

  // An entry that covers a House and a Senate bill often names only one sponsor and says "House companion":
  // an unnamed companion sponsor is worth a note, but it does not mean the tracker is wrong.
  const minor = [];
  const multi = ((entry.identifiers && entry.identifiers.external && entry.identifiers.external.congress_gov) || []).length > 1;
  const primary = (bill.sponsors || [])[0];
  if (primary && entry.sponsor_text && !norm(entry.sponsor_text).includes(surname(primary.fullName))) {
    (multi ? minor : reasons).push({ kind: 'sponsor_change', detail: `Sponsor on Congress.gov is ${primary.fullName}, not named in the tracker.`, api_value: primary.fullName, our_value: entry.sponsor_text });
  }

  if (reasons.length) return { item_id: item.item_id, entry_key: entry.key, verdict: 'material', reasons };

  const updated = (bill.updateDate || '').slice(0, 10);
  if (updated && updated > baseline) minor.push({ kind: 'record_updated', detail: `Congress.gov record updated ${updated}; no new action.` });
  const a = words(bill.title), b = words(entry.title + ' ' + entry.short_name);
  if (a.size && [...a].filter((w) => b.has(w)).length / a.size < 0.5) minor.push({ kind: 'title_change', detail: `Title now reads "${bill.title}".`, api_value: bill.title, our_value: entry.short_name });
  return { item_id: item.item_id, entry_key: entry.key, verdict: minor.length ? 'minor' : 'unchanged', reasons: minor };
}
