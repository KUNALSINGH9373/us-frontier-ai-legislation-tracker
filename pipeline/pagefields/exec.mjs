// An executive action's "What it orders" checklist (entry.exec_checklist): the same eight questions on every executive action, each
// answered like a bill duty from the order's own official text. Every answer is proved before it is kept, as for the 13 duties:
//   1) code (duties/check.mjs checkAnswer): format, quote found word for word, every number in the text, the section's numbers
//   2) the independent reader (validator role) confirms every yes / partial / no answer with its own quote, checked word for word
// After one round of feedback, if any answer still fails, the whole checklist is left off. Never an unverified answer.
import { VERDICT_SCHEMA, VALIDATOR_SYSTEM, validatorPrompt } from '../agents/prompts.mjs';
import { containsQuote } from '../agents/source-text.mjs';
import { checkAnswer } from '../duties/check.mjs';
import { makeValidator } from '../schema/validate.mjs';

export const EXEC_NAMES = ['binding', 'voluntary_program', 'pre_release_access', 'agencies_build', 'deadlines', 'enforcement_priority', 'targets_state_laws', 'penalties'];
// What "yes" means for each question (the claim the reader checks).
export const EXEC_MEANINGS = {
  binding: 'imposes a mandatory duty on private companies (developers, exporters or other businesses)',
  voluntary_program: 'sets up or calls for a voluntary programme, framework or commitment that companies may join',
  pre_release_access: 'provides for government testing of, or access to, AI models before they are released',
  agencies_build: 'directs government agencies to create, develop or deliver something (a rule, benchmark, framework, report, office or programme)',
  deadlines: 'sets dated or day-counted deadlines for the actions it orders',
  enforcement_priority: 'directs law enforcement or litigation priorities, or enforcement action',
  targets_state_laws: 'addresses state laws (challenging, pre-empting, evaluating or conditioning funding on them)',
  penalties: 'sets penalties or sanctions for not complying'
};
const S = (extra = {}) => ({ type: 'STRING', ...extra });
const ANSWER = { type: 'OBJECT', required: ['value', 'summary'], properties: { value: S({ enum: ['yes', 'partial', 'no', 'not_in_bill'] }), summary: S(), section: S({ nullable: true }), quote: S({ nullable: true }) } };
export const EXEC_SCHEMA = { type: 'OBJECT', required: ['answers'], properties: { answers: { type: 'OBJECT', required: EXEC_NAMES, properties: Object.fromEntries(EXEC_NAMES.map((k) => [k, ANSWER])) } } };
export const EXEC_SYSTEM = `You read ONE official text of an executive action or federal rule and answer 8 fixed questions about what it orders, for a tracker of US frontier-AI law. Code checks every quote word for word against the text and a second reader checks every answer, so answer only what SOURCE states.

For each question give { value, summary, section, quote }:
- value: "yes" = the text does it. "partial" = it does, with a limit the summary states. "no" = the text expressly rules it out (quote that exclusion). "not_in_bill" = the text is silent (no section, no quote).
- summary: one plain-English line, at most 240 characters, that a reader with no legal background can follow. Say who must do what. Every number must appear in SOURCE.
- section: the section as the text numbers it ("Sec. 3(c)", "§ 744.23"). Required unless not_in_bill.
- quote: ONE exact span copied from SOURCE, 8 to 400 characters, that proves the answer. Copy it character for character; never join two passages.

The questions ("yes" when the text ...):
${EXEC_NAMES.map((k) => `- ${k}: ${EXEC_MEANINGS[k]}`).join('\n')}`;

export const execClaim = (k, d) => `${d.value === 'no' ? `The text expressly rules this out (it ${EXEC_MEANINGS[k]})` : `The text ${EXEC_MEANINGS[k]}${d.value === 'partial' ? ', with the limit stated here' : ''}`}, in ${d.section}: ${d.summary}`;
const schema = makeValidator();

export async function writeExecChecklist({ generator, validator, entry, sourceText, sourceUrl, log = () => {} }) {
  let feedback = [], previous = null, last = {};
  const itemId = 'exec:' + entry.key;
  for (let round = 1; round <= 2; round++) {
    const prompt = [`ACTION: ${entry.title}`, `SOURCE (${sourceUrl}):\n<<<SOURCE\n${sourceText}\nSOURCE>>>`, ...(feedback.length ? [`YOUR PREVIOUS ATTEMPT WAS REJECTED. Fix exactly these problems and nothing else:\n${feedback.map((f) => '- ' + f).join('\n')}\n\nPrevious attempt:\n${JSON.stringify(previous)}`] : [])].join('\n\n');
    const res = await generator.generate({ system: EXEC_SYSTEM, prompt, responseSchema: EXEC_SCHEMA, itemId: `${itemId}:w${round}` });
    const raw = (res.data && res.data.answers) || {}, answers = {}, problems = {};
    const add = (k, p) => { (problems[k] ||= []).push(p); };
    for (const k of EXEC_NAMES) {
      const d = raw[k];
      if (!d) { add(k, `${k}: missing`); continue; }
      answers[k] = d.value === 'not_in_bill' ? { value: d.value, summary: String(d.summary || '').trim() } : { value: d.value, summary: String(d.summary || '').trim(), section: String(d.section || '').trim(), quote: String(d.quote || '').trim(), source_url: sourceUrl };
      checkAnswer(k, answers[k], sourceText, { sourceUrl }).forEach((p) => add(k, p));
    }
    const list = EXEC_NAMES.filter((k) => answers[k] && !problems[k] && answers[k].value !== 'not_in_bill').map((k) => ({ field: k, claim: execClaim(k, answers[k]) }));
    if (list.length) {
      const v = await validator.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: sourceText, claims: list }), responseSchema: VERDICT_SCHEMA, itemId: `${itemId}:v${round}` });
      const byN = new Map(((v.data && v.data.results) || []).map((r) => [r.n, r]));
      list.forEach((c, i) => { const r = byN.get(i + 1); if (!r) add(c.field, `${c.field}: the independent reader did not answer`); else if (r.supported !== true) add(c.field, `${c.field}: the independent reader rejected it: ${r.reason || 'not supported'}`); else if (!containsQuote(sourceText, r.quote)) add(c.field, `${c.field}: the reader's quote is not in the source`); });
    }
    log(`${entry.key} round ${round}: ${Object.keys(problems).length ? Object.keys(problems).length + ' answer(s) failed' : 'every answer proved'}`);
    if (!Object.keys(problems).length) {
      if (EXEC_NAMES.every((k) => answers[k].value === 'not_in_bill')) return { key: entry.key, exec_checklist: null, reason: 'every answer was not_in_bill' };
      const errs = schema.check('entry', { ...entry, exec_checklist: answers, page_verification: { method: 'agent', checked_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') } });
      if (errs.length) return { key: entry.key, exec_checklist: null, reason: 'entry schema: ' + errs[0] };
      return { key: entry.key, exec_checklist: answers, reason: null, reviewerModel: validator.model };
    }
    feedback = Object.values(problems).flat(); previous = raw; last = problems;
  }
  return { key: entry.key, exec_checklist: null, reason: `left off: ${Object.keys(last).length} answer(s) still unproved (${Object.values(last).flat()[0]})` };
}
