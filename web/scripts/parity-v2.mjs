// Checks that the UI builds the same model from the v2 files as it does from the v1 files.
//   node web/scripts/parity-v2.mjs [v2 folder]      (default: web/data/v2)
// Every field of every entry, the timeline events, news, links, milestones, the comparison matrix and the headline
// counts are compared. Differences are printed; the exit code is 1 if any are found.
// v1 is frozen (15 Oct 2026). Entries the pipeline has updated (origin "mixed" / "automated") differ from v1 on purpose,
// so they, their events, the pipeline's own news items, and the counts and dates that move with them are left out.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const v2dir = path.resolve(process.argv[2] || path.join(web, 'data', 'v2'));
const read = (...p) => JSON.parse(fs.readFileSync(path.join(...p), 'utf8'));
const lib = pathToFileURL(path.join(web, 'tracker-lib.js')).href;
// two separate module instances, so the v2 build's site values cannot leak into the v1 build
const A = await import(lib + '?v1'), B = await import(lib + '?v2');

const D1 = A.build(read(web, 'data', 'entries.json'), read(web, 'data', 'news.json'), read(web, 'data', 'relationships.json'));
D1.tev = read(web, 'data', 'events.json').events.map((x) => ({ ...x, d: new Date(x.date + 'T12:00:00') }));
const D2 = B.buildV2(read(v2dir, 'entries.json'), read(v2dir, 'news.json'), read(v2dir, 'relationships.json'), read(v2dir, 'site.json'));

const problems = [];
const v2entries = read(v2dir, 'entries.json'), v2news = read(v2dir, 'news.json').items;
// Entries added after v1 froze (written in a Claude session, verification.method "session") have no v1 row either.
const changed = new Set(v2entries.filter((e) => e.origin !== 'authored' || (e.verification && e.verification.method === 'session')).map((e) => e.id));
const autoNews = new Set(v2news.filter((n) => n.origin !== 'authored' || (n.verification && n.verification.method === 'session')).map((n) => n.date + '|' + n.title));
const authored = (e) => !changed.has(e.id);
const norm = (v) => String(JSON.stringify(v, (k, x) => (x instanceof Date ? x.toISOString() : x)));
const same = (what, a, b) => { if (norm(a) !== norm(b)) problems.push(`${what}\n    v1: ${norm(a).slice(0, 300)}\n    v2: ${norm(b).slice(0, 300)}`); };

// Both sides leave out the entries v2 marks as changed: an updated entry still exists in v1, an added one does not.
same('entry count', D1.E.filter(authored).length, D2.E.filter(authored).length);
if (changed.size) console.log(`${changed.size} entries updated by the pipeline or added after v1 are not compared with v1: ${v2entries.filter((e) => changed.has(e.id)).map((e) => e.key).join(', ')}`);
const SKIP = new Set(['raw', 'v2key', 'origin', 'lastChecked', 'v2events']);
D1.E.filter(authored).forEach((a) => {
  const b = D2.byId[a.id]; if (!b) { problems.push(`entry ${a.id} missing in v2`); return; }
  Object.keys(a).forEach((f) => { if (SKIP.has(f)) return; const fix = (v) => (f === 'years' ? v.filter((y) => y !== '*') : v); same(`entry ${a.id} (${a.short}) .${f}`, fix(a[f]), fix(b[f])); }); // v1 writes "*" for "no year"
});
same('timeline events (from status lines)', D1.events.filter(authored).map((e) => [e.id, e.d, e.t]), D2.events.filter(authored).map((e) => [e.id, e.d, e.t]));
const tevKey = (e) => [e.id, e.date, e.precision, e.inferredYear, e.type, e.clause];
same('timeline lane events', D1.tev.filter(authored).map(tevKey).sort(), D2.tev.filter(authored).map(tevKey).sort());
const newsRow = (n) => [n.date, n.kind, n.title, n.entryId, n.tracker];
same('news', D1.N.map(newsRow), D2.N.filter((n) => !autoNews.has(n.date + '|' + n.title)).map(newsRow));
// Links and map nodes for entries added after v1 have no v1 counterpart, nor do links the pipeline added (origin "automated").
const oldEdge = (e) => e.origin !== 'automated' && !changed.has(e.fromId) && !changed.has(e.toId);
same('links', D1.edges.filter(oldEdge).map((e) => [e.from, e.to, e.type, e.fromId, e.toId, !!e.dashed]), D2.edges.filter(oldEdge).map((e) => [e.from, e.to, e.type, e.fromId, e.toId, !!e.dashed]));
const unchangedIds = (m) => Object.fromEntries(Object.entries(m).filter(([, id]) => !changed.has(id)));
same('link node → entry', unchangedIds(D1.keyToId), unchangedIds(D2.keyToId));
same('actors', D1.rel.actors, D2.rel.actors);
// v1 also lists names for link keys that have no node in v2 (they were never drawn); compare only the ones in use
const used = new Set(D1.edges.flatMap((e) => [e.from, e.to]));
same('link names in use', Object.fromEntries(Object.entries(D1.rel.short).filter(([k]) => used.has(k))), Object.fromEntries(Object.entries(D2.rel.short).filter(([k]) => used.has(k))));
if (!changed.size) same('pulse (states with news this week)', D1.pulse, D2.pulse);
same('replay milestones', A.MILESTONES, B.MILESTONES);
same('comparison matrix ids', A.K_IDS, B.K_IDS);
// The matrix is checked against its v1 source, tracker.md section K, read here independently of the converter
// (the old hand-copied rows in tracker-lib.js were reworded and had 11 of the 16 rows).
{
  const md = fs.readFileSync(path.join(web, '..', 'tracker.md'), 'utf8'), k = md.slice(md.indexOf('\n## K.'), md.indexOf('\n### K.2'));
  const txt = (c) => c.replace(/\\(.)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\s+/g, ' ').trim();
  const rows = k.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-/.test(l)).slice(1).map((l) => l.trim().slice(1, -1).split(/(?<!\\)\|/).map(txt));
  const want = rows.map((r) => [r[0], /full spread/i.test(r[0]) ? {} : Object.fromEntries(B.K_IDS.map((id, i) => [id, r[i + 1]])), /full spread/i.test(r[0]) ? r.slice(1).filter((v) => v && v !== '—').join(' · ') : null]);
  same('comparison matrix rows (v2 vs tracker.md section K)', want, B.K_ROWS);
}
same('section names', A.SEC, B.SEC);
same('section groups', A.GROUPS, B.GROUPS);
same('federal groups', A.FED_GROUPS, B.FED_GROUPS);
same('replay start', A.REPLAY_START, B.REPLAY_START);
if (!changed.size) same('dates', [A.ASOF, A.VERIFIED, A.WEEK_FROM], [B.ASOF, B.VERIFIED, B.WEEK_FROM]);
// The page shows: enacted, federal bills, pending, stalled-or-failed, auditor measures, executive actions, lawsuits.
// (v1's typed 6 stalled / 5 failed split disagrees with its own statuses, but the page only shows the 11 total.)
const shown = (h, sf) => ({ enacted: h.enacted, fed: h.fed, pending: h.pending, stalledOrFailed: sf, ivo: h.ivo, exec: h.exec, lit: h.lit, total: h.total });
if (!changed.size) same('headline counts the page shows (typed in v1, computed in v2)', shown(A.HC, A.HC.stalled + A.HC.failed), shown(B.HC, B.HC.stalledOrFailed));

if (problems.length) { console.log(`${problems.length} difference(s):\n- ` + problems.join('\n- ')); process.exit(1); }
console.log(`v1 and v2 build the same model: ${D2.E.length} entries, ${D2.events.length} timeline steps, ${D2.tev.length} lane events, ${D2.N.length} news items, ${D2.edges.length} links.`);
