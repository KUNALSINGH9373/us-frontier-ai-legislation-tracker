// The Tier B measure of the gate (eval/gate.mjs): the replay set in eval/tierb-set/ (cases.json, records/, drafts/) run through the
// real code that decides whether a new entry is created, with no AI:
//   1. agents/process-item.mjs with AI clients that refuse to be called: every code refusal before any AI is spent (not a bill, already
//      tracked, related bills unread, no section's criterion met) holds the case here;
//   2. a case that would reach the AI readers is decided by its recorded draft (what the agents wrote in the audit run) through
//      publish/tier-b.mjs applyTierB with new-entry publishing on: created or skipped.
// Scored against the case's expect: not_created (created = wrong; reaching the readers with no draft to decide it = wrong, since only a
// code refusal proves it), created:<section> (created elsewhere = wrong; not created = missed), to_readers (held before the readers =
// missed). The gate needs wrong 0. Writes eval/reports/<date>-tierb.json with the current checks_hash.
// A case may patch its record (raw_patch), add a tracked entry for itself (entries_patch: add_title_number "ST:NUM", or add_entry {...}), and
// change its recorded draft the way a wrong draft would be (draft_patch: a figure not in its quote, another section).
//   node eval/tierb-set.mjs [--no-write] [--only id,id]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { processItem } from '../agents/process-item.mjs';
import { applyTierB } from '../publish/tier-b.mjs';
import { checksHash } from './hash.mjs';
import { writeMeasureReport } from './gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');
export const SET_DIR = path.join(here, 'tierb-set');
const J = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const merge = (a, b) => { if (b == null) return a; if (typeof b === 'object' && !Array.isArray(b)) { const o = { ...(a || {}) }; for (const [k, v] of Object.entries(b)) o[k] = merge(o[k], v); return o; } return b; };

class ReachedAI extends Error {}
const trap = { generate() { throw new ReachedAI('reached the AI readers'); } };

export async function replayCase(c, { entries, data, dir = SET_DIR, runDate = '2026-10-29' }) {
  const rec = J(path.join(dir, 'records', c.record)), raw = merge(rec.raw, c.raw_patch || null), item = rec.item;
  let es = entries;
  if (c.entries_patch && c.entries_patch.add_title_number) {
    const [st, num] = c.entries_patch.add_title_number.split(':');
    es = [...entries, { id: 999999, key: 'hand-written-test-entry', section: 'B', state: st, jurisdiction: st, level: 'state', title: `${num.replace(/^([A-Z]+)(\d+)$/, '$1 $2')} — an entry written by hand, without ids`, short_name: `${st} ${num}`, identifiers: {} }];
  }
  // Round 4: a tracked entry as given (a companion or a number written out), added to the tracker for this case only.
  if (c.entries_patch && c.entries_patch.add_entry) es = [...es, { id: 999998, key: 'round4-test-entry', identifiers: {}, ...c.entries_patch.add_entry }];
  const diff = { item_id: item.item_id, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'replay' }] };
  let stage, why;
  try {
    const r = await processItem({ generator: trap, validator: trap, referee: trap, item, raw, diff, entry: null, entries: es, today: runDate, runId: 'tierb-set' });
    stage = 'held'; why = r.reason;
  } catch (e) { if (!(e instanceof ReachedAI)) throw e; stage = 'readers'; }
  let created = null;
  if (stage === 'readers' && c.draft) {
    // draft_patch (round 4): the recorded draft with a field changed the way a wrong draft would be (a figure not in its quote, another section).
    const draft = merge(J(path.join(dir, 'drafts', c.draft)), c.draft_patch || null);
    const t = applyTierB({ data: { ...data, entries: es }, drafts: [{ item_id: item.item_id, outcome: 'publishable', operation: 'create', entry: draft }], itemById: new Map([[item.item_id, item]]), readRaw: () => raw, runId: 'tierb-set', runDate, config: { auto_publish: { new_entries: true }, max_new_entries_per_run: 3, news_from_official_actions: true } });
    created = t.added[0] ? t.added[0].section : null;
    why = created ? `created in ${created}` : (t.skipped[0] && t.skipped[0].why) || 'not created';
  }
  const exp = c.expect, want = exp.startsWith('created:') ? exp.slice(8) : null;
  const wrong = exp === 'not_created' ? !!created || (stage === 'readers' && !c.draft) : want ? !!created && created !== want : false;
  const missed = want ? !created : exp === 'to_readers' ? stage === 'held' : false;
  return { id: c.id, expect: exp, stage, created, wrong, missed, why: String(why || '').slice(0, 240) };
}

export async function runTierBSet({ dir = SET_DIR, dataDir = path.join(P, '..', 'web', 'data', 'v2'), only = null, now = new Date() } = {}) {
  const set = J(path.join(dir, 'cases.json'));
  const read = (f, d) => (fs.existsSync(path.join(dataDir, f)) ? J(path.join(dataDir, f)) : d);
  const entries = read('entries.json', []), data = { entries, news: read('news.json', { items: [] }), site: read('site.json', {}), changes: read('changes.json', { items: [] }) };
  const rows = [];
  for (const c of set.cases.filter((x) => !only || only.includes(x.id))) rows.push(await replayCase(c, { entries, data, dir }));
  return { measure: 'tierb', run_at: now.toISOString(), checks_hash: checksHash('new_entries'), cases: rows.length, wrong: rows.filter((x) => x.wrong).length, missed: rows.filter((x) => x.missed).length, partial: !!only, rows };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2), i = a.indexOf('--only'), only = i >= 0 ? a[i + 1].split(',') : null;
  const rep = await runTierBSet({ only });
  rep.rows.forEach((x) => console.log(`  ${x.wrong ? 'WRONG ' : x.missed ? 'missed' : 'ok    '} ${x.id.padEnd(24)} expect ${x.expect.padEnd(11)} ${x.stage === 'held' ? 'held before AI' : x.created ? 'CREATED ' + x.created : 'reached readers'}: ${x.why.slice(0, 120)}`));
  console.log(`tier B replay set: ${rep.cases} cases, ${rep.wrong} wrong, ${rep.missed} missed`);
  if (!a.includes('--no-write') && !only) console.log('wrote ' + writeMeasureReport(rep));
  process.exit(rep.wrong ? 1 : 0);
}
