// The AI check on a statement before it shows on an event (decided 29 Oct 2026 after review round 6: a headline can always be worded
// so that code keywords misread it, "Senate advances AI bill as governor weighs veto"). news/attach.mjs proposes an attachment by code;
// it stands only when the AI, reading the headline, agrees and code then confirms the AI's answer:
//   - the AI says the headline reports this event as having happened (not expected, not negated, not another step or bill)
//   - the class it names is the event's class
//   - its quote is the headline's own words (verbatim) and carries that class's keyword (KEYWORDS)
// Both must hold: a wrong attachment needs the code rule and the AI to be wrong the same way. Without AI (no key, AI off, a failed
// call, an unreadable answer) nothing attaches: the statement stays on the entry's timeline list, as a lead.
import { KEYWORDS, compatibleClasses, numberConflict, wordsAgree } from './attach.mjs';

const PLAIN = {
  'introduction': 'the bill was introduced', 'hearing-held': 'a committee held a hearing on the bill', 'committee-passage': 'a committee passed or approved the bill',
  'passage': 'a chamber of the legislature passed the bill', 'concurrence': 'a chamber agreed to the other chamber\'s amendments',
  'executive-signature': 'the governor or president signed the bill', 'became-law': 'the bill became law', 'executive-veto': 'the governor or president vetoed the bill',
  'veto-override-passage': 'the legislature overrode a veto of the bill', 'executive-order': 'the president signed an executive order',
  'agency-rule-final': 'an agency issued a final rule', 'agency-rule-proposed': 'an agency proposed a rule',
};
export const CHECK_CLASSES = Object.keys(PLAIN);

export const STATEMENT_CHECK_SYSTEM = `You check whether a press-release headline reports one specific official event that already happened.
Answer about the headline only, read literally. Do not guess from what usually happens.
- "reports": "yes" only if the headline states, as done, the event described. "no" if it is about something else, only mentions it in passing, says it is expected, planned, possible, being weighed, awaited or scheduled, says it did not happen or was undone, asks a question, or reports a different step (another reading, a vote on an amendment, a different bill).
- "event_class": the one class from the list that the headline itself reports as done, or "none".
- "quote": the shortest exact words copied from the headline that state the event (verbatim, same spelling), or "" if none.
Return JSON only: {"reports":"yes"|"no","event_class":"<class>"|"none","quote":"<words>","why":"<a few words>"}`;

export function statementPrompt(title, event) {
  const f = event.facts || {};
  return [`Headline: ${title}`, '', `Official event: ${PLAIN[event.class] || event.class}`, `Class: ${event.class}`, f.number ? `Bill: ${f.number}` : '', f.chamber ? `Chamber: ${f.chamber}` : '', `Date: ${event.date}`, '',
    'Classes: ' + CHECK_CLASSES.join(', ')].filter((x) => x !== '').join('\n');
}

const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
// code's check of the AI's answer. -> { ok, why }
// The answer shape the prompt asks for (llm/schema.mjs); acceptAnswer still checks every value in code.
const STATEMENT_SCHEMA = { type: 'OBJECT', required: ['reports', 'event_class', 'quote', 'why'], properties: { reports: { type: 'STRING', enum: ['yes', 'no'] }, event_class: { type: 'STRING' }, quote: { type: 'STRING' }, why: { type: 'STRING' } } };

export function acceptAnswer(answer, title, event) {
  const a = answer || {};
  if (a.reports !== 'yes') return { ok: false, why: `AI: does not report it (${String(a.why || '').slice(0, 80)})` };
  if (a.event_class !== event.class) return { ok: false, why: `AI names ${a.event_class}, the event is ${event.class}` };
  const q = norm(a.quote);
  if (q.length < 3 || !norm(title).includes(q)) return { ok: false, why: 'AI quote is not the headline\'s own words' };
  const kw = KEYWORDS.filter(([, cls]) => cls.includes(event.class)).map(([re]) => re);
  if (!kw.some((re) => re.test(q))) return { ok: false, why: 'AI quote has no word for this event' };
  // the quote passes the same code rules as a whole headline: no negation, prediction, other step ("weighs veto" is no veto)
  // and the whole headline does too, so a fragment cannot be cherry-picked from a headline about another event (review r7 #1)
  if (!compatibleClasses(title).has(event.class)) return { ok: false, why: 'the headline does not pass the code rules for this event' };
  // and the bill-number and chamber rules attach.mjs applied before asking, again: the answer never stands on one layer alone (local AI test)
  if (numberConflict(title, event.facts && event.facts.number) || !wordsAgree(title, event)) return { ok: false, why: 'the headline names another bill or chamber' };
  if (!compatibleClasses(a.quote, { quote: true }).has(event.class)) return { ok: false, why: 'AI quote does not pass the code rules for this event' };
  return { ok: true, why: null };
}

// llm: an AI client (generate({ system, prompt, itemId }) -> { data }) or null. Returns verify(title, event) -> Promise<{ ok, why }>.
export function makeStatementVerifier(llm, { log = () => {} } = {}) {
  return async (title, event) => {
    if (!llm) return { ok: false, why: 'no AI check available: not attached' };
    if (!CHECK_CLASSES.includes(event.class)) return { ok: false, why: `no AI check for class ${event.class}` };
    try {
      const r = await llm.generate({ system: STATEMENT_CHECK_SYSTEM, prompt: statementPrompt(title, event), itemId: `statement:${event.key || ''}`, responseSchema: STATEMENT_SCHEMA });
      return acceptAnswer(r && r.data, title, event);
    } catch (e) { log(`statement check failed, not attached: ${String((e && e.message) || e).slice(0, 120)}`); return { ok: false, why: 'AI check failed: not attached' }; }
  };
}

// att: news/attach.mjs attachStatements's result; before: the events it was given (by key). Every statement it attached is checked;
// one that fails comes off the event and goes to the timeline list with the reason. Returns att, changed in place.
// memo: state.statement_checks (url|event key -> { ok, why, at }), kept across runs. A statement once refused for an event is never asked
// again, so a later random "yes" cannot attach it (review r8 #8b); an accepted one is not asked again either.
export async function checkAttachments(att, before, verify, memo = null) {
  for (const e of att.events) {
    const old = before[e.key];
    const added = e.sources.slice(old ? old.sources.length : 0).filter((s) => s.role === 'statement');
    for (const s of added) {
      const mk = `${s.url}|${e.key}|${s.title}`; // an edited headline is checked again (review r10 #8)
      let v = memo && memo[mk] ? memo[mk] : null;
      if (!v) {
        v = verify ? await verify(s.title, e) : { ok: false, why: 'no AI check available: not attached' };
        // only an answer is remembered: no AI, or a failed call, is asked again next run
        if (memo && verify && !/^(no AI check available|AI check failed)/.test(v.why || '')) memo[mk] = { ok: v.ok, why: v.why, at: new Date().toISOString().slice(0, 10) };
      }
      if (v.ok) { s.checked = 'ai+code'; continue; }
      e.sources = e.sources.filter((x) => x !== s);
      att.timeline.push({ entry_id: e.entry_id, item: { date: e.date, source: s.source, source_id: s.source_id, url: s.url, title: s.title, entry_id: e.entry_id, facts: { role: 'statement', publisher: s.publisher }, hash: s.hash }, held: v.why });
    }
  }
  return att;
}
