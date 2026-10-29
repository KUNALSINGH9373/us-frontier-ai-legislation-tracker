// Per-source health for the News lane, kept in pipeline/state/news-health.json.
//   updateHealth(prev, results, { now, items })  -> next state (pure). results: { <source>: adapter health }, items: { <source>: RawItem[] }
//   alerts(state, { now, config, items })         -> alert lines for the Telegram report (stale, broken, no key, zero-volume, spike, replay, future-dated)
//   dataAsOf(state)                               -> { <source>: ISO of the last ok read } (page-level "data as of")
//   loadHealth(path) / saveHealth(path, state)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HEALTH_PATH = path.join(HERE, '..', 'state', 'news-health.json');
const KEEP = 14; // runs of history kept per source

export function loadHealth(p = HEALTH_PATH) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { sources: {} }; } }
// No key-looking string ever reaches news-health.json (review F5): every secret value given (the env keys) and every key=/apikey=/api_key=/
// token= query value is redacted before writing.
export function healthText(state, secrets = []) {
  let t = JSON.stringify(state, null, 1);
  for (const k of secrets) if (k && String(k).length >= 6) t = t.split(String(k)).join('REDACTED');
  return t.replace(/([?&;\s"'(]|^)((?:api[_-]?)?key|apikey|token|access_token)=[^&\s"'),\\]+/gi, '$1$2=REDACTED') + '\n';
}
export function saveHealth(p = HEALTH_PATH, state, secrets = []) { fs.writeFileSync(p, healthText(state, secrets)); }

const futureLimit = (now) => new Date(now.getTime() + 86400000).toISOString().slice(0, 10);

export function updateHealth(prev, results, { now = new Date(), items = {} } = {}) {
  const at = now.toISOString();
  const sources = { ...((prev && prev.sources) || {}) };
  for (const [name, h] of Object.entries(results || {})) {
    const p = sources[name] || {};
    // not due (cadence_hours, review F2c): the previous record stands; only the skip is noted
    if (h && h.skipped === 'cadence') { sources[name] = { ...p, last_skipped: at }; continue; }
    const list = items[name] || [];
    const future = list.filter((x) => x.date && x.date > futureLimit(now)).map((x) => ({ source_id: x.source_id, date: x.date }));
    const newest = (h && h.newest) || list.reduce((m, x) => (x.date && x.date <= futureLimit(now) && x.date > (m || '') ? x.date : m), null);
    const ok = !!(h && h.ok);
    sources[name] = {
      last_run: at,
      last_fetch: at, // when the source was last read: the cadence check (news/run.mjs) counts from here
      ...(h && h.truncated ? { truncated: true } : {}),
      last_ok: ok ? at : (p.last_ok || null),
      ok,
      newest: newest && (!p.newest || newest > p.newest) ? newest : (p.newest || newest || null),
      run_newest: newest || null,
      replay: !!(ok && list.length && newest && p.newest && newest < p.newest),
      count: (h && h.count) || 0,
      counts: [...(p.counts || []), (h && h.count) || 0].slice(-KEEP),
      errors: (h && h.errors) || [],
      consecutive_failures: ok ? 0 : (p.consecutive_failures || 0) + 1,
      future_items: future,
    };
  }
  return { updated_at: at, sources };
}

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export function alerts(state, { now = new Date(), config = {} } = {}) {
  const lines = [];
  for (const [name, s] of Object.entries((state && state.sources) || {})) {
    const cadence = (config[name] && config[name].cadence_hours) || 24;
    if ((s.errors || []).includes('no key')) { lines.push(`news source ${name}: no API key set, not read`); continue; }
    if (!s.ok) lines.push(`news source ${name}: broken (${s.consecutive_failures} run(s)): ${(s.errors || []).join('; ').slice(0, 200)}`);
    const ageH = s.last_ok ? (now - Date.parse(s.last_ok)) / 3600000 : Infinity;
    if (ageH > 2 * cadence) lines.push(`news source ${name}: stale, last ok read ${s.last_ok || 'never'} (expected every ${cadence} h)`);
    const before = (s.counts || []).slice(0, -1);
    const m = median(before);
    if (s.ok && before.length >= 3 && m > 0 && s.count === 0) lines.push(`news source ${name}: zero items this run (usually ${m})`);
    if (s.ok && before.length >= 3 && s.count > Math.max(10, 5 * m)) lines.push(`news source ${name}: volume spike, ${s.count} items (usually ${m}); checked, nothing extra shown`);
    if (s.replay) lines.push(`news source ${name}: replayed only old items (newest this run ${s.run_newest}, already had ${s.newest}); nothing new`);
    if ((s.future_items || []).length) lines.push(`news source ${name}: ${s.future_items.length} future-dated item(s) rejected (e.g. ${s.future_items[0].source_id} dated ${s.future_items[0].date})`);
  }
  return lines;
}

export function dataAsOf(state) {
  const out = {};
  for (const [name, s] of Object.entries((state && state.sources) || {})) out[name] = s.last_ok || null;
  return out;
}
