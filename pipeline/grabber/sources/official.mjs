// Downloads a bill's text from the legislature's OWN website (the state_link LegiScan gives for each text version).
// It costs no LegiScan query, and it is the official source the site cites anyway.
// Returns { text, bytes, mime } or throws; the caller falls back to LegiScan's copy only when this fails.
import { htmlToText, stripLineNumbering } from '../lib/text.mjs';
import { pdfToText } from '../lib/pdf.mjs';

// Many state sites refuse scripts or traffic from outside the US (13 Oct 2026, from the owner's machine: timeouts from NJ, PA, CT;
// 403 from CA and NY). So failures are fast: a short timeout, and a site that fails twice is skipped for the rest of the run.
export function createOfficial({ fetchImpl = globalThis.fetch, timeoutMs = 15000, maxFailsPerHost = 2, maxBytes = 30_000_000, userAgent = 'Mozilla/5.0 (compatible; us-frontier-ai-tracker/0.1; official bill text)' } = {}) {
  let used = 0;
  const fails = new Map();
  async function get(url) {
    const host = new URL(url).host;
    if ((fails.get(host) || 0) >= maxFailsPerHost) throw new Error(`${host} skipped after ${maxFailsPerHost} failures this run`);
    used++;
    try { return await fetchOnce(url); } catch (e) { fails.set(host, (fails.get(host) || 0) + 1); throw e; }
  }
  async function fetchOnce(url) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'text/html,application/pdf,*/*' }, signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`file too large (${buf.length} bytes)`);
      return { buf, mime: (res.headers && res.headers.get && res.headers.get('content-type')) || '' };
    } finally { clearTimeout(timer); }
  }
  return {
    used: () => used,
    async text(url) {
      const { buf, mime } = await get(url);
      const isPdf = /pdf/i.test(mime) || buf.subarray(0, 5).toString('latin1') === '%PDF-';
      if (isPdf) { const p = await pdfToText(buf); return { text: p.text, bytes: buf, mime: 'application/pdf', pdf: { pages: p.pages || null, truncated: !!p.truncated, reason: p.reason || null, warnings: p.warnings || [] } }; }
      const text = stripLineNumbering(htmlToText(buf.toString('utf8')));
      if (text.length < 200) throw new Error('page has almost no text');
      return { text, mime: mime || 'text/html' };
    }
  };
}
