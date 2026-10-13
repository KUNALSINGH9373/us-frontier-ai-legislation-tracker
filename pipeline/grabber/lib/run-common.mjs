// Pieces every Grabber shares: run ids, hashes, saving raw source text, and writing a validated change set.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { makeValidator } from '../../schema/validate.mjs';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const isoZ = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const makeRunId = (now) => 'run-' + now.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-') + '-' + sha(String(+now)).slice(0, 4);

// Saves the fetched source text so the Validator can later check quotes against exactly what we fetched.
export function saveRaw({ outDir, runId, source, name, text }) {
  const dir = path.join(outDir, runId, 'raw', source);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return { hash: sha(text), rel: path.relative(path.join(outDir, runId), file).split(path.sep).join('/') };
}

// Validates against the schema, then writes changeset.json into the run folder.
export function writeChangeset({ outDir, runId, items }) {
  const changeset = { run_id: runId, generated_at: isoZ(new Date()), items };
  const errs = makeValidator().check('changeset', changeset);
  if (errs.length) throw new Error('change set failed its own schema: ' + errs.join('; '));
  fs.mkdirSync(path.join(outDir, runId), { recursive: true });
  fs.writeFileSync(path.join(outDir, runId, 'changeset.json'), JSON.stringify(changeset, null, 1) + '\n');
  return changeset;
}
