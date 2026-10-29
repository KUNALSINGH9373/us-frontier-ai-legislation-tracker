// The news-writer measure (proposed gate input for the news switch): the fact-sheet writer (news/writer.mjs) replayed over a fixed set of
// events on real tracked entries (eval/news-writer-set/cases.json).
//   recorded  the live writer and reader answers (recorded once with --record, within budget) are replayed through writeCard. A card
//             published as AI-written must be the recorded card and must carry review "ok"; a published card reviewed "bad" is WRONG.
//             A template fallback is counted as missed (not wrong).
//   bad       synthetic bad cards (the traps: "unanimously" on 38-2, a scheduled hearing written as held, "first" with no milestone,
//             invented names, numbers, dates ...). Each is replayed with a second reader that wrongly says faithful, so only the code
//             checks stand in the way; any one that is published is WRONG.
// The gate would need wrong 0 over the whole set (cases >= the set's size). Code only in replay; --record makes live Claude calls.
//   node eval/news-writer-set.mjs [--no-write]
//   node eval/news-writer-set.mjs --record [--only id,id] [--max-usd 0.4]    (paid; writes recorded answers into cases.json)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeCard, checkCard } from '../news/writer.mjs';
import { buildFactSheet } from '../news/factsheet.mjs';
import { checksHash } from './hash.mjs';
import { writeMeasureReport } from './gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');
export const WRITER_SET = path.join(here, 'news-writer-set', 'cases.json');
const ENTRIES = path.join(P, '..', 'web', 'data', 'v2', 'entries.json');

export const loadEntries = (f = ENTRIES) => { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return new Map((Array.isArray(d) ? d : d.entries).map((e) => [e.key, e])); };
export const eventOf = (c) => ({ key: `${c.event.jurisdiction}|${c.entry_key || '-'}|${c.event.class}|${c.event.date}`, entry_id: c.entry_key || null, status: 'confirmed', sources: [], confirmations: [], history: [], ...c.event });

const scripted = (answers) => ({ calls: 0, async generate() { const a = answers[Math.min(this.calls++, answers.length - 1)]; if (a && a.__error) throw new Error(a.__error); return { data: JSON.parse(JSON.stringify(a)), usage: {} }; } });
const fooledReader = () => scripted([{ faithful: true, added_or_overstated: [] }]);

const AI_ON = { news: { ai_writer: true } };

// The phrase-bank measure (news.ai_writer false, the default): the matrix (every class × every variant × representative sheets:
// vote missing, no = 0, split vote, scheduled vs held, withdrawn, multi-chamber, state / federal / unicameral) plus every real
// event of the set rendered by bankCard, each checked by the trap assertions (eval/news-bank-matrix.mjs); and the AI synthetic-bad
// suite, which checkCard alone must refuse. wrong = a trap broken by a bank card, or a synthetic bad card checkCard passes.
export async function runBankMeasure({ cases, today, entries, models = null, now = new Date() }) {
  const { runMatrix, trapProblems } = await import('./news-bank-matrix.mjs');
  const { BANK } = await import('../news/phrasebank.mjs');
  const { bankCard } = await import('../news/writer.mjs');
  const m = runMatrix(entries.get('ca-ab-1405-auditor-registry'));
  const rows = [];
  for (const c of cases) {
    const entry = entries.get(c.entry_key) || null, event = eventOf(c), sheet = buildFactSheet(event, entry, { today: c.today || today });
    const r = bankCard({ event, entry, sheet });
    const t = r.card.written_by === 'bank' ? trapProblems(r.card, sheet) : [];
    rows.push({ id: c.id, kind: 'real-event', written_by: r.card.written_by, wrong: t.length > 0, missed: r.card.written_by !== 'bank', headline: r.card.headline, body: r.card.body, reason: t[0] || r.reason });
    for (const [i, b] of (c.bad || []).entries()) { const p = checkCard(b, sheet); rows.push({ id: `${c.id}#bad${i + 1}`, kind: 'checkcard-suite', why: b.why, wrong: p.length === 0, missed: false, reason: p[0] || 'checkCard passed it' }); }
  }
  // a variant that renders on no representative sheet, or never passes checkCard, is reported (unusable), not hidden
  const passing = new Set(m.rows.filter((x) => !x.refused && x.kind === 'H').flatMap((x) => [`${x.cls}|H|${x.i}`, `${x.cls}|B|${x.b}`]));
  const unusable = Object.entries(BANK).flatMap(([cls, b]) => [...b.H.map((_, i) => `${cls}|H|${i}`), ...b.B.map((_, i) => `${cls}|B|${i}`)]).filter((k) => !passing.has(k));
  const variants = Object.fromEntries(Object.entries(BANK).map(([cls, b]) => [cls, { headlines: b.H.length, bodies: b.B.length }]));
  const mw = m.rows.filter((x) => x.wrong);
  return {
    measure: 'news_writer', mode: 'bank', run_at: now.toISOString(), checks_hash: checksHash('news_writer'), cases: cases.length,
    wrong: rows.filter((x) => x.wrong).length + mw.length, missed: rows.filter((x) => x.missed).length,
    bank_written: rows.filter((x) => x.kind === 'real-event' && x.written_by === 'bank').length, ai_written: 0,
    matrix: { renderings: m.rows.length, wrong: mw.length, refused: m.rows.filter((x) => x.refused).length, unusable_headlines: unusable, examples_wrong: mw.slice(0, 5) },
    checkcard_suite: { cases: rows.filter((x) => x.kind === 'checkcard-suite').length, passed_wrongly: rows.filter((x) => x.kind === 'checkcard-suite' && x.wrong).length },
    variants, models, rows
  };
}

export async function runWriterSet({ cases, today, entries, models = null, now = new Date() }) {
  const rows = [];
  for (const c of cases) {
    const entry = entries.get(c.entry_key) || null, event = eventOf(c), sheet = buildFactSheet(event, entry, { today: c.today || today });
    // 1. recorded live answers
    if (c.recorded) {
      const r = await writeCard({ config: AI_ON, event, entry, sheet, writer: scripted(c.recorded.writer), reader: scripted(c.recorded.reader.length ? c.recorded.reader : [{ faithful: false, added_or_overstated: ['no answer'] }]), today: c.today || today });
      const ai = r.card.written_by === 'ai';
      const differs = ai && c.recorded.card && (r.card.headline !== c.recorded.card.headline || r.card.body !== c.recorded.card.body);
      const wrong = ai && (c.recorded.review !== 'ok' || !!differs);
      rows.push({ id: c.id, kind: 'recorded', written_by: r.card.written_by, wrong, missed: !ai, headline: r.card.headline, reason: wrong ? (differs ? 'replayed card differs from the recorded one' : `published a card reviewed ${c.recorded.review || 'not reviewed'}`) : r.reason });
    }
    // 2. synthetic bad cards, with a reader that wrongly confirms them
    for (const [i, b] of (c.bad || []).entries()) {
      const r = await writeCard({ config: AI_ON, event, entry, sheet, writer: scripted([{ headline: b.headline, body: b.body }]), reader: fooledReader(), today: c.today || today, maxRounds: 1 });
      const problems = checkCard(b, sheet);
      rows.push({ id: `${c.id}#bad${i + 1}`, kind: 'synthetic-bad', why: b.why, written_by: r.card.written_by, wrong: r.card.written_by === 'ai', missed: false, reason: problems[0] || null });
    }
  }
  const rec = rows.filter((x) => x.kind === 'recorded');
  return { measure: 'news_writer', mode: 'ai', generator: models && models.generator || null, validator: models && models.validator || null, run_at: now.toISOString(), checks_hash: checksHash('news_writer'), cases: cases.length, recorded: rec.length, synthetic: rows.length - rec.length, wrong: rows.filter((x) => x.wrong).length, missed: rows.filter((x) => x.missed).length, ai_written: rec.filter((x) => x.written_by === 'ai').length, rows };
}

// --record: one live pass per case (writer + reader, up to 2 rounds), every answer stored. Spend goes on the shared ledger
// (state/ledger/<month>.jsonl) and the run stops before it passes maxUsd.
async function record({ set, only, maxUsd }) {
  const { loadEnv } = await import('../grabber/lib/env.mjs');
  const { createLlmFromConfig, createLedger } = await import('../llm/index.mjs');
  const { createSpend } = await import('../llm/spend.mjs');
  loadEnv(P);
  const config = JSON.parse(fs.readFileSync(path.join(P, 'config', 'models.json'), 'utf8'));
  const spend = createSpend({ dir: path.join(P, 'state', 'ledger') });
  const ledger = createLedger({ limits: config.limits, prices: config.prices_per_million_tokens, onCall: (r) => spend.append({ ...r, run: 'news-writer-set' }) });
  const mk = (role) => createLlmFromConfig({ config, role, provider: 'anthropic', ledger }).llm;
  const entries = loadEntries();
  const tap = (llm, log) => ({ async generate(req) { try { const r = await llm.generate(req); log.push(r.data); return r; } catch (e) { log.push({ __error: e.message }); throw e; } } });
  const perCard = [];
  for (const c of set.cases) {
    if (only && !only.includes(c.id)) continue;
    const cost = ledger.totals().estimated_cost_usd || 0;
    if (cost >= maxUsd) { console.log(`stopping: spent $${cost} of the $${maxUsd} limit`); break; }
    const w = [], rd = [], before = cost;
    const entry = entries.get(c.entry_key) || null, event = eventOf(c);
    const r = await writeCard({ config: AI_ON, event, entry, writer: tap(mk('generator'), w), reader: tap(mk('validator'), rd), today: c.today || set.today, log: (m) => console.log('    ' + m) });
    c.recorded = { at: new Date().toISOString(), writer: w, reader: rd, written_by: r.card.written_by, card: r.card.written_by === 'ai' ? { headline: r.card.headline, body: r.card.body } : null, review: c.recorded && c.recorded.review || null };
    const spent = (ledger.totals().estimated_cost_usd || 0) - before; perCard.push(spent);
    console.log(`  ${c.id}: ${r.card.written_by} in ${r.rounds} round(s), $${spent.toFixed(5)}  | ${r.card.headline} | ${r.card.body}`);
  }
  fs.writeFileSync(WRITER_SET, JSON.stringify(set, null, 1) + '\n');
  const t = ledger.totals();
  console.log(`recorded; calls ${t.calls}, tokens ${t.input_tokens} in / ${t.output_tokens} out, $${t.estimated_cost_usd}; mean per card $${(perCard.reduce((a, b) => a + b, 0) / Math.max(1, perCard.length)).toFixed(5)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const set = JSON.parse(fs.readFileSync(WRITER_SET, 'utf8'));
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  if (process.argv.includes('--record')) { await record({ set, only: arg('--only') ? arg('--only').split(',') : null, maxUsd: Number(arg('--max-usd') || 0.4) }); process.exit(0); }
  const publish = JSON.parse(fs.readFileSync(path.join(P, 'config', 'publish.json'), 'utf8'));
  const ai = !!(publish.news && publish.news.ai_writer === true);
  const rep = ai ? await runWriterSet({ cases: set.cases, today: set.today, entries: loadEntries(), models: set.models || null }) : await runBankMeasure({ cases: set.cases, today: set.today, entries: loadEntries(), models: set.models || null });
  rep.rows.forEach((x) => console.log(`  ${x.wrong ? 'WRONG ' : x.missed ? 'missed' : 'ok    '} ${x.id.padEnd(40)} ${x.kind.padEnd(15)} ${x.written_by || ''}${x.reason ? ` (${String(x.reason).slice(0, 90)})` : ''}`));
  console.log(ai ? `news writer set (AI): ${rep.cases} cases, ${rep.recorded} recorded, ${rep.synthetic} synthetic bad, ${rep.ai_written} AI-written, ${rep.wrong} wrong, ${rep.missed} missed` : `news writer set (phrase bank): ${rep.cases} real events (${rep.bank_written} bank, ${rep.missed} template), matrix ${rep.matrix.renderings} renderings (${rep.matrix.wrong} wrong, ${rep.matrix.refused} refused by checkCard, unusable ${rep.matrix.unusable_headlines.length}), checkCard suite ${rep.checkcard_suite.cases} (${rep.checkcard_suite.passed_wrongly} passed wrongly); ${rep.wrong} wrong`);
  if (!process.argv.includes('--no-write')) console.log('wrote ' + writeMeasureReport(rep));
  process.exit(rep.wrong ? 1 : 0);
}
