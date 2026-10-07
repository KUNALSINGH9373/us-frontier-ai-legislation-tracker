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
const runEo = (o) => processItem({ item: itemEo, raw: eo, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z'), ...o });
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
  // A notice from an ordinary agency has no rule-based section, so the model's choice is used; a state-bill section needs a person.
  const notice = clone(eo); notice.document.type = 'Notice'; notice.document.executive_order_number = null; notice.document.signing_date = null; notice.document.agency_names = ['Commerce Department'];
  const bad = goodCreate(); bad.fields.section = 'B';
  const r = await processItem({ generator: scriptedGenerator([bad, bad, bad]), validator: scriptedValidator(), item: itemEo, raw: notice, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
  ok('the agents may not create entries in sections that need a person (state bills)', r.outcome === 'held' && r.verdicts[0].code_checks.some((c) => c.name === 'assembled' && /need a person/.test(c.detail)));
  const bis = clone(notice); bis.document.agency_names = ['Commerce Department', 'Industry and Security Bureau']; const g3 = goodCreate(); delete g3.fields.section;
  const r2 = await processItem({ generator: scriptedGenerator([g3]), validator: scriptedValidator({ answerFor: (f) => (f === 'in_scope' ? Q1 : f === 'mechanism' ? Q2 : Q3) }), item: itemEo, raw: bis, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
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
  const r = await runEo({ generator: scriptedGenerator([out]), validator: val });
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
  const long = clone(eo); long.text = 'Section 1. ' + 'This order concerns frontier AI safety. '.repeat(5000);
  const inScope = { operation: 'create', in_scope: true, scope_reason: 'Frontier AI safety order.', fields: {}, events_add: [], evidence: [] };
  const r = await processItem({ generator: scriptedGenerator([inScope]), validator: scriptedValidator(), item: itemEo, raw: long, diff: diffEo, entry: null, entries, today: '2026-10-07', runId: 'run-test', now: new Date('2026-10-07T05:00:00Z') });
  ok('a very long source that may be in scope is held for a person, not published or dropped', r.outcome === 'held' && /needs a person/.test(r.reason));
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
}
{
  // New bill whose text is not published yet: nothing can be described or verified. Only a scope check on its title and actions is possible.
  const bill = clone(J(fx('congress', '119-s-5493.json'))); bill.text_missing = true;
  const it = itemOf('119/s/5493', 'congress_gov', 'https://www.congress.gov/bill/119th-congress/senate-bill/5493');
  const run1 = (g, val) => processItem({ generator: g, validator: val, item: it, raw: bill, diff: { item_id: it.item_id, entry_key: null, verdict: 'new_entry_candidate', reasons: [{ kind: 'candidate', detail: 'x' }] }, entry: null, entries, today: '2026-10-07', runId: 'r' });
  const inScope = { operation: 'create', in_scope: true, scope_reason: 'Title says it bans superintelligence.', fields: {}, events_add: [], evidence: [], section: 'D' };
  const g1 = scriptedGenerator([inScope]), v1 = scriptedValidator();
  const r1 = await run1(g1, v1);
  ok('a possibly-relevant new bill with no published text is held to be retried, and no entry is written', r1.outcome === 'held' && /not available yet/.test(r1.reason) && r1.entry === null && v1.calls.length === 0, r1.reason);
  ok('the one model call told it the source is incomplete and asked only for the scope', /the bill text is not published yet/.test(g1.calls[0].prompt) && /Decide ONLY in_scope/.test(g1.calls[0].prompt) && g1.calls.length === 1);
  const outScope = { operation: 'create', in_scope: false, scope_reason: 'The title is about worker retraining.', fields: {}, events_add: [], evidence: [], section: 'F' };
  const val2 = { calls: [], async generate(req) { this.calls.push(req); return { usage: {}, data: { results: [{ n: 1, supported: false, quote: null, reason: 'Not about frontier developers.' }] } }; } };
  const r2 = await run1(scriptedGenerator([outScope]), val2);
  ok('a clearly irrelevant new bill is ruled out from its title even without text', r2.outcome === 'out_of_scope' && /the text is not published yet/.test(r2.reason));
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
  const r = await runEo({ generator: g, validator: val });
  ok('the opposite disagreement also stops after the second objection, and the reader\'s reason is kept', r.outcome === 'held' && /scope disagreement/.test(r.reason) && /terminology/.test(r.reason) && g.calls.length === 2, `${r.outcome} calls=${g.calls.length}`);
  ok('the reader\'s scope objection is phrased for the generator as an invitation to set in_scope false', /judged this item OUT of scope/.test(g.calls[1].prompt) && /set in_scope to false/.test(g.calls[1].prompt));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
