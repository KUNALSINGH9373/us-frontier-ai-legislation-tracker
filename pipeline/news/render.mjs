// Reading an official release the way a reader sees it (audit, 29 Oct 2026: pattern stripping of hidden HTML let 14 of 20 tricks
// through). The page is loaded in a headless browser (Playwright chromium) and only words a reader can see are kept.
//   1. first pass (in the page): each word must have a box on the page, be the top element at its own spot (not clipped, covered,
//      off-page or inside a collapsed <details>), be at least MIN_FONT_PX tall, not be (nearly) transparent, not be aria-hidden, and
//      differ in colour from the background behind it. <template>, <noscript>, comments and anything not rendered have no box.
//   2. pixel check (review N1, 29 Oct 2026: SVG fill, CSS filter, mix-blend-mode, masks, gradient backgrounds, overlays that ignore the
//      pointer, ::after overlays all fooled pass 1): the page is screenshotted, then re-rendered with the text made transparent; a word
//      is kept only if the pixels inside its own box change. Words whose boxes overlap another text's box are checked one element at a
//      time (bounded; past the bound they are dropped). Scripts are stopped before the check, so the page cannot change between shots.
// Quotes and numbers are checked against this text only (news/write.mjs).
//   createRenderer({ allowHosts, userAgent, allowed }) -> { render(url) -> { text, finalUrl }, renderHtml(html) -> text, close() }
//     allowHosts: hosts a release may end up on after redirects (config/news-sources.json, primary feeds); any other host is refused
//     (RedirectRefused), for the first load, every redirect hop, any later navigation of the page (script or meta refresh) and the
//     URL after reading. allowed(url) -> bool: robots.txt (news/run.mjs createReader). A failed page load or a read that takes longer
//     than readMs throws PageFailed (the release is held and retried).
//   The browser is started on first use; if it cannot start, BrowserUnavailable is thrown (news drafts are held, the run goes on).
import { PNG } from 'pngjs';
import { cleanRelease } from './feeds.mjs';

export class BrowserUnavailable extends Error {}
export class RedirectRefused extends Error {}
export class PageFailed extends Error {}

const MIN_FONT_PX = 6, MIN_CONTRAST = 1.6, MAX_VIEW_HEIGHT = 30000, MAX_SINGLE_CHECKS = 60;
// a word is seen when at least this share of the pixels in its box (and at least MIN_CHANGED_PX of them) change when its text is
// made transparent; a pixel counts as changed when its red+green+blue differ by more than PIXEL_DELTA
const MIN_CHANGED_SHARE = 0.03, MIN_CHANGED_PX = 2, PIXEL_DELTA = 48;
const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
export const hostOf = (u) => { try { return bare(new URL(u).host); } catch { return null; } };

// Runs inside the page. Candidate text nodes with their words and word boxes (page = viewport coordinates; the viewport is as tall as
// the page). The element of each node is kept in window.__vtEls for the pixel check.
/* c8 ignore start */
function firstPassInPage(opts) {
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
      if (!(el instanceof SVGElement) && (!fg || fg.a < 0.2)) ok = false;
      else if (!(el instanceof SVGElement)) {
        // (a background image on the way down: the colour behind is not known here; the pixel check decides)
        const layers = []; let image = false;
        for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage && s.backgroundImage !== 'none') { image = true; break; } const b = parse(s.backgroundColor); if (b && b.a > 0) { layers.push(b); if (b.a >= 1) break; } }
        let bg = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
        if (!image && contrast(blend(fg, bg), bg) < minContrast) ok = false;
      }
    }
    cache.set(el, ok);
    return ok;
  }
  const root = document.querySelector('main') || document.querySelector('article') || document.body;
  const anchor = root === document.body ? document.querySelector('a#main-content, #main-content') : null;
  const blockOf = (el) => { for (let e = el; e && e !== root.parentElement; e = e.parentElement) { const d = getComputedStyle(e).display; if (!/^inline/.test(d) && d !== 'contents') return e; } return root; };
  const blocks = new Map(), els = [], elIds = new Map(), nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const W = document.documentElement.clientWidth, H = window.innerHeight;
  let n;
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
        if (x < 0 || y < 0 || x > W || y > H) return false;
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      });
      if (seen) words.push({ w: m[0], rects: rects.map((b) => ({ x: Math.max(0, Math.floor(b.left)), y: Math.max(0, Math.floor(b.top)), x2: Math.min(W, Math.ceil(b.right)), y2: Math.min(H, Math.ceil(b.bottom)) })) });
    }
    if (!words.length) continue;
    const blk = blockOf(el); if (!blocks.has(blk)) blocks.set(blk, blocks.size);
    if (!elIds.has(el)) { elIds.set(el, els.length); els.push(el); }
    nodes.push({ el: elIds.get(el), block: blocks.get(blk), lead: /^\s/.test(n.data), trail: /\s$/.test(n.data), words });
  }
  window.__vtEls = els;
  return nodes;
}
// Makes the text of the given elements (all when ids is null) transparent, or restores it.
function hideTextInPage({ ids, on }) {
  const els = window.__vtEls || [];
  (ids || els.map((_, i) => i)).forEach((i) => {
    const el = els[i]; if (!el) return;
    if (on) {
      if (el.__vtStyle === undefined) el.__vtStyle = el.getAttribute('style');
      for (const p of ['color', '-webkit-text-fill-color', 'fill', 'stroke', 'text-decoration-color', 'caret-color']) el.style.setProperty(p, 'transparent', 'important');
      el.style.setProperty('transition', 'none', 'important');
    } else if (el.__vtStyle !== undefined) {
      if (el.__vtStyle === null) el.removeAttribute('style'); else el.setAttribute('style', el.__vtStyle);
      delete el.__vtStyle;
    }
  });
}
/* c8 ignore stop */

const shot = async (page, clip) => PNG.sync.read(await page.screenshot({ clip, animations: 'disabled', caret: 'hide', type: 'png', scale: 'css' }));
// changed pixels inside a word's boxes, as { changed, area }
function diffWord(a, b, clip, rects) {
  let changed = 0, area = 0;
  for (const r of rects) for (let y = r.y; y < r.y2; y++) for (let x = r.x; x < r.x2; x++) {
    const px = x - clip.x, py = y - clip.y; if (px < 0 || py < 0 || px >= a.width || py >= a.height) continue;
    const i = (py * a.width + px) * 4; area++;
    if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > PIXEL_DELTA) changed++;
  }
  return { changed, area };
}
const seenBy = ({ changed, area }) => area > 0 && changed >= MIN_CHANGED_PX && changed >= area * MIN_CHANGED_SHARE;
const overlaps = (r, s) => r.x < s.x2 && s.x < r.x2 && r.y < s.y2 && s.y < r.y2;

// The pixel check over the first pass's nodes; returns the release text.
async function pixelCheck(page, nodes) {
  const all = nodes.flatMap((n) => n.words.flatMap((w) => w.rects));
  if (!all.length) return '';
  const clip = { x: Math.min(...all.map((r) => r.x)), y: Math.min(...all.map((r) => r.y)) };
  clip.width = Math.max(1, Math.max(...all.map((r) => r.x2)) - clip.x); clip.height = Math.max(1, Math.max(...all.map((r) => r.y2)) - clip.y);
  const base = await shot(page, clip);
  await page.evaluate(hideTextInPage, { ids: null, on: true });
  const gone = await shot(page, clip);
  await page.evaluate(hideTextInPage, { ids: null, on: false });
  // words whose box overlaps a box of another element's word: hiding everything at once cannot tell them apart, so their element is
  // checked alone (a hidden sentence laid over a visible one)
  const items = nodes.flatMap((n) => n.words.map((w) => ({ n, w })));
  const rows = new Map(); const key = (y) => Math.floor(y / 32);
  items.forEach((it) => it.w.rects.forEach((r) => { for (let k = key(r.y); k <= key(r.y2); k++) { if (!rows.has(k)) rows.set(k, []); rows.get(k).push(it); } }));
  const single = new Set();
  for (const it of items) for (const r of it.w.rects) for (let k = key(r.y); k <= key(r.y2); k++) for (const o of rows.get(k) || []) if (o.n.el !== it.n.el && o.w.rects.some((s) => overlaps(r, s))) single.add(it.n.el);
  const singleOk = new Map(); let checks = 0;
  for (const el of single) {
    if (++checks > MAX_SINGLE_CHECKS) break; // past the bound: dropped (fail closed)
    await page.evaluate(hideTextInPage, { ids: [el], on: true });
    const img = await shot(page, clip);
    await page.evaluate(hideTextInPage, { ids: [el], on: false });
    singleOk.set(el, img);
  }
  const out = []; let lastBlock = null, lastSpace = false;
  for (const n of nodes) {
    const words = n.words.filter((w) => {
      if (single.has(n.el)) { const img = singleOk.get(n.el); const ok1 = !!img && seenBy(diffWord(base, img, clip, w.rects)); return ok1; }
      const d = diffWord(base, gone, clip, w.rects); return seenBy(d);
    }).map((w) => w.w);
    if (!words.length) continue;
    if (lastBlock !== null && n.block !== lastBlock) out.push('\n');
    else if (out.length && (lastSpace || n.lead)) out.push(' ');
    out.push(words.join(' ')); lastBlock = n.block; lastSpace = n.trail;
  }
  return out.join('');
}

export function createRenderer({ allowHosts = [], userAgent = 'us-frontier-ai-tracker-pipeline/0.1', allowed = async () => true, launch = null, timeoutMs = 30000, readMs = 90000 } = {}) {
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
  const cdps = new WeakMap();
  const cdpOf = (page) => { if (!cdps.has(page)) cdps.set(page, page.context().newCDPSession(page).catch(() => null)); return cdps.get(page); };
  async function scripts(page, on) {
    try { const cdp = await cdpOf(page); if (cdp) await cdp.send('Emulation.setScriptExecutionDisabled', { value: !on }); }
    catch { /* not chromium: the shots are still taken back to back */ }
  }
  async function extract(page) {
    const work = (async () => {
      const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
      await page.setViewportSize({ width: 1280, height: Math.min(Math.max(800, Math.ceil(h)), MAX_VIEW_HEIGHT) });
      const h2 = await page.evaluate(() => document.documentElement.scrollHeight);
      if (h2 > MAX_VIEW_HEIGHT) throw new PageFailed(`the page is taller than ${MAX_VIEW_HEIGHT}px; not read`);
      await scripts(page, false);
      const nodes = await page.evaluate(firstPassInPage, { minFont: MIN_FONT_PX, minContrast: MIN_CONTRAST });
      return cleanRelease(await pixelCheck(page, nodes));
    })();
    let timer;
    const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new PageFailed(`reading the release took longer than ${readMs / 1000}s; held`)), readMs); });
    try { return await Promise.race([work, limit]); } finally { clearTimeout(timer); work.catch(() => {}); }
  }
  async function withPage(fn) {
    const b = await getBrowser();
    const ctx = await b.newContext({ userAgent, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, javaScriptEnabled: true, serviceWorkers: 'block' });
    const blocked = [];
    try {
      await ctx.route('**/*', (route) => {
        const req = route.request();
        // a page or frame may never navigate to a host off the list (a script or meta refresh redirect after load included)
        if (req.isNavigationRequest() && !allow.has(hostOf(req.url()))) { blocked.push(req.url()); return route.abort(); }
        return ['image', 'media', 'font'].includes(req.resourceType()) ? route.abort() : route.continue();
      });
      const page = await ctx.newPage(); page.setDefaultTimeout(timeoutMs);
      return await fn(page, blocked);
    } finally { await ctx.close().catch(() => {}); }
  }
  return {
    async render(url) {
      if (!allow.has(hostOf(url))) throw new RedirectRefused(`${hostOf(url)} is not an official news source`);
      if (!(await allowed(url))) throw new PageFailed(`${hostOf(url)} does not allow automated reading of this page (robots.txt), or refused robots.txt`);
      return withPage(async (page, blocked) => {
        let resp;
        try { resp = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs }); }
        catch (e) {
          if (blocked.length) throw new RedirectRefused(`the release redirects to ${hostOf(blocked[0])}, which is not an official news source`);
          throw new PageFailed(`the release page could not be loaded: ${String(e.message || e).split('\n')[0]}`);
        }
        const finalUrl = page.url(), hops = [];
        for (let r = resp && resp.request(); r; r = r.redirectedFrom()) hops.push(r.url());
        const bad = [finalUrl, ...hops, ...blocked].find((u) => !allow.has(hostOf(u)));
        if (bad) throw new RedirectRefused(`the release redirects to ${hostOf(bad)}, which is not an official news source (final URL ${finalUrl})`);
        if (!resp || !resp.ok()) throw new PageFailed(`HTTP ${resp ? resp.status() : 'no response'} for ${hostOf(finalUrl)}`);
        if (finalUrl !== url && !(await allowed(finalUrl))) throw new PageFailed(`${hostOf(finalUrl)} does not allow automated reading of this page (robots.txt)`);
        let text;
        try { text = await extract(page); }
        catch (e) {
          if (blocked.length || page.url() !== finalUrl || /navigation|context was destroyed/i.test(e.message)) throw new RedirectRefused(`the release page navigated away while it was read (${blocked[0] || page.url()}); not read`);
          throw e instanceof PageFailed ? e : new PageFailed(`the release page could not be read: ${String(e.message || e).split('\n')[0]}`);
        }
        // the page must still be the one that was loaded (review N2: a script or meta refresh may navigate after load)
        if (page.url() !== finalUrl || blocked.length) throw new RedirectRefused(`the release page navigated away while it was read (${blocked[0] || page.url()}); not read`);
        return { text, finalUrl };
      });
    },
    // test and eval hook: a recorded page, rendered offline (no network; subresource requests are refused)
    // (one page is kept for these: starting a page process is slow on some machines; a read stops its scripts, so they are turned back
    // on before the next page is set)
    async renderHtml(html) {
      const make = async () => {
        const b = await getBrowser();
        const ctx = await b.newContext({ userAgent, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, javaScriptEnabled: true, serviceWorkers: 'block', offline: true });
        await ctx.route('**/*', (route) => route.abort());
        const page = await ctx.newPage(); page.setDefaultTimeout(timeoutMs);
        return page;
      };
      if (!offline) offline = make().catch((e) => { offline = null; throw e; });
      const page = await offline;
      await scripts(page, true);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.setContent(String(html || ''), { waitUntil: 'load', timeout: timeoutMs });
      return extract(page);
    },
    async close() { offline = null; if (browser) { const b = browser; browser = null; starting = null; await b.close().catch(() => {}); } }
  };
}
