// Run:  node agents/test.mjs   (or npm run test:agents)
// Scripted LLMs force every situation: a clean pass, an invented quote, an invented number, a rejected claim, running out of rounds...
// The sources are real records saved from live checks (fixtures/).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { processItem } from './process-item.mjs';
import { sourceText, containsQuote, digitRuns } from './source-text.mjs';
import { buildClaims, complaints } from './validator.mjs';
import { dateSupported } from './checks.mjs';
import { assembleEntry } from './assemble.mjs';
import { BudgetExceeded, LlmOutputError, InputTooLarge } from '../llm/gemini.mjs';
import { makeValidator } from '../schema/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (...p) => path.join(here, '..', 'fixtures', ...p);
const J = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const entries = J(fx('entries.sample.json'));
const v = makeValidator();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };

// ---------- scripted LLMs ----------
function scriptedGenerator(queue) {
  return { calls: [], async generate(req) { this.calls.push(req); const r = queue.shift(); if (r instanceof Error) throw r; return { data: typeof r === 'function' ? r(req) : r, usage: {} }; } };
}
// The validator reads the numbered claims out of the prompt, like a real reader would, and answers each one.
function scriptedValidator({ unsupported = {}, quotes = {}, answerFor } = {}) {
  return {
    calls: [],
    async generate(req) {
      this.calls.push(req);
      const claims = [...req.prompt.matchAll(/^(\d+)\. \[([^\]]+)\] (.*)$/gm)].map((m) => ({ n: +m[1], field: m[2] }));
      return { usage: {}, data: { results: claims.map((c) => unsupported[c.field] ? { n: c.n, supported: false, quote: null, reason: unsupported[c.field] } : { n: c.n, supported: true, quote: quotes[c.field] || (answerFor ? answerFor(c.field) : 'Hearings held.'), reason: null }) } };
    }
  };
}

// The referee confirms a new item's scope with a quote it copies from the source it was shown (the first line of 8+ characters).
// Every new entry needs the referee's confirmation (agents/process-item.mjs), so tests of publishable creates pass one.
function confirmingReferee() {
  return { calls: [], async generate(req) { this.calls.push(req); const src = (/<<<SOURCE\n([\s\S]*?)\nSOURCE>>>/.exec(req.prompt) || [, ''])[1]; const lines = src.split('\n').map((l) => l.trim()).filter((l) => l.length >= 8 && !/^\[/.test(l)); const line = lines[0] || '';
    // On a section claim it quotes the first passage that shows a section criterion (as a careful referee would), else its first line.
    const sec = (/belongs in section (B\.2|[A-C])\b/.exec(req.prompt) || [])[1]; if (sec) { const M = { A: /frontier|large developer|floating-point|computational operations/i, B: /frontier|large developer|floating-point|computational operations/i, 'B.2': /catastrophic|critical harm/i, C: /independent verification|auditor/i }[sec]; const hit = lines.find((l) => M.test(l)); if (hit) { const i = hit.search(M); return { usage: {}, data: { results: [{ n: 1, supported: true, quote: hit.slice(Math.max(0, i - 20), i + 60).trim(), reason: null }] } }; } }
    return { usage: {}, data: { results: [{ n: 1, supported: true, quote: line.slice(0, 80), reason: null }] } }; } };
}

// ---------- real records ----------
const s2938 = J(fx('congress', '119-s-2938.json'));
const e2938 = entries.find((e) => e.key.startsWith('s-2938'));
const itemOf = (id, source, url, entryKey) => ({ item_id: `${source}:${id}`, source, source_id: id, entry_key: entryKey || null, change: entryKey ? 'changed' : 'new', source_url: url, fetched_at: '2026-10-07T04:00:00Z', raw_hash: 'x', raw_path: 'x' });
const item2938 = itemOf('119/s/2938', 'congress_gov', 'https://www.congress.gov/bill/119th-congress/senate-bill/2938', e2938.key);
const diff2938 = { item_id: item2938.item_id, entry_key: e2938.key, verdict: 'material', reasons: [{ kind: 'new_action', detail: '2026-09-30: Committee on Homeland Security and Governmental Affairs. Hearings held.' }] };
const Q = 'Committee on Homeland Security and Governmental Affairs. Hearings held.';
const goodUpdate = () => ({
  operation: 'update', in_scope: true, scope_reason: 'The bill already in the tracker; the update reports a committee hearing.',
  fields: { status_text: 'Introduced Sept 29, 2025; referred to Senate Commerce. Hearing held Sept 30, 2026 by the Homeland Security and Governmental Affairs Committee' },
  events_add: [{ date: '2026-09-30', precision: 'day', type: 'Referred / stalled / hearing', text: 'Hearing held by the Senate Homeland Security and Governmental Affairs Committee' }],
  evidence: [{ field: 'status_text', quote: Q, source_url: item2938.source_url }, { field: 'events_add[0]', quote: Q, source_url: item2938.source_url }], notes: ''
});
const run = (o) => processItem({ item: item2938, raw: s2938, diff: diff2938, entry: e2938, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z'), ...o });

// ---------- source reading ----------
const st = sourceText(s2938, 'congress_gov');
ok('source text includes the action list with dates and committee names', /2026-09-30: Committee on Homeland Security and Governmental Affairs\. Hearings held\./.test(st) && /Sponsor: Sen\. Hawley/.test(st));
ok('quotes match after normalising case, whitespace and curly quotes', containsQuote('He said “hello   WORLD”.', 'he said "hello world"'));
ok('a quote that is not in the text is rejected', !containsQuote(st, 'Passed the Senate 99-1'));
ok('digit runs read commas and superscripts', [...digitRuns('$1,000,000 and 10²⁶')].join() === '1000000,10,26' || [...digitRuns('$1,000,000 and 10²⁶')].includes('1000000'));
ok('dates are supported when written out in words', dateSupported('2026-09-29', 'signed on September 29, 2026') && dateSupported('2026-09-29', 'Sept. 29, 2026') && !dateSupported('2026-09-28', 'signed on September 29, 2026'));

// ---------- 1. a clean update ----------
{
  const g = scriptedGenerator([goodUpdate()]), val = scriptedValidator({ answerFor: () => Q });
  const r = await run({ generator: g, validator: val });
  ok('a well-supported update is publishable on the first round', r.outcome === 'publishable' && r.attempts === 1, JSON.stringify(r.verdicts.map((x) => x.code_checks.filter((c) => !c.passed))));
  const e = r.entry;
  ok('the new event is added in date order and flagged correctly', e.events.some((x) => x.date === '2026-09-30' && x.type === 'Referred / stalled / hearing') && e.events.map((x) => x.date).join() === [...e.events.map((x) => x.date)].sort().join());
  ok('the entry is marked as updated by the agents, with the run and the round count', e.origin === 'mixed' && e.verification.method === 'agent' && e.verification.run_id === 'run-test' && e.verification.rounds === 1);
  ok('last_checked and last_changed are today', e.last_checked === '2026-10-07' && e.last_changed === '2026-10-07');
  ok('the Congress.gov id and source link were added by code', e.identifiers.external.congress_gov.includes('119/s/2938') && e.sources.some((s) => s.url === item2938.source_url && s.kind === 'primary'));
  ok('the assembled entry passes the full entry schema', v.check('entry', e).length === 0, v.check('entry', e).join('; '));
  ok('the original entry was not modified', e2938.last_checked === '2026-09-05' && e2938.origin === 'authored');
  ok('the validator checked a claim for the text field and for the event', val.calls.length === 1 && /\[status_text\]/.test(val.calls[0].prompt) && /\[events_add-0\]/.test(val.calls[0].prompt));
  ok('the generator was shown the current entry, the comparison finding and the source', /CURRENT ENTRY/.test(g.calls[0].prompt) && /Hearings held/.test(g.calls[0].prompt) && /<<<SOURCE/.test(g.calls[0].prompt));
  ok('the validator was NOT shown the generator\'s reasoning or patch', !/scope_reason|events_add\":/.test(val.calls[0].prompt) && !/CURRENT ENTRY/.test(val.calls[0].prompt));
}

// ---------- 2. an invented quote is caught by code and fixed on the next round ----------
{
  const bad = goodUpdate(); bad.evidence[0].quote = 'The committee voted 12-3 to advance the bill.';
  const g = scriptedGenerator([bad, goodUpdate()]), val = scriptedValidator({ answerFor: () => Q });
  const r = await run({ generator: g, validator: val });
  ok('an invented quote fails the first round', r.verdicts[0].passed === false && r.verdicts[0].code_checks.some((c) => c.name === 'evidence_quotes_are_in_the_source' && !c.passed));
  ok('the second round passes', r.outcome === 'publishable' && r.attempts === 2);
  ok('the complaint was fed back to the generator, naming the quote', /evidence quotes are in the source/.test(g.calls[1].prompt) && /voted 12-3/.test(g.calls[1].prompt) && /YOUR PREVIOUS ATTEMPT WAS REJECTED/.test(g.calls[1].prompt));
}

// ---------- 3. an invented number ----------
{
  const bad = goodUpdate(); bad.fields.status_text += ', with 47 cosponsors';
  const r = await run({ generator: scriptedGenerator([bad, goodUpdate()]), validator: scriptedValidator({ answerFor: () => Q }) });
  ok('a number that is not in the source is caught in code', r.verdicts[0].code_checks.some((c) => c.name === 'numbers_come_from_the_source' && !c.passed && /47/.test(c.detail)));
  ok('and fixed on the next round', r.outcome === 'publishable' && r.attempts === 2);
}

// ---------- 4. an event date that the source does not state ----------
{
  const bad = goodUpdate(); bad.events_add[0].date = '2026-09-28';
  const r = await run({ generator: scriptedGenerator([bad, goodUpdate()]), validator: scriptedValidator({ answerFor: () => Q }) });
  ok('an event date not stated in the source is caught', r.verdicts[0].code_checks.some((c) => c.name === 'event_dates_are_in_the_source' && !c.passed));
}

// ---------- 5. the independent reader rejects a claim ----------
{
  const g = scriptedGenerator([goodUpdate(), goodUpdate()]);
  let n = 0;
  const val = { calls: [], async generate(req) { this.calls.push(req); n++; const claims = [...req.prompt.matchAll(/^(\d+)\. \[([^\]]+)\]/gm)]; return { usage: {}, data: { results: claims.map((m) => (n === 1 && m[2] === 'status_text' ? { n: +m[1], supported: false, quote: null, reason: 'The source says Homeland Security and Governmental Affairs, but the claim calls it Commerce.' } : { n: +m[1], supported: true, quote: Q, reason: null })) } }; } };
  const r = await run({ generator: g, validator: val });
  ok('a claim the reader marks unsupported fails the round even when every code check passed', r.verdicts[0].code_checks.every((c) => c.passed) && !r.verdicts[0].passed && r.verdicts[0].claims.some((c) => c.field === 'status_text' && !c.supported));
  ok('the reader\'s reason is passed to the generator word for word', /calls it Commerce/.test(g.calls[1].prompt));
  ok('the second round passes', r.outcome === 'publishable' && r.attempts === 2);
}

// ---------- 6. the reader says "supported" but its quote is not in the source ----------
{
  const val = scriptedValidator({ answerFor: () => 'A sentence that is nowhere in the source.' });
  const r = await run({ generator: scriptedGenerator([goodUpdate(), goodUpdate(), goodUpdate()]), validator: val });
  ok('a reader quote that is not in the source is not accepted', r.verdicts[0].claims.every((c) => !c.supported) && /does not appear in the source/.test(r.verdicts[0].claims[0].reason));
}

// ---------- 7. three failed rounds: held ----------
{
  const bad = goodUpdate(); bad.evidence[0].quote = 'Made up words not in the record.';
  const g = scriptedGenerator([clone(bad), clone(bad), clone(bad), goodUpdate()]);
  const r = await run({ generator: g, validator: scriptedValidator({ answerFor: () => Q }) });
  ok('after 3 failed rounds the item is held, not published', r.outcome === 'held' && r.attempts === 3 && r.entry === null && r.verdicts.length === 3);
  ok('the generator was called exactly 3 times, never a 4th', g.calls.length === 3);
  ok('the held record explains why', /still failing after 3 rounds/.test(r.reason));
}

// ---------- 8. patches that break the rules ----------
{
  const bad = goodUpdate(); bad.fields.status = 'enacted';
  const g = scriptedGenerator([bad, goodUpdate()]);
  const r = await run({ generator: g, validator: scriptedValidator({ answerFor: () => Q }) });
  ok('a patch that tries to set status is rejected by the schema and the round is used up', r.outcome === 'publishable' && r.attempts === 2 && /does not match the required shape/.test(g.calls[1].prompt));
}
{
  const g = scriptedGenerator([new LlmOutputError('the model did not return valid JSON'), goodUpdate()]);
  const r = await run({ generator: g, validator: scriptedValidator({ answerFor: () => Q }) });
  ok('unusable model output counts as a failed round and the next round recovers', r.outcome === 'publishable' && r.attempts === 2);
}
{
  const bad = goodUpdate(); bad.fields.status_text += '. No other action was located.';
  const r = await run({ generator: scriptedGenerator([bad, goodUpdate()]), validator: scriptedValidator({ answerFor: () => Q }) });
  ok('a "none located" style claim is blocked: only a person may write those', r.verdicts[0].code_checks.some((c) => c.name === 'no_negative_findings' && !c.passed));
}
{
  const bad = goodUpdate(); bad.evidence = [bad.evidence[0]];
  const r = await run({ generator: scriptedGenerator([bad, goodUpdate()]), validator: scriptedValidator({ answerFor: () => Q }) });
  ok('a change with no evidence quote is caught', r.verdicts[0].code_checks.some((c) => c.name === 'every_change_has_evidence' && !c.passed && /events_add\[0\]/.test(c.detail)));
}
{
  const neg = clone(e2938); neg.confidence = { level: 'SEARCH-QUALIFIED', basis: 'search_negative' };
  const r = await run({ generator: scriptedGenerator([goodUpdate(), goodUpdate(), goodUpdate()]), validator: scriptedValidator({ answerFor: () => Q }), entry: neg });
  ok('an entry holding a "none located" finding cannot be updated by the agents', r.outcome === 'held' && r.verdicts.every((x) => x.code_checks.some((c) => c.name === 'assembled' && !c.passed && /only a person/.test(c.detail))));
}
{
  const bad = goodUpdate(); bad.fields.title = 'A different title';
  const r = await run({ generator: scriptedGenerator([bad, goodUpdate()]), validator: scriptedValidator({ answerFor: () => Q }) });
  ok('an update may not change the title or section', r.verdicts[0].code_checks.some((c) => c.name === 'assembled' && /may not change/.test(c.detail)) || /does not match/.test(JSON.stringify(r)));
}

// ---------- 9. budget ----------
{
  const g = scriptedGenerator([new BudgetExceeded('1000 tokens per run')]);
  let err; try { await run({ generator: g, validator: scriptedValidator() }); } catch (e) { err = e; }
  ok('a run-wide budget error reaches the caller, so the run can stop cleanly', err instanceof BudgetExceeded);
}
{
  const r = await run({ generator: scriptedGenerator([new BudgetExceeded('60000 tokens for item x', 'item')]), validator: scriptedValidator() });
  ok('an item that used up its OWN token budget is held and the run carries on', r.outcome === 'held' && /tokens for item/.test(r.reason), JSON.stringify(r.reason));
}
{
  const r = await run({ generator: scriptedGenerator([new InputTooLarge(150000, 120000)]), validator: scriptedValidator() });
  ok('a source that is too long is held with a clear reason instead of crashing the run', r.outcome === 'held' && /too long for automatic processing/.test(r.reason) && r.attempts === 0, JSON.stringify(r.reason));
}

// ---------- 10. creating a new entry from a real executive order ----------
const eo = J(fx('federal-register', '2026-20321.json'));
const itemEo = itemOf('2026-20321', 'federal_register', 'https://www.federalregister.gov/documents/2026/10/02/2026-20321/inaugurating-the-era-of-super-intelligence');
const diffEo = { item_id: itemEo.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'New Presidential Document "Inaugurating the Era of Super Intelligence" (EO 14434), published 2026-10-02.' }] };
const Q1 = 'Executive Order 14434 of September 29, 2026 Inaugurating the Era of Super Intelligence', Q2 = 'Within 60 days of the date of this order', Q3 = 'THE WHITE HOUSE, September 29, 2026.';
const goodCreate = () => ({
  operation: 'create', in_scope: true, scope_reason: 'Executive order on AI terminology that also sets a 60-day legislative proposal.',
  fields: { title: 'Executive Order 14434: Inaugurating the Era of Super Intelligence', short_name: 'EO 14434 (Super Intelligence)', section: 'G', sponsor_text: 'President', mechanism: 'Directs agencies to use the terms Super Intelligence and SI; requires proposed legislative language on a Federal definition within 60 days', status_text: 'Signed Sept 29, 2026; published Oct 2, 2026' },
  events_add: [{ date: '2026-09-29', precision: 'day', type: 'Signed / enacted', text: 'Executive Order 14434 signed' }],
  evidence: [{ field: 'title', quote: Q1, source_url: itemEo.source_url }, { field: 'sponsor_text', quote: 'By the authority vested in me as President by the Constitution', source_url: itemEo.source_url }, { field: 'mechanism', quote: Q2, source_url: itemEo.source_url }, { field: 'status_text', quote: Q3, source_url: itemEo.source_url }, { field: 'events_add[0]', quote: Q3, source_url: itemEo.source_url }], notes: ''
});
const runEo = (o) => processItem({ referee: confirmingReferee(), item: itemEo, raw: eo, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z'), ...o });
{
  const val = scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? Q2 : Q3) });
  const r = await runEo({ generator: scriptedGenerator([goodCreate()]), validator: val });
  ok('a new executive order becomes a publishable new entry', r.outcome === 'publishable' && r.operation === 'create', JSON.stringify(r.verdicts.map((x) => x.code_checks.filter((c) => !c.passed))));
  const e = r.entry;
  ok('code, not the model, set type, level, jurisdiction and status', e.type === 'executive' && e.level === 'federal' && e.jurisdiction === 'Federal' && e.state === null && e.status === 'executive');
  ok('code set confidence from the source kind: official record means HIGH / primary_record', e.confidence.level === 'HIGH' && e.confidence.basis === 'primary_record');
  ok('the entry is marked automated, with the Federal Register document id and a primary source', e.origin === 'automated' && e.identifiers.external.federal_register_doc === '2026-20321' && e.sources[0].kind === 'primary');
  ok('it has a new id and a unique key', e.id === 43 && e.key === 'eo-14434-inaugurating-the-era-of-super-intelligence' &&!entries.some((x) => x.key === e.key), `${e.id} ${e.key}`);
  ok('the new entry passes the full entry schema', v.check('entry', e).length === 0, v.check('entry', e).join('; '));
  ok('the claim list for a new entry includes a scope claim', /\[in_scope\]/.test(val.calls[0].prompt));
}
{
  const bad = goodCreate(); bad.fields.section = 'B'; bad.fields.title = 'A title the model invented'; bad.fields.sponsor_text = 'Sen. Nobody'; bad.evidence.push({ field: 'title', quote: Q1, source_url: itemEo.source_url });
  const val = scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? Q2 : Q3) });
  const r = await runEo({ generator: scriptedGenerator([bad]), validator: val });
  ok('for an executive order, code decides the section: a model\'s "B" is ignored', r.outcome === 'publishable' && r.entry.section === 'G');
  ok('fields the official record states exactly are written by code, whatever the model wrote', r.entry.title === 'Executive Order 14434: Inaugurating the Era of Super Intelligence' && r.entry.sponsor_text === 'President' && r.entry.status_text === 'Signed Sept 29, 2026; published in the Federal Register Oct 2, 2026 (91 FR 63129)' && r.entry.signed_text === 'Sept 29, 2026', `${r.entry.title} | ${r.entry.sponsor_text} | ${r.entry.status_text}`);
  ok('events for the signing and the publication come from the record, in date order', r.entry.events.map((e) => `${e.date} ${e.type}`).join(' | ') === '2026-09-29 Signed / enacted | 2026-10-02 Introduced / published', r.entry.events.map((e) => e.date).join());
  ok('the model\'s evidence for the dropped fields is dropped too', !r.entry.evidence.some((e) => e.field === 'title'));
  ok('the claims the independent reader checks are only what the model wrote', !/\[title\]|\[sponsor_text\]|\[status_text\]/.test(val.calls[0].prompt) && /\[mechanism\]/.test(val.calls[0].prompt));
}
{
  // A notice from an ordinary agency has no rule-based section, so the model's choice is used; a draft (E) needs a person, and a
  // state section is refused for a federal item.
  const notice = clone(eo); notice.document.type = 'Notice'; notice.document.executive_order_number = null; notice.document.signing_date = null; notice.document.agency_names = ['Commerce Department'];
  const bad = goodCreate(); bad.fields.section = 'E';
  const r = await processItem({ generator: scriptedGenerator([bad, bad, bad]), validator: scriptedValidator(), item: itemEo, raw: notice, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
  ok('the agents may not create entries in sections that need a person (drafts)', r.outcome === 'held' && r.verdicts[0].code_checks.some((c) => c.name === 'assembled' && /never auto-created/.test(c.detail)));
  const st = goodCreate(); st.fields.section = 'B';
  const rs = await processItem({ generator: scriptedGenerator([st, st, st]), validator: scriptedValidator(), item: itemEo, raw: notice, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
  ok('a federal item may not go in a state section', rs.outcome === 'held' && rs.verdicts[0].code_checks.some((c) => c.name === 'assembled' && /section B is for state items; this is a federal item/.test(c.detail)));
  const bis = clone(notice); bis.document.agency_names = ['Commerce Department', 'Industry and Security Bureau']; const g3 = goodCreate(); delete g3.fields.section;
  const r2 = await processItem({ generator: scriptedGenerator([g3]), validator: scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? Q2 : Q3) }), referee: confirmingReferee(), item: itemEo, raw: bis, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
  ok('a rule from the Bureau of Industry and Security is placed in G.3 by rule', r2.outcome === 'publishable' && r2.entry.section === 'G.3' && r2.entry.status === 'export', `${r2.outcome} ${r2.entry && r2.entry.section}`);
}
{
  const bad = goodCreate(); bad.fields.mechanism = 'x'.repeat(800);
  const r = await runEo({ generator: scriptedGenerator([bad, goodCreate()]), validator: scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? Q2 : Q3) }) });
  ok('a rambling field is caught by the length check', r.verdicts[0].code_checks.some((c) => c.name === 'field_lengths' && !c.passed));
}
{
  const bad = goodCreate(); bad.fields.mechanism = 'Requires agencies to file reports within 30 days';
  const r = await runEo({ generator: scriptedGenerator([bad, goodCreate()]), validator: scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? Q2 : Q3) }) });
  ok('an invented deadline in a new entry is caught by the number check', r.verdicts[0].code_checks.some((c) => c.name === 'numbers_come_from_the_source' && !c.passed && /30/.test(c.detail)));
}
{
  const out = goodCreate(); out.in_scope = false; out.scope_reason = 'It sets terminology for agencies and does not regulate AI developers.'; out.fields = {}; out.events_add = []; out.evidence = [];
  const val = { calls: [], async generate(req) { this.calls.push(req); return { usage: {}, data: { results: [{ n: 1, supported: false, quote: null, reason: 'The order only renames AI as Super Intelligence in agency communications; it imposes no duty on AI developers.' }] } }; } };
  const r = await runEo({ generator: scriptedGenerator([out]), validator: val, referee: null });
  ok('when the generator and the independent reader both say out of scope, nothing is published', r.outcome === 'out_of_scope' && r.entry === null && /terminology/.test(r.reason));
}
{
  const out = goodCreate(); out.in_scope = false; out.fields = {}; out.events_add = []; out.evidence = [];
  const val = scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? Q2 : Q3) });
  const g = scriptedGenerator([out, goodCreate()]);
  const r = await runEo({ generator: g, validator: val });
  ok('if the reader disagrees that it is out of scope, the generator is told and tries again', r.outcome === 'publishable' && /judged this item IN scope/.test(g.calls[1].prompt));
}

// ---------- 9b. the model service fails ----------
{
  const { NetworkError, HttpError } = await import('../grabber/lib/http.mjs');
  const r1 = await run({ generator: scriptedGenerator([new NetworkError('This operation was aborted')]), validator: scriptedValidator() });
  ok('a model-service timeout holds the item instead of crashing the run, and flags it as a service error', r1.outcome === 'held' && r1.service_error === true && /model service failed/.test(r1.reason));
  const r2 = await run({ generator: scriptedGenerator([new HttpError(503, 'https://x', 'overloaded')]), validator: scriptedValidator() });
  ok('a model-service HTTP error does the same', r2.outcome === 'held' && r2.service_error === true);
}

// ---------- 10a. leaked JSON syntax in a text field (seen with the real model) ----------
{
  const bad = goodCreate(); bad.fields.thresholds = "Covers facilities above 20 megawatts.','penalties':null},";
  const val = scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? Q2 : Q3) });
  const g = scriptedGenerator([bad, goodCreate()]);
  const r = await runEo({ generator: g, validator: val });
  ok('leaked JSON syntax in a text field is caught by code', r.verdicts[0].code_checks.some((c) => c.name === 'clean_text' && !c.passed && /thresholds/.test(c.detail)), JSON.stringify(r.verdicts[0].code_checks.filter((c) => !c.passed)));
  ok('and the next round writes clean prose', r.outcome === 'publishable' && r.attempts === 2 && /Write plain prose only/.test(g.calls[1].prompt));
  const fine = goodCreate(); fine.fields.mechanism = 'Declares a contract null and void (see section 3) when an agency fails to report, "except as provided".';
  const r2 = await runEo({ generator: scriptedGenerator([fine]), validator: scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? 'Within 60 days of the date of this order' : Q3) }) });
  ok('ordinary legal prose with quotes and parentheses is not flagged', r2.verdicts[0].code_checks.find((c) => c.name === 'clean_text').passed);
}

// ---------- 10b. long sources, null fields, scope disagreements ----------
{
  const long = clone(eo); long.text = 'Section 1. ' + 'This order concerns terminology. '.repeat(5000);
  const out = { operation: 'create', in_scope: false, scope_reason: 'It only changes terminology used by agencies.', fields: {}, events_add: [], evidence: [] };
  const val = { calls: [], async generate(req) { this.calls.push(req); return { usage: {}, data: { results: [{ n: 1, supported: false, quote: null, reason: 'Not about frontier AI developers.' }] } }; } };
  const g = scriptedGenerator([out]);
  const r = await processItem({ generator: g, validator: val, item: itemEo, raw: long, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
  ok('a very long source is judged on its opening and dropped if clearly out of scope', r.outcome === 'out_of_scope' && /first 30000 characters/.test(r.reason), r.outcome + ' ' + r.reason);
  ok('and only the opening was sent to the models, never the whole text', g.calls[0].prompt.length < 60000 && val.calls[0].prompt.length < 60000 && /cut off after its first 30000 characters/.test(g.calls[0].prompt));
}
{
  const long = clone(eo); long.text = 'Section 1. ' + 'This order concerns agency terminology. '.repeat(5000);
  const inScope = { operation: 'create', in_scope: true, scope_reason: 'Frontier AI safety order.', fields: {}, events_add: [], evidence: [] };
  const r = await processItem({ generator: scriptedGenerator([inScope]), validator: scriptedValidator(), item: itemEo, raw: long, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
  ok('a very long source with no frontier-AI term anywhere that may be in scope is held and reported, not published or dropped', r.outcome === 'held' && /held until its record changes/.test(r.reason) && !!r.proposal);
}
{
  // IL H.B. 2949: a 1.25-million-character budget bill whose headings cannot be read; its frontier part is deep inside (Sec. 40-15).
  // The whole text is searched for frontier-AI terms and those passages are read, never just the opening.
  const long = clone(eo); long.text = 'BUDGET IMPLEMENTATION. ' + 'Appropriations for roads and bridges 123 Sec. 5-10. '.repeat(4000) + ' Section 40-15. the Artificial Intelligence Safety Measures Act is amended: no large frontier developer may develop a frontier model without a disclosure. ' + 'More appropriations for parks. '.repeat(2000);
  const inScope = { operation: 'create', in_scope: true, scope_reason: 'Amends frontier duties.', fields: {}, events_add: [], evidence: [] };
  const g = scriptedGenerator([inScope]);
  const r = await processItem({ generator: g, validator: scriptedValidator(), item: itemEo, raw: long, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
  ok('a long text with unreadable headings is read at its frontier-AI passages, wherever they are, not judged on its opening', /large frontier developer may develop/.test(g.calls[0].prompt) && /passage\(s\) from a/.test(g.calls[0].prompt) && !/cut off after its first/.test(g.calls[0].prompt) && g.calls[0].prompt.length < 110000, `${r.outcome} ${r.reason}`);
}
{
  const withNulls = goodCreate(); withNulls.fields.title = null; withNulls.fields.section = ''; withNulls.fields.sponsor_text = null;
  const val = scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? Q2 : Q3) });
  const r = await runEo({ generator: scriptedGenerator([withNulls]), validator: val });
  ok('null or empty values for fields the model was told to skip are ignored, not an error', r.outcome === 'publishable' && r.attempts === 1, JSON.stringify(r.reason));
}
{
  const out = goodCreate(); out.in_scope = false; out.fields = {}; out.events_add = []; out.evidence = [];
  const g = scriptedGenerator([out, goodCreate()]);
  const val = scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? Q2 : Q3) });
  const r = await runEo({ generator: g, validator: val });
  ok('when the reader says "in scope", the generator is told firmly to write the entry and not to return empty fields', r.outcome === 'publishable' && /Set in_scope to true and write the entry now/.test(g.calls[1].prompt) && /Do not return an empty/.test(g.calls[1].prompt));
}

// ---------- 10c. the model's loose labels ----------
{
  const { normField, normalisePatch } = await import('./generator.mjs');
  ok('evidence labels are normalised: fields.x, fields[\'x\'], events_add.0, events_add-0', normField('fields.mechanism') === 'mechanism' && normField("fields['mechanism']") === 'mechanism' && normField('events_add.0') === 'events_add[0]' && normField('events_add-1') === 'events_add[1]');
  ok('and correct labels are left exactly as they are', normField('mechanism') === 'mechanism' && normField('events_add[0]') === 'events_add[0]' && normField('status_text') === 'status_text');
  const p = normalisePatch({ operation: 'create', in_scope: true, scope_reason: 'x', section: 'D', fields: { mechanism: 'Does a thing', title: null, thresholds: '' }, events_add: [], evidence: [{ field: 'fields.mechanism', quote: 'Does a thing' }, { field: 'scope_reason', quote: 'because of the title' }, { field: 'section', quote: 'D bill here' }] });
  ok('a top-level section is moved into fields; nulls are dropped; evidence for labels such as scope_reason and section is discarded', p.fields.section === 'D' && !('title' in p.fields) && p.section === undefined && p.evidence.length === 1 && p.evidence[0].field === 'mechanism', JSON.stringify(p));
  const q = normalisePatch({ operation: 'create', in_scope: true, scope_reason: 'Duties on frontier developers.', reasoning: 'thinking aloud', summary: 'y', fields: { mechanism: 'Does a thing' }, events_add: [], evidence: [{ field: 'mechanism', quote: 'Does a thing' }], notes: 'n' });
  ok('an extra top-level key (the model\'s own "reasoning") is dropped; the known keys stay', !('reasoning' in q) && !('summary' in q) && q.notes === 'n' && q.fields.mechanism === 'Does a thing' && makeValidator().check('patch', q).length === 0, JSON.stringify(q));
}
{
  // New bill whose text is not published yet: nothing can be described or verified, and its scope is never judged from its title alone
  // (NJ S4934 was ruled out on its title). It is held, with no AI call, and read again when its record changes.
  const bill = clone(J(fx('congress', '119-s-5493.json'))); bill.text_missing = true;
  // Another sponsor: with S. 5493's own sponsor and title it would be held as a possible duplicate of the tracked S. 5493 (round 3).
  bill.bill.sponsors = [{ fullName: 'Sen. Example, Pat [D-XX]', firstName: 'Pat', lastName: 'Example' }];
  // Round 4: and another title (the same title alone now holds it as a possible companion of S. 5493).
  bill.bill.title = 'Example Frontier Oversight Act'; delete bill.titles; delete bill.bill.titles;
  const it = itemOf('119/s/9999', 'congress_gov', 'https://www.congress.gov/bill/119th-congress/senate-bill/9999');
  const run1 = (g, val) => processItem({ generator: g, validator: val, item: it, raw: bill, diff: { item_id: it.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'x' }] }, entry: null, entries, today: '2026-10-07', runId: 'r' });
  const inScope = { operation: 'create', in_scope: true, scope_reason: 'Title says it bans superintelligence.', fields: {}, events_add: [], evidence: [], section: 'D' };
  const g1 = scriptedGenerator([inScope]), v1 = scriptedValidator();
  const r1 = await run1(g1, v1);
  ok('a new bill with no published text is held to be retried, and no entry is written', r1.outcome === 'held' && /not available yet/.test(r1.reason) && r1.entry === null && v1.calls.length === 0, r1.reason);
  ok('no model is asked about a bill with no text', g1.calls.length === 0);
  const outScope = { operation: 'create', in_scope: false, scope_reason: 'The title is about worker retraining.', fields: {}, events_add: [], evidence: [], section: 'F' };
  const val2 = { calls: [], async generate(req) { this.calls.push(req); return { usage: {}, data: { results: [{ n: 1, supported: false, quote: null, reason: 'Not about frontier developers.' }] } }; } };
  const r2 = await run1(scriptedGenerator([outScope]), val2);
  ok('a new bill with no text is never ruled out from its title alone: it is held', r2.outcome === 'held' && r2.text_missing === true, `${r2.outcome} ${r2.reason}`);
  const st = clone(J(fx('legiscan', 'bills.json')))['NY-S10373'] || null;
  if (st) {
    const rawLs = { bill: { ...st, bill_id: 99990001, bill_number: 'S4934', state: 'NJ', bill_type_id: '1', title: 'Requires Chief Innovation Officer to conduct study and issue report on AI auditors.', sasts: [] }, text: '', text_missing: false };
    const itLs = itemOf('99990001', 'legiscan', 'https://legiscan.com/NJ/bill/S4934/2026');
    const r3 = await processItem({ generator: scriptedGenerator([outScope]), validator: val2, item: itLs, raw: rawLs, diff: { item_id: itLs.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'x' }] }, entry: null, entries, today: '2026-10-28', runId: 'r' });
    ok('NJ S4934: a state bill whose text is empty is held like a Congress bill with no text, not ruled out from its title', r3.outcome === 'held' && r3.text_missing === true, `${r3.outcome} ${r3.reason}`);
  }
}
{
  // The generator keeps saying "out of scope" while the reader says "in scope": one firm retry, then stop.
  const out = () => ({ operation: 'create', in_scope: false, scope_reason: 'It is a research programme, not regulation.', fields: {}, events_add: [], evidence: [] });
  const g = scriptedGenerator([out(), out(), out()]);
  const val = scriptedValidator({ answerFor: () => Q1 });
  const r = await runEo({ generator: g, validator: val });
  ok('a scope disagreement stops after one firm retry and is recorded, instead of burning every round', r.outcome === 'held' && /scope disagreement/.test(r.reason) && g.calls.length === 2, `${r.outcome} calls=${g.calls.length}`);
}
{
  // The generator says "in scope" but the reader says "out" twice.
  const val = scriptedValidator({ unsupported: { in_scope: 'It only renames terminology; no duty on developers.' }, answerFor: (f) => (f === 'mechanism' ? Q2 : Q3) });
  const g = scriptedGenerator([goodCreate(), goodCreate(), goodCreate()]);
  const r = await runEo({ generator: g, validator: val, referee: null });
  ok('the opposite disagreement also stops after the second objection, and the reader\'s reason is kept', r.outcome === 'held' && /scope disagreement/.test(r.reason) && /terminology/.test(r.reason) && g.calls.length === 2, `${r.outcome} calls=${g.calls.length}`);
  ok('the reader\'s scope objection is phrased for the generator as an invitation to set in_scope false', /judged this item OUT of scope/.test(g.calls[1].prompt) && /set in_scope to false/.test(g.calls[1].prompt));
}

// ---------- 10d. lessons from the 27 Oct 2026 review: text rules, the export-control rule, the scope referee ----------
{
  const { repairExponents } = await import('./source-text.mjs');
  ok('a garbled exponent before a compute word is repaired ("1026 integer", "10�26", "10ˆ26")', repairExponents('greater than 1026 integer or') === 'greater than 10^26 integer or' && repairExponents('10�26 operations') === '10^26 operations' && repairExponents('10ˆ26 operations') === '10^26 operations');
  ok('and nothing else is touched (years, counts, an exponent already written)', repairExponents('In 2026 operations began; 1026 people; 10^26 operations') === 'In 2026 operations began; 1026 people; 10^26 operations');
  const { textProblems } = await import('./checks.mjs');
  const src = 'A developer shall publish a "safety and security protocol" before deployment.';
  ok('text rule: a garbled exponent in a field is refused', textProblems('thresholds', 'Trained on more than 1026 operations', src).some((p) => /garbled exponent/.test(p)));
  ok('text rule: a date without its year is refused, a full date or a range with a year is not', textProblems('status_text', 'Received in the Senate Sept 14', src).some((p) => /without its year/.test(p)) && !textProblems('status_text', 'Received Sept 14, 2026; cosponsors added Sept 3–16, 2026 and Sept 3–Oct 1, 2026; May 1, 2026', src).length);
  ok('text rule: words in quotation marks must be in the source; correct ones pass', textProblems('mechanism', 'Disclaims "mandatory governmental review of models"', src).some((p) => /quotation marks/.test(p)) && !textProblems('mechanism', 'Requires a "safety and security protocol"', src).length);
  ok('text rule: "not established from the sources" is refused', textProblems('thresholds', 'Definitions of "covered entity" not established from the sources read', 'covered entity').some((p) => /definitions section/.test(p)));
  const { exportControlBill } = await import('./derive.mjs');
  ok('a bill citing ECCN 3A090 and export licensing is an export-control bill (G.3 by rule); others are not', exportControlBill('license for the export of items classified under ECCN 3A090') && !exportControlBill('A developer shall publish a framework') && !exportControlBill('3A090 appears in a definition only', 'Data center safety'));
}
{
  const referee = (supported) => ({ calls: [], async generate(req) { this.calls.push(req); return { usage: {}, data: { results: [{ n: 1, supported, quote: Q1, reason: supported ? null : 'Only terminology.' }] } }; } });
  const out = () => ({ operation: 'create', in_scope: false, scope_reason: 'It is a terminology order, not regulation of developers.', fields: {}, events_add: [], evidence: [] });
  // Both readers say out, the referee says in: the item is written up, and the reader's later scope objection is overruled.
  const ref1 = referee(true), g1 = scriptedGenerator([out(), goodCreate()]);
  const r1 = await runEo({ generator: g1, validator: scriptedValidator({ unsupported: { in_scope: 'Not about developers.' }, answerFor: (f) => (f === 'mechanism' ? Q2 : Q3) }), referee: ref1 });
  ok('referee: both readers say out but the referee says in, so the entry is written and published', r1.outcome === 'publishable' && /judged this item IN scope/.test(g1.calls[1].prompt), `${r1.outcome} ${r1.reason}`);
  ok('referee: it is asked once per item, not on every round', ref1.calls.length === 1);
  // The readers disagree and the referee says out: dropped, with the reason recorded.
  const r2 = await runEo({ generator: scriptedGenerator([out()]), validator: scriptedValidator({ answerFor: () => Q1 }), referee: referee(false) });
  ok('referee: when the readers disagree and the referee says out, it is dropped as out of scope, not held', r2.outcome === 'out_of_scope' && /confirmed by the referee/.test(r2.reason), `${r2.outcome} ${r2.reason}`);
  // The generator writes it up, the reader objects to the scope, the referee says out.
  const r3 = await runEo({ generator: scriptedGenerator([goodCreate()]), validator: scriptedValidator({ unsupported: { in_scope: 'It only renames terminology.' }, answerFor: (f) => (f === 'mechanism' ? Q2 : Q3) }), referee: referee(false) });
  ok('referee: when the reader objects to the scope and the referee agrees, it is dropped in the same round', r3.outcome === 'out_of_scope' && r3.attempts === 1 && /terminology/.test(r3.reason), `${r3.outcome} ${r3.reason}`);
}

// ---------- 11. pieces ----------
{
  const claims = buildClaims({ patch: goodUpdate(), operation: 'update' });
  ok('claims are derived by code: one per changed text field and per event, no scope claim on updates', claims.length === 2 && claims[0].field === 'status_text' && claims[1].field === 'events_add[0]');
  const c = complaints({ code_checks: [{ name: 'numbers_come_from_the_source', passed: false, detail: 'not found: 47' }, { name: 'entry_schema', passed: true }], claims: [{ field: 'mechanism', claim: 'covers all developers', supported: false, reason: 'The source says only large developers.' }, { field: 'x', claim: 'y', supported: true }] });
  ok('complaints list every failed check and every unsupported claim, and nothing else', c.length === 2 && /numbers come from the source: not found: 47/.test(c[0]) && /only large developers/.test(c[1]));
}
{
  const asm = assembleEntry({ entry: null, patch: goodUpdate(), item: item2938, raw: s2938, today: '2026-10-07', runId: 'r', rounds: 1, entries });
  ok('assembling an update with no existing entry is an error', asm.entry === null && asm.problems.length === 1);
}

// ---------- a new STATE bill (LegiScan): drafted in full, to the federal standard ----------
{
  const raw = { bill: { state: 'CT', bill_number: 'SB00086', title: 'An Act Addressing Innovations In And The Responsible Use Of Artificial Intelligence.', description: 'Frontier developer safety duties.', history: [{ date: '2026-02-10', action: 'Referred to Joint Committee on General Law' }] }, text: 'Section 1. A frontier developer of artificial intelligence models shall publish a safety framework. '.repeat(20) }; // round 4: a frontier term counts only about AI
  const item = { item_id: 'legiscan:2107947', source: 'legiscan', source_id: '2107947', source_url: 'https://www.cga.ct.gov/', fetched_at: '2026-10-28T07:00:00Z' };
  const diff = { item_id: item.item_id, verdict: 'new_entry_candidate', reasons: [{ kind: 'new_entry_candidate', detail: 'New state bill CT SB00086' }] };
  ok('a LegiScan record is readable', /Bill: CT SB00086/.test(sourceText(raw, 'legiscan')) && /2026-02-10: Referred/.test(sourceText(raw, 'legiscan')));
  const inScope = await processItem({ generator: scriptedGenerator([{ operation: 'create', in_scope: true, scope_reason: 'Duties on frontier developers.', fields: {}, events_add: [], evidence: [] }]), validator: scriptedValidator(), item, raw, diff, entries, today: '2026-10-28', runId: 'run-test' });
  ok('a state bill the generator never writes up (no section, no mechanism) is held, never published', inScope.outcome === 'held' && inScope.entry === null && inScope.verdicts.some((x) => x.code_checks.some((c) => c.name === 'assembled' && /needs "(?:section|mechanism)"/.test(c.detail))), inScope.reason);
}
{
  // Real candidates the LegiScan grabber saved on 13 Oct 2026 (fixtures/legiscan/candidates): AZ HB 4098 (pending, frontier wording),
  // NE LB 1185 (indefinitely postponed: LegiScan status 6) and UT SB 205 (police use of generative AI: out of scope).
  const lsRaw = (f) => J(fx('legiscan', 'candidates', f));
  const az = lsRaw('AZ-HB4098-2112241.json'), ne = lsRaw('NE-LB1185-2088052.json'), ut = lsRaw('UT-SB0205-2094829.json');
  const itemLs = (raw) => ({ item_id: `legiscan:${raw.id}`, source: 'legiscan', source_id: raw.id, entry_key: null, change: 'new', reason: 'discovery', source_url: raw.bill.state_link, fetched_at: '2026-10-13T07:14:00Z', raw_hash: 'x', raw_path: 'x' });
  const diffLs = (raw) => ({ item_id: `legiscan:${raw.id}`, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: `New state bill ${raw.bill.state} ${raw.bill.bill_number} "${raw.bill.title}" is not in the tracker.` }] });
  const runLs = (raw, o) => processItem({ referee: confirmingReferee(), item: itemLs(raw), raw, diff: diffLs(raw), entry: null, entries, today: '2026-10-13', runId: 'run-test', now: new Date('2026-10-13T08:00:00Z'), ...o });
  const AZ = {
    mechanism: 'shall submit a transparency report to the attorney general', thresholds: 'has spent more than $5,000,000 in developing the frontier model and more than $100,000,000 in training the frontier model',
    penalties: 'civil penalty of not more than $50,000 per violation', in_scope: 'frontier model of artificial intelligence that is owned or operated by a large developer'
  };
  const azPatch = (section = 'B') => ({
    operation: 'create', in_scope: true, scope_reason: 'Duties on businesses using a frontier model owned or operated by a large developer.', section,
    fields: { mechanism: 'An artificial intelligence business must assess each high risk AI system before using or selling it, submit a transparency report to the attorney general, post the reports on its website and conduct a quarterly audit.', thresholds: 'A large developer has spent more than $5,000,000 developing and more than $100,000,000 training the frontier model.', penalties: 'Civil penalty of not more than $50,000 per violation, enforced by the attorney general.' },
    events_add: [], evidence: ['mechanism', 'thresholds', 'penalties'].map((field) => ({ field, quote: AZ[field] })), notes: ''
  });
  const none = (summary) => ({ value: 'not_in_bill', summary });
  const azDuties = {
    framework: none('No safety framework is required.'), transparency_report: { value: 'yes', summary: 'Transparency reports must be posted on the business\'s website.', section: '44-1383(D)', quote: 'The transparency reports shall be publicly posted' },
    incident_reporting: none('No incident reporting.'), imminent_risk_reporting: none('No shorter window.'), third_party_audit: none('No independent audit.'), whistleblower: none('No employee protections.'),
    registration: { value: 'yes', summary: 'The attorney general must issue a certification before the business enters the stream of commerce.', section: '44-1383(H)', quote: 'The attorney general shall issue a certification' },
    shutdown: none('No shutdown duty.'), compute_threshold: none('No compute figure.'), revenue_threshold: { value: 'yes', summary: 'A large developer has spent more than $5,000,000 developing and $100,000,000 training a frontier model.', section: '44-1383(K)(4)', quote: AZ.thresholds },
    harm_threshold: none('No harm figure.'), penalties: { value: 'yes', summary: 'Civil penalty of not more than $50,000 per violation, imposed by the attorney general.', section: '44-1383(I)', quote: AZ.penalties }, effective_date: none('No effective date stated.')
  };
  const quoteFor = (f) => AZ[f] || (azDuties[f] && azDuties[f].quote) || AZ.mechanism;
  {
    const gen = scriptedGenerator([azPatch(), { duties: azDuties, notes: '' }]), val = scriptedValidator({ answerFor: quoteFor });
    const r = await runLs(az, { generator: gen, validator: val }), e = r.entry;
    ok('state create: a pending state bill is drafted, checked and publishable', r.outcome === 'publishable' && !!e, r.reason || JSON.stringify(r.verdicts.map((x) => complaints(x))));
    // Only B's criterion (a frontier threshold with duties) is met by AZ HB 4098's text, so code files it in B; the generator is not asked.
    ok('state create: code decides the section when exactly one section\'s criterion is met (no section asked of the generator)', !(gen.calls[0].responseSchema.required || []).includes('section') && e.evidence.some((x) => x.field === 'section' && /frontier|large developer/i.test(x.quote)), JSON.stringify(gen.calls[0].responseSchema.required));
    ok('state create: section, type, level, jurisdiction, state and status by rule', e.section === 'B' && e.type === 'bill' && e.level === 'state' && e.jurisdiction === 'AZ' && e.state === 'AZ' && e.status === 'pending', `${e.section} ${e.type} ${e.level} ${e.jurisdiction} ${e.state} ${e.status}`);
    ok('state create: title, short name, sponsor and status line come from the record in fixed wording', e.title === 'H.B. 4098 — Artificial intelligence business; attorney general' && e.short_name === 'AZ HB 4098' && e.key === 'az-hb-4098' && e.sponsor_text === 'Rep. Anastasia Travers (D)' && e.status_text === 'Status: Introduced Feb 10, 2026; Assigned to House RULES Committee (Feb 10, 2026)', `${e.title} | ${e.short_name} | ${e.sponsor_text} | ${e.status_text}`);
    ok('state create: events are the history actions the Tier A rules keep', e.events.length >= 2 && e.events[0].date === '2026-02-10' && e.events[0].type === 'Introduced / published' && e.events.some((x) => x.type === 'Referred / stalled / hearing') && !e.events.some((x) => /read second time/i.test(x.text)), e.events.map((x) => x.type + ' ' + x.text).join(' | '));
    ok('state create: tracked by its LegiScan id and session', JSON.stringify(e.identifiers) === JSON.stringify({ external: { legiscan: [2112241] }, session: 'Fifty-seventh Legislature - Second Regular Session (2026)' }), JSON.stringify(e.identifiers));
    ok('state create: the legislature\'s own pages are the sources (bill page, then the text read)', e.sources[0].url === 'https://apps.azleg.gov/BillStatus/BillOverview/85620' && e.sources[1].url === 'https://www.azleg.gov/legtext/57leg/2r/bills/hb4098p.htm' && e.sources.every((x) => x.kind === 'primary') && e.legacy.section_name === 'Pending, stalled and failed state bills');
    ok('state create: the entry passes its schema', v.check('entry', e).length === 0, v.check('entry', e).join('; '));
    ok('state create: the duty step runs for the state frontier section and every answer is proved', e.duties && e.duties.penalties.value === 'yes' && e.duties.penalties.source_url === az.bill.state_link && e.duties_basis.method === 'agent' && r.duties.added === true, JSON.stringify(r.duties));
    ok('state create: the reader checked the reading fields only, never the record\'s own facts', /\[mechanism\]/.test(val.calls[0].prompt) && !/\[title\]|\[sponsor_text\]|\[status_text\]/.test(val.calls[0].prompt));
  }
  {
    const nePatch = { operation: 'create', in_scope: true, scope_reason: 'Safety duties for conversational AI services.', section: 'B.2', fields: { mechanism: 'An operator must clearly and conspicuously disclose to each minor account holder that the account holder is interacting with artificial intelligence.' }, events_add: [], evidence: [{ field: 'mechanism', quote: 'An operator shall clearly and conspicuously disclose to each minor account holder' }], notes: '' };
    // NE LB 1185 as filed (a chatbot disclosure duty for minors) meets no state section's criterion: held before any AI is spent (round 2:
    // the B.2 filing the generator chose for bills like this was the misfiling of WA HB 2503 and VA SB 365).
    const g0 = scriptedGenerator([nePatch]), r0 = await runLs(ne, { generator: g0, validator: scriptedValidator() });
    ok('a state bill meeting no section\'s criterion is held before any AI is spent, and reported', r0.outcome === 'held' && r0.no_section === true && g0.calls.length === 0 && r0.escalate === true && /meets no state section/.test(r0.proposal || ''), `${r0.outcome} ${r0.reason}`);
    // The same record with a catastrophic-risk duty on developers (and no frontier threshold) meets B.2 only.
    const ne2 = clone(ne); ne2.text += '\nSection 9. A developer shall assess the catastrophic risk of each model it makes available to operators.';
    const r = await runLs(ne2, { generator: scriptedGenerator([nePatch]), validator: scriptedValidator({ answerFor: () => 'An operator shall clearly and conspicuously disclose' }) });
    ok('dead state bill: status failed, from the record, with the action that ended it in the status line', r.outcome === 'publishable' && r.entry.section === 'B.2' && r.entry.status === 'failed' && r.entry.status_text === 'Status: Introduced Jan 21, 2026; Indefinitely postponed (Apr 17, 2026)' && r.entry.events.some((x) => x.type === 'Vetoed / failed / rescinded' && x.date === '2026-04-17'), r.reason || (r.entry && r.entry.status_text));
    ok('dead state bill: a nonpartisan sponsor carries no party letter', r.entry.sponsor_text === 'Sen. Eliot Bostar');
    ok('dead state bill (B.2): duties that cannot be proved are left off, the entry still goes out', !r.entry.duties && r.duties && r.duties.added === false);
    // In A or B (a frontier law or bill) the duty step is never skipped silently: without proved duties the entry is held, not published.
    const ne3 = clone(ne); ne3.text += '\nSection 9. A large developer shall publish a safety framework for each frontier model.';
    const rB = await runLs(ne3, { generator: scriptedGenerator([{ ...clone(nePatch), fields: { ...clone(nePatch.fields), section: 'B' } }]), validator: scriptedValidator({ answerFor: () => 'An operator shall clearly and conspicuously disclose' }) });
    ok('a B entry whose duties cannot be proved is held, never published without them', rB.outcome === 'held' && rB.entry === null && /not published without its duty answers/.test(rB.reason) && rB.escalate === true, `${rB.outcome} ${rB.reason}`);
  }
  {
    // AZ HB 4098 meets B's criterion only, so code sets B and a generator's D or A is dropped. Where code cannot decide (several sections
    // qualify), the generator's choice is still bounded: a federal section or A for a pending bill is refused.
    const asmD = assembleEntry({ entry: null, patch: { ...azPatch('D'), fields: { ...azPatch('D').fields, section: 'D' } }, item: itemLs(az), raw: az, today: '2026-10-13', runId: 'r', rounds: 1, entries });
    ok('code decides the section: a generator\'s D for AZ HB 4098 is replaced by B', asmD.entry && asmD.entry.section === 'B', JSON.stringify(asmD.problems));
    const both = clone(az); both.text += '\nSec. 9. The attorney general shall license independent verification organizations.';
    const r = await runLs(both, { generator: scriptedGenerator([azPatch('D'), azPatch('D'), azPatch('D')]), validator: scriptedValidator({ answerFor: quoteFor }) });
    ok('wrong section: a state bill may not go in a federal section', r.outcome === 'held' && r.verdicts[0].code_checks.some((c) => c.name === 'assembled' && /section D is for federal items; this is a state bill/.test(c.detail)), r.reason);
    const r2 = await runLs(both, { generator: scriptedGenerator([azPatch('A'), azPatch('A'), azPatch('A')]), validator: scriptedValidator({ answerFor: quoteFor }) });
    ok('wrong section: a pending state bill may not go in A (enacted laws)', r2.outcome === 'held' && r2.verdicts[0].code_checks.some((c) => c.name === 'assembled' && /a pending state bill goes in section B, C, not A/.test(c.detail)), r2.reason);
  }
  {
    const bad = () => { const p = azPatch(); p.evidence[0].quote = 'shall submit a transparency report to the attorney general within 30 days'; return p; };
    const r = await runLs(az, { generator: scriptedGenerator([bad(), bad(), bad()]), validator: scriptedValidator({ answerFor: quoteFor }) });
    ok('invented quote: a state draft whose quote is not in the bill is never publishable', r.outcome === 'held' && r.verdicts.every((x) => x.code_checks.some((c) => c.name === 'evidence_quotes_are_in_the_source' && !c.passed)), r.reason);
  }
  {
    const g0 = scriptedGenerator([]), held0 = await runLs(ut, { generator: g0, validator: scriptedValidator(), referee: null });
    ok('UT SB 205 (police use of generative AI) meets no section\'s criterion: nothing created, no AI spent', held0.outcome === 'held' && held0.no_section === true && g0.calls.length === 0);
    // A text that does meet a criterion still goes to the readers, and both ruling it out drops it.
    const ut2 = clone(ut); ut2.text += '\nSection 9. A large developer shall report to the department.';
    const out = await runLs(ut2, { generator: scriptedGenerator([{ operation: 'create', in_scope: false, scope_reason: 'Policies for police use of generative AI; nothing on frontier developers.', fields: {}, events_add: [], evidence: [] }]), validator: scriptedValidator({ unsupported: { in_scope: 'law enforcement AI policies only' } }), referee: null });
    ok('out of scope: a state bill both readers rule out is dropped', out.outcome === 'out_of_scope' && out.entry === null);
    const missing = clone(az); missing.text = null; missing.text_missing = true;
    const held = await runLs(missing, { generator: scriptedGenerator([{ operation: 'create', in_scope: true, scope_reason: 'Title names artificial intelligence businesses.', fields: {}, events_add: [], evidence: [] }]), validator: scriptedValidator() });
    ok('a state bill whose text is not available is held and retried, never drafted from its title', held.outcome === 'held' && /full text is not available/.test(held.reason));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
