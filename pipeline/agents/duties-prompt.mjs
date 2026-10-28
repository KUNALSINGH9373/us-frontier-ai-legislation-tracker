// The duty prompts, in one reviewable file, written from duties/DRAFTING.md (the rules the session drafts followed) so the agent
// answers the 13 duties of entry.schema.json "duties" the same way. duties/check.mjs holds every answer to the text in code.

// The 13 duties, in schema order, with what "yes" means for each (duties/DRAFTING.md, "What each duty means").
export const DUTY_MEANINGS = {
  framework: 'requires a developer to write, publish or follow a safety / risk-management / security framework, plan or protocol',
  transparency_report: 'requires a public report or disclosure about a model (system card, risk summary)',
  incident_reporting: 'requires reporting safety or security incidents to a government body (state the window)',
  imminent_risk_reporting: 'sets a shorter window for incidents posing imminent risk of death or serious injury',
  third_party_audit: 'requires an independent audit, evaluation or verification (partial when third-party testing is only described or optional)',
  whistleblower: 'protects employees who report risks or violations',
  registration: 'requires registering, licensing, permitting or notifying a regulator before developing or deploying',
  shutdown: 'requires a shutdown, kill-switch, stop or containment capability',
  compute_threshold: 'defines coverage by training compute (operations / FLOPs)',
  revenue_threshold: 'defines coverage by revenue, spending or users',
  harm_threshold: 'defines catastrophic or covered harm by deaths, injuries or damages',
  penalties: 'states penalties, fines or enforcement remedies (say who enforces)',
  effective_date: 'the text itself states when it takes effect or becomes operative (never a date from outside knowledge)'
};
export const DUTY_NAMES = Object.keys(DUTY_MEANINGS);

export const DUTIES_SYSTEM = `You read ONE official bill text and answer 13 fixed questions about what the bill requires, for a tracker of US frontier-AI laws. Code checks every quote word for word against the text and a second reader checks every answer, so an answer that cannot be proved from SOURCE is thrown away.

For each duty give { value, summary, section, quote }:
- value: "yes" = the bill imposes or sets it. "partial" = it does, with a limit the summary states (for example "describes third-party testing, no audit required", "applies only to federal agencies", "study only"). "no" = the bill expressly excludes or negates it (quote that exclusion). "not_in_bill" = the text is silent; then give NO section and NO quote.
- summary: one plain-English line, at most 240 characters, that a reader with no legal background can follow. Say who must do what.
- section: the section as the bill numbers it ("Sec. 4(b)", "22757.12(a)"). Required unless not_in_bill.
- quote: ONE exact span copied from SOURCE, 8 to 400 characters, that proves the answer. Copy it character for character. Prefer the operative sentence ("shall report ... within 15 days"), not a heading. Never join two passages with "...", never fix spelling. Required unless not_in_bill.

What "yes" means for each duty:
${DUTY_NAMES.map((k) => `- ${k}: ${DUTY_MEANINGS[k]}`).join('\n')}

RULES:
1. Only what SOURCE says. No outside knowledge, no inference about intent. A duty that is implied but not stated is not_in_bill.
2. Every number in a summary, quote or section must occur in SOURCE. Write figures as SOURCE writes them ($500,000,000, 10^26, 24 hours); a number SOURCE spells out ("fifteen days") may be written as digits.
3. Duties are the bill's own requirements on developers, deployers or agencies, not findings, purposes or definitions nobody must act on. A definition counts only for the three thresholds.
4. A bill that only orders a study or report by an agency is "partial" at most, and the summary must say who has the duty ("the Secretary must study ..., no duty on developers").
5. An amendment to another statute: describe what the new text requires; the quote is the new text.
6. Search the whole text for the key terms (report, incident, audit, evaluat, whistleblower, register, license, shut, terminate, penalt, civil, effective, take effect, operations, revenue, catastrophic) and read those sections before answering. Never answer from the title or the digest alone.
7. If the previous attempt was rejected, fix exactly the problems listed and change nothing else.

Return JSON only: {"duties":{"framework":{...},"transparency_report":{...}, ... all 13 keys ...},"notes":""}. Example of one answer of each kind (made up; yours come from SOURCE):
"penalties":{"value":"yes","summary":"Civil penalty of up to $1,000,000 per violation, enforced by the Attorney General.","section":"Sec. 6(a)","quote":"a civil penalty of up to $1,000,000 per violation"},
"whistleblower":{"value":"not_in_bill","summary":"The bill has no employee protections."}`;

export function dutiesPrompt({ entry, source, sourceUrl, feedback, previous }) {
  const parts = [`BILL: ${entry.title}${entry.mechanism ? `\nWHAT IT DOES (already checked): ${entry.mechanism}` : ''}`];
  parts.push(`SOURCE (${sourceUrl}):\n<<<SOURCE\n${source}\nSOURCE>>>`);
  if (feedback && feedback.length) parts.push(`YOUR PREVIOUS ATTEMPT WAS REJECTED. Fix exactly these problems and nothing else:\n${feedback.map((f) => `- ${f}`).join('\n')}\n\nPrevious attempt:\n${JSON.stringify(previous)}`);
  return parts.join('\n\n');
}

// The claim the independent reader checks for one answer (agents/prompts.mjs VALIDATOR_SYSTEM): the value, the section and the summary together,
// so a "yes" the text does not support, a duty put in the wrong section or an overstated summary is each rejected.
export function dutyClaim(name, d) {
  const what = d.value === 'no' ? `The bill expressly excludes or negates this duty (${DUTY_MEANINGS[name]})` : `The bill ${DUTY_MEANINGS[name]}${d.value === 'partial' ? ', with the limit stated here' : ''}`;
  return `${what}, in ${d.section} of the bill: ${d.summary}`;
}
