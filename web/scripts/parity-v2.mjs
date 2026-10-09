// Checks that the UI builds the same model from the v2 files as it does from the v1 files.
//   node web/scripts/parity-v2.mjs [v2 folder]      (default: web/data/v2)
// Every field of every entry, the timeline events, news, links, milestones, the comparison matrix and the headline
// counts are compared. Differences are printed; the exit code is 1 if any are found.
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
const norm = (v) => JSON.stringify(v, (k, x) => (x instanceof Date ? x.toISOString() : x));
const same = (what, a, b) => { if (norm(a) !== norm(b)) problems.push(`${what}\n    v1: ${norm(a).slice(0, 300)}\n    v2: ${norm(b).slice(0, 300)}`); };

same('entry count', D1.E.length, D2.E.length);
const SKIP = new Set(['raw', 'v2key', 'origin', 'lastChecked', 'v2events']);
D1.E.forEach((a) => {
  const b = D2.byId[a.id]; if (!b) { problems.push(`entry ${a.id} missing in v2`); return; }
  Object.keys(a).forEach((f) => { if (SKIP.has(f)) return; const fix = (v) => (f === 'years' ? v.filter((y) => y !== '*') : v); same(`entry ${a.id} (${a.short}) .${f}`, fix(a[f]), fix(b[f])); }); // v1 writes "*" for "no year"
});
same('timeline events (from status lines)', D1.events.map((e) => [e.id, e.d, e.t]), D2.events.map((e) => [e.id, e.d, e.t]));
const tevKey = (e) => [e.id, e.date, e.precision, e.inferredYear, e.type, e.clause];
same('timeline lane events', D1.tev.map(tevKey).sort(), D2.tev.map(tevKey).sort());
same('news', D1.N.map((n) => [n.i, n.date, n.kind, n.title, n.entryId, n.tracker]), D2.N.map((n) => [n.i, n.date, n.kind, n.title, n.entryId, n.tracker]));
same('links', D1.edges.map((e) => [e.from, e.to, e.type, e.fromId, e.toId, !!e.dashed]), D2.edges.map((e) => [e.from, e.to, e.type, e.fromId, e.toId, !!e.dashed]));
same('link node → entry', D1.keyToId, D2.keyToId);
same('actors', D1.rel.actors, D2.rel.actors);
// v1 also lists names for link keys that have no node in v2 (they were never drawn); compare only the ones in use
const used = new Set(D1.edges.flatMap((e) => [e.from, e.to]));
same('link names in use', Object.fromEntries(Object.entries(D1.rel.short).filter(([k]) => used.has(k))), Object.fromEntries(Object.entries(D2.rel.short).filter(([k]) => used.has(k))));
same('pulse (states with news this week)', D1.pulse, D2.pulse);
same('replay milestones', A.MILESTONES, B.MILESTONES);
same('comparison matrix ids', A.K_IDS, B.K_IDS);
same('comparison matrix rows', A.K_ROWS, B.K_ROWS);
same('section names', A.SEC, B.SEC);
same('section groups', A.GROUPS, B.GROUPS);
same('federal groups', A.FED_GROUPS, B.FED_GROUPS);
same('replay start', A.REPLAY_START, B.REPLAY_START);
same('dates', [A.ASOF, A.VERIFIED, A.WEEK_FROM], [B.ASOF, B.VERIFIED, B.WEEK_FROM]);
// The page shows: enacted, federal bills, pending, stalled-or-failed, auditor measures, executive actions, lawsuits.
// (v1's typed 6 stalled / 5 failed split disagrees with its own statuses, but the page only shows the 11 total.)
const shown = (h, sf) => ({ enacted: h.enacted, fed: h.fed, pending: h.pending, stalledOrFailed: sf, ivo: h.ivo, exec: h.exec, lit: h.lit, total: h.total });
same('headline counts the page shows (typed in v1, computed in v2)', shown(A.HC, A.HC.stalled + A.HC.failed), shown(B.HC, B.HC.stalledOrFailed));

if (problems.length) { console.log(`${problems.length} difference(s):\n- ` + problems.join('\n- ')); process.exit(1); }
console.log(`v1 and v2 build the same model: ${D2.E.length} entries, ${D2.events.length} timeline steps, ${D2.tev.length} lane events, ${D2.N.length} news items, ${D2.edges.length} links.`);
