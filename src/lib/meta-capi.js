// Meta Conversions API: sends Purchase from the server so orders are counted even when the
// browser pixel is blocked. Uses the same event IDs as the browser pixel, so Meta de-duplicates.
// Turned on by the META_CAPI_TOKEN secret (Events Manager → dataset → Settings → Conversions API).
import { initializeTables } from './db.js';

export const pixelId = '2193064114941333';
const ensureContext = initializeTables('CREATE TABLE IF NOT EXISTS meta_order_context (order_id TEXT PRIMARY KEY, ip TEXT, ua TEXT, fbp TEXT, fbc TEXT, url TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))');

async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function egyptPhone(phone) {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '20' + digits.slice(1);
  return digits;
}

export async function saveOrderContext(env, context, orderId) {
  if (!env.META_CAPI_TOKEN) return;
  try {
    await ensureContext(env.DB);
    const cookie = (name) => context.cookies.get(name)?.value ?? null;
    await env.DB.prepare('INSERT OR IGNORE INTO meta_order_context (order_id, ip, ua, fbp, fbc, url) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(orderId, context.request.headers.get('CF-Connecting-IP'), context.request.headers.get('User-Agent')?.slice(0, 400) ?? null,
        cookie('_fbp'), cookie('_fbc'), context.request.headers.get('Referer')?.slice(0, 400) ?? null).run();
  } catch { /* Tracking never blocks checkout. */ }
}

export async function sendPurchase(env, { id, eventId, value, email, phone, name, city, contentIds = [], numItems = 1 }) {
  if (!env.META_CAPI_TOKEN) return false;
  try {
    await ensureContext(env.DB);
    const ctx = await env.DB.prepare('SELECT * FROM meta_order_context WHERE order_id = ?').bind(id).first() ?? {};
    const [first, ...rest] = String(name ?? '').trim().toLowerCase().split(/\s+/);
    const user = {
      em: email ? [await hash(String(email).trim().toLowerCase())] : undefined,
      ph: phone ? [await hash(egyptPhone(phone))] : undefined,
      fn: first ? [await hash(first)] : undefined,
      ln: rest.length ? [await hash(rest.join(' '))] : undefined,
      ct: city ? [await hash(String(city).toLowerCase().replace(/[^a-z]/g, ''))] : undefined,
      country: [await hash('eg')],
      client_ip_address: ctx.ip ?? undefined, client_user_agent: ctx.ua ?? undefined,
      fbp: ctx.fbp ?? undefined, fbc: ctx.fbc ?? undefined,
    };
    const response = await fetch('https://graph.facebook.com/v21.0/' + pixelId + '/events?access_token=' + encodeURIComponent(env.META_CAPI_TOKEN), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ data: [{
        event_name: 'Purchase', event_time: Math.floor(Date.now() / 1000), event_id: eventId, action_source: 'website',
        event_source_url: (env.PAYMENT_ORIGIN ?? 'https://unlisted-shop.com') + '/checkout', user_data: user,
        custom_data: { currency: 'EGP', value: Math.round(value) / 100, content_ids: contentIds, content_type: 'product', num_items: numItems },
      }] }),
    });
    return response.ok;
  } catch { return false; }
}

export async function sendOrderPurchase(env, order) {
  if (!env.META_CAPI_TOKEN || !order) return false;
  const lines = (await env.DB.prepare('SELECT variant_id, quantity FROM order_items WHERE order_id = ?').bind(order.id).all()).results;
  return sendPurchase(env, { id: order.id, eventId: 'order-' + order.id, value: order.total, email: order.email, phone: order.phone,
    name: order.name, city: order.city, contentIds: lines.map((l) => l.variant_id), numItems: lines.reduce((n, l) => n + l.quantity, 0) });
}
