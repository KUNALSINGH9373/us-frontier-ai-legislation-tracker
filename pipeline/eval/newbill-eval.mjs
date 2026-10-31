// The new-bills measure (the gate for auto_publish.new_entries under new_bills.engine "simple"). Runs the production writer and reviewer
// (agents/newbill.mjs writeAndReview: the same code a daily run uses) on every bill of a case set, as if each were new, and has an
// independent scorer (role "scorer", eval/newbill-scorer.mjs) read every published entry against the bill and the human reference note.
// Nothing is published. Writes eval/reports/<date>-new_bills-<set>.json, which the gate reads.
//   node eval/newbill-eval.mjs [--set test|unseen] [--gold f] [--sources f] [--texts dir] [--references dir] [--only key,key] [--limit N]
//                              [--concurrency 2] [--provider anthropic]
// The test set is eval/gold.json + eval/sources.json + data/eval/texts (eval/fetch-texts.mjs). The unseen set lives outside the repo and is
// passed by path; its size and fingerprints are pinned in config/eval-sets.json, so only a run over exactly that set counts.
// Scored by code:
//   scope       the decision matches the human label: publish / facts-only for an in-scope bill, out of scope / excluded for an out one.
//               Publishing an out-of-scope bill is WRONG; ruling out an in-scope bill is a missed bill. Both are scope errors.
//   wrong ...   per published entry, the scorer's findings that its bill quote proves (code drops any it cannot find in the bill)
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { cleanText, readerText } from '../agents/text-norm.mjs';
import { writeAndReview, modelText } from '../agents/newbill.mjs';
import { stateSectionRule, FEDERAL_SECTION_RULE } from '../agents/prompts.mjs';
import { SCORER_SYSTEM, SCORER_SCHEMA, scorerUser, readScore } from './newbill-scorer.mjs';
import { currentHashes } from './hash.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// A set's fingerprint: its gold file and every reference note (sorted by name), so a report names exactly the set it was run on.
export function setFingerprint({ goldFile, referencesDir = null }) {
  const gold = sha(fs.readFileSync(goldFile));
  if (!referencesDir) return { gold_sha256: gold, references_sha256: null };
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(referencesDir).filter((x) => x.endsWith('.json')).sort()) { h.update(f); h.update(fs.readFileSync(path.join(referencesDir, f))); }
  return { gold_sha256: gold, references_sha256: h.digest('hex') };
}

// The sections a bill may take, as production allows them (agents/derive.mjs stateSections, the federal rule).
export function sectionsFor(g) {
  if (g.level === 'federal') return ['D', 'F', 'G.3'];
  return g.section === 'A' ? ['A', 'C'] : ['B', 'B.2', 'C'];
}
export function billOf(g, meta, stored) {
  const text = modelText(readerText(stored));
  if (text == null) return null;
  const jurisdiction = meta.kind === 'legiscan' ? String(meta.bill || '').split(/\s+/)[0] || 'State' : 'US';
  const number = String(meta.bill || g.title || g.key).replace(/\s*\(\d+\)\s*$/, '');
  return { jurisdiction, number, title: g.title || '', text };
}

const IN = new Set(['publish', 'facts_only']), OUT = new Set(['out_of_scope', 'excluded']);
// One bill's score. w: writeAndReview's result (or { decision: 'error' | 'no_text' }); score: readScore() of a published entry, or null.
export function scoreBill(g, w, score) {
  const d = w.decision, published = d === 'publish';
  const scopeErr = g.in_scope ? (OUT.has(d) ? 'missed' : null) : (IN.has(d) ? 'published_out_of_scope' : null);
  return {
    key: g.key, gold_in_scope: !!g.in_scope, decision: d, published, facts_only: d === 'facts_only',
    scope_error: scopeErr, error: d === 'error' || d === 'unusable', no_text: d === 'no_text',
    // a published out-of-scope bill is itself WRONG, whatever the scorer says about its lines
    wrong: (score ? score.wrong : 0) + (scopeErr === 'published_out_of_scope' ? 1 : 0), misleading: score ? score.misleading : 0, omission: score ? score.omission : 0,
    dropped_findings: score ? score.dropped : 0, findings: score ? score.findings : [], reason: w.reason || null,
    writer_calls: w.trail ? w.trail.writer_calls : 0, reviews: w.trail ? w.trail.reviews.length : 0
  };
}
export function summariseBills(items) {
  const sum = (k) => items.reduce((n, x) => n + (Number(x[k]) || 0), 0), count = (f) => items.filter(f).length;
  const published = count((x) => x.published);
  return {
    items: items.length, published, facts_only: count((x) => x.facts_only), out_of_scope: count((x) => OUT.has(x.decision)), held: count((x) => ['unreadable', 'draft_only'].includes(x.decision)),
    errors: count((x) => x.error), no_text: count((x) => x.no_text), scope_errors: count((x) => x.scope_error), missed: count((x) => x.scope_error === 'missed'),
    wrong: sum('wrong'), misleading: sum('misleading'), omission: sum('omission'),
    misleading_per_published: published ? +(sum('misleading') / published).toFixed(2) : null,
    publish_rate: count((x) => x.gold_in_scope) ? +(published / count((x) => x.gold_in_scope)).toFixed(2) : null
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { loadEnv } = await import('../grabber/lib/env.mjs');
  const { createHttp } = await import('../grabber/lib/http.mjs');
  const { createLlmFromConfig } = await import('../llm/index.mjs');
  loadEnv(P);
  const args = process.argv.slice(2), opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const set = opt('--set') || 'test';
  const goldFile = opt('--gold') || path.join(here, 'gold.json'), sourcesFile = opt('--sources') || path.join(here, 'sources.json');
  const textsDir = opt('--texts') || path.join(P, 'data', 'eval', 'texts'), referencesDir = opt('--references') || null;
  const models = read(path.join(P, 'config', 'models.json')), provider = opt('--provider') || models.provider;
  // A whole-set run reads every bill once or twice with two models: a larger budget than a daily run.
  const config = { ...models, provider, limits: { ...models.limits, max_tokens_per_run: 12_000_000, max_tokens_per_item: 400_000 } };
  const gkey = process.env.GEMINI_API_KEY;
  const http = createHttp({ headers: provider === 'gemini' ? { 'x-goog-api-key': gkey } : {}, secrets: [gkey].filter(Boolean), maxRequests: 5000, timeoutMs: 300000 });
  const make = (role) => createLlmFromConfig({ config, apiKey: gkey, http, role });
  const { llm: writer, ledger } = make('writer'), { llm: reviewer } = make('bill_reviewer'), { llm: scopeJudge } = make('scope_judge'), { llm: scorer } = make('scorer');
  const gold = read(goldFile).items, sources = read(sourcesFile).items;
  const only = opt('--only') ? opt('--only').split(',') : null, limit = Number(opt('--limit')) || Infinity;
  const todo = gold.filter((g) => !only || only.includes(g.key)).slice(0, limit);
  const refOf = (g) => { const f = referencesDir && path.join(referencesDir, g.key + '.json'); return f && fs.existsSync(f) ? read(f) : { mechanism: g.mechanism, thresholds: g.thresholds, penalties: g.penalties, in_scope: g.in_scope, section: g.section }; };
  console.log(`new-bills eval: set ${set}, ${todo.length} bills, writer ${writer.model}, reviewer ${reviewer.model}, scorer ${scorer.model}`);
  const items = [], queue = [...todo];
  await Promise.all(Array.from({ length: Number(opt('--concurrency')) || 2 }, async () => {
    for (let g; (g = queue.shift());) {
      const meta = sources[g.key] || {}, f = path.join(textsDir, g.key + '.txt');
      const stored = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
      let w, score = null;
      if (!stored || (meta.sha256 && sha(stored) !== meta.sha256)) w = { decision: 'no_text', reason: 'text missing or changed since its sources file' };
      else {
        const source = cleanText(stored), bill = billOf(g, meta, stored), sections = sectionsFor(g);
        try {
          w = bill ? await writeAndReview({ writer, reviewer, scopeJudge, bill, source, sections, sectionRule: g.level === 'federal' ? FEDERAL_SECTION_RULE : stateSectionRule(sections), itemId: `eval:${g.key}` }) : { decision: 'unreadable', reason: 'very long text with no AI section found' };
          if (w.decision === 'publish') score = readScore((await scorer.generate({ system: SCORER_SYSTEM, prompt: scorerUser({ billText: bill.text, reference: refOf(g), entry: w.out }), itemId: `score:${g.key}`, responseSchema: SCORER_SCHEMA })).data, source);
        } catch (e) { w = { decision: 'error', reason: String(e.message).slice(0, 200) }; }
      }
      const s = scoreBill(g, w, score); items.push(s);
      console.log(`  ${g.key}: ${s.decision}${s.scope_error ? ` SCOPE ${s.scope_error}` : ''}${s.published ? ` | wrong ${s.wrong}, misleading ${s.misleading}, omission ${s.omission}` : ''}`);
    }
  }));
  items.sort((a, b) => a.key.localeCompare(b.key));
  const summary = summariseBills(items), fp = setFingerprint({ goldFile, referencesDir });
  const report = { measure: 'new_bills', method: 'simple', set, run_at: new Date().toISOString(), provider, writer: writer.model, reviewer: reviewer.model, scope_judge: scopeJudge.model, scorer: scorer.model,
    checks_hash: (currentHashes() || {}).new_entries || null, partial: !!only || Number.isFinite(limit), set_size: gold.length, ...fp, summary, usage: ledger.totals(), items };
  const dir = path.join(here, 'reports'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${report.run_at.slice(0, 10)}-new_bills-${set}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
  console.log(`\n${JSON.stringify(summary, null, 1)}\nreport: ${path.relative(P, out)}`);
}
