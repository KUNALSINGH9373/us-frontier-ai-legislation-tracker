// Links between entries, proposed for new or changed entries. Two readers:
//   by code (facts the text states): the bill's lead sponsor is a legislator already in the network (same first and last name,
//     chamber, state and, where the node states it, party; from the official record's primary sponsors when the step has the
//     record); a bill amends a law the tracker has (an explicit "amends" whose object is the law's name or a code section it
//     enacts, or "adds" whose object is such a section). Companion bills are found too (Congress.gov "Identical bill", or a title
//     naming another entry's bill as its companion), but the tracker keeps a bill and its companion in ONE entry, so they are
//     reported for merging, never drawn as a link. Anything unsure (two legislators match, a repeal, a record sponsor the entry's
//     text does not name) is reported under `notes`, never proposed.
//   by AI (reading): "copies / overlaps / modeled on", only with a quote from BOTH bills that code finds word for word in each
//     bill's text, and a second reader (role validator) agreeing. Prompts in prompts.mjs.
// Direction, labels and evidence follow links/rules.mjs. Every proposal:
//   { from, to, type, label, evidence: [{ entry_key, node, field, quote, source_url }], method: 'code' | 'ai', dashed? }
// evidence[0] is the edge's quote: verbatim in field `field` of the entry at node `node` (source_url = its tracker page), or, for
// AI links, field 'text' and the official text's URL. Only edge types the network already draws are proposed. Nothing is written
// here: apply.mjs adds accepted proposals.
import { containsQuote } from '../agents/source-text.mjs';
import { READER_SYSTEM, readerPrompt, CONFIRM_SYSTEM, confirmPrompt } from './prompts.mjs';
import { trackerUrl, sponsorLabel, amendsLabel, TEMPLATE_LABEL, OVERLAP_PREFIX, legislatorOf, chamberOf } from './rules.mjs';

export { amendsLabel };
export const LABEL = { sponsor: 'Sponsor', draft: 'Draft author', copies: TEMPLATE_LABEL };

const MAX_QUOTE = 240;
const nodeOfEntry = (rel) => { const m = {}; Object.entries(rel.nodes).forEach(([k, n]) => { if (n.kind === 'entry') m[n.entry_key] = k; }); return m; };
const usedTypes = (rel) => new Set(rel.edges.map((e) => e.type).filter((t) => rel.types[t]));
export const primaryUrl = (e) => { const s = (e.sources || []).find((x) => x.kind === 'primary') || (e.sources || [])[0]; return s ? s.url : null; };
// A verbatim piece of a field, cut at a word boundary so it stays a substring of the text it came from.
const cut = (s) => { const t = s.trim(); if (t.length <= MAX_QUOTE) return t; const i = t.lastIndexOf(' ', MAX_QUOTE); return t.slice(0, i > 40 ? i : MAX_QUOTE); };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// One piece of evidence from the tracker's own prose: the quote must be in the field as written.
const entryEvidence = (entry, node, field, quote) => ({ entry_key: entry.key, node, field, quote: cut(quote), source_url: trackerUrl(entry) });

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
// The lead sponsor as the tracker states it: the sponsor text must START with a legislator's title, full name and party
// ("Sen. Jerry Moran (R-KS)", "Reps. Sara Jacobs (D-CA), ...", "Sen. Mary Edly-Allen (D-Lake County), chief sponsor"); only that
// first person is the lead. Anyone after (co-sponsors, "with ...", "cosponsored by", "supported by", "opposed by") is never read,
// and a text that starts any other way ("Opposed by Sen. ...") names no lead sponsor.
const LEAD = /^\s*(Sens?|Reps?|Asm|Assemblymember|Del)\.?\s+((?:[A-Z][A-Za-z'’.-]*\s+){1,3}?[A-Z][A-Za-z'’-]+)\s*\(\s*([DRI])(?:-([A-Z]{2})(?=\)))?[^)]*\)/;
export function leadSponsor(text) {
  const m = String(text || '').match(LEAD); if (!m) return null;
  const parts = m[2].trim().split(/\s+/);
  return { chamber: chamberOf(m[1]), first: parts[0], last: parts[parts.length - 1], party: m[3], state: m[4] || null, quote: m[0].trim() };
}
// Kept for callers: the text of the lead sponsor ('' when the text names none).
export const leadSponsors = (s) => { const l = leadSponsor(s); return l ? l.quote : ''; };

// Primary sponsors from an official record: Congress.gov (bill.sponsors, each with a bioguideId) or LegiScan (bill.sponsors with
// people_id, sponsor_type_id 1 = primary; when none is marked primary, none: the first listed is never assumed to be the lead).
export function recordSponsors(rec, entry) {
  const b = (rec && (rec.bill || rec)) || {}, s = Array.isArray(b.sponsors) ? b.sponsors : [];
  if (s.some((x) => x && x.bioguideId)) return s.filter((x) => x && x.bioguideId && x.firstName && x.lastName).map((x) => ({ id: 'bioguide:' + x.bioguideId, chamber: chamberOf(x.fullName), first: x.firstName, last: x.lastName, party: x.party || null, state: x.state || null }));
  const ls = s.filter((x) => x && x.people_id && !x.committee_sponsor);
  const prim = ls.filter((x) => x.sponsor_type_id === 1);
  return prim.filter((x) => x.first_name && x.last_name).map((x) => ({ id: 'legiscan:' + x.people_id, chamber: chamberOf(x.role), first: x.first_name, last: x.last_name, party: x.party || null, state: entry.state || null }));
}

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
// A person matches a legislator node when first and last name, chamber and state all match, the level fits (Congress nodes
// carry a party, state nodes do not), and the party matches wherever the node states one.
function matches(person, actor, entry) {
  const state = entry.level === 'federal' ? person.state : entry.state;
  if (!person.chamber || !person.first || !person.last || !state) return false;
  if (actor.federal !== (entry.level === 'federal')) return false;
  if (entry.level === 'state' && person.state && person.state !== entry.state) return false;
  if (actor.party && !same(actor.party, person.party)) return false;
  return actor.chamber === person.chamber && same(actor.first, person.first) && same(actor.last, person.last) && actor.state === state;
}
// A sponsor edge is drawn only for the entry's stated lead sponsor (leadSponsor), quoting that lead clause. With an official
// record, the record's primary sponsor must BE that lead (same first and last name and chamber, both matching the same node); a
// record whose primary is someone else, or that marks no primary, draws nothing (reported).
function sponsorProposals(entry, node, rel, records, notes) {
  const label = sponsorLabel(entry); if (!label) return [];
  const actors = Object.entries(rel.nodes).filter(([, n]) => n.kind === 'actor').map(([k, n]) => ({ k, ...legislatorOf(n.name) })).filter((a) => a.chamber);
  const recs = (records && records[entry.key]) || [];
  const lead = leadSponsor(entry.sponsor_text);
  const note = (why) => notes.push({ entry_key: entry.key, kind: 'sponsor', why });
  if (!lead) { if (recs.length) note('the record\'s sponsor is not named as the lead sponsor: the entry\'s sponsor text names no lead ("Sen./Rep. First Last (Party)" at its start); nothing proposed'); return []; }
  let person = lead, id = null;
  if (recs.length) {
    const prim = recs.flatMap((r) => recordSponsors(r, entry));
    if (!prim.length) { note(`the official record marks no primary sponsor, so the entry's lead ${lead.first} ${lead.last} is not confirmed; nothing proposed`); return []; }
    const hits = prim.filter((p) => same(p.first, lead.first) && same(p.last, lead.last) && p.chamber === lead.chamber);
    if (hits.length !== 1) { note(`the record's primary sponsor ${prim.map((p) => p.first + ' ' + p.last).join(', ')} is not named as the entry's lead sponsor (${lead.first} ${lead.last}); nothing proposed`); return []; }
    person = hits[0]; id = person.id;
  }
  const hit = actors.filter((a) => matches(person, a, entry) && matches(lead, a, entry));
  if (hit.length > 1) { note(`ambiguous: ${lead.first} ${lead.last} matches ${hit.map((a) => a.k).join(', ')}; nothing proposed`); return []; }
  if (!hit.length) return [];
  return [{ from: hit[0].k, to: node, type: 'actor', label, evidence: [entryEvidence(entry, node, 'sponsor_text', lead.quote)], method: 'code', ...(id ? { record_id: id } : {}) }];
}
// The meaning check checkLinks runs on a Sponsor edge: its quote is exactly the lead clause of the sponsor text, and that lead is
// the legislator at the edge's `from` (null when it is; otherwise the problem).
export function sponsorQuoteProblem(sponsorText, quote, actorName) {
  const lead = leadSponsor(sponsorText), a = legislatorOf(actorName);
  if (!lead || quote !== lead.quote) return 'the quote is not the lead sponsor clause at the start of the sponsor text';
  if (!a || a.chamber !== lead.chamber || !same(a.first, lead.first) || !same(a.last, lead.last)) return `the lead sponsor in the quote is not ${actorName}`;
  return null;
}

// ---------- amendments ----------
const CODES = [
  { id: 'gbl', re: /\b(?:GBL|Gen\.\s?Bus\.\s?Law|General Business Law)\b/gi },
  { id: 'gov', re: /\bGov(?:\.|ernment)\s+Code\b/gi },
  { id: 'bpc', re: /\bBus(?:\.|iness)\s+(?:&|and)\s+Prof(?:\.|essions)\s+Code\b/gi }
];
const num = (s) => parseFloat(String(s).replace(/^\./, '0.'));
// A section number as its dot-separated integer parts ("8898.10" -> [8898, 10]): §8898.10 follows §8898.9, so sections are
// compared part by part, never as decimals (8898.10 is not 8898.1). A shorter number sorts before its own subdivisions.
const parts = (s) => String(s).split('.').map((x) => parseInt(x, 10));
const cmpParts = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i] === undefined) return -1; if (b[i] === undefined) return 1; if (a[i] !== b[i]) return a[i] - b[i]; } return 0; };
// Code citations in one clause: [{ code, art } | { code, from, to } | { code: 'chapter', chapter } | { code: 'usc:<title>', sec }].
export function citations(clause) {
  const out = [];
  for (const c of CODES) for (const m of clause.matchAll(c.re)) {
    const win = clause.slice(m.index, m.index + m[0].length + 70), before = clause.slice(Math.max(0, m.index - 30), m.index);
    const art = win.match(/\bArt(?:icle|\.)\s*([0-9]+(?:-[A-Z])?)/i); if (art) out.push({ code: c.id, art: art[1].toUpperCase() });
    for (const s of win.matchAll(/§+\s*([0-9]+(?:\.[0-9]+)?)(?:\s*[–-]\s*(\.?[0-9]+(?:\.[0-9]+)?))?/g)) {
      const from = num(s[1]); let to = s[2] ? num(s[2]) : from;
      const fromP = parts(s[1]); let toP = s[2] ? parts(s[2]) : fromP;
      if (s[2] && /^\./.test(s[2])) { to = Math.floor(from) + num(s[2]); toP = [fromP[0], ...parts(s[2].slice(1))]; } // "§§11549.80–.86"
      out.push({ code: c.id, from, to, fromP, toP });
    }
    const sec = before.match(/\bSection\s+([0-9]+(?:\.[0-9]+)?)\s+of\s+the\s*$/i); if (sec) out.push({ code: c.id, from: num(sec[1]), to: num(sec[1]), fromP: parts(sec[1]), toP: parts(sec[1]) });
  }
  for (const m of clause.matchAll(/\bchapter\s+([0-9]+[A-Z]{1,2})\b/gi)) out.push({ code: 'chapter', chapter: m[1].toUpperCase() });
  // "15 U.S.C. §278h-1", "15 U.S.C. § 278h–1(a)", "15 U.S.C. 278h-1": the section, with an en dash read as a hyphen
  for (const m of clause.matchAll(/\b([0-9]+)\s+U\.\s?S\.\s?C\.?\s*(?:§+\s*)?([0-9]+[a-z]*(?:[-–‑][0-9]+[a-z]*)*)/g)) out.push({ code: 'usc:' + m[1], sec: m[2].replace(/[–‑]/g, '-') });
  return out;
}
const covers = (own, c) => own.code === c.code && ((own.art && c.art === own.art) || (own.chapter && c.chapter === own.chapter) || (own.sec && c.sec === own.sec) || (own.fromP && c.fromP && cmpParts(c.fromP, own.fromP) >= 0 && cmpParts(c.toP, own.toP) <= 0));

// Clauses of a text, split at ";", ":" and sentence ends; abbreviations ("Gen. Bus.", "Art.", "Sen.") do not end a sentence.
export function clauses(text) {
  const masked = String(text || '').replace(/\b([A-Z][a-z]{0,3}|[A-Z](?:\.[A-Z])+)\.(?=\s)/g, (m) => m.replace(/\./g, '\u0000'));
  return masked.split(/;\s|:\s|\.\s+(?=[A-Z(])|\.$/).map((c) => c.replace(/\u0000/g, '.').trim()).filter((c) => c.length >= 8);
}
const ENACTS = /\b(?:enacts|creates|establishes|adds a new|new\s+(?:Art|Article|chapter)|codified at)\b|\bChapter\s+[0-9]+[A-Z]{1,2}\s+effective\b/i;

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

// The object of a verb: the words after it up to the first ",", " to ", " so ", " that ", " which ", " by ", " and " outside
// parentheses ("Amends the RAISE Act (GBL Article 44-B as replaced by Chapter 96) by adding ..." -> "the RAISE Act (GBL ...)").
function objectAfter(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (!depth && (ch === ',' || /^\s(?:to|so|that|which|by|and|while|but|unlike|like|as)\s/i.test(s.slice(i, i + 9)))) return s.slice(0, i);
  }
  return s;
}
// The verbs: an explicit amendment ("amends", "would amend", "amending", "to amend", "by amending"), "adds" only with a code
// section as its direct object ("Adds GBL §1425", "adds new GBL §1425", "by adding Section 1422 of the General Business Law"),
// and a repeal (never drawn as "would amend"; reported).
const AMEND_VERB = /\b(?:amends|would amend|amending|to amend)\b/gi;
const ADD_VERB = /\b(?:adds|by adding|adding|would add)\s+(?:a\s+)?(?:new\s+)?(?=(?:GBL|Gen\.\s?Bus|General Business|Gov(?:\.|ernment)\s+Code|Bus(?:\.|iness)\s|§|Sections?\s+[0-9]|Article\s+[0-9]|Art\.\s*[0-9]|chapter\s+[0-9]|[0-9]+\s+U\.S\.C))/gi;
const REPEAL_VERB = /\b(?:repeals|would repeal|repealing|to repeal)\b/gi;
const NEGATED = /\b(?:not|cannot|no|never|without|nor)\b/i;
// The object names law t: its name at the head of the object (after "the" and an optional "Section N of the"), or a code
// citation in the object that law t occupies.
// The name must be the WHOLE name: followed only by the end of the object or a parenthesis ("the RAISE Act (GBL Art. 44-B)"),
// never by more title words ("the RAISE Act for Kids of 2024" is another act). Citations are read only in the object's head: the
// first law it cites and that law's own section, article or parenthesis ("Public Health Law § 2805 cross-referenced in GBL
// Art. 44-B" amends the Public Health Law, not GBL Art. 44-B).
function objectNames(obj, t, own, names) {
  const head = String.raw`^\s*(?:the\s+)?(?:(?:[Ss]ections?|§§?)\s*[0-9][\w.–-]*(?:\s*(?:,|and|through|to|–|-)\s*[0-9][\w.–-]*)*\s+of\s+(?:the\s+)?)?`;
  if (names.some((n) => new RegExp(head + esc(n) + String.raw`\s*(?:\(|$)`).test(obj))) return { by: 'name' };
  const cites = citations(objectHead(obj)), o = own.find((x) => cites.some((c) => covers(x, c)));
  return o ? { by: 'citation', own: o } : null;
}
const LAW_WORD = /\b(?:Law|Code|Act|GBL|U\.\s?S\.\s?C\.?)(?![A-Za-z])/;
const CITE_TAIL = /^(?:\s*(?:§+\s*[0-9][\w.]*(?:\([\w]+\))*(?:\s*(?:[–‑-]|through|to|,)\s*\.?[0-9][\w.]*(?:\([\w]+\))*)*|[0-9]+[a-z]*(?:[–‑-][0-9]+[a-z]*)*(?:\([\w]+\))*|Art(?:icle|\.)\s*[0-9]+(?:-[A-Z])?|chapter\s+[0-9]+[A-Z]{0,2}|\([^()]*(?:\([^()]*\)[^()]*)*\)))+/i;
function objectHead(obj) {
  const m = obj.match(LAW_WORD); if (!m) return obj;
  const end = m.index + m[0].length, tail = obj.slice(end).match(CITE_TAIL);
  return obj.slice(0, end + (tail ? tail[0].length : 0));
}
// An operative verb has the bill itself as its subject: it opens the clause ("Amends ...", "This act amends ...", "This bill
// would amend ...", "It adds ..."), or is joined by "and" / "by" to such an opening verb ("Amends X by adding §...", "(and
// amending § 1429)"). A verb anywhere else ("directs the AG to report on whether to amend", "rules adopted by the Department
// amending") is not the bill acting.
const SUBJECT = /^\s*(?:(?:this|the)\s+(?:act|bill|measure|legislation|section)\s+|it\s+)?(?:also\s+)?$/i;
const OPENS = /^\s*(?:(?:this|the)\s+(?:act|bill|measure|legislation|section)\s+|it\s+)?(?:also\s+)?(?:amends|would amend|adds|would add|repeals|would repeal)\b/i;
const JOINED = /(?:\band|\bby|\(and)\s*$/i;
const operative = (cl, at) => SUBJECT.test(cl.slice(0, at)) || (OPENS.test(cl) && JOINED.test(cl.slice(0, at)));
const verbsOf = (cl) => {
  const verbs = (re, kind) => [...cl.matchAll(re)].map((m) => ({ kind, at: m.index, obj: objectAfter(cl.slice(m.index + m[0].length)) }));
  return [...verbs(REPEAL_VERB, 'repeal'), ...verbs(AMEND_VERB, 'amend'), ...verbs(ADD_VERB, 'add')]// a repeal is kept wherever it stands: it only ever stops a link
    .filter((v) => (v.kind === 'repeal' || operative(cl, v.at)) && !NEGATED.test(cl.slice(0, v.at)));
};
const lawOf = (t) => ({ t, own: ownedCitations(t), names: t.status === 'enacted' ? aliases(t) : [] });
// Does clause `cl` amend law entry t: an operative, un-negated amend (or add, by citation) whose object names t, with no repeal
// of t in the same clause? Returns the hit ({ by, own? }) or null. checkLinks runs it on every added "Would amend" quote.
export function amendsLaw(cl, t, law = lawOf(t)) {
  const all = verbsOf(cl), { own, names } = law;
  if (all.some((w) => w.kind === 'repeal' && objectNames(w.obj, t, own, names))) return null;
  for (const v of all) {
    if (v.kind === 'repeal') continue;
    const hit = objectNames(v.obj, t, own, names); if (!hit) continue;
    if (v.kind === 'add' && hit.by !== 'citation') continue;
    return hit;
  }
  return null;
}

function amendProposals(entry, node, entries, rel, nodeOf, notes) {
  const out = [];
  const laws = entries.filter((t) => t.key !== entry.key && nodeOf[t.key] && t.level === entry.level && (t.level === 'federal' || t.state === entry.state))
    .map(lawOf).filter((x) => x.own.length || x.names.length);
  if (!laws.length) return out;
  const done = new Set();
  for (const field of ['title', 'mechanism']) for (const cl of clauses(entry[field])) {
    const all = verbsOf(cl);
    for (const v of all) {
      for (const law of laws) {
        const { t, own, names } = law;
        const hit = objectNames(v.obj, t, own, names); if (!hit) continue;
        if (v.kind === 'add' && hit.by !== 'citation') continue;
        if (v.kind === 'repeal') { notes.push({ entry_key: entry.key, kind: 'amendment', law: t.key, why: `"${cut(cl)}" repeals ${t.short_name}; a repeal is not drawn as "would amend"` }); done.add('repeal:' + t.key); continue; }
        if (done.has(t.key) || done.has('repeal:' + t.key)) continue;
        // a clause that also repeals this law is reported above, never drawn
        if (all.some((w) => w.kind === 'repeal' && objectNames(w.obj, t, own, names))) continue;
        // the quote as published (cut to length) must itself show the amendment, as checkLinks will check
        if (!amendsLaw(cut(cl), t, law)) { notes.push({ entry_key: entry.key, kind: 'amendment', law: t.key, why: `the quotable part of "${cut(cl)}" does not show the amendment of ${t.short_name}; nothing proposed` }); continue; }
        done.add(t.key);
        const ev = [entryEvidence(entry, node, field, cl)];
        if (hit.own) ev.push(entryEvidence(t, nodeOf[t.key], hit.own.field, hit.own.quote));
        out.push({ from: node, to: nodeOf[t.key], type: 'succession', label: amendsLabel(rel.nodes[nodeOf[t.key]].name), evidence: ev, method: 'code' });
      }
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
// records: { entry key: [official records (Congress.gov / LegiScan raw)] }, used for primary sponsors when present.
// Returns { proposals, nodes: { key: node } for changed entries the network does not have yet, companions, notes }.
export function proposeByCode({ entries, relationships: rel, changed, billIds = {}, related = {}, records = {} }) {
  const nodeOf = nodeOfEntry(rel), nodes = {}, scratch = { ...rel, nodes: { ...rel.nodes } }, types = usedTypes(rel), notes = [];
  for (const key of changed) if (!nodeOf[key]) { const e = entries.find((x) => x.key === key); if (!e) continue; const n = nodeFor(e, scratch, entries); scratch.nodes[n.key] = n.node; nodes[n.key] = n.node; nodeOf[key] = n.key; }
  const proposals = [];
  for (const key of changed) {
    const e = entries.find((x) => x.key === key); if (!e) continue;
    if (types.has('actor')) proposals.push(...sponsorProposals(e, nodeOf[key], scratch, records, notes));
    if (types.has('succession')) proposals.push(...amendProposals(e, nodeOf[key], entries, scratch, nodeOf, notes));
  }
  const kept = dedupe(proposals, rel, notes);
  return { proposals: kept, nodes, companions: companions({ entries, changed, billIds, related }), notes };
}

// One proposal per pair and type, none the network already has in either direction, and none whose reverse the network has
// under any type (a reverse edge would contradict the direction convention).
export const pairKey = (a, b, t) => [a, b].sort().join('|') + '|' + t;
export function dedupe(proposals, rel, notes = []) {
  const seen = new Set(rel.edges.map((e) => pairKey(e.from, e.to, e.type)));
  const dir = new Set(rel.edges.map((e) => e.from + '>' + e.to));
  return proposals.filter((p) => {
    const k = pairKey(p.from, p.to, p.type);
    if (p.from === p.to) return false;
    if (dir.has(p.to + '>' + p.from)) { notes.push({ entry_key: p.evidence[0].entry_key, kind: 'reverse', why: `${p.to} -> ${p.from} already exists; ${p.from} -> ${p.to} (${p.label}) not proposed` }); return false; }
    if (seen.has(k)) return false;
    seen.add(k); dir.add(p.from + '>' + p.to); return true;
  });
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
      const label = type === 'template' ? LABEL.copies : OVERLAP_PREFIX + String(l.label || '').replace(/^overlap:\s*/i, '').trim().slice(0, 100);
      if (label.length < 12) { dropped.push({ entry_key: key, to: t.key, why: 'no label for the overlap' }); continue; }
      proposals.push({ from: nodeOf[key], to: nodeOf[t.key], type, label, dashed: true, method: 'ai',
        evidence: [{ entry_key: key, node: nodeOf[key], field: 'text', quote: String(l.quote_from).trim(), source_url: mine.url }, { entry_key: t.key, node: nodeOf[t.key], field: 'text', quote: String(l.quote_to).trim(), source_url: texts[t.key].url }] });
    }
  }
  return { proposals: dedupe(proposals, rel), dropped };
}

// Both readers, code first: an AI link for a pair code already linked is dropped as a duplicate.
export async function propose({ entries, relationships, changed, billIds, related, records, texts, reader, validator, log }) {
  const c = proposeByCode({ entries, relationships, changed, billIds, related, records });
  if (!reader || !validator) return { ...c, dropped: [] };
  const withCode = { ...relationships, edges: [...relationships.edges, ...c.proposals] };
  const a = await proposeByAI({ entries, relationships: withCode, changed, texts, reader, validator, nodes: c.nodes, log });
  return { proposals: [...c.proposals, ...a.proposals], nodes: c.nodes, companions: c.companions, notes: c.notes, dropped: a.dropped };
}
