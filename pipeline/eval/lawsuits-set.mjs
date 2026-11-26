// The lawsuit measure (the gate for auto_publish.lawsuits, owner 26 Nov 2026): the production writer and reviewer (agents/lawsuit.mjs
// writeLawsuit, the code a run uses) on every case of eval/lawsuits-set/cases.json, scored by code against each case's gold answer.
//   wrong     a case that would be published although it is out of scope, or whose published defendant, court or filing date contradicts
//             the gold answer
//   missed    an in-scope case not published (held or ruled out): reported, not wrong (nothing false reaches the site)
// The gate needs zero wrong, at least one published, every case run, no error, by the current code and the production models.
//   node eval/lawsuits-set.mjs [--write] [--only id,id]        (paid: about 2 model calls per case)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeLawsuit } from '../agents/lawsuit.mjs';
import { checksHash } from './hash.mjs';
import { writeMeasureReport, roleModel } from './gate.mjs';
import { loadEnv } from '../grabber/lib/env.mjs';
import { createLlmFactory } from '../llm/make.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const LAWSUITS_SET = path.join(here, 'lawsuits-set', 'cases.json');

// One case scored: the decision and what (if anything) is wrong with it.
export function scoreCase(c, w) {
  const g = c.gold, out = w.out || {}, published = w.decision === 'publishable', why = [];
  if (published && !g.in_scope) why.push('published although out of scope');
  if (published && g.in_scope) {
    const d = String(out.defendant || '');
    if (g.defendant_includes && !d.includes(g.defendant_includes)) why.push(`defendant "${d}" is not ${g.defendant_includes}`);
    if (g.defendant_includes_any && !g.defendant_includes_any.some((x) => d.includes(x))) why.push(`defendant "${d}" is none of ${g.defendant_includes_any.join(', ')}`);
    if (g.court_includes && !String(out.court || '').includes(g.court_includes)) why.push(`court "${out.court}" is not ${g.court_includes}`);
    if (g.court_includes === null && out.court) why.push(`a court ("${out.court}") the release does not name`);
    if (g.filed_date_any && !g.filed_date_any.includes(out.filed_date || '')) why.push(`filed date "${out.filed_date}" is not ${g.filed_date_any.map((x) => x || '(none)').join(' or ')}`);
  }
  return { id: c.id, in_scope: g.in_scope, decision: w.decision, wrong: why.length > 0, why, missed: g.in_scope && !published, reason: w.reason || null };
}

export async function runLawsuitsSet({ writer, reviewer, only = null, log = () => {} }) {
  const set = JSON.parse(fs.readFileSync(LAWSUITS_SET, 'utf8')).cases.filter((c) => !only || only.includes(c.id));
  const results = [];
  let errors = 0;
  for (const c of set) {
    try {
      const w = await writeLawsuit({ writer, reviewer, release: { url: c.url, title: c.title, publisher: c.publisher, date: c.date || '', text: c.text }, itemId: `eval:${c.id}` });
      const s = scoreCase(c, w); results.push(s); log(`${c.id}: ${w.decision}${s.wrong ? ' WRONG: ' + s.why.join('; ') : ''}`);
    } catch (e) { errors++; results.push({ id: c.id, error: String(e.message).slice(0, 200) }); log(`${c.id}: error ${e.message}`); }
  }
  return { cases: set.length, published: results.filter((r) => r.decision === 'publishable').length, wrong: results.filter((r) => r.wrong).length, missed: results.filter((r) => r.missed).length, errors, results, partial: !!only };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const P = path.resolve(here, '..'), args = process.argv.slice(2), opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  loadEnv(P);
  const models = JSON.parse(fs.readFileSync(path.join(P, 'config', 'models.json'), 'utf8')), factory = createLlmFactory({ models });
  if (!factory.hasKey) { console.error(`${factory.keyName} is not set`); process.exit(2); }
  const r = await runLawsuitsSet({ writer: factory.make('writer'), reviewer: factory.make('bill_reviewer'), only: opt('--only') ? opt('--only').split(',') : null, log: (m) => console.log('  ' + m) });
  const report = { measure: 'lawsuits', run_at: new Date().toISOString(), checks_hash: checksHash('lawsuits'), writer: roleModel(models, 'writer'), reviewer: roleModel(models, 'bill_reviewer'), ...r };
  console.log(`lawsuits: ${r.cases} cases, ${r.published} published, ${r.wrong} wrong, ${r.missed} missed, ${r.errors} error(s)`);
  if (args.includes('--write') && !r.partial) console.log('report:', writeMeasureReport(report));
  process.exit(r.wrong || r.errors ? 1 : 0);
}
