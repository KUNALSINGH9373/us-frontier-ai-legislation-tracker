// Run:  node news/test-press.mjs   (or npm test). The press step with a scripted reviewer, its code checks, the final check's allowance
// and the press measure. No network.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkPress, addPress, runPressStep, outletOf, hostOk, PRESS_MAX } from './press.mjs';
import { checkPublish } from '../publish/guards.mjs';
import { loadData } from '../publish/run.mjs';
import { pressProblems } from '../schema/integrity.mjs';
import { runPressSet, PRESS_SET } from '../eval/press-set.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const today = '2026-11-12';
const lead = { title: 'Newsom’s AI safety law faces its first test', publisher: 'Politico', link: 'https://www.politico.com/news/2026/11/10/ai-safety-law-test', date: '2026-11-10', primary: false, tracker: 'ca-sb-53-tfaia' };

ok('outlets: the publisher names map to the five outlets; Reuters and AP are not among them', outletOf('POLITICO') === 'Politico' && outletOf('The New York Times') === 'The New York Times' && !outletOf('Reuters') && !outletOf('AP'));
ok('outlets: a link must be https on the outlet\'s own site', hostOk('Politico', 'https://rss.politico.com/x') && !hostOk('Politico', 'https://politico.com.evil.example/x') && !hostOk('Politico', 'http://www.politico.com/x'));
ok('code: a clean candidate passes', checkPress({ lead, entry: { key: 'k' }, today }).length === 0);
ok('code: a future date and an old one are refused', checkPress({ lead: { ...lead, date: '2026-11-20' }, entry: { key: 'k' }, today }).length && checkPress({ lead: { ...lead, date: '2026-10-01' }, entry: { key: 'k' }, today }).length);
ok('list: newest first, no duplicate link, at most five', (() => { let l = []; for (let i = 1; i <= 7; i++) l = addPress(l, { headline: 'h' + i, outlet: 'CNN', date: `2026-11-0${i}`, url: 'https://www.cnn.com/' + i }); l = addPress(l, { headline: 'again', outlet: 'CNN', date: '2026-11-07', url: 'https://www.cnn.com/7' }); return l.length === PRESS_MAX && l[0].date === '2026-11-07' && new Set(l.map((x) => x.url)).size === l.length; })());
ok('integrity: a press link off its outlet\'s site is refused', pressProblems({ key: 'k', press: [{ headline: 'x'.repeat(20), outlet: 'CNN', date: '2026-11-10', url: 'https://www.politico.com/x', checked_at: '2026-11-10T00:00:00Z' }] }).length === 1);

// the step on a scratch copy of the data
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'press-'));
['entries', 'news', 'relationships', 'site', 'changes'].forEach((f) => { const s = new URL(`../../web/data/v2/${f}.json`, import.meta.url); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dir, f + '.json')); });
const keep = async () => ({ keep: true, about: 'yes', misleading: 'no', why: 'about it' }), refuse = async () => ({ keep: false, about: 'yes', misleading: 'yes', why: 'calls a pending bill law' });
let calls = 0;
const factory = { make: () => ({ model: 'opus', generate: async () => { calls++; return { data: {} }; } }) };
{ const r = await runPressStep({ dataDir: dir, config: { auto_publish: { press: false } }, factory, leads: [lead], today }); ok('step: switch off spends no AI and writes nothing', !r.ran && calls === 0 && r.candidates === 1); }
{ const r = await runPressStep({ dataDir: dir, config: { auto_publish: { press: true } }, factory, leads: [lead, { ...lead, publisher: 'Some Blog' }, { ...lead, primary: true }, { ...lead, tracker: null }], today, verify: refuse });
  ok('step: only press leads matched to one entry from an allowed outlet are candidates; a reviewer refusal adds nothing', r.candidates === 1 && r.added.length === 0 && r.refused.length === 1 && r.status === 'unchanged'); }
{ const before = loadData(dir);
  const r = await runPressStep({ dataDir: dir, config: { auto_publish: { press: true } }, factory, leads: [lead], today, verify: keep, now: new Date('2026-11-12T10:00:00Z') });
  const after = loadData(dir), e = after.entries.find((x) => x.key === 'ca-sb-53-tfaia');
  ok('step: a kept story is added to the entry\'s press list (headline, outlet, date, link only)', r.status === 'written' && e.press && e.press[0].url === lead.link && e.press[0].outlet === 'Politico' && Object.keys(e.press[0]).sort().join() === 'checked_at,date,headline,outlet,url');
  ok('step: nothing else on the entry changes', JSON.stringify({ ...e, press: undefined }) === JSON.stringify({ ...before.entries.find((x) => x.key === 'ca-sb-53-tfaia'), press: undefined }));
  ok('final check: a press list the step did not add is refused', checkPublish({ before, after, runDate: today, maxEntries: 15 }).problems.some((p) => /field press changed/.test(p)));
  ok('final check: the press list the step added is allowed, and nothing else', !checkPublish({ before, after, runDate: today, maxEntries: 15, pressed: ['ca-sb-53-tfaia'] }).problems.length && checkPublish({ before, after: { ...after, entries: after.entries.map((x) => (x.key === 'ca-sb-53-tfaia' ? { ...x, status: 'failed' } : x)) }, runDate: today, maxEntries: 15, pressed: ['ca-sb-53-tfaia'] }).problems.length > 0);
  const again = await runPressStep({ dataDir: dir, config: { auto_publish: { press: true } }, factory, leads: [lead], today, verify: keep });
  ok('step: the same story is not added twice', again.added.length === 0 && /already listed/.test((again.refused[0] || {}).why || '')); }
fs.rmSync(dir, { recursive: true, force: true });

const set = JSON.parse(fs.readFileSync(PRESS_SET, 'utf8')).cases, m = runPressSet({ cases: set });
ok('measure: every planted fault refused and every recorded reviewer answer right', m.wrong === 0 && m.cases === set.length, JSON.stringify(m.failures));
ok('measure: it can fail (a fault marked keep is reported)', runPressSet({ cases: set.map((c) => (c.id === 'code:future-date' ? { ...c, expect: 'keep' } : c)) }).wrong === 1);

console.log(`press: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
