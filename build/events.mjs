// Extracts dated events from the tracker's date-bearing columns.
// Input: tables as plain text [{heads:[..], rows:[{id, cells:[..]}]}].
// Output: events [{id, date, precision, inferredYear, type, column, clause, cell}].
// Nothing is added: every event points at the cell and the clause it was read from.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const M = "(Jan|Feb|Mar|Apr|May|June|Jun|July|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?";
const DATE_RE = new RegExp(`\\b${M}\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b(?!\\s*[–-]\\s*\\d)|\\b${M}\\s+(\\d{4})\\b`, "g");
const DATE_COLUMN = /signed|effective|status|introduced|^date/i;

export const TYPES = [
  "Introduced / published",
  "Passed / advanced",
  "Signed / enacted",
  "Effective",
  "Referred / stalled / hearing",
  "Vetoed / failed / rescinded",
  "Litigation",
  "Deadline / scheduled",
];

function classify(window, column, sectionLabel) {
  const w = window.toLowerCase();
  const has = (re) => re.test(w);
  if (sectionLabel === "G.2" && has(/sued|complaint|intervened|lawsuit|petition|filed|case|suit|foia/)) return "Litigation";
  if (has(/vetoed|withdrawn|rescinded|rescission|struck|stripped|repealed|revoked|removed|terminat|suspended|not enacted|dead|failed|bills not passed/)) return "Vetoed / failed / rescinded";
  if (has(/signed|approved by|enacted|chapter\b|public act|became law/)) return "Signed / enacted";
  if (has(/effective|eff\.|in effect|obligations from|apply from|compliance date|from jan|from july/)) return "Effective";
  if (has(/passed|concurred|reported|favorable|engrossed|adopted|third reading|roll call|vote\b|votes\b|markup|ordered|enrolled|sent to governor|to enrolling/)) return "Passed / advanced";
  if (has(/introduced|filed|announced|released|published|prefiled|issued|kickoff|created|proposal|draft|section-by-section|interview|remark|post\b|directive|order\b/)) return "Introduced / published";
  if (has(/referred|re-referred|held|stalled|subject to call|no action|returned to|hearing|calendar|rules|assignments/)) return "Referred / stalled / hearing";
  if (has(/deadline|due|sunset|through|reimposed|scheduled|recheck|by jan|by july|checked live|as of|search/)) return "Deadline / scheduled";
  const c = column.toLowerCase();
  if (c.startsWith("signed")) return "Signed / enacted";
  if (c.startsWith("effective")) return "Effective";
  if (c.startsWith("introduced")) return "Introduced / published";
  if (c.startsWith("date")) return "Introduced / published";
  return "Introduced / published";
}

function clauseAround(text, start, end) {
  // the clause containing the date: bounded by ; or · or start/end of cell
  let a = start, b = end;
  while (a > 0 && !/[;·]/.test(text[a - 1])) a--;
  while (b < text.length && !/[;·]/.test(text[b])) b++;
  let c = text.slice(a, b).trim().replace(/^[,.\s]+/, "");
  if (c.length > 240) {
    const ds = start - a;
    const from = Math.max(0, ds - 120);
    c = (from > 0 ? "…" : "") + c.slice(from, from + 240).trim() + (from + 240 < c.length ? "…" : "");
  }
  return c;
}

export function extractEvents(tables, sectionOf) {
  const events = [];
  for (const t of tables) {
    for (const row of t.rows) {
      const sec = sectionOf(row.id);
      if (!sec) continue;
      t.heads.forEach((head, i) => {
        if (i === 0 || !DATE_COLUMN.test(head)) return;
        const text = row.cells[i];
        const years = [...text.matchAll(/\b(20\d\d)\b/g)].map((m) => ({ y: Number(m[1]), at: m.index }));
        let prevEnd = 0;
        for (const m of text.matchAll(DATE_RE)) {
          const monthName = (m[1] || m[4]).toLowerCase();
          const month = MONTHS[monthName];
          const day = m[2] ? Number(m[2]) : null;
          let year = m[3] ? Number(m[3]) : m[5] ? Number(m[5]) : null;
          let inferredYear = false;
          if (year === null) {
            // year from the same cell: the most recent year stated before this date (the cell's running context),
            // else the first year stated after it, else the tracker's verification year
            const before = [...years].reverse().find((y) => y.at < m.index), after = years.find((y) => y.at > m.index);
            year = (before || after || { y: 2026 }).y; inferredYear = true;
          }
          if (year < 2015 || year > 2040) continue;
          // context window: text since the previous date in this cell, plus what follows the date
          // up to the next punctuation break, so a neighbouring clause cannot recolour this event
          const end = m.index + m[0].length;
          const afterRaw = text.slice(end, end + 40);
          const cut = afterRaw.search(/[;,(·)]|\b(Jan|Feb|Mar|Apr|May|June?|July?|Aug|Sept?|Oct|Nov|Dec)\b/);
          const after = cut >= 0 ? afterRaw.slice(0, cut) : afterRaw;
          const window = (text.slice(prevEnd, end) + after).replace(/\[[A-Z—–\- ]+\]/g, " ");
          prevEnd = end;
          const type = classify(window, head, sec.label);
          const date = new Date(Date.UTC(year, month, day || 1));
          events.push({
            id: row.id, date: date.toISOString().slice(0, 10), precision: day ? "day" : "month", inferredYear,
            type, column: head, clause: clauseAround(text, m.index, m.index + m[0].length), match: m[0],
          });
        }
      });
    }
  }
  // de-duplicate identical (id,date,type,column)
  const seen = new Set();
  return events.filter((e) => { const k = `${e.id}|${e.date}|${e.type}|${e.column}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));
}
