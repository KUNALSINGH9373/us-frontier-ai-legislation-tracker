// The AI intent check: from a bill's title alone, could it be in the tracker's scope? Used by the Grabbers to decide
// which bills are worth fetching. It never decides what is published (the agents' scope step reads the bill itself).
//
// Built so it cannot make us MISS a bill: "maybe" is fetched like "yes", only a confident "no" is dropped,
// a title the model leaves out counts as "maybe", and if the model call fails every title counts as "maybe".
import { SCOPE_DEFINITION } from '../agents/prompts.mjs';

// v2 (13 Oct 2026): v1 said "no" to military / defense AI and to an AI board of investigations, all three on the site. The "no" list is now
// only topics that are clearly outside the tracker; every other AI title is at least "maybe".
export const INTENT_PROMPT_VERSION = 'intent-v2';

export const INTENT_SYSTEM = `You screen US bill titles for a tracker of frontier-AI law. ${SCOPE_DEFINITION}
The tracker also covers adjacent federal and state bills on AI security, AI oversight or investigation boards, AI reliability and testing, military and defense AI, AI whistleblowers, AI incidents, rogue or self-improving AI, and AI chips.

For each title answer:
- "yes": the title shows it is about frontier / large AI developers or models, AI safety, security or catastrophic risk, AI audits or independent verification of AI, AI incident reporting, AI oversight or investigation, compute thresholds, preemption or moratoriums on state AI laws, or AI chips and their export.
- "maybe": it could contain such provisions. Use "maybe" for every AI title that is not clearly in the "no" list, and for any title that is vague or generic (e.g. "An act to amend the code", "Relating to commerce", omnibus, budget, economic development, technology, innovation, national security, threats, consumer protection, online safety). A vague title may well hide AI provisions.
- "no": ONLY when the title clearly shows one of these and nothing broader: deepfakes or synthetic media; AI in elections or political ads; AI in hiring or employment decisions; chatbots or companions for minors, or children's online safety; AI in health care, insurance, housing, lending or education decisions; AI literacy or workforce training; AI grants or funds; data centers and energy; or a topic with no connection to AI or computing at all (farming, water, plastics, taxes on goods, ...).

Missing a bill the tracker should cover is much worse than flagging one it should not. If a title is not plainly in the "no" list, it is "maybe" or "yes".
Return JSON only: {"results":[{"id":"<id>","verdict":"yes"|"maybe"|"no","reason":"<a few words>"}]} with one result per title, ids exactly as given.`;

// A title that names no subject (budget, omnibus, "An act to amend the code", Illinois "SCH CD-...") can hide frontier provisions:
// a model "no" on such a title is overruled to "maybe". In the 13 Oct 2026 dry run the model said "no" to 53 such titles,
// among them Tennessee's "AN ACT to amend Tennessee Code Annotated, Title 49, relative to artificial intelligence".
export const GENERIC_TITLE = /\bbudget\b|appropriations? (act|bill)|\bappropriations? for\b|\bomnibus\b|major components of legislation|implement(s|ing)? the (state )?budget|economic development|general government|government finance|state government operations|revenue (act|measure)|^an act to amend [^;:]{0,120}$|^a bill to amend [^;:]{0,120}$|^relating to (commerce|state affairs|business)\.?$|^(sch cd|business-tech|various)\b/i;

const RESPONSE_SCHEMA = { type: 'OBJECT', required: ['results'], properties: { results: { type: 'ARRAY', items: { type: 'OBJECT', required: ['id', 'verdict', 'reason'], properties: { id: { type: 'STRING' }, verdict: { type: 'STRING', enum: ['yes', 'maybe', 'no'] }, reason: { type: 'STRING' } } } } } };

// items: [{ id, title, state?, number? }]. Returns Map(id -> { verdict, reason, by }). by = "model" | "fallback".
export async function classifyTitles({ llm, items, batchSize = 120, log = () => {} }) {
  const out = new Map();
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const prompt = batch.map((x) => `${x.id}\t${x.state ? x.state + ' ' : ''}${x.number ? x.number + ': ' : ''}${String(x.title || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
    let got = new Map();
    if (llm) {
      try {
        const r = await llm.generate({ system: INTENT_SYSTEM, prompt: 'Titles (id<TAB>title):\n' + prompt, itemId: `intent-screen-${i}`, responseSchema: RESPONSE_SCHEMA });
        got = new Map((r.data.results || []).filter((x) => ['yes', 'maybe', 'no'].includes(x.verdict)).map((x) => [String(x.id), x]));
      } catch (e) { log(`intent check failed for ${batch.length} title(s), all treated as "maybe": ${String(e.message).slice(0, 120)}`); }
    }
    for (const x of batch) {
      const g = got.get(String(x.id));
      if (g && g.verdict === 'no' && GENERIC_TITLE.test(String(x.title || ''))) { out.set(String(x.id), { verdict: 'maybe', reason: `generic title, kept by rule (model said no: ${g.reason || ''})`, by: 'rule' }); continue; }
      out.set(String(x.id), g ? { verdict: g.verdict, reason: g.reason || '', by: 'model' } : { verdict: 'maybe', reason: llm ? 'no answer from the model' : 'no model available', by: 'fallback' });
    }
  }
  return out;
}

export const fetchIt = (v) => !v || v.verdict !== 'no';
