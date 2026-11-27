import { all } from './db.js';
import { ensureShopifyImport } from './shopify-import.js';

// A read model combines existing records without reimporting orders, reserving stock,
// rewriting original payment/status fields, or linking people by an unverified email.
const combined = `SELECT id, coalesce('#' || number, id) AS reference, email, name, created_at, status, payment_status,
  coalesce((SELECT method FROM order_payment_choices WHERE order_id=orders.id), payment_method) AS payment_method,
  total, currency, 0 AS historical FROM orders
  UNION ALL
  SELECT 'history:' || o.source_id, o.order_number, o.email,
    coalesce(json_extract(d.data, '$.header."Shipping Name"'),json_extract(d.data, '$.header."Billing Name"'),'') AS name,
    o.created_at, CASE WHEN o.cancelled_at IS NOT NULL THEN 'cancelled' ELSE o.fulfillment END,
    o.payment, coalesce(json_extract(d.data, '$.header."Payment Method"'),''),
    CAST(round(CAST(o.amount AS NUMERIC)*100) AS INTEGER), o.currency, 1
  FROM shopify_orders o LEFT JOIN shopify_order_details d ON d.source_id=o.source_id`;

export async function unifiedOrders(db, { email = null, q = '', offset = 0 } = {}) {
  await ensureShopifyImport(db);
  return all(db.prepare(`SELECT * FROM (${combined}) WHERE (? IS NULL OR email = ? COLLATE NOCASE)
    AND (? = '' OR instr(lower(coalesce(email,'')),lower(?)) > 0 OR instr(lower(reference),lower(?)) > 0
      OR instr(lower(name),lower(?)) > 0) ORDER BY created_at DESC, id DESC LIMIT 26 OFFSET ?`)
    .bind(email, email, q, q, q, q, offset));
}

export async function historicalOrder(db, id, email = null) {
  if (!/^\d{1,30}$/.test(id ?? '')) return null;
  await ensureShopifyImport(db);
  return db.prepare(`SELECT o.*, d.data FROM shopify_orders o LEFT JOIN shopify_order_details d ON d.source_id=o.source_id
    WHERE o.source_id=? AND (? IS NULL OR o.email=? COLLATE NOCASE)`).bind(id, email, email).first();
}

export const orderHref = (order, admin = false) => admin
  ? '/admin/orders?order=' + encodeURIComponent(order.id)
  : order.historical ? '/orders/history/' + order.id.slice(8) : '/orders/' + order.id;
export const orderReference = (order) => order.historical || String(order.reference ?? '').startsWith('#') ? order.reference : '#' + order.id.slice(0,8).toUpperCase();

export async function unifiedCustomers(db, q='', offset=0) {
  await ensureShopifyImport(db);
  return all(db.prepare(`WITH identities AS (
    SELECT email, name, 0 AS orders FROM customers
    UNION ALL SELECT email,name,1 FROM (${combined}) WHERE email IS NOT NULL AND email<>''
    UNION ALL SELECT email,trim(coalesce(json_extract(data,'$."First Name"'),'') || ' ' || coalesce(json_extract(data,'$."Last Name"'),'')),0
      FROM shopify_customer_details WHERE email IS NOT NULL AND email<>''
  ), profiles AS (
    SELECT lower(email) AS identity,email,max(name) AS name,sum(orders) AS orders FROM identities GROUP BY email COLLATE NOCASE
    UNION ALL SELECT 'history:' || source_id,NULL,
      trim(coalesce(json_extract(data,'$."First Name"'),'') || ' ' || coalesce(json_extract(data,'$."Last Name"'),'')),0
      FROM shopify_customer_details WHERE email IS NULL OR email=''
  ) SELECT * FROM profiles WHERE ?='' OR instr(lower(coalesce(email,'')),lower(?))>0 OR instr(lower(name),lower(?))>0
    ORDER BY coalesce(email,identity) LIMIT 26 OFFSET ?`).bind(q,q,q,offset));
}
