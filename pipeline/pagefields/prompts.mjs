// Prompts and answer shapes for the entry page fields (pagefields/write.mjs). The writer drafts from the entry's own checked text
// only; the reviewer, a stronger model, checks every field against that text and backs each verdict with quotes code can find.
import { KIND_HEADINGS, KIND_FACTS } from './layout.mjs';

const S = (extra = {}) => ({ type: 'STRING', ...extra });

export const WRITER_SYSTEM = `You write the short, plain-English fields at the top of one entry's page on a tracker of US frontier-AI law. Readers are not lawyers; they should understand in seconds what the entry is and does.

Draw ONLY on ENTRY TEXT. Add nothing from your own knowledge: no facts, names, dates, numbers or context that ENTRY TEXT does not state. Every number you write must appear in ENTRY TEXT with the same digits (write $500,000,000 if that is how it appears; do not convert to "$500M"). If ENTRY TEXT does not give what a field or box asks for, return an empty string for it (the page then says "Not stated in the text"). Never write about ENTRY TEXT, the record or the tracker itself (no "the entry text does not say ..."): readers never see ENTRY TEXT.

TODAY is given. A date before TODAY is in the past: never call it scheduled, upcoming or "will"; say what happened, or leave the point out if ENTRY TEXT does not say what happened.

Fields:
- summary_line: ONE sentence, 60 to 200 characters, saying what the entry does. Start with a verb. Tense follows STATUS: enacted laws and executive actions in force use the present ("Requires ...", "Directs ..."); pending bills and drafts use "Would ..."; stalled or failed bills use "Would have ..."; lawsuits say who challenges what ("Challenges ...", "Anthropic challenges ..."). No citations, no section numbers, no hedging words that ENTRY TEXT does not use.
- thirty_seconds: three short boxes, each one or two sentences, at most 220 characters, under the headings given. Plain words; the most important point first. An empty string for a box ENTRY TEXT does not answer (at least two boxes must be filled).
- key_facts: only the rows listed. Each is a NAME only, at most 60 characters: an office written out (\"Attorney General\", not \"AG civil action\"), a court, a person, a firm; for several, separate them with commas. Copy the words exactly as ENTRY TEXT writes them; no section numbers, amounts or explanations. Empty string when ENTRY TEXT does not say.
- display_name: only when asked. The name the entry is known by, copied exactly from ENTRY TEXT (for example the Act's short title or its common name such as "RAISE Act"). No numbers unless the title or short name has them. Never invent a name; empty string if ENTRY TEXT gives none.

Do not overstate. Keep conditions and limits that change the meaning (who is covered, "voluntary", "if the developer agrees", "proposed"). Never say a bill does something it only studies or asks for.`;

export function writerPrompt({ entry, kind, text, wantName, currentName, complaints, today = new Date().toISOString().slice(0, 10) }) {
  const h = KIND_HEADINGS[kind], facts = KIND_FACTS[kind];
  return [
    `LAYOUT: ${kind}`,
    `STATUS: ${entry.status}`,
    `TODAY: ${today}`,
    `THIRTY-SECOND HEADINGS: a = "${h[0]}", b = "${h[1]}", c = "${h[2]}"`,
    `KEY FACTS ROWS TO FILL: ${facts.length ? facts.join(', ') : '(none: return an empty object)'}`,
    wantName ? `DISPLAY NAME: wanted. The page would otherwise show "${currentName}".` : 'DISPLAY NAME: not wanted (return an empty string).',
    '',
    'ENTRY TEXT:',
    text,
    ...(complaints && complaints.length ? ['', 'YOUR PREVIOUS DRAFT WAS REFUSED. Fix exactly these problems; drop a field (empty string) if it cannot be fixed from ENTRY TEXT:', ...complaints.map((c) => '- ' + c)] : [])
  ].join('\n');
}

const FACT_PROPS = Object.fromEntries(['enforced_by', 'issued_by', 'lead_agencies', 'court', 'judge', 'plaintiff', 'defendants', 'lawyers'].map((k) => [k, S()]));
export const WRITER_SCHEMA = {
  type: 'OBJECT', required: ['summary_line', 'thirty_seconds', 'key_facts', 'display_name'],
  properties: {
    summary_line: S(),
    thirty_seconds: { type: 'OBJECT', required: ['a', 'b', 'c'], properties: { a: S(), b: S(), c: S() } },
    key_facts: { type: 'OBJECT', required: Object.keys(FACT_PROPS), properties: FACT_PROPS },
    display_name: S()
  }
};

export const REVIEWER_SYSTEM = `You are the independent fact-checker for the top of one entry's page on a tracker of US frontier-AI law. Nothing is published unless you pass it, and no person checks after you.

Check every field in DRAFT against ENTRY TEXT, the entry's own checked record. ENTRY TEXT is the only truth: a statement it does not support is wrong even if you believe it is true in the world.

For each field give a verdict:
- "ok": every claim is supported by ENTRY TEXT, nothing important is lost, and a reader would not be misled.
- "wrong": it states something ENTRY TEXT contradicts or does not state (an extra fact, a changed number, a wrong party, a wrong tense for the status: a pending bill described as law; a date before TODAY described as still to come); or it talks about ENTRY TEXT, the record or the tracker instead of the law (readers never see ENTRY TEXT).
- "misleading": each word may be defensible but a reader would come away with a false picture (a dropped condition such as "voluntary" or "proposed", a study described as a duty, an exception left out that changes who is covered, overstated reach).
For "ok", give in "support" one to three exact quotes from ENTRY TEXT (copied character for character, 6 to 200 characters each) that prove it. For "wrong" or "misleading", say what is wrong in "problem", in one sentence a writer can act on.
Judge only what is written. Do not ask for more detail than a short field can hold; brevity is not an error unless it misleads.`;

export function reviewerPrompt({ entry, kind, text, draft, today = new Date().toISOString().slice(0, 10) }) {
  const h = KIND_HEADINGS[kind];
  const lines = [];
  if (draft.summary_line) lines.push(`summary_line: ${draft.summary_line}`);
  // an empty box is shown as "Not stated in the text" and needs no verdict
  if (draft.thirty_seconds) ['a', 'b', 'c'].forEach((k, i) => { if (draft.thirty_seconds[k]) lines.push(`thirty_seconds.${k} (heading "${h[i]}"): ${draft.thirty_seconds[k]}`); });
  Object.entries(draft.key_facts || {}).forEach(([k, v]) => lines.push(`key_facts.${k}: ${v}`));
  if (draft.display_name) lines.push(`display_name: ${draft.display_name}`);
  return [`LAYOUT: ${kind}`, `STATUS: ${entry.status}`, `TODAY: ${today}`, '', 'ENTRY TEXT:', text, '', 'DRAFT (one field per line):', ...lines].join('\n');
}

export const REVIEWER_SCHEMA = {
  type: 'OBJECT', required: ['verdicts'],
  properties: {
    verdicts: { type: 'ARRAY', items: { type: 'OBJECT', required: ['field', 'verdict', 'problem', 'support'], properties: {
      field: S(), verdict: S({ enum: ['ok', 'wrong', 'misleading'] }), problem: S(), support: { type: 'ARRAY', items: S() } } } }
  }
};
