import { all } from './db.js';
import { orderNo } from './order-number.js';
import { money } from './content.js';

export function telegramReady(env) {
  return /^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN ?? '') && /^-?\d+$/.test(env.TELEGRAM_CHAT_ID ?? '');
}

export function orderNotificationText(order, lines, origin) {
  const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0,max);
  const items = lines.map((line) => `${line.quantity} × ${text(line.product_title,100)} · ${text(line.variant_title,60)} · ${money(line.price*line.quantity,true)}`);
  const heading = `UNLISTED · NEW ORDER ${orderNo(order)}`;
  const details = [heading, `${text(order.name,100)} · ${text(order.email,254)}`, text(order.phone,24),
    `${text(order.address,350)}, ${text(order.city,100)}, ${text(order.shipping_label,100)}`,
    `Total: ${money(order.total,true)}`, `Payment: ${order.chosen_method ?? order.payment_method} · ${order.payment_status}`];
  const link = new URL('/admin/orders?order=' + order.id, origin).href;
  const available = 3950 - details.join('\n').length - link.length;
  let summary = items.join('\n');
  if (summary.length > available) summary = summary.slice(0,Math.max(0,available-65)) + '\n… View the order for the complete product list.';
  return [...details,'',summary,'',link].join('\n');
}

export async function deliverOrderNotifications(env, orderId = null) {
  if (!telegramReady(env)) return;
  const pending = await all(env.DB.prepare(`SELECT order_id FROM order_notifications WHERE sent_at IS NULL
    AND next_attempt_at<=unixepoch() AND locked_until<unixepoch() AND (? IS NULL OR order_id=?) LIMIT 10`).bind(orderId,orderId));
  for (const { order_id } of pending) {
    const lock = await env.DB.prepare(`UPDATE order_notifications SET locked_until=unixepoch()+60, attempts=attempts+1
      WHERE order_id=? AND sent_at IS NULL AND locked_until<unixepoch() RETURNING attempts,locked_until`).bind(order_id).first();
    if (!lock) continue;
    let delivered = false, error = 'Telegram request did not complete';
    try {
      const order = await env.DB.prepare(`SELECT o.*, c.method AS chosen_method FROM orders o
        LEFT JOIN order_payment_choices c ON c.order_id=o.id WHERE o.id=?`).bind(order_id).first();
      const lines = await all(env.DB.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY product_title').bind(order_id));
      const response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
        method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(8000),
        body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:orderNotificationText(order,lines,env.PAYMENT_ORIGIN ?? env.PREVIEW_PAYMENT_ORIGIN),
          disable_notification:false,protect_content:true,link_preview_options:{is_disabled:true}}),
      });
      delivered = response.ok && (await response.json()).ok === true;
      error = delivered ? '' : 'Telegram delivery failed (HTTP ' + response.status + ')';
    } catch { /* Keep provider URLs and credentials out of logs and stored errors. */ }
    await env.DB.prepare(`UPDATE order_notifications SET sent_at=CASE WHEN ? THEN unixepoch() ELSE NULL END,
      last_error=?,locked_until=0,next_attempt_at=unixepoch()+? WHERE order_id=? AND locked_until=?`)
      .bind(Number(delivered),error,Math.min(3600,60*2**Math.min(lock.attempts,5)),order_id,lock.locked_until).run();
  }
}
