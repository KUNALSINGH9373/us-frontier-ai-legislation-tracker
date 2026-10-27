// Fills in what code knows so the drafter only writes what needs reading.
//   node duties/stamp.mjs <key> [key ...]
// Sets draft.source_url and draft.basis (hash of the stored text) from eval/sources.json, and gives every answer
// except not_in_bill that source_url. Run it after writing a draft and before duties/check.mjs.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DRAFTS, loadText } from './check.mjs';
import { sha } from '../grabber/lib/run-common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'eval', 'sources.json'), 'utf8')).items;

export function stamp(key) {
  const f = path.join(DRAFTS, key + '.json'), m = manifest[key];
  if (!m || !m.url) throw new Error(`no official URL recorded for ${key} in eval/sources.json`);
  const draft = JSON.parse(fs.readFileSync(f, 'utf8')), text = loadText(key);
  draft.key = key;
  draft.source_url = m.url;
  draft.basis = { source_url: m.url, sha256: sha(text), chars: text.length };
  for (const d of Object.values(draft.duties || {})) if (d.value !== 'not_in_bill') d.source_url = m.url;
  fs.writeFileSync(f, JSON.stringify(draft, null, 1) + '\n');
  return draft;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  for (const k of process.argv.slice(2)) { stamp(k); console.log('stamped', k); }
}
