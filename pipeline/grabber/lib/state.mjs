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
