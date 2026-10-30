// Assembles the public site in docs/ (what GitHub Pages serves from main):
//   docs/        the new UI (Tracker.dc.html as index.html, its scripts, fonts, logo, data/v2, downloads)
//   docs/v1/     the v1 site, rebuilt from tracker.md exactly as before
// v1's own files are not edited. The old root files (tracker-table.csv, tracker.md, handbook.pdf) stay at the root so
// existing links to them keep working. Safe to run again: it rebuilds v1 first, then lays the new UI on top.
//   node web/scripts/publish-site.mjs
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const docs = path.join(root, 'docs'), web = path.join(root, 'web'), v1 = path.join(docs, 'v1');
const cp = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };

// 1. Rebuild v1 (writes docs/index.html, tracker-table.csv, tracker.md, favicon.svg, .nojekyll)
execFileSync(process.execPath, ['build/build.mjs'], { cwd: root, stdio: 'inherit' });

// 2. Park the v1 site in docs/v1/
fs.rmSync(v1, { recursive: true, force: true });
['index.html', 'tracker-table.csv', 'tracker.md', 'favicon.svg', 'handbook.pdf'].forEach((f) => cp(path.join(docs, f), path.join(v1, f)));
fs.writeFileSync(path.join(v1, '.nojekyll'), '');

// 3. Lay the new UI on the root
cp(path.join(web, 'Tracker.dc.html'), path.join(docs, 'index.html'));
// every script at the top of web/ is a site library: copy them all, so a new one cannot be left behind
[...fs.readdirSync(web).filter((f) => f.endsWith('.js')), 'fonts', 'logo', 'downloads', path.join('data', 'v2')].forEach((f) => cp(path.join(web, f), path.join(docs, f)));
cp(path.join(web, 'logo', 'us-frontier-law-seal.svg'), path.join(docs, 'favicon.svg'));
fs.writeFileSync(path.join(docs, '.nojekyll'), '');

const must = ['index.html', 'CNAME', 'support.js', 'tracker-lib.js', 'viz-lib.js', 'data/v2/entries.json', 'v1/index.html', 'v1/handbook.pdf'];
const missing = must.filter((f) => !fs.existsSync(path.join(docs, f)));
if (missing.length) { console.error('missing from docs/: ' + missing.join(', ')); process.exit(1); }
// docs/ must now match web/ exactly (the same check runs on its own: node web/scripts/check-docs-sync.mjs)
execFileSync(process.execPath, [path.join(web, 'scripts', 'check-docs-sync.mjs')], { cwd: root, stdio: 'inherit' });
console.log('docs/ now serves the new UI at / and v1 at /v1/');
