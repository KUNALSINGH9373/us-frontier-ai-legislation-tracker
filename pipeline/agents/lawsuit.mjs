// New lawsuits (owner, 26 Nov 2026): an official release announcing a lawsuit about a frontier-AI developer or a frontier-AI law becomes a
// G.2 litigation entry, written by AI from the release alone and checked like a new bill: writer (role "writer") -> code checks (one
// retry) -> independent reviewer (role "bill_reviewer"). Published only with no WRONG or MISLEADING finding the release proves, every fact
// quoted word for word from the release, and behind its own switch (auto_publish.lawsuits) and test-set gate (eval/lawsuits-set.mjs).
//   isLawsuitLead(lead)                         code screen: an official release whose headline announces a lawsuit
//   writeLawsuit({ writer, reviewer, release }) -> { decision: publishable | out_of_scope | held, out, problems, review, reason }
//   lawsuitEntry({ out, release, today, runId, at, id }) -> the entry (G.2, origin automated)
// A release is the official body's own page (the caller checks its host). Nothing here reads the network.
import { containsQuote } from './source-text.mjs';
import { LlmOutputError } from '../llm/gemini.mjs';
import { longDate } from './derive.mjs';

// An official headline that announces a lawsuit (filed, joined or answered), not an investigation, a settlement or a guidance letter.
export const SUES = /\b(sues|sued|suing|lawsuit|files? (?:a )?(?:suit|complaint|lawsuit)|filed (?:a )?(?:suit|complaint|lawsuit)|takes? legal action|legal action against|complaint against|joins? (?:a )?(?:coalition )?(?:suit|lawsuit))\b/i;
// A frontier developer or frontier-AI wording (the writer and the reviewer decide scope; this only picks what to read).
export const AI_PARTY = /\b(OpenAI|Anthropic|xAI|Google|DeepMind|Meta|Microsoft|Nvidia|Character\.?AI|Mistral|DeepSeek|frontier|artificial intelligence|A\.?I\.?|chatbot|large language model|AI model|AI agent)/i;
export const isLawsuitLead = (lead) => SUES.test(lead.title || '') && AI_PARTY.test(`${lead.title || ''} ${lead.summary || ''}`);

// State attorneys general and federal enforcers whose releases are read (host -> who and where). A host not here is never read.
export const OFFICIAL = {
  'oag.ca.gov': { publisher: 'California Attorney General', state: 'CA' },
  'www.njoag.gov': { publisher: 'New Jersey Attorney General', state: 'NJ' },
  'njoag.gov': { publisher: 'New Jersey Attorney General', state: 'NJ' },
  'www.atg.wa.gov': { publisher: 'Washington Attorney General', state: 'WA' },
  'www.justice.gov': { publisher: 'U.S. Department of Justice', state: null },
  'www.ftc.gov': { publisher: 'Federal Trade Commission', state: null }
};
export const officialOf = (url) => { try { return OFFICIAL[new URL(url).hostname] || null; } catch { return null; } };

// The litigation section's scope, shared by the writer and the reviewer. Owner, 26 Nov 2026: a case about a lab's facilities, energy,
// environmental permits, employment or contracts is out, even with a frontier lab as a party, unless it is about an AI law or a model's
// safety (the DOJ's intervention in the Clean Air Act suit over xAI's Mississippi data centre is out).
export const LITIGATION_SCOPE = `The tracker's litigation section covers court cases about frontier AI developers' models or conduct as AI developers (OpenAI, Anthropic, Google DeepMind, xAI, Meta's frontier models and the like: the safety, security, testing, deployment or marketing of their AI models), and court cases over frontier-AI laws (a challenge to a state AI-safety law, a federal-state preemption fight). It does NOT cover:
- cases about AI used for an unrelated purpose by a non-frontier company (a robocall or deepfake scam, an "AI-powered" product making false claims, hiring tools, facial recognition);
- cases about a lab's facilities, power supply, energy, environmental permits, land use, employment, taxes or contracts, EVEN WHEN a frontier lab is a party and even when a government argues AI or national security, unless the case itself turns on an AI law or an AI model's safety;
- investigations, settlements, subpoenas, demand letters, bankruptcy filings or guidance with no lawsuit.`;

export const WRITER_SYSTEM = `You write one entry for a tracker of US frontier-AI policy from ONE official release that announces a lawsuit.
${LITIGATION_SCOPE}
Rules:
- Use ONLY the release. Never add a fact from memory. If the release does not say something, leave that field empty ("").
- Every quote must be copied word for word from the release, 8 to 300 characters, enough to prove its field.
- in_scope: true only if the release announces a lawsuit that fits the section above; scope_quote proves it (it names the developer or the law and the lawsuit).
- plaintiff and defendant: as the release names them (e.g. "California Attorney General Rob Bonta", "OpenAI"); parties_quote proves both.
- court: the court as the release names it (e.g. "San Francisco Superior Court"); "" if not named. court_quote proves it.
- filed_date: YYYY-MM-DD of the filing as the release states it; "" if it gives none. date_quote proves it. Never use the release's own date unless the release says the suit was filed that day ("today").
- claims: 1 to 3 plain sentences on what the lawsuit alleges and asks for, in neutral words ("The Attorney General alleges ..."), with no claim the release does not make. claims_quotes: the release's words behind every sentence.
- Write short, plain English.`;

export const WRITER_SCHEMA = { type: 'OBJECT', required: ['in_scope', 'scope_reason', 'scope_quote', 'plaintiff', 'defendant', 'parties_quote', 'court', 'court_quote', 'filed_date', 'date_quote', 'claims', 'claims_quotes'], properties: {
  in_scope: { type: 'BOOLEAN' }, scope_reason: { type: 'STRING' }, scope_quote: { type: 'STRING' },
  plaintiff: { type: 'STRING' }, defendant: { type: 'STRING' }, parties_quote: { type: 'STRING' },
  court: { type: 'STRING' }, court_quote: { type: 'STRING' },
  filed_date: { type: 'STRING' }, date_quote: { type: 'STRING' },
  claims: { type: 'STRING' }, claims_quotes: { type: 'ARRAY', items: { type: 'STRING' } } } };

export const REVIEWER_SYSTEM = `You independently fact-check a draft tracker entry about a lawsuit against the ONE official release it was written from.
${LITIGATION_SCOPE}
For each field (scope, plaintiff, defendant, court, filed_date, claims) decide whether the release supports it. Report a finding only when the release proves it:
- WRONG: the field states something the release contradicts or does not say (a wrong court, date, party or claim; a lawsuit that is out of scope under the section above).
- MISLEADING: technically supported but would give a reader a false picture (an allegation stated as fact, a request for relief stated as an outcome, a case presented as decided).
Each finding needs the release's own words (quote, copied exactly) that prove it. If everything is supported, return no findings.`;
export const REVIEWER_SCHEMA = { type: 'OBJECT', required: ['checked', 'findings'], properties: {
  checked: { type: 'ARRAY', items: { type: 'STRING' } },
  findings: { type: 'ARRAY', items: { type: 'OBJECT', required: ['field', 'severity', 'problem', 'quote'], properties: { field: { type: 'STRING' }, severity: { type: 'STRING', enum: ['WRONG', 'MISLEADING'] }, problem: { type: 'STRING' }, quote: { type: 'STRING' } } } } } };
export const FIELDS = ['scope', 'plaintiff', 'defendant', 'court', 'filed_date', 'claims'];

const releaseBlock = (r) => `<release publisher="${r.publisher}" url="${r.url}" date="${r.date || ''}">\n${r.title}\n\n${r.text}\n</release>`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const numbersIn = (s) => (String(s || '').replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) || []);

// Code checks on the writer's answer: quotes in the release, the date in its own quote, numbers backed by quotes, nothing empty that must not be.
export function writerProblems(out, release) {
  const p = [], text = `${release.title}\n${release.text}`;
  if (!out || typeof out !== 'object') return ['no answer'];
  if (out.in_scope !== true) return [];
  const q = (name, quote) => { if (!quote) p.push(`${name} has no quote`); else if (!containsQuote(text, quote)) p.push(`${name} quote is not in the release: "${String(quote).slice(0, 80)}"`); };
  q('scope', out.scope_quote); q('parties', out.parties_quote);
  if (!out.defendant || !out.plaintiff) p.push('plaintiff and defendant are required');
  if (out.court) q('court', out.court_quote);
  if (out.court && out.court_quote && !String(out.court_quote).toLowerCase().replace(/\s+/g, ' ').includes(String(out.court).toLowerCase().replace(/^the /, '').replace(/\s+/g, ' '))) p.push(`the court quote does not name "${out.court}"`);
  if (out.filed_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.filed_date)) p.push('filed_date must be YYYY-MM-DD');
    else {
      q('filed_date', out.date_quote);
      const [y, m, d] = out.filed_date.split('-').map(Number), dq = String(out.date_quote || '');
      const says = new RegExp(`\\b${MONTHS[m - 1].slice(0, 3)}[a-z]*\\.?\\s+${d}\\b`, 'i').test(dq) || (/\btoday\b/i.test(dq) && release.date === out.filed_date);
      if (!says) p.push(`the date quote does not state ${out.filed_date} (or "today" on a release of that date)`);
      if (y < 2000 || out.filed_date > (release.date || out.filed_date)) p.push('filed_date is after the release');
    }
  }
  if (!out.claims) p.push('claims are required');
  const cq = Array.isArray(out.claims_quotes) ? out.claims_quotes : [];
  if (!cq.length) p.push('claims need quotes');
  cq.forEach((x, i) => q(`claims quote ${i + 1}`, x));
  const backed = `${cq.join(' ')} ${out.date_quote || ''} ${out.court_quote || ''}`;
  numbersIn(out.claims).filter((n) => !numbersIn(backed).includes(n)).forEach((n) => p.push(`the number ${n} in claims is not in its quotes`));
  return p;
}

// The reviewer's answer: only findings whose quote is in the release count (a finding the release does not prove is discarded).
export function readReview(data, release) {
  const text = `${release.title}\n${release.text}`, all = (data && Array.isArray(data.findings)) ? data.findings : [];
  const proved = all.filter((f) => f && ['WRONG', 'MISLEADING'].includes(f.severity) && containsQuote(text, f.quote));
  const checked = new Set(((data && data.checked) || []).map((x) => String(x).toLowerCase()));
  const missing = FIELDS.filter((f) => ![...checked].some((c) => c.includes(f.replace('_', ' ')) || c.includes(f)));
  return { findings: proved, discarded: all.length - proved.length, missing, pass: proved.length === 0 && missing.length === 0 };
}

const again = async (llm, req) => { try { return await llm.generate(req); } catch (e) { if (!(e instanceof LlmOutputError)) throw e; return llm.generate(req); } };

export async function writeLawsuit({ writer, reviewer, release, itemId = null, log = () => {} }) {
  const trail = { writer_calls: 0, problems: [], reviews: [] };
  const write = async (extra = '') => { trail.writer_calls++; return (await again(writer, { system: WRITER_SYSTEM, prompt: releaseBlock(release) + extra, itemId, responseSchema: WRITER_SCHEMA })).data; };
  let out, problems;
  try {
    out = await write(); problems = writerProblems(out, release);
    if (problems.length) { trail.problems.push(problems); log(`lawsuit writer failed ${problems.length} check(s); one retry`); out = await write(`\n\n<previous_answer>\n${JSON.stringify(out)}\n</previous_answer>\n\nYour previous answer failed these checks; fix every one:\n- ${problems.join('\n- ')}`); problems = writerProblems(out, release); }
  } catch (e) { if (e instanceof LlmOutputError) return { decision: 'held', trail, reason: `the writer gave an unusable answer twice: ${e.message}` }; throw e; }
  if (out.in_scope !== true) return { decision: 'out_of_scope', out, trail, reason: out.scope_reason || 'out of scope' };
  if (problems.length) { trail.problems.push(problems); return { decision: 'held', out, trail, problems, reason: `the draft failed its code checks: ${problems.slice(0, 3).join('; ')}` }; }
  const ask = async (note = '') => readReview((await again(reviewer, { system: REVIEWER_SYSTEM, prompt: `${releaseBlock(release)}\n\n<draft>\n${JSON.stringify({ scope: out.scope_reason, plaintiff: out.plaintiff, defendant: out.defendant, court: out.court, filed_date: out.filed_date, claims: out.claims }, null, 1)}\n</draft>${note}`, itemId, responseSchema: REVIEWER_SCHEMA })).data, release);
  let review;
  try { review = await ask(); if (review.missing.length) review = await ask(`\n\nList every field in "checked": ${FIELDS.join(', ')}.`); }
  catch (e) { if (e instanceof LlmOutputError) return { decision: 'held', out, trail, reason: `the reviewer gave an unusable answer twice: ${e.message}` }; throw e; }
  trail.reviews.push(review);
  if (review.findings.some((f) => /scope/i.test(f.field) && f.severity === 'WRONG')) return { decision: 'out_of_scope', out, trail, review, reason: `the reviewer proved it out of scope: ${review.findings[0].problem}` };
  if (!review.pass) return { decision: 'held', out, trail, review, reason: review.findings.length ? `the reviewer found ${review.findings.length} problem(s): ${review.findings.map((f) => `${f.severity} ${f.field}: ${f.problem}`).join('; ').slice(0, 240)}` : 'the reviewer did not check every field' };
  return { decision: 'publishable', out, trail, review };
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
// The entry, from a publishable answer. Official facts only; the release is its source. A state AG's case is on its state's tile.
export function lawsuitEntry({ out, release, today, runId, at, id }) {
  const off = officialOf(release.url) || {}, state = off.state || null;
  const who = state ? `${release.publisher.replace(/ Attorney General$/, '')}` : release.publisher;
  const where = out.court ? ` (${out.court})` : '';
  const title = cut(`${out.plaintiff} v. ${out.defendant}${where}`, 160);
  const short = cut(`${who} v. ${out.defendant}`, 80);
  const date = out.filed_date || null, text = `${out.plaintiff} sues ${out.defendant}${out.court ? ` in ${out.court}` : ''}`;
  const filed = date ? `Filed ${longDate(date)}${out.court ? ` in ${out.court}` : ''}` : `Announced ${longDate(release.date)}`;
  return {
    id, key: slug(`${short} ${date || release.date}`), section: 'G.2', type: 'litigation', level: state ? 'state' : 'federal', jurisdiction: 'US', state,
    status: 'litigation', title, short_name: short, sponsor_text: '', mechanism: out.claims, thresholds: null, penalties: null,
    status_text: `${filed}, per the ${release.publisher}'s release of ${longDate(release.date)}.`, signed_text: null, effective_text: null,
    events: date ? [{ date, precision: 'day', type: 'Litigation', text, clause: text, inferred_year: false, scheduled: false, source_url: release.url }] : [],
    sources: [{ label: `${release.publisher} release, ${longDate(release.date)}`, url: release.url, kind: 'primary' }],
    source_label: `${release.publisher} release, ${longDate(release.date)}`,
    confidence: { level: 'MED-HIGH', basis: 'primary_record', note: "From the official release, written by the pipeline and checked by an independent reviewer. The complaint itself was not read." },
    tags: { updated_after_verification: false, found_via: 'news' }, origin: 'automated', verification: { method: 'agent', checked_at: at, run_id: runId, rounds: 1 },
    last_checked: today, last_changed: today, identifiers: {},
    evidence: [
      { field: 'in_scope', quote: out.scope_quote, source_url: release.url },
      { field: 'parties', quote: out.parties_quote, source_url: release.url },
      ...(out.court ? [{ field: 'court', quote: out.court_quote, source_url: release.url }] : []),
      ...(date ? [{ field: 'events', quote: out.date_quote, source_url: release.url }] : []),
      ...out.claims_quotes.map((q) => ({ field: 'mechanism', quote: q, source_url: release.url }))]
  };
}
