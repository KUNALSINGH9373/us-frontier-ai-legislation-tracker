// Copies the pipeline's v2 files into web/data/v2/, where the UI reads them.
//   node pipeline/schema/legacy-to-v2.mjs     (or a pipeline run) writes pipeline/out/*.v2.json
//   node web/scripts/sync-v2.mjs               copies them here
// v1 is frozen (owner, 15 Oct 2026): the publisher (pipeline/publish/run.mjs) now writes web/data/v2/ itself. This copy
// would overwrite its changes with the v1 conversion, so it refuses once any entry is no longer "authored".
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const from = path.join(root, 'pipeline', 'out'), to = path.join(root, 'web', 'data', 'v2');
const FILES = ['entries', 'relationships', 'news', 'site', 'content'];
// v1 files offered for download on the Handbook and About pages
const DOWNLOADS = [['handbook.md', 'handbook.md'], ['docs/handbook.pdf', 'handbook.pdf'], ['tracker.md', 'tracker.md']];
const missing = FILES.filter((f) => !fs.existsSync(path.join(from, f + '.v2.json')));
if (missing.length) { console.error(`missing in pipeline/out: ${missing.map((f) => f + '.v2.json').join(', ')}. Run: node pipeline/schema/legacy-to-v2.mjs`); process.exit(1); }
const live = path.join(to, 'entries.json');
if (fs.existsSync(live) && !process.argv.includes('--force')) {
  const changed = JSON.parse(fs.readFileSync(live, 'utf8')).filter((e) => e.origin !== 'authored').map((e) => e.key);
  if (changed.length) { console.error(`refusing: ${changed.length} entries in web/data/v2 were updated by the pipeline (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', ...' : ''}); copying the v1 conversion would undo them. v1 is frozen.`); process.exit(1); }
}
fs.mkdirSync(to, { recursive: true });
FILES.forEach((f) => { JSON.parse(fs.readFileSync(path.join(from, f + '.v2.json'), 'utf8')); fs.copyFileSync(path.join(from, f + '.v2.json'), path.join(to, f + '.json')); });
const dl = path.join(root, 'web', 'downloads'); fs.mkdirSync(dl, { recursive: true });
DOWNLOADS.forEach(([src, name]) => fs.copyFileSync(path.join(root, src), path.join(dl, name)));
console.log(`copied ${FILES.length} files to web/data/v2/ and ${DOWNLOADS.length} downloads to web/downloads/`);
