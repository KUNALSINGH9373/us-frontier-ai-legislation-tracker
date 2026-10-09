// Converts the current data (web/data/*.json, as the UI reads it today) into the v2 shape.
// It reuses the UI's own tracker-lib.js, so status, type, state and short names are exactly what the UI derives now.
// Nothing is invented: every v2 field comes from the existing data, and fields it cannot know are left out.
//   node schema/legacy-to-v2.mjs          writes pipeline/out/*.v2.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { convertContent } from './content-from-v1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(root, ...p), 'utf8'));

const iso = (d) => d.toISOString().slice(0, 10);
const day = (y, m, d) => iso(new Date(Date.UTC(y, m, d)));
const VERIFIED = '2026-09-05', THROUGH = '2026-09-29', WEEK_FROM = '2026-09-23';

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
const PRIMARY = /(\.gov\b|legislature|leginfo|ilga\.|nysenate|malegislature|capitol|courtlistener|justia|congress|whitehouse|govinfo|federalregister|sec\.state|\.us\/)/i;
const BASIS = { HIGH: 'primary_record', 'MED-HIGH': 'corroborated', MED: 'corroborated', 'SEARCH-QUALIFIED': 'search_negative', LOW: 'single_source' };

export async function convert() {
  const L = await import(pathToFileURL(path.join(root, 'web', 'tracker-lib.js')).href);
  const entries = readJson('web', 'data', 'entries.json'), news = readJson('web', 'data', 'news.json'), rel = readJson('web', 'data', 'relationships.json'), ev = readJson('web', 'data', 'events.json');
  const D = L.build(entries, news, rel);

  // Stable keys: a readable slug of the short name, made unique with the legacy number only when two collide.
  const keyOfId = {}, used = new Set();
  D.E.forEach((x) => {
    const lead = x.st && !new RegExp('^' + x.st + '\\b').test(x.short) ? x.st + ' ' : '';
    let k = slug(lead + x.short) || 'entry';
    if (!/^[a-z0-9]/.test(k)) k = 'e-' + k;
    if (used.has(k)) k = `${k}-${x.id}`;
    used.add(k); keyOfId[x.id] = k;
  });

  const eventsOf = {};
  ev.events.forEach((e) => { (eventsOf[e.id] = eventsOf[e.id] || []).push(e); });

  // Identifiers proposed by grabber/map-ids.mjs and confirmed by a person (config/identifiers.json). Missing file = none yet.
  const idFile = path.join(root, 'pipeline', 'config', 'identifiers.json');
  const idMap = fs.existsSync(idFile) ? JSON.parse(fs.readFileSync(idFile, 'utf8')).congress_gov || {} : {};
  const out = D.E.map((x) => {
    const raw = x.raw, U = x.U;
    const checked = U ? THROUGH : VERIFIED;
    const srcLinks = x.srcLinks.map((l) => ({ label: l.t, url: l.u, kind: PRIMARY.test(l.u) ? 'primary' : 'secondary' }));
    const more = x.moreLinks.map((l) => ({ t: l.t, u: l.u }));
    const events = (eventsOf[x.id] || []).slice().sort((a, b) => a.date.localeCompare(b.date)).map((e) => ({
      date: e.date, precision: e.precision, type: e.type, text: L.clean(e.clause).slice(0, 200) || e.match,
      clause: e.clause, inferred_year: !!e.inferredYear, scheduled: e.date > THROUGH
    }));
    const o = {
      id: x.id, key: keyOfId[x.id], section: x.section, type: x.type, level: x.level,
      jurisdiction: raw.jurisdiction ? raw.jurisdiction : null, state: x.st || null, status: x.status,
      title: x.title, short_name: x.short, sponsor_text: x.sponsor, mechanism: x.mech,
      thresholds: x.thresholds || null, penalties: x.penalties || null,
      status_text: L.clean(raw.status_and_dates) || null, signed_text: x.signed || null, effective_text: x.effective || null,
      events, sources: srcLinks, source_label: x.source || undefined,
      confidence: { level: x.conf || null, basis: x.conf ? BASIS[x.conf] : 'not_rated', ...(x.confNote && x.confNote !== x.conf ? { note: x.confNote } : {}) },
      tags: { updated_after_verification: !!U, ...(x.R ? { found_via: 'dedicated_search' } : x.NCSL ? { found_via: 'ncsl' } : { found_via: 'author' }) },
      origin: 'authored', verification: { method: 'author', checked_at: checked + 'T00:00:00Z' },
      last_checked: checked, last_changed: checked,
      legacy: { permalink: x.link, section_name: raw.section_name }
    };
    const ids = idMap[keyOfId[x.id]];
    if (ids && ids.congress_gov && ids.congress_gov.length && ids.status !== 'rejected') o.identifiers = { session: '119th Congress', external: { congress_gov: ids.congress_gov } };
    if (more.length) o.more_links = more;
    if (!o.source_label) delete o.source_label;
    return o;
  });

  // Relationships: nodes carry the entry key; edges are untouched apart from the origin marker.
  const nodes = {};
  Object.keys(rel.short).forEach((k) => { const id = D.keyToId[k]; if (id) nodes[k] = { name: rel.short[k], column: rel.columnOf[k] != null ? rel.columnOf[k] : 0, kind: 'entry', entry_key: keyOfId[id] }; });
  Object.keys(rel.actors).forEach((k) => { nodes[k] = { name: rel.actors[k], column: 0, kind: 'actor' }; });
  const relationships = {
    types: rel.types, columns: rel.columns, nodes,
    edges: rel.edges.map((e) => ({ from: e.from, to: e.to, type: e.type, label: e.label, quote: e.quote, ...(e.dashed ? { dashed: true } : {}), src: e.src, col: e.col, origin: 'authored' }))
  };

  const newsV2 = {
    title: news.title, asof: news.asof, intro: news.intro, bottom: news.bottom, kinds: news.kinds,
    items: news.items.map((n) => ({
      date: n.date, kind: n.kind, title: n.title, body: n.body, links: n.links, ...(n.check ? { check: n.check } : {}),
      tracker: n.tracker && D.keyToId[n.tracker] ? keyOfId[D.keyToId[n.tracker]] : null,
      origin: 'authored', verification: { method: 'author', checked_at: n.date + 'T00:00:00Z' }
    }))
  };

  const v1text = convertContent(root, L, keyOfId);
  const site = {
    verified_as_of: VERIFIED, updates_through: THROUGH, week_from: WEEK_FROM,
    section_names: L.SEC,
    section_groups: L.GROUPS.map((g) => ({ key: g.k, name: g.l, sections: g.sections })),
    federal_groups: L.FED_GROUPS.map((g) => ({ section: g.k, name: g.l, note: g.sub })),
    replay_start: iso(new Date(Date.UTC(L.REPLAY_START.getFullYear(), L.REPLAY_START.getMonth(), L.REPLAY_START.getDate()))),
    replay_milestones: L.MILESTONES.map((m) => ({ date: iso(m.d), entry_key: keyOfId[m.id], caption: m.c })),
    // section K of tracker.md, read verbatim (all its rows), with v1's other reference text in content
    comparison_matrix: v1text.matrix
  };
  return { entries: out, relationships, news: newsV2, site, content: v1text.content };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = await convert();
  const outDir = path.join(root, 'pipeline', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  for (const [k, v] of Object.entries(r)) fs.writeFileSync(path.join(outDir, k + '.v2.json'), JSON.stringify(v, null, 1));
  console.log(`wrote ${Object.keys(r).length} files to pipeline/out: ${r.entries.length} entries, ${r.entries.reduce((n, e) => n + e.events.length, 0)} events, ${Object.keys(r.relationships.nodes).length} nodes, ${r.relationships.edges.length} edges, ${r.news.items.length} news items`);
}
