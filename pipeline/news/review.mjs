// Independent review of every automated news item before it is first published (26 Nov 2026, after a CRS copyright report was published
// as the TRUMP AMERICA draft's card, with a "What the bill would do" line that was a status remark: no second reader saw it).
//
// A reader (role "validator", a different call from whatever wrote the card) is shown the official record as the source gave it (its own
// title, number, date and facts), the tracker entry it is filed under, and the exact item the page would show. It answers two questions:
//   about_entry  is this official record about this tracked measure (not merely mentioning it)?
//   faithful     is every statement in the item supported by the record and the entry, with nothing added or overstated?
// Only both true, with no problems listed, is "passed". The verdict is stored on the event with a hash of the exact item reviewed: a later
// change to the item (new facts, a new card) needs a new review. No AI available (no key, monthly limit, error) means no verdict, and an
// item without a passing verdict is never added to the page (renderNews requireReview; checkNewsEvents refuses it as a stop rule).
// Never throws.
import crypto from 'crypto';

export const REVIEW_SYSTEM = `You check one short news item before it is published on a tracker of US frontier-AI legislation. You are given the official record the item was made from, the tracked measure it is filed under, and the item. Be strict: answer only from what is given.
1. about_entry: true only if the official record is itself about the tracked measure (it is that measure's own action, document, hearing, report or case). A record that only mentions the measure, discusses a different subject, or is about another measure is false.
2. faithful: true only if every statement in the item's title and body is supported by the official record or the tracked measure's description, with no number, date, name, stage or claim added or overstated, and the item reads correctly (a status remark is not "what the bill would do"; a report's own number is not a bill number).
List every problem you find in "problems" (empty only when both answers are true).`;

const SCHEMA = { type: 'OBJECT', required: ['about_entry', 'faithful', 'problems'], properties: { about_entry: { type: 'BOOLEAN' }, faithful: { type: 'BOOLEAN' }, problems: { type: 'ARRAY', items: { type: 'STRING' } } } };

// What the page would show, without the fields that change on every render (the verification time).
export const itemHash = (item) => crypto.createHash('sha256').update(JSON.stringify({ date: item.date, title: item.title, body: item.body, tracker: item.tracker, links: item.links, status: item.status })).digest('hex').slice(0, 16);

export function reviewPrompt(ev, entry, item) {
  const off = (ev.sources || []).find((s) => s.role === 'official') || {};
  return [
    'OFFICIAL RECORD',
    `source: ${off.source || '?'}; url: ${off.url || '?'}`,
    `record title: ${off.title || (ev.facts && ev.facts.title) || '(none)'}`,
    `event: ${ev.class} on ${ev.date}`,
    `facts: ${JSON.stringify(ev.facts || {})}`,
    '',
    'TRACKED MEASURE',
    `title: ${entry.title}`,
    `short name: ${entry.short_name || ''}`,
    `status: ${entry.status}; ${entry.status_text || ''}`,
    `what it does: ${entry.summary_line || entry.mechanism || ''}`,
    '',
    'ITEM TO PUBLISH',
    `title: ${item.title}`,
    `body: ${item.body}`
  ].join('\n');
}

// state: news events; entries; items: [{ key, item }] the render would add; factory: llm/make.mjs. Returns counts; verdicts are written
// onto state.events[key].review. A verdict already given for the same item text is kept (no second call).
export async function reviewItems({ state, entries, items, factory, max = 10, log = () => {} }) {
  const out = { passed: 0, refused: 0, unreviewed: 0, kept: 0, why_unreviewed: null };
  let reader = null;
  try { reader = factory ? factory.make('validator') : null; } catch (e) { out.why_unreviewed = String(e && e.message || e).slice(0, 200); }
  if (!reader && !out.why_unreviewed) out.why_unreviewed = 'no AI reader available';
  const byKey = new Map(entries.map((e) => [e.key, e]));
  let asked = 0;
  for (const { key, item } of items) {
    const ev = state.events[key], entry = ev && byKey.get(ev.entry_id);
    if (!ev || !entry) continue;
    const h = itemHash(item);
    if (ev.review && ev.review.item_hash === h) { out.kept++; out[ev.review.verdict === 'passed' ? 'passed' : 'refused']++; continue; }
    if (!reader || asked >= max) { out.unreviewed++; continue; }
    asked++;
    try {
      const r = await reader.generate({ system: REVIEW_SYSTEM, prompt: reviewPrompt(ev, entry, item), itemId: `news-review:${key}`, responseSchema: SCHEMA });
      const v = (r && r.data) || {};
      const problems = Array.isArray(v.problems) ? v.problems.map(String) : ['the reader gave no problems list'];
      const pass = v.about_entry === true && v.faithful === true && problems.length === 0;
      ev.review = { verdict: pass ? 'passed' : 'refused', item_hash: h, about_entry: v.about_entry === true, faithful: v.faithful === true, problems: problems.slice(0, 5), at: new Date().toISOString() };
      out[pass ? 'passed' : 'refused']++;
      if (!pass) log(`news review refused ${key}: ${problems.join('; ') || 'not confirmed'}`);
    } catch (e) {
      out.unreviewed++; out.why_unreviewed = String(e && e.message || e).slice(0, 200); // no verdict: the item waits for a later run
    }
  }
  return out;
}

// The verdict that lets an item be added: a passing review of exactly this item.
export const reviewedOk = (ev, item) => !!(ev && ev.review && ev.review.verdict === 'passed' && ev.review.item_hash === itemHash(item));
