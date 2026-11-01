// The site check an update run passes before anything is promoted: the staged data must build, and everything the run did not change
// must build exactly as it did from the data at the start of the run.
//   node web/scripts/site-check.mjs <before folder> <after folder> [entry keys the run changed, comma-separated | auto]
// The baseline is the live data the run started from, never a frozen copy: an edit made outside the pipeline (a manual update) is part of
// that baseline, so it can never fail a later run. What it catches is a run reaching past what it says it changed: an entry it did not
// claim that now reads differently, or an untouched entry's timeline steps, lane events, news items or links that moved, went missing or
// lost their target.
// Both models are built with the after site.json, so a moved "as of" date (which regroups years and counts) is not a difference;
// site.json itself is checked by the schema. Each build gets its own module instance, so neither leaks site values into the other.
// (web/scripts/parity-v2.mjs, the v1 comparison from the v1-to-v2 move, is kept as a tool and gates nothing.)
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const lib = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tracker-lib.js')).href;
let instance = 0;
const SKIP = new Set(['raw', 'lastChecked', 'v2events']); // v2events: compared below as lane events
const norm = (v) => String(JSON.stringify(v, (k, x) => (x instanceof Date ? x.toISOString() : x)));
// Not changes: the run stamps last_checked on every entry it read, and when updates_through moves Tier A sets each event's scheduled
// flag again from it (publish/tier-a.mjs), so both sides are compared with the flag as the after updates_through gives it.
const strip = ({ last_checked, ...e }, ut) => ({ ...e, events: (e.events || []).map((v) => (v.scheduled !== undefined || v.date > ut ? { ...v, scheduled: v.date > ut } : v)) });

// before, after: { entries, news, relationships, site } as publish/run.mjs loadData returns them. changed: entry keys the run changed
// or added. linksChanged: the link network was edited on purpose (a manual change), so old links may change or go; none may lose an
// end. Returns { problems: [text], built } (problems name the entry key first, so a caller can tell which entries they are about).
export async function siteCheck({ before, after, changed = [], linksChanged = false }) {
  const problems = [], claimed = new Set(changed);
  let D1, D2;
  try { D2 = (await import(lib + '?after' + ++instance)).buildV2(after.entries, after.news, after.relationships, after.site); }
  catch (e) { return { problems: [`the staged data does not build: ${e.message}`], built: null }; }
  try { D1 = (await import(lib + '?before' + ++instance)).buildV2(before.entries, before.news, before.relationships, after.site); }
  catch (e) { return { problems: [`the data at run start does not build with the staged site.json: ${e.message}`], built: null }; }

  const was = new Map(before.entries.map((e) => [e.key, e])), ut = after.site.updates_through;
  const keys = new Set(), ids = new Set();
  after.entries.forEach((e) => {
    if (keys.has(e.key)) problems.push(`${e.key}: two entries have this key`);
    if (ids.has(e.id)) problems.push(`${e.key}: id ${e.id} is used twice`);
    keys.add(e.key); ids.add(e.id);
    if (claimed.has(e.key)) return;
    if (!was.has(e.key)) problems.push(`${e.key}: added, but the run did not say it added it`);
    else if (norm(strip(was.get(e.key), ut)) !== norm(strip(e, ut))) problems.push(`${e.key}: changed, but the run did not say it changed it`);
  });
  before.entries.filter((e) => !keys.has(e.key) && !claimed.has(e.key)).forEach((e) => problems.push(`${e.key}: missing from the staged data`));

  // every untouched entry builds the same model, field by field
  const untouched = (id) => { const e = D2.byId[id] || D1.byId[id]; return !!e && !claimed.has(e.v2key); };
  D1.E.filter((a) => untouched(a.id)).forEach((a) => {
    const b = D2.byId[a.id]; if (!b) return; // reported above
    Object.keys(a).forEach((f) => { if (!SKIP.has(f) && norm(a[f]) !== norm(b[f])) problems.push(`${a.v2key}: .${f} builds differently\n    before: ${norm(a[f]).slice(0, 300)}\n    after:  ${norm(b[f]).slice(0, 300)}`); });
  });
  const per = (list, row) => { const m = new Map(); list.filter((x) => untouched(x.id)).forEach((x) => { const k = D2.byId[x.id] ? D2.byId[x.id].v2key : D1.byId[x.id].v2key; (m.get(k) || m.set(k, []).get(k)).push(norm(row(x))); }); m.forEach((v) => v.sort()); return m; };
  const same = (what, m1, m2) => new Set([...m1.keys(), ...m2.keys()]).forEach((k) => { if (norm(m1.get(k) || []) !== norm(m2.get(k) || [])) problems.push(`${k}: ${what} differ\n    before: ${norm(m1.get(k) || []).slice(0, 300)}\n    after:  ${norm(m2.get(k) || []).slice(0, 300)}`); });
  same('timeline steps', per(D1.events, (e) => [e.d, e.t]), per(D2.events, (e) => [e.d, e.t]));
  same('lane events', per(D1.tev, (e) => [e.date, e.precision, e.inferredYear, e.type, e.clause]), per(D2.tev, (e) => [e.date, e.precision, e.inferredYear, e.type, e.clause]));

  // news: an item about an untouched entry (or about none) that was shown is still shown, the same; a new item points at a real entry
  const newsRow = (n) => norm([n.date, n.kind, n.title, n.entryId, n.tracker]);
  const shown = new Set(D2.N.map(newsRow));
  D1.N.filter((n) => !n.entryId || untouched(n.entryId)).filter((n) => !shown.has(newsRow(n))).forEach((n) => problems.push(`${n.entryId ? D1.byId[n.entryId].v2key : 'news'}: news item no longer shown as before: ${n.date} ${n.title}`));
  const oldNews = new Set(D1.N.map(newsRow));
  D2.N.filter((n) => !oldNews.has(newsRow(n)) && n.tracker && !n.entryId).forEach((n) => problems.push(`news: new item ${n.date} "${n.title}" points at no entry`));

  // links: every link between untouched ends is still there, the same; no link (old or new) loses an end
  const nodes = after.relationships.nodes, ends = (e) => [e.fromId, e.toId].filter((x) => x != null);
  const edgeRow = (e) => norm([e.from, e.to, e.type, e.fromId, e.toId, !!e.dashed]);
  const edges2 = new Set(D2.edges.map(edgeRow));
  if (!linksChanged) D1.edges.filter((e) => ends(e).every(untouched)).filter((e) => !edges2.has(edgeRow(e))).forEach((e) => problems.push(`links: ${e.from} → ${e.to} (${e.type}) changed or missing`));
  const lostBefore = new Set(D1.edges.filter((e) => !nodes[e.from] || !nodes[e.to]).map(edgeRow));
  D2.edges.filter((e) => (!nodes[e.from] || !nodes[e.to]) && !lostBefore.has(edgeRow(e))).forEach((e) => problems.push(`links: ${e.from} → ${e.to} points at a node that does not exist`));
  Object.entries(D1.keyToId).filter(([, id]) => untouched(id)).forEach(([k, id]) => { if (D2.keyToId[k] !== id) problems.push(`links: node ${k} no longer leads to entry ${D1.byId[id].v2key}`); });

  return { problems, built: { entries: D2.E.length, steps: D2.events.length, lane: D2.tev.length, news: D2.N.length, links: D2.edges.length } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [b, a, list] = process.argv.slice(2);
  if (!b || !a) { console.error('usage: node web/scripts/site-check.mjs <before folder> <after folder> [changed keys, comma-separated]'); process.exit(2); }
  const load = (dir) => Object.fromEntries(['entries', 'news', 'relationships', 'site'].map((k) => [k, JSON.parse(fs.readFileSync(path.join(dir, k + '.json'), 'utf8'))]));
  // "auto" claims every entry whose record differs (a manual change, checked on a pull request): what is left is that the data builds
  // and that the changed entries did not move anything about the others
  const before = load(b), after = load(a), was = new Map(before.entries.map((e) => [e.key, norm(e)]));
  const changed = list === 'auto' ? after.entries.filter((e) => was.get(e.key) !== norm(e)).map((e) => e.key).concat(before.entries.filter((e) => !after.entries.some((x) => x.key === e.key)).map((e) => e.key)) : list ? list.split(',').filter(Boolean) : [];
  if (list === 'auto') console.log(`${changed.length} changed entr${changed.length === 1 ? 'y' : 'ies'}: ${changed.join(', ') || 'none'}`);
  const linksChanged = list === 'auto' && norm(before.relationships) !== norm(after.relationships);
  if (linksChanged) console.log('the link network changed: old links are not required to stay as they were');
  const { problems, built } = await siteCheck({ before, after, changed, linksChanged });
  if (problems.length) { console.log(`${problems.length} problem(s):\n- ` + problems.join('\n- ')); process.exit(1); }
  console.log(`site check passed: ${built.entries} entries, ${built.steps} timeline steps, ${built.lane} lane events, ${built.news} news items, ${built.links} links; everything the run did not change builds as before.`);
}
