// Tests for the Telegram client. No network: fetch is faked.
//   node notify/test.mjs
import { createTelegram, chunk, tokenFromEnv } from './telegram.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL ', name, detail || ''); } };
const TOKEN = '123456:SECRET-token_value';
const reply = (obj, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => obj, text: async () => JSON.stringify(obj) });
const fake = (handler) => { const calls = []; const f = async (url, init = {}) => { calls.push({ url, body: init.body ? JSON.parse(init.body) : null }); return handler(url, init, calls.length); }; return { f, calls }; };
const noSleep = async () => {};

ok('the token is read from either variable name', tokenFromEnv({ TELEGRAM_BOT_TOKEN: 'a' }) === 'a' && tokenFromEnv({ TELEGRAM_ACCESS_TOKEN: 'b' }) === 'b' && tokenFromEnv({ TELEGRAM_BOT_TOKEN: 'a', TELEGRAM_ACCESS_TOKEN: 'b' }) === 'a' && tokenFromEnv({}) === '');
ok('no token is a clear error, not a call', (() => { try { createTelegram({ token: '' }); return false; } catch (e) { return /no Telegram bot token/.test(e.message); } })());

{
  const long = Array.from({ length: 300 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(40)).join('\n');
  const parts = chunk(long);
  ok('a long report is split into messages under the limit, with no line lost', parts.every((p) => p.length <= 4000) && parts.join('\n') === long && parts.length > 1);
  ok('a short report is one message', chunk('hello\nworld').length === 1);
  ok('one enormous line is hard-split rather than refused', chunk('y'.repeat(9000)).join('').length === 9000 && chunk('y'.repeat(9000)).every((p) => p.length <= 4000));
}
{
  const { f, calls } = fake(() => reply({ ok: true, result: { id: 1, username: 'frontier_bot', first_name: 'Frontier' } }));
  const tg = createTelegram({ token: TOKEN, chatId: '42', fetchImpl: f, sleep: noSleep });
  const me = await tg.whoami();
  ok('whoami calls getMe on the bot URL and returns the bot', me.username === 'frontier_bot' && /\/bot123456:SECRET-token_value\/getMe$/.test(calls[0].url));
}
{
  const ups = [{ message: { chat: { id: 7, type: 'private', first_name: 'Ada', last_name: 'L' } } }, { message: { chat: { id: 7, type: 'private', first_name: 'Ada' } } }, { my_chat_member: { chat: { id: -100, type: 'supergroup', title: 'Tracker alerts' } } }, { edited_message: {} }];
  const tg = createTelegram({ token: TOKEN, fetchImpl: fake(() => reply({ ok: true, result: ups })).f, sleep: noSleep });
  const cs = await tg.chats();
  ok('chats lists each distinct chat once, private and group', cs.length === 2 && cs.find((c) => c.id === 7).name === 'Ada L' && cs.find((c) => c.id === -100).name === 'Tracker alerts');
}
{
  const { f, calls } = fake(() => reply({ ok: true, result: {} }));
  const tg = createTelegram({ token: TOKEN, chatId: '42', fetchImpl: f, sleep: noSleep });
  const n = await tg.send('a\n\n' + 'b'.repeat(4500) + '\nc');
  ok('send posts every part to the chat, without link previews', n === calls.length && n >= 2 && calls.every((c) => c.body.chat_id === '42' && c.body.disable_web_page_preview === true && c.body.text.length <= 4000));
  ok('no chat id is a clear error before anything is sent', await createTelegram({ token: TOKEN, chatId: '', fetchImpl: f, sleep: noSleep }).send('x').then(() => false, (e) => /TELEGRAM_CHAT_ID/.test(e.message)));
}
{
  const tg = createTelegram({ token: TOKEN, chatId: '42', fetchImpl: fake(() => reply({ ok: false, description: 'Bad Request: chat not found' }, 400)).f, sleep: noSleep });
  const err = await tg.send('hi').then(() => null, (e) => e);
  ok('a Telegram refusal surfaces as an error', !!err && /chat not found|HTTP 400/.test(err.message + String(err.body)));
  ok('the token never appears in the error text', !!err && !String(err.message).includes('SECRET-token_value') && !String(err.body || '').includes('SECRET-token_value') && !String(err.stack || '').includes('SECRET-token_value'));
}
{
  let n = 0;
  const tg = createTelegram({ token: TOKEN, chatId: '42', fetchImpl: fake(() => (++n < 3 ? reply({ ok: false }, 502) : reply({ ok: true, result: {} }))).f, sleep: noSleep });
  ok('a temporary Telegram outage is retried', (await tg.send('hi')) === 1 && n === 3);
}
{
  const err = await createTelegram({ token: TOKEN, chatId: '42', fetchImpl: fake(() => { throw new Error('connect ECONNREFUSED https://api.telegram.org/bot' + TOKEN + '/sendMessage'); }).f, sleep: noSleep }).send('hi').then(() => null, (e) => e);
  ok('a network failure is an error with the token scrubbed', !!err && !String(err.message).includes('SECRET-token_value'));
}

console.log(`telegram: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
