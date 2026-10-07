// Copies the pipeline's v2 files into web/data/v2/, where the UI reads them.
//   node pipeline/schema/legacy-to-v2.mjs     (or a pipeline run) writes pipeline/out/*.v2.json
//   node web/scripts/sync-v2.mjs               copies them here
// Stand-in until the publisher exists: the publisher will write the checked files to web/data/v2/ itself.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const from = path.join(root, 'pipeline', 'out'), to = path.join(root, 'web', 'data', 'v2');
const FILES = ['entries', 'relationships', 'news', 'site'];
const missing = FILES.filter((f) => !fs.existsSync(path.join(from, f + '.v2.json')));
if (missing.length) { console.error(`missing in pipeline/out: ${missing.map((f) => f + '.v2.json').join(', ')}. Run: node pipeline/schema/legacy-to-v2.mjs`); process.exit(1); }
fs.mkdirSync(to, { recursive: true });
FILES.forEach((f) => { JSON.parse(fs.readFileSync(path.join(from, f + '.v2.json'), 'utf8')); fs.copyFileSync(path.join(from, f + '.v2.json'), path.join(to, f + '.json')); });
console.log(`copied ${FILES.length} files to web/data/v2/`);
