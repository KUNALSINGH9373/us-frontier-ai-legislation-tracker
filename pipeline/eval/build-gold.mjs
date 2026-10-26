// Freezes the gold answers: the author's own fields for every entry that has an official text in eval/sources.json.
//   node eval/build-gold.mjs
// Run once; the gold set must not move when the live data changes. Tier A never edits these fields, so rebuilding
// from today's data gives the same answers, but a frozen file makes that a fact rather than a promise.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const entries = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'web', 'data', 'v2', 'entries.json'), 'utf8'));
const sources = JSON.parse(fs.readFileSync(path.join(here, 'sources.json'), 'utf8')).items;
const items = entries.filter((e) => e.origin === 'authored' && sources[e.key] && sources[e.key].sha256).map((e) => ({
  key: e.key, title: e.title, section: e.section, level: e.level, in_scope: e.section !== 'J',
  mechanism: e.mechanism || null, thresholds: e.thresholds || null, penalties: e.penalties || null
}));
fs.writeFileSync(path.join(here, 'gold.json'), JSON.stringify({ _note: 'Frozen 16 Oct 2026 from the hand-checked v1 entries (verified Oct 15). in_scope: section J entries are out, all others in.', items }, null, 1) + '\n');
console.log(`${items.length} gold items (${items.filter((i) => !i.in_scope).length} out of scope)`);
