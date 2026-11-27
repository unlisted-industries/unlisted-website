import { acceptedOrder } from './checkout.js';
import { statements } from './db.js';

export const collections = [
  { name: 'Earlier UNLISTED T-shirts', products: ['shopify:9138480906394', 'shopify:9138687738010', 'shopify:9138708185242'] },
  { name: 'COZY collection', products: ['shopify:15430614679706', 'shopify:15430614745242'], project: 'stock-2' },
  { name: 'Fold-over Sweatpants', products: ['shopify:15430614810778'], project: 'stock-3' },
  { name: 'Other products', products: [] },
];

function readJson(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

export async function collectionSales(db) {
  const [variants, historical, website] = await statements(db, [
    ['SELECT id, product_id FROM variants'],
    [`SELECT o.source_id, o.line_items, d.data FROM shopify_orders o
      LEFT JOIN shopify_order_details d ON d.source_id=o.source_id
      WHERE o.currency='EGP' AND o.cancelled_at IS NULL AND lower(o.payment) NOT IN ('voided','expired')
      AND NOT EXISTS (SELECT 1 FROM finance_order_links l WHERE l.shopify_source_id=o.source_id)`],
    [`SELECT o.id, o.subtotal, o.discount, i.variant_id, i.quantity, i.price
      FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ${acceptedOrder}
      ORDER BY o.id,i.variant_id`],
  ]);
  const variantProducts = new Map(variants.results.map(v => [v.id, v.product_id]));
  const groups = collections.map(group => ({ ...group, orders: new Set(), quantity: 0, value: 0, missing: 0 }));
  function add(variant, order, quantity, amount) {
    const product = variantProducts.get(String(variant ?? '').replace(/^gid:\/\/shopify\/ProductVariant\//, ''));
    const group = groups.find(group => group.products.includes(product)) ?? groups.at(-1);
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(quantity)) {
      group.missing++;
      return;
    }
    if (!amount && !quantity) return;
    group.orders.add(order);
    group.quantity += quantity;
    group.value += amount;
  }
  for (const order of historical.results) {
    const detail = readJson(order.data, {});
    if (detail.test === true || (detail.header ?? detail).Test === 'true') continue;
    const lines = readJson(order.line_items, []);
    if (!Array.isArray(lines) || !lines.length) groups.at(-1).missing++;
    else for (const line of lines) {
      add(line.variant_id, 'shopify:' + order.source_id, line.net_quantity, line.net_revenue);
    }
  }
  let currentOrder, gross = 0, allocated = 0;
  for (const line of website.results) {
    if (line.id !== currentOrder) {
      currentOrder = line.id;
      gross = 0;
      allocated = 0;
    }
    const value = line.price * line.quantity;
    gross += value;
    const cumulative = line.subtotal ? Math.floor(gross * line.discount / line.subtotal) : 0;
    add(line.variant_id, 'website:' + line.id, line.quantity, value - (cumulative - allocated));
    allocated = cumulative;
  }
  return groups.filter(group => group.products.length || group.orders.size || group.missing)
    .map(group => ({ ...group, orders: group.orders.size }));
}

// Every sale as a dated point, for the overview chart. value = product value after discounts
// (same basis as "Sales by collection"); total = full order amount incl. shipping (once per order).
export async function salesPoints(db) {
  const [variants, historical, website] = await statements(db, [
    ['SELECT id, product_id FROM variants'],
    [`SELECT o.source_id, o.created_at, o.amount, o.line_items, d.data FROM shopify_orders o
      LEFT JOIN shopify_order_details d ON d.source_id=o.source_id
      WHERE o.currency='EGP' AND o.cancelled_at IS NULL AND lower(o.payment) NOT IN ('voided','expired')
      AND NOT EXISTS (SELECT 1 FROM finance_order_links l WHERE l.shopify_source_id=o.source_id)`],
    [`SELECT o.id, o.created_at, o.total, o.subtotal, o.discount, i.variant_id, i.quantity, i.price
      FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ${acceptedOrder}
      ORDER BY o.id,i.variant_id`],
  ]);
  const variantProducts = new Map(variants.results.map(v => [v.id, v.product_id]));
  const group = (variant) => {
    const product = variantProducts.get(String(variant ?? '').replace(/^gid:\/\/shopify\/ProductVariant\//, ''));
    return (collections.find(g => g.products.includes(product)) ?? collections.at(-1)).name;
  };
  const points = [];
  for (const order of historical.results) {
    const detail = readJson(order.data, {});
    if (detail.test === true || (detail.header ?? detail).Test === 'true') continue;
    const total = Math.round(Number(order.amount) * 100);
    points.push({ at: order.created_at, order: 'shopify:' + order.source_id, total: Number.isSafeInteger(total) ? total : 0, collection: null, value: 0, quantity: 0 });
    for (const line of readJson(order.line_items, [])) {
      if (Number.isSafeInteger(line.net_revenue) && Number.isSafeInteger(line.net_quantity) && (line.net_revenue || line.net_quantity))
        points.push({ at: order.created_at, order: 'shopify:' + order.source_id, total: 0, collection: group(line.variant_id), value: line.net_revenue, quantity: line.net_quantity });
    }
  }
  let current, gross = 0, allocated = 0;
  for (const line of website.results) {
    if (line.id !== current) {
      current = line.id; gross = 0; allocated = 0;
      points.push({ at: line.created_at, order: 'website:' + line.id, total: line.total, collection: null, value: 0, quantity: 0 });
    }
    const value = line.price * line.quantity;
    gross += value;
    const cumulative = line.subtotal ? Math.floor(gross * line.discount / line.subtotal) : 0;
    points.push({ at: line.created_at, order: 'website:' + line.id, total: 0, collection: group(line.variant_id), value: value - (cumulative - allocated), quantity: line.quantity });
    allocated = cumulative;
  }
  return points;
}
