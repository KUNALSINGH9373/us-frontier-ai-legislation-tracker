// Run:  node grabber/test-federal-register.mjs   (or npm run test:fr)
// A fake Federal Register server, shaped like the real one (including the HTML-wrapped "plain text"), proves the Grabber.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runFederalRegister } from './run-federal-register.mjs';
import { createHttp, HttpError } from './lib/http.mjs';
import { htmlToText, watchPhrases } from './sources/federal-register.mjs';
import { emptyState } from './lib/state.mjs';
import { makeValidator } from '../schema/validate.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fr-'));
const NOW = new Date('2026-10-07T12:00:00Z');
const scope = { title_terms: ['artificial intelligence', '\\bAI\\b', 'super intelligence'], max_candidates_per_run: 40, federal_register: { terms: ['artificial intelligence', 'super intelligence'], max_candidates_per_run: 40 } };

const doc = (n, title, date, extra = {}) => ({ document_number: n, title, type: 'Notice', publication_date: date, html_url: `https://www.federalregister.gov/documents/${n}`, abstract: null, agency_names: ['Some Agency'], executive_order_number: null, signing_date: null, effective_on: null, citation: null, raw_text_url: `https://www.federalregister.gov/documents/full_text/text/${n}.html`, text: 'Body of the document.', ...extra });

function fakeServer({ docs, failures = {}, textStatus = {}, log = [] }) {
  const sleeps = [];
  const resp = (status, body, text) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (text !== undefined ? text : JSON.stringify(body)) });
  const fetchImpl = async (url) => {
    log.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/documents.json')) {
      const f = failures.search; if (f && f.times > 0) { f.times--; return resp(f.status, {}); }
      const term = (u.searchParams.get('conditions[term]') || '').replace(/^"|"$/g, '').toLowerCase();
      const gte = u.searchParams.get('conditions[publication_date][gte]'), lte = u.searchParams.get('conditions[publication_date][lte]');
      const page = +u.searchParams.get('page') || 1, per = +u.searchParams.get('per_page') || 20;
      const hit = docs.filter((d) => d.publication_date >= gte && d.publication_date <= lte && `${d.title} ${d.abstract || ''} ${d.text}`.toLowerCase().includes(term))
        .sort((a, b) => a.publication_date.localeCompare(b.publication_date) || a.document_number.localeCompare(b.document_number));
      const results = hit.slice((page - 1) * per, page * per).map(({ text, ...d }) => d);
      return resp(200, { count: hit.length, total_pages: Math.max(1, Math.ceil(hit.length / per)), results });
    }
    const m = /\/full_text\/text\/(.+)\.html$/.exec(u.pathname);
    if (m) {
      if (textStatus[m[1]]) return resp(textStatus[m[1]], {}, 'gone');
      const d = docs.find((x) => x.document_number === m[1]);
      return resp(200, {}, `<html><head><title>FR</title></head><body><pre>[Presidential Documents]\n${d.title}\n${d.text.replace(/&/g, '&amp;')}</pre></body></html>`);
    }
    const one = /\/documents\/([^/]+)\.json$/.exec(u.pathname);
    if (one) { const d = docs.find((x) => x.document_number === one[1]); return d ? resp(200, (({ text, ...r }) => r)(d)) : resp(404, {}); }
    return resp(404, {});
  };
  return { fetchImpl, sleeps, sleep: async (ms) => { sleeps.push(ms); }, log };
}
const mk = (srv, extra = {}) => createHttp({ fetchImpl: srv.fetchImpl, sleep: srv.sleep, ...extra });
const trackedEo = { key: 'eo-14365-state-law-framework', section: 'G', title: 'Executive Order 14365: Ensuring a National Policy Framework for Artificial Intelligence', short_name: 'EO 14365 (state-law framework)' };
const baseDocs = () => [
  doc('2026-30001', 'Ensuring a National Policy Framework for Artificial Intelligence', '2026-09-30', { type: 'Presidential Document', executive_order_number: '14365', abstract: null, text: 'Executive Order 14365. This order addresses artificial intelligence.' }),
  doc('2026-30002', 'Inaugurating the Era of Super Intelligence', '2026-10-02', { type: 'Presidential Document', abstract: null, text: 'Executive Order 14434. Artificial intelligence & super intelligence leadership.' }),
  doc('2026-30003', 'Investment Adviser Compensation Modernization', '2026-10-06', { type: 'Proposed Rule', abstract: 'The Commission proposes to amend rules on adviser fees.', text: 'Mentions artificial intelligence once in a footnote.' }),
  doc('2026-30004', 'Artificial Intelligence Standards for Federal Procurement', '2026-10-05', { type: 'Notice', abstract: 'Request for comment on artificial intelligence procurement.', text: 'Body text about super intelligence and artificial intelligence.' })
];

// ---------- 1. a normal run ----------
{
  const srv = fakeServer({ docs: baseDocs() }), out = tmp();
  const r = await runFederalRegister({ http: mk(srv), state: emptyState(), entries: [trackedEo], scope, outDir: out, now: NOW });
  const by = Object.fromEntries(r.changeset.items.map((i) => [i.source_id, i]));
  ok('the tracked executive order is matched to its entry by order number', by['2026-30001'] && by['2026-30001'].entry_key === 'eo-14365-state-law-framework' && by['2026-30001'].change === 'changed');
  ok('a presidential document with no abstract is found by screening its full text', by['2026-30002'] && by['2026-30002'].reason === 'discovery' && by['2026-30002'].entry_key === null);
  ok('a document with an AI title/abstract is a candidate', !!by['2026-30004']);
  ok('a document that only mentions AI in passing is screened out', !by['2026-30003'] && r.stats.screened_out === 1, JSON.stringify(r.stats));
  ok('a document found by two search terms is counted once', r.stats.found === 4, JSON.stringify(r.stats));
  ok('search terms are sent as exact phrases (quoted)', srv.log.filter((u) => /documents\.json/.test(u)).every((u) => /conditions\[term\]=%22/.test(decodeURI(u).replace(/"/g, '%22')) || /conditions%5Bterm%5D=%22|conditions\[term\]="/.test(u)), srv.log[0]);
  const raw = JSON.parse(fs.readFileSync(path.join(out, r.runId, by['2026-30002'].raw_path), 'utf8'));
  ok('saved text is plain text: tags gone, entities decoded', !/<[a-z]/i.test(raw.text) && raw.text.includes('Artificial intelligence & super intelligence'), raw.text.slice(0, 120));
  ok('change set passes its schema and carries the source URL', makeValidator().check('changeset', r.changeset).length === 0 && by['2026-30002'].source_url.startsWith('https://www.federalregister.gov/'));
  ok('cursor moves to today', r.cursor === '2026-10-07', r.cursor);
  // 2. same data again
  const r2 = await runFederalRegister({ http: mk(fakeServer({ docs: baseDocs() })), state: r.nextState, entries: [trackedEo], scope, outDir: out, now: new Date(+NOW + 3600e3), since: '2026-09-29' });
  ok('a second run over the same data yields nothing new', r2.changeset.items.length === 0 && r2.stats.unchanged >= 3, JSON.stringify(r2.stats));
  // 3. a document is corrected
  const fixed = baseDocs(); fixed[3] = { ...fixed[3], abstract: 'Corrected request for comment on artificial intelligence procurement.' };
  const r3 = await runFederalRegister({ http: mk(fakeServer({ docs: fixed })), state: r.nextState, entries: [trackedEo], scope, outDir: out, now: new Date(+NOW + 7200e3), since: '2026-09-29' });
  ok('a changed document is picked up again', r3.changeset.items.length === 1 && r3.changeset.items[0].source_id === '2026-30004');
}

// ---------- 4. paging ----------
{
  const many = []; for (let i = 0; i < 230; i++) many.push(doc('2026-4' + String(i).padStart(4, '0'), 'Unrelated notice ' + i, '2026-10-0' + (1 + (i % 6)), { text: 'This notice mentions artificial intelligence.' }));
  many.push(doc('2026-49999', 'Artificial Intelligence Safety Notice', '2026-10-06', { abstract: 'About artificial intelligence safety.' }));
  const srv = fakeServer({ docs: many });
  const r = await runFederalRegister({ http: mk(srv, { maxRequests: 100 }), state: emptyState(), entries: [], scope: { ...scope, federal_register: { terms: ['artificial intelligence'], max_candidates_per_run: 40 } }, outDir: tmp(), now: NOW });
  ok('reads every page (3 pages of 100 for 231 documents)', r.stats.found === 231 && srv.log.filter((u) => /documents\.json/.test(u)).length === 3, JSON.stringify(r.stats));
  ok('and finds the one relevant document among them', r.changeset.items.some((i) => i.source_id === '2026-49999'));
}

// ---------- 5. budget and resume ----------
{
  const docs = []; for (let i = 0; i < 6; i++) docs.push(doc('2026-5000' + i, 'Artificial Intelligence Notice ' + i, `2026-10-0${i + 1}`, { abstract: 'artificial intelligence' }));
  const r = await runFederalRegister({ http: mk(fakeServer({ docs }), { maxRequests: 6 }), state: emptyState(), entries: [], scope, outDir: tmp(), now: NOW });
  ok('stops when the request budget is used up and says so', r.truncated && r.requests === 6 && r.changeset.items.length >= 1 && r.changeset.items.length < 6, `${r.truncated} ${r.requests} ${r.changeset.items.length}`);
  ok('the cursor stays at the last day it finished', r.cursor < '2026-10-07' && r.cursor >= '2026-10-01', r.cursor);
  const r2 = await runFederalRegister({ http: mk(fakeServer({ docs })), state: r.nextState, entries: [], scope, outDir: tmp(), now: new Date(+NOW + 600e3) });
  const got = new Set([...r.changeset.items, ...r2.changeset.items].map((i) => i.source_id));
  ok('the next run finishes the job, so nothing is lost', got.size === 6, String(got.size));
}

// ---------- 6. candidate cap ----------
{
  const docs = []; for (let i = 0; i < 5; i++) docs.push(doc('2026-6000' + i, 'Artificial Intelligence Notice ' + i, `2026-10-0${i + 1}`, { abstract: 'artificial intelligence' }));
  const r = await runFederalRegister({ http: mk(fakeServer({ docs })), state: emptyState(), entries: [], scope: { ...scope, federal_register: { terms: ['artificial intelligence'], max_candidates_per_run: 2 } }, outDir: tmp(), now: NOW });
  ok('stops at the candidate cap and flags it', r.changeset.items.length === 2 && r.stats.over_candidate_cap === 1 && r.truncated);
}

// ---------- 7. errors ----------
{
  const docs = [doc('2026-70001', 'Artificial Intelligence Notice', '2026-10-02', { abstract: 'artificial intelligence' })];
  const r = await runFederalRegister({ http: mk(fakeServer({ docs, textStatus: { '2026-70001': 404 } })), state: emptyState(), entries: [], scope, outDir: tmp(), now: NOW });
  const out = r.changeset.items[0];
  ok('if the full text cannot be fetched, the document is still collected and marked text_missing', r.changeset.items.length === 1 && r.stats.text_missing === 1);
}
{
  const srv = fakeServer({ docs: baseDocs(), failures: { search: { status: 500, times: 99 } } });
  let err; const state = emptyState();
  try { await runFederalRegister({ http: mk(srv, { retries: 1 }), state, entries: [], scope, outDir: tmp(), now: NOW }); } catch (e) { err = e; }
  ok('a persistent server error stops the run and leaves the saved state untouched', err instanceof HttpError && JSON.stringify(state) === JSON.stringify(emptyState()));
}
{
  const srv = fakeServer({ docs: baseDocs(), failures: { search: { status: 503, times: 1 } } });
  const r = await runFederalRegister({ http: mk(srv), state: emptyState(), entries: [trackedEo], scope, outDir: tmp(), now: NOW });
  ok('a temporary server error is retried and the run succeeds', r.changeset.items.length === 3 && srv.sleeps[0] === 2000);
}

// ---------- 8. named documents (reconciliation) and helpers ----------
{
  const r = await runFederalRegister({ http: mk(fakeServer({ docs: baseDocs() })), state: emptyState(), entries: [trackedEo], scope, outDir: tmp(), now: NOW, docs: ['2026-30001'] });
  ok('fetching a named document marks it reconcile, keeps its entry key and does not move the cursor', r.changeset.items.length === 1 && r.changeset.items[0].reason === 'reconcile' && r.changeset.items[0].entry_key === 'eo-14365-state-law-framework' && r.cursor === '2026-09-29');
}
ok('watchPhrases finds order numbers and quoted names', (() => { const w = watchPhrases({ title: 'BIS "Framework for AI Diffusion" (Biden-era rule); EO 14110', short_name: 'x' }); return w.eo.has('14110') && w.phrases.includes('framework for ai diffusion') && w.phrases.includes('executive order 14110'); })());
ok('htmlToText strips tags and decodes entities', htmlToText('<html><body><pre>A &amp; B &quot;c&quot; &#8212; <a href="x">d</a></pre></body></html>') === 'A & B "c" — d');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
