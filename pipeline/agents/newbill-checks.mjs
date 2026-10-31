// The code checks on a new-bills writer answer and reviewer answer (agents/newbill-prompt.md section 4 and "What code does with the
// review"). Plain code, no AI. `source` is the bill as code checks it (sourceText(): cleanText of the printed bill); quotes are found
// with containsQuote, which also ignores printed line numbers and page furniture, so a quote copied from readerText still matches.
import { containsQuote } from './source-text.mjs';
import { digitRuns, norm } from './text-norm.mjs';
import { ROW_KEYS, itemsOf, DUTY_KINDS, OTHER_KINDS } from './newbill-prompts.mjs';
import { quoteMatchProblems } from '../publish/guards.mjs';
import { toPatch } from './newbill-entry.mjs';
export { itemsOf };

const ID_PREFIX = { coverage: 'c', definitions: 'd', exclusions: 'x', duties: 'u', penalties: 'p', effective: 'e', other_provisions: 'o' };
const SLOTS = ['applies_to', 'requires', 'enforcement', 'effective'];
// A heading of another provision inside a quote: upper-case SEC. or SECTION, a number and a full stop ("SECTION 2.", "SEC. 802."),
// including one inside inserted text that opens with quote marks (``SEC. 802.), or a title heading ("TITLE VIII--"). A cross-reference
// has no full stop after its number, even in a state that prints new law in capitals ("SECTION 6-1-1701 (2)", "under section 552").
const HEADING = /(?:^|[\s`'"“‘(])(?:(?:SEC\.|SECTION)\s?\d+[A-Z]?\.\s|TITLE [IVXL]+(?:--|—|\.\s))/;
const clean = (s) => String(s || '').trim();
// A quote that begins as an item of a list: "(f)", "(2)", "(iii)", "(A)", optionally after a section number ("3(b)(2) ").
const LIST_ITEM = /^(?:[\d.]+)?\((?:[a-z]{1,2}|\d{1,3}|[ivxlc]{1,6})\)\s/i;
// A verb of obligation or power of the quote's own (then it does not lean on a list's opening words).
const OWN_FORCE = /\b(?:shall|must|may|is required to|are required to|is prohibited|are prohibited|is liable|are liable|is authori[sz]ed|are authori[sz]ed)\b/i;
// A heading anywhere after the quote's own opening words (a quote may start at its own section's heading).
export const crossesSection = (q) => HEADING.test(' ' + String(q || '').replace(/\s+/g, ' ').slice(12));
// The printed text from the end of a lead_in to the start of its quote, when both are found as printed ('' otherwise: the matcher
// already proved each exists, and a span it cannot place is not evidence of a crossing).
const flat = (s) => String(s || '').replace(/\s+/g, ' ');
function between(source, a, b) {
  const s = flat(source), i = s.indexOf(flat(a).trim()), j = i >= 0 ? s.indexOf(flat(b).trim(), i) : -1;
  return i >= 0 && j >= 0 ? s.slice(i + flat(a).trim().length, j) : '';
}
const where = (x) => `${x._list}[${x.id}]`;

// The reader-facing text of an answer, [path, text]: every line the page shows (quotes are checked as quotes, not as numbers).
function shownText(out) {
  const t = [['name', out.name]];
  for (const x of itemsOf(out)) {
    t.push([`${where(x)}.text`, x.text]);
    for (const f of ['conditions', 'deadline', 'amount', 'unit', 'trigger', 'enforcer', 'applies_to', 'party', 'term']) if (x[f]) t.push([`${where(x)}.${f}`, [].concat(x[f]).join(' ')]);
  }
  for (const k of ROW_KEYS) if (out.rows && out.rows[k]) t.push([`rows.${k}.summary`, out.rows[k].summary]);
  for (const k of SLOTS) if (out.box && out.box[k]) t.push([`box.${k}`, out.box[k].text]);
  return t.filter(([, s]) => clean(s));
}

// Problems with a writer answer, each a line the retry message can show. [] = it passes.
export function writerProblems(out, { source }) {
  const p = [], have = digitRuns(source);
  const items = itemsOf(out);
  // Out of scope, or too damaged to write honestly: nothing else may be filled in.
  if (out.readable === false || out.in_scope === false) {
    if (items.length) p.push(`${out.readable === false ? 'readable is false' : 'in_scope is false'}, so every list must be empty (found ${items.length} items)`);
    if (out.in_scope === false && !clean(out.scope_reason)) p.push('scope_reason is empty: say which OUT-list item the bill falls under');
    return p;
  }
  if (!clean(out.scope_reason)) p.push('scope_reason is empty: name the binding provision that places the bill in scope');
  if (!clean(out.name)) p.push('name is empty');
  if (clean(out.name_quote) && !containsQuote(source, out.name_quote)) p.push(`name_quote is not in the bill word for word: "${clean(out.name_quote).slice(0, 80)}"`);
  if (clean(out.name_quote) && !norm(out.name_quote).includes(norm(out.name).replace(/^the /, '').slice(0, 40))) p.push('name is not copied from name_quote (options 1 and 2 copy the bill\'s own words)');
  // ids: unique, the right letter for the list
  const ids = new Set();
  for (const x of items) {
    if (!new RegExp(`^${ID_PREFIX[x._list]}[0-9]+$`).test(x.id || '')) p.push(`${where(x)}: id must be ${ID_PREFIX[x._list]} and a number`);
    if (ids.has(x.id)) p.push(`id ${x.id} is used twice`);
    ids.add(x.id);
  }
  // A duty or penalty quoted as one item of a list ("(f) report ...", "(2) a fine of ...") carries the words that open the list in
  // lead_in: they hold the party, the verb or the deadline the item depends on (live run, 31 Oct 2026: an item quoted alone lost its
  // "On or before January 1, 2028, the agency shall" while its neighbours kept it).
  // An item that is a complete provision of its own ("(a) A large frontier developer shall ...") needs none: only one with no verb of
  // obligation of its own depends on the words that open its list.
  for (const x of items) if ((x._list === 'duties' || x._list === 'penalties') && LIST_ITEM.test(clean(x.quote)) && !OWN_FORCE.test(clean(x.quote)) && !clean(x.lead_in)) p.push(`${where(x)}: the quote is one item of a list; copy the words that open the list (who must act, and any deadline) into lead_in`);
  // the per-list choices the answer's grammar leaves open (agents/newbill-prompts.mjs writerSchema)
  const CHOICE = { duties: { force: ['duty', 'power', 'ban'], kind: DUTY_KINDS }, other_provisions: { kind: OTHER_KINDS }, effective: { type: ['act', 'duty', 'agency'] } };
  for (const x of items) for (const [f, allowed] of Object.entries(CHOICE[x._list] || {})) if (!allowed.includes(x[f])) p.push(`${where(x)}: ${f} "${x[f] || ''}" is not one of ${allowed.join(', ')}`);
  // quotes and lead_ins: word for word in the bill, one provision each, the lead_in before its quote
  for (const x of items) {
    if (!clean(x.quote)) { p.push(`${where(x)}: quote is empty`); continue; }
    if (!containsQuote(source, x.quote)) p.push(`${where(x)}: quote is not in the bill word for word: "${clean(x.quote).slice(0, 80)}"`);
    else if (crossesSection(x.quote)) p.push(`${where(x)}: quote runs into another section; end it inside ${x.sec || 'its own section'}`);
    if (clean(x.lead_in)) {
      if (!containsQuote(source, x.lead_in)) p.push(`${where(x)}: lead_in is not in the bill word for word: "${clean(x.lead_in).slice(0, 80)}"`);
      else if (crossesSection(between(source, x.lead_in, x.quote))) p.push(`${where(x)}: lead_in and quote are in different provisions`);
    }
  }
  // the 13 rows: a marked row carries its quote; an empty one carries none
  for (const k of ROW_KEYS) {
    const r = out.rows && out.rows[k];
    if (!r) { p.push(`rows.${k} is missing`); continue; }
    if (r.value === 'not_in_bill') { if (clean(r.quote) || clean(r.sec)) p.push(`rows.${k}: a not_in_bill row has no quote or sec`); continue; }
    if (!clean(r.summary)) p.push(`rows.${k}: summary is empty`);
    if (!clean(r.quote)) p.push(`rows.${k}: quote is empty`);
    else if (!containsQuote(source, r.quote)) p.push(`rows.${k}: quote is not in the bill word for word: "${clean(r.quote).slice(0, 80)}"`);
    for (const id of r.items || []) if (!ids.has(id)) p.push(`rows.${k}: items names ${id}, which is not an item`);
  }
  // the box: no blank slot, every based_on id exists
  for (const k of SLOTS) {
    const s = out.box && out.box[k];
    if (!s || !clean(s.text)) p.push(`box.${k} is blank: say what the bill states, or that it states nothing ("Not stated in the bill; ...")`);
    for (const id of (s && s.based_on) || []) if (!ids.has(id)) p.push(`box.${k}: based_on names ${id}, which is not an item`);
  }
  // one-way numbers: every number the page shows is in the bill exactly (a figure, not a guess)
  for (const [path, text] of shownText(out)) for (const n of digitRuns(text)) if (!have.has(n)) p.push(`${path}: the number "${n}" is not in the bill as written`);
  // The publisher's own check on the reading fields built from these items (publish/guards.mjs quoteMatchProblems): a duty line shares
  // words with its quote and is mostly the bill's own words; a figure is in digits or in the quote's own words. Run here, so a line it
  // would refuse goes back to the writer in the one retry instead of failing at publication.
  const patch = toPatch(out);
  for (const g of quoteMatchProblems({ ...patch.fields, evidence: patch.evidence }, source)) p.push(`${g} — rewrite that line of the matching item's text closer to the bill's own words (keep every condition)`);
  return [...new Set(p)];
}

// Every part of an entry the reviewer must say it checked.
export function reviewTargets(out) {
  return [...itemsOf(out).map((x) => x.id), ...ROW_KEYS, 'scope', 'name', ...SLOTS.map((k) => `box.${k}`)];
}
// A reviewer answer, as code reads it: findings whose proof is not in the bill are dropped (a finding must be proved); the parts it did
// not say it checked are listed; the verdict is computed here, never taken from the model.
export function readReview(review, { source, out }) {
  const findings = [], discarded = [];
  for (const f of review.findings || []) (clean(f.bill_quote) && containsQuote(source, f.bill_quote) ? findings : discarded).push(f);
  // A part counts as checked when the reviewer named it, however it prefixed or spelled the path (live run, 31 Oct 2026: Opus wrote the
  // rows and scope with their own paths, and every bill fell to facts-only): "framework", "rows.framework", "rows[framework]" and
  // "duty row: framework" all name the framework row; "in_scope" or "scope_reason" name the scope, "name_quote" the name. A part it
  // never named is still missing.
  const said = (review.checked || []).map((c) => String(c).toLowerCase());
  const tokens = said.flatMap((c) => c.split(/[^a-z0-9_]+/).filter(Boolean));
  const named = (t) => {
    const k = t.toLowerCase();
    if (k === 'scope') return said.some((c) => /scope/.test(c));
    if (k === 'name') return said.some((c) => /(^|[^a-z])(short_)?name(_quote)?([^a-z]|$)/.test(c));
    if (k.startsWith('box.')) return said.some((c) => c === k || c.endsWith(k) || (c.includes('box') && c.includes(k.slice(4))));
    return said.includes(k) || tokens.includes(k);
  };
  const missing = reviewTargets(out).filter((t) => !named(t));
  const wrong = findings.filter((f) => f.severity === 'WRONG');
  // A wrong scope call is not a fixable line: the bill is out of the tracker (agents/newbill.mjs never gives it an entry).
  // (a wrong tracker_section alone is a fixable line, not an out-of-scope bill)
  const scopeWrong = wrong.filter((f) => /(^|[^a-z])(in_)?scope(_reason)?([^a-z]|$)/i.test(clean(f.where)));
  const verdict = !findings.length ? 'pass' : wrong.length ? 'fail' : 'fix';
  return { findings, discarded, missing, verdict, wrong: wrong.length, scopeWrong: scopeWrong.length > 0 };
}
