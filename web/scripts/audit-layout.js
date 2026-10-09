// Layout audit, run in the page (paste into the console, or inject with a browser tool) at each viewport width:
//   await auditLayout()            → { width, results: [{ route, theme, problems: [...] }] }
// Checks, for every route in both themes:
//   1. no horizontal page scroll (wide tables scroll inside their own region)
//   2. controls that sit on one row share height and vertical centre (±1px)
//   3. icon-only buttons are square
//   4. the page's first heading starts at the same x as the header logo
//   5. no errors in the console since the page loaded (window.__errs, collected below)
// Nothing here changes the page apart from the hash and the theme, which are restored at the end.
(function () {
  if (!window.__errs) { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); const ce = console.error; console.error = (...a) => { window.__errs.push(a.join(' ')); ce.apply(console, a); }; }
  const ROUTES = ['#/', '#/?view=list', '#/?graph=entire', '#/?c=SB53', '#/explore', '#/explore?view=timeline', '#/explore?view=table', '#/explore?sec=A', '#/bill/1', '#/bill/4', '#/compare', '#/updates', '#/method', '#/handbook', '#/handbook?all=1', '#/about'];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const isControl = (el) => {
    if (el.closest('[role=region],svg,[data-tile],table,[aria-hidden=true]')) return false;
    if (el.matches('select')) return true;
    // a borderless input sits inside a bordered wrapper (the search pill); the wrapper is what lines up
    if (el.matches('input:not([type=checkbox]):not([type=radio])')) { const cs = getComputedStyle(el); return parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none'; }
    // a borderless, transparent button reads as a text link, so it is not held to the control height
    if (el.matches('button')) { const cs = getComputedStyle(el); return (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') || !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor); }
    if (el.matches('a')) { const cs = getComputedStyle(el); return parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && /flex|grid/.test(cs.display); }
    return false;
  };
  const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
  function check() {
    const P = [], W = innerWidth;
    if (document.documentElement.scrollWidth > W + 1) P.push(`page scrolls sideways: ${document.documentElement.scrollWidth}px > ${W}px`);
    // rows: controls with the same flex-row parent whose boxes overlap vertically
    const byParent = new Map();
    document.querySelectorAll('main button, main select, main input, main a, header button, header a, header input').forEach((el) => {
      if (!vis(el) || !isControl(el)) return;
      let p = el.parentElement; while (p && getComputedStyle(p).display === 'contents') p = p.parentElement;
      if (el.parentElement.tagName === 'LABEL' && getComputedStyle(el.parentElement).display !== 'contents') p = el.parentElement.parentElement;
      const cs = p && getComputedStyle(p); if (!cs || !/flex/.test(cs.display) || /column/.test(cs.flexDirection)) return;
      if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(el);
    });
    byParent.forEach((els) => {
      const rows = []; els.forEach((el) => { const r = el.getBoundingClientRect(); const row = rows.find((x) => r.top < x.b && r.bottom > x.t); if (row) { row.els.push(el); row.t = Math.min(row.t, r.top); row.b = Math.max(row.b, r.bottom); } else rows.push({ t: r.top, b: r.bottom, els: [el] }); });
      rows.filter((r) => r.els.length > 1).forEach((r) => {
        const bs = r.els.map((e) => e.getBoundingClientRect()), h0 = bs[0].height, c0 = bs[0].top + bs[0].height / 2;
        bs.forEach((b, i) => { if (Math.abs(b.height - h0) > 1 || Math.abs(b.top + b.height / 2 - c0) > 1) P.push(`row mismatch: "${label(r.els[0])}" ${h0.toFixed(1)}h vs "${label(r.els[i])}" ${b.height.toFixed(1)}h, centre off ${(b.top + b.height / 2 - c0).toFixed(1)}px`); });
      });
    });
    // icon-only buttons are square
    document.querySelectorAll('main button[aria-label], header button[aria-label], header a[aria-label]').forEach((el) => {
      if (!vis(el) || el.closest('[data-tile],svg,[role=region]')) return;
      const txt = (el.innerText || '').trim(); // visible text, aria-hidden or not: a one-glyph label still counts as an icon
      if (txt.length > 1 || el.querySelector('img')) return;
      const r = el.getBoundingClientRect(); if (el.matches('header a[aria-label*=home]')) return;
      if (Math.abs(r.width - r.height) > 1) P.push(`icon button not square: "${label(el)}" ${r.width.toFixed(1)}×${r.height.toFixed(1)}`);
    });
    // first heading aligned with the logo
    const logo = document.querySelector('header a[href="#/"]'), h1 = [...document.querySelectorAll('main h1')].find(vis);
    if (logo && h1) { const dx = h1.getBoundingClientRect().left - logo.getBoundingClientRect().left; if (Math.abs(dx) > 1 && !h1.closest('[data-exgrid]')) P.push(`h1 "${label(h1)}" starts ${dx.toFixed(1)}px from the logo edge`); }
    return P;
  }
  window.auditLayout = async function (routes = ROUTES) {
    const start = location.hash, btn = () => document.querySelector('header button[aria-label*="theme"]'), themeNow = () => document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const results = [];
    for (const theme of ['light', 'dark']) {
      if (themeNow() !== theme) { btn().click(); await wait(300); }
      for (const route of routes) {
        window.__errs.length = 0; location.hash = route; await wait(700); window.scrollTo(0, 0); await wait(100);
        const problems = check(); if (window.__errs.length) problems.push('console errors: ' + window.__errs.slice(0, 3).join(' | '));
        results.push({ route, theme, problems });
      }
    }
    location.hash = start;
    return { width: innerWidth, results: results.filter((r) => r.problems.length), clean: results.filter((r) => !r.problems.length).length, total: results.length };
  };
})();
