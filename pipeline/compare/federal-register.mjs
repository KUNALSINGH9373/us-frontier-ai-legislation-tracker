// Comparison rules for Federal Register documents (executive orders, rules, notices). Plain code, no AI.
//   no matching entry          -> new_entry_candidate
//   the tracked order itself   -> unchanged (it is already in the tracker)
//   a later document that names a tracked entry (an amendment, a revocation, a follow-up rule) -> material
import { datesMentioned } from './congress.mjs';
import { watchPhrases } from '../grabber/sources/federal-register.mjs';

const CHANGE_WORDS = /\b(revok\w*|rescind\w*|repeal\w*|supersed\w*|amend\w*|terminat\w*|withdraw\w*)\b/i;

export function compareFederalRegister({ item, raw, entry }) {
  const doc = raw.document || {};
  const label = `${doc.type} "${doc.title}"${doc.executive_order_number ? ` (EO ${doc.executive_order_number})` : ''}, published ${doc.publication_date}`;
  if (!entry) {
    return { item_id: item.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: `New ${label}, matches the screen and is not in the tracker.` }] };
  }
  const baseline = entry.last_checked;
  const w = watchPhrases(entry);
  const isSelf = !!doc.executive_order_number && w.eo.has(String(doc.executive_order_number));
  // For the order itself, the date the tracker records is the signing date; publication in the Federal Register comes days later.
  const selfDates = [doc.signing_date || doc.publication_date];
  const known = datesMentioned(entry.status_text, entry.events, +baseline.slice(0, 4));

  if (isSelf && selfDates.every((d) => d <= baseline || known.has(d))) return { item_id: item.item_id, entry_key: entry.key, verdict: 'unchanged', reasons: [] };

  const reasons = [];
  if (doc.publication_date > baseline && !known.has(doc.publication_date)) {
    reasons.push({ kind: 'new_action', detail: label, api_value: doc.title, our_value: entry.status_text || '' });
    const head = `${doc.title} ${doc.abstract || ''} ${(raw.text || '').slice(0, 4000)}`;
    if (!isSelf && CHANGE_WORDS.test(head)) reasons.push({ kind: 'status_change', detail: `The document uses revoke/amend/rescind wording about a tracked item, so it may change this entry's status.`, api_value: (head.match(CHANGE_WORDS) || [])[0] });
  }
  return { item_id: item.item_id, entry_key: entry.key, verdict: reasons.length ? 'material' : 'unchanged', reasons };
}
