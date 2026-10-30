// Fails when a file the site serves from docs/ differs from its source in web/ (the scripts at the top of web/, and
// Tracker.dc.html as docs/index.html). docs/ is assembled by publish-site.mjs; an edit to web/ that was never
// published, or a hand edit to docs/, shows up here.
//   node web/scripts/check-docs-sync.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const web = path.join(root, 'web'), docs = path.join(root, 'docs');
const SITE_SCRIPTS = fs.readdirSync(web).filter((f) => f.endsWith('.js'));
const pairs = [...SITE_SCRIPTS.map((f) => [f, f]), ['Tracker.dc.html', 'index.html']];
const norm = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') : null); // line endings are git's business
const bad = pairs.filter(([a, b]) => norm(path.join(web, a)) !== norm(path.join(docs, b))).map(([a, b]) => `web/${a} -> docs/${b}`);
if (bad.length) { console.error('docs/ is out of date with web/ (run node web/scripts/publish-site.mjs):\n  ' + bad.join('\n  ')); process.exit(1); }
console.log(`docs/ matches web/: ${pairs.length} files`);
