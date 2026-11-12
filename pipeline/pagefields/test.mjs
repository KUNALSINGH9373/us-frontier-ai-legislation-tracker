// Run:  node pagefields/test.mjs   (or npm test). Scripted models, no network: the code checks and the review loop.
import fs from 'fs';
import { checkDraft, applyVerdicts, writePageFields } from './write.mjs';
import { kindOf, nameOf, needsName, entryText } from './layout.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const live = JSON.parse(fs.readFileSync(new URL('../../web/data/v2/entries.json', import.meta.url), 'utf8'));
const by = (re) => live.find((e) => re.test(e.short_name));
const sb = by(/^CA SB 53 \(/), raise = by(/^NY RAISE/), mn = by(/^MN HF 4532/), eo = by(/^EO 14409/), lit = by(/^Anthropic v\. Department of War/), watch = by(/^No challenge/);

// layout
ok('kinds: bill, exec, lawsuit, watch item', kindOf(sb) === 'bill' && kindOf(eo) === 'exec' && kindOf(lit) === 'lit' && kindOf(watch) === 'watch');
ok('name: the official short title after the number', nameOf(sb).name === 'Transparency in Frontier AI Act (TFAIA)' && !needsName(sb));
ok('name: a bill whose title is a chapter number needs a display name', needsName(raise), JSON.stringify(nameOf(raise)));
ok('name: a "titled ..." bill takes the quoted name', nameOf(mn).name === 'Responsible Artificial Intelligence Safety and Education Act');
ok('entry text carries the checklist answers with their bill words', /CHECKLIST penalties: yes: .*bill words/.test(entryText(sb)));

// code checks
const good = { summary_line: 'Requires the largest AI developers to publish safety frameworks and report critical incidents within 15 days.', thirty_seconds: { a: 'Developers of models trained above 10^26 operations.', b: 'Publish a framework and report incidents.', c: 'Up to $1,000,000 per violation.' }, key_facts: { enforced_by: 'Attorney General' }, display_name: '' };
{ const r = checkDraft({ entry: sb, draft: good, kind: 'bill', wantName: false }); ok('code: a clean draft passes every check', Object.keys(r.problems).length === 0 && r.fields.summary_line && r.fields.thirty_seconds && r.fields.key_facts.enforced_by, JSON.stringify(r.problems)); }
{ const r = checkDraft({ entry: sb, draft: { ...good, summary_line: 'Requires the largest AI developers to report critical incidents within 12 days.' }, kind: 'bill', wantName: false }); ok('code: a number not in the entry is refused', r.problems.summary_line && !r.fields.summary_line, JSON.stringify(r.problems)); }
{ const r = checkDraft({ entry: sb, draft: { ...good, summary_line: 'Requires frontier developers to publish frameworks. It also protects whistleblowers.' }, kind: 'bill', wantName: false }); ok('code: two sentences are refused', /one sentence/.test((r.problems.summary_line || []).join())); }
{ const r = checkDraft({ entry: sb, draft: { ...good, summary_line: 'Requires the U.S. Department of Commerce to publish a report on frontier AI.' }, kind: 'bill', wantName: false }); ok('code: "U.S." is not a sentence end', !/one sentence/.test((r.problems.summary_line || []).join()), JSON.stringify(r.problems)); }
{ const r = checkDraft({ entry: mn, draft: { ...good, summary_line: 'Requires developers of frontier models to publish safety protocols.' }, kind: 'bill', wantName: false }); ok('code: a stalled bill described in the present tense is refused', /Would/.test((r.problems.summary_line || []).join()), JSON.stringify(r.problems)); }
{ const r = checkDraft({ entry: sb, draft: { ...good, thirty_seconds: { a: 'Developers of large models.', b: '', c: '' } }, kind: 'bill', wantName: false }); ok('code: fewer than two 30-second boxes drops all three', !r.fields.thirty_seconds && r.problems['thirty_seconds.a']); }
{ const r = checkDraft({ entry: sb, draft: { ...good, thirty_seconds: { a: 'Developers of large models.', b: '', c: 'Up to $1,000,000 per violation.' } }, kind: 'bill', wantName: false }); ok('code: one empty box is allowed (the page says "Not stated in the text")', r.fields.thirty_seconds && r.fields.thirty_seconds.b === ''); }
{ const r = checkDraft({ entry: sb, draft: { ...good, thirty_seconds: { a: 'The entry text does not say who is covered.', b: 'Publish a framework.', c: 'Up to $1,000,000 per violation.' } }, kind: 'bill', wantName: false }); ok('code: a box that talks about the record is refused', /talks about the record/.test((r.problems['thirty_seconds.a'] || []).join())); }
{ const r = checkDraft({ entry: sb, draft: { ...good, summary_line: 'The record does not say much, but it concerns frontier developers.' }, kind: 'bill', wantName: false }); ok('code: a summary that talks about the record is refused', /talks about the record/.test((r.problems.summary_line || []).join())); }
{ const r = checkDraft({ entry: sb, draft: { ...good, key_facts: { enforced_by: 'Attorney General (civil action); employees for retaliation' } }, kind: 'bill', wantName: false }); ok('code: a key fact that is an explanation, not a name, is refused', !r.fields.key_facts && /name only/.test((r.problems['key_facts.enforced_by'] || []).join())); }
{ const r = checkDraft({ entry: sb, draft: { ...good, key_facts: { enforced_by: 'The California Privacy Protection Agency' } }, kind: 'bill', wantName: false }); ok('code: a key fact not copied from the entry is refused', !r.fields.key_facts && r.problems['key_facts.enforced_by']); }
{ const r = checkDraft({ entry: lit, draft: { ...good, summary_line: 'Anthropic challenges the government label that cut it off from federal work.', key_facts: { judge: 'Rita F. Lin', lawyers: 'WilmerHale', court: 'Supreme Court of Ohio' } }, kind: 'lit', wantName: false }); ok('code: lawsuit facts copied from the entry pass; one not in it is refused', r.fields.key_facts && r.fields.key_facts.judge === 'Rita F. Lin' && r.fields.key_facts.lawyers === 'WilmerHale' && r.problems['key_facts.court'], JSON.stringify(r)); }
{ const r = checkDraft({ entry: raise, draft: { ...good, summary_line: '', thirty_seconds: {}, key_facts: {}, display_name: 'RAISE Act' }, kind: 'bill', wantName: true }); ok('code: a display name copied from the entry passes', r.fields.display_name === 'RAISE Act', JSON.stringify(r.problems)); }
{ const r = checkDraft({ entry: raise, draft: { ...good, summary_line: '', thirty_seconds: {}, key_facts: {}, display_name: 'New York Frontier Safety Act' }, kind: 'bill', wantName: true }); ok('code: an invented display name is refused', !r.fields.display_name && r.problems.display_name); }
{ const r = checkDraft({ entry: sb, draft: { ...good, display_name: 'Transparency in Frontier AI Act' }, kind: 'bill', wantName: false }); ok('code: a display name is ignored when none is wanted', !r.fields.display_name); }

{ const ma = live.find((e) => /^MA H\.5576/.test(e.short_name)); const r = checkDraft({ entry: ma, draft: { ...good, summary_line: '', thirty_seconds: {}, key_facts: {}, display_name: 'An Act relative to economic development in the commonwealth' }, kind: 'bill', wantName: true }); ok('code: an "An Act relative to ..." display name is refused', !r.fields.display_name && /formal title/.test((r.problems.display_name || []).join()), JSON.stringify(r.problems)); }

// reviewer verdicts
const text = entryText(sb);
{ const f = { summary_line: good.summary_line }; const a = applyVerdicts({ fields: f, verdicts: [{ field: 'summary_line', verdict: 'ok', problem: '', support: ['the moon is made of cheese'] }], text }); ok('review: "ok" with a quote that is not in the entry is refused', !a.keep.summary_line && /not in ENTRY TEXT/.test(a.refused.summary_line), JSON.stringify(a)); }
{ const q = /CHECKLIST penalties: yes: ([^(]{10,60})/.exec(text)[1].trim(); const a = applyVerdicts({ fields: { summary_line: good.summary_line }, verdicts: [{ field: 'summary_line', verdict: 'ok', problem: '', support: [q] }], text }); ok('review: "ok" with a real quote keeps the field', a.keep.summary_line === good.summary_line, JSON.stringify(a)); }
{ const a = applyVerdicts({ fields: { summary_line: good.summary_line }, verdicts: [{ field: 'summary_line', verdict: 'misleading', problem: 'drops who is covered', support: [] }], text }); ok('review: "misleading" drops the field with the reason', !a.keep.summary_line && /drops who/.test(a.refused.summary_line)); }
{ const a = applyVerdicts({ fields: { summary_line: good.summary_line }, verdicts: [], text }); ok('review: no verdict is a refusal', !a.keep.summary_line); }

// the loop with scripted models
const quote = /CHECKLIST penalties: yes: ([^(]{10,60})/.exec(text)[1].trim();
const okAll = (f) => [...(f.summary_line ? ['summary_line'] : []), ...(f.thirty_seconds ? ['thirty_seconds.a', 'thirty_seconds.b', 'thirty_seconds.c'] : []), ...Object.keys(f.key_facts || {}).map((k) => 'key_facts.' + k)];
{
  let w = 0, r = 0;
  const writer = { model: 'w', generate: async () => { w++; return { data: w === 1 ? { ...good, summary_line: 'Requires developers to report incidents within 12 days.' } : good }; } };
  const reviewer = { model: 'opus', generate: async ({ prompt }) => { r++; const fields = []; if (/summary_line:/.test(prompt)) fields.push('summary_line'); if (/thirty_seconds\.a/.test(prompt)) fields.push('thirty_seconds.a', 'thirty_seconds.b', 'thirty_seconds.c'); if (/key_facts\.enforced_by/.test(prompt)) fields.push('key_facts.enforced_by'); return { data: { verdicts: fields.map((field) => ({ field, verdict: 'ok', problem: '', support: [quote] })) } }; } };
  const res = await writePageFields({ entry: sb, writer, reviewer });
  ok('loop: a refused number is rewritten in round 2 and every field is kept', res.rounds === 2 && res.fields.summary_line === good.summary_line && res.fields.thirty_seconds && res.fields.key_facts && !Object.keys(res.dropped).length, JSON.stringify(res));
  ok('loop: round 1 fields that passed are not reviewed again needlessly lost', w === 2 && r === 2);
}
{
  const writer = { model: 'w', generate: async () => ({ data: good }) };
  const reviewer = { model: 'opus', generate: async () => ({ data: { verdicts: [{ field: 'summary_line', verdict: 'wrong', problem: 'says Requires', support: [] }, ...['thirty_seconds.a', 'thirty_seconds.b', 'thirty_seconds.c', 'key_facts.enforced_by'].map((field) => ({ field, verdict: 'ok', problem: '', support: [quote] }))] } }) };
  const res = await writePageFields({ entry: sb, writer, reviewer });
  ok('loop: a field the reviewer refuses twice is dropped with the reason; the rest are kept', !res.fields.summary_line && /wrong/.test(res.dropped.summary_line) && res.fields.thirty_seconds && res.fields.key_facts, JSON.stringify(res));
}

// ---- the run step (pagefields/step.mjs), the final check's allowance (publish/guards.mjs) and the gate measure ----
{
  const os = await import('os'), path = await import('path');
  const { runPageFieldsStep, pickEntries, withFields } = await import('./step.mjs');
  const { basisOf } = await import('./layout.mjs');
  const { checkPublish } = await import('../publish/guards.mjs');
  const { loadData } = await import('../publish/run.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
  ['entries', 'news', 'relationships', 'site', 'changes'].forEach((f) => { const src = new URL(`../../web/data/v2/${f}.json`, import.meta.url); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f + '.json')); });
  const base = loadData(dir);
  // a fresh entry with no page fields, and SB 53 with stale ones
  const fresh = base.entries.find((e) => e.key === sb.key);
  const noPf = { ...fresh }; ['display_name', 'summary_line', 'thirty_seconds', 'key_facts', 'page_verification'].forEach((f) => delete noPf[f]);
  const ents = base.entries.map((e) => (e.key === sb.key ? noPf : e));
  fs.writeFileSync(path.join(dir, 'entries.json'), JSON.stringify(ents, null, 1));
  ok('step: an entry with no page fields is picked; a touched entry comes first', pickEntries(ents, [sb.key], 3)[0].key === sb.key);
  const withBasis = ents.map((e) => (e.page_verification ? { ...e, page_verification: { ...e.page_verification, basis_sha256: basisOf(e) } } : e));
  ok('step: entries whose checksum matches are not picked again', !pickEntries(withBasis, [], 200).some((e) => e.page_verification && e.page_verification.basis_sha256 === basisOf(e)));
  const n = withFields(noPf, { fields: { summary_line: good.summary_line }, reviewerModel: 'opus' }, '2026-11-12T10:00:00Z');
  ok('step: written fields carry the reviewer and the checksum of the text they came from', n.page_verification.reviewer === 'opus' && n.page_verification.basis_sha256 === basisOf(noPf) && n.summary_line === good.summary_line);
  const cfgOff = { auto_publish: { page_fields: false }, page_fields: { max_entries_per_run: 2 } };
  let calls = 0;
  const factory = { make: () => ({ model: 'm', generate: async () => { calls++; return { data: {} }; } }) };
  { const r = await runPageFieldsStep({ dataDir: dir, config: cfgOff, factory, touched: [sb.key] }); ok('step: switch off spends no AI and writes nothing, but says how many pages wait', !r.ran && calls === 0 && r.waiting >= 1 && /off/.test(r.skipped_why)); }
  const cfgOn = { auto_publish: { page_fields: true }, page_fields: { max_entries_per_run: 1 } };
  const writeImpl = async ({ entry }) => ({ key: entry.key, fields: entry.key === sb.key ? { summary_line: good.summary_line, key_facts: { enforced_by: 'Attorney General' } } : {}, dropped: { 'thirty_seconds.a': 'misleading: x' }, reviewerModel: 'opus' });
  { const r = await runPageFieldsStep({ dataDir: dir, config: cfgOn, factory, touched: [sb.key], writeImpl, now: new Date('2026-11-12T10:00:00Z') });
    const e = loadData(dir).entries.find((x) => x.key === sb.key);
    ok('step: switch on writes the checked fields for the touched entry, with its checksum', r.status === 'written' && r.changed.includes(sb.key) && e.summary_line === good.summary_line && e.page_verification.basis_sha256 === basisOf(noPf) && r.dropped.length === 1, JSON.stringify(r).slice(0, 300));
    ok('step: at most max_entries_per_run entries a run', r.checked.length === 1);
    const after = loadData(dir), before = { ...after, entries: after.entries.map((x) => (x.key === sb.key ? noPf : x)) };
    ok('final check: page fields on an entry the step did not write are refused', checkPublish({ before, after, runDate: '2026-11-12', maxEntries: 15 }).problems.some((p) => /field summary_line changed/.test(p)));
    ok('final check: page fields the step wrote are allowed', !checkPublish({ before, after, runDate: '2026-11-12', maxEntries: 15, paged: [sb.key] }).problems.some((p) => /summary_line|key_facts|page_verification/.test(p)), checkPublish({ before, after, runDate: '2026-11-12', maxEntries: 15, paged: [sb.key] }).problems.join('; ').slice(0, 300));
    const bad = { ...after, entries: after.entries.map((x) => (x.key === sb.key ? { ...x, mechanism: x.mechanism + ' Extra.' } : x)) };
    ok('final check: the allowance covers page fields only, not the mechanism', checkPublish({ before, after: bad, runDate: '2026-11-12', maxEntries: 15, paged: [sb.key] }).problems.some((p) => /field mechanism changed/.test(p))); }
  { const stop = async ({ entry }) => ({ key: entry.key, fields: { summary_line: 'Requires the largest developers to act within 37 days.' }, dropped: {}, reviewerModel: 'opus' });
    fs.writeFileSync(path.join(dir, 'entries.json'), JSON.stringify(ents, null, 1));
    const r = await runPageFieldsStep({ dataDir: dir, config: cfgOn, factory, touched: [sb.key], writeImpl: stop });
    ok('step: a field that breaks the integrity rules stops the step and nothing is written', r.status === 'stopped' && !loadData(dir).entries.find((x) => x.key === sb.key).summary_line, JSON.stringify(r.problems).slice(0, 200)); }
  fs.rmSync(dir, { recursive: true, force: true });
  const { runPageFieldsSet, PAGEFIELDS_SET } = await import('../eval/pagefields-set.mjs');
  const set = JSON.parse(fs.readFileSync(PAGEFIELDS_SET, 'utf8')).cases, m = runPageFieldsSet({ cases: set });
  ok('measure: every reviewed draft passes and every planted fault is refused', m.wrong === 0 && m.errors === 0 && m.cases === set.length, JSON.stringify(m.failures));
  { const broken = set.map((c) => (c.kind === 'bad' && /summary:number/.test(c.id) ? { ...c, kind: 'good' } : c)); ok('measure: a planted fault treated as good is reported as an error (the measure can fail)', runPageFieldsSet({ cases: broken }).errors > 0); }
}

console.log(`pagefields: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
