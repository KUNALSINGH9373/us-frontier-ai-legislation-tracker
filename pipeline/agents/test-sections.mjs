// Run:  node agents/test-sections.mjs   (or npm run test:sections)
// Long bills read section by section: splitting at the bill's own headings, choosing the frontier-AI sections of two real omnibus
// texts (MA S.3228, CT P.A. 26-15; fixtures/long-bills, read from LegiScan through correct/texts.mjs and trimmed to whole sections),
// and the Generator/Validator and the self-correction reader no longer holding or skipping a long bill (scripted models, no AI).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { splitSections, relevantSections, SECTION_CHARS } from './sections.mjs';
import { processItem } from './process-item.mjs';
import { containsQuote, sourceText } from './source-text.mjs';
import { reviewEntry, MAX_SOURCE_CHARS } from '../correct/review.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (...p) => path.join(here, '..', 'fixtures', ...p);
const J = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const filler = (n, word = 'The agency shall keep records of its work. ') => word.repeat(n);

// ---------- 1. headings, one style at a time ----------
{
  const fed = `A BILL\nTo establish frontier model safety.\nSEC. 1. SHORT TITLE.\nThis Act may be cited as the Test Act.\nSEC. 2. DEFINITIONS.\nIn this Act the term "frontier model" means a model.\nSEC. 3. EFFECTIVE DATE.\nThis Act shall take effect 90 days after enactment.\n`;
  const s = splitSections(fed);
  ok('federal "SEC. 2." headings: an opening and three sections', s.map((x) => x.label).join('|') === '(opening)|SEC. 1.|SEC. 2.|SEC. 3.', s.map((x) => x.label).join('|'));
  ok('each section keeps its heading and its full text, and together they are the whole bill', s[2].text.startsWith('SEC. 2. DEFINITIONS.') && /means a model\.\n$/.test(s[2].text) && s.map((x) => x.text).join('') === fed);
  const st = 'Section 1. This act concerns artificial intelligence.\nSection 2. As used in this act, "developer" means a person.\nSection 3. This act takes effect July 1, 2027.\n';
  ok('state "Section 1." headings', splitSections(st).map((x) => x.heading).join('|') === 'Section 1.|Section 2.|Section 3.');
  const caps = 'SECTION 32. Some text.\nSECTION 33. The frontier developer shall report.\nSECTION 34. More text.\n';
  ok('"SECTION 33." headings', splitSections(caps).map((x) => x.heading).join('|') === 'SECTION 32.|SECTION 33.|SECTION 34.');
  const ct = 'Section 1. (NEW) ( Effective October 1, 2026 ) First.\nSec. 2. (NEW) Second.\nSec. 33. ( Effective July 1, 2027 ) (a) As used in this section:\n';
  ok('CT "Section 1." then "Sec. 33." headings are all top-level', splitSections(ct).map((x) => `${x.heading}/${x.level}`).join('|') === 'Section 1./1|Sec. 2./1|Sec. 33./1');
  const ma = 'SECTION 1. Appropriations.\nSECTION 2. The General Laws are hereby amended by inserting after chapter 93L the following chapter:-\nCHAPTER 93M.\nFRONTIER ACT\nSection 1. As used in this chapter, "Frontier model", a model.\nSection 3A. (a) A large frontier developer shall be audited.\nSection 9A 1/2. Other rules.\nSECTION 3. This act shall take effect on July 1, 2027.\n';
  const m = splitSections(ma);
  ok('MA: chapter sections ("Section 3A.", "Section 9A 1/2.") sit under the bill section that inserts them', m.map((x) => `${x.heading}/${x.level}`).join('|') === 'SECTION 1./1|SECTION 2./1|Section 1./2|Section 3A./2|Section 9A 1/2./2|SECTION 3./1', m.map((x) => `${x.heading}/${x.level}`).join('|'));
  ok('MA: an inserted section is labelled with its bill section and chapter', m[3].label === 'SECTION 2 (chapter 93M Section 3A)' && m[3].chapter === '93M', m[3].label);
  const numbered = '3207 install automated road safety camera systems.\n3208 SECTION 164. The General Laws are hereby amended.\n3209 SECTION 165. More.\n3210 SECTION 166. More.\n';
  const n = splitSections(numbered);
  ok('a printed line number left in front of a heading does not hide it, and stays in the text', n.length === 4 && n[1].heading === 'SECTION 164.' && n[1].text.startsWith('3208 SECTION 164.'));
  ok('a reference inside a sentence is not a heading', splitSections('Section 1. See\nsection 4 of chapter 6C.\nSection 9A 1/2 of chapter 40A shall not apply.\n').length === 1);
  ok('a text with no headings is one section; an empty text has none', splitSections('Just words about AI.').length === 1 && splitSections('').length === 0);
}

// ---------- 2. choosing sections on synthetic bills ----------
{
  const bill = [
    'Section 1. This act may be cited as the Road and Frontier Act.\n',
    `Section 2. The department shall resurface roads. ${filler(40)}\n`,
    'Section 3. As used in this act, "frontier model" means a foundation model trained using more than 10^26 integer or floating-point operations; "developer" means a person who trains a frontier model.\n',
    'Section 4. A developer shall publish a safety framework for each frontier model.\n',
    'Section 5. The attorney general may bring a civil action for a civil penalty of not more than $1,000,000 for a violation of section 4.\n',
    `Section 6. The department shall paint bridges. ${filler(40)}\n`,
    'Section 7. Sections 3 to 5 shall take effect on July 1, 2027.\n',
  ].join('');
  const r = relevantSections(bill, { maxChars: 2500 });
  ok('synthetic: definitions, duties, enforcement chosen; roads and bridges left out', ['Section 3.', 'Section 4.', 'Section 5.'].every((h) => r.selected.includes(h)) && !r.selected.includes('Section 2.') && !r.selected.includes('Section 6.'), r.selected.join('|'));
  ok('synthetic: the note names the omitted sections', /Omitted sections: .*Section 2\..*Section 6\./.test(r.text) && r.omitted.includes('Section 6.'));
  ok('synthetic: every chunk is copied from the bill', r.chunks.length > 0 && r.chunks.every((c) => bill.includes(c)));
  ok('synthetic: sections come back in their original order', r.text.indexOf('Section 3.') < r.text.indexOf('Section 4.') && r.text.indexOf('Section 4.') < r.text.indexOf('Section 5.'));
  ok('synthetic: under the limit', r.text.length <= 2500, String(r.text.length));
  ok('a bill with nothing about AI gives no selection', relevantSections(`Section 1. Roads. ${filler(30)}\nSection 2. Bridges. ${filler(30)}\n`).chunks.length === 0);

  // One section over the limit: split at its own (a)/(b)/(c) subsections, never inside one.
  const sub = (l) => `(${l}) A frontier developer shall ${'keep a written record of every frontier model safety test it runs and its results. '.repeat(6)}\n`;
  const big = `Section 1. Roads.\nSection 2. ${sub('a')}${sub('b')}${sub('c')}${sub('d')}Section 3. Bridges.\n`;
  const b = relevantSections(big, { maxChars: 2000 });
  const parts = b.selected.filter((x) => /^Section 2\. \(part \d+ of [2-9]\)$/.test(x));
  ok('an over-long section is split into parts at its subsections', parts.length >= 1 && !b.selected.includes('Section 2.'), b.selected.join('|'));
  ok('every part starts at the heading or at a subsection marker and is copied from the bill', b.chunks.length > 0 && b.chunks.every((c) => big.includes(c) && /^(?:Section 2\.|\([a-d]\))/.test(c.trim())), b.chunks.map((c) => c.slice(0, 15)).join('|'));
  ok('and the selection stays under the limit', b.text.length <= 2000, String(b.text.length));
  const huge = `Section 1. ${'(a) A frontier developer shall test. '.repeat(1)}${'The frontier developer shall keep records. '.repeat(100)}\n`;
  ok('a single subsection over the limit is never sent cut off (nothing selected)', relevantSections(huge, { maxChars: 2000 }).chunks.length === 0);
}

// ---------- 3. MA S.3228 (real text, trimmed to whole sections) ----------
const maText = fs.readFileSync(fx('long-bills', 'ma-s3228.txt'), 'utf8');
const ctText = fs.readFileSync(fx('long-bills', 'ct-pa-26-15.txt'), 'utf8');
const ma = relevantSections(maText);
{
  ok('MA fixture is longer than one call allows', maText.length > MAX_SOURCE_CHARS, String(maText.length));
  ok('MA: chapter 93M definitions ("Large frontier developer", 10^26)', /“Large frontier developer”/.test(ma.text) && /10\^26 integer or floating-point operations/.test(ma.text));
  ok('MA: incident reporting (15 days, 24 hours)', containsQuote(ma.text, 'to the attorney general within 15 days of discovering the critical safety incident') && containsQuote(ma.text, 'that incident within 24 hours to an authority'));
  ok('MA: civil penalty ($1,000,000 / $3,000,000)', containsQuote(ma.text, '$1,000,000 for a first violation and not more than $3,000,000 for subsequent violations'));
  ok('MA: effective date July 1, 2027 for chapter 93M', containsQuote(ma.text, 'chapter 93M of the General Laws shall take effect on July 1, 2027'));
  ok('MA: under the limit', ma.text.length <= SECTION_CHARS, String(ma.text.length));
  ok('MA: every chunk is a substring of the source', ma.chunks.length > 0 && ma.chunks.every((c) => maText.includes(c)));
  ok('MA: appropriation line items left out', !/1596-7066/.test(ma.text) && maText.includes('1596-7066') && !ma.selected.includes('SECTION 2A.') && ma.omitted.includes('SECTION 2A.'));
  ok('MA: unrelated chapters left out (90L road safety cameras)', !/automated road safety camera system/.test(ma.chunks.join('')) && /automated road safety camera system/.test(maText));
  console.log('MA selected: ' + ma.selected.join(' | '));
}

// ---------- 4. CT P.A. 26-15 ----------
const ct = relevantSections(ctText);
{
  ok('CT: Sec. 33 (independent verification organization pilot)', ct.selected.includes('Sec. 33.') && containsQuote(ct.text, '"Independent verification organization" means an independent'));
  ok('CT: Sec. 2 frontier definitions', ct.selected.includes('Sec. 2.') && /"Catastrophic risk"/.test(ct.text) && /frontier developer/.test(ct.text));
  ok('CT: under the limit', ct.text.length <= SECTION_CHARS && ctText.length > MAX_SOURCE_CHARS);
  ok('CT: every chunk is a substring of the source, starting at a section heading', ct.chunks.length > 0 && ct.chunks.every((c) => ctText.includes(c) && /^(?:Section|Sec\.) \d+\./.test(c)));
  ok('CT: some sections are left out and listed', ct.omitted.length > 0 && ct.omitted.every((h) => ct.text.includes(h)));
  console.log('CT selected: ' + ct.selected.join(' | '));
}

// ---------- 5. the Generator/Validator write up a long bill instead of holding it ----------
function scriptedGenerator(queue) {
  return { calls: [], async generate(req) { this.calls.push(req); const r = queue.shift(); if (r instanceof Error) throw r; return { data: typeof r === 'function' ? r(req) : r, usage: {} }; } };
}
function scriptedValidator(answerFor) {
  return { calls: [], async generate(req) { this.calls.push(req); const claims = [...req.prompt.matchAll(/^(\d+)\. \[([^\]]+)\] (.*)$/gm)].map((m) => ({ n: +m[1], field: m[2] })); return { usage: {}, data: { results: claims.map((c) => ({ n: c.n, supported: true, quote: answerFor(c.field), reason: null })) } }; } };
}
{
  // A real executive-order record whose text is followed by the MA omnibus: far over the limit, and its opening is not about AI.
  const entries = J(fx('entries.sample.json'));
  const eo = J(fx('federal-register', '2026-20321.json'));
  const url = 'https://www.federalregister.gov/documents/2026/10/02/2026-20321/inaugurating-the-era-of-super-intelligence';
  const item = { item_id: 'federal_register:2026-20321', source: 'federal_register', source_id: '2026-20321', entry_key: null, change: 'new', source_url: url, fetched_at: '2026-10-07T04:00:00Z', raw_hash: 'x', raw_path: 'x' };
  const diff = { item_id: item.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'New Presidential Document.' }] };
  const Q1 = 'Executive Order 14434 of September 29, 2026 Inaugurating the Era of Super Intelligence', Q3 = 'THE WHITE HOUSE, September 29, 2026.';
  const Q2 = 'to the attorney general within 15 days of discovering the critical safety incident';
  const patch = (q2) => ({
    operation: 'create', in_scope: true, scope_reason: 'Sets duties for frontier developers.',
    fields: { title: 'Executive Order 14434: Inaugurating the Era of Super Intelligence', short_name: 'EO 14434 (Super Intelligence)', section: 'G', sponsor_text: 'President', mechanism: 'Requires a frontier developer to report a critical safety incident to the attorney general within 15 days', status_text: 'Signed Sept 29, 2026; published Oct 2, 2026' },
    events_add: [{ date: '2026-09-29', precision: 'day', type: 'Signed / enacted', text: 'Executive Order 14434 signed' }],
    evidence: [{ field: 'title', quote: Q1, source_url: url }, { field: 'sponsor_text', quote: 'By the authority vested in me as President by the Constitution', source_url: url }, { field: 'mechanism', quote: q2, source_url: url }, { field: 'status_text', quote: Q3, source_url: url }, { field: 'events_add[0]', quote: Q3, source_url: url }], notes: ''
  });
  const long = clone(eo); long.text = `${eo.text}\n${maText}`;
  const answer = (f) => (f === 'mechanism' ? Q2 : f === 'in_scope' ? Q2 : Q3);
  const g = scriptedGenerator([patch(Q2)]), val = scriptedValidator(answer);
  const r = await processItem({ generator: g, validator: val, item, raw: long, diff, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
  ok('a long bill is written up from its sections, not held as "too long"', r.outcome === 'publishable' && !/too long/.test(r.reason || ''), `${r.outcome} ${r.reason}`);
  ok('the Generator read the selection: the 93M sections and the note, not the whole text', g.calls[0].prompt.length < SECTION_CHARS + 30000 && /Large frontier developer/.test(g.calls[0].prompt) && /SOURCE above is a selection/.test(g.calls[0].prompt) && !/1596-7066/.test(g.calls[0].prompt), String(g.calls[0].prompt.length));
  ok('the Validator read the same selection', val.calls.length === 1 && val.calls[0].prompt.length < SECTION_CHARS + 30000 && /Large frontier developer/.test(val.calls[0].prompt));
  ok('quotes are checked against the FULL text: the order\'s own title, outside the selection, was accepted as evidence', r.outcome === 'publishable' && !containsQuote(relevantSections(sourceText(long, 'federal_register')).text, Q1));
  const bad = scriptedGenerator([patch('within 10 days of discovering the critical safety incident'), patch('within 10 days of discovering the critical safety incident'), patch('within 10 days of discovering the critical safety incident')]);
  const r2 = await processItem({ generator: bad, validator: scriptedValidator(answer), item, raw: long, diff, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
  ok('an invented quote is still refused by the code check on the full text', r2.outcome === 'held' && r2.verdicts[0].code_checks.some((c) => !c.passed && /quote/i.test(c.name + ' ' + (c.detail || c.problems || ''))), JSON.stringify(r2.verdicts[0] && r2.verdicts[0].code_checks.filter((c) => !c.passed)));
}


// ---------- 6. the self-correction reader re-checks a long bill instead of skipping it ----------
{
  const entry = J(path.join(here, '..', '..', 'web', 'data', 'v2', 'entries.json')).find((e) => e.key === 'ma-h-5576-s-3178');
  const scripted = (fn) => ({ calls: [], async generate(req) { this.calls.push(req); return { data: fn(req), usage: {} }; } });
  const Q = 'to the attorney general within 15 days of discovering the critical safety incident';
  const omitted = 'There shall be within the division of highways an automated road safety'; // in the bill, not in the selection
  ok('the quote used below is in the bill but outside the selection', containsQuote(maText, omitted) && !containsQuote(ma.text, omitted));
  const fix = (quote) => ({ corrections: [{ field: 'mechanism', kind: 'omission', problem: 'The incident deadline is missing.', new_text: `${entry.mechanism} Critical safety incidents go to the attorney general within 15 days.`, evidence: [{ quote }] }] });
  const reviewer = scripted(() => fix(Q)), confirmer = scripted(() => ({ confirmed: true, quote: Q, reason: 'SOURCE sets 15 days.' }));
  const r = await reviewEntry({ reviewer, confirmer, entry, text: maText, url: 'https://malegislature.gov/Bills/194/S3228' });
  ok('a long bill is reviewed, not skipped as too_long', r.outcome !== 'too_long' && reviewer.calls.length >= 1, `${r.outcome} ${r.reason}`);
  ok('the reader and confirmer read the selection, not the whole text', reviewer.calls[0].prompt.length < SECTION_CHARS + 20000 && /Large frontier developer/.test(reviewer.calls[0].prompt) && confirmer.calls.every((c) => c.prompt.length < SECTION_CHARS + 20000));
  ok('a correction quoting the bill is confirmed', r.outcome === 'corrected' && r.corrections[0].evidence[0] === Q, JSON.stringify(r.rejected));
  const r2 = await reviewEntry({ reviewer: scripted(() => fix(omitted)), confirmer: scripted(() => ({ confirmed: true, quote: omitted, reason: 'x' })), entry, text: maText, url: 'x' });
  ok('code checks quotes against the full text: a quote outside the selection is still found', !(r2.rejected || []).some((x) => /quote not in the source/.test(x.why)), JSON.stringify(r2.rejected));
  const r3 = await reviewEntry({ reviewer: scripted(() => fix('within 10 days of discovering the critical safety incident')), confirmer: scripted(() => ({ confirmed: true })), entry, text: maText, url: 'x' });
  ok('an invented quote is refused', r3.outcome === 'rejected' && r3.rejected.some((x) => /quote not in the source/.test(x.why)), JSON.stringify(r3));
  const r4 = await reviewEntry({ reviewer: scripted(() => ({ corrections: [] })), confirmer: scripted(() => ({})), entry, text: `Section 1. Roads. ${filler(3000)}`, url: 'x' });
  ok('a long text with nothing about AI is still too_long, with no AI call', r4.outcome === 'too_long' && /no section about frontier AI/.test(r4.reason));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
