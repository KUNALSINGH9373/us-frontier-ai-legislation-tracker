// Which entries the self-correction step re-reads this run, in order. Pure: candidates and the saved state in, a list out.
//   1. text_changed  the bill's text is not the one the entry was last checked against (hash compare)
//   2. retry         the last check proposed a fix that did not survive, or failed; tried again, up to max_retries times
//   3. never_checked not checked yet; entries with an empty reading field first (a field left empty when it was published)
//   4. rolling       the entry checked longest ago, once it is older than recheck_after_days
// The rest wait for a later run. Entries without a readable text are never candidates (the caller records why).
import { fieldsFor } from './review.mjs';

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);

// candidates: [{ key, entry, sha }] for every entry whose text was read this run. state: state/corrections.json "items".
export function pickEntries({ candidates, state = {}, today, max = 3, recheckDays = 30, maxRetries = 3 }) {
  const ranked = [];
  for (const c of candidates) {
    const s = state[c.key];
    const empty = fieldsFor(c.entry).some((f) => c.entry[f] == null || c.entry[f] === '');
    let rank, why;
    if (!s) { rank = empty ? 2 : 3; why = empty ? 'never checked; has an empty field' : 'never checked'; }
    else if (s.text_sha && s.text_sha !== c.sha) { rank = 0; why = 'the bill text changed'; }
    else if (s.retry && (s.retries || 0) < maxRetries) { rank = 1; why = `retry ${(s.retries || 0) + 1} of ${maxRetries} (${s.outcome})`; }
    else if (daysBetween(s.checked_at, today) >= recheckDays) { rank = 4; why = `last checked ${s.checked_at}`; }
    else continue;
    ranked.push({ ...c, rank, why, since: s ? s.checked_at : c.entry.last_checked || '0000-00-00' });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
  return { picked: ranked.slice(0, max), waiting: ranked.length - Math.min(max, ranked.length) };
}

// The state after one entry's check. A text-changed or new entry starts with no retries; a failed check keeps counting.
export function nextState(prev, { sha, url, today, outcome, reason }) {
  const retry = outcome === 'rejected' || outcome === 'error';
  const sameText = prev && prev.text_sha === sha;
  return { text_sha: sha, text_url: url, checked_at: today, outcome, retry, retries: retry ? (sameText && prev.retry ? (prev.retries || 0) + 1 : 1) : 0, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) };
}
