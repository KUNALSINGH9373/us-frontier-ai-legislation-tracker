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
// Round 3: PDF-split words ("cove red model", "floa ting - point") are matched by loose(): one optional space between any two letters.
// "Covered model" (NC S735, the SB 1047 family) and a threshold in words ("10 to the 26th power", "10 to the power of 25") count too.
const loose = (w) => [...w].map((c, i) => (c === '-' ? String.raw`\s?[- ]?\s?` : c + (i < w.length - 1 && w[i + 1] !== '-' ? String.raw`\s?` : ''))).join('');
const THRESHOLD_SRC = [String.raw`\b(?:large\s+)?frontier\s+(?:developers?|models?|artificial\s+intelligence)\b`, String.raw`\b10\s?\^\s?2\d\b`, String.raw`\b10[.,]?2\d\s+(?:integer|floating|computational|operations)`,
  String.raw`\b10\s+to\s+the\s+(?:power\s+of\s+)?2\d(?:st|nd|rd|th)?\b`, String.raw`\b${loose('floating-point')}\s+${loose('operations')}`, String.raw`\bcomputational\s+operations\b`, String.raw`\bFLOPs?\b`,
  String.raw`\b${loose('large')}\s+${loose('developer')}s?\b`, String.raw`\b${loose('covered')}\s+(?:frontier\s+)?${loose('model')}s?\b`, String.raw`\b${loose('frontier')}\s+${loose('model')}s?\b`].join('|');
const CATASTROPHIC_SRC = String.raw`\bcatastrophic\s+risks?\b|\bcritical\s+(?:safety\s+)?(?:harms?|risks?|incidents?)\b|\bmass\s+casualt\w*|\bchemical,?\s+biological\b|\bweapons?\s+of\s+mass\s+destruction\b|\bloss\s+of\s+control\b`;
// C must be about AI: an auditor or verification-organization term counts only with an AI term near it (NJ S1927's compost "third-party
// independent verification organization" is not an AI auditor).
const AI_CONTEXT = /\b(?:artificial\s+intelligence|AI|machine\s+learning|algorithm\w*|frontier\s+models?|foundation\s+models?)\b/i;
const AUDITOR_SRC = String.raw`\bindependent\s+verification\s+organi[sz]ations?\b|\b(?:AI|artificial\s+intelligence)\s+auditors?\b|\b(?:licens|certif|accredit)\w*\s+(?:of\s+)?(?:independent\s+)?(?:third[- ]party\s+)?(?:AI\s+)?auditors?\b|\bthird[- ]party\s+auditors?\b[^.]{0,80}\b(?:licens|certif|accredit)\w*`;
const re = (src, g = '') => new RegExp(src, 'i' + g);
export const SECTION_MARKERS = { A: THRESHOLD_SRC, B: THRESHOLD_SRC, 'B.2': CATASTROPHIC_SRC, C: AUDITOR_SRC };
// Defined below the federal criteria (D_SRC, F_RISK_SRC): SECTION_MARKERS.D and .F are added there.
export const SECTION_CRITERIA = {
  A: 'an enacted law that puts binding duties on frontier or large AI developers defined by a frontier threshold (training compute such as 10^26 operations, a "frontier model" or "large developer" definition)',
  B: 'a bill that puts binding duties on frontier or large AI developers defined by a frontier threshold (training compute such as 10^26 operations, a "frontier model" or "large developer" definition)',
  'B.2': 'a bill that puts duties about catastrophic risk (catastrophic risk, critical harm, chemical, biological, radiological or nuclear weapons, mass casualties, loss of control) on AI developers, without any compute or frontier threshold',
  C: 'a measure on who may audit or verify AI developers: independent verification organizations, or the licensing, certification or accreditation of AI auditors',
  D: 'a federal bill that puts binding duties on frontier, large or advanced-AI developers or their models, defined by a frontier threshold or definition (training compute such as 10^26 operations, a "frontier model", "covered model" or "large developer" definition)',
  F: 'an adjacent or sectoral federal AI-risk bill: AI testing, evaluation, safety, reliability or incident-reporting programs (including defence and intelligence-community AI safety), AI whistleblower protection, independent verification or AI auditors, preemption of state AI laws, export or security rules for AI chips, compute or model weights, control of autonomous AI agents, or catastrophic-risk work; NOT government procurement or use of AI, privacy or civil-liberties reports on agency use of AI, sector-only rules, deepfakes, children\'s online safety, or workforce, energy or data-centre studies'
};
// ---------- the federal sections' criteria, in code (round 3, audit item 6) ----------
// D  Federal frontier-AI bills: binding duties on frontier, large or advanced-AI developers or models (a frontier threshold or definition).
// F  Adjacent and sectoral federal bills (tracker.md section F; the scope definition's IN types): a federal AI-risk measure that is not
//    general frontier-developer regulation: AI testing, evaluation, safety, reliability or incident programs (NIST, DoD, the intelligence
//    community), AI whistleblower protection, independent verification or AI auditors, preemption of state AI laws, export or security
//    rules for AI chips, compute or model weights, control of autonomous AI agents, catastrophic-risk work. OUT (the scope's OUT list):
//    government procurement or use of AI, privacy and civil-liberties reports on agency use (H.R. 10502, AI use under section 702),
//    sector-only rules, deepfakes, children's online safety, workforce or energy studies. A passage meets F only with an AI term near
//    one of those risk terms, and never when it is only about agency use, procurement, privacy or civil liberties.
const AI_SRC = String.raw`artificial\s+intelligence|\bAI\b|machine\s+learning|frontier\s+models?|foundation\s+models?`;
const D_SRC = `${THRESHOLD_SRC}|\\badvanced\\s+(?:artificial\\s+intelligence|AI)\\s+(?:models?|systems?|developers?)\\b`;
const F_RISK_SRC = String.raw`\b(?:safety|reliab\w+|testing|tests?|evaluat\w+|red[- ]team\w*|incidents?|vulnerabilit\w+|security\s+risks?|misuse|model\s+weights|dangerous\s+capabilit\w+|whistleblow\w*|preempt\w*|export\s+controls?|advanced\s+(?:computing\s+)?(?:chips?|semiconductors?|integrated\s+circuits?)|autonomous\s+(?:AI\s+)?agents?|loss\s+of\s+control)\b`;
const F_OUT = /\bcivil\s+liberties\b|\bprivacy\b|\bsection\s+702\b|\bprocure\w*|\bacquisition\s+of\s+(?:AI|artificial)|\bdeepfakes?\b|\bchildren\b|\bminors?\b|\bworkforce\b|\bdata\s+cent(?:er|re)s?\b/i;
SECTION_MARKERS.D = D_SRC;
SECTION_MARKERS.F = `${THRESHOLD_SRC}|${CATASTROPHIC_SRC}|${F_RISK_SRC}`;
function fPassage(t) {
  const d = new RegExp(`${THRESHOLD_SRC}|${CATASTROPHIC_SRC}`, 'i').exec(t);
  if (d) return t.slice(Math.max(0, d.index - 150), d.index + 150);
  for (const m of t.matchAll(re(F_RISK_SRC, 'g'))) {
    const w = t.slice(Math.max(0, m.index - 250), m.index + m[0].length + 250);
    if (!re(AI_SRC).test(w)) continue;
    // The risk word must not be one of the OUT subjects' own words in the same sentence (privacy "safeguards" on agency use).
    const sentence = t.slice(Math.max(0, t.lastIndexOf('.', m.index) + 1), (t.indexOf('.', m.index + m[0].length) + 1 || t.length));
    if (F_OUT.test(sentence)) continue;
    return t.slice(Math.max(0, m.index - 150), m.index + 150);
  }
  return null;
}

// A passage (up to 300 characters) of text that meets the section's criterion, or null.
// A threshold term defines who is regulated, whatever the bill calls them (AZ H.B. 4098: an "artificial intelligence business" is one using
// a frontier model of a large developer), so any binding duty near it counts. A catastrophic-risk term is common in general AI bills (a
// risk-assessment list), so for B.2 the duty must be on a developer or deployer.
const ANY_DUTY = /\b(?:shall|must|may not|is required to)\b/i;
// The duty may sit some way from the definition that names who is regulated (definitions first, duties a section or two later): 4000
// characters either side.
const WINDOW = 4000;
function dutyNear(t, src, duty) {
  for (const m of t.matchAll(re(src, 'g'))) { const w = t.slice(Math.max(0, m.index - WINDOW), m.index + WINDOW); if (duty.test(w)) return t.slice(Math.max(0, m.index - 150), m.index + 150); }
  return null;
}
function aiAuditor(t) {
  for (const m of t.matchAll(re(AUDITOR_SRC, 'g'))) if (AI_CONTEXT.test(m[0]) || AI_CONTEXT.test(t.slice(Math.max(0, m.index - 400), m.index + m[0].length + 400))) return t.slice(Math.max(0, m.index - 150), m.index + 150);
  return null;
}
export function sectionPassage(section, text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (section === 'A' || section === 'B') return dutyNear(t, THRESHOLD_SRC, ANY_DUTY);
  // B.2 is for a text WITHOUT a frontier threshold: refused when the text meets B (a threshold with a duty near it), not because a threshold
  // word appears somewhere in passing.
  if (section === 'B.2') return dutyNear(t, THRESHOLD_SRC, ANY_DUTY) ? null : dutyNear(t, CATASTROPHIC_SRC, DUTY_ON_DEVELOPER);
  if (section === 'C') return aiAuditor(t);
  if (section === 'D') return dutyNear(t, D_SRC, ANY_DUTY);
  if (section === 'F') return fPassage(t);
  return null;
}
// The sections among `allowed` whose criterion the text meets (in the order given).
export const sectionsByCode = (text, allowed) => allowed.filter((s) => !!sectionPassage(s, text));
// Does a referee's quote meet the section's own criterion? (The quote must also be in the source; callers check that.)
// source (optional): the record's text. For F a quote is read in its place in the text (250 characters either side, the same window
// fPassage uses), so a quote naming the provision ("assess ... any risk related to ... foreign adversary models") counts when its own
// passage is about AI risk; the passage must still meet F (an AI term near a risk term, none of the OUT subjects).
export const quoteMeetsSection = (section, quote, source = null) => {
  if (section === 'F' && source) {
    const ns = String(source).replace(/\s+/g, ' ').toLowerCase(), nq = String(quote || '').replace(/\s+/g, ' ').trim().toLowerCase(), at = nq.length >= 8 ? ns.indexOf(nq) : -1;
    if (at >= 0) { const raw = String(source).replace(/\s+/g, ' '); if (fPassage(raw.slice(Math.max(0, at - 250), at + nq.length + 250))) return true; }
  }
  const q = String(quote || '').replace(/\s+/g, ' ');
  if (!SECTION_MARKERS[section] || !re(SECTION_MARKERS[section]).test(q)) return false;
  if (section === 'B.2') return !re(THRESHOLD_SRC).test(q);
  if (section === 'C') return !!aiAuditor(q);
  if (section === 'F') return !!fPassage(q);
  return true;
};
// The federal sections whose criterion code checks (a federal bill's referee quote must meet it; tier B checks it again).
export const FEDERAL_CHECKED_SECTIONS = ['D', 'F'];

// Problems with a state section for a record of this kind ('bill' | 'resolution' | 'memorial' | 'other', agents/record-kind.mjs) and text.
export function stateSectionProblems(section, kind, text) {
  const out = [];
  if (['A', 'B', 'B.2'].includes(section) && kind && kind !== 'bill') out.push(`a ${kind} never goes in section ${section} (A, B and B.2 hold bills and laws)`);
  if (section === 'A' && text != null && !frontierDutyPassage(text)) out.push('section A needs an enacted text with binding duties on frontier or large AI developers or their models, and none was found in this text; choose C if its subject is independent verification or AI auditors');
  if (SECTION_MARKERS[section] && text != null && !sectionPassage(section, text)) out.push(`section ${section} needs ${SECTION_CRITERIA[section]}, and no passage of this text meets it`);
  return out;
}
