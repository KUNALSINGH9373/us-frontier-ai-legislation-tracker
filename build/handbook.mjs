// Renders handbook.md (the Plain-English Handbook) into the Info tab.
// Text is verbatim. Structure drives the visuals: glossary bullets become term
// cards, numbered lists become step cards, the source hierarchy becomes a
// ladder, the ten rules become rule cards. Each H2 is a chapter shown on its own.
import { Marked } from "marked";

const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const decode = (t) => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const slug = (s) => decode(strip(s)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Per-chapter presentation variants (class names only; text is unchanged).
const VARIANTS = {
  1: { ordered: ["hb-tiers", "hb-questions"] },
  14: { terms: " hb-scale" },
  15: { ordered: ["hb-ladder"] },
  19: { ordered: ["hb-workflow"] },
  20: { ordered: ["hb-rules"] },
};

export function renderHandbook(md) {
  const m = new Marked({ gfm: true });
  let variant = {}, orderedSeq = [];
  m.use({
    renderer: {
      heading({ tokens, depth }) {
        const t = this.parser.parseInline(tokens);
        if (depth === 3) return `<h4 class="hb-sub" id="hb-${slug(t)}">${t}</h4>\n`;
        return `<h${depth}>${t}</h${depth}>\n`;
      },
      hr() { return ""; },
      link({ href, tokens }) { const t = this.parser.parseInline(tokens); return `<a href="${href}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ""}>${t}</a>`; },
      blockquote({ tokens }) { return `<blockquote class="hb-callout">${this.parser.parse(tokens)}</blockquote>\n`; },
      table(token) {
        const head = "<tr>" + token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join("") + "</tr>";
        const body = token.rows.map((r) => "<tr>" + r.map((c, i) => `<${i === 0 ? 'th scope="row"' : "td"}>${this.parser.parseInline(c.tokens)}</${i === 0 ? "th" : "td"}>`).join("") + "</tr>").join("");
        return `<div class="hb-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>\n`;
      },
      list(token) {
        const items = token.items;
        const firstInline = (it) => (it.tokens && it.tokens[0] && it.tokens[0].type === "text" ? it.tokens[0].tokens : null);
        const isTerms = !token.ordered && items.length > 1 && items.every((it) => { const inl = firstInline(it); return inl && inl[0] && inl[0].type === "strong"; });
        if (isTerms) {
          const cards = items.map((it) => {
            const inl = firstInline(it);
            const term = this.parser.parseInline(inl[0].tokens).replace(/[:;]\s*$/, "");
            const rest = this.parser.parseInline(inl.slice(1)).replace(/^\s*[:—–-]\s*/, "");
            const more = it.tokens.slice(1).length ? this.parser.parse(it.tokens.slice(1)) : "";
            return `<div class="hb-term"><dt>${term}</dt><dd>${rest}${more}</dd></div>`;
          }).join("");
          return `<dl class="hb-terms${variant.terms || ""}">${cards}</dl>\n`;
        }
        const cls = token.ordered ? (orderedSeq.shift() || "hb-steps") : "hb-list";
        const body = items.map((it) => `<li>${this.parser.parse(it.tokens)}</li>`).join("");
        return token.ordered ? `<ol class="${cls}">${body}</ol>\n` : `<ul class="${cls}">${body}</ul>\n`;
      },
    },
  });

  const tokens = m.lexer(md);
  const chapters = []; let cur = null; const pre = [];
  let title = "";
  for (const t of tokens) {
    if (t.type === "heading" && t.depth === 1) { title = t.text; continue; }
    if (t.type === "heading" && t.depth === 2) {
      const mm = t.text.match(/^(\d+)\.\s+(.*)$/);
      cur = { num: mm ? Number(mm[1]) : null, title: mm ? mm[2] : t.text, id: mm ? `hb-${mm[1]}` : "hb-" + slug(t.text), tokens: [] };
      chapters.push(cur); continue;
    }
    (cur ? cur.tokens : pre).push(t);
  }

  const preamble = m.parser(pre);
  const chapterHtml = chapters.map((ch, i) => {
    variant = VARIANTS[ch.num] || {}; orderedSeq = [...(variant.ordered || [])];
    const subs = ch.tokens.filter((t) => t.type === "heading" && t.depth === 3).map((t) => ({ text: t.text, id: "hb-" + slug(m.parseInline(t.text)) }));
    const subnav = subs.length ? `<nav class="hb-subnav" aria-label="In this chapter">${subs.map((s) => `<a href="#${s.id}">${m.parseInline(s.text)}</a>`).join("")}</nav>` : "";
    const body = m.parser(ch.tokens);
    const prev = chapters[i - 1], next = chapters[i + 1];
    const pn = `<nav class="hb-pn">${prev ? `<a href="#${prev.id}" class="prev"><span>Previous chapter</span><b>${prev.num ? prev.num + ". " : ""}${prev.title}</b></a>` : "<span></span>"}${next ? `<a href="#${next.id}" class="next"><span>Next chapter</span><b>${next.num ? next.num + ". " : ""}${next.title}</b></a>` : "<span></span>"}</nav>`;
    return `<article class="hb-ch" id="${ch.id}" data-num="${ch.num || ""}"><header class="hb-ch-head">${ch.num ? `<span class="hb-num">${ch.num}</span>` : `<span class="hb-num">§</span>`}<h3>${ch.title}</h3></header>${subnav}<div class="hb-body">${body}</div>${pn}</article>`;
  }).join("\n");

  const grid = `<nav class="hb-grid" aria-label="Chapters">${chapters.map((ch) => `<a href="#${ch.id}" data-ch="${ch.id}"><span class="n">${ch.num || "§"}</span><span class="t">${ch.title}</span></a>`).join("")}</nav>`;
  return { title, preamble, grid, chapterHtml, chapters: chapters.map((c) => ({ id: c.id, num: c.num, title: c.title })) };
}
