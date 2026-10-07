// Validates tracker data against the schemas.
//   node schema/validate.mjs <schema> <file.json>
//   schema: entry | news | relationships | site | state | changeset | draft | verdict | held | runlog
// For "entry" the file may hold one entry or an array of entries.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'));

export function makeValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
  addFormats(ajv);
  const files = ['common', 'entry', 'news', 'relationships', 'site', 'pipeline'];
  files.forEach((f) => ajv.addSchema(read(f + '.schema.json')));
  const P = 'https://tracker.local/schema/pipeline.schema.json#/$defs/';
  const ids = {
    entry: 'https://tracker.local/schema/entry.schema.json',
    news: 'https://tracker.local/schema/news.schema.json',
    relationships: 'https://tracker.local/schema/relationships.schema.json',
    site: 'https://tracker.local/schema/site.schema.json',
    state: P + 'state', changeset: P + 'changeset', draft: P + 'draft', verdict: P + 'verdict', held: P + 'held', runlog: P + 'runlog', diff: P + 'diff', patch: P + 'patch'
  };
  const fns = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, ajv.getSchema(id)]));
  return {
    // Returns [] when valid, otherwise readable problems.
    check(name, data) {
      const fn = fns[name];
      if (!fn) throw new Error('unknown schema: ' + name);
      if (fn(data)) return [];
      return fn.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params && e.params.allowedValues ? ' [' + e.params.allowedValues.join(', ') + ']' : ''}`);
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [name, file] = process.argv.slice(2);
  if (!name || !file) { console.error('usage: node schema/validate.mjs <schema> <file.json>'); process.exit(2); }
  const v = makeValidator();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = name === 'entry' && Array.isArray(data) ? data : [data];
  let bad = 0;
  list.forEach((d, i) => {
    const errs = v.check(name, d);
    if (errs.length) { bad++; console.log(`#${i}${d && d.id ? ' (id ' + d.id + ')' : ''}:\n  ` + errs.join('\n  ')); }
  });
  console.log(bad ? `${bad} of ${list.length} FAILED` : `${list.length} OK`);
  process.exit(bad ? 1 : 0);
}
