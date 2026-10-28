// The link convention, in one place: links/propose.mjs follows it and publish/guards.mjs (checkLinks) enforces it.
//
// Direction: an edge reads "<from> <label> <to>". `from` is the party that acts: the legislator who sponsors a bill (actor ->
// entry), the bill that would amend a law (amending bill -> law). Of the three hand-written amendment edges in the network, two
// follow this (S10373 -> RAISE "Adds GBL §1425 ...", S10456 -> RAISE "Adds GBL §1430 ..."); RAISE -> NYTERM, labelled "Would amend
// the RAISE Act", names its own `from` in the label and is the odd one out (left as written; the pipeline never edits old edges).
// An edge is never proposed when the network already links the pair in either direction.
//
// Labels written by code: an actor edge is "Sponsor" for a bill, law, auditor-licensing bill or precursor, and "Draft author"
// for a discussion draft (the network's own wording for drafts: Obernolte / Trahan -> GAAIA, Blackburn -> TRUMPAI); no sponsor
// edge for any other entry type. An amendment edge is "Would amend <law's node name>", type succession.
//
// Evidence: a code edge's quote is the tracker's own prose (the entry's sponsor_text, title or mechanism), so the edge says so:
// `src` is the node of the entry quoted, `col` the field, and `source_url` that entry's page on the tracker, never the bill's page.
// An AI edge quotes the official bill text: `col` is "text" and `source_url` the text it was read from.
// Applied vs proposed (29 Oct 2026): the ONLY edge ever added automatically is a sponsor edge proved by the entry's official record
// (`col` "record": the quote is the record's own sponsor field, `source_url` the record's page, the sponsor's bioguideId / LegiScan
// people_id stored for the actor in config/actor-ids.json). Every edge read from prose or by AI, above, is a proposal in the run
// report, never added: three audit rounds showed prose patterns never converge on zero wrong links.

export const TRACKER_URL = 'https://usfrontierlaw.com/#/bill/';
export const trackerUrl = (entry) => TRACKER_URL + entry.id;
export const ENTRY_FIELDS = ['sponsor_text', 'title', 'mechanism'];

export const SPONSOR_LABEL = { bill: 'Sponsor', law: 'Sponsor', auditor: 'Sponsor', precursor: 'Sponsor', draft: 'Draft author' };
export const sponsorLabel = (entry) => SPONSOR_LABEL[entry && entry.type] || null;
export const AMEND_PREFIX = 'Would amend ';
export const amendsLabel = (name) => AMEND_PREFIX + name;
export const TEMPLATE_LABEL = 'Same template; common drafting source rather than sequential copying';
export const OVERLAP_PREFIX = 'Overlap: ';

// Legislator actor nodes: "Sen. Josh Hawley (R-MO)" (Congress: party and state) or "Sen. Scott Wiener (CA)" (state: state only).
const NODE = /^(Sen|Rep|Asm|Del)\.\s+(.+?)\s+\((?:([DRI])-)?([A-Z]{2})\)\s*$/;
// "Del." is its own chamber: a delegate (a non-voting House member from a territory, or a member of a House of Delegates) is never
// read as a Representative, so "Del. Ted Lieu" never matches "Rep. Ted Lieu".
export const chamberOf = (t) => (/^sen/i.test(String(t)) ? 'upper' : /^(rep|asm|assembly)/i.test(String(t)) ? 'lower' : /^del/i.test(String(t)) ? 'delegate' : null);
export function legislatorOf(name) {
  const m = String(name || '').match(NODE); if (!m) return null;
  const parts = m[2].split(/\s+/).filter(Boolean); if (parts.length < 2) return null;
  return { chamber: chamberOf(m[1]), first: parts[0], last: parts[parts.length - 1], party: m[3] || null, state: m[4], federal: !!m[3] };
}

// What an automated edge must be, by its type: [kind of `from`, kind of `to`, label test].
export function edgeShapeProblem(e, nodes, entryOf) {
  const f = nodes[e.from], t = nodes[e.to];
  if (!f || !t) return `an end is not a node (${!f ? e.from : e.to})`;
  if (e.type === 'actor') {
    if (f.kind !== 'actor' || t.kind !== 'entry') return 'a sponsor link must go from an actor to an entry';
    const want = sponsorLabel(entryOf(t.entry_key));
    if (!want) return `entry ${t.entry_key} is not a type that has sponsors`;
    if (e.label !== want) return `label "${e.label}" is not "${want}" for a ${entryOf(t.entry_key).type}`;
    if (!legislatorOf(f.name)) return `actor ${e.from} is not a legislator`;
    return null;
  }
  if (f.kind !== 'entry' || t.kind !== 'entry') return `a ${e.type} link must join two entries`;
  if (f.entry_key === t.entry_key) return 'a link from an entry to itself';
  if (e.type === 'succession' && e.label.startsWith(AMEND_PREFIX)) {
    if (e.label !== amendsLabel(t.name)) return `label "${e.label}" does not name the amended law ${t.name}`;
    const a = entryOf(f.entry_key), b = entryOf(t.entry_key);
    if (!a || !b || a.level !== b.level || (a.level === 'state' && a.state !== b.state)) return 'an amendment must stay in one jurisdiction';
    return null;
  }
  if (e.type === 'succession' && e.label.startsWith(OVERLAP_PREFIX) && e.dashed) return null;
  if (e.type === 'template' && e.label === TEMPLATE_LABEL && e.dashed) return null;
  return `type ${e.type} with label "${e.label}" is not one the pipeline writes`;
}
