// The official text of a tracked entry's bill, for the self-correction step and the accuracy test (eval/fetch-texts.mjs).
// Federal: Congress.gov (newest text version). State: LegiScan's newest text version, HTML preferred, PDFs read by
// grabber/lib/pdf.mjs; a text already read is reused from data/text-cache (keyed by LegiScan's document id, which changes
// whenever a new version is published). Entries with no bill (executive actions, lawsuits, drafts) have no text here.
import fs from 'fs';
import path from 'path';
import { parseBillId, billUrl } from '../grabber/sources/congress.mjs';
import { latestText, normNumber, officialUrl, adoptedAmendments, withAmendments, STATUS } from '../grabber/sources/legiscan.mjs';
import { pdfToText } from '../grabber/lib/pdf.mjs';
import { stripLineNumbering } from '../grabber/lib/text.mjs';
import { cleanText } from '../agents/text-norm.mjs';

// Which of an entry's bills is in force or current, from LegiScan's own records (no per-entry list): mapped: the entry's bill ids in
// identifiers-legiscan.json order; getBill: id -> LegiScan bill record.
// 1. Enacted ones first: of the mapped bills LegiScan marks Passed, the latest by its status date (a chapter amendment signed after the
//    law it amends is the law as it now reads).
// 2. Otherwise the newest text in the entry's lineage: the first mapped bill, every mapped bill LegiScan links to a replacement ("Replaces"
//    or "Replaced by"), and every bill reached from those along "Replaced by" links (a reprint as amended, a conference or substitute
//    bill). Whatever order the bills were mapped in, MA's H.5576 / S.3178 / S.37 / S.2630 read S.3228 (the Senate text as amended, the
//    newest), and a later conference report replacing it would be read in its place. A tie keeps the earlier bill (mapped order first).
//    LegiScan lists links both ways (S.3228 "Replaced by" H.5576), so a link back to an older text is reached but never chosen.
const PASSED = Number(Object.keys(STATUS).find((k) => STATUS[k] === 'Passed'));
const newestText = (b) => (b && b.texts || []).reduce((d, t) => (t.date > d ? t.date : d), '');
const linksOf = (b, re) => ((b && b.sasts) || []).filter((x) => re.test(String(x.type || ''))).map((x) => x.sast_bill_id);
export async function operativeBillId(mapped, getBill, { maxFetch = 12 } = {}) {
  const recs = [];
  for (const id of mapped) recs.push(await getBill(id));
  const enacted = recs.filter((b) => b && b.status === PASSED).sort((a, b) => String(b.status_date || '').localeCompare(String(a.status_date || '')));
  if (enacted.length) return enacted[0].bill_id;
  const byId = new Map(mapped.map((id, i) => [id, recs[i]]));
  const lineage = [mapped[0], ...mapped.slice(1).filter((id, i) => linksOf(recs[i + 1], /^replace(s|d by)$/i).length)];
  const queue = [...lineage]; let fetched = 0;
  while (queue.length) {
    for (const next of linksOf(byId.get(queue.shift()), /^replaced by$/i)) {
      if (byId.has(next) || fetched >= maxFetch) continue;
      fetched++; byId.set(next, await getBill(next)); lineage.push(next); queue.push(next);
    }
  }
  let best = mapped[0];
  for (const id of lineage) if (byId.get(id) && newestText(byId.get(id)) > newestText(byId.get(best))) best = id;
  return best;
}

// cg, ls: Congress.gov and LegiScan clients. ic, il: config/identifiers.json "congress_gov" and identifiers-legiscan.json "legiscan".
// extra: more { key: [state, number] } bills to look up by number (the accuracy test's excluded bills). noCache: re-read from LegiScan.
// repair: put PDF-mangled exponents back (the accuracy test stores texts as fetched and repairs them when it reads them).
export function createEntryTexts({ cg, ls, ic = {}, il = {}, cacheDir, extra = {}, noCache = false, repair = true, withAdopted = false }) {
  const sessionCache = new Map(), billCache = new Map();
  const getBill = async (id) => { if (!billCache.has(id)) billCache.set(id, await ls.bill(id)); return billCache.get(id); };
  async function stateText(billId) {
    const bill = await getBill(billId), v = latestText(bill);
    if (!v) return { text: null, why: 'no text version on LegiScan', bill };
    const cache = cacheDir && path.join(cacheDir, `${billId}-${v.doc_id}.txt`);
    let r;
    if (cache && fs.existsSync(cache) && !noCache) r = { text: stripLineNumbering(fs.readFileSync(cache, 'utf8')), bill, version: v };
    else {
      const t = await ls.text(v.doc_id);
      if (t.text != null) r = { text: t.text, bill, version: v };
      else {
        const p = /pdf/i.test(t.mime) ? await pdfToText(t.bytes) : { text: null, reason: 'unsupported format ' + t.mime };
        r = { text: p.text, why: p.reason, bill, version: v, pdf_warnings: (p.warnings || []).map((w) => `${w.found} may be ${w.reads_as}`) };
      }
      if (cache && r.text) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cache, r.text); }
    }
    // Amendments adopted since that version was printed are added only when asked (the accuracy test, which then holds the bill as
    // production does); self-correction reads the printed text alone, so it never rewrites an entry from an un-applied amendment.
    if (r.text && withAdopted) {
      const parts = [];
      for (const a of adoptedAmendments(bill)) {
        const ac = cacheDir && path.join(cacheDir, `${billId}-a${a.amendment_id}.txt`);
        if (ac && fs.existsSync(ac) && !noCache) { parts.push({ title: a.title, date: a.date, text: fs.readFileSync(ac, 'utf8') }); continue; }
        let t = null; try { t = await ls.amendment(a.amendment_id); } catch (e) { t = null; }
        parts.push({ title: a.title, date: a.date, text: t && t.text });
        if (ac && t && t.text) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(ac, t.text); }
      }
      if (parts.length) r = { ...r, text: withAmendments(r.text, parts), amendments: parts.map((p) => ({ title: p.title, date: p.date, read: !!p.text })) };
    }
    return r;
  }
  async function findStateBill(state, number) {
    if (!sessionCache.has(state)) sessionCache.set(state, (await ls.sessions(state)).filter((s) => !s.special).sort((a, b) => b.year_end - a.year_end).slice(0, 2));
    for (const s of sessionCache.get(state)) {
      const m = await ls.masterList(s.session_id);
      const hit = m.bills.find((b) => normNumber(b.number) === number);
      if (hit) return hit.bill_id;
    }
    return null;
  }
  const fromState = async (id, label) => {
    if (!id) return { kind: 'legiscan', text: null, why: `${label} not found in the two newest sessions` };
    const s = await stateText(id);
    return { kind: 'legiscan', bill: `${s.bill.state} ${s.bill.bill_number} (${id})`, url: officialUrl(s.bill), text: s.text, why: s.text ? null : s.why, pdf_warnings: s.pdf_warnings };
  };

  // Which bill an entry is read from, or null when it has none (no fetch is made).
  const sourceOf = (key) => ic[key] && ic[key].congress_gov && ic[key].congress_gov.length ? 'congress_gov' : il[key] || extra[key] ? 'legiscan' : null;

  // { kind, bill, url, text, why } — text is null (with why) when no text could be read; null for an entry with no bill.
  async function textFor(key) {
    const kind = sourceOf(key);
    if (!kind) return null;
    let rec;
    try {
      if (kind === 'congress_gov') {
        const id = ic[key].congress_gov[0], b = parseBillId(id);
        const text = await cg.getText(b);
        rec = { kind, bill: id, url: billUrl(b) + '/text', text, why: text ? null : 'no text published on Congress.gov yet' };
      } else if (il[key]) {
        const ids = il[key].bills.map((b) => b.bill_id); // one bill: read it; several: the one in force (operativeBillId)
        rec = await fromState(ids.length > 1 ? await operativeBillId(ids, getBill) : ids[0], '');
      } else rec = await fromState(await findStateBill(...extra[key]), extra[key].join(' '));
    } catch (err) { rec = { kind, text: null, why: 'fetch failed: ' + String(err.message).slice(0, 120) }; }
    if (rec.text && repair) rec.text = cleanText(rec.text);
    return rec;
  }
  return { textFor, sourceOf };
}
