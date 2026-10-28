// The tracker's own classification rules, written once and applied by code. The LLM may suggest a section,
// but status, type, level and confidence are decided here, so they cannot drift or be talked into something.

// Which sections the pipeline may create new entries in. Everything else is never auto-created (reported as a proposal). State bills (LegiScan) go in A, B, B.2 or C:
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
// ---------- the state sections' criteria, in code (tracker.md section definitions) ----------
// A  Enacted state frontier-developer laws: binding duties on developers defined by a frontier threshold (compute, "frontier" or "large
//    developer" definitions).
// B  Pending, stalled and failed state frontier-developer bills: the same, in a bill that is not law.
// B.2 Catastrophic-risk regulation WITHOUT a frontier threshold: catastrophic-risk duties ("catastrophic risk", "critical harm", CBRN,
//    mass casualties, loss of control) on developers, in a text that has no frontier threshold at all.
// C  State IVO / AI-auditor licensing measures: who may audit or verify AI developers (independent verification organizations, AI auditor
//    licensing or accreditation).
// A general AI bill (impact assessments, an ethics board, training-data or base-model disclosure, algorithmic discrimination) meets none
// of them. Code decides the section whenever exactly one qualifies; the referee must also give a quote that meets the section's own
// criterion (quoteMeetsSection), or the entry is held.
// A lost superscript ("10.26 computational operations", "1026 operations") still marks a compute threshold here: it is the bill's own
// threshold misprinted, and the numeric check (agents/checks.mjs thresholdNumberProblems) keeps it out of any field until normalised.
const THRESHOLD_SRC = String.raw`\b(?:large\s+)?frontier\s+(?:developers?|models?|artificial\s+intelligence)\b|\b10\s?\^\s?2\d\b|\b10[.,]?2\d\s+(?:integer|floating|computational|operations)|\bfloating[- ]point\s+operations\b|\bcomputational\s+operations\b|\bFLOPs?\b|\blarge\s+developers?\b`;
const CATASTROPHIC_SRC = String.raw`\bcatastrophic\s+risks?\b|\bcritical\s+(?:safety\s+)?(?:harms?|risks?|incidents?)\b|\bmass\s+casualt\w*|\bchemical,?\s+biological\b|\bweapons?\s+of\s+mass\s+destruction\b|\bloss\s+of\s+control\b`;
const AUDITOR_SRC = String.raw`\bindependent\s+verification\s+organi[sz]ations?\b|\b(?:AI|artificial\s+intelligence)\s+auditors?\b|\b(?:licens|certif|accredit)\w*\s+(?:of\s+)?(?:independent\s+)?(?:third[- ]party\s+)?(?:AI\s+)?auditors?\b|\bthird[- ]party\s+auditors?\b[^.]{0,80}\b(?:licens|certif|accredit)\w*`;
const re = (src, g = '') => new RegExp(src, 'i' + g);
export const SECTION_MARKERS = { A: THRESHOLD_SRC, B: THRESHOLD_SRC, 'B.2': CATASTROPHIC_SRC, C: AUDITOR_SRC };
export const SECTION_CRITERIA = {
  A: 'an enacted law that puts binding duties on frontier or large AI developers defined by a frontier threshold (training compute such as 10^26 operations, a "frontier model" or "large developer" definition)',
  B: 'a bill that puts binding duties on frontier or large AI developers defined by a frontier threshold (training compute such as 10^26 operations, a "frontier model" or "large developer" definition)',
  'B.2': 'a bill that puts duties about catastrophic risk (catastrophic risk, critical harm, chemical, biological, radiological or nuclear weapons, mass casualties, loss of control) on AI developers, without any compute or frontier threshold',
  C: 'a measure on who may audit or verify AI developers: independent verification organizations, or the licensing, certification or accreditation of AI auditors'
};
// A passage (up to 300 characters) of text that meets the section's criterion, or null.
// A threshold term defines who is regulated, whatever the bill calls them (AZ H.B. 4098: an "artificial intelligence business" is one using
// a frontier model of a large developer), so any binding duty near it counts. A catastrophic-risk term is common in general AI bills (a
// risk-assessment list), so for B.2 the duty must be on a developer or deployer.
const ANY_DUTY = /\b(?:shall|must|may not|is required to)\b/i;
function dutyNear(t, src, duty) {
  for (const m of t.matchAll(re(src, 'g'))) { const w = t.slice(Math.max(0, m.index - 1500), m.index + 1500); if (duty.test(w)) return t.slice(Math.max(0, m.index - 150), m.index + 150); }
  return null;
}
export function sectionPassage(section, text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (section === 'A' || section === 'B') return dutyNear(t, THRESHOLD_SRC, ANY_DUTY);
  if (section === 'B.2') return re(THRESHOLD_SRC).test(t) ? null : dutyNear(t, CATASTROPHIC_SRC, DUTY_ON_DEVELOPER);
  if (section === 'C') { const m = re(AUDITOR_SRC).exec(t); return m ? t.slice(Math.max(0, m.index - 150), m.index + 150) : null; }
  return null;
}
// The sections among `allowed` whose criterion the text meets (in the order given).
export const sectionsByCode = (text, allowed) => allowed.filter((s) => !!sectionPassage(s, text));
// Does a referee's quote meet the section's own criterion? (The quote must also be in the source; callers check that.)
export const quoteMeetsSection = (section, quote) => !!SECTION_MARKERS[section] && re(SECTION_MARKERS[section]).test(String(quote || '').replace(/\s+/g, ' ')) && (section !== 'B.2' || !re(THRESHOLD_SRC).test(String(quote || '')));

// Problems with a state section for a record of this kind ('bill' | 'resolution' | 'memorial' | 'other', agents/record-kind.mjs) and text.
export function stateSectionProblems(section, kind, text) {
  const out = [];
  if (['A', 'B', 'B.2'].includes(section) && kind && kind !== 'bill') out.push(`a ${kind} never goes in section ${section} (A, B and B.2 hold bills and laws)`);
  if (section === 'A' && text != null && !frontierDutyPassage(text)) out.push('section A needs an enacted text with binding duties on frontier or large AI developers or their models, and none was found in this text; choose C if its subject is independent verification or AI auditors');
  if (SECTION_MARKERS[section] && text != null && !sectionPassage(section, text)) out.push(`section ${section} needs ${SECTION_CRITERIA[section]}, and no passage of this text meets it`);
  return out;
}
