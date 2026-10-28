// Where the pipeline keeps its memory between runs, and the Grabber's state.json (its memory of the last successful run).
// Run-to-run state lives in pipeline/state/ and is committed, so a scheduled run on a fresh machine carries on from the last one:
//   state.json (grabber cursors and hashes), legiscan-seen.json, legiscan-usage.json, news-seen.json, courts-state.json,
//   waiting-for-text.json, corrections.json (correct/run.mjs) and ledger/<YYYY-MM>.jsonl (the month's AI spend).
// What may be lost stays in pipeline/data/ (git-ignored): runs/, updates/, text-cache/, eval/, staging/, update.lock.
// state.json is validated against the schema on every read and write, and written atomically so a crash cannot leave a half file.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeValidator } from '../../schema/validate.mjs';

export const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_DIR = path.join(PIPELINE_DIR, 'state');
export const WORK_DIR = path.join(PIPELINE_DIR, 'data');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const LEGISCAN_SEEN_FILE = path.join(STATE_DIR, 'legiscan-seen.json');
// TRACKER_LEGISCAN_USAGE_FILE: tests point the counter at a temporary file, so the real monthly count is never touched.
export const LEGISCAN_USAGE_FILE = process.env.TRACKER_LEGISCAN_USAGE_FILE || path.join(STATE_DIR, 'legiscan-usage.json');
export const NEWS_SEEN_FILE = path.join(STATE_DIR, 'news-seen.json');
export const COURTS_STATE_FILE = path.join(STATE_DIR, 'courts-state.json');
export const WAITING_FILE = path.join(STATE_DIR, 'waiting-for-text.json');
export const CORRECTIONS_FILE = path.join(STATE_DIR, 'corrections.json');
export const LEDGER_DIR = path.join(STATE_DIR, 'ledger');
// The files a run moves forward only when the whole run succeeded (update.mjs stages them and promotes them with the data).
// The LegiScan usage counter and the AI ledger are not among them: they count what was really spent, so they are written at once.
export const PROMOTED_STATE = ['state.json', 'legiscan-seen.json', 'news-seen.json', 'courts-state.json', 'waiting-for-text.json', 'corrections.json'];

const validator = makeValidator();
export const emptyState = () => ({ version: 1, sources: {} });

export function readState(file) {
  if (!fs.existsSync(file)) return emptyState();
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errs = validator.check('state', s);
  if (errs.length) throw new Error(`state file is invalid: ${errs.join('; ')}`);
  return s;
}

export function writeState(file, state) {
  const errs = validator.check('state', state);
  if (errs.length) throw new Error(`refusing to write an invalid state: ${errs.join('; ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

// Makes the grabber fetch one item again on its next run. update.mjs calls it on the staged state for an item a stop rule held, so the
// item is retried from a fresh copy, never from one fetched days ago: the item's hash and its LegiScan screening record are dropped, and
// the Congress.gov or Federal Register cursor moves back to the item's own date (from its stored record), so the next listing brings it
// again. A new Congress bill whose record has no date goes back on the waiting-for-text list, which fetches it on the next run.
// raw: the stored record (text) the item was fetched as, or null. Returns what was changed ('hash', 'cursor', 'seen', 'waiting').
export function forgetItem(stateDir, { item_id, raw = null, change = null, title = null, today }) {
  const [source, ...rest] = String(item_id).split(':'), sid = rest.join(':'), done = [];
  let rec = null;
  try { rec = raw ? JSON.parse(raw) : null; } catch { rec = null; }
  const at = !rec ? null : source === 'congress_gov' ? (rec.list_item && rec.list_item.updateDate) || (rec.bill && rec.bill.updateDate) || null : source === 'federal_register' ? (rec.document && rec.document.publication_date) || null : null;
  const sf = path.join(stateDir, 'state.json'), st = readState(sf), block = st.sources[source];
  if (block) {
    if (block.hashes && Object.hasOwn(block.hashes, sid)) { delete block.hashes[sid]; done.push('hash'); }
    if (at && block.cursor && Date.parse(at) < Date.parse(block.cursor)) {
      block.cursor = source === 'federal_register' ? String(at).slice(0, 10) : new Date(Date.parse(at) - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      done.push('cursor');
    }
    if (done.length) writeState(sf, st);
  }
  const seenFile = path.join(stateDir, path.basename(LEGISCAN_SEEN_FILE));
  if (source === 'legiscan' && fs.existsSync(seenFile)) {
    const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    if (Object.hasOwn(seen, sid)) { delete seen[sid]; fs.writeFileSync(seenFile, JSON.stringify(seen, null, 1) + '\n'); done.push('seen'); }
  }
  if (source === 'congress_gov' && change === 'new' && !at) {
    const wf = path.join(stateDir, path.basename(WAITING_FILE)), w = fs.existsSync(wf) ? JSON.parse(fs.readFileSync(wf, 'utf8')) : { items: {} };
    w.items = w.items || {};
    if (!w.items[item_id]) { w.items[item_id] = { source_id: sid, title, since: today, last_checked: '', checks: 0 }; fs.writeFileSync(wf, JSON.stringify(w, null, 1) + '\n'); done.push('waiting'); }
  }
  return done;
}
