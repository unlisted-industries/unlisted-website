import { statements } from './db.js';
import { ensureLiveVisitors } from './live-visitors.js';

export async function expireOldData(db) {
  await ensureLiveVisitors(db);
  await statements(db, [
    [`UPDATE orders SET status = 'cancelled', payment_status = 'unpaid', updated_at = unixepoch()
      WHERE id IN (
        SELECT id FROM orders WHERE status = 'new' AND payment_status = 'pending'
          AND expires_at <= unixepoch() LIMIT 100
      )`],
    ['DELETE FROM login_tokens WHERE digest IN (SELECT digest FROM login_tokens WHERE expires_at <= unixepoch() LIMIT 500)'],
    ['DELETE FROM admin_passkey_challenges WHERE digest IN (SELECT digest FROM admin_passkey_challenges WHERE expires_at <= unixepoch() LIMIT 500)'],
    ['DELETE FROM sessions WHERE digest IN (SELECT digest FROM sessions WHERE expires_at <= unixepoch() LIMIT 500)'],
    ['DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires_at <= unixepoch() LIMIT 1000)'],
    ['DELETE FROM carts WHERE id IN (SELECT id FROM carts WHERE updated_at < unixepoch() - 2592000 LIMIT 100)'],
    ["DELETE FROM visits WHERE (day, visitor_id) IN (SELECT day, visitor_id FROM visits WHERE day < date('now', '-365 days') LIMIT 1000)"],
    ['DELETE FROM visitor_activity WHERE visitor_id IN (SELECT visitor_id FROM visitor_activity WHERE last_seen_at < unixepoch() - 86400 LIMIT 1000)'],
  ]);
}
