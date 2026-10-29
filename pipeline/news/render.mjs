// Reading an official release the way a reader sees it (audit, 29 Oct 2026: pattern stripping of hidden HTML let 14 of 20 tricks
// through). The page is loaded in a headless browser (Playwright chromium) and only words a reader can see are kept: each word must
// have a box on the page, be the top element at its own spot (so it is not clipped, covered, off-page or inside a collapsed
// <details>), be at least MIN_FONT_PX tall, not be (nearly) transparent, not be aria-hidden, and differ in colour from the background
// behind it. <template>, <noscript> (scripts run), comments and anything not rendered never have a box, so they are never read.
// Quotes and numbers are checked against this text only (news/write.mjs).
//   createRenderer({ allowHosts, userAgent, allowed }) -> { render(url) -> { text, finalUrl }, renderHtml(html) -> text, close() }
//     allowHosts: hosts a release may end up on after redirects (config/news-sources.json, primary feeds); any other final host is
//     refused (RedirectRefused). allowed(url) -> bool: robots.txt (news/run.mjs createReader). A failed page load throws.
//   The browser is started on first use; if it cannot start, BrowserUnavailable is thrown (news drafts are held, the run goes on).
import { cleanRelease } from './feeds.mjs';

export class BrowserUnavailable extends Error {}
export class RedirectRefused extends Error {}
export class PageFailed extends Error {}

const MIN_FONT_PX = 6, MIN_CONTRAST = 1.6, MAX_VIEW_HEIGHT = 30000;
const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
export const hostOf = (u) => { try { return bare(new URL(u).host); } catch { return null; } };

// Runs inside the page. Returns the visible text of the release region with a newline between blocks.
/* c8 ignore start */
function visibleTextInPage(opts) {
  const { minFont, minContrast } = opts;
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const blend = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const cache = new Map();
  function elementOk(el) {
    if (cache.has(el)) return cache.get(el);
    let ok = true;
    if (el.closest('[aria-hidden="true"],template,noscript,nav,header,footer,aside,form,section.usa-banner,script,style')) ok = false;
    else if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) ok = false;
    else {
      const cs = getComputedStyle(el);
      if (parseFloat(cs.fontSize) < minFont) ok = false;
      let op = 1; for (let e = el; e; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity);
      if (op < 0.2) ok = false;
      const fill = parse(cs.webkitTextFillColor) || parse(cs.color), color = parse(cs.color);
      const fg = fill && color && fill.a > 0 ? fill : color;
      if (!fg || fg.a < 0.2) ok = false;
      else {
        // the background behind: the first ancestor's colour layered down to white
        const layers = [];
        for (let e = el; e; e = e.parentElement) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b.a > 0) { layers.push(b); if (b.a >= 1) break; } }
        let bg = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
        if (contrast(blend(fg, bg), bg) < minContrast) ok = false;
      }
    }
    cache.set(el, ok);
    return ok;
  }
  const root = document.querySelector('main') || document.querySelector('article') || document.body;
  const anchor = root === document.body ? document.querySelector('a#main-content, #main-content') : null;
  const blockOf = (el) => { for (let e = el; e && e !== root.parentElement; e = e.parentElement) { const d = getComputedStyle(e).display; if (!/^inline/.test(d) && d !== 'contents') return e; } return root; };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out = []; let lastBlock = null, lastSpace = false, n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement; if (!el || !n.data.trim()) continue;
    if (anchor && (anchor.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
    if (!elementOk(el)) continue;
    const words = []; const re = /\S+/g; let m;
    while ((m = re.exec(n.data))) {
      const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
      const rects = [...r.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
      const seen = rects.length > 0 && rects.every((b) => {
        if (b.height < minFont * 0.8 || b.width < 1) return false;
        const x = b.left + b.width / 2, y = b.top + b.height / 2;
        if (x < 0 || y < 0 || x > document.documentElement.clientWidth || y > window.innerHeight) return false;
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      });
      if (seen) words.push(m[0]);
    }
    if (!words.length) continue;
    const blk = blockOf(el);
    if (lastBlock && blk !== lastBlock) out.push('\n');
    else if (out.length && (lastSpace || /^\s/.test(n.data))) out.push(' ');
    out.push(words.join(' ')); lastBlock = blk; lastSpace = /\s$/.test(n.data);
  }
  return out.join('');
}
/* c8 ignore stop */

export function createRenderer({ allowHosts = [], userAgent = 'us-frontier-ai-tracker-pipeline/0.1', allowed = async () => true, launch = null, timeoutMs = 30000 } = {}) {
  const allow = new Set(allowHosts.map(bare));
  let browser = null, starting = null, offline = null;
  async function getBrowser() {
    if (browser) return browser;
    if (!starting) starting = (async () => {
      try {
        if (launch) return await launch();
        const { chromium } = await import('playwright');
        return await chromium.launch({ headless: true });
      } catch (e) { throw new BrowserUnavailable(`the headless browser could not start: ${String(e.message || e).split('\n')[0]}`); }
    })();
    try { browser = await starting; } catch (e) { starting = null; throw e; }
    return browser;
  }
  async function extract(page) {
    // a viewport as tall as the page, so every word can be hit-tested where it is
    const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
    await page.setViewportSize({ width: 1280, height: Math.min(Math.max(800, Math.ceil(h)), MAX_VIEW_HEIGHT) });
    const h2 = await page.evaluate(() => document.documentElement.scrollHeight);
    if (h2 > MAX_VIEW_HEIGHT) throw new PageFailed(`the page is taller than ${MAX_VIEW_HEIGHT}px; not read`);
    const raw = await page.evaluate(visibleTextInPage, { minFont: MIN_FONT_PX, minContrast: MIN_CONTRAST });
    return cleanRelease(raw);
  }
  async function withPage(fn) {
    const b = await getBrowser();
    const ctx = await b.newContext({ userAgent, viewport: { width: 1280, height: 800 }, javaScriptEnabled: true, serviceWorkers: 'block' });
    try {
      await ctx.route('**/*', (route) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
      const page = await ctx.newPage(); page.setDefaultTimeout(timeoutMs);
      return await fn(page);
    } finally { await ctx.close().catch(() => {}); }
  }
  return {
    async render(url) {
      if (!allow.has(hostOf(url))) throw new RedirectRefused(`${hostOf(url)} is not an official news source`);
      if (!(await allowed(url))) throw new PageFailed(`${hostOf(url)} does not allow automated reading of this page (robots.txt), or refused robots.txt`);
      return withPage(async (page) => {
        let resp;
        try { resp = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs }); }
        catch (e) { throw new PageFailed(`the release page could not be loaded: ${String(e.message || e).split('\n')[0]}`); }
        const finalUrl = page.url(), hops = [];
        for (let r = resp && resp.request(); r; r = r.redirectedFrom()) hops.push(r.url());
        const bad = [finalUrl, ...hops].find((u) => !allow.has(hostOf(u)));
        if (bad) throw new RedirectRefused(`the release redirects to ${hostOf(bad)}, which is not an official news source (final URL ${finalUrl})`);
        if (!resp || !resp.ok()) throw new PageFailed(`HTTP ${resp ? resp.status() : 'no response'} for ${hostOf(finalUrl)}`);
        if (finalUrl !== url && !(await allowed(finalUrl))) throw new PageFailed(`${hostOf(finalUrl)} does not allow automated reading of this page (robots.txt)`);
        return { text: await extract(page), finalUrl };
      });
    },
    // test and eval hook: a recorded page, rendered offline (no network; subresource requests are refused)
    // (one page is kept for these: starting a page process is slow on some machines)
    async renderHtml(html) {
      if (!offline) offline = (async () => {
        const b = await getBrowser();
        const ctx = await b.newContext({ userAgent, viewport: { width: 1280, height: 800 }, javaScriptEnabled: true, serviceWorkers: 'block', offline: true });
        await ctx.route('**/*', (route) => route.abort());
        const page = await ctx.newPage(); page.setDefaultTimeout(timeoutMs);
        return page;
      })().catch((e) => { offline = null; throw e; });
      const page = await offline;
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.setContent(String(html || ''), { waitUntil: 'load', timeout: timeoutMs });
      return extract(page);
    },
    async close() { offline = null; if (browser) { const b = browser; browser = null; starting = null; await b.close().catch(() => {}); } }
  };
}
