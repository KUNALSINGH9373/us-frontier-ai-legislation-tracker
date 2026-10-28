// The code a gate measure depends on: its prompts and its checks. Every report carries checks_hash for its measure, and the gate
// (eval/gate.mjs) counts a report only while that hash matches the code as it is now: a changed prompt or check needs a new report.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const P = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Files per measure, relative to pipeline/. The reading fields measure the bill writer and reader; new entries add everything that decides
// whether a new entry is created; relationships and news their own steps. publish/guards.mjs holds every publish stop rule, so it is in all.
const READING = ['agents/prompts.mjs', 'agents/generator.mjs', 'agents/validator.mjs', 'agents/checks.mjs', 'agents/rules.mjs', 'agents/source-text.mjs', 'agents/sections.mjs', 'agents/derive.mjs', 'agents/assemble.mjs', 'agents/process-item.mjs', 'eval/run.mjs'];
export const MEASURE_FILES = {
  fields: READING,
  new_entries: [...READING, 'agents/dedupe.mjs', 'agents/record-kind.mjs', 'agents/duties.mjs', 'agents/duties-prompt.mjs', 'duties/check.mjs', 'publish/tier-b.mjs', 'publish/guards.mjs', 'grabber/sources/legiscan.mjs', 'eval/tierb-set.mjs'],
  relationships: ['links/propose.mjs', 'links/rules.mjs', 'links/apply.mjs', 'links/prompts.mjs', 'links/run.mjs', 'links/backtest.mjs', 'publish/guards.mjs', 'eval/links-measure.mjs'],
  news: ['news/prompts.mjs', 'news/write.mjs', 'news/leads.mjs', 'news/feeds.mjs', 'news/run.mjs', 'publish/guards.mjs', 'eval/news-set.mjs']
};

// sha256 over the files' paths and contents (line endings normalised, so a checkout on Windows hashes like one on Linux).
export function checksHash(measure, root = P) {
  const files = MEASURE_FILES[measure];
  if (!files) throw new Error(`no such gate measure: ${measure}`);
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort()) {
    const p = path.join(root, f);
    h.update(f + '\n');
    h.update(fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : '(missing)');
    h.update('\n\0');
  }
  return h.digest('hex');
}
export const currentHashes = (root = P) => Object.fromEntries(Object.keys(MEASURE_FILES).map((m) => [m, checksHash(m, root)]));
