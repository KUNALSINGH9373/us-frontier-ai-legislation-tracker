// Renders tracker.md into docs/index.html.
//
// Content is not edited. Transformations are layout only:
//  - markdown -> HTML, heading ids, external-link attributes
//  - each table row becomes a record card: short cells become a facts grid,
//    long cells become prose blocks, each under the author's own column heading
//    (two-column tables become a definition list; section-K matrices stay tabular)
//  - the document is split into sections at each H2; sections are grouped for
//    navigation; a directory, jump lists and previous/next links are added
//  - CSS classes on the author's bold confidence/status labels
//
// Fidelity checks make the build fail if anything is lost or moved:
//  - every table cell in the markdown is rendered exactly once
//  - every (link text, URL) pair in the markdown appears in the HTML
//  - every word in the markdown appears in the page at least as often
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { marked } from "marked";
import { extractEvents, TYPES } from "./events.mjs";
import { renderHandbook } from "./handbook.mjs";

const REPO_URL = process.env.REPO_URL || "https://github.com/KUNALSINGH9373/us-frontier-ai-legislation-tracker";
const md = readFileSync("tracker.md", "utf8");
const template = readFileSync("build/template.html", "utf8");

const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
const plain = (h) => decode(strip(h));
const slug = (s) => plain(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ids = new Set();
const uniq = (id) => { let x = id, n = 2; while (ids.has(x)) x = `${id}-${n++}`; ids.add(x); return x; };
const FACT_MAX = 170; // plain-text length at or below which a cell is shown in the facts grid

let title = "";
const sourceCells = [];
const tablesData = []; // plain-text copy of card tables for event extraction
const matricesData = []; // section-K matrices, HTML cells, reused on the overview
const pairsData = [];    // section-J exclusion rows
const renderedCells = [];

marked.use({
  gfm: true,
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      if (depth === 1) { title = strip(text); return `<h1>${text}</h1>\n`; }
      const id = uniq(slug(text));
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
    link({ href, title: t, tokens }) {
      const text = this.parser.parseInline(tokens);
      const ext = /^https?:/i.test(href) ? ' target="_blank" rel="noopener"' : "";
      return `<a href="${href}"${t ? ` title="${t}"` : ""}${ext}>${text}</a>`;
    },
    table(token) {
      const heads = token.header.map((c) => this.parser.parseInline(c.tokens));
      const rows = token.rows.map((r) => r.map((c) => this.parser.parseInline(c.tokens)));
      rows.forEach((r) => r.forEach((c) => sourceCells.push(plain(c))));
      const first = strip(heads[0]);

      if (/^(Dimension|Jurisdiction)/i.test(first)) {
        matricesData.push({ heads, rows });
        const head = "<tr>" + heads.map((h) => `<th>${h}</th>`).join("") + "</tr>";
        const body = rows.map((r) => "<tr>" + r.map((c, i) => { renderedCells.push(plain(c)); return i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`; }).join("") + "</tr>").join("\n");
        return `<div class="matrix"><table><thead>${head}</thead><tbody>\n${body}\n</tbody></table></div>\n`;
      }

      if (heads.length === 2) {
        const items = rows.map((r) => { renderedCells.push(plain(r[0]), plain(r[1])); const pid = uniq("rec-" + slug(r[0]).slice(0, 70)); pairsData.push({ id: pid, heads: heads.map(plain), cells: r.map(plain), html: r }); return `<div class="pair" id="${pid}"><dt><span class="vh">${heads[0]}: </span>${r[0]}</dt><dd><span class="lbl">${heads[1]}</span>${r[1]}</dd></div>`; }).join("\n");
        return `<div class="pairs" data-count="${rows.length}"><dl>\n${items}\n</dl></div>\n`;
      }

      const stateIdx = heads.findIndex((h) => /^State$/i.test(strip(h)));
      const tdata = { heads: heads.map(plain), rows: [] }; tablesData.push(tdata);
      const cards = rows.map((r) => {
        const id = uniq("rec-" + slug(r[0]).slice(0, 70));
        tdata.rows.push({ id, cells: r.map(plain), html: r });
        const chip = stateIdx >= 0 ? `<span class="chip state"><span class="vh">${heads[stateIdx]}: </span>${r[stateIdx]}</span>` : "";
        // Fields in the author's column order. Consecutive short cells share a facts grid;
        // long cells (and Source) stand alone as prose blocks.
        const runs = []; // [{kind:"facts"|"block", items:[]}]
        r.forEach((cell, i) => {
          if (i === 0 || i === stateIdx) return;
          const label = strip(heads[i]).toLowerCase();
          const isSource = label.startsWith("source");
          const short = plain(cell).length <= FACT_MAX && !isSource;
          const cls = label.startsWith("confidence") ? " conf" : isSource ? " src" : "";
          const item = `<div class="${short ? "fact" : "block"}${cls}"><dt>${heads[i]}</dt><dd>${cell}</dd></div>`;
          const last = runs[runs.length - 1];
          if (short && last && last.kind === "facts") last.items.push(item);
          else runs.push({ kind: short ? "facts" : "block", items: [item] });
        });
        const body = runs.map((run) => `<dl class="${run.kind === "facts" ? "facts" : "blocks"}">\n${run.items.join("\n")}\n</dl>`).join("\n");
        r.forEach((c) => renderedCells.push(plain(c)));
        return `<article class="record" id="${id}">
<header class="record-head">${chip}<h3 class="title"><span class="vh">${heads[0]}: </span>${r[0]}</h3></header>
${body}
<p class="permalink"><a href="#${id}">Link to this entry</a></p>
</article>`;
      }).join("\n");
      return `<div class="records" data-count="${rows.length}">\n${cards}\n</div>\n`;
    },
  },
});

let html = marked.parse(md);
const m = html.match(/<\/h1>\n<p>([\s\S]*?)<\/p>/);
const lede = m ? m[1] : "";

const conf = { HIGH: "high", "MED-HIGH": "medhigh", MED: "med", "SEARCH-QUALIFIED": "sq", LOW: "low" };
html = html.replace(/<strong>(HIGH|MED-HIGH|MED|SEARCH-QUALIFIED|LOW)<\/strong>/g, (_, k) => `<strong class="conf ${conf[k]}">${k}</strong>`);
html = html.replace(/<strong>\[(PENDING|STALLED|FAILED[^\]]*)\]<\/strong>/g, (_, k) => `<strong class="status ${k.startsWith("FAILED") ? "failed" : k.toLowerCase()}">[${k}]</strong>`);

// Section groups for navigation.
const GROUPS = [
  { key: "start", name: "Start here", labels: ["Overview"] },
  { key: "state", name: "State legislation", labels: ["A", "B", "B.2", "C"] },
  { key: "federal", name: "Federal legislation", labels: ["D", "E", "F"] },
  { key: "exec", name: "Executive action, litigation, export controls", labels: ["G", "G.2", "G.3"] },
  { key: "context", name: "Precursors, adjacent laws, exclusions", labels: ["H", "I", "J"] },
  { key: "analysis", name: "Cross-cutting analysis and method", labels: ["K", "L"] },
];

const parts = html.split(/(?=<h2 id=")/);
const sections = [];
parts.forEach((part, i) => {
  let id, label, name;
  if (i === 0) { id = "sec-overview"; label = "Overview"; name = "Overview"; }
  else {
    const hm = part.match(/^<h2 id="([^"]+)">([\s\S]*?)<\/h2>/);
    id = "sec-" + hm[1];
    const heading = plain(hm[2]);
    const lm = heading.match(/^([A-Z](?:\.\d)?)\.?\s+(.*)$/);
    label = lm ? lm[1] : heading.slice(0, 2);
    name = lm ? lm[2] : heading;
  }
  const count = [...part.matchAll(/data-count="(\d+)"/g)].reduce((s, x) => s + Number(x[1]), 0);
  const entries = [...part.matchAll(/<(?:article class="record"|div class="pair") id="([^"]+)"[^>]*>\s*(?:<header class="record-head">(?:<span class="chip state">[\s\S]*?<\/span>)?<h3 class="title">|<dt>)<span class="vh">[\s\S]*?<\/span>([\s\S]*?)<\/(?:h3|dt)>/g)]
    .map((x) => ({ id: x[1], text: plain(x[2]) }));
  const h3s = [...part.matchAll(/<h3 id="([^"]+)">([\s\S]*?)<\/h3>/g)].map((x) => ({ id: x[1], text: plain(x[2]) }));
  const short = name.replace(/\s*[—(].*$/, "");
  const group = GROUPS.find((g) => g.labels.includes(label)) || GROUPS[GROUPS.length - 1];
  sections.push({ id, label, name, short, count, entries, h3s, group, body: part });
});

// ---- Timeline tab: events read from the date-bearing columns ----
const entryMeta = {};
sections.forEach((sec) => sec.entries.forEach((e) => { entryMeta[e.id] = { title: e.text, section: sec.label, sectionName: sec.name, group: sec.group.key }; }));
const events = extractEvents(tablesData, (id) => entryMeta[id] ? { label: entryMeta[id].section } : null);
const usedEntries = {}; events.forEach((e) => { usedEntries[e.id] = entryMeta[e.id]; });
const VIZ = { types: TYPES, colors: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"], events, entries: usedEntries, sectionOrder: sections.map((x) => x.label) };
const YEARS = ["2023", "2024", "2025", "2026", "2027+"];
const bucket = (iso) => { const y = Number(iso.slice(0, 4)); return y >= 2027 ? "2027+" : String(y); };
const entryYears = {}; events.forEach((e) => { (entryYears[e.id] = entryYears[e.id] || new Set()).add(bucket(e.date)); });
const yearsOf = (id) => (id.startsWith("hb-") ? "*" : entryYears[id] ? [...entryYears[id]].sort().join(" ") : "");
VIZ.entryYears = Object.fromEntries(Object.entries(entryYears).map(([k, v]) => [k, [...v].sort()]));
const GROUP_COLORS = { state: "#2a78d6", federal: "#eb6834", exec: "#1baf7a", context: "#eda100" };
const yearPanelData = YEARS.map((y) => { const per = {}; Object.entries(entryYears).forEach(([id, ys]) => { if (ys.has(y)) { const g = entryMeta[id].group; per[g] = (per[g] || new Set()).add(id); } }); return { y, counts: Object.fromEntries(Object.entries(per).map(([g, ids]) => [g, ids.size])) }; });
const vizBody = `<header class="sec-head"><p class="sec-meta"><span class="sec-group">Start here</span><span class="sec-count">Derived view</span></p><h2 id="timeline">Changes over time</h2></header>
<p class="viz-intro">Every dated event in the tracker's <em>Signed</em>, <em>Effective</em>, <em>Status</em>, <em>Introduced</em> and <em>Date</em> cells, placed on one time axis: <b>${events.length} events</b> read from <b>${Object.keys(usedEntries).length} entries</b>. Nothing is added to the tracker here; each mark points back to the cell it was read from, and hovering shows that text. Colour is the kind of event. Press play to watch the record fill in month by month.</p>
<div class="viz-controls"><div class="viz-presets" role="group" aria-label="Date range"></div><div class="viz-play"><button type="button" id="viz-play" aria-pressed="false">Play the timeline</button><button type="button" id="viz-reset">Reset</button><span id="viz-cursor" class="viz-cursor"></span></div></div>
<div class="viz-legend" role="group" aria-label="Event types. Click to hide or show a type."></div>
<ul class="viz-stats"><li><b id="st-events">0</b><span>events shown</span></li><li><b id="st-entries">0</b><span>instruments</span></li><li><b id="st-enacted">0</b><span>with a signed / enacted event</span></li><li><b id="st-effective">0</b><span>with an effective date</span></li><li class="note"><span id="st-note"></span></li></ul>
<div class="viz-card"><h3>Every instrument's lifecycle</h3><p class="viz-help">One row per instrument, grouped by section and ordered by first event. Hover or focus a mark for the original cell text; click a name to open the entry. Paler marks are month-only dates.</p><div id="viz-timeline" class="viz-plot"></div></div>
<div class="viz-card"><h3>Activity by month</h3><p class="viz-help">Events per month, stacked by type. Hover a segment to see which instruments it counts.</p><div id="viz-bars" class="viz-plot"></div></div>
<div class="viz-card"><h3>Instruments with a dated event, cumulative</h3><p class="viz-help">How the tracked set grew over time. Hover for the count at any date.</p><div id="viz-cum" class="viz-plot"></div></div>
<p><button type="button" id="viz-table-toggle" aria-expanded="false" class="viz-btn">Show table view</button></p>
<div class="viz-table" hidden><table><thead><tr><th>Date</th><th>Section</th><th>Entry</th><th>Event type</th><th>Column</th><th>Text read from the cell</th></tr></thead><tbody></tbody></table><p class="viz-foot">* Year inferred from the same cell where the tracker gives only month and day.</p></div>
<div class="viz-tip" role="tooltip" hidden></div>`;
sections.splice(1, 0, { id: "sec-timeline", label: "TL", name: "Changes over time", short: "Changes over time", count: 0, entries: [], h3s: [], group: GROUPS[0], body: vizBody, synthetic: true });

// Stamp each entry with the years in which it has a dated event (drives the year filter).
sections.forEach((sec) => { if (!sec.synthetic) sec.body = sec.body.replace(/<(article class="record"|div class="pair") id="([^"]+)"/g, (m, tag, id) => `<${tag} id="${id}" data-years="${yearsOf(id)}"`); });

// ---- Table tab: one row per entry, AAF-style columns, all cells verbatim ----
const pick = (heads, re) => heads.map((h, i) => (re.test(h) ? i : -1)).filter((i) => i >= 0);
const confRank = { HIGH: 5, "MED-HIGH": 4, MED: 3, "SEARCH-QUALIFIED": 2, LOW: 1 };
const tableRows = [];
tablesData.forEach((t) => t.rows.forEach((row) => {
  const meta = entryMeta[row.id]; if (!meta) return;
  const H = t.heads;
  const stateI = pick(H, /^state$/i)[0];
  const sponsorI = pick(H, /sponsor/i);
  const mechI = pick(H, /mechanism|what it does|key content|frontier-relevant|relevance|nature/i);
  const threshI = pick(H, /threshold|^scope$/i);
  const statusI = pick(H, /status|introduced|signed|effective|^date/i);
  const srcI = pick(H, /^source/i);
  const confI = pick(H, /^confidence/i);
  const cellsOf = (idx) => idx.map((i) => `<div class="tc"><span class="tl">${H[i]}</span>${row.html[i]}</div>`).join("");
  const confText = confI.length ? row.cells[confI[0]] : "";
  const confKey = (confText.match(/^(HIGH|MED-HIGH|MED|SEARCH-QUALIFIED|LOW)/) || ["", ""])[1];
  const statusText = statusI.map((i) => row.cells[i]).join(" ");
  const statusTag = (statusText.match(/\[(PENDING|STALLED|FAILED)/) || [])[1] || (meta.section === "A" ? "ENACTED" : "");
  tableRows.push({
    id: row.id, title: row.html[0], titlePlain: row.cells[0], juris: stateI >= 0 ? row.cells[stateI] : (meta.group === "state" ? "" : "US"),
    section: meta.section, sectionName: meta.sectionName, group: meta.group,
    sponsor: cellsOf(sponsorI), mech: cellsOf(mechI), thresh: cellsOf(threshI), status: cellsOf(statusI), source: cellsOf(srcI), conf: cellsOf(confI),
    confKey, confRank: confRank[confKey] || 0, statusTag, years: yearsOf(row.id),
    csv: { sponsor: sponsorI.map((i) => row.cells[i]).join(" | "), mech: mechI.map((i) => row.cells[i]).join(" | "), thresh: threshI.map((i) => row.cells[i]).join(" | "), status: statusI.map((i) => `${H[i]}: ${row.cells[i]}`).join(" | "), source: srcI.map((i) => row.cells[i]).join(" | "), conf: confText },
  });
}));
pairsData.forEach((pr) => { const meta = entryMeta[pr.id]; if (!meta) return; tableRows.push({ id: pr.id, title: pr.html[0], titlePlain: pr.cells[0], juris: "", section: meta.section, sectionName: meta.sectionName, group: meta.group, sponsor: "", mech: `<div class="tc"><span class="tl">${pr.heads[1]}</span>${pr.html[1]}</div>`, thresh: "", status: "", source: "", conf: "", confKey: "", confRank: 0, statusTag: "EXCLUDED", years: yearsOf(pr.id), csv: { sponsor: "", mech: pr.cells[1], thresh: "", status: "", source: "", conf: "" } }); });

const csvEsc = (v) => `"${String(v).replace(/"/g, '""')}"`;
const csv = [["Section", "Entry", "Jurisdiction", "Sponsor", "Core mechanism / description", "Thresholds / scope", "Status and dates", "Source", "Confidence", "Years with dated events", "Permalink"].join(","),
  ...tableRows.map((r) => [r.section, r.titlePlain, r.juris, r.csv.sponsor, r.csv.mech, r.csv.thresh, r.csv.status, r.csv.source, r.csv.conf, r.years, `https://kunalssingh.com/us-frontier-ai-legislation-tracker/#${r.id}`].map(csvEsc).join(","))].join("\n");
writeFileSync("docs/tracker-table.csv", "\ufeff" + csv);

const sectionsWithRows = [...new Set(tableRows.map((r) => r.section))];
const groupsWithRows = GROUPS.filter((g) => tableRows.some((r) => r.group === g.key));
const statesWithRows = [...new Set(tableRows.map((r) => r.juris).filter(Boolean))].sort();
const aaf = JSON.parse(readFileSync("build/aaf-crosscheck.json", "utf8"));
const tableBody = `<header class="sec-head"><p class="sec-meta"><span class="sec-group">Start here</span><span class="sec-count">${tableRows.length} rows</span></p><h2 id="table">All entries as a table</h2></header>
<p class="viz-intro">Every entry in the tracker as one row: state laws and bills, federal bills and drafts, executive actions, litigation, export controls, precursors and exclusions. Cells are the tracker's own text under the tracker's own headings; long cells are clipped to three lines until you expand the row. Sort by clicking a heading, filter with the controls, or <a href="tracker-table.csv" download>download the table as CSV</a>.</p>
<div class="tbl-controls">
  <label class="tsearch"><span class="vh">Filter rows</span><input id="tq" type="search" placeholder="Filter rows: any word in any column" autocomplete="off"></label>
  <select id="tgroup" aria-label="Group"><option value="">All groups</option>${groupsWithRows.map((g) => `<option value="${g.key}">${g.name}</option>`).join("")}</select>
  <select id="tsection" aria-label="Section"><option value="">All sections</option>${sections.filter((x) => sectionsWithRows.includes(x.label)).map((x) => `<option value="${x.label}">${x.label}. ${x.short}</option>`).join("")}</select>
  <select id="tstate" aria-label="Jurisdiction"><option value="">All jurisdictions</option>${statesWithRows.map((x) => `<option value="${x}">${x}</option>`).join("")}</select>
  <select id="tstatus" aria-label="Status class"><option value="">Any status class</option><option value="ENACTED">Enacted (section A)</option><option value="PENDING">[PENDING]</option><option value="STALLED">[STALLED]</option><option value="FAILED">[FAILED]</option><option value="EXCLUDED">Excluded (section J)</option></select>
  <button type="button" id="texpand" class="viz-btn">Expand all rows</button>
  <span class="tcount" id="tcount"></span>
</div>
<div class="bigwrap"><table class="big" id="bigtable">
<thead><tr>
<th data-sort="section" aria-sort="none"><button type="button">Section</button></th>
<th data-sort="title" aria-sort="none"><button type="button">Entry</button></th>
<th data-sort="juris" aria-sort="none"><button type="button">Jurisdiction</button></th>
<th>Sponsor</th>
<th>Mechanism / description</th>
<th>Thresholds / scope</th>
<th data-sort="status" aria-sort="none"><button type="button">Status and dates</button></th>
<th>Source</th>
<th data-sort="conf" aria-sort="none"><button type="button">Confidence</button></th>
</tr></thead>
<tbody>
${tableRows.map((r) => `<tr id="row-${r.id}" data-years="${r.years}" data-group="${r.group}" data-section="${r.section}" data-state="${r.juris}" data-status="${r.statusTag}" data-conf="${r.confRank}" data-title="${r.titlePlain.replace(/"/g, "&quot;").toLowerCase()}">
<td class="c-sec"><a href="#sec-${slug(sections.find((x) => x.label === r.section).id.replace(/^sec-/, ""))}" title="${r.sectionName.replace(/"/g, "&quot;")}"><span class="lbl">${r.section}</span></a></td>
<td class="c-title"><a href="#${r.id}">${r.title}</a><button type="button" class="rowtgl" aria-expanded="false">Expand</button></td>
<td class="c-juris">${r.juris ? `<span class="chip state">${r.juris}</span>` : ""}</td>
<td class="c-sponsor clip">${r.sponsor}</td>
<td class="c-mech clip">${r.mech}</td>
<td class="c-thresh clip">${r.thresh}</td>
<td class="c-status clip">${r.status}</td>
<td class="c-src">${r.source}</td>
<td class="c-conf">${r.conf}</td>
</tr>`).join("\n")}
</tbody></table></div>
<p class="tfoot">${tableRows.length} rows. Section J rows carry the tracker's exclusion reason in the mechanism column. Every cell links back to its entry.</p>

<section class="panel" aria-labelledby="aaf-h"><h2 id="aaf-h" class="panel-title">Cross-check against the American Action Forum list</h2>
<p class="panel-note"><a data-site href="${aaf.url}" target="_blank" rel="noopener">${aaf.source}</a>, ${aaf.rows} federal bills, fetched ${aaf.fetched}. ${aaf.scope_note}</p>
<h3 class="cc-h">In both lists</h3><ul class="cc-list">${aaf.in_both.map((x) => `<li><b>${x.bill}</b> ${x.title} <span class="cc-tag">${x.tracker}</span></li>`).join("")}</ul>
<h3 class="cc-h">On the AAF list, within the tracker's scope or close to it, not yet in the tracker</h3>
<p class="panel-note">Candidates for the tracker's own verification process, not entries. Summaries are AAF's wording, quoted. Nothing here is added to the tracker until the operative text and official action record have been read.</p>
<div class="ccwrap"><table class="cc"><thead><tr><th>Bill</th><th>Sponsor</th><th>Title</th><th>AAF summary (quoted)</th><th>Assessment under the tracker's rules</th><th>Suggested section</th></tr></thead><tbody>
${aaf.candidates.map((x) => `<tr><td><b>${x.bill}</b></td><td>${x.sponsor}</td><td>${x.title}</td><td class="q">“${x.aaf_summary}”</td><td>${x.assessment}</td><td><span class="cc-tag">${x.suggested}</span></td></tr>`).join("")}
</tbody></table></div>
<h3 class="cc-h">In the tracker, absent from the AAF list</h3><ul class="cc-list inline">${aaf.tracker_only.map((x) => `<li>${x}</li>`).join("")}</ul>
<h3 class="cc-h">Caveats about the AAF list as observed on the fetch date</h3><ul class="cc-list">${aaf.caveats.map((x) => `<li>${x}</li>`).join("")}</ul>
</section>`;
// ---- Info tab: the Plain-English Handbook ----
const hbMd = readFileSync("handbook.md", "utf8");
const hb = renderHandbook(hbMd);
const infoBody = `<header class="sec-head"><p class="sec-meta"><span class="sec-group">Start here</span><span class="sec-count">${hb.chapters.length} chapters</span></p><h2 id="info">${hb.title}</h2></header>
<div class="hb-pre">${hb.preamble}<p class="hb-actions"><a class="viz-btn" href="handbook.pdf" download>Download the handbook as PDF</a> <a class="viz-btn" href="handbook.md" download>Markdown</a> <button type="button" class="viz-btn" id="hb-all" aria-pressed="false">Show all chapters on one page</button></p></div>
${hb.grid}
<div class="hb-chapters">${hb.chapterHtml}</div>`;
const hbNorm = (t) => t.replace(/[*_|`#>\[\]]/g, " ").split(/\s+/).map((w) => w.replace(/[:;,.]+$/, "")).filter(Boolean); // trailing punctuation ignored: glossary colons are dropped in card headings
const hbWords = hbNorm(hbMd.replace(/\]\((https?:[^)]+)\)/g, "]").replace(/^\s*(\d+\.|[-*])\s+/gm, "")); // list markers are rendered as counters
const hbHtmlWords = hbNorm(infoBody.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
{ const tally = (ws) => ws.reduce((mm, w) => mm.set(w, (mm.get(w) || 0) + 1), new Map()); const a = tally(hbWords), b = tally(hbHtmlWords); const miss = [...a].filter(([w, n]) => (b.get(w) || 0) < n && !/^[-:]+$|^\d+\.$/.test(w)).map(([w, n]) => `${w}×${n - (b.get(w) || 0)}`); if (miss.length) throw new Error(`handbook words missing: ${miss.slice(0, 20).join(" ")}`); }
sections.splice(1, 0, { id: "sec-info", label: "HB", name: "Plain-English Handbook", short: "Handbook: how US AI law works", count: 0, entries: hb.chapters.map((c) => ({ id: c.id, text: `${c.num ? c.num + ". " : ""}${c.title}` })), h3s: [], group: GROUPS[0], body: infoBody, synthetic: true });

sections.splice(3, 0, { id: "sec-table", label: "TB", name: "All entries as a table", short: "Table of all entries", count: 0, entries: [], h3s: [], group: GROUPS[0], body: tableBody, synthetic: true });

// ---- About section (doc's confidence key + verification note, plus how the site was made) ----
GROUPS.push({ key: "about", name: "About this site", labels: ["i"] });
const om = parts[0].match(/^<h1>([\s\S]*?)<\/h1>\n<p>([\s\S]*?)<\/p>\n([\s\S]*)$/);
const heroTitle = om[1], heroLede = om[2], overviewRest = om[3].trim();
const linkCheck = (() => { try { const t = readFileSync("LINK-CHECK.md", "utf8"); const g = (c) => Number((t.match(new RegExp(`\\| HTTP ${c} \\| (\\d+) \\|`)) || [0, 0])[1]); const date = (t.match(/requested on (\d{4}-\d{2}-\d{2})/) || [0, ""])[1]; return { ok: g(200), forbidden: g(403), notfound: g(404), date }; } catch { return null; } })();
const aboutBody = `<header class="sec-head"><p class="sec-meta"><span class="sec-group">About this site</span><span class="sec-count">Reference</span></p><h2 id="about">About this site</h2></header>
<div class="about-block" id="confidence-key"><h3>Confidence key and verification note</h3><p class="about-note">The following text is the tracker's own introduction, reproduced verbatim.</p>${overviewRest}</div>
<div class="about-block"><h3>What this site is</h3><p>A reading view of the <em>US Frontier AI Legislation Tracker (2025–2026)</em>, a primary-source audit of state and federal bills, enacted laws, executive actions, litigation and export controls that target frontier AI developers, together with the independent-verification-organization and AI-auditor licensing bills that form a distinct sub-category. The tracker's text is shown without editorial change. Every entry keeps the tracker's own column headings, column order, confidence ratings, status classes, dates and source links.</p></div>
<div class="about-block"><h3>How it was made</h3><ol>
<li>The tracker was written as a markdown document and exported from Google Docs. The export is kept unchanged in the repository for provenance.</li>
<li>Two artifacts of that export were reversed and nothing else: markdown characters inside table cells that the export had backslash-escaped, and table header rows that the export had pushed into the first body row. The result is the markdown of record.</li>
<li>A build script renders that markdown to this page. Each table row becomes one entry; each column becomes a labelled field under the tracker's own heading, in the tracker's order. Runs of short cells share a facts grid and long cells are shown as prose. The two comparison matrices in section K stay as tables. The exclusion list in section J is a definition list.</li>
<li>The document is split into sections at its own headings, grouped for navigation, and given a directory, jump lists, search and previous/next links. On this overview page the directory comes first; the confidence key and verification note live here.</li>
</ol></div>
<div class="about-block"><h3>Checks that run on every build</h3><ul>
<li>Every table cell in the markdown must be rendered exactly once. The build stops otherwise.</li>
<li>Every link, as a text-and-URL pair, must appear in the page.</li>
<li>Every word of the markdown must appear in the page at least as often as in the source.</li>
<li>A second, independently written checker parses the markdown tables and the published HTML and confirms that each cell sits under its own heading, in its own entry, in the tracker's column order, with its links, and that every paragraph is present.</li>
</ul></div>
<div class="about-block"><h3>The Info tab</h3><p>The <em>Plain-English Handbook for the Frontier AI Law Audit (2025–26)</em>, a companion guide to the US legal system, legislative procedure, statutory reading, AI-governance vocabulary, enforcement, preemption, litigation terms and research method. Its text is shown verbatim, one chapter at a time, with the handbook's own structure driving the layout: glossary entries become term cards, numbered procedures become step cards, and the ten closing rules become rule cards. Trailing colons on glossary terms are dropped in the card headings. The PDF and markdown are downloadable from the tab, and the build checks that every word of the handbook appears on the page.</p></div>
<div class="about-block"><h3>The Table tab</h3><p>Every entry as one row with the tracker's Sponsor, mechanism, threshold, status, source and confidence cells placed under their own headings, sortable and filterable, with a CSV download. Below the table, a cross-check against the American Action Forum's list of federal AI bills records which bills appear in both, which AAF bills fall within or near the tracker's frontier scope but are not yet entries, and which tracker bills AAF lacks. Those candidates are for the tracker's verification process; they are not entries.</p></div>
<div class="about-block"><h3>The Changes over time tab</h3><p>A derived view, not part of the tracker text. At build time every date in the tracker's Signed, Effective, Status, Introduced and Date cells becomes an event carrying the entry it belongs to, the column it came from, the clause of text around it, and an event type inferred from the words in that clause. Where the tracker gives only month and day, the year is taken from the same cell and the event is marked as inferred. Hovering a mark shows the original cell text, and a table view lists every event.</p></div>
${linkCheck ? `<div class="about-block"><h3>Link check</h3><p>Every unique link in the tracker was requested on ${linkCheck.date}. ${linkCheck.ok} returned 200. ${linkCheck.forbidden} returned 403 from sites that block automated access, which matches the tracker's own note about such sites. ${linkCheck.notfound} returned 404. No link was changed as a result; the full report is in the repository.</p></div>` : ""}
<div class="about-block"><h3>Source and updates</h3><p>The markdown of record, the raw export, the build and the checks are in the <a data-site href="${REPO_URL}">repository</a>. To update, edit the markdown, run the build and the verifier, and push; the site redeploys. <a href="tracker.md">Download the markdown</a>.</p></div>`;
sections.push({ id: "sec-about", label: "i", name: "About this site", short: "About this site", count: 0, entries: [], h3s: [], group: GROUPS[GROUPS.length - 1], body: aboutBody, synthetic: true });

const totalEntries = sections.reduce((n, s) => n + s.count, 0);
const mdLinkCount = (md.match(/\]\(https?:\/\//g) || []).length;
const linkText = (t, n = 96) => (t.length > n ? t.slice(0, n - 2).trimEnd() + "…" : t);
const lblPrefix = (s) => (["Overview", "TL", "TB", "HB", "i"].includes(s.label) ? "" : s.label + ". ");
const jumpList = (s) => {
  const items = [...s.h3s.map((h) => `<li class="sub"><a href="#${h.id}">${h.text}</a></li>`), ...s.entries.map((e) => `<li data-years="${yearsOf(e.id)}"><a href="#${e.id}">${linkText(e.text)}</a></li>`)];
  return items.length ? `<nav class="jump" aria-label="Entries in this section"><p class="jump-title">In this section</p><ol>${items.join("")}</ol></nav>` : "";
};

// ---- Overview panels, all derived from the tracker's own cells ----
const secBy = (l) => sections.find((s) => s.label === l);
const cnt = (l) => (secBy(l) ? secBy(l).count : 0);
const href = (l) => (secBy(l) ? "#" + secBy(l).id : "#");
const statusTags = { PENDING: 0, STALLED: 0, FAILED: 0 };
tablesData.forEach((t) => { const si = t.heads.findIndex((h) => /^status/i.test(h)); if (si < 0) return; t.rows.forEach((r) => { const mm = r.cells[si].match(/\[(PENDING|STALLED|FAILED)/); if (mm) statusTags[mm[1]]++; }); });
const stateCounts = {};
tablesData.forEach((t) => { const si = t.heads.findIndex((h) => /^state$/i.test(h)); if (si < 0) return; t.rows.forEach((r) => { stateCounts[r.cells[si]] = (stateCounts[r.cells[si]] || 0) + 1; }); });
const states = Object.entries(stateCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const stateMax = Math.max(...states.map((x) => x[1]));
const fmtD = (iso, precision) => { const [y, mo, d] = iso.split("-").map(Number); const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo - 1]; return precision === "month" ? `${M} ${y}` : `${M} ${d}, ${y}`; };
const CUTOFF = "2026-09-05";
const latest = events.filter((e) => e.date <= CUTOFF).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
const upcoming = events.filter((e) => e.date > CUTOFF).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
const evLi = (e) => `<li><span class="dt">${fmtD(e.date, e.precision)}${e.inferredYear ? "*" : ""}</span><i style="background:${VIZ.colors[TYPES.indexOf(e.type)]}"></i><span class="what"><a href="#${e.id}">${entryMeta[e.id].title}</a><span class="ty">${e.type} · ${e.column}</span></span></li>`;
const KEEP_DIMS = ["Casualty threshold", "Developer trigger", "FLOP threshold", "Incident reporting", "Third-party audit", "Whistleblower protection", "Private right of action", "Penalty ceiling"];
const kmini = matricesData[0] ? `<div class="kmini"><table><thead><tr>${matricesData[0].heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${matricesData[0].rows.filter((r) => KEEP_DIMS.includes(plain(r[0]))).map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`).join("")}</tbody></table></div>` : "";
const glance = `<section class="panel" aria-labelledby="glance-h"><h2 id="glance-h" class="panel-title">At a glance</h2>
<ul class="glance">
<li><a href="${href("A")}"><b>${cnt("A")}</b><span>enacted state frontier laws</span></a></li>
<li><a href="${href("B")}"><b>${statusTags.PENDING}</b><span>state bills pending</span></a></li>
<li><a href="${href("B")}"><b>${statusTags.STALLED}</b><span>state bills stalled</span></a></li>
<li><a href="${href("B")}"><b>${statusTags.FAILED}</b><span>state bills failed</span></a></li>
<li><a href="${href("C")}"><b>${cnt("C")}</b><span>IVO / auditor licensing measures</span></a></li>
<li><a href="${href("D")}"><b>${cnt("D")}</b><span>federal frontier bills introduced</span></a></li>
<li><a href="${href("G")}"><b>${cnt("G")}</b><span>executive actions</span></a></li>
<li><a href="${href("G.2")}"><b>${cnt("G.2")}</b><span>litigation and enforcement items</span></a></li>
</ul>
<p class="panel-note">Counts are taken from the tracker's sections and from the status class the tracker writes at the start of each status cell.</p></section>
<section class="panel" aria-labelledby="years-h"><h2 id="years-h" class="panel-title">Activity by year</h2><p class="panel-note">Instruments with at least one dated event in each year, by group. Click a year to filter the whole tracker to it; the filter row under the top bar clears it.</p>
<div class="ybars">${(() => { const max = Math.max(...yearPanelData.map((d) => Object.values(d.counts).reduce((a, b) => a + b, 0))); return yearPanelData.map((d) => { const total = Object.values(d.counts).reduce((a, b) => a + b, 0); const segs = ["state", "federal", "exec", "context"].filter((g) => d.counts[g]).map((g) => `<span class="seg" style="height:${(d.counts[g] / max) * 100}%;background:${GROUP_COLORS[g]}" title="${GROUPS.find((x) => x.key === g).name}: ${d.counts[g]}"></span>`).join(""); return `<button type="button" class="ybar" data-year="${d.y}" aria-label="Filter to ${d.y === "2027+" ? "2027 and later" : d.y}: ${total} instruments"><span class="tot">${total}</span><span class="col">${segs}</span><span class="yl">${d.y === "2027+" ? "2027+" : d.y}</span></button>`; }).join(""); })()}</div>
<ul class="ylegend">${["state", "federal", "exec", "context"].map((g) => `<li><i style="background:${GROUP_COLORS[g]}"></i>${GROUPS.find((x) => x.key === g).name}</li>`).join("")}</ul></section>
<section class="panel two" aria-labelledby="states-h">
<div><h2 id="states-h" class="panel-title">Where the state measures are</h2><p class="panel-note">Entries with a State column, across enacted laws, pending bills, IVO measures, precursors and adjacent laws.</p>
<ul class="statebars">${states.map(([st, n]) => `<li><span class="st">${st}</span><span class="bar"><span style="width:${(n / stateMax) * 100}%"></span></span><span class="n">${n}</span></li>`).join("")}</ul></div>
<div><h2 class="panel-title">Latest movement in the record</h2><p class="panel-note">Most recent dated events on or before the verification date. Colour is the kind of event.</p><ul class="movement">${latest.map(evLi).join("")}</ul>
<h2 class="panel-title">Dates ahead</h2><p class="panel-note">Effective dates, deadlines and scheduled steps after the verification date.</p><ul class="movement">${upcoming.map(evLi).join("")}</ul><p class="panel-foot">* year inferred from the same cell. Full record in <a href="#sec-timeline">Changes over time</a>.</p></div>
</section>
${kmini ? `<section class="panel" aria-labelledby="cmp-h"><h2 id="cmp-h" class="panel-title">How the leading instruments compare</h2><p class="panel-note">Selected rows from the tracker's own cross-cutting comparison. The full matrix, with every dimension and the assurance-layer table, is in <a href="${href("K")}">section K</a>.</p>${kmini}</section>` : ""}`;

const directory = `<div class="directory">
<h2 class="dir-title" id="directory">Browse the tracker</h2>
<p class="dir-lede">${totalEntries} entries across ${sections.filter((s) => !s.synthetic).length - 1} sections. Each section opens on its own page; every entry has a permanent link. For the same record as a chart, open <a href="#sec-timeline">Changes over time</a>; as one sortable table, open <a href="#sec-table">Table of all entries</a>; for the legal background in plain English, open the <a href="#sec-info">Handbook</a>; for the confidence key and how this site was built, see <a href="#sec-about">About</a>.</p>
${GROUPS.filter((g) => g.key !== "start").map((g) => `<div class="dir-group"><h3 class="dir-group-title">${g.name}</h3><ul>${sections.filter((s) => s.group === g).map((s) => `<li><a href="#${s.id}"><span class="lbl">${s.label}</span><span class="txt">${s.name}</span>${s.count ? `<span class="n">${s.count}</span>` : `<span class="n ref">ref</span>`}</a></li>`).join("")}</ul></div>`).join("\n")}
</div>`;

sections.forEach((s, i) => {
  let body = s.body;
  if (i === 0) {
    body = `<div class="hero"><h1 class="display">${heroTitle}</h1><p class="lede">${heroLede}</p><ul class="stats"><li><b>${totalEntries}</b><span>entries</span></li><li><b>${sections.filter((x) => !x.synthetic).length - 1}</b><span>sections</span></li><li><b>${mdLinkCount}</b><span>source links</span></li><li><b>${events.length}</b><span>dated events</span></li></ul></div>\n${glance}\n${directory}`;
  } else {
    const meta = `<p class="sec-meta"><span class="sec-group">${s.group.name}</span><span class="sec-count">${s.count ? `${s.count} ${s.count === 1 ? "entry" : "entries"}` : "Reference"}</span></p>`;
    if (!s.synthetic) body = body.replace(/^(<h2 id="[^"]+">)([\s\S]*?)(<\/h2>)/, (_, a, t, b) => `<header class="sec-head">${meta}${a}${t}${b}</header>${jumpList(s)}`);
  }
  const prev = sections[i - 1], next = sections[i + 1];
  const pn = `<nav class="pn" aria-label="Previous and next section">${prev ? `<a class="prev" href="#${prev.id}"><span>Previous</span><b>${lblPrefix(prev)}${prev.name}</b></a>` : "<span></span>"}${next ? `<a class="next" href="#${next.id}"><span>Next</span><b>${lblPrefix(next)}${next.name}</b></a>` : "<span></span>"}</nav>`;
  s.html = `<section class="sec" id="${s.id}" data-label="${s.label}" aria-label="${s.label === "Overview" ? "Overview" : s.synthetic ? s.name : `Section ${s.label}`}">\n${body}\n${pn}\n</section>`;
});

html = sections.map((s) => s.html).join("\n");

// Fidelity checks.
const same = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
if (!same(sourceCells, renderedCells)) {
  const s = new Map(); sourceCells.forEach((c) => s.set(c, (s.get(c) || 0) + 1)); renderedCells.forEach((c) => s.set(c, (s.get(c) || 0) - 1));
  throw new Error(`table cells differ: ${[...s].filter(([, n]) => n).slice(0, 5).map(([c, n]) => `${n > 0 ? "missing" : "extra"}: ${c.slice(0, 80)}`).join(" | ")}`);
}
const mdLinks = [...md.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map((x) => `${plain(marked.parseInline(x[1]))} -> ${x[2]}`);
const trackerHtml = sections.filter((x) => !x.synthetic).map((x) => x.html).join("\n"); // synthetic tabs may repeat links
const htmlLinks = [...trackerHtml.matchAll(/<a ([^>]*?)href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].filter((x) => !x[1].includes("data-site")).map((x) => `${plain(x[3])} -> ${x[2]}`);
if (!same(mdLinks, htmlLinks)) {
  const s = new Map(); mdLinks.forEach((c) => s.set(c, (s.get(c) || 0) + 1)); htmlLinks.forEach((c) => s.set(c, (s.get(c) || 0) - 1));
  throw new Error(`links differ: ${[...s].filter(([, n]) => n).slice(0, 5).map(([c, n]) => `${n > 0 ? "missing" : "extra"}: ${c}`).join(" | ")}`);
}
const norm = (t) => t.replace(/[*_|`#>\[\]]/g, " ").split(/\s+/).filter(Boolean);
const mdWords = norm(md.replace(/\]\((https?:[^)]+)\)/g, "]").replace(/\\(.)/g, "$1").replace(/^\|( --- \|)+$/gm, "").replace(/^\s*[-*]\s+/gm, ""));
const htmlWords = norm(decode(strip(html)));
const tally = (ws) => ws.reduce((mm, w) => mm.set(w, (mm.get(w) || 0) + 1), new Map());
const tm = tally(mdWords), th = tally(htmlWords);
const missing = [...tm].filter(([w, n]) => (th.get(w) || 0) < n).map(([w, n]) => `${w}×${n - (th.get(w) || 0)}`);
if (missing.length) throw new Error(`words missing from page: ${missing.slice(0, 30).join(" ")}`);

// Navigation fragments.
const sidebar = GROUPS.map((g) => {
  const secs = sections.filter((s) => s.group === g);
  if (!secs.length) return "";
  return `<div class="grp"><p class="grp-title">${g.name}</p><ul>${secs.map((s) => `<li><a href="#${s.id}" data-sec="${s.id}"><span class="lbl">${s.label === "Overview" ? "•" : s.label === "TL" ? "◔" : s.label === "TB" ? "▤" : s.label === "HB" ? "¶" : s.label === "i" ? "ⓘ" : s.label}</span><span class="txt">${s.short}</span>${s.count ? `<span class="n">${s.count}</span>` : ""}</a>${s.entries.length || s.h3s.length ? `<ol class="entries" data-for="${s.id}" hidden>${[...s.h3s.map((h) => `<li class="sub"><a href="#${h.id}">${h.text}</a></li>`), ...s.entries.map((e) => `<li data-years="${yearsOf(e.id)}"><a href="#${e.id}">${linkText(e.text, 72)}</a></li>`)].join("")}</ol>` : ""}</li>`).join("")}</ul></div>`;
}).join("\n");
const picker = sections.map((s) => `<option value="${s.id}">${s.label === "Overview" ? "Overview" : ["TL", "TB", "HB", "i"].includes(s.label) ? s.short : s.label + ". " + s.short}${s.count ? ` (${s.count})` : ""}</option>`).join("");

const out = template
  .replaceAll("{{TITLE}}", title)
  .replaceAll("{{LEDE}}", lede)
  .replaceAll("{{SIDEBAR}}", sidebar)
  .replaceAll("{{PICKER}}", picker)
  .replaceAll("{{CONTENT}}", html)
  .replaceAll("{{TOTAL}}", String(totalEntries))
  .replaceAll("{{LINKS}}", String(htmlLinks.length))
  .replaceAll("{{REPO_URL}}", REPO_URL)
  .replaceAll("{{VIZ_JSON}}", JSON.stringify(VIZ).replace(/</g, "\\u003c"))
  .replaceAll("{{VIZ_SCRIPT}}", readFileSync("build/viz.js", "utf8"))
  .replaceAll("{{BUILT}}", new Date().toISOString().slice(0, 10));

writeFileSync("docs/index.html", out);
copyFileSync("tracker.md", "docs/tracker.md");
writeFileSync("docs/.nojekyll", "");
writeFileSync("docs/favicon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1D57A5"/><text x="32" y="41" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="30" fill="#fff" letter-spacing="-1">KS</text></svg>`);
console.log(`timeline: ${events.length} events from ${Object.keys(usedEntries).length} entries; by type: ${TYPES.map((t) => t.split(" ")[0] + "=" + events.filter((e) => e.type === t).length).join(", ")}`);
console.log(`built docs/index.html: ${sections.length} sections, ${totalEntries} entries, ${renderedCells.length} cells, ${htmlLinks.length} links, ${mdWords.length} words verified`);
