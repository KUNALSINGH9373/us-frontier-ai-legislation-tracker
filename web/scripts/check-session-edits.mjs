// Renders the bill page of every entry corrected in a Claude session and checks that each clause of its corrected text fields
// appears on the page (the v1 check, check-bill-text.mjs, leaves these entries out because they differ from v1 on purpose).
//   node web/scripts/check-session-edits.mjs [--since 2026-10-27]
// Starts its own static server; needs Chrome or Edge installed. Exit code 1 if anything is missing.
import fs from 'fs';
import path from 'path';
import { web, arg, startServer, textOf, squash } from './render-lib.mjs';

const since = arg('--since') || '0000-00-00';
const FIELDS = ['title', 'sponsor_text', 'mechanism', 'thresholds', 'penalties', 'status_text'];
// A leading "Status:" / "Date / status:" label is shown as the block's heading, not inline, so it is not looked for.
const LABEL = /^(Status|Date|Date \/ status|Introduced \/ status|Signed|Effective)(\s*\([^)]*\))?\s*:\s*/i;
// Editing notes in titles ("(moved from Section E, ...)") are dropped from shown titles by the site.
const NOTE = /\s*\((moved|added|formerly) [^)]*\)/gi;
const clauses = (t) => String(t).replace(NOTE, '').split(/;\s+|\.\s+(?=[A-Z(])/).map((c) => c.replace(/^[\s.;,]+|[\s.;,]+$/g, '').replace(LABEL, '')).filter((c) => squash(c).length > 2);
const v2 = JSON.parse(fs.readFileSync(path.join(web, 'data', 'v2', 'entries.json'), 'utf8'));
const todo = v2.filter((e) => e.verification && e.verification.method === 'session' && e.last_changed >= since);
const { dump, close } = await startServer();
const missing = [];
let checked = 0;
try {
  for (const e of todo) {
    const page = squash(textOf(await dump(`#/bill/${e.id}`)));
    if (!page) { missing.push(`#${e.id} ${e.key}: page did not render`); continue; }
    for (const f of FIELDS) for (const c of clauses(e[f] || '')) { checked++; if (!page.includes(squash(c))) missing.push(`#${e.id} ${e.key} [${f}] ${c}`); }
  }
} finally { await close(); }
if (missing.length) { console.log(`${missing.length} clause(s) missing on ${todo.length} pages (${checked} checked):\n- ` + missing.join('\n- ')); process.exit(1); }
console.log(`All ${checked} clauses of ${todo.length} session-corrected entries appear on their bill pages.`);
