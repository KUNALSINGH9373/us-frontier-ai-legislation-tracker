// The scope check for the LegiScan catch-up: is each fetched candidate bill in the tracker's scope? Reads the bill's own text,
// returns in / out with a word-for-word quote, and code confirms the quote is really in the bill. Writes NOTHING to the site.
//   node scope-check/run.mjs [run folder ...]        default: every run folder under data/runs that has LegiScan candidates
//   node scope-check/run.mjs --validate <run folder>  checks the bills the site ALREADY tracks (all should be in scope); text from the
//                                                     legislature's own site, no LegiScan query
// Output: out/scope-check.json and out/scope-check-report.md
//
// Only the parts of a bill that matter are sent: its opening (title / purpose), its definitions, and every passage that mentions AI,
// models, developers or compute. A long budget bill is cut to those passages instead of being judged on its first pages.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from '../grabber/lib/env.mjs';
import { createHttp } from '../grabber/lib/http.mjs';
import { createOfficial } from '../grabber/sources/official.mjs';
import { latestText, officialUrl, trackerStatus, createLegiScan } from '../grabber/sources/legiscan.mjs';
import { pdfToText } from '../grabber/lib/pdf.mjs';
import { readUsage, addUsage, LEGISCAN_USAGE_FILE } from '../grabber/run-legiscan.mjs';
import { createLlmFactory, roleModel } from '../llm/make.mjs';
import { SCOPE_DEFINITION } from '../agents/prompts.mjs';
import { containsQuote } from '../agents/source-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineDir = path.resolve(here, '..');
// v2 (13 Oct 2026): v1 called Virginia's JCOTS study of AI independent verification organizations (on the site) "only a study".
export const SCOPE_CHECK_VERSION = 'scope-v2';

// Strong words show frontier content; weak words are common in any bill that mentions AI. A long bill is cut to: its opening, its
// definitions, every passage around a strong word, and then passages around weak words while room is left. (13 Oct 2026: with one
// list for all words, Massachusetts S.3178, 179,000 characters with "frontier" 134 times, was cut before its frontier sections.)
const STRONG_RE = /frontier|foundation model|large developer|floating[- ]point|10\s*\^\s*2[56]|catastroph|critical harm|kill switch|shutdown|verification organi|safety incident|safety (and security )?protocol|superintelligen|artificial general intelligence/gi;
const WEAK_RE = /artificial intelligence|\bA\.?I\.?\b|machine learning|\bmodels?\b|developer|computing power|compute|neural|algorithm|audit/gi;

const mergeSpans = (spans) => { const m = []; for (const s of [...spans].sort((x, y) => x[0] - y[0])) { const l = m.at(-1); if (l && s[0] <= l[1]) l[1] = Math.max(l[1], s[1]); else m.push([...s]); } return m; };
const spanLen = (spans) => mergeSpans(spans).reduce((n, [x, y]) => n + (y - x), 0);

export function excerpt(text, { head = 3000, around = 900, defs = 6000, max = 45000 } = {}) {
  const t = String(text || '');
  if (t.length <= max) return { text: t, cut: false };
  const spans = [[0, head]];
  const d = t.search(/\bdefinitions?\b|\bas used in this (act|chapter|section)/i);
  if (d >= 0) spans.push([Math.max(0, d - 300), d + defs]);
  for (const re of [STRONG_RE, WEAK_RE]) {
    for (const m of t.matchAll(re)) {
      const s = [Math.max(0, m.index - around), Math.min(t.length, m.index + around)];
      if (spanLen([...spans, s]) > max) break;
      spans.push(s);
    }
  }
  return { text: mergeSpans(spans).map(([x, y]) => t.slice(x, y)).join('\n[...]\n'), cut: true };
}

export const SCOPE_SYSTEM = `You decide whether ONE US state bill belongs in a tracker of frontier-AI law. ${SCOPE_DEFINITION}
The tracker also covers bills that license or accredit AI auditors / independent verification organizations, AI safety incident reporting, whistleblower protections for AI developers' employees, and catastrophic-risk rules, when they apply to developers or models in general (not one sector). A study, commission, report or pilot is in scope when it is specifically about frontier AI, its risks, or AI auditors / independent verification organizations. A long omnibus, budget or economic development bill is in scope if any of its sections does one of these things.

Read the BILL TEXT (parts of a long bill may be left out, marked [...]). Answer:
- in_scope: true if the bill imposes duties on, sets rules for, or directly targets frontier / large AI developers or models (e.g. a compute or revenue threshold, "frontier model", "large developer", safety frameworks, incident reporting, audits / independent verification, kill switch, catastrophic risk), or licenses AI auditors / verification organizations. false if it only mentions AI in passing, or regulates AI in one sector or use (deepfakes, elections, hiring, chatbots or companions, minors, health care, insurance, housing, education, government use or procurement, toys, personhood), or sets up a general AI study or task force not aimed at frontier AI or AI auditors, or is not about AI.
- quote: ONE short passage copied EXACTLY, character for character, from the BILL TEXT that best shows your answer (for true: the duty, definition or threshold aimed at frontier developers; for false: what the bill is actually about). 10 to 60 words. Do not paraphrase, do not join separate passages.
- reason: one or two plain sentences.
- confidence: "high", "medium" or "low".
Return JSON only: {"in_scope":true|false,"confidence":"high"|"medium"|"low","reason":"...","quote":"..."}`;

const SCHEMA = { type: 'OBJECT', required: ['in_scope', 'confidence', 'reason', 'quote'], properties: { in_scope: { type: 'BOOLEAN' }, confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] }, reason: { type: 'STRING' }, quote: { type: 'STRING' } } };

// A quote the model copied correctly can still miss a strict match when the page prints line numbers or breaks words
// (New York's pages do). Second try: letters only, so numbers, spacing and punctuation are ignored. Marked "loose" in the report.
export const lettersOnly = (s) => String(s || '').toLowerCase().replace(/[^a-z]+/g, '');
export const quoteMatch = (text, quote) => (!quote ? null : containsQuote(text, quote) ? 'exact' : lettersOnly(quote).length >= 40 && lettersOnly(text).includes(lettersOnly(quote)) ? 'loose' : null);

// One bill -> { verdict: in_scope | out_of_scope | needs_look | no_text, ... }. A quote that is not in the bill makes the answer unproven:
// an unproven "in" or an unproven "out" both become needs_look, so a bad quote can never hide a bill.
export async function checkOne({ llm, bill, text }) {
  if (!text || text.length < 200) return { verdict: 'no_text', reason: 'no readable bill text' };
  const ex = excerpt(text);
  const prompt = `BILL: ${bill.state} ${bill.bill_number}: ${bill.title}\nDESCRIPTION: ${bill.description || ''}\n\nBILL TEXT${ex.cut ? ' (only the opening, the definitions and the passages about AI; other parts left out)' : ''}:\n${ex.text}`;
  let r;
  try { r = (await llm.generate({ system: SCOPE_SYSTEM, prompt, itemId: `scope:${bill.bill_id}`, responseSchema: SCHEMA })).data; }
  catch (e) { return { verdict: 'needs_look', reason: 'model call failed: ' + String(e.message).slice(0, 120), excerpt_cut: ex.cut }; }
  const match = quoteMatch(text, r.quote);
  const verdict = !match ? 'needs_look' : r.in_scope ? 'in_scope' : 'out_of_scope';
  return { verdict, in_scope: r.in_scope, confidence: r.confidence, reason: r.reason, quote: r.quote, quote_found: match, excerpt_cut: ex.cut };
}

// Every LegiScan discovery candidate saved in the given run folders (newest copy of each bill wins).
export function candidatesIn(runDirs) {
  const byId = new Map();
  for (const dir of runDirs) {
    const cs = path.join(dir, 'changeset.json');
    if (!fs.existsSync(cs)) continue;
    for (const it of JSON.parse(fs.readFileSync(cs, 'utf8')).items.filter((i) => i.source === 'legiscan' && i.reason === 'discovery')) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, it.raw_path), 'utf8'));
      byId.set(it.source_id, { run: path.basename(dir), item: it, raw });
    }
  }
  return [...byId.values()];
}

const md = (rows, title) => {
  const g = (v) => rows.filter((r) => r.result.verdict === v);
  const line = (r) => `| ${r.bill.state} ${r.bill.bill_number} | ${String(r.bill.title).replace(/\|/g, '/').slice(0, 90)} | ${trackerStatus(r.bill.status)} | ${r.result.confidence || ''} | ${String(r.result.reason || '').replace(/\|/g, '/')} | ${r.result.quote ? '"' + String(r.result.quote).replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 260) + '"' : ''} | ${r.url} |`;
  const head = '| Bill | Title | Status | Confidence | Why | Quote from the bill (checked by code) | Official page |\n| --- | --- | --- | --- | --- | --- | --- |';
  return [`# ${title}`, '', `${rows.length} bills read. **In scope: ${g('in_scope').length}** · needs a look: ${g('needs_look').length} · out of scope: ${g('out_of_scope').length} · no readable text: ${g('no_text').length}. Prompt ${SCOPE_CHECK_VERSION}. Nothing here is published.`, '',
    '## In scope', '', head, ...g('in_scope').map(line), '',
    '## Needs a look', '', 'The model\'s quote was not found word for word in the bill, or the call failed. Read these by hand.', '', head, ...g('needs_look').map(line), '',
    '## No readable text', '', head, ...g('no_text').map(line), '',
    '## Out of scope', '', head, ...g('out_of_scope').map(line), ''].join('\n');
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadEnv(pipelineDir);
  const args = process.argv.slice(2), validate = args.includes('--validate'), dirsArg = args.filter((a) => !a.startsWith('--'));
  const models = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'models.json'), 'utf8'));
  const factory = createLlmFactory({ models, limits: models.scope_check_limits });
  if (!factory.hasKey) { console.error(`${factory.keyName} is not set`); process.exit(2); }
  const llm = factory.make('scope_checker'), ledger = factory.ledger;
  const runsDir = path.join(pipelineDir, 'data', 'runs');
  const dirs = dirsArg.length ? dirsArg.map((d) => path.resolve(d)) : fs.readdirSync(runsDir).map((d) => path.join(runsDir, d));
  const rows = [];
  if (validate) {
    // the bills the site already tracks, as saved in a run folder; text from the legislature's own site (free)
    const official = createOfficial();
    // when the state's site refuses us, LegiScan's copy (one query each, counted in the monthly usage)
    const lkey = process.env.LEGISCAN_API_KEY, lcfg = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'config', 'legiscan.json'), 'utf8'));
    const usageFile = LEGISCAN_USAGE_FILE, lhttp = createHttp({ secrets: [lkey], maxRequests: Math.max(0, Math.min(60, lcfg.monthly_cap - readUsage(usageFile, new Date()).used)) });
    const ls = lkey ? createLegiScan(lhttp, lkey) : null;
    process.on('exit', () => { if (lhttp.used()) addUsage(usageFile, new Date(), lhttp.used()); });
    for (const dir of dirs) {
      const cs = JSON.parse(fs.readFileSync(path.join(dir, 'changeset.json'), 'utf8'));
      for (const it of cs.items.filter((i) => i.source === 'legiscan' && i.entry_key)) {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, it.raw_path), 'utf8')), v = latestText(raw.bill);
        const cacheFile = v && path.join(pipelineDir, 'data', 'text-cache', `${raw.bill.bill_id}-${v.doc_id}.txt`);
        let text = cacheFile && fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : null;
        if (!text) try { if (v && v.state_link) text = (await official.text(v.state_link)).text; } catch (e) { console.log(`  no official text for ${raw.bill.state} ${raw.bill.bill_number}: ${String(e.message).slice(0, 80)}`); }
        if (!text && v && ls) try { const t = await ls.text(v.doc_id); text = t.text != null ? t.text : t.bytes ? (await pdfToText(t.bytes)).text : null; } catch (e) { console.log(`  no LegiScan text either: ${String(e.message).slice(0, 80)}`); }
        if (text && cacheFile) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, text); }
        rows.push({ bill: raw.bill, entry_key: it.entry_key, url: officialUrl(raw.bill), result: await checkOne({ llm, bill: raw.bill, text }) });
        process.stdout.write('.');
      }
    }
  } else {
    for (const c of candidatesIn(dirs)) { rows.push({ bill: c.raw.bill, url: c.item.source_url, run: c.run, intent: c.raw.search_hit, result: await checkOne({ llm, bill: c.raw.bill, text: c.raw.text }) }); process.stdout.write('.'); }
  }
  console.log('');
  const name = validate ? 'scope-check-validation' : 'scope-check';
  fs.mkdirSync(path.join(pipelineDir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'out', name + '.json'), JSON.stringify(rows.map((r) => ({ state: r.bill.state, number: r.bill.bill_number, bill_id: r.bill.bill_id, title: r.bill.title, entry_key: r.entry_key || null, url: r.url, search: r.intent || null, ...r.result })), null, 1) + '\n');
  fs.writeFileSync(path.join(pipelineDir, 'out', name + '.md'), md(rows, validate ? 'Scope check on bills the site already tracks (all should be in scope)' : 'LegiScan catch-up: scope check of new candidate bills'));
  const c = rows.reduce((n, r) => ({ ...n, [r.result.verdict]: (n[r.result.verdict] || 0) + 1 }), {});
  console.log(`${name}: ${rows.length} bills: ${JSON.stringify(c)}; model ${JSON.stringify(ledger.totals().total_tokens)} tokens in ${ledger.totals().calls} calls`);
}
