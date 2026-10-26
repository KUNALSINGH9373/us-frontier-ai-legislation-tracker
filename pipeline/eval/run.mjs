// The accuracy test set (the gate). Runs the real Generator and the independent reader on the official text of every
// hand-checked entry, as if each were a new bill, and scores what would have been published against the author's
// own entry. Nothing is published. Writes eval/report.md and eval/reports/<date>-<provider>-<model>.json.
//   node eval/run.mjs [--provider gemini|anthropic] [--model <id>] [--thinking-level low] [--max-output-tokens N]
//                     [--item-budget N] [--only key,key] [--limit N] [--concurrency 4]
//
// Scoring is code, not a model:
//   published      the item passed every code check and every claim was supported by the independent reader
//   unsupported    a published field whose quote or number is not in the official text (should be impossible: counted to prove it)
//   fact recall    of the numbers in the author's field that the official text also contains (thresholds, amounts,
//                  deadlines), the share the published field states. Numbers the author took from other documents are not counted.
//   field passes   published, nothing unsupported, and (thresholds, penalties) every provable number of the author's
//                  field is there; mechanism is prose, so its number recall is reported but does not decide the pass
//   scope          the in / out of scope call matches the tracker (section J = out, everything else = in)
// A field's auto_publish switch (config/publish.json) may be turned on only when its pass rate meets eval_bar there.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from '../grabber/lib/env.mjs';
import { createHttp } from '../grabber/lib/http.mjs';
import { sha } from '../grabber/lib/run-common.mjs';
import { createLlmFromConfig, LlmOutputError, InputTooLarge } from '../llm/index.mjs';
import { generatePatch } from '../agents/generator.mjs';
import { VALIDATOR_SYSTEM, validatorPrompt, SCOPE_DEFINITION } from '../agents/prompts.mjs';
import { buildClaims } from '../agents/validator.mjs';
import { containsQuote, digitRuns } from '../agents/source-text.mjs';
import { NEGATIVE_FINDING } from '../agents/rules.mjs';
import { foreignLetters } from '../agents/checks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), P = path.resolve(here, '..');
const args = process.argv.slice(2), opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
export const FIELDS = ['mechanism', 'thresholds', 'penalties'];
const MAX_ROUNDS = 3;

// Numbers worth checking: amounts, thresholds, deadlines. Single digits and 4-digit years are too common to mean anything.
export const factNumbers = (s) => new Set([...digitRuns(s || '')].filter((n) => n.replace('.', '').length > 1 && !/^(19|20)\d\d$/.test(n)));

// Code checks on one patch (the same rules as agents/checks.mjs, without the parts that need an assembled entry).
export function codeChecks(patch, text) {
  const problems = [];
  for (const ev of patch.evidence) if (!containsQuote(text, ev.quote)) problems.push(`evidence quote for ${ev.field} is not in the source: "${String(ev.quote).slice(0, 80)}"`);
  const src = digitRuns(text);
  for (const f of FIELDS) {
    const v = patch.fields[f];
    if (typeof v !== 'string' || !v) continue;
    if (!patch.evidence.some((e) => e.field === f)) problems.push(`no evidence quote for ${f}`);
    for (const n of digitRuns(v)) if (n.length > 1 && !src.has(n)) problems.push(`number ${n} in ${f} is not in the source`);
    if (NEGATIVE_FINDING.test(v)) problems.push(`a "none located" style claim in ${f}`);
    if (/[{}]|```|\\n/.test(v)) problems.push(`stray code or JSON syntax in ${f}`);
    if (foreignLetters(v, text)) problems.push(`letters that do not occur in the source in ${f}`);
    if (v.length > (f === 'mechanism' ? 700 : 400)) problems.push(`${f} is too long (${v.length} characters)`);
  }
  return problems;
}

// Scores one finished item against the author's entry. Pure: used by the tests.
export function scoreItem({ gold, text, result }) {
  // Scope: an in-scope bill must not be dropped as out of scope; an excluded bill must not be published (held is safe).
  const out = { key: gold.key, outcome: result.outcome, scope_ok: gold.in_scope ? result.outcome !== 'out_of_scope' : result.outcome !== 'published', fields: {} };
  for (const f of FIELDS) {
    const want = gold[f], got = result.outcome === 'published' ? result.fields[f] || null : null;
    const provable = [...factNumbers(want)].filter((n) => digitRuns(text).has(n));
    const gotNums = factNumbers(got);
    const found = provable.filter((n) => gotNums.has(n));
    const unsupported = got ? [...digitRuns(got)].filter((n) => n.length > 1 && !digitRuns(text).has(n)) : [];
    const recall = provable.length ? found.length / provable.length : null;
    // mechanism is prose (the author's run to 2,000 characters, ours stop at 700), so its number recall is reported but
    // does not decide the pass; thresholds and penalties are lists of facts and must state every provable number.
    const complete = f === 'mechanism' || ((!provable.length || found.length === provable.length) && !(provable.length && !got));
    const pass = gold.in_scope && result.outcome === 'published' && !unsupported.length && complete;
    out.fields[f] = { gold: want || null, got, provable, found, recall, unsupported, pass };
  }
  return out;
}

export function summarise(scored) {
  const inScope = scored.filter((s) => s.gold_in_scope);
  const fields = Object.fromEntries(FIELDS.map((f) => {
    const rows = inScope.map((s) => s.fields[f]);
    const withFacts = rows.filter((r) => r.recall !== null);
    return [f, {
      items: rows.length, passed: rows.filter((r) => r.pass).length, pass_rate: rows.length ? rows.filter((r) => r.pass).length / rows.length : 0,
      published: rows.filter((r) => r.got).length, unsupported_fields: rows.filter((r) => r.unsupported.length).length,
      fact_recall: withFacts.length ? withFacts.reduce((n, r) => n + r.recall, 0) / withFacts.length : null, items_with_provable_facts: withFacts.length
    }];
  }));
  const outcomes = scored.reduce((n, s) => ({ ...n, [s.outcome]: (n[s.outcome] || 0) + 1 }), {});
  return { items: scored.length, outcomes, scope_agreement: scored.filter((s) => s.scope_ok).length / (scored.length || 1), scope_wrong: scored.filter((s) => !s.scope_ok).map((s) => s.key), fields };
}

// One item: up to 3 Generator rounds, each checked by code and by the independent reader; complaints fed back.
async function runItem({ gold, text, generator, validator, styleExamples }) {
  const item = { item_id: gold.key, source: gold.kind, source_url: gold.url };
  const reasons = [{ kind: 'candidate', detail: 'Describe this bill for the tracker from its official text.' }];
  let feedback = [], previousPatch = null, last = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const g = await generatePatch({ llm: generator, item, source: text, entry: null, reasons, operation: 'create', styleExamples, feedback, previousPatch, needsSection: gold.level === 'federal' });
    if (!g.patch) { feedback = g.problems; continue; }
    const patch = g.patch; previousPatch = patch;
    if (patch.in_scope === false) {
      const scopeClaim = [{ field: 'in_scope', claim: `This item regulates or directly concerns frontier / large-scale AI developers or models, as defined here: ${SCOPE_DEFINITION}` }];
      let r = null; try { r = (await validator.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: text, claims: scopeClaim }), itemId: gold.key })).data.results[0]; } catch (e) { if (!(e instanceof LlmOutputError)) throw e; }
      if (r && r.supported === false) return { outcome: 'out_of_scope', in_scope: false, rounds: round, fields: {}, problems: [] };
      return { outcome: 'held', in_scope: null, rounds: round, fields: {}, problems: ['scope disagreement: generator out, reader in'] };
    }
    const problems = codeChecks(patch, text);
    const claims = buildClaims({ patch, operation: 'create' });
    let res = null;
    try { res = await validator.generate({ system: VALIDATOR_SYSTEM, prompt: validatorPrompt({ source: text, claims }), itemId: gold.key }); } catch (e) { if (!(e instanceof LlmOutputError)) throw e; problems.push('the independent reader gave an unusable answer'); }
    const byN = new Map(((res && res.data && res.data.results) || []).map((r) => [r.n, r]));
    claims.forEach((c, i) => {
      const r = byN.get(i + 1);
      if (!r || r.supported !== true || !containsQuote(text, r.quote)) problems.push(c.field === 'in_scope' ? `an independent reader judged this item out of scope: ${(r && r.reason) || 'no answer'}` : `claim about ${c.field} ("${c.claim.slice(0, 100)}") is not supported: ${(r && r.reason) || 'the reader could not confirm it word for word'}`);
    });
    last = { patch, problems, round };
    if (!problems.length) return { outcome: 'published', in_scope: true, rounds: round, fields: patch.fields, section: patch.fields.section || null, problems: [] };
    feedback = problems;
  }
  return { outcome: 'held', in_scope: last ? last.patch.in_scope : null, rounds: MAX_ROUNDS, fields: {}, problems: last ? last.problems : feedback };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadEnv(P);
  const models = readJson(path.join(P, 'config', 'models.json'));
  const provider = opt('--provider') || models.provider, model = opt('--model');
  const roles = provider === 'anthropic' ? models.anthropic.roles : models.roles;
  // The test set reads whole bills up to 3 rounds each: a larger per-item budget than a daily run (--item-budget).
  const config = { ...models, provider, limits: { ...models.limits, max_tokens_per_run: 6_000_000, max_tokens_per_item: Number(opt('--item-budget')) || 250_000 } };
  if (model || opt('--thinking-level') || opt('--max-output-tokens')) {
    const r = provider === 'anthropic' ? (config.anthropic = { roles: { ...roles } }).roles : (config.roles = { ...roles });
    for (const k of ['generator', 'validator']) r[k] = { ...r[k], ...(model ? { model } : {}), ...(opt('--thinking-level') ? { thinking_level: opt('--thinking-level') } : {}), ...(opt('--max-output-tokens') ? { max_output_tokens: Number(opt('--max-output-tokens')) } : {}) };
  }
  const gkey = process.env.GEMINI_API_KEY;
  const http = createHttp({ headers: provider === 'gemini' ? { 'x-goog-api-key': gkey } : {}, secrets: [gkey].filter(Boolean), maxRequests: 2000, timeoutMs: 180000 });
  const { llm: generator, ledger } = createLlmFromConfig({ config, apiKey: gkey, http, role: 'generator' });
  const { llm: validator } = createLlmFromConfig({ config, apiKey: gkey, http, role: 'validator' });

  const entries = readJson(path.join(P, '..', 'web', 'data', 'v2', 'entries.json'));
  const gold = readJson(path.join(here, 'gold.json')).items;
  const sources = readJson(path.join(here, 'sources.json')).items;
  const only = opt('--only') ? opt('--only').split(',') : null, limit = Number(opt('--limit')) || Infinity;
  const todo = gold.filter((g) => sources[g.key] && sources[g.key].sha256 && (!only || only.includes(g.key))).slice(0, limit);
  const maxChars = (config.limits.max_input_chars_per_call || 120000) - 12000; // room for the instructions and style examples
  const scored = [], queue = [...todo];
  console.log(`eval: ${todo.length} items, provider ${provider}, generator ${generator.model}, reader ${validator.model}`);
  await Promise.all(Array.from({ length: Number(opt('--concurrency')) || 4 }, async () => {
    for (let g; (g = queue.shift());) {
      const s = sources[g.key], f = path.join(P, 'data', 'eval', 'texts', g.key + '.txt');
      const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
      let result;
      if (!text || sha(text) !== s.sha256) result = { outcome: 'no_text', in_scope: null, fields: {}, problems: ['text missing or changed since eval/sources.json; run eval/fetch-texts.mjs'] };
      else if (text.length > maxChars) result = { outcome: 'too_long', in_scope: null, fields: {}, problems: [`${text.length} characters: needs section-by-section reading (not built yet)`] };
      else {
        const styleExamples = entries.filter((e) => e.key !== g.key && e.section === g.section && e.mechanism && e.mechanism.length < 600).slice(0, 2);
        try { result = await runItem({ gold: { ...g, kind: s.kind, url: s.url }, text, generator, validator, styleExamples }); }
        catch (e) { result = { outcome: 'error', in_scope: null, fields: {}, problems: [String(e.message).slice(0, 200)] }; }
      }
      const sc = { ...scoreItem({ gold: g, text: text || '', result }), gold_in_scope: g.in_scope, rounds: result.rounds || 0, problems: result.problems, section: result.section || null };
      scored.push(sc);
      console.log(`  ${g.key}: ${result.outcome}${result.rounds ? ` (${result.rounds} round${result.rounds > 1 ? 's' : ''})` : ''}${sc.scope_ok ? '' : ' SCOPE WRONG'} | ${FIELDS.map((k) => `${k} ${sc.fields[k].pass ? 'pass' : 'fail'}`).join(', ')}`);
    }
  }));
  scored.sort((a, b) => a.key.localeCompare(b.key));
  const summary = summarise(scored), usage = ledger.totals();
  const stamp = new Date().toISOString().slice(0, 10), tag = `${stamp}-${provider}-${generator.model}`;
  const report = { run_at: new Date().toISOString(), provider, generator: generator.model, reader: validator.model, prompt_version: sha(fs.readFileSync(path.join(P, 'agents', 'prompts.mjs'), 'utf8')).slice(0, 12), summary, usage, items: scored };
  fs.mkdirSync(path.join(here, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(here, 'reports', tag + '.json'), JSON.stringify(report, null, 1) + '\n');
  fs.writeFileSync(path.join(here, 'report.md'), renderReport(report));
  console.log(`\n${JSON.stringify(summary.fields, null, 1)}\nscope agreement ${(summary.scope_agreement * 100).toFixed(0)}%; outcomes ${JSON.stringify(summary.outcomes)}; tokens ${usage.total_tokens}\nreport: eval/report.md`);
}

export function renderReport(r) {
  const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`), s = r.summary;
  const L = [`# Accuracy test set: latest report`, '', `Run ${r.run_at.slice(0, 16).replace('T', ' ')} UTC · provider **${r.provider}** · generator \`${r.generator}\` · reader \`${r.reader}\` · prompts ${r.prompt_version} · ${s.items} items · ${r.usage.total_tokens.toLocaleString('en-US')} tokens`, '',
    `Outcomes: ${Object.entries(s.outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}. Scope agreement ${pct(s.scope_agreement)}${s.scope_wrong.length ? ` (wrong: ${s.scope_wrong.join(', ')})` : ''}.`, '',
    '| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |', '|---|---|---|---|---|---|---|',
    ...FIELDS.map((f) => { const x = s.fields[f]; return `| ${f} | ${x.items} | ${x.passed} | **${pct(x.pass_rate)}** | ${x.published} | ${x.unsupported_fields} | ${pct(x.fact_recall)} (${x.items_with_provable_facts}) |`; }), '',
    'A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author\'s field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.', '',
    '## Items', '', '| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |', '|---|---|---|---|---|---|---|---|',
    ...r.items.map((i) => `| ${i.key} | ${i.outcome} | ${i.rounds} | ${i.scope_ok ? 'ok' : '**wrong**'} | ${FIELDS.map((f) => (i.fields[f].pass ? 'pass' : i.fields[f].provable.length && i.fields[f].found.length < i.fields[f].provable.length ? `fail (missing ${i.fields[f].provable.filter((n) => !i.fields[f].found.includes(n)).join(', ')})` : 'fail')).join(' | ')} | ${(i.problems[0] || '').replace(/\|/g, '/').slice(0, 140)} |`)];
  return L.join('\n') + '\n';
}
