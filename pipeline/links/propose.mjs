// Links between entries, proposed for new or changed entries. Two readers:
//   by code (facts the text states): a sponsor who is already in the network sponsors the bill; a bill amends a law the tracker
//     has (it cites that law's code article or section, or names the law next to "amends" / "adds"). Companion bills are found
//     too (Congress.gov "Identical bill", or a title naming another entry's bill as its companion), but the tracker keeps a bill
//     and its companion in ONE entry, so they are reported for merging, never drawn as a link.
//   by AI (reading): "copies / overlaps / modeled on", only with a quote from BOTH bills that code finds word for word in each
//     bill's text, and a second reader (role validator) agreeing. Prompts in prompts.mjs.
// Every proposal: { from, to, type, label, evidence: [{ entry_key, quote, source_url }], method: 'code' | 'ai', dashed? }.
// Only edge types the network already draws are proposed. Nothing is written here: apply.mjs adds accepted proposals.
import { containsQuote, norm } from '../agents/source-text.mjs';
import { READER_SYSTEM, readerPrompt, CONFIRM_SYSTEM, confirmPrompt } from './prompts.mjs';

// The fixed labels code writes. 'Sponsor' and the template label are labels the network already uses.
export const LABEL = { sponsor: 'Sponsor', copies: 'Same template; common drafting source rather than sequential copying' };
export const amendsLabel = (name) => `Would amend ${name}`;

const MAX_QUOTE = 240;
const nodeOfEntry = (rel) => { const m = {}; Object.entries(rel.nodes).forEach(([k, n]) => { if (n.kind === 'entry') m[n.entry_key] = k; }); return m; };
const usedTypes = (rel) => new Set(rel.edges.map((e) => e.type).filter((t) => rel.types[t]));
export const primaryUrl = (e) => { const s = (e.sources || []).find((x) => x.kind === 'primary') || (e.sources || [])[0]; return s ? s.url : null; };
// A verbatim piece of a field, cut at a word boundary so it stays a substring of the text it came from.
const cut = (s) => { const t = s.trim(); if (t.length <= MAX_QUOTE) return t; const i = t.lastIndexOf(' ', MAX_QUOTE); return t.slice(0, i > 40 ? i : MAX_QUOTE); };

// ---------- placement: a node for an entry the network does not have yet ----------
// Same column as the existing nodes of the same section (and level, where a section spans two columns); the key is a short
// upper-case form of the entry's short name, made unique.
export function nodeFor(entry, rel, entries) {
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
  const votes = {};
  Object.values(rel.nodes).filter((n) => n.kind === 'entry' && byKey[n.entry_key]).forEach((n) => {
    const x = byKey[n.entry_key];
    const w = x.section === entry.section ? (x.level === entry.level ? 3 : 1) : x.level === entry.level && x.type === entry.type ? 0.5 : 0;
    if (w) votes[n.column] = (votes[n.column] || 0) + w;
  });
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const column = best ? Number(best[0]) : entry.level === 'federal' ? 2 : 4;
  // the first bill number in the short name, as the network writes it (SB315, HR9917, S10373); else its capital letters
  const bill = String(entry.short_name || '').match(new RegExp(BILL.source));
  const base = bill ? normBill(bill[0]) : (String(entry.short_name || entry.key).replace(/\(.*?\)/g, '').match(/[A-Z0-9]/g) || ['ENTRY']).join('').slice(0, 10);
  let key = base, i = 2;
  while (rel.nodes[key]) key = base + i++;
  return { key, node: { name: String(entry.short_name || entry.title).slice(0, 100), column, kind: 'entry', entry_key: entry.key } };
}

// ---------- sponsors ----------
// The lead sponsor segment: before the first ";", " with ", " + ", " — " or any co-author / co-sponsor list. Co-sponsors and
// supporters are left out on purpose: the network links only some of them, so linking all would add links the tracker lacks.
export const leadSponsors = (s) => String(s || '').split(/;|\s+with\s+|\s\+\s|\s—\s|\bco-?authors?\b|\bco-?sponsors?\b|\bsponsored by\b/i)[0];
const LEGISLATOR = /^(?:Sen|Rep|Asm)\.\s+.*?([A-Z][A-Za-z'-]+)\s*\((?:([DRI])-)?([A-Z]{2})\)\s*$/;
function legislators(rel) {
  return Object.entries(rel.nodes).filter(([, n]) => n.kind === 'actor').map(([k, n]) => { const m = n.name.match(LEGISLATOR); return m && { k, surname: m[1], federal: !!m[2], state: m[3] }; }).filter(Boolean);
}
function sponsorProposals(entry, node, rel) {
  const lead = leadSponsors(entry.sponsor_text).trim(), url = primaryUrl(entry);
  if (!lead || !url) return [];
  return legislators(rel).filter((a) => (a.federal ? entry.level === 'federal' : entry.level === 'state' && entry.state === a.state))
    .filter((a) => new RegExp(`(^|[^A-Za-z-])${a.surname.replace(/[-']/g, '\\$&')}(?![A-Za-z-])`).test(lead))
    .map((a) => ({ from: a.k, to: node, type: 'actor', label: LABEL.sponsor, evidence: [{ entry_key: entry.key, quote: cut(lead), source_url: url }], method: 'code' }));
}

// ---------- amendments ----------
const CODES = [
  { id: 'gbl', re: /\b(?:GBL|Gen\.\s?Bus\.\s?Law|General Business Law)\b/gi },
  { id: 'gov', re: /\bGov(?:\.|ernment)\s+Code\b/gi },
  { id: 'bpc', re: /\bBus(?:\.|iness)\s+(?:&|and)\s+Prof(?:\.|essions)\s+Code\b/gi }
];
const num = (s) => parseFloat(String(s).replace(/^\./, '0.'));
// Code citations in one clause: [{ code, art } | { code, from, to } | { code: 'chapter', chapter } | { code: 'usc:<title>', sec }].
export function citations(clause) {
  const out = [];
  for (const c of CODES) for (const m of clause.matchAll(c.re)) {
    const win = clause.slice(m.index, m.index + m[0].length + 70), before = clause.slice(Math.max(0, m.index - 30), m.index);
    const art = win.match(/\bArt(?:icle|\.)\s*([0-9]+(?:-[A-Z])?)/i); if (art) out.push({ code: c.id, art: art[1].toUpperCase() });
    for (const s of win.matchAll(/§+\s*([0-9]+(?:\.[0-9]+)?)(?:\s*[–-]\s*(\.?[0-9]+(?:\.[0-9]+)?))?/g)) {
      const from = num(s[1]); let to = s[2] ? num(s[2]) : from;
      if (s[2] && /^\./.test(s[2])) to = Math.floor(from) + num(s[2]); // "§§11549.80–.86"
      out.push({ code: c.id, from, to });
    }
    const sec = before.match(/\bSection\s+([0-9]+(?:\.[0-9]+)?)\s+of\s+the\s*$/i); if (sec) out.push({ code: c.id, from: num(sec[1]), to: num(sec[1]) });
  }
  for (const m of clause.matchAll(/\bchapter\s+([0-9]+[A-Z]{1,2})\b/gi)) out.push({ code: 'chapter', chapter: m[1].toUpperCase() });
  for (const m of clause.matchAll(/\b([0-9]+)\s+U\.S\.C\.\s*§*\s*([0-9]+[a-z0-9-]*)/g)) out.push({ code: 'usc:' + m[1], sec: m[2] });
  return out;
}
const covers = (own, c) => own.code === c.code && ((own.art && c.art === own.art) || (own.chapter && c.chapter === own.chapter) || (own.sec && c.sec === own.sec) || (own.from != null && c.from != null && c.from >= own.from && c.to <= own.to));
const sameCode = (own, c) => own.code === c.code;

// Clauses of a text, split at ";", ":" and sentence ends; abbreviations ("Gen. Bus.", "Art.", "Sen.") do not end a sentence.
export function clauses(text) {
  const masked = String(text || '').replace(/\b([A-Z][a-z]{0,3}|[A-Z](?:\.[A-Z])+)\.(?=\s)/g, (m) => m.replace(/\./g, '\u0000'));
  return masked.split(/;\s|:\s|\.\s+(?=[A-Z(])|\.$/).map((c) => c.replace(/\u0000/g, '.').trim()).filter((c) => c.length >= 8);
}
const ENACTS = /\b(?:enacts|creates|establishes|adds a new|new\s+(?:Art|Article|chapter))\b|\bChapter\s+[0-9]+[A-Z]{1,2}\s+effective\b/i;
const AMENDS = /\b(?:amends|would amend|adds|by adding)\b/i;
const NEGATED = /\b(?:not|cannot|no|never)\b[^,]*\b(?:amend|add)/i;
const lawText = (e) => [e.title, e.mechanism].filter(Boolean).join('. ');

// What a law (or a bill that would create one) occupies in the code: from its title's parentheses and from clauses that enact.
export function ownedCitations(e) {
  const own = [], paren = String(e.title || '').match(/\(([^()]*(?:Code|Law|U\.S\.C\.)[^()]*)\)/);
  if (paren) citations(paren[1]).forEach((c) => own.push({ ...c, quote: paren[0], field: 'title' }));
  clauses(e.mechanism).filter((c) => ENACTS.test(c)).forEach((cl) => citations(cl).forEach((c) => own.push({ ...c, quote: cl, field: 'mechanism' })));
  return own;
}
// Names a law goes by: its short name without state code and parentheses ("RAISE Act"), and an acronym in parentheses ("TFAIA").
export function aliases(e) {
  const s = String(e.short_name || ''), out = [];
  const plain = s.replace(/\(.*?\)/g, '').replace(/^[A-Z]{2}\s+/, '').trim();
  if (/\bAct\b/.test(plain) && plain.length >= 6) out.push(plain);
  for (const m of s.matchAll(/\(([A-Z]{4,})\)/g)) out.push(m[1]);
  return out;
}

function amendProposals(entry, node, entries, rel, nodeOf, texts) {
  const out = [], url = primaryUrl(entry);
  if (!url) return out;
  const text = lawText(entry), all = [entry.title, entry.mechanism, entry.thresholds].filter(Boolean).join(' ');
  const laws = entries.filter((t) => t.key !== entry.key && nodeOf[t.key] && (t.level === entry.level) && (t.level === 'federal' || t.state === entry.state))
    .map((t) => ({ t, own: ownedCitations(t), names: t.status === 'enacted' ? aliases(t) : [] })).filter((x) => x.own.length || x.names.length);
  for (const cl of clauses(text)) {
    if (!AMENDS.test(cl) || NEGATED.test(cl)) continue;
    const cites = citations(cl);
    for (const { t, own, names } of laws) {
      const named = names.find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(cl));
      const hit = own.find((o) => cites.some((c) => covers(o, c)))
        || (named ? { quote: null } : null)
        || own.find((o) => cites.some((c) => sameCode(o, c)) && names.some((n) => all.includes(n)));
      if (!hit) continue;
      const ev = [{ entry_key: entry.key, quote: cut(cl), source_url: url }];
      const turl = primaryUrl(t);
      if (hit.quote && turl) ev.push({ entry_key: t.key, quote: cut(hit.quote), source_url: turl });
      out.push({ from: node, to: nodeOf[t.key], type: 'succession', label: amendsLabel(rel.nodes[nodeOf[t.key]].name), evidence: ev, method: 'code' });
    }
  }
  return out;
}

// ---------- companions (reported, never drawn) ----------
// billIds: { entry key: ['119/s/2938', 'NY/S10373', ...] }. related: { entry key: Congress.gov relatedBills }.
const BILL = /\b(?:H\.?R\.?|S\.?B\.?|H\.?B\.?|H\.?F\.?|S\.?F\.?|S\.?|A\.)\s?[0-9]+/;
const normBill = (b) => b.toUpperCase().replace(/[\s.]/g, '');
// The bill numbers an entry's title starts with ("S. 5417 / H.R. 10567 — ...").
export const leadBills = (t) => [...String(t || '').split(/\s[—–]\s/)[0].matchAll(new RegExp(BILL.source, 'g'))].map((m) => normBill(m[0]));
const billId = (b) => `${b.congress}/${String(b.type).toLowerCase()}/${b.number}`;
export function companions({ entries, changed, billIds = {}, related = {} }) {
  const owner = {}; Object.entries(billIds).forEach(([k, ids]) => ids.forEach((id) => { owner[id.toLowerCase()] = k; }));
  const out = [];
  for (const key of changed) {
    const e = entries.find((x) => x.key === key); if (!e) continue;
    for (const b of related[key] || []) {
      const id = billId(b), o = owner[id];
      if (!o || o === key || !(b.relationshipDetails || []).some((d) => d.type === 'Identical bill')) continue;
      out.push({ entry_key: key, companion_of: o, bill: id, evidence: 'Congress.gov relatedBills: Identical bill', method: 'code' });
    }
    // the title or sponsor line names a companion bill another entry tracks, e.g. "Senate companion S. 5417"
    const own = new Set(leadBills(e.title));
    for (const m of [e.title, e.sponsor_text].join(' ').matchAll(new RegExp('companion[^;)]{0,40}?(' + BILL.source + ')', 'gi'))) {
      const want = normBill(m[1]); if (own.has(want)) continue;
      const o = entries.find((x) => x.key !== key && x.level === e.level && x.state === e.state && leadBills(x.title).includes(want));
      if (o) out.push({ entry_key: key, companion_of: o.key, bill: m[1], evidence: m[0], method: 'code' });
    }
  }
  return out;
}

// ---------- by code ----------
// entries, relationships: the current data (the changed entries included). changed: entry keys that are new or changed.
// Returns { proposals, nodes: { key: node } for changed entries the network does not have yet, companions }.
export function proposeByCode({ entries, relationships: rel, changed, billIds = {}, related = {}, texts = {} }) {
  const nodeOf = nodeOfEntry(rel), nodes = {}, scratch = { ...rel, nodes: { ...rel.nodes } }, types = usedTypes(rel);
  for (const key of changed) if (!nodeOf[key]) { const e = entries.find((x) => x.key === key); if (!e) continue; const n = nodeFor(e, scratch, entries); scratch.nodes[n.key] = n.node; nodes[n.key] = n.node; nodeOf[key] = n.key; }
  const proposals = [];
  for (const key of changed) {
    const e = entries.find((x) => x.key === key); if (!e) continue;
    if (types.has('actor')) proposals.push(...sponsorProposals(e, nodeOf[key], scratch));
    if (types.has('succession')) proposals.push(...amendProposals(e, nodeOf[key], entries, scratch, nodeOf, texts));
  }
  return { proposals: dedupe(proposals, rel), nodes, companions: companions({ entries, changed, billIds, related }) };
}

// One proposal per pair and type, and none the network already has (either direction).
export const pairKey = (a, b, t) => [a, b].sort().join('|') + '|' + t;
export function dedupe(proposals, rel) {
  const seen = new Set(rel.edges.map((e) => pairKey(e.from, e.to, e.type)));
  return proposals.filter((p) => { const k = pairKey(p.from, p.to, p.type); if (seen.has(k) || p.from === p.to) return false; seen.add(k); return true; });
}

// ---------- by AI ----------
// texts: { entry key: { text, url } } official bill texts. reader / validator: AI clients (generate({ system, prompt, itemId }) -> { data }).
// The reader lists links from one changed bill to bills in the network; code then needs each quote word for word in the right
// bill's text, and the validator must confirm the relation from the two quotes. Anything short of that is dropped (reported).
const KIND = { copies: 'template', modeled_on: 'template', overlaps: 'succession' };
export async function proposeByAI({ entries, relationships: rel, changed, texts = {}, reader, validator, nodes = {}, maxCandidates = 40, log = () => {} }) {
  const nodeOf = nodeOfEntry(rel); Object.entries(nodes).forEach(([k, n]) => { nodeOf[n.entry_key] = k; });
  const types = usedTypes(rel), proposals = [], dropped = [];
  for (const key of changed) {
    const e = entries.find((x) => x.key === key), mine = texts[key];
    if (!e || !mine || !mine.text || !nodeOf[key]) continue;
    const cands = entries.filter((x) => x.key !== key && nodeOf[x.key] && texts[x.key] && texts[x.key].text).slice(0, maxCandidates);
    if (!cands.length) continue;
    const r = await reader.generate({ system: READER_SYSTEM, prompt: readerPrompt({ entry: e, text: mine.text, candidates: cands }), itemId: 'links:' + key });
    for (const l of ((r.data && r.data.links) || []).filter((x) => x && typeof x === 'object')) {
      const t = cands.find((x) => x.key === l.to), type = KIND[l.kind];
      const why = !t ? `unknown bill ${l.to}` : !type || !types.has(type) ? `kind ${l.kind} is not a link type the network draws`
        : !containsQuote(mine.text, l.quote_from) || String(l.quote_from).trim().length < 20 ? 'the quote from this bill is not in its text'
        : !containsQuote(texts[t.key].text, l.quote_to) || String(l.quote_to).trim().length < 20 ? 'the quote from the other bill is not in its text' : null;
      if (why) { dropped.push({ entry_key: key, to: l.to, why }); log(`${key} -> ${l.to}: dropped (${why})`); continue; }
      const v = await validator.generate({ system: CONFIRM_SYSTEM, prompt: confirmPrompt({ a: e, b: t, kind: l.kind, quoteA: l.quote_from, quoteB: l.quote_to }), itemId: 'links-confirm:' + key + ':' + t.key });
      if (!(v.data && v.data.confirmed === true)) { dropped.push({ entry_key: key, to: t.key, why: 'the validator did not confirm: ' + String((v.data && v.data.reason) || 'no reason') }); continue; }
      const label = type === 'template' ? LABEL.copies : 'Overlap: ' + String(l.label || '').replace(/^overlap:\s*/i, '').trim().slice(0, 100);
      if (label.length < 12) { dropped.push({ entry_key: key, to: t.key, why: 'no label for the overlap' }); continue; }
      proposals.push({ from: nodeOf[key], to: nodeOf[t.key], type, label, dashed: true, method: 'ai',
        evidence: [{ entry_key: key, quote: String(l.quote_from).trim(), source_url: mine.url }, { entry_key: t.key, quote: String(l.quote_to).trim(), source_url: texts[t.key].url }] });
    }
  }
  return { proposals: dedupe(proposals, rel), dropped };
}

// Both readers, code first: an AI link for a pair code already linked is dropped as a duplicate.
export async function propose({ entries, relationships, changed, billIds, related, texts, reader, validator, log }) {
  const c = proposeByCode({ entries, relationships, changed, billIds, related, texts });
  if (!reader || !validator) return { ...c, dropped: [] };
  const withCode = { ...relationships, edges: [...relationships.edges, ...c.proposals] };
  const a = await proposeByAI({ entries, relationships: withCode, changed, texts, reader, validator, nodes: c.nodes, log });
  return { proposals: [...c.proposals, ...a.proposals], nodes: c.nodes, companions: c.companions, dropped: a.dropped };
}
