// Renders every bill page in headless Chrome and checks that every clause of every v1 table cell appears on it.
// Confidence and Source cells are skipped: the page shows them in their own blocks (as levels and as links).
//   node web/scripts/check-bill-text.mjs [--chrome <path>] [--only 4,18,61]
// Starts its own static server on a free port; needs Chrome or Edge installed. Exit code 1 if anything is missing.
import fs from 'fs';
import path from 'path';
import http from 'http';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const CHROMES = [arg('--chrome'), process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const chrome = CHROMES.find((c) => fs.existsSync(c));
if (!chrome) { console.error('No Chrome found. Pass --chrome <path>.'); process.exit(2); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.css': 'text/css', '.pdf': 'application/pdf', '.md': 'text/markdown' };
const server = http.createServer((req, res) => {
  const f = path.join(web, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(web) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/Tracker.dc.html`;

const dump = (url) => new Promise((resolve) => execFile(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=8000', '--window-size=1280,2000', '--dump-dom', url], { maxBuffer: 64 << 20, timeout: 60000 }, (err, out) => resolve(err ? '' : out)));
const SN = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const textOf = (html) => (html.match(/<main[\s\S]*<\/main>/) || [''])[0].replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
// compare without whitespace, markdown escapes, review markers, class tags or quote styles
const squash = (s) => s.replace(/\\(.)/g, '$1').replace(/⟨[^⟩]*⟩/g, '').replace(/\[[A-Z][A-Z—\- ]*\]/g, '').replace(/\*/g, '').replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'").replace(/\s+/g, '').toLowerCase();
const SKIP = /^(Confidence|Source)$/;
const clauses = (t) => t.replace(/\\(.)/g, '$1').split(/;\s+|\.\s+(?=[A-Z(])|\s+\|\s+/).map((c) => c.replace(/^[\s.;,]+|[\s.;,]+$/g, '')).filter((c) => squash(c).length > 2);

const v1 = JSON.parse(fs.readFileSync(path.join(web, 'data', 'entries.json'), 'utf8'));
const only = (arg('--only') || '').split(',').filter(Boolean).map(Number);
const todo = only.length ? v1.filter((x) => only.includes(x.id)) : v1;
const missing = []; let checked = 0, pages = 0;
const queue = [...todo];
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let x; (x = queue.shift());) {
    const page = squash(textOf(await dump(`${base}#/bill/${x.id}`)));
    if (!page.includes(squash(x.title.replace(/⟨[^⟩]*⟩/g, '').split(' — ')[0]))) { missing.push(`#${x.id}: page did not render`); continue; }
    pages++;
    x.cells.forEach((c) => {
      if (SKIP.test(c.h)) return;
      const t = c.h === 'State' && SN[c.t.trim()] ? SN[c.t.trim()] : c.t;
      clauses(t).forEach((cl) => { checked++; if (!page.includes(squash(cl))) missing.push(`#${x.id} [${c.h}] ${cl}`); });
    });
  }
}));
server.close();
if (missing.length) { console.log(`${missing.length} clause(s) missing on ${pages} rendered pages (${checked} checked):\n- ` + missing.join('\n- ')); process.exit(1); }
console.log(`All ${checked} clauses of ${todo.length} entries' v1 cells appear on their bill pages (${pages} pages rendered).`);
