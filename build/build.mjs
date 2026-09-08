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
        const head = "<tr>" + heads.map((h) => `<th>${h}</th>`).join("") + "</tr>";
        const body = rows.map((r) => "<tr>" + r.map((c, i) => { renderedCells.push(plain(c)); return i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`; }).join("") + "</tr>").join("\n");
        return `<div class="matrix"><table><thead>${head}</thead><tbody>\n${body}\n</tbody></table></div>\n`;
      }

      if (heads.length === 2) {
        const items = rows.map((r) => { renderedCells.push(plain(r[0]), plain(r[1])); return `<div class="pair" id="${uniq("rec-" + slug(r[0]).slice(0, 70))}"><dt><span class="vh">${heads[0]}: </span>${r[0]}</dt><dd><span class="lbl">${heads[1]}</span>${r[1]}</dd></div>`; }).join("\n");
        return `<div class="pairs" data-count="${rows.length}"><dl>\n${items}\n</dl></div>\n`;
      }

      const stateIdx = heads.findIndex((h) => /^State$/i.test(strip(h)));
      const cards = rows.map((r) => {
        const id = uniq("rec-" + slug(r[0]).slice(0, 70));
        const chip = stateIdx >= 0 ? `<span class="chip state"><span class="vh">${heads[stateIdx]}: </span>${r[stateIdx]}</span>` : "";
        const facts = [], blocks = [];
        r.forEach((cell, i) => {
          if (i === 0 || i === stateIdx) return;
          const label = strip(heads[i]).toLowerCase();
          const isSource = label.startsWith("source");
          const short = plain(cell).length <= FACT_MAX && !isSource;
          const cls = label.startsWith("confidence") ? " conf" : isSource ? " src" : "";
          (short ? facts : blocks).push(`<div class="${short ? "fact" : "block"}${cls}"><dt>${heads[i]}</dt><dd>${cell}</dd></div>`);
        });
        r.forEach((c) => renderedCells.push(plain(c)));
        return `<article class="record" id="${id}">
<header class="record-head">${chip}<h3 class="title"><span class="vh">${heads[0]}: </span>${r[0]}</h3></header>
${facts.length ? `<dl class="facts">\n${facts.join("\n")}\n</dl>` : ""}
${blocks.length ? `<dl class="blocks">\n${blocks.join("\n")}\n</dl>` : ""}
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
  if (i === 0) { id = "sec-overview"; label = "Overview"; name = "Overview and confidence key"; }
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

const totalEntries = sections.reduce((n, s) => n + s.count, 0);
const mdLinkCount = (md.match(/\]\(https?:\/\//g) || []).length;
const linkText = (t, n = 96) => (t.length > n ? t.slice(0, n - 2).trimEnd() + "…" : t);
const jumpList = (s) => {
  const items = [...s.h3s.map((h) => `<li class="sub"><a href="#${h.id}">${h.text}</a></li>`), ...s.entries.map((e) => `<li><a href="#${e.id}">${linkText(e.text)}</a></li>`)];
  return items.length ? `<nav class="jump" aria-label="Entries in this section"><p class="jump-title">In this section</p><ol>${items.join("")}</ol></nav>` : "";
};

sections.forEach((s, i) => {
  let body = s.body;
  if (i === 0) {
    body = body.replace(/<h1>([\s\S]*?)<\/h1>\n<p>([\s\S]*?)<\/p>/, (_, h, l) => `<div class="hero"><p class="eyebrow">Primary-source audit · verified as of September 5, 2026</p><h1 class="display">${h}</h1><p class="lede">${l}</p><ul class="stats"><li><b>${totalEntries}</b><span>entries</span></li><li><b>${sections.length - 1}</b><span>sections</span></li><li><b>${mdLinkCount}</b><span>source links</span></li><li><b>Sept 5, 2026</b><span>verified as of</span></li></ul></div>`);
  } else {
    const meta = `<p class="sec-meta"><span class="sec-group">${s.group.name}</span><span class="sec-count">${s.count ? `${s.count} ${s.count === 1 ? "entry" : "entries"}` : "Reference"}</span></p>`;
    body = body.replace(/^(<h2 id="[^"]+">)([\s\S]*?)(<\/h2>)/, (_, a, t, b) => `<header class="sec-head">${meta}${a}${t}${b}</header>${jumpList(s)}`);
  }
  const prev = sections[i - 1], next = sections[i + 1];
  const pn = `<nav class="pn" aria-label="Previous and next section">${prev ? `<a class="prev" href="#${prev.id}"><span>Previous</span><b>${prev.label === "Overview" ? "" : prev.label + ". "}${prev.name}</b></a>` : "<span></span>"}${next ? `<a class="next" href="#${next.id}"><span>Next</span><b>${next.label}. ${next.name}</b></a>` : "<span></span>"}</nav>`;
  s.html = `<section class="sec" id="${s.id}" data-label="${s.label}" aria-label="${s.label === "Overview" ? "Overview" : `Section ${s.label}`}">\n${body}\n${pn}\n</section>`;
});

// Directory on the overview page.
const directory = `<div class="directory">
<h2 class="dir-title" id="directory">Browse the tracker</h2>
<p class="dir-lede">${totalEntries} entries across ${sections.length - 1} sections. Each section opens on its own page; every entry has a permanent link.</p>
${GROUPS.filter((g) => g.key !== "start").map((g) => `<div class="dir-group"><h3 class="dir-group-title">${g.name}</h3><ul>${sections.filter((s) => s.group === g).map((s) => `<li><a href="#${s.id}"><span class="lbl">${s.label}</span><span class="txt">${s.name}</span>${s.count ? `<span class="n">${s.count}</span>` : `<span class="n ref">ref</span>`}</a></li>`).join("")}</ul></div>`).join("\n")}
</div>`;
sections[0].html = sections[0].html.replace(/<nav class="pn"/, `${directory}\n<nav class="pn"`);

html = sections.map((s) => s.html).join("\n");

// Fidelity checks.
const same = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
if (!same(sourceCells, renderedCells)) {
  const s = new Map(); sourceCells.forEach((c) => s.set(c, (s.get(c) || 0) + 1)); renderedCells.forEach((c) => s.set(c, (s.get(c) || 0) - 1));
  throw new Error(`table cells differ: ${[...s].filter(([, n]) => n).slice(0, 5).map(([c, n]) => `${n > 0 ? "missing" : "extra"}: ${c.slice(0, 80)}`).join(" | ")}`);
}
const mdLinks = [...md.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map((x) => `${plain(marked.parseInline(x[1]))} -> ${x[2]}`);
const htmlLinks = [...html.matchAll(/<a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((x) => `${plain(x[2])} -> ${x[1]}`);
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
  return `<div class="grp"><p class="grp-title">${g.name}</p><ul>${secs.map((s) => `<li><a href="#${s.id}" data-sec="${s.id}"><span class="lbl">${s.label === "Overview" ? "•" : s.label}</span><span class="txt">${s.short}</span>${s.count ? `<span class="n">${s.count}</span>` : ""}</a>${s.entries.length || s.h3s.length ? `<ol class="entries" data-for="${s.id}" hidden>${[...s.h3s.map((h) => `<li class="sub"><a href="#${h.id}">${h.text}</a></li>`), ...s.entries.map((e) => `<li><a href="#${e.id}">${linkText(e.text, 72)}</a></li>`)].join("")}</ol>` : ""}</li>`).join("")}</ul></div>`;
}).join("\n");
const picker = sections.map((s) => `<option value="${s.id}">${s.label === "Overview" ? "Overview" : s.label + ". " + s.short}${s.count ? ` (${s.count})` : ""}</option>`).join("");

const out = template
  .replaceAll("{{TITLE}}", title)
  .replaceAll("{{LEDE}}", lede)
  .replaceAll("{{SIDEBAR}}", sidebar)
  .replaceAll("{{PICKER}}", picker)
  .replaceAll("{{CONTENT}}", html)
  .replaceAll("{{TOTAL}}", String(totalEntries))
  .replaceAll("{{LINKS}}", String(htmlLinks.length))
  .replaceAll("{{REPO_URL}}", REPO_URL)
  .replaceAll("{{BUILT}}", new Date().toISOString().slice(0, 10));

writeFileSync("docs/index.html", out);
copyFileSync("tracker.md", "docs/tracker.md");
writeFileSync("docs/.nojekyll", "");
console.log(`built docs/index.html: ${sections.length} sections, ${totalEntries} entries, ${renderedCells.length} cells, ${htmlLinks.length} links, ${mdWords.length} words verified`);
