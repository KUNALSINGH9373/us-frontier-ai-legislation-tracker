// Fetches the official text of the executive actions and export rules that have one, for their "What it orders" checklist
// (pagefields/exec-run.mjs). Federal Register documents through its API (raw text); the White House and state pages as visible text.
// Writes data/exec-texts/<key>.txt (git-ignored, like data/eval/texts) and pagefields/exec-sources.json (key -> official URL).
//   node pagefields/fetch-exec-texts.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url)), dir = path.join(here, '..', 'data', 'exec-texts');
// key -> Federal Register document number, or a page URL
export const EXEC_SOURCES = {
  'eo-14409-pre-release-access': { fr: '2026-11415' },
  'eo-14434-super-intelligence-terminology-order': { fr: '2026-20321' },
  'bis-framework-for-ai-diffusion-biden-era-interim-final-rule': { fr: '2025-00636' },
  'bis-final-rule-on-ai-chip-licensing-to-china-macau': { fr: '2026-00789' },
  'bis-affiliates-rule': { fr: '2025-19001' },
  'eo-14365-state-law-framework': { page: 'https://www.whitehouse.gov/presidential-actions/2025/12/eliminating-state-law-obstruction-of-national-artificial-intelligence-policy/' },
  'or-il-eo-2026-07-ai-cabinet': { page: 'https://www.illinois.gov/government/executive-orders/executive-order.executive-order-2026-07.2026.html' }
};
const UA = { 'user-agent': 'us-frontier-law-tracker (official-text fetch)' };
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”').replace(/&#8212;|&mdash;/g, '—').replace(/&#8211;|&ndash;/g, '–').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(dir, { recursive: true });
  const urls = {};
  for (const [key, s] of Object.entries(EXEC_SOURCES)) {
    try {
      let text, url;
      if (s.fr) {
        const meta = await (await fetch(`https://www.federalregister.gov/api/v1/documents/${s.fr}.json?fields[]=raw_text_url&fields[]=html_url`, { headers: UA })).json();
        text = visible(await (await fetch(meta.raw_text_url, { headers: UA })).text()); url = meta.html_url;
      } else { const r = await fetch(s.page, { headers: UA }); if (!r.ok) throw new Error('HTTP ' + r.status); text = visible(await r.text()); url = s.page; }
      if (text.length < 1500) throw new Error(`only ${text.length} characters: not the order's text`);
      fs.writeFileSync(path.join(dir, key + '.txt'), text); urls[key] = url;
      console.log(`${key}: ${text.length} characters from ${url}`);
    } catch (e) { console.log(`${key}: NOT FETCHED (${e.message})`); }
  }
  fs.writeFileSync(path.join(here, 'exec-sources.json'), JSON.stringify(urls, null, 2) + '\n');
}
