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

// 'bill' | 'resolution' | 'memorial' | 'other' (an executive order, a petition, a study request ...).
export function measureKind(bill = {}, text = '') {
  // The bill's own number and text come first: LegiScan's type field is not trusted on its own, so a record numbered or worded as a
  // resolution or memorial is one whatever bill_type_id says (code review S3). These are state numbering rules: this function is only
  // used on LegiScan (state) records, never on a Congress "H.R." bill (code review S2).
  const n = String(bill.bill_number || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]+)0+/, '$1');
  if (RESOLUTION_NUMBER.test(n)) return 'resolution';
  if (MEMORIAL_NUMBER.test(n)) return 'memorial';
  if (RESOLUTION_TEXT.test(String(text).slice(0, 1500)) && !/\bA\s+BILL\b|\bAN\s+ACT\b/i.test(String(text).slice(0, 1500))) return 'resolution';
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

// Every reason code refuses to create an entry from this state record ([] when none). raw: the stored LegiScan record.
export function recordRefusals(raw = {}) {
  const b = raw.bill || {}, text = String(raw.text || ''), out = [];
  if (placeholderTitle(b.title)) out.push(`LegiScan gives a placeholder title ("${b.title || ''}"), not the bill's own`);
  const a = amendmentRecord(b, text);
  if (a) out.push(`an amendment record, not a bill: ${a}`);
  const k = measureKind(b, text);
  if (k === 'resolution' || k === 'memorial') out.push(`a ${k} (${b.bill_number}), not a bill: resolutions and memorials never go in sections A, B or B.2, and the pipeline creates no entry for them (reported)`);
  else if (k === 'other') out.push(`LegiScan type ${b.bill_type || b.bill_type_id} (${b.bill_number}) is not a bill`);
  return out;
}
