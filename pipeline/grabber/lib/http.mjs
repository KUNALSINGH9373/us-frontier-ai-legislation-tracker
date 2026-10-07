// A small, polite HTTP client for JSON APIs.
// - retries rate-limit (429), server (5xx) and network errors with growing waits, honouring Retry-After
// - hard cap on requests per run (the quota guard)
// - secrets are scrubbed from every error message and log line
// fetch and sleep are injectable so the whole thing can be tested without network access.
export class QuotaExceeded extends Error { constructor(max) { super(`request budget of ${max} reached`); this.name = 'QuotaExceeded'; } }
export class NetworkError extends Error { constructor(msg) { super(msg); this.name = 'NetworkError'; } }
export class HttpError extends Error { constructor(status, url, body) { super(`HTTP ${status} for ${url}`); this.name = 'HttpError'; this.status = status; this.body = body; } }

export function createHttp({ fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), headers = {}, secrets = [], maxRequests = 500, retries = 4, timeoutMs = 30000, userAgent = 'us-frontier-ai-tracker-pipeline/0.1', log = () => {} } = {}) {
  let used = 0;
  const scrub = (s) => secrets.filter(Boolean).reduce((t, x) => t.split(x).join('***'), String(s));

  async function request(url, as, init = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (used >= maxRequests) throw new QuotaExceeded(maxRequests);
      used++;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { ...init, headers: { Accept: 'application/json', 'User-Agent': userAgent, ...headers, ...(init.headers || {}) }, signal: ctl.signal });
        clearTimeout(timer);
        if (res.ok) return as === 'text' ? await res.text() : await res.json();
        const retryable = res.status === 429 || res.status >= 500;
        const body = scrub((await res.text().catch(() => '')).slice(0, 300));
        if (!retryable) throw new HttpError(res.status, scrub(url.split('?')[0]), body);
        lastErr = new HttpError(res.status, scrub(url.split('?')[0]), body);
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        const wait = ra > 0 ? Math.min(ra, 60) * 1000 : Math.min(2000 * 2 ** attempt, 30000);
        log(`retry ${attempt + 1}/${retries} after ${wait} ms (HTTP ${res.status})`);
        await sleep(wait);
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof HttpError || e instanceof QuotaExceeded) throw e;
        lastErr = new NetworkError(scrub(e.message || e)); // network error or timeout
        log(`retry ${attempt + 1}/${retries} after network error: ${lastErr.message}`);
        await sleep(Math.min(2000 * 2 ** attempt, 30000));
      }
    }
    throw lastErr;
  }
  const postJson = (url, body) => request(url, 'json', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return { getJson: (url) => request(url, 'json'), getText: (url) => request(url, 'text'), postJson, used: () => used, maxRequests };
}
