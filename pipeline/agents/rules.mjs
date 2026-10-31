// The tracker's own classification rules, written once and applied by code. The LLM may suggest a section,
// but status, type, level and confidence are decided here, so they cannot drift or be talked into something.
import { loose, LOST_EXPONENT, COMPUTE_POWER_PHRASE } from './text-norm.mjs';

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
// Round 3: PDF-split words ("cove red model", "floa ting - point") are matched by loose() (agents/text-norm.mjs): one optional space
// between any two letters. The lost exponent and the power in words are text-norm's single patterns, shared with every check.
// "Covered model" (NC S735, the SB 1047 family) and a threshold in words ("10 to the 26th power", "10 to the power of 25") count too.
const THRESHOLD_SRC = [String.raw`\b(?:large\s+)?frontier\s+(?:developers?|models?|artificial\s+intelligence)\b`, String.raw`\b10\s?\^\s?2\d\b`, LOST_EXPONENT.source,
  COMPUTE_POWER_PHRASE, String.raw`\b${loose('floating-point')}\s+${loose('operations')}`, String.raw`\bcomputational\s+operations\b`, String.raw`\bFLOPs?\b`,
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
const F_RISK_SRC = String.raw`\b(?:safety|reliab\w+|testing|tests?|evaluat\w+|red[- ]team\w*|incidents?|vulnerabilit\w+|security\s+risks?|misuse|model\s+weights|dangerous\s+capabilit\w+|whistleblow\w*|preempt\w*|export\s+controls?|exports?\s+(?:of|licen[cs]\w*)|(?:advanced|AI)\s+(?:AI\s+|computing\s+)?(?:chips?|semiconductors?|integrated\s+circuits?)|autonomous\s+(?:AI\s+)?agents?|loss\s+of\s+control)\b`;
const F_OUT = /\bcivil\s+liberties\b|\bprivacy\b|\bsection\s+702\b|\bprocure\w*|\bacquisition\s+of\s+(?:AI|artificial)|\bdeepfakes?\b|\bchildren\b|\bminors?\b|\bworkforce\b|\bdata\s+cent(?:er|re)s?\b/i;
SECTION_MARKERS.D = D_SRC;
SECTION_MARKERS.F = `${THRESHOLD_SRC}|${CATASTROPHIC_SRC}|${F_RISK_SRC}`;
// Round 4: generic words ("evaluation", "testing") count only right next to an AI term ("evaluation of artificial intelligence models",
// "AI testing"): a table of contents line "National center for education evaluation" after an AI heading (H.R. 10515, an education and
// workforce bill), or "an evaluation of capability for artificial intelligence integration" in a drone strategy (S. 4633), is not AI-risk
// work. Every other risk word needs an AI term in its own sentence; a frontier or catastrophic-risk term needs one within 1500 characters
// (H.R. 10152 lists "chemical, biological, radiological, or nuclear capabilities" among the risks of foreign adversary AI models).
const F_GENERIC = /^(?:testing|tests?|evaluat\w+)$/i;
const sentenceAt = (t, i, n) => t.slice(Math.max(0, t.lastIndexOf('.', i) + 1), (t.indexOf('.', i + n) + 1 || t.length));
function fPassage(t) {
  for (const d of t.matchAll(new RegExp(`${THRESHOLD_SRC}|${CATASTROPHIC_SRC}`, 'gi'))) {
    if (re(AI_SRC).test(t.slice(Math.max(0, d.index - 1500), d.index + d[0].length + 1500))) return t.slice(Math.max(0, d.index - 150), d.index + 150);
  }
  for (const m of t.matchAll(re(F_RISK_SRC, 'g'))) {
    const sentence = sentenceAt(t, m.index, m[0].length);
    if (F_GENERIC.test(m[0])) {
      // "testing and evaluation of artificial intelligence systems", "AI safety testing": the AI term within 40 characters, same sentence.
      const near = t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
      if (!re(AI_SRC).test(near) || !re(AI_SRC).test(sentence)) continue;
      if (!/\b(?:of|for|on)\s+(?:the\s+)?(?:(?:advanced|frontier|covered|foundation|dual-use)\s+)?(?:artificial\s+intelligence|AI)\s+(?:models?|systems?|capabilit\w+)|\b(?:artificial\s+intelligence|AI)\s+(?:safety\s+|security\s+|model\s+|system\s+)?(?:testing|tests?|evaluat\w+)/i.test(near)) continue;
    } else if (!re(AI_SRC).test(sentence)) continue;
    // The risk word must not be one of the OUT subjects' own words in the same sentence (privacy "safeguards" on agency use).
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
// Round 4: for A and B the duty near the threshold is laid on a regulated party (a developer, deployer, operator, business, company,
// person or entity, or the frontier term itself), not only on a commission ("the Commission shall direct State agencies to assess the impact
// of frontier artificial intelligence systems on workers", IL HB 5760) or a definition ("computing power ... shall include").
const PARTY_DUTY = new RegExp(String.raw`\b(?:developers?|deployers?|operators?|business(?:es)?|compan(?:y|ies)|persons?|entit(?:y|ies)|providers?|licensees?|frontier\s+(?:models?|developers?))\b[^.;]{0,150}\b(?:shall|must|may not|is required to)\b|\b(?:shall|must)\b[^.;]{0,250}\b(?:large\s+)?frontier\s+(?:\d{1,4}\s+)?developers?\b`, 'i');
// The duty may sit some way from the definition that names who is regulated (definitions first, duties a section or two later): 4000
// characters either side.
const WINDOW = 4000;
function dutyNear(t, src, duty, { ai = false } = {}) {
  for (const m of t.matchAll(re(src, 'g'))) {
    const w = t.slice(Math.max(0, m.index - WINDOW), m.index + WINDOW);
    if (!duty.test(w)) continue;
    // Round 4: the term must be about AI ("a large developer shall provide affordable units" is a housing bill; "chemical, biological"
    // hazards in a pesticide bill are not catastrophic AI risk).
    if (ai && !AI_CONTEXT.test(t.slice(Math.max(0, m.index - 1500), m.index + m[0].length + 1500))) continue;
    return t.slice(Math.max(0, m.index - 150), m.index + 150);
  }
  return null;
}
// ---------- round 4: an OPERATIVE frontier threshold ----------
// A frontier phrase in passing never makes a frontier-developer bill: findings that name "the Joint California Policy Working Group on AI
// Frontier Models" (CA SB 833), members of "the Frontier Model Forum" (a resolution), a workforce commission assessing "frontier artificial
// intelligence systems" (IL HB 5760), a budget line for "the regulation of certain developers of AI frontier models" (NY A10000), or a tax
// "measured in floating-point operations per second" (NJ S4712). Sections A, B and D need the bill to set the threshold itself: a compute
// figure (10^26, "10 to the 26th power", "10.26 operations" with its superscript lost, a number of floating-point operations or FLOPs) or
// a definition of the regulated term ('"frontier model" means', '"large developer" has the meaning', "Covered model. An artificial
// intelligence model ..."), with a binding duty near it, as before.
const NUM_THRESHOLD_SRC = [String.raw`\b10\s?\^\s?2\d\b`, LOST_EXPONENT.source, COMPUTE_POWER_PHRASE,
  String.raw`\d[\d,.]*\s*(?:x\s*10\s?\^?\s?\d+\s*)?(?:(?:integer|computational)\s+or\s+)?${loose('floating-point')}\s+${loose('operations')}(?!\s+per\s+second)`, String.raw`\d[\d,.]*\s+FLOPs?\b`].join('|');
// State A/B: frontier, large-developer and covered-model terms; federal D also counts "advanced AI" models or systems (S. 5417). An
// "advanced artificial intelligence system" licence in a state bill (NY A03356) is not a frontier threshold.
const TERM_STATE = String.raw`(?:(?:large\s+)?${loose('frontier')}\s+(?:${loose('developer')}s?|${loose('model')}s?|artificial\s+intelligence(?:\s+models?)?|AI\s+models?)|${loose('large')}\s+${loose('developer')}s?|${loose('covered')}\s+(?:frontier\s+)?${loose('model')}s?)`;
const TERM_FED = String.raw`(?:${TERM_STATE}|advanced\s+(?:artificial\s+intelligence|AI)\s+(?:models?|systems?|developers?))`;
const definitionSrc = (TERM_SRC) => [String.raw`["“”'‘’]\s*${TERM_SRC}\s*["“”'‘’]?\s*,?\s*(?:means|has\s+the\s+(?:same\s+)?meaning|shall\s+mean|includes)\b`,
  String.raw`\b${TERM_SRC}\s*["“”'‘’]?\s*,?\s*(?:means|has\s+the\s+(?:same\s+)?meaning|shall\s+mean)\b`, String.raw`\b${TERM_SRC}\s*["”’]?\s*,?\s*as\s+(?:such\s+term\s+is\s+)?defined\s+(?:in|by|under)\b`,
  String.raw`(?:^|[.;:)]\s*|\(\w{1,4}\)\s*|\d+\s+)${TERM_SRC}\.\s+(?:An?|The)\s+(?:artificial\s+intelligence|AI|person|entity|developer|model)\b`].join('|');
// A bill that amends a frontier law uses the law's defined terms without defining them again (NY S.10373: "A large frontier developer
// shall annually retain ... a third party verifier"; S. 5417: "Each covered entity shall ensure that the advanced artificial intelligence
// system ..."), and a compute threshold can be a cost (IL HB 3506: "computational power that costs at least $100,000,000"). A regulated-party
// term as the subject of a duty, a duty laid on (or regulations made for) frontier developers, and a defined party built on the term count.
// General phrases ("frontier artificial intelligence systems", "frontier models") count only when defined or with a compute figure.
const DUTY_WORD = String.raw`(?:shall|must|may\s+not|is\s+required\s+to|are\s+required\s+to)`;
// LN: a printed line number between two words (NY: "to require large frontier 6 developers' frontier AI frameworks").
const LN = String.raw`\s+(?:\d{1,4}\s+)?`;
const useSrc = (TERM_SRC, fed) => [String.raw`\b(?:large${LN})?frontier${LN}developers?\b[^.;]{0,60}\b${DUTY_WORD}`, String.raw`\b(?:shall|must)\b[^.;]{0,250}\b(?:large${LN})?frontier${LN}developers?\b`,
  String.raw`\b(?:large\s+developers?|covered\s+(?:frontier\s+)?models?${fed ? String.raw`|advanced\s+(?:artificial\s+intelligence|AI)\s+(?:models?|systems?)` : ''})\b[^.;]{0,60}\b${DUTY_WORD}`,
  String.raw`\bshall\s+ensure\s+that\s+(?:the|each|any|its|every)\s+(?:${fed ? 'advanced|' : ''}frontier|covered)\s+(?:artificial\s+intelligence\s+|AI\s+)?(?:models?|systems?)\b`,
  String.raw`\bmeans\b[^.;]{0,150}\b(?:develops?|trains?|deploys?|operates?|developed|trained)\b[^.;]{0,40}${TERM_SRC}`,
  String.raw`\b(?:computational|computing|compute)\s+(?:power|resources|costs?)\b[^.;]{0,120}\$\s?\d[\d,.]*`].join('|');
const OPERATIVE_SRC = `${NUM_THRESHOLD_SRC}|${definitionSrc(TERM_STATE)}|${useSrc(TERM_STATE, false)}`;
const OPERATIVE_FED_SRC = `${NUM_THRESHOLD_SRC}|${definitionSrc(TERM_FED)}|${useSrc(TERM_FED, true)}`;
export const operativeThreshold = (text) => { const t = String(text || '').replace(/\s+/g, ' '); const m = re(OPERATIVE_SRC).exec(t); return m ? m[0] : null; };
function aiAuditor(t) {
  for (const m of t.matchAll(re(AUDITOR_SRC, 'g'))) if (AI_CONTEXT.test(m[0]) || AI_CONTEXT.test(t.slice(Math.max(0, m.index - 400), m.index + m[0].length + 400))) return t.slice(Math.max(0, m.index - 150), m.index + 150);
  return null;
}
export function sectionPassage(section, text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  // Round 4: an operative threshold (a compute figure or a definition), about AI, with a binding duty near it.
  if (section === 'A' || section === 'B') return dutyNear(t, OPERATIVE_SRC, PARTY_DUTY, { ai: true });
  // B.2 is for a text WITHOUT a frontier threshold: refused when the text meets B (a threshold with a duty near it), not because a threshold
  // word appears somewhere in passing.
  if (section === 'B.2') return dutyNear(t, OPERATIVE_SRC, PARTY_DUTY, { ai: true }) ? null : dutyNear(t, CATASTROPHIC_SRC, DUTY_ON_DEVELOPER, { ai: true });
  if (section === 'C') return aiAuditor(t);
  if (section === 'D') return dutyNear(t, OPERATIVE_FED_SRC, ANY_DUTY, { ai: true });
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
    if (at >= 0) {
      const raw = String(source).replace(/\s+/g, ' ');
      if (fPassage(raw.slice(Math.max(0, at - 250), at + nq.length + 250))) return true;
      // A frontier or catastrophic-risk term in the quote itself, with an AI term within 1500 characters of it (fPassage's own window).
      if (new RegExp(`${THRESHOLD_SRC}|${CATASTROPHIC_SRC}`, 'i').test(quote) && re(AI_SRC).test(raw.slice(Math.max(0, at - 1500), at + nq.length + 1500))) return true;
    }
  }
  const q = String(quote || '').replace(/\s+/g, ' ');
  if (!SECTION_MARKERS[section] || !re(SECTION_MARKERS[section]).test(q)) return false;
  // Round 4: with the record's text, the text itself must meet the section (an operative threshold with a duty for A, B and D; AI
  // catastrophic-risk duties for B.2): a quote of a frontier phrase in passing ("the Frontier Model Forum") never proves A, B or D.
  if (source != null && ['A', 'B', 'B.2', 'D'].includes(section) && !sectionPassage(section, source)) return false;
  if (section === 'B.2') return !re(THRESHOLD_SRC).test(q);
  if (section === 'C') return !!aiAuditor(q);
  // Without the record's text a frontier or catastrophic-risk term in the quote is taken as it stands (its AI context cannot be read).
  if (section === 'F') return !!fPassage(q) || (source == null && new RegExp(`${THRESHOLD_SRC}|${CATASTROPHIC_SRC}`, 'i').test(q));
  return true;
};
// Round 4: a federal bill whose own title names one of F's OUT subjects (H.R. 10515, "Artificial Intelligence Education and Workforce
// Readiness Act": AI "safety" and "incident response" appear only in a list of what students learn) is never filed in F by code; it may still
// be D when it meets D's criterion.
export const F_TITLE_OUT = /\b(?:education\w*|students?|schools?|workforce|workers?|jobs?|employment|apprentic\w+|children|child|kids|minors?|youth|deepfakes?|data\s+cent(?:er|re)s?|energy|electricity|privacy|procurement|acquisition|health(?:\s+care)?|medicare|medicaid|agricultur\w*|farm\w*|veterans?)\b/i;
export const fTitleOut = (title) => F_TITLE_OUT.test(String(title || '').replace(/^[^—]*—\s*/, (m) => (/^\s*(?:H\.R\.|S\.)/.test(m) ? '' : m)));
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
