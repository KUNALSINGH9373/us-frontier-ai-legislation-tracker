// Shared helpers for the official news source adapters (news/sources/*.mjs). No AI. See news/CONTRACT.md.
//   http(url, { headers }) -> { status, text }    the transport every adapter takes (tests pass a fixture map; defaultHttp() is live)
//   collect(name, retrievedAt)                    item gate: host allowlist, date sanity, plain text, verbatim title; builds health
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decode } from '../feeds.mjs';
import { htmlToText } from '../../grabber/lib/text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_FILE = path.join(here, '..', '..', 'config', 'news-sources.json');
let CONFIG = null;
export function sourceConfig(name) {
  if (!CONFIG) { try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).structured || {}; } catch { CONFIG = {}; } }
  return CONFIG[name] || { hosts: [] };
}

export const USER_AGENT = 'us-frontier-ai-tracker-pipeline/0.1 (official news sources)';
export function defaultHttp({ timeoutMs = 30000 } = {}) {
  return async (url, { headers = {} } = {}) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { const r = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: ctl.signal, redirect: 'follow' }); return { status: r.status, text: await r.text(), url: r.url }; }
    finally { clearTimeout(t); }
  };
}

// Never let an API key reach a log, an error or an item.
export const redact = (s, ...keys) => { let out = String(s ?? ''); for (const k of keys) if (k && k.length >= 6) out = out.split(k).join('REDACTED'); return out.replace(/(api_key=)[^&\s"]+/gi, '$1REDACTED'); };

// One GET returning parsed JSON or text; never throws. { ok, status, data|text, error }
export async function get(http, url, { json = true, keys = [], headers } = {}) {
  try {
    const r = await http(url, { headers });
    if (!r || r.status !== 200) return { ok: false, status: r?.status ?? 0, error: `HTTP ${r?.status ?? 0} ${redact(url.split('?')[0], ...keys)}` };
    if (!json) return { ok: true, status: 200, text: String(r.text ?? '') };
    try { return { ok: true, status: 200, data: JSON.parse(r.text) }; } catch { return { ok: false, status: 200, error: `bad JSON from ${redact(url.split('?')[0], ...keys)}` }; }
  } catch (e) { return { ok: false, status: 0, error: redact(`${e?.name === 'AbortError' ? 'timeout' : (e?.message || e)} ${url.split('?')[0]}`, ...keys) }; }
}

// Plain text only: HTML tags and entities removed, whitespace collapsed.
export const plain = (s) => (s == null ? '' : htmlToText(decode(String(s))).replace(/\s+/g, ' ').trim());

// The official date in Washington (America/New_York) for an instant: "2026-10-14T03:59:59Z" -> "2026-10-13".
export function etDate(ts) {
  const t = Date.parse(ts); if (!Number.isFinite(t)) return null;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  return /^\d{4}-\d{2}-\d{2}$/.test(p) ? p : null;
}
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// Date sanity: a real calendar date, not before 1990, and not more than 1 day after the retrieval date (no future dates).
export function dateOk(d, retrievedAt) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return false;
  const t = Date.parse(d + 'T00:00:00Z'); if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== d || d < '1990-01-01') return false;
  const r = String(retrievedAt || new Date().toISOString()).slice(0, 10);
  return d <= addDays(r, 1);
}

export function hostAllowed(url, hosts) {
  try { const u = new URL(url); return u.protocol === 'https:' && hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h)); } catch { return false; }
}

// AI relevance screen for agency documents and presidential actions (title / abstract only, never page bodies).
export const AI_RE = /\bartificial[\s-]intelligence\b|\bsuper[\s-]?intelligen|\bfrontier (?:AI|model)|\bmachine learning\b|\bfoundation models?\b|\blarge language models?\b|\bAI Safety Institute\b/i;
const AI_WORD = /(?<![A-Za-z])(?:AI|A\.I\.|CAISS?I)(?![A-Za-z])/;   // upper case only: "ai" inside words or prose never counts
export const isAI = (s) => AI_RE.test(String(s || '')) || AI_WORD.test(String(s || ''));

// Item gate. add() keeps an item only when it is well formed; health() summarises the run.
export function collect(source, { retrievedAt, hosts }) {
  const items = [], errors = [], seen = new Set();
  let rejected = 0;
  return {
    errors,
    add(it) {
      const item = { source, source_id: String(it.source_id || ''), jurisdiction: it.jurisdiction || 'US', entry_id: it.entry_id || null, class: it.class ?? null,
        date: it.date, facts: {}, url: it.url, title: it.title, retrieved_at: retrievedAt };
      for (const [k, v] of Object.entries(it.facts || {})) {
        if (v == null || v === '') continue;
        item.facts[k] = typeof v === 'string' ? plain(v) : (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? plain(x) : x)) : v);
      }
      item.title = typeof item.title === 'string' ? plain(item.title) : '';
      const why = !item.source_id ? 'no source_id' : !item.title ? 'no title' : !dateOk(item.date, retrievedAt) ? `bad date ${item.date}` : !hostAllowed(item.url, hosts) ? `host not allowed ${String(item.url).slice(0, 80)}` : null;
      if (why) { rejected++; if (errors.length < 20) errors.push(`rejected ${item.source_id || '?'}: ${why}`); return false; }
      const k = `${item.source_id}|${item.class}`;
      if (seen.has(k)) return false;
      seen.add(k); items.push(item); return true;
    },
    result(extra = {}, ok = true) {
      const newest = items.reduce((m, i) => (m == null || i.date > m ? i.date : m), null);
      return { items, health: { ok: ok && !errors.some((e) => !e.startsWith('rejected')), count: items.length, newest, rejected, errors }, ...extra };
    },
  };
}

export const noKey = (extra = {}) => ({ items: [], health: { ok: false, count: 0, newest: null, rejected: 0, errors: ['no key'] }, ...extra });
// Any thrown error inside an adapter becomes a failed health report, never an exception.
export async function safely(fn) {
  try { return await fn(); } catch (e) { return { items: [], health: { ok: false, count: 0, newest: null, rejected: 0, errors: [redact(e?.message || String(e))] } }; }
}
export const iso = (d = new Date()) => (d instanceof Date ? d : new Date(d)).toISOString();
