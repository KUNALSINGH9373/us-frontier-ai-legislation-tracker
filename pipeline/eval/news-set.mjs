// The news measure of the gate (eval/gate.mjs): a recorded leads set (eval/news-set/cases.json) replayed through the real news writer
// (news/write.mjs draftNews) with the recorded answers of the writer and the second reader. Every case says what must happen:
//   expect "publish"  the draft is checked and would be added (outcome drafted)
//   expect "refuse"   nothing may be added (rejected, secondary, not newsworthy, error)
// wrong = a case expected "refuse" that would be added (a wrong or misleading item), or one expected "publish" that would be added with a
// different title or body than recorded; missed = a "publish" case refused (counted, not wrong). The gate needs wrong 0.
// Code only: the answers are recorded, so the measure is about the checks (quotes, numbers, dates, attribution, freshness, press leads).
// A case format (one object per case in cases.json):
//   { id, note, today, max_age_days, lead: { ...a findLeads lead }, release_fixture: "<file in fixtures/news>" | release_text: "...",
//     writer: [<answer per round>], checker: "yes" | "no" | [<answer per round>], expect: "publish" | "refuse" }
// New cases are added from real leads: record the release page and the models' answers (news/run.mjs keeps them in the run folder).
//   node eval/news-set.mjs [--no-write]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRenderer } from '../news/render.mjs';
import { draftNews } from '../news/write.mjs';
import { checksHash } from './hash.mjs';
import { writeMeasureReport } from './gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');
export const NEWS_SET = path.join(here, 'news-set', 'cases.json');

const scripted = (fn) => ({ calls: 0, async generate(req) { this.calls++; return { data: fn(req, this.calls), usage: {} }; } });
const claimCount = (prompt) => (prompt.match(/^\d+\. \[/gm) || []).length;
function checkerOf(spec) {
  if (Array.isArray(spec)) return scripted((req, n) => spec[Math.min(n, spec.length) - 1]);
  return scripted((req) => ({ results: Array.from({ length: claimCount(req.prompt) }, (_, i) => (spec && spec.supported === false) || spec === 'no'
    ? { n: i + 1, supported: false, quote: null, reason: 'not stated in the release' }
    : { n: i + 1, supported: true, quote: (spec && spec.quote) || null, reason: null }) }));
}

export async function runNewsSet({ cases, fixturesDir = path.join(P, 'fixtures', 'news'), now = new Date() }) {
  const rows = [];
  // a recorded release page is read as the run reads it: rendered in a headless browser, visible text only (news/render.mjs), offline
  let renderer = null;
  try {
  for (const c of cases) {
    if (c.release_text == null && !renderer) renderer = createRenderer();
    const release = c.release_text != null ? c.release_text : await renderer.renderHtml(fs.readFileSync(path.join(fixturesDir, c.release_fixture), 'utf8'));
    const writer = scripted((req, n) => JSON.parse(JSON.stringify(c.writer[Math.min(n, c.writer.length) - 1])));
    let r;
    try { r = await draftNews({ lead: c.lead, release, writer, checker: checkerOf(c.checker), today: c.today, runId: 'news-set', now: new Date(c.today + 'T06:00:00Z'), maxRounds: c.max_rounds || 2, maxAgeDays: c.max_age_days || 14 }); }
    catch (e) { r = { outcome: 'error', reason: e.message }; }
    const added = r.outcome === 'drafted';
    const differs = added && c.expect === 'publish' && c.expect_item && (r.item.title !== c.expect_item.title || r.item.body !== c.expect_item.body);
    rows.push({ id: c.id, expect: c.expect, outcome: r.outcome, wrong: (added && c.expect === 'refuse') || !!differs, missed: !added && c.expect === 'publish', reason: r.reason || null });
  }
  } finally { if (renderer) await renderer.close(); }
  return { measure: 'news', run_at: now.toISOString(), checks_hash: checksHash('news'), cases: rows.length, wrong: rows.filter((x) => x.wrong).length, missed: rows.filter((x) => x.missed).length, rows };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const set = JSON.parse(fs.readFileSync(NEWS_SET, 'utf8'));
  const rep = await runNewsSet({ cases: set.cases });
  rep.rows.forEach((x) => console.log(`  ${x.wrong ? 'WRONG ' : x.missed ? 'missed' : 'ok    '} ${x.id.padEnd(28)} expect ${x.expect.padEnd(7)} got ${x.outcome}${x.reason ? ` (${String(x.reason).slice(0, 90)})` : ''}`));
  console.log(`news set: ${rep.cases} cases, ${rep.wrong} wrong, ${rep.missed} missed`);
  if (!process.argv.includes('--no-write')) console.log('wrote ' + writeMeasureReport(rep));
  process.exit(rep.wrong ? 1 : 0);
}
