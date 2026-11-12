// A lawsuit's claims and how each fared (entry.claims), from the case's own checked record (entryText): writer -> code -> reviewer,
// one rewrite round. Each claim carries a quote from the record that code finds; its outcome is "won", "lost" or "unclear" only when
// the record states a ruling on it, else "pending". The link is the case's court record from the entry's sources. All or nothing:
// if any claim still fails, no claims are kept (a partial list would misstate the case).
import { entryText } from './layout.mjs';
import { containsQuote } from '../agents/source-text.mjs';
import { pageFieldProblems } from '../schema/integrity.mjs';

const S = (extra = {}) => ({ type: 'STRING', ...extra });
const OUTCOMES = ['won', 'lost', 'unclear', 'pending'];
export const CLAIMS_SCHEMA = { type: 'OBJECT', required: ['claims'], properties: { claims: { type: 'ARRAY', items: { type: 'OBJECT', required: ['label', 'outcome', 'note', 'quote'], properties: { label: S(), outcome: S({ enum: OUTCOMES }), note: S(), quote: S() } } } } };
export const CLAIMS_SYSTEM = `You list the claims of one lawsuit tracked on a site about US frontier-AI law, and how each has fared, for readers who are not lawyers.

Use ONLY ENTRY TEXT, the case's checked record. List the claims (counts) as the record names them, in its order. If the record does not list separate claims, return an empty list.
- label: the claim in a few plain words, keeping its number if the record numbers it ("I. Beyond the statute (APA, 10 U.S.C. § 3252)"). At most 120 characters.
- outcome: "won" or "lost" (for the party that brought the claim) only when ENTRY TEXT states the court's ruling on that claim; "unclear" when a ruling exists but ENTRY TEXT does not say how it treated this claim; "pending" when no ruling on it is recorded.
- note: at most one short sentence from the record that explains the outcome, or an empty string.
- quote: an exact span of ENTRY TEXT (copied character for character, 6 to 200 characters) that names this claim.
Add nothing from your own knowledge.`;
export const CLAIMS_REVIEW_SCHEMA = { type: 'OBJECT', required: ['verdicts'], properties: { verdicts: { type: 'ARRAY', items: { type: 'OBJECT', required: ['n', 'verdict', 'problem', 'support'], properties: { n: { type: 'INTEGER' }, verdict: S({ enum: ['ok', 'wrong', 'misleading'] }), problem: S(), support: S() } } }, missing: S() } };
export const CLAIMS_REVIEW_SYSTEM = `You are the independent fact-checker of a lawsuit's claim list on a site about US frontier-AI law. Nothing is published unless you pass it.
Check each numbered claim against ENTRY TEXT only. "ok": the claim is in the record as labelled and its outcome is exactly what the record supports ("won"/"lost" only with a stated ruling on that claim; "unclear" when the record gives a ruling but not on this claim; "pending" when no ruling is recorded). "wrong": the label or outcome is not supported. "misleading": a reader would get a false picture. For "ok" give in "support" one exact quote from ENTRY TEXT (6 to 200 characters) that proves the outcome. In "missing", name any claim the record lists that the draft leaves out (empty string if none).`;

const clean = (c) => ({ label: String(c.label || '').trim(), outcome: c.outcome, note: String(c.note || '').trim(), quote: String(c.quote || '').trim() });
// Plain-code checks; returns problems by claim number (1-based) plus "all".
export function checkClaims({ entry, claims }) {
  const text = entryText(entry), p = {};
  const put = (k, m) => { (p[k] ||= []).push(m); };
  if (!claims.length) put('all', 'no claims listed');
  claims.forEach((c, i) => {
    const n = i + 1;
    if (c.label.length < 3 || c.label.length > 160 || /[\n{}<>]/.test(c.label)) put(n, 'the label must be 3 to 160 characters, no markup');
    if (!OUTCOMES.includes(c.outcome)) put(n, `outcome "${c.outcome}" is not won, lost, unclear or pending`);
    if (c.note && (c.note.length > 240 || /[\n{}<>]/.test(c.note))) put(n, 'the note must be one short sentence, no markup');
    if (!c.quote || !containsQuote(text, c.quote)) put(n, `its quote is not in ENTRY TEXT: "${c.quote.slice(0, 60)}"`);
  });
  pageFieldProblems({ ...entry, claims: claims.map(({ label, outcome, note }) => ({ label, outcome, ...(note ? { note } : {}) })), page_verification: { method: 'agent', checked_at: new Date().toISOString() } })
    .filter((m) => /claims\[(\d+)\]/.test(m)).forEach((m) => put(+/claims\[(\d+)\]/.exec(m)[1] + 1, m.replace(/^[^:]+: /, '')));
  return p;
}

// The court-record link for decided claims: a source on a court-record host. When the title gives the case number, the link must be
// a record of that case (an entry's sources may include a related case's record); no matching record, no link and no claims.
const COURT = /courtlistener\.com|justia\.com|uscourts\.gov|clearinghouse\.net|pacer/i;
export function courtLink(entry) {
  const court = (entry.sources || []).filter((s) => COURT.test(s.url));
  const m = /\bNos?\.\s+([\w:.-]+)/.exec(entry.title);
  if (!m) return (court[0] || {}).url || null;
  const digits = (s) => String(s).replace(/\D/g, ''), want = digits(m[1]).replace(/^(\d{2})(?=\d{6,}$)/, '$1').slice(-6);
  return (court.find((s) => digits(s.url).includes(want) || digits(s.label || '').includes(want)) || {}).url || null;
}

export async function writeClaims({ entry, writer, reviewer, log = () => {} }) {
  const text = entryText(entry), link = courtLink(entry), itemId = 'claims:' + entry.key;
  if (!link) return { key: entry.key, claims: null, reason: 'no court-record link among the sources' };
  let complaints = [];
  for (let round = 1; round <= 2; round++) {
    const w = await writer.generate({ system: CLAIMS_SYSTEM, prompt: ['ENTRY TEXT:', text, ...(complaints.length ? ['', 'YOUR PREVIOUS LIST WAS REFUSED. Fix exactly these problems:', ...complaints.map((c) => '- ' + c)] : [])].join('\n'), responseSchema: CLAIMS_SCHEMA, itemId: `${itemId}:w${round}` });
    const claims = (w.data.claims || []).map(clean);
    if (!claims.length) return { key: entry.key, claims: null, reason: 'the record lists no separate claims' };
    const probs = checkClaims({ entry, claims });
    if (Object.keys(probs).length) { complaints = Object.entries(probs).map(([n, m]) => `claim ${n}: ${m.join('; ')}`); log(`${entry.key} round ${round}: code refused ${Object.keys(probs).join(', ')}`); continue; }
    const r = await reviewer.generate({ system: CLAIMS_REVIEW_SYSTEM, prompt: ['ENTRY TEXT:', text, '', 'CLAIMS:', ...claims.map((c, i) => `${i + 1}. ${c.label} — ${c.outcome}${c.note ? ' (' + c.note + ')' : ''}`)].join('\n'), responseSchema: CLAIMS_REVIEW_SCHEMA, itemId: `${itemId}:r${round}` });
    const by = Object.fromEntries((r.data.verdicts || []).map((v) => [v.n, v]));
    const bad = claims.map((c, i) => { const v = by[i + 1]; if (!v) return `claim ${i + 1}: the reviewer gave no verdict`; if (v.verdict !== 'ok') return `claim ${i + 1}: ${v.verdict}: ${v.problem}`; if (!v.support || !containsQuote(text, v.support)) return `claim ${i + 1}: passed without a support quote found in ENTRY TEXT`; return null; }).filter(Boolean);
    if (r.data.missing && r.data.missing.trim()) bad.push(`a claim the record lists is missing: ${r.data.missing.trim()}`);
    log(`${entry.key} round ${round}: ${bad.length ? bad.length + ' problem(s)' : 'every claim passed'}`);
    if (!bad.length) return { key: entry.key, claims: claims.map((c) => ({ label: c.label, outcome: c.outcome, ...(c.note ? { note: c.note } : {}), ...(c.outcome !== 'pending' ? { source_url: link } : {}) })), reason: null, reviewerModel: reviewer.model };
    complaints = bad;
  }
  return { key: entry.key, claims: null, reason: 'left off: ' + complaints.slice(0, 2).join('; ') };
}
