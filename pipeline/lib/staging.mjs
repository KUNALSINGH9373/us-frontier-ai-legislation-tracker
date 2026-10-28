// The staging copy an update run writes to, and the one promotion at its end. Every step of update.mjs (publish, court dockets,
// self-correction, links, news, status.json, the tracked-bill lists and the run-to-run state) writes only here; the real files
// change once, after every step and every final check passed. Any failure before that leaves every real file as it was.
// Plain code, no AI.
import fs from 'fs';
import path from 'path';

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
const jsonIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

// dir: the staging folder (made fresh). dataDir: web/data/v2. idsFiles: { name: real path } (the tracked-bill lists).
// stateDir + stateFiles: the run-to-run state promoted with the data (grabber/lib/state.mjs PROMOTED_STATE).
// dataFiles: the only site data files (names without .json) a run may promote; any other file a step drops into staging is never promoted.
// Returns where each step writes, and `pairs`: every staged file with the real files it is promoted to and their bytes at run start.
export function createStaging({ dir, dataDir, docsDir = null, idsFiles = {}, stateDir, stateFiles = [], dataFiles = null }) {
  fs.rmSync(dir, { recursive: true, force: true });
  cleanTmp([dataDir, docsDir, stateDir, ...Object.values(idsFiles).map((f) => path.dirname(f))]);
  const v2 = path.join(dir, 'v2'), config = path.join(dir, 'config'), state = path.join(dir, 'state');
  for (const d of [v2, config, state]) fs.mkdirSync(d, { recursive: true });
  const pairs = [], start = new Map();
  const pair = (staged, reals) => { pairs.push({ staged, reals }); reals.forEach((r) => start.set(r, read(r))); };
  for (const f of jsonIn(dataDir)) { fs.copyFileSync(path.join(dataDir, f), path.join(v2, f)); }
  const ids = {};
  for (const [name, real] of Object.entries(idsFiles)) { ids[name] = path.join(config, path.basename(real)); if (fs.existsSync(real)) fs.copyFileSync(real, ids[name]); pair(ids[name], [real]); }
  for (const f of stateFiles) { const real = path.join(stateDir, f); if (fs.existsSync(real)) fs.copyFileSync(real, path.join(state, f)); pair(path.join(state, f), [real]); }
  // data files: the ones there now, and any a step adds (listed again at promotion)
  const dataPairs = () => jsonIn(v2).filter((f) => !dataFiles || dataFiles.includes(f.replace(/\.json$/, ''))).map((f) => ({ staged: path.join(v2, f), reals: [path.join(dataDir, f), ...(docsDir ? [path.join(docsDir, f)] : [])] }));
  dataPairs().forEach((p) => p.reals.forEach((r) => start.set(r, read(r))));
  for (const f of jsonIn(docsDir)) start.set(path.join(docsDir, f), read(path.join(docsDir, f)));
  return { dir, v2, ids, stateDir: state, stateFile: (f) => path.join(state, f), pairs: () => [...dataPairs(), ...pairs], start };
}

// A crash mid-write can leave <name>.json.tmp next to a real file; such leftovers are removed before a run starts (files only).
function cleanTmp(dirs) {
  for (const d of dirs) if (d && fs.existsSync(d)) for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (f.endsWith('.json.tmp') && fs.statSync(p).isFile()) fs.rmSync(p, { force: true });
  }
}

// Puts every written file back as it was before a promotion (its recorded bytes, or removed when it did not exist).
export function rollback(writes) {
  for (const w of writes) { if (w.was) fs.writeFileSync(w.to, w.was); else fs.rmSync(w.to, { force: true }); }
}

// The writes a promotion would make: each real file whose bytes differ from its staged copy (a staged file that does not exist is
// not promoted). A real file changed by someone else since the run started stops the promotion.
export function plan(staging) {
  const writes = [], problems = [];
  for (const p of staging.pairs()) {
    const bytes = read(p.staged);
    if (bytes == null) continue;
    for (const r of p.reals) {
      const now = read(r), was = staging.start.has(r) ? staging.start.get(r) : null;
      if (!(now == null && was == null) && !(now && was && now.equals(was))) problems.push(`${r} changed while the run was going`);
      if (!now || !now.equals(bytes)) writes.push({ to: r, bytes, was: now });
    }
  }
  return { writes, problems };
}

// Writes every file to <name>.tmp, reads each back, then renames them all. Any failure removes the temp files and puts back the files
// already renamed, so the real files are either all promoted or all as they were. io: the fs functions (tests replace one to fail).
export function promote(writes, io = fs) {
  const tmps = [], done = [];
  try {
    for (const w of writes) {
      io.mkdirSync(path.dirname(w.to), { recursive: true });
      const t = w.to + '.tmp';
      io.writeFileSync(t, w.bytes); tmps.push(t);
      if (!io.readFileSync(t).equals(w.bytes)) throw new Error(`${t}: the bytes read back differ from the bytes written`);
    }
    for (const w of writes) { io.renameSync(w.to + '.tmp', w.to); done.push(w); tmps.splice(tmps.indexOf(w.to + '.tmp'), 1); }
    for (const w of writes) if (!fs.readFileSync(w.to).equals(w.bytes)) throw new Error(`${w.to}: the promoted file differs from the staged one`);
  } catch (e) {
    for (const t of tmps) fs.rmSync(t, { force: true });
    rollback(done);
    throw new Error(`promotion failed, every file put back as it was: ${e.message}`);
  }
  return writes.map((w) => w.to);
}
