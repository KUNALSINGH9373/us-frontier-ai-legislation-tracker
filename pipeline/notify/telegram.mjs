// Telegram client for the run reports. Plain code; the bot token is never printed or logged (createHttp scrubs it from every error).
//   node notify/telegram.mjs --whoami       who the bot is (checks the token)
//   node notify/telegram.mjs --find-chat    chats that have written to the bot (message the bot first, then run this to get TELEGRAM_CHAT_ID)
//   node notify/telegram.mjs --test         sends one test message to TELEGRAM_CHAT_ID
// Variables (E:\uslegislation\.env or real environment): TELEGRAM_BOT_TOKEN (or TELEGRAM_ACCESS_TOKEN), TELEGRAM_CHAT_ID.
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from '../grabber/lib/env.mjs';
import { createHttp } from '../grabber/lib/http.mjs';

export const MAX_LEN = 4000; // Telegram's limit is 4096 characters per message; keep a margin

export const tokenFromEnv = (env = process.env) => env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_ACCESS_TOKEN || '';

// Split a long report into messages that fit, breaking on blank lines, then lines, then (last resort) hard.
export function chunk(text, max = MAX_LEN) {
  const out = []; let cur = '';
  const push = (s) => { if (cur && cur.length + s.length + 1 > max) { out.push(cur); cur = ''; } cur = cur ? cur + '\n' + s : s; };
  for (const para of String(text).split('\n')) {
    let line = para;
    while (line.length > max) { push(line.slice(0, max)); out.push(cur); cur = ''; line = line.slice(max); }
    push(line);
  }
  if (cur) out.push(cur);
  return out;
}

export function createTelegram({ token = tokenFromEnv(), chatId = process.env.TELEGRAM_CHAT_ID, http, fetchImpl, sleep } = {}) {
  if (!token) throw new Error('no Telegram bot token (set TELEGRAM_BOT_TOKEN or TELEGRAM_ACCESS_TOKEN)');
  const h = http || createHttp({ secrets: [token], maxRequests: 30, retries: 2, ...(fetchImpl ? { fetchImpl } : {}), ...(sleep ? { sleep } : {}) });
  const base = `https://api.telegram.org/bot${token}`;
  const call = async (method, body) => {
    const r = body ? await h.postJson(`${base}/${method}`, body) : await h.getJson(`${base}/${method}`);
    if (!r || r.ok !== true) throw new Error(`Telegram ${method} failed: ${String((r && r.description) || 'no answer').slice(0, 200)}`);
    return r.result;
  };
  return {
    whoami: () => call('getMe'),
    // Every distinct chat that has sent the bot a message (or added it to a group).
    async chats() {
      const ups = await call('getUpdates');
      const seen = new Map();
      for (const u of ups) { const c = (u.message || u.channel_post || (u.my_chat_member && { chat: u.my_chat_member.chat }) || {}).chat; if (c && !seen.has(c.id)) seen.set(c.id, { id: c.id, type: c.type, name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '' }); }
      return [...seen.values()];
    },
    // Sends a report, split into as many messages as needed. Returns how many were sent.
    async send(text) {
      if (!chatId) throw new Error('no TELEGRAM_CHAT_ID set');
      const parts = chunk(text);
      for (const p of parts) await call('sendMessage', { chat_id: chatId, text: p, disable_web_page_preview: true });
      return parts.length;
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadEnv(path.dirname(fileURLToPath(import.meta.url)));
  const flag = process.argv[2];
  try {
    const tg = createTelegram();
    if (flag === '--whoami') { const me = await tg.whoami(); console.log(`token OK: bot @${me.username} (${me.first_name})`); }
    else if (flag === '--find-chat') {
      const cs = await tg.chats();
      console.log(cs.length ? cs.map((c) => `chat id ${c.id}  (${c.type}${c.name ? ', ' + c.name : ''})`).join('\n') : 'No messages found. Open the bot in Telegram, press Start (or send any message; for a group, add the bot and post once), then run this again.');
    } else if (flag === '--test') { const n = await tg.send('✅ US Frontier Law: Telegram reports are connected.'); console.log(`sent ${n} message`); }
    else console.log('usage: node notify/telegram.mjs --whoami | --find-chat | --test');
  } catch (e) { console.error('FAILED:', e.message); process.exit(1); }
}
