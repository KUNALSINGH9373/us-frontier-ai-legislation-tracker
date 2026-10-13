// Loads secrets from a .env file into process.env, searching upward from a folder.
// Values are never printed or returned; only the file path and the variable NAMES are reported.
// Accepts "KEY=value" and "KEY = value", optional quotes, and # comments.
import fs from 'fs';
import path from 'path';

export function loadEnv(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    const file = path.join(dir, '.env');
    if (fs.existsSync(file)) {
      const names = [];
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m || line.trim().startsWith('#')) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v; // a real environment variable (e.g. a GitHub Secret) wins
        names.push(m[1]);
      }
      return { path: file, names };
    }
    const up = path.dirname(dir);
    if (up === dir) return { path: null, names: [] };
    dir = up;
  }
}
