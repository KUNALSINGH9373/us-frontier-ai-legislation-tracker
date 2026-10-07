// The Federal Register Grabber. Plain code, no AI. Same contract as the Congress.gov one:
// finds what is new since the last successful run, saves the raw text, writes a change set.
import { createFederalRegister, watchPhrases } from './sources/federal-register.mjs';
import { QuotaExceeded, HttpError, NetworkError } from './lib/http.mjs';
import { sha, isoZ, makeRunId, saveRaw, writeChangeset } from './lib/run-common.mjs';
import { makeScreen } from './screen.mjs';

export const FR_CUTOFF = '2026-09-29';
const MAX_TEXT = 1_500_000; // characters of full text kept per document
const hashOf = (d) => sha(JSON.stringify([d.title, d.publication_date, d.abstract, d.type, d.effective_on]));

export async function runFederalRegister({ http, state, entries = [], scope, outDir, now = new Date(), since, docs = [], dryRun = false, log = () => {} }) {
  const fr = createFederalRegister(http);
  const cfg = scope.federal_register || { terms: ['artificial intelligence'], max_candidates_per_run: 40 };
  const screen = makeScreen(scope);
  const runId = makeRunId(now);
  const block = structuredClone(state.sources.federal_register || { last_success: FR_CUTOFF + 'T00:00:00Z', cursor: FR_CUTOFF, hashes: {} });
  block.hashes = block.hashes || {};
  const from = (since || block.cursor || FR_CUTOFF).slice(0, 10), to = isoZ(now).slice(0, 10);

  const watch = entries.filter((e) => e.section !== 'J').map((e) => ({ key: e.key, ...watchPhrases(e) })).filter((w) => w.eo.size || w.phrases.length);
  const trackedKey = (d) => {
    const hay = `${d.title || ''} ${d.abstract || ''}`.toLowerCase();
    const hit = watch.find((w) => (d.executive_order_number && w.eo.has(String(d.executive_order_number))) || w.phrases.some((p) => hay.includes(p)));
    return hit ? hit.key : null;
  };

  const items = [], stats = { found: 0, tracked: 0, candidates: 0, screened_out: 0, unchanged: 0, over_candidate_cap: 0, text_missing: 0, errors: 0 };
  let truncated = false, lastDate = null, candidatesTaken = 0;

  async function collect(d, reason, entryKey, preloaded) {
    let text = preloaded === undefined ? null : preloaded, missing = false;
    try { if (preloaded === undefined) text = await fr.getText(d); } catch (e) { if (!(e instanceof HttpError || e instanceof NetworkError)) throw e; missing = true; stats.text_missing++; log(`no full text for ${d.document_number}: ${String(e.message).slice(0, 80)}`); }
    if (text == null) missing = true;
    const raw = JSON.stringify({ id: d.document_number, document: d, text: text ? text.slice(0, MAX_TEXT) : null, text_truncated: !!text && text.length > MAX_TEXT, text_missing: missing }, null, 1);
    const saved = saveRaw({ outDir, runId, source: 'federal_register', name: d.document_number + '.json', text: raw });
    items.push({
      item_id: `federal_register:${d.document_number}`, source: 'federal_register', source_id: d.document_number, entry_key: entryKey || null,
      change: entryKey ? 'changed' : 'new', reason, source_url: d.html_url, fetched_at: isoZ(new Date()), raw_hash: saved.hash, raw_path: saved.rel, title: d.title
    });
    block.hashes[d.document_number] = hashOf(d);
  }

  try {
    let found;
    if (docs.length) {
      found = [];
      for (const n of docs) found.push(await http.getJson(`https://www.federalregister.gov/api/v1/documents/${encodeURIComponent(n)}.json`));
    } else {
      // List first (cheap), across every search term, then process in date order so a cut-off run can resume.
      const byNumber = new Map();
      for (const term of cfg.terms) for await (const d of fr.searchDocuments({ from, to, term })) byNumber.set(d.document_number, d);
      found = [...byNumber.values()].sort((a, b) => a.publication_date.localeCompare(b.publication_date) || a.document_number.localeCompare(b.document_number));
    }
    stats.found = found.length;
    for (const d of found) {
      const key = trackedKey(d);
      if (docs.length) { await collect(d, 'reconcile', key); continue; }
      if (block.hashes[d.document_number] === hashOf(d)) { stats.unchanged++; lastDate = d.publication_date; continue; }
      if (key) { await collect(d, 'updated_since_cursor', key); stats.tracked++; }
      else {
        // Title and abstract first. Only presidential documents also get their full text screened, because an order's title often
        // does not say what it is about. Doing it for every document would let passing mentions flood the candidate cap.
        let text, hit = screen(`${d.title} ${d.abstract || ''}`);
        if (!hit && d.type === 'Presidential Document') {
          try { text = await fr.getText(d); hit = !!text && screen(text.slice(0, 30000)); } catch (e) { if (!(e instanceof HttpError || e instanceof NetworkError)) throw e; text = undefined; }
        }
        if (hit) {
          if (candidatesTaken >= cfg.max_candidates_per_run) { stats.over_candidate_cap++; truncated = true; break; }
          await collect(d, 'discovery', null, text); stats.candidates++; candidatesTaken++;
        } else stats.screened_out++;
      }
      lastDate = d.publication_date;
    }
  } catch (e) {
    if (e instanceof QuotaExceeded) { truncated = true; log(`stopped early: ${e.message}`); }
    else { stats.errors++; throw Object.assign(e, { partial: { runId, items, stats } }); }
  }

  const cursor = docs.length ? block.cursor : truncated && lastDate ? lastDate : to; // a date; the next run re-reads that day and skips what it already has
  const changeset = writeChangeset({ outDir, runId, items });
  const next = { ...state, sources: { ...state.sources, federal_register: { ...block, last_success: isoZ(new Date()), cursor, quota: { period: 'run', used: http.used(), limit: http.maxRequests } } } };
  return { runId, changeset, stats, truncated, cursor, requests: http.used(), nextState: next, saved: !dryRun };
}
