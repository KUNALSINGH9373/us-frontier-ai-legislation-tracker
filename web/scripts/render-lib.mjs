// Shared by the content checks: serves web/ on a free port and renders a route in headless Chrome or Edge.
import fs from 'fs';
import path from 'path';
import http from 'http';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

export const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

const CHROMES = [arg('--chrome'), process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.css': 'text/css', '.pdf': 'application/pdf', '.md': 'text/markdown' };

export async function startServer() {
  const chrome = CHROMES.find((c) => fs.existsSync(c));
  if (!chrome) { console.error('No Chrome found. Pass --chrome <path>.'); process.exit(2); }
  const server = http.createServer((req, res) => {
    const f = path.join(web, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(web) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/Tracker.dc.html`;
  // the rendered DOM of one route (after the app has loaded and drawn)
  const dump = (route) => new Promise((resolve) => execFile(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=8000', '--window-size=1280,2000', '--dump-dom', base + route], { maxBuffer: 64 << 20, timeout: 60000 }, (err, out) => resolve(err ? '' : out)));
  return { dump, close: () => server.close() };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// visible text of <main>
export const textOf = (html) => (html.match(/<main[\s\S]*<\/main>/) || [''])[0].replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
// compare without whitespace, markdown (escapes, emphasis, link targets), review markers, class tags or quote styles
export const squash = (s) => s.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1').replace(/\\(.)/g, '$1').replace(/⟨[^⟩]*⟩/g, '').replace(/\[[A-Z][A-Z—\- ]*\]/g, '').replace(/[*↗]/g, '').replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'").replace(/\s+/g, '').toLowerCase();
