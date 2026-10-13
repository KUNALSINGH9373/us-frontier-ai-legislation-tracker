// Reads and writes pipeline/data/state.json, the Grabber's memory of the last successful run.
// Validated against the schema on every read and write, and written atomically so a crash cannot leave a half file.
import fs from 'fs';
import path from 'path';
import { makeValidator } from '../../schema/validate.mjs';

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
