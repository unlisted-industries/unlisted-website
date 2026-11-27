import { initializeTables } from './db.js';
import { StoreError } from './http.js';

// Orders (and paid pre-orders) go to their own Telegram group so that one chat can use the
// cha-ching notification sound. Every other alert stays in TELEGRAM_CHAT_ID with the normal sound.
const ensureTelegramSettings = initializeTables('CREATE TABLE IF NOT EXISTS telegram_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))');
const chatPattern = /^-?\d{1,20}$/;
const tokenPattern = /^\d+:[A-Za-z0-9_-]+$/;

export async function ordersChatId(env) {
  if (chatPattern.test(env.TELEGRAM_ORDERS_CHAT_ID ?? '')) return env.TELEGRAM_ORDERS_CHAT_ID;
  try {
    await ensureTelegramSettings(env.DB);
    const saved = await env.DB.prepare("SELECT value FROM telegram_settings WHERE key='orders_chat'").first('value');
    if (chatPattern.test(saved ?? '')) return saved;
  } catch { /* Fall back to the main chat. */ }
  return env.TELEGRAM_CHAT_ID;
}

async function telegram(env, method, body) {
  const response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000), body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw new StoreError('Telegram did not accept the request. Check that the bot is in the group.', 502);
  return data.result;
}

// Finds the newest group the bot was added to, saves it as the orders chat and sends the
// cha-ching sound there so it can be saved as that chat's notification sound.
export async function connectOrdersChat(env, origin) {
  if (!tokenPattern.test(env.TELEGRAM_BOT_TOKEN ?? '')) throw new StoreError('The Telegram bot is not configured.');
  const updates = await telegram(env, 'getUpdates', { allowed_updates: ['message', 'my_chat_member'], limit: 100 });
  const groups = updates.map((update) => (update.my_chat_member ?? update.message)?.chat)
    .filter((chat) => chat && ['group', 'supergroup'].includes(chat.type) && chatPattern.test(String(chat.id)));
  const chat = groups.at(-1);
  if (!chat) throw new StoreError('No group found. In Telegram, create a group, add your bot, send /start in it, then press Connect again.');
  await ensureTelegramSettings(env.DB);
  await env.DB.prepare(`INSERT INTO telegram_settings (key, value) VALUES ('orders_chat', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()`).bind(String(chat.id)).run();
  await telegram(env, 'sendAudio', {
    chat_id: chat.id, audio: new URL('/theme/cha-ching.mp3?v=2', origin).href, title: 'Cha-ching', performer: 'UNLISTED',
    caption: 'New orders will arrive in this group.\n\nSet the sound:\n1. Long-press this audio → Save for notifications.\n2. Tap the group name → Notifications → Sound → Cha-ching.',
  });
  await telegram(env, 'sendMessage', { chat_id: chat.id, text: 'UNLISTED · TEST ORDER ALERT 💰\nThis is how new orders will sound.' });
  return chat.title ?? 'your group';
}
