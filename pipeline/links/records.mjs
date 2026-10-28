// Official records as the links step reads them: the structured sponsor of a bill (Congress.gov bioguideId, LegiScan people_id with
// sponsor_type_id 1), the URL of the record itself, and the stored official ids of the network's legislator nodes
// (config/actor-ids.json, built by links/actor-ids.mjs). A sponsor edge is applied automatically ONLY when the record proves it:
// the record's primary sponsor carries an official id, that id is stored for exactly one actor node, and that sponsor is the
// entry's stated lead. Everything else the links step finds is a proposal, reported, never applied.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ACTOR_IDS_FILE = path.join(here, '..', 'config', 'actor-ids.json');

// { node key: { bioguide?: 'L000582', legiscan?: 19716 } }; a missing or unreadable file is no ids (nothing applied).
export function loadActorIds(file = ACTOR_IDS_FILE) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && j.ids && typeof j.ids === 'object' ? j.ids : {}; } catch { return {}; }
}
// The node whose stored id is `id` ('bioguide:X' / 'legiscan:N'); null unless exactly one node has it.
export function nodeOfId(id, actorIds) {
  const [kind, v] = String(id || '').split(':'); if (!kind || !v) return null;
  const hits = Object.entries(actorIds || {}).filter(([, x]) => x && x[kind] != null && String(x[kind]) === v).map(([k]) => k);
  return hits.length === 1 ? hits[0] : null;
}

// A record as the update step passes it ({ item_id, source, raw }) or the raw record itself.
export const rawOf = (rec) => (rec && rec.raw && typeof rec.raw === 'object' ? rec.raw : rec) || {};
export const billOf = (rec) => { const r = rawOf(rec); return (r && (r.bill || r)) || {}; };

const CG_TYPE = { HR: 'house-bill', S: 'senate-bill', HJRES: 'house-joint-resolution', SJRES: 'senate-joint-resolution', HRES: 'house-resolution', SRES: 'senate-resolution', HCONRES: 'house-concurrent-resolution', SCONRES: 'senate-concurrent-resolution' };
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
// The public page of the record the sponsor was read from: Congress.gov's bill page, or the LegiScan bill page.
export function recordUrl(rec) {
  const b = billOf(rec);
  if (b.congress && b.type && b.number && CG_TYPE[String(b.type).toUpperCase()]) return `https://www.congress.gov/bill/${ord(Number(b.congress))}-congress/${CG_TYPE[String(b.type).toUpperCase()]}/${b.number}`;
  if (b.bill_id && /^https:\/\/legiscan\.com\//.test(String(b.url || ''))) return b.url;
  return null;
}

// Primary sponsors with their official id, the record's own words for them (`quote`: Congress.gov fullName, LegiScan name) and
// the party the record gives. LegiScan: sponsor_type_id 1 only (no primary marked: none; the first listed is never assumed).
export const chamberOfTitle = (t) => (/^sen/i.test(String(t)) ? 'upper' : /^(rep|asm|assembly)/i.test(String(t)) ? 'lower' : /^del/i.test(String(t)) ? 'delegate' : null);
export function recordSponsors(rec, entry = {}) {
  const b = billOf(rec), s = Array.isArray(b.sponsors) ? b.sponsors : [];
  if (s.some((x) => x && x.bioguideId)) return s.filter((x) => x && x.bioguideId && x.firstName && x.lastName && x.fullName).map((x) => ({ id: 'bioguide:' + x.bioguideId, chamber: chamberOfTitle(x.fullName), first: x.firstName, last: x.lastName, party: x.party || null, state: x.state || null, quote: x.fullName }));
  return s.filter((x) => x && x.people_id && !x.committee_sponsor && x.sponsor_type_id === 1 && x.first_name && x.last_name)
    .map((x) => ({ id: 'legiscan:' + x.people_id, chamber: chamberOfTitle(x.role), first: x.first_name, last: x.last_name, party: x.party || null, state: b.state || entry.state || null, quote: x.name || `${x.first_name} ${x.last_name}` }));
}
// Every person a record names with an official id (sponsors and, on LegiScan, co-sponsors): for building actor-ids.json only.
export function recordPeople(rec) {
  const b = billOf(rec), s = Array.isArray(b.sponsors) ? b.sponsors : [], out = [];
  for (const x of [...s, ...(Array.isArray(b.cosponsors) ? b.cosponsors : [])]) {
    if (!x) continue;
    if (x.bioguideId && x.firstName && x.lastName) out.push({ id: 'bioguide:' + x.bioguideId, kind: 'bioguide', v: x.bioguideId, chamber: chamberOfTitle(x.fullName), first: x.firstName, last: x.lastName, party: x.party || null, state: x.state || null, federal: true });
    else if (x.people_id && x.first_name && x.last_name && !x.committee_sponsor) out.push({ id: 'legiscan:' + x.people_id, kind: 'legiscan', v: x.people_id, chamber: chamberOfTitle(x.role), first: x.first_name, last: x.last_name, party: x.party || null, state: b.state || null, federal: false });
  }
  return out;
}

// Raw records in pipeline/data/runs, by entry key, matched through the entries' identifiers (congress_gov '119/hr/9917', legiscan
// bill_id). The newest run's copy of each record wins. Returns { entry key: [raw] }.
export function loadRunRecords(runsDir, entries) {
  const want = {};
  for (const e of entries) for (const [src, ids] of Object.entries((e.identifiers && e.identifiers.external) || {})) for (const id of ids || []) want[src + ':' + String(id).toLowerCase()] = e.key;
  const found = {};
  let runs = []; try { runs = fs.readdirSync(runsDir).sort(); } catch { return {}; }
  for (const run of runs) {
    for (const src of ['congress_gov', 'legiscan']) {
      const dir = path.join(runsDir, run, 'raw', src); let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        const id = src === 'congress_gov' ? f.replace(/\.json$/, '').replace(/-/g, '/').toLowerCase() : (f.match(/-(\d+)\.json$/) || [])[1];
        const key = id && want[src + ':' + id]; if (!key) continue;
        try { (found[key] = found[key] || {})[src + ':' + id] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* unreadable: skipped */ }
      }
    }
  }
  return Object.fromEntries(Object.entries(found).map(([k, m]) => [k, Object.values(m)]));
}
