// What kind of record a new state item is, decided by code from the LegiScan record and the bill's own text, before any AI reads it.
// LegiScan's facts are not trusted blindly: a placeholder title ("Site Information & Links"), an amendment filed as its own record
// (MA S3224, "Text of amendment (471) ... to the Ways and Means amendment (Senate, No. 3178)"), and resolutions and memorials (which
// are not bills and never go in A, B or B.2) are refused here. Each refusal is final for the record as it stands: the item is held
// with escalate set (no AI is spent on it), and it is read again only when its record changes.

// LegiScan bill_type_id: 1 bill, 2 resolution, 3 concurrent resolution, 4 joint resolution, 5 joint resolution (constitutional
// amendment), 8 memorial, 12 joint memorial, 16 concurrent memorial; 21 repeal bill and 23 committee bill are bills too.
const BILL_TYPES = new Set([1, 21, 23]), RESOLUTION_TYPES = new Set([2, 3, 4, 5]), MEMORIAL_TYPES = new Set([8, 12, 16]);
// A state resolution or memorial number: HR, SR, AR, HCR, SCR, ACR, HJR, SJR, AJR, HM, SM, HJM, SJM, HCM, SCM (any leading zeros).
const RESOLUTION_NUMBER = /^(?:[HSA])(?:C|J)?R\d+$/, MEMORIAL_NUMBER = /^(?:[HSA])(?:C|J)?M\d+$/;
const RESOLUTION_TEXT = /\b(?:(?:HOUSE|SENATE|ASSEMBLY|JOINT|CONCURRENT)\s+)?R\s?E\s?S\s?O\s?L\s?U\s?T\s?I\s?O\s?N\b(?:\s+No\.)?|\bBE IT RESOLVED\b/;
// The explicit form: a title that IS a resolution or memorial ("A Resolution urging ...", "House Joint Memorial ..."; not "the Dispute
// Resolution Act" or "Memorial Highway"), a MEMORIAL heading, and the resolving clause ("BE IT RESOLVED", "RESOLVED, That", "Resolved, That").
const RESOLUTION_FORM = /^\s*(?:(?:a|an)\s+)?(?:(?:house|senate|assembly|joint|concurrent|legislative|simple)\s+)*resolution\b|\b(?:house|senate|assembly|joint|concurrent)\s+(?:joint\s+|concurrent\s+)?resolution\b/i;
const MEMORIAL_FORM = /^\s*(?:(?:a|an)\s+)?(?:(?:house|senate|assembly|joint|concurrent)\s+)*memorial\b(?!\s+(?:highway|bridge|road|park|day|hospital|fund))|\b(?:house|senate|assembly)\s+(?:joint\s+|concurrent\s+)?memorial\b/i;
const MEMORIAL_HEAD = /\b(?:HOUSE|SENATE|ASSEMBLY|JOINT|CONCURRENT)\s+(?:JOINT\s+|CONCURRENT\s+)?MEMORIAL\b/;
const RESOLUTION_TITLE = /^\s*(?:urg(?:es|ing)\b|memoriali[sz]\w*|request(?:s|ing)\s+(?:the\s+)?(?:congress|federal|president|united\s+states|governor)|express(?:es|ing)\s+(?:support|opposition|the\s+sense|gratitude|concern)|commend\w*|congratulat\w*|recogni[sz](?:es|ing)\s+(?:the\s+)?(?:week|month|day|importance)|proclaim\w*|designat(?:es|ing)\b[^.;]{0,80}\b(?:day|week|month)\b)/i;
const RESOLVED_CLAUSE = /\bBE\s+IT\s+(?:FURTHER\s+)?RESOLVED\b|\bRESOLVED\b|\bResolved,\s+That\b/;

// 'bill' | 'resolution' | 'memorial' | 'other' (an executive order, a petition, a study request ...).
export function measureKind(bill = {}, text = '') {
  // The bill's own number and text come first: LegiScan's type field is not trusted on its own, so a record numbered or worded as a
  // resolution or memorial is one whatever bill_type_id says (code review S3). These are state numbering rules: this function is only
  // used on LegiScan (state) records, never on a Congress "H.R." bill (code review S2).
  const n = String(bill.bill_number || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]+)0+/, '$1');
  // Round 4: Virginia's and Montana's joint resolutions are numbered "HJ 45" / "SJ 12", Michigan's by letter ("HJR A", "SJR B").
  if (RESOLUTION_NUMBER.test(n) || /^LR\d+[A-Z]?$/.test(n) || /^[HS]J\d+$/.test(n) || /^[HS](?:J|C)R[A-Z]{1,2}$/.test(n)) return 'resolution';
  if (MEMORIAL_NUMBER.test(n)) return 'memorial';
  // An explicit resolution or memorial form wins over "a bill" / "an act" in the opening (round 3, audit item 8: a memorial "urging
  // Congress to enact a bill" is still a memorial): a title that names the form, a MEMORIAL heading, or the resolving clause.
  const head = String(text).slice(0, 1500), title = String(bill.title || '');
  if (MEMORIAL_FORM.test(title) || MEMORIAL_HEAD.test(head)) return 'memorial';
  if (RESOLUTION_FORM.test(title) || RESOLVED_CLAUSE.test(head)) return 'resolution';
  // Round 4: a resolution typed and numbered as a bill (a LegiScan typing error, or a header the text reader lost): the resolving clause
  // anywhere in the text, in any case ("Be It\nResolved by the Senate", after two pages of "Whereas" clauses), with no enacting clause;
  // or a title in the resolution form ("Urges ...", "Memorializes ...", "Expresses support ...", "Requests the Federal government ...").
  const all = String(text);
  if (/\bbe\s+it\s+(?:further\s+)?resolved\b|\bresolved\s+by\s+the\s+(?:senate|house|assembly|general\s+assembly|legislature)\b|\bresolved,\s+that\b/i.test(all) && !/\bbe\s+it\s+enacted\b|\bdo\s+enact\s+as\s+follows\b|\benacts?\s+as\s+follows\b/i.test(all)) return 'resolution';
  if (RESOLUTION_TITLE.test(title)) return 'resolution';
  if (RESOLUTION_TEXT.test(head) && !/\bA\s+BILL\b|\bAN\s+ACT\b/i.test(head)) return 'resolution';
  const t = Number(bill.bill_type_id);
  if (BILL_TYPES.has(t)) return 'bill';
  if (RESOLUTION_TYPES.has(t)) return 'resolution';
  if (MEMORIAL_TYPES.has(t)) return 'memorial';
  if (t) return 'other';
  return 'bill';
}

// A title that names no bill: LegiScan shows the legislature's page heading when it has nothing better.
export const PLACEHOLDER_TITLE = /^\s*(?:site information(?:\s*(?:&|and)\s*links)?|untitled|no title|title not available|not available|n\/?a|tbd|none|-+|\.+)\s*$/i;
export const placeholderTitle = (t) => !String(t || '').trim() || PLACEHOLDER_TITLE.test(String(t));

// An amendment filed as its own record: its text opens "Text of amendment (...) (offered by Senator ...) to ...", or its only history
// line points at another bill ("See S3178"), or LegiScan says it was replaced by another bill.
const AMENDMENT_TEXT = /\btext of amendment\b|\bamendment\s*\(\d+\)\s*\(offered by\b|\b(?:floor|committee)\s+amendment\s+(?:no\.?\s*)?\d+\s+to\b/i;
export function amendmentRecord(bill = {}, text = '') {
  if (AMENDMENT_TEXT.test(String(text).slice(0, 1200))) return 'its text is an amendment to another bill';
  const h = bill.history || [];
  if (h.length && h.every((x) => /^\s*see\s+[A-Z]{1,3}\s?\d+\s*$/i.test(x.action || ''))) return `its only history is a pointer to another bill ("${h[0].action}")`;
  if (/^\s*amendment\b/i.test(String(bill.title || ''))) return 'LegiScan titles it as an amendment';
  return null;
}

// A Congress record that is not a bill: a simple, concurrent or joint resolution (S.Res., H.Res., S.Con.Res., H.Con.Res., S.J.Res.,
// H.J.Res.). The tracker's federal sections D and F hold bills only (tracker.md lists no resolution in D or F), so none is ever created,
// like a state resolution, and no AI is spent on it (round 3, audit item 6: S.Res. 918 was published in F).
const FEDERAL_RESOLUTION_TYPES = new Set(['SRES', 'HRES', 'SCONRES', 'HCONRES', 'SJRES', 'HJRES']);
const FEDERAL_RES_LABEL = { SRES: 'S.Res.', HRES: 'H.Res.', SCONRES: 'S.Con.Res.', HCONRES: 'H.Con.Res.', SJRES: 'S.J.Res.', HJRES: 'H.J.Res.' };
export function federalType(item = {}, raw = {}) {
  const t = String((raw.bill && raw.bill.type) || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (t) return t;
  const m = /^congress_gov:\d+\/([a-z]+)\/\d+/.exec(String(item.item_id || ''));
  return m ? m[1].toUpperCase() : '';
}
export function federalRefusals(item = {}, raw = {}) {
  const t = federalType(item, raw), title = String((raw.bill && raw.bill.title) || item.title || '');
  if (FEDERAL_RESOLUTION_TYPES.has(t)) return [`a ${FEDERAL_RES_LABEL[t]} resolution, not a bill: sections D and F hold bills only, and the pipeline creates no entry for a resolution (reported)`];
  if (/^\s*(?:a|an)\s+(?:joint\s+|concurrent\s+)?resolution\b/i.test(title)) return ['titled as a resolution, not a bill: sections D and F hold bills only (reported)'];
  return subjectRefusals(title);
}

// ---------- round 4: measures that are never a new entry, by their own title ----------
// A budget or appropriations bill (NY A10000 / S09000, "Makes appropriations for the support of government - State Operations Budget",
// funds "the regulation of certain developers of AI frontier models"), a defence authorization act, and a bill that only extends a sunset
// or makes technical corrections: an AI provision inside such a measure is section I (provisions inside broader laws) or an update of the
// law it amends, never a new A, B, B.2, C, D or F entry. Held (reported), no AI spent.
// A substantive bill "making an appropriation therefor" is not a budget bill: the title must BE the appropriation (it opens with it, or
// names an Appropriations Act or a budget).
const BUDGET_TITLE = /^\s*(?:an\s+act\s+)?(?:making|makes|make|relating\s+to|general|supplemental|omnibus|consolidated|further\s+continuing|continuing)?\s*(?:general\s+|supplemental\s+)?appropriations?\b|\bappropriations?\s+act\b|\bbudget\b|\bnational\s+defen[cs]e\s+authorization\s+act\b|\brevenue\s+(?:and|&)\s+taxation\s+omnibus\b/i;
const AMENDS_ONLY_TITLE = /\bsunset\b|\b(?:extend|extends|extending|extension\s+of|delay|delays|delaying|postpone\w*)\b[^.;]{0,60}\b(?:repeal|expiration|termination|effective|operative|implementation|sunset)\s+dates?\b|\b(?:repeal|expiration|termination)\s+dates?\b|\btechnical\s+(?:corrections?|changes?|amendments?|revisions?|cleanup)\b|\bclean-?up\b|\bnonsubstantive\b/i;
export function subjectRefusals(title) {
  const t = String(title || ''), out = [];
  if (BUDGET_TITLE.test(t)) out.push(`a budget, appropriations or defence authorization measure ("${t.slice(0, 80)}"): an AI provision inside it is section I, which is never auto-created`);
  else if (AMENDS_ONLY_TITLE.test(t)) out.push(`a measure that only extends dates or makes technical changes ("${t.slice(0, 80)}"): it updates the law it amends and is never a new entry`);
  return out;
}

// Every reason code refuses to create an entry from this state record ([] when none). raw: the stored LegiScan record.
export function recordRefusals(raw = {}) {
  const b = raw.bill || {}, text = String(raw.text || ''), out = [];
  subjectRefusals(b.title).forEach((x) => out.push(x));
  // LegiScan's longer description is read for the budget form only (a new programme's description often names its own repeal date).
  // Only a description that OPENS as an appropriation or budget act counts (CT SB 86 and HI SB 2585, substantive AI bills, mention a budget
  // or an appropriation further on).
  if (!out.length && b.description && /^\s*(?:an\s+act\s+)?(?:making|makes)\s+(?:general\s+|supplemental\s+)?appropriations?\b|^\s*(?:the\s+)?(?:general\s+|state\s+)?budget\s+(?:act|bill)\b/i.test(String(b.description))) out.push(...subjectRefusals(String(b.description).slice(0, 160)).slice(0, 1));
  if (placeholderTitle(b.title)) out.push(`LegiScan gives a placeholder title ("${b.title || ''}"), not the bill's own`);
  const a = amendmentRecord(b, text);
  if (a) out.push(`an amendment record, not a bill: ${a}`);
  const k = measureKind(b, text);
  if (k === 'resolution' || k === 'memorial') out.push(`a ${k} (${b.bill_number}), not a bill: resolutions and memorials never go in sections A, B or B.2, and the pipeline creates no entry for them (reported)`);
  else if (k === 'other') out.push(`LegiScan type ${b.bill_type || b.bill_type_id} (${b.bill_number}) is not a bill`);
  return out;
}
