// The tracker's own classification rules, written once and applied by code. The LLM may suggest a section,
// but status, type, level and confidence are decided here, so they cannot drift or be talked into something.

// Which sections the pipeline may create new entries in. Everything else needs a person (state bills wait for LegiScan).
export const AUTO_CREATE_SECTIONS = ['D', 'F', 'G', 'G.3'];

export const SECTION_RULES = {
  A: { type: 'law', level: 'state' }, B: { type: 'bill', level: 'state' }, 'B.2': { type: 'bill', level: 'state' }, C: { type: 'auditor', level: 'state' },
  D: { type: 'bill', level: 'federal' }, E: { type: 'draft', level: 'federal' }, F: { type: 'bill', level: 'federal' },
  G: { type: 'executive', level: 'federal' }, 'G.2': { type: 'litigation', level: null }, 'G.3': { type: 'export', level: 'federal' },
  H: { type: 'precursor', level: null }, I: { type: 'law', level: null }, J: { type: 'excluded', level: 'none' }
};
export const SECTION_NAMES = {
  D: 'Federal frontier-AI bills introduced (none enacted)', F: 'Adjacent and sectoral federal bills', G: 'Executive actions', 'G.3': 'Compute and export controls'
};

// Federal bills stay "pending" until they become law; executive actions, litigation and export controls have their own status.
export function statusFor(section, apiStatus) {
  if (section === 'G') return 'executive';
  if (section === 'G.2') return 'litigation';
  if (section === 'G.3') return 'export';
  if (section === 'D' || section === 'E' || section === 'F') return apiStatus === 'enacted' || apiStatus === 'failed' ? apiStatus : 'pending';
  return null; // state sections need a state source
}

// Phrases the pipeline must never write: "none located" and similar are a person's search finding, not a fact a feed can supply.
export const NEGATIVE_FINDING = /\b(none|no\b[^.]{0,40}\b)\s+(located|found|identified)\b|\bnot (located|found)\b|\bno (evidence|record|action|activity) (was |has been )?(located|found|identified)\b|\bas of [A-Z][a-z]+ \d{1,2}, 20\d\d, no\b/i;

// The confidence the pipeline may assign, by rule from where the facts came from.
export function confidenceFor(sourceKinds) {
  if (sourceKinds.length && sourceKinds.every((k) => k === 'primary')) return { level: 'HIGH', basis: 'primary_record' };
  if (sourceKinds.includes('primary')) return { level: 'MED-HIGH', basis: 'corroborated' };
  return { level: 'MED', basis: 'secondary' };
}
