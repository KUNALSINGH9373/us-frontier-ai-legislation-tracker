// Loaded before every test suite (package.json "test": node --import ./lib/test-cleanup.mjs ...). Every temporary folder a test makes
// with fs.mkdtempSync under the system temp folder is removed when the suite exits, so test runs never pile up in %TEMP% (they did:
// about 1,800 folders, 7.9 GB, on 28 Oct 2026). Folders made anywhere else are never touched.
import fs from 'fs';
import os from 'os';
import path from 'path';

const made = new Set();
const base = path.resolve(os.tmpdir());
const original = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, options) {
  const dir = original.call(fs, prefix, options);
  if (path.resolve(dir).startsWith(base + path.sep)) made.add(dir);
  return dir;
};
process.on('exit', () => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort: never fail a suite over cleanup */ } }
});
