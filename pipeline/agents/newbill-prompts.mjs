// The new-bills writer and reviewer prompts (simple build, 31 Oct 2026). The words sent to the models live in one place,
// agents/newbill-prompt.md (the owner-reviewed prompt document): this module reads its eight code blocks in order and fills in the
// per-bill data, so the document and what is sent can never drift apart. The answer shapes are below, in the Gemini-style form every
// AI call uses (llm/schema.mjs); the document's JSON shapes describe the same fields for readers.
//   0 writer system   1 writer user   2 checks-failed retry   3 writer shape (doc)   4 reviewer system   5 reviewer user
//   6 reviewer shape (doc)   7 fix round   8 scope check
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCOPE_DEFINITION } from './prompts.mjs';

const DOC = fileURLToPath(new URL('./newbill-prompt.md', import.meta.url));
export const BLOCK_COUNT = 9;
let cached = null;
export function promptBlocks() {
  if (cached) return cached;
  const md = fs.readFileSync(DOC, 'utf8');
  const blocks = [...md.matchAll(/```(?:text|json)\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1]);
  if (blocks.length !== BLOCK_COUNT) throw new Error(`agents/newbill-prompt.md has ${blocks.length} code blocks, expected ${BLOCK_COUNT}`);
  cached = blocks;
  return blocks;
}

// The section rule as the writer reads it: the generator's rule (agents/prompts.mjs), named for this answer shape.
const asTrackerSection = (rule) => String(rule).replace(/^- section \(a top-level key, next to "fields", not inside it\): REQUIRED/, 'tracker_section: REQUIRED');
const fill = (t, map) => Object.entries(map).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(v), t);

export const writerSystem = ({ sectionRule }) => fill(promptBlocks()[0], { SCOPE_DEFINITION, SECTION_RULE: asTrackerSection(sectionRule) });
export const reviewerSystem = () => fill(promptBlocks()[4], { SCOPE_DEFINITION });
// The scope check (agents/newbill.mjs scopeCheck): the bill and the writer's reason, nothing else of the entry.
export const scopeJudgeSystem = () => fill(promptBlocks()[8], { SCOPE_DEFINITION });
export const scopeJudgeUser = (bill, writerReason) => `<bill jurisdiction="${bill.jurisdiction}" number="${bill.number}">
<official_title>${bill.title || ''}</official_title>
<text>
${bill.text}
</text>
</bill>

<writer_reason>
${writerReason || ''}
</writer_reason>

Decide whether this bill is in scope. Name the qualifying binding provision and copy its words exactly, or say it is out of scope. Return JSON matching the schema.`;

// bill: { jurisdiction, number, title, text } with text = readerSourceText() (or its frontier sections for a very long bill).
export const writerUser = (bill) => fill(promptBlocks()[1], { jurisdiction: bill.jurisdiction, number: bill.number, 'official title': bill.title || '', 'full cleaned text': bill.text });
export const checksFailed = (problems) => promptBlocks()[2].replace('{{problems}}', problems.map((p) => `- ${p}`).join('\n'));
// The reviewer reads the entry without the writer's inventory, so it builds its own map of the bill.
export const reviewerUser = (bill, entry) => {
  const { inventory, ...rest } = entry;
  return fill(promptBlocks()[5], { jurisdiction: bill.jurisdiction, number: bill.number, 'official title': bill.title || '', 'full cleaned text': bill.text, 'writer JSON, without "inventory"': JSON.stringify(rest, null, 1) });
};
// The fix round. The client sends one message per call, so the writer's previous answer is given back inside it.
export function fixRound(findings, previous) {
  const lines = findings.map((f) => `- [${f.severity}] ${f.where}: ${f.problem} Bill says: "${f.bill_quote}". Suggested fix: ${f.fix}`).join('\n');
  const block = promptBlocks()[7].replace(/\{\{for each finding[^}]*\}\}/, lines);
  return `<previous_answer>\n${JSON.stringify(previous, null, 1)}\n</previous_answer>\n\n${block}`;
}

// ---------- answer shapes ----------
const S = (extra = {}) => ({ type: 'STRING', ...extra });
const B = { type: 'BOOLEAN' };
const strs = { type: 'ARRAY', items: S() };
const obj = (properties) => ({ type: 'OBJECT', required: Object.keys(properties), properties });
const list = (properties) => ({ type: 'ARRAY', items: obj(properties) });
// Every item: lead_in and quote first, then where it is and whom it binds, then the conditions, and the plain line last (copy first,
// then paraphrase: the field order is the order the model writes in).
const item = (middle) => list({ id: S(), lead_in: S(), quote: S(), sec: S(), ...middle, text: S() });
export const ROW_KEYS = ['framework', 'transparency_report', 'incident_reporting', 'imminent_risk_reporting', 'third_party_audit', 'whistleblower', 'registration', 'shutdown', 'compute_threshold', 'revenue_threshold', 'harm_threshold', 'penalties', 'effective_date'];
export const DUTY_KINDS = ['framework', 'transparency_report', 'incident_reporting', 'imminent_risk_reporting', 'third_party_audit', 'whistleblower', 'registration', 'shutdown', 'records', 'agency', 'rulemaking', 'other'];
export const OTHER_KINDS = ['preemption', 'immunity', 'disclosure_exemption', 'sunset', 'funding', 'severability', 'relation_to_other_law', 'other'];
export const PROVISION_TYPES = ['definition', 'coverage', 'exclusion', 'duty', 'power', 'ban', 'penalty', 'enforcement', 'effective', 'preemption', 'immunity', 'disclosure_exemption', 'sunset', 'funding', 'findings_or_purpose', 'short_title', 'other'];
export const ITEM_LISTS = ['coverage', 'definitions', 'exclusions', 'duties', 'penalties', 'effective', 'other_provisions'];
// Every item of an answer, tagged with its list.
export const itemsOf = (out) => ITEM_LISTS.flatMap((l) => ((out && out[l]) || []).map((x) => ({ ...x, _list: l })));
const row = obj({ value: S({ enum: ['yes', 'partial', 'no', 'not_in_bill'] }), items: strs, quote: S(), sec: S(), summary: S() });
const slot = obj({ based_on: strs, text: S() });

// The shape the model answers in (structured output). The API compiles the shape into a grammar and refuses one with too many distinct
// object shapes (live run, 31 Oct 2026: seven item lists and thirteen named rows were refused; three lists were accepted). So the model
// writes every item in ONE list, each naming its `list`, and the rows as ONE list, each naming its `key`; expandAnswer turns that back
// into writerShape (below) at once, and every check, the reviewer, the entry and the site read that. Per-list choices (a duty's kind,
// an effective item's type) are checked by code (newbill-checks.mjs), not by the grammar.
const ANY_ITEM = { list: S({ enum: ITEM_LISTS }), id: S(), lead_in: S(), quote: S(), sec: S(), party: S(), term: S(), excludes_from: S(), applies_to: S(), force: S(), kind: S(), type: S(), trigger: S(), amount: S(), unit: S(), enforcer: S(), conditions: strs, deadline: S(), headline: B, text: S() };
export const writerSchema = (sections) => obj({
  inventory: list({ sec: S(), provision_type: S({ enum: PROVISION_TYPES }), party: S() }),
  readable: B, text_problems: strs,
  in_scope: B, scope_reason: S(), tracker_section: S({ enum: sections }),
  name_quote: S(), name: S(),
  items: list(ANY_ITEM),
  rows: list({ key: S({ enum: ROW_KEYS }), value: S({ enum: ['yes', 'partial', 'no', 'not_in_bill'] }), items: strs, quote: S(), sec: S(), summary: S() }),
  box: obj({ main_party: S(), applies_to: slot, requires_lead: S({ enum: ['Requires them to', 'Directs'] }), requires: slot, enforcement: slot, effective: slot })
});
// The fields each list keeps (the rest of an item's fields are the other lists' and are dropped).
const LIST_FIELDS = {
  coverage: ['party', 'conditions', 'headline'], definitions: ['term'], exclusions: ['excludes_from'],
  duties: ['party', 'force', 'kind', 'conditions', 'deadline'], penalties: ['applies_to', 'trigger', 'amount', 'unit', 'enforcer', 'conditions'],
  effective: ['type'], other_provisions: ['kind']
};
// The model's answer in the shape everything else reads: the seven lists and the thirteen named rows. An answer already in that shape
// (the scripted answers of the tests) is returned as it is.
export function expandAnswer(a) {
  if (!a || !Array.isArray(a.items) || ITEM_LISTS.some((l) => Array.isArray(a[l]))) return a;
  const { items, rows, ...rest } = a, out = { ...rest };
  for (const l of ITEM_LISTS) out[l] = [];
  for (const x of items) {
    if (!LIST_FIELDS[x.list]) continue;
    const keep = ['id', 'lead_in', 'quote', 'sec', ...LIST_FIELDS[x.list], 'text'];
    out[x.list].push(Object.fromEntries(keep.map((k) => [k, x[k] !== undefined ? x[k] : (k === 'conditions' ? [] : k === 'headline' ? false : '')])));
  }
  out.rows = {};
  for (const r of rows || []) if (ROW_KEYS.includes(r.key) && !out.rows[r.key]) { const { key, ...v } = r; out.rows[key] = v; }
  return out;
}
// The full shape (the seven lists, the thirteen named rows), as the checks and the document describe it.
export const writerShape = (sections) => obj({
  inventory: list({ sec: S(), provision_type: S({ enum: PROVISION_TYPES }), party: S() }),
  readable: B, text_problems: strs,
  in_scope: B, scope_reason: S(), tracker_section: S({ enum: sections }),
  name_quote: S(), name: S(),
  coverage: item({ party: S(), conditions: strs, headline: B }),
  definitions: item({ term: S() }),
  exclusions: item({ excludes_from: S() }),
  duties: item({ party: S(), force: S({ enum: ['duty', 'power', 'ban'] }), kind: S({ enum: DUTY_KINDS }), conditions: strs, deadline: S() }),
  penalties: item({ applies_to: S(), trigger: S(), amount: S(), unit: S(), enforcer: S(), conditions: strs }),
  effective: item({ type: S({ enum: ['act', 'duty', 'agency'] }) }),
  other_provisions: item({ kind: S({ enum: OTHER_KINDS }) }),
  rows: obj(Object.fromEntries(ROW_KEYS.map((k) => [k, row]))),
  box: obj({ main_party: S(), applies_to: slot, requires_lead: S({ enum: ['Requires them to', 'Directs'] }), requires: slot, enforcement: slot, effective: slot })
});

// The scope check's answer: the provisions it weighed, then its call and the one qualifying provision's exact words.
export const SCOPE_JUDGE_SCHEMA = obj({
  considered: list({ sec: S(), limited_to_frontier: B, aimed_at_catastrophic_harm: B, why: S() }),
  in_scope: B, sec: S(), quote: S(), reason: S()
});

export const REVIEWER_SCHEMA = obj({
  reviewer_map: list({ sec: S(), provision_type: S(), party: S() }),
  checked: { type: 'ARRAY', items: S(), description: 'every part checked, by its plain name: each item id (c1, u3 ...), each of the 13 row keys (framework ... effective_date), and scope, name, box.applies_to, box.requires, box.enforcement, box.effective' },
  findings: list({ severity: S({ enum: ['WRONG', 'MISLEADING', 'OMISSION'] }), where: S(), bill_quote: S(), problem: S(), fix: S() })
});
