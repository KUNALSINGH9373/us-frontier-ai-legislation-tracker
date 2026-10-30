// The official text of a tracked entry's bill, for the self-correction step and the accuracy test (eval/fetch-texts.mjs).
// Federal: Congress.gov (newest text version). State: LegiScan's newest text version, HTML preferred, PDFs read by
// grabber/lib/pdf.mjs; a text already read is reused from data/text-cache (keyed by LegiScan's document id, which changes
// whenever a new version is published). Entries with no bill (executive actions, lawsuits, drafts) have no text here.
import fs from 'fs';
import path from 'path';
import { parseBillId, billUrl } from '../grabber/sources/congress.mjs';
import { latestText, normNumber, officialUrl, adoptedAmendments, withAmendments } from '../grabber/sources/legiscan.mjs';
import { pdfToText } from '../grabber/lib/pdf.mjs';
import { stripLineNumbering } from '../grabber/lib/text.mjs';
import { cleanText } from '../agents/text-norm.mjs';

// Entries whose description follows a later bill than the first mapped one (NY RAISE: Ch. 699 was repealed and replaced by Ch. 96 = S.8828).
export const USE_BILL = { 'ny-raise-act-ch-699-ch-96': ['NY', 'S8828'], 'ma-h-5576-s-3178': ['MA', 'S3228'] };

// cg, ls: Congress.gov and LegiScan clients. ic, il: config/identifiers.json "congress_gov" and identifiers-legiscan.json "legiscan".
// extra: more { key: [state, number] } bills to look up by number (the accuracy test's excluded bills). noCache: re-read from LegiScan.
// repair: put PDF-mangled exponents back (the accuracy test stores texts as fetched and repairs them when it reads them).
export function createEntryTexts({ cg, ls, ic = {}, il = {}, cacheDir, extra = {}, noCache = false, repair = true, withAdopted = false }) {
  const sessionCache = new Map();
  async function stateText(billId) {
    const bill = await ls.bill(billId), v = latestText(bill);
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
  const sourceOf = (key) => USE_BILL[key] ? 'legiscan' : ic[key] && ic[key].congress_gov && ic[key].congress_gov.length ? 'congress_gov' : il[key] || extra[key] ? 'legiscan' : null;

  // { kind, bill, url, text, why } — text is null (with why) when no text could be read; null for an entry with no bill.
  async function textFor(key) {
    const kind = sourceOf(key);
    if (!kind) return null;
    let rec;
    try {
      if (USE_BILL[key]) rec = await fromState(await findStateBill(...USE_BILL[key]), USE_BILL[key].join(' '));
      else if (kind === 'congress_gov') {
        const id = ic[key].congress_gov[0], b = parseBillId(id);
        const text = await cg.getText(b);
        rec = { kind, bill: id, url: billUrl(b) + '/text', text, why: text ? null : 'no text published on Congress.gov yet' };
      } else rec = await fromState(il[key] ? il[key].bills[0].bill_id : await findStateBill(...extra[key]), (extra[key] || []).join(' ')); // a multi-bill entry is read from its first mapped bill
    } catch (err) { rec = { kind, text: null, why: 'fetch failed: ' + String(err.message).slice(0, 120) }; }
    if (rec.text && repair) rec.text = cleanText(rec.text);
    return rec;
  }
  return { textFor, sourceOf };
}
