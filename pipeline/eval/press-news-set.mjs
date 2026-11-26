// The press-based news measure (the gate for auto_publish.press_news, owner 26 Nov 2026): every case of eval/press-news-set/cases.json run
// through the production grouper, the qualifying rule, writer and reviewer (news/press-news.mjs: the code a run uses), scored against the
// case's gold events, and each published item read by an independent scorer (role "scorer") against its headlines.
//   wrong     an item published for a group that is not one gold event, or for an event that must not be published, with the wrong basis
//             (press / official), or with wording the scorer finds unsupported or overstated
//   missed    a gold event to publish ("press" / "official") that was not: reported, not wrong
// The gate needs zero wrong, zero errors, at least one published, every case, by the current code and the production models.
//   node eval/press-news-set.mjs [--write] [--only id,id]      (paid: a few model calls per case)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { candidate, groupLeads, qualifies, writePressItem } from '../news/press-news.mjs';
import { checksHash } from './hash.mjs';
import { writeMeasureReport, roleModel } from './gate.mjs';
import { loadEnv } from '../grabber/lib/env.mjs';
import { createLlmFactory } from '../llm/make.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PRESS_NEWS_SET = path.join(here, 'press-news-set', 'cases.json');
export const SCORER_SYSTEM = `You check one news item against the headlines it was written from. Answer supported: true only if every statement in the item is said by the headlines (names, numbers, actions, who did what), nothing is added, and nothing is overstated (an allegation or report stated as established fact, a plan as done). Attribution to the outlets is required wording, not a claim. List every problem.`;
export const SCORER_SCHEMA = { type: 'OBJECT', required: ['supported', 'problems'], properties: { supported: { type: 'BOOLEAN' }, problems: { type: 'ARRAY', items: { type: 'STRING' } } } };

// One published item scored against the case's gold events (pure; the scorer's verdict is passed in).
export function scoreItem(c, keys, basis, scorer) {
  const why = [], ev = c.events.find((e) => keys.every((k) => e.keys.includes(k)));
  if (!ev) why.push(`published a group that is not one gold event (${keys.join(', ')})`);
  else {
    if (ev.publish !== 'optional' && ev.publish !== basis) why.push(`basis ${basis}, gold ${ev.publish}`);
  }
  if (scorer && scorer.supported !== true) why.push(`the scorer: ${(scorer.problems || []).join('; ') || 'not supported'}`);
  return why;
}

export async function runPressNewsSet({ grouper, writer, reviewer, scorer, only = null, log = () => {} }) {
  const cases = JSON.parse(fs.readFileSync(PRESS_NEWS_SET, 'utf8')).cases.filter((c) => !only || only.includes(c.id));
  const results = [];
  let errors = 0;
  for (const c of cases) {
    try {
      const leads = c.leads.filter(candidate), published = [];
      const groups = await groupLeads({ grouper, leads, itemId: `eval:${c.id}` });
      for (const g of groups) {
        const gl = g.keys.map((k) => leads.find((l) => l.key === k)), q = qualifies(gl);
        if (!g.in_scope || !q.ok) continue;
        const w = await writePressItem({ writer, reviewer, leads: gl, basis: q.basis, itemId: `eval:${c.id}` });
        if (w.decision !== 'publishable') continue;
        const s = (await scorer.generate({ system: SCORER_SYSTEM, prompt: `${gl.map((l) => `- ${l.publisher}: ${l.title}`).join('\n')}\n\nITEM\ntitle: ${w.out.title}\nbody: ${w.out.body}`, itemId: `eval:${c.id}:score`, responseSchema: SCORER_SCHEMA })).data;
        published.push({ keys: g.keys, basis: q.basis, title: w.out.title, body: w.out.body, wrong: scoreItem(c, g.keys, q.basis, s) });
      }
      const missed = c.events.filter((e) => e.publish !== 'optional' && !published.some((p) => p.keys.some((k) => e.keys.includes(k)) && !p.wrong.length));
      const wrong = published.filter((p) => p.wrong.length);
      results.push({ id: c.id, published, wrong: wrong.length, missed: missed.length });
      log(`${c.id}: ${published.length} published${wrong.length ? `, WRONG: ${wrong.flatMap((p) => p.wrong).join('; ')}` : ''}${missed.length ? `, ${missed.length} missed` : ''}`);
    } catch (e) { errors++; results.push({ id: c.id, error: String(e.message).slice(0, 200) }); log(`${c.id}: error ${e.message}`); }
  }
  const sum = (f) => results.reduce((n, r) => n + (r[f] || 0), 0);
  return { cases: cases.length, published: results.reduce((n, r) => n + ((r.published || []).length), 0), wrong: sum('wrong'), missed: sum('missed'), errors, results, partial: !!only };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const P = path.resolve(here, '..'), args = process.argv.slice(2), opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  loadEnv(P);
  const models = JSON.parse(fs.readFileSync(path.join(P, 'config', 'models.json'), 'utf8')), factory = createLlmFactory({ models });
  if (!factory.hasKey) { console.error(`${factory.keyName} is not set`); process.exit(2); }
  const r = await runPressNewsSet({ grouper: factory.make('validator'), writer: factory.make('generator'), reviewer: factory.make('bill_reviewer'), scorer: factory.make('scorer'), only: opt('--only') ? opt('--only').split(',') : null, log: (m) => console.log('  ' + m) });
  const report = { measure: 'press_news', run_at: new Date().toISOString(), checks_hash: checksHash('press_news'), grouper: roleModel(models, 'validator'), writer: roleModel(models, 'generator'), reviewer: roleModel(models, 'bill_reviewer'), scorer: roleModel(models, 'scorer'), ...r };
  console.log(`press-based news: ${r.cases} cases, ${r.published} published, ${r.wrong} wrong, ${r.missed} missed, ${r.errors} error(s)`);
  if (args.includes('--write') && !r.partial) console.log('report:', writeMeasureReport(report));
  process.exit(r.wrong || r.errors ? 1 : 0);
}
