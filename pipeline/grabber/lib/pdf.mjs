// Reads the words out of a bill PDF so quotes can be checked against them, exactly like HTML bill text.
// Many legislatures print line numbers down the margin and a running header / footer on every page; those are removed,
// because a quote taken from the bill must not be broken by "12" or "Page 3 of 40" in the middle of a sentence.
// A scanned PDF (no text layer) or one that comes out as mostly garbage returns { text: null, reason }: nothing is guessed.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const PDF_LIMITS = { maxPages: 400, maxChars: 1_500_000 };

// Groups text items into lines by their vertical position, left to right within a line.
// - Pieces that touch (no gap) are one word: some printers (CT, RI, PA) split words mid-glyph run, "w" + "ithin".
// - Small digits set above the line after a number are an exponent: "10" + raised "26" -> "10^26".
export function pageLines(items) {
  const parts = items.filter((it) => it.str && it.str.trim()).map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, h: it.height || 0, s: it.str }));
  const hs = parts.map((p) => p.h).filter((h) => h > 0).sort((a, b) => a - b), med = hs[hs.length >> 1] || 0;
  const isSup = (p) => /^\d{1,3}$/.test(p.s.trim()) && med && p.h < med * 0.85;
  const rows = [], sups = [];
  for (const p of parts) {
    let row = rows.find((r) => Math.abs(r.y - p.y) <= 2);
    if (!row && isSup(p)) { sups.push(p); continue; }
    if (!row) rows.push((row = { y: p.y, parts: [] }));
    row.parts.push(p);
  }
  // A raised digit with no row of its own belongs to the line just below it (within about half a line), right after a number.
  for (const p of sups) {
    const row = rows.filter((r) => p.y - r.y > 1 && p.y - r.y <= 8).sort((a, b) => (p.y - a.y) - (p.y - b.y))[0];
    const before = row && row.parts.filter((q) => q.x < p.x).sort((a, b) => b.x - a.x)[0];
    if (row && before && /\d$/.test(before.s.trim())) row.parts.push({ ...p, s: '^' + p.s.trim(), sup: true });
    else rows.push({ y: p.y, parts: [p] });
  }
  return rows.sort((a, b) => b.y - a.y).map((r) => {
    let out = '', prev = null;
    for (const p of r.parts.sort((a, b) => a.x - b.x)) {
      const touches = prev && Math.abs(prev.x + prev.w - p.x) < 0.6 && /\S$/.test(prev.s) && /^\S/.test(p.s);
      out += !prev ? p.s : p.sup ? p.s.trim() : touches ? p.s : ' ' + p.s;
      if (p.sup) out = out.replace(/\s+\^(\d+)$/, '^$1');
      prev = p;
    }
    return out.replace(/\s+/g, ' ').trim();
  });
}

// True when most of the numbers count up by one, as margin line numbers do (1, 2, 3 ... or 34, 35, 36 ...).
const counts = (nums) => nums.length > 1 && nums.slice(1).filter((n, i) => n === nums[i] + 1).length >= (nums.length - 1) * 0.8;

// Line numbers, left or right margin: a line that is only a number, or a number at the start / end of most lines on
// the page, counting up. Ohio prints them on the right ("... best 34"), most states on the left.
export function stripLineNumbers(lines) {
  const enough = (n) => n >= Math.max(5, lines.length * 0.4);
  const lead = lines.map((l) => /^(\d{1,3})\s+\S/.exec(l)).filter(Boolean).map((m) => +m[1]);
  const tail = lines.map((l) => /\S\s+(\d{1,3})$/.exec(l)).filter(Boolean).map((m) => +m[1]);
  const left = enough(lead.length) && (lead.every((n) => n < 100) || counts(lead));
  const right = enough(tail.length) && counts(tail);
  const alone = (l) => /^\d{1,2}$/.test(l) || ((left || right) && /^\d{3}$/.test(l));
  return lines.filter((l) => !alone(l)).map((l) => {
    if (left) l = l.replace(/^\d{1,3}\s+(?=\S)/, '');
    if (right) l = l.replace(/(?<=\S)\s+\d{1,3}$/, '');
    return l;
  });
}

// A line repeated at the top or bottom of most pages (bill number, "Page 3 of 40", session name) is a header or footer.
export function stripRepeats(pages) {
  if (pages.length < 3) return pages;
  const norm = (l) => l.replace(/\d+/g, '#');
  const count = new Map();
  for (const p of pages) for (const l of new Set([...p.slice(0, 2), ...p.slice(-2)].map(norm))) count.set(l, (count.get(l) || 0) + 1);
  const rep = new Set([...count].filter(([, n]) => n >= pages.length * 0.6).map(([l]) => l));
  return pages.map((p) => p.filter((l, i) => !((i < 2 || i >= p.length - 2) && rep.has(norm(l)))));
}

// Words joined across line ends: "artifi-\ncial" -> "artificial".
const join = (lines) => lines.join('\n').replace(/([a-z])-\n([a-z])/g, '$1$2');

// Passages the printed bill itself may have garbled. Never corrected (that would be a guess); reported so the agents
// and the run report treat the number as unproved. Example: PA H.B. 2800 (PN 3904) prints "1,026 integer or
// floating-point operations" where the superscript of 10^26 was lost by the printer.
export function textWarnings(text) {
  const w = [];
  for (const m of text.matchAll(/\b(1,?0(?:2\d|3\d))\b(?=[\s\S]{0,60}?\boperations\b)/g)) w.push({ kind: 'possible_lost_exponent', found: m[1], reads_as: '10^' + m[1].replace(/\D/g, '').slice(2), at: m.index });
  return w;
}

export async function pdfToText(bytes, limits = PDF_LIMITS) {
  let doc;
  try { doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise; }
  catch (e) { return { text: null, reason: 'not a readable PDF: ' + String(e.message).slice(0, 80) }; }
  try {
    const n = Math.min(doc.numPages, limits.maxPages), pages = [];
    let chars = 0;
    for (let i = 1; i <= n && chars < limits.maxChars; i++) {
      const page = await doc.getPage(i);
      const lines = stripLineNumbers(pageLines((await page.getTextContent()).items));
      chars += lines.join('\n').length;
      pages.push(lines);
      page.cleanup();
    }
    const text = stripRepeats(pages).map(join).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    if (text.length < 200 || letters / text.length < 0.5) return { text: null, pages: doc.numPages, reason: text.length < 200 ? 'no text layer (scanned?)' : 'text looks garbled' };
    const out = text.slice(0, limits.maxChars);
    return { text: out, pages: doc.numPages, truncated: doc.numPages > n || text.length > limits.maxChars, warnings: textWarnings(out) };
  } finally { await doc.destroy(); }
}
