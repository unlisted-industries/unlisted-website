import migration from '../../migrations/0008_shopify_import.sql?raw';
import { initializeTables, makeToken, sha256, statements, unixNow } from './db.js';
import { StoreError } from './http.js';

export const ensureShopifyImport = initializeTables(migration);
const string = (value, max) => typeof value === 'string' && value.length <= max;
const email = (value) => value === null || (string(value, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
const id = (value) => typeof value === 'string' && /^\d{1,30}$/.test(value);
const handle = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,149}$/.test(value);
const record = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const time = (value) => Number.isSafeInteger(value) && value > 0 && value <= unixNow() + 86400;
const rows = (value, valid) => Array.isArray(value) && value.length <= 500 && value.every((row) => record(row) && valid(row));

function validate(bundle) {
  if (!record(bundle) || bundle.version !== 1 || !time(bundle.exportedAt) ||
      !rows(bundle.orders, (row) => id(row.id) && string(row.number, 100) && row.number && email(row.email) &&
        time(row.created) && (row.cancelled === null || time(row.cancelled)) && string(row.payment, 100) && string(row.fulfillment, 100) &&
        typeof row.amount === 'string' && /^\d{1,12}\.\d{2}$/.test(row.amount) && /^[A-Z]{3}$/.test(row.currency) &&
        rows(row.items, (item) => string(item.name, 500) && Number.isSafeInteger(item.quantity) && item.quantity > 0) && record(row.details)) ||
      !rows(bundle.customers, (row) => id(row.id) && email(row.email) && string(row.name, 254) && record(row.details)) ||
      !rows(bundle.products, (row) => handle(row.handle) && rows(row.details, () => true)) ||
      !rows(bundle.variants, (row) => string(row.id, 100) && row.id && handle(row.handle) && string(row.sku, 100) &&
        (row.available === null || (Number.isSafeInteger(row.available) && row.available >= 0 && row.available <= 1000000))) ||
      !rows(bundle.discounts ?? [], (row) => string(row.Name, 255) && row.Name && string(row.Type, 120) && string(row.Status, 40))) {
    throw new StoreError('Choose a valid Shopify migration file prepared for this workspace.');
  }
  for (const [list, key] of [[bundle.orders, 'id'], [bundle.customers, 'id'], [bundle.products, 'handle'], [bundle.variants, 'id'], [bundle.discounts ?? [], 'Name']]) {
    if (new Set(list.map((row) => row[key])).size !== list.length) throw new StoreError('The migration file contains duplicate Shopify records.');
  }
  if (!bundle.orders.length && !bundle.customers.length && !bundle.products.length) throw new StoreError('The migration file is empty.');
}

export async function importShopify(env, form) {
  const file = form.get('snapshot');
  if (!(file instanceof File) || file.size === 0 || file.size > 750 * 1024) {
    throw new StoreError('Choose a Shopify migration JSON file under 750 KB.');
  }
  const raw = await file.text();
  let bundle;
  try { bundle = JSON.parse(raw); } catch { throw new StoreError('The migration file is not valid JSON.'); }
  validate(bundle);

  const db = env.DB;
  await ensureShopifyImport(db);
  const transfer = makeToken(16);
  const digest = await sha256(raw);
  const orders = JSON.stringify(bundle.orders);
  const customers = JSON.stringify(bundle.customers);
  const products = JSON.stringify(bundle.products);
  const variants = JSON.stringify(bundle.variants);
  const discounts = bundle.discounts ?? [];
  const permitted = 'EXISTS (SELECT 1 FROM shopify_imports WHERE id = ?)';
  const matches = `FROM json_each(?) j JOIN variants v ON v.id = json_extract(j.value, '$.id')
    JOIN products p ON p.id = v.product_id AND p.handle = json_extract(j.value, '$.handle')`;
  const [result] = await statements(db, [
    [`INSERT INTO shopify_imports (id, digest, exported_at, order_count, customer_count, product_count, stock_count, discount_count)
      SELECT ?, ?, ?, ?, ?, ?, (SELECT count(*) ${matches}
        WHERE v.inventory IS NULL AND json_type(j.value, '$.available') = 'integer'), ?
      WHERE NOT EXISTS (SELECT 1 FROM shopify_imports WHERE exported_at >= ?)
      ON CONFLICT (digest) DO NOTHING`, transfer, digest, bundle.exportedAt, bundle.orders.length, bundle.customers.length,
    bundle.products.length, variants, discounts.length, bundle.exportedAt],
    [`INSERT INTO shopify_orders (source_id, order_number, email, created_at, cancelled_at, payment, fulfillment, amount, currency, line_items)
      SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.number'), json_extract(j.value, '$.email'),
        json_extract(j.value, '$.created'), json_extract(j.value, '$.cancelled'), json_extract(j.value, '$.payment'),
        json_extract(j.value, '$.fulfillment'), json_extract(j.value, '$.amount'), json_extract(j.value, '$.currency'), json_extract(j.value, '$.items')
      FROM json_each(?) j WHERE ${permitted}
      ON CONFLICT (source_id) DO UPDATE SET order_number = excluded.order_number, email = excluded.email,
        created_at = excluded.created_at, cancelled_at = excluded.cancelled_at, payment = excluded.payment,
        fulfillment = excluded.fulfillment, amount = excluded.amount, currency = excluded.currency, line_items = excluded.line_items`, orders, transfer],
    [`INSERT INTO shopify_order_details (source_id, data)
      SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.details') FROM json_each(?) j WHERE ${permitted}
      ON CONFLICT (source_id) DO UPDATE SET data = excluded.data`, orders, transfer],
    [`INSERT OR IGNORE INTO customers (id, email, name)
      SELECT 'shopify:' || json_extract(j.value, '$.id'), lower(json_extract(j.value, '$.email')), json_extract(j.value, '$.name')
      FROM json_each(?) j WHERE json_extract(j.value, '$.email') IS NOT NULL AND ${permitted}`, customers, transfer],
    [`INSERT INTO shopify_customer_details (source_id, email, data)
      SELECT json_extract(j.value, '$.id'), lower(json_extract(j.value, '$.email')), json_extract(j.value, '$.details')
      FROM json_each(?) j WHERE ${permitted} ON CONFLICT (source_id) DO UPDATE SET email = excluded.email, data = excluded.data`, customers, transfer],
    [`INSERT INTO shopify_product_details (handle, data)
      SELECT json_extract(j.value, '$.handle'), json_extract(j.value, '$.details') FROM json_each(?) j WHERE ${permitted}
      ON CONFLICT (handle) DO UPDATE SET data = excluded.data`, products, transfer],
    [`INSERT INTO shopify_discount_details (name, data)
      SELECT json_extract(j.value, '$.Name'), j.value FROM json_each(?) j WHERE ${permitted}
      ON CONFLICT (name) DO UPDATE SET data = excluded.data`, JSON.stringify(discounts), transfer],
    [`WITH supplied AS (SELECT v.id, json_extract(j.value, '$.available') AS available, json_extract(j.value, '$.sku') AS sku
      ${matches} WHERE ${permitted})
      UPDATE variants SET inventory = coalesce(inventory, supplied.available), sku = coalesce(nullif(variants.sku, ''), supplied.sku)
      FROM supplied WHERE variants.id = supplied.id AND ((variants.inventory IS NULL AND supplied.available IS NOT NULL)
        OR (variants.sku = '' AND supplied.sku <> ''))`, variants, transfer],
  ]);
  if (!result.meta.changes && !await db.prepare('SELECT 1 FROM shopify_imports WHERE digest = ?').bind(digest).first()) {
    throw new StoreError('A newer Shopify snapshot has already been imported.', 409);
  }
  return '/admin/migration';
}
