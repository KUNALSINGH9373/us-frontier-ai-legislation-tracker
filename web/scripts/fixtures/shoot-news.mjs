// Screenshots of the News cards against the fixture. Needs a static server on web/ and playwright.
//   node web/scripts/fixtures/shoot-news.mjs <baseUrl> <outDir> <playwrightModulePath>
import path from 'path';
import { pathToFileURL } from 'url';
const [base, out, pw] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(pw).href);
const browser = await chromium.launch();
const shots = [
  ['updates', 'news=scripts/fixtures/news-fixture.json&today=2026-10-29', '#/updates'],
  ['updates-quiet', 'news=scripts/fixtures/news-fixture-quiet.json&today=2026-10-29', '#/updates'],
  ['updates-real', 'today=2026-10-29', '#/updates'],
  ['bill-27', 'news=scripts/fixtures/news-fixture.json&today=2026-10-29', '#/bill/27']
];
let bad = 0;
for (const [w, h, tag] of [[1366, 900, 'desktop'], [390, 844, 'phone']]) {
  for (const [name, qs, hash] of shots) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`${base}/Tracker.dc.html?${qs}${hash}`);
    await page.waitForTimeout(4500);
    const info = await page.evaluate(() => ({ cards: document.querySelectorAll('article').length, official: document.querySelectorAll('[data-official]').length, stage: document.querySelectorAll('[data-stage]').length, cd: document.querySelectorAll('[data-countdown]').length, tl: !!document.querySelector('[data-entry-timeline]'), digest: (document.querySelector('[data-digest]') || {}).innerText, hidden: document.body.innerText.includes('must not render'), sx: document.documentElement.scrollWidth > innerWidth }));
    await page.screenshot({ path: path.join(out, `${name}-${tag}.png`), fullPage: true });
    console.log(tag, name, JSON.stringify(info), errs.length ? 'CONSOLE: ' + errs.join(' | ') : 'console clean');
    if (errs.length || info.hidden || info.sx) bad++;
    await page.close();
  }
}
await browser.close();
process.exit(bad ? 1 : 0);
