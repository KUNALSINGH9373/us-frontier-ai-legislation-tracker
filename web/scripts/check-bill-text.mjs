// Renders every bill page in headless Chrome and checks that every clause of every v1 table cell appears on it.
// Confidence and Source cells are skipped: the page shows them in their own blocks (as levels and as links).
//   node web/scripts/check-bill-text.mjs [--chrome <path>] [--only 4,18,61]
// Starts its own static server on a free port; needs Chrome or Edge installed. Exit code 1 if anything is missing.
import fs from 'fs';
import path from 'path';
import { web, arg, startServer, textOf, squash } from './render-lib.mjs';

const SN = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
const SKIP = /^(Confidence|Source)$/;
const clauses = (t) => t.replace(/\\(.)/g, '$1').split(/;\s+|\.\s+(?=[A-Z(])|\s+\|\s+/).map((c) => c.replace(/^[\s.;,]+|[\s.;,]+$/g, '')).filter((c) => squash(c).length > 2);

const v1 = JSON.parse(fs.readFileSync(path.join(web, 'data', 'entries.json'), 'utf8'));
const only = (arg('--only') || '').split(',').filter(Boolean).map(Number);
// Entries changed after v1 froze (by the pipeline, or corrected in a Claude session) differ from their v1 cells on purpose;
// they are left out, as in parity-v2.mjs.
const v2 = JSON.parse(fs.readFileSync(path.join(web, 'data', 'v2', 'entries.json'), 'utf8'));
const changed = new Set(v2.filter((e) => e.origin !== 'authored' || (e.verification && e.verification.method === 'session')).map((e) => e.id));
const todo = (only.length ? v1.filter((x) => only.includes(x.id)) : v1).filter((x) => !changed.has(x.id));
if (changed.size) console.log(`${v1.filter((x) => changed.has(x.id)).length} v1 entries changed since v1 are not compared (see parity-v2.mjs)`);
const { dump, close } = await startServer();
const missing = []; let checked = 0, pages = 0;
const queue = [...todo];
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let x; (x = queue.shift());) {
    const page = squash(textOf(await dump(`#/bill/${x.id}`)));
    if (!page.includes(squash(x.title.replace(/⟨[^⟩]*⟩/g, '').split(' — ')[0]))) { missing.push(`#${x.id}: page did not render`); continue; }
    pages++;
    x.cells.forEach((c) => {
      if (SKIP.test(c.h)) return;
      // Editors' notes in a title ("(moved from Section E, where …)") are dropped from the shown title on purpose.
      const t = (c.h === 'State' && SN[c.t.trim()] ? SN[c.t.trim()] : c.t).replace(/\s*\((?:moved|formerly listed) from Section [^)]*\)/gi, '');
      clauses(t).forEach((cl) => { checked++; if (!page.includes(squash(cl))) missing.push(`#${x.id} [${c.h}] ${cl}`); });
    });
  }
}));
close();
if (missing.length) { console.log(`${missing.length} clause(s) missing on ${pages} rendered pages (${checked} checked):\n- ` + missing.join('\n- ')); process.exit(1); }
console.log(`All ${checked} clauses of ${todo.length} entries' v1 cells appear on their bill pages (${pages} pages rendered).`);
