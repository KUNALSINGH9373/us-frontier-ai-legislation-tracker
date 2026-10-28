// The tracker's own classification rules, written once and applied by code. The LLM may suggest a section,
// but status, type, level and confidence are decided here, so they cannot drift or be talked into something.

// Which sections the pipeline may create new entries in. Everything else needs a person. State bills (LegiScan) go in A, B, B.2 or C:
// the four state sections whose entries are bills or laws, with a status the record gives (agents/derive.mjs stateSections decides which
// of them a bill's status allows). E (drafts), G.2 (litigation), H (precursors), I (provisions inside broader laws) and J (exclusions)
// are judgements about context, not facts a bill record states, so they stay with a person.
export const AUTO_CREATE_SECTIONS = ['A', 'B', 'B.2', 'C', 'D', 'F', 'G', 'G.3'];

export const SECTION_RULES = {
  A: { type: 'law', level: 'state' }, B: { type: 'bill', level: 'state' }, 'B.2': { type: 'bill', level: 'state' }, C: { type: 'auditor', level: 'state' },
  D: { type: 'bill', level: 'federal' }, E: { type: 'draft', level: 'federal' }, F: { type: 'bill', level: 'federal' },
  G: { type: 'executive', level: 'federal' }, 'G.2': { type: 'litigation', level: null }, 'G.3': { type: 'export', level: 'federal' },
  H: { type: 'precursor', level: null }, I: { type: 'law', level: null }, J: { type: 'excluded', level: 'none' }
};
export const SECTION_NAMES = {
  A: 'Enacted state frontier-developer laws', B: 'Pending, stalled and failed state bills', 'B.2': 'Catastrophic-risk regulation without a frontier threshold', C: 'State IVO / AI-auditor licensing measures',
  D: 'Federal frontier-AI bills introduced (none enacted)', F: 'Adjacent and sectoral federal bills', G: 'Executive actions', 'G.3': 'Compute and export controls'
};

// Federal bills stay "pending" until they become law; executive actions, litigation and export controls have their own status.
export function statusFor(section, apiStatus) {
  if (section === 'G') return 'executive';
  if (section === 'G.2') return 'litigation';
  if (section === 'G.3') return 'export';
  if (section === 'D' || section === 'E' || section === 'F') return apiStatus === 'enacted' || apiStatus === 'failed' ? apiStatus : 'pending';
  // State sections: A holds only enacted laws, B and B.2 only bills that are not law (pending or failed; "stalled" is a person's
  // judgement), C IVO / AI-auditor measures in any state. An enacted bill in B, or a pending one in A, has no status by rule.
  if (section === 'A') return apiStatus === 'enacted' ? 'enacted' : null;
  if (section === 'B' || section === 'B.2') return apiStatus === 'failed' ? 'failed' : apiStatus === 'pending' ? 'pending' : null;
  if (section === 'C') return ['enacted', 'failed', 'pending'].includes(apiStatus) ? apiStatus : null;
  return null;
}

// Phrases the pipeline must never write: "none located" and similar are a person's search finding, not a fact a feed can supply.
export const NEGATIVE_FINDING = /\b(none|no\b[^.]{0,40}\b)\s+(located|found|identified)\b|\bnot (located|found)\b|\bno (evidence|record|action|activity) (was |has been )?(located|found|identified)\b|\bas of [A-Z][a-z]+ \d{1,2}, 20\d\d, no\b/i;

// The confidence the pipeline may assign, by rule from where the facts came from.
export function confidenceFor(sourceKinds) {
  if (sourceKinds.length && sourceKinds.every((k) => k === 'primary')) return { level: 'HIGH', basis: 'primary_record' };
  if (sourceKinds.includes('primary')) return { level: 'MED-HIGH', basis: 'corroborated' };
  return { level: 'MED', basis: 'secondary' };
}

// Section A holds enacted state laws that put binding duties on frontier or large AI developers or their models. A law whose only
// in-scope part is something else (CT H.B. 5222: an independent-verification pilot inside a consumer-protection act) is not an A law.
// Code checks the enacted text for both: a frontier definition or threshold, and a duty ("shall" / "must" / "may not") on a developer of
// such models in the same passage. No such passage: A is refused (the Generator is told why, and may choose C; otherwise it is held).
const FRONTIER_TERM = /\b(?:large\s+)?frontier\s+(?:developers?|models?|artificial intelligence)\b|\bfoundation\s+models?\b|\b10\^2\d\b|\bfloating[- ]point\s+operations\b|\blarge\s+developers?\b|\bcovered\s+(?:frontier\s+)?models?\b/gi;
const DUTY_ON_DEVELOPER = /\b(?:developers?|deployers?)\b[^.;]{0,200}\b(?:shall|must|may not)\b|\b(?:shall|must)\b[^.;]{0,120}\b(?:frontier|large)\s+developers?\b/i;
export function frontierDutyPassage(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  for (const m of t.matchAll(FRONTIER_TERM)) {
    const w = t.slice(Math.max(0, m.index - 1500), m.index + 1500);
    if (DUTY_ON_DEVELOPER.test(w)) return w.slice(0, 300);
  }
  return null;
}
// Problems with a state section for a record of this kind ('bill' | 'resolution' | 'memorial' | 'other', agents/record-kind.mjs) and text.
export function stateSectionProblems(section, kind, text) {
  const out = [];
  if (['A', 'B', 'B.2'].includes(section) && kind && kind !== 'bill') out.push(`a ${kind} never goes in section ${section} (A, B and B.2 hold bills and laws)`);
  if (section === 'A' && text != null && !frontierDutyPassage(text)) out.push('section A needs an enacted text with binding duties on frontier or large AI developers or their models, and none was found in this text; choose C if its subject is independent verification or AI auditors');
  return out;
}
