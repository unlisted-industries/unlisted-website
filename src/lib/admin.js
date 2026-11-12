import { all, isToken, makeToken, statements, unixNow } from './db.js';
import { discountCode, acceptedOrder } from './checkout.js';
import { safeHtml, safeLink, parseCairoDateTime } from './content.js';
import { checked, priceValue, quantityValue, slugValue, StoreError, textValue } from './http.js';
import { cardReady } from './paymob.js';
import { ensureReturns, manageReturn } from './returns.js';
import { importShopify } from './shopify-import.js';
import { reportingRange } from './reporting.js';

export const adminSections = [
  ['products', 'Products'], ['collections', 'Collections'], ['orders', 'Orders'], ['customers', 'Customers'],
  ['discounts', 'Discounts'], ['shipping', 'Shipping'], ['content', 'Content'],
  ['media', 'Media'], ['inbox', 'Inbox'], ['settings', 'Settings'],
  ['returns', 'Returns & exchanges'], ['migration', 'Shopify migration'],
];

export function queryOffset(url) {
  return Math.max(0, Math.min(10000, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0));
}

export const reportingPeriods = [1, 7, 30, 90];

export function reportDays(url) {
  const selected = Number(url.searchParams.get('days'));
  return reportingPeriods.includes(selected) ? selected : 30;
}

function path(area, key, value) {
  return '/admin/' + area + (key && value ? '?' + new URLSearchParams({ [key]: value }) : '');
}

function oneChange(result, message) {
  if (result.meta.changes !== 1) throw new StoreError(message, 409);
}

function commaList(form, name) {
  return textValue(form, name, 180, false).split(',').map((value) => value.trim()).filter(Boolean).slice(0, 3);
}

async function productAction(env, form) {
  const handle = slugValue(form.get('handle'));
  const title = textValue(form, 'title', 150);
  const description = safeHtml(textValue(form, 'description', 16000, false));
  const category = form.get('category') ? slugValue(form.get('category')) : '';
  const status = form.get('status');
  if (!['draft', 'active', 'archived'].includes(status)) throw new StoreError('Select a product status.');
  const chart = textValue(form, 'size_chart_key', 185, false) || null;
  if (chart && !await env.DB.prepare("SELECT 1 FROM media WHERE key = ? AND content_type LIKE 'image/%'").bind(chart).first()) {
    throw new StoreError('Select a size chart image from the media library.');
  }
  const values = [title, description, category, status, chart, checked(form, 'preorder'), checked(form, 'featured'),
    quantityValue(form.get('position') || '0', 0, 999999), JSON.stringify(commaList(form, 'option_names'))];
  if (form.get('mode') === 'new') {
    const existing = await env.DB.prepare('SELECT 1 FROM products WHERE handle = ?').bind(handle).first();
    if (existing) throw new StoreError('This product handle is already in use.');
    await env.DB.prepare(`INSERT INTO products (id, handle, title, description, category, status, size_chart_key, preorder, featured, position, option_names)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(makeToken(), handle, ...values).run();
  } else {
    oneChange(await env.DB.prepare(`UPDATE products SET title = ?, description = ?, category = ?, status = ?, size_chart_key = ?,
      preorder = ?, featured = ?, position = ?, option_names = ?, updated_at = unixepoch() WHERE handle = ?`)
      .bind(...values, handle).run(), 'Product was not found.');
  }
  return path('products', 'product', handle);
}

async function variantAction(env, form) {
  const handle = slugValue(form.get('handle'));
  const product = await env.DB.prepare('SELECT id FROM products WHERE handle = ?').bind(handle).first();
  if (!product) throw new StoreError('Product was not found.', 404);
  const id = textValue(form, 'variant', 100, false);
  const title = textValue(form, 'variant_title', 120);
  const price = priceValue(form.get('price'));
  const compareAt = form.get('compare_at') ? priceValue(form.get('compare_at')) : null;
  const stock = form.get('inventory') ? quantityValue(form.get('inventory'), 0, 99999999) : null;
  if (compareAt !== null && compareAt < price) throw new StoreError('The compare-at price must be at least the selling price.');
  const values = [title, textValue(form, 'sku', 100, false), JSON.stringify(commaList(form, 'options')),
    price, compareAt, stock, checked(form, 'active'), quantityValue(form.get('position') || '0', 0, 999999)];
  if (!id) {
    await env.DB.prepare(`INSERT INTO variants
      (id, product_id, title, sku, options, price, compare_at, inventory, active, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(makeToken(), product.id, ...values).run();
  } else {
    const before = form.get('inventory_before') === '' ? null : quantityValue(form.get('inventory_before'), 0, 99999999);
    if (before !== null && stock === null) throw new StoreError('Enter a quantity. Use zero when inventory is out of stock.');
    oneChange(await env.DB.prepare(`UPDATE variants SET title = ?, sku = ?, options = ?, price = ?, compare_at = ?,
      inventory = ?, active = ?, position = ? WHERE id = ? AND product_id = ? AND inventory IS ?`)
      .bind(...values, id, product.id, before).run(), 'Inventory changed. Reload the product before saving.');
  }
  return path('products', 'product', handle);
}

async function collectionAction(env, form) {
  const handle = slugValue(form.get('handle'));
  const title = textValue(form, 'title', 150);
  const description = safeHtml(textValue(form, 'description', 16000, false));
  const productIds = form.getAll('product_id').filter((value) => typeof value === 'string' && value.length <= 100);
  const editing = form.get('mode') !== 'new';
  if (!editing && await env.DB.prepare('SELECT 1 FROM collections WHERE handle = ?').bind(handle).first()) {
    throw new StoreError('This collection handle is already in use.');
  }
  await statements(env.DB, [
    [`INSERT INTO collections (handle, title, description, active) VALUES (?, ?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET title = excluded.title, description = excluded.description, active = excluded.active`,
    handle, title, description, checked(form, 'active')],
    ['DELETE FROM collection_products WHERE collection_handle = ?', handle],
    [`INSERT OR IGNORE INTO collection_products (collection_handle, product_id, position)
      SELECT ?, p.id, p.position FROM json_each(?) items JOIN products p ON p.id = items.value`,
    handle, JSON.stringify(productIds)],
  ]);
  return path('collections', 'collection', handle);
}

async function pageAction(env, form) {
  const handle = slugValue(form.get('handle'));
  if (form.get('mode') === 'new' && await env.DB.prepare('SELECT 1 FROM pages WHERE handle = ?').bind(handle).first()) {
    throw new StoreError('This page handle is already in use.');
  }
  await env.DB.prepare(`INSERT INTO pages (handle, title, body, active) VALUES (?, ?, ?, ?)
    ON CONFLICT (handle) DO UPDATE SET title = excluded.title, body = excluded.body, active = excluded.active`)
    .bind(handle, textValue(form, 'title', 150), safeHtml(textValue(form, 'body', 20000, false)), checked(form, 'active')).run();
  return path('content', 'page', handle);
}

async function shippingAction(env, form) {
  const code = slugValue(form.get('code'));
  await env.DB.prepare(`INSERT INTO shipping_rates (code, label, amount, active) VALUES (?, ?, ?, ?)
    ON CONFLICT (code) DO UPDATE SET label = excluded.label, amount = excluded.amount, active = excluded.active`)
    .bind(code, textValue(form, 'label', 100), priceValue(form.get('amount')), checked(form, 'active')).run();
  return path('shipping');
}

function dateValue(value) {
  if (!value) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new StoreError('Enter a valid date and time.');
  const time = parseCairoDateTime(value);
  if (time === null) throw new StoreError('Enter a valid date and time.');
  return time;
}

async function discountAction(env, form) {
  const code = discountCode(textValue(form, 'code', 32));
  const kind = form.get('kind');
  if (kind !== 'fixed' && kind !== 'percent') throw new StoreError('Select a discount type.');
  const value = kind === 'percent' ? quantityValue(form.get('value'), 1, 100) : priceValue(form.get('value'));
  if (!value) throw new StoreError('The discount must be greater than zero.');
  const maxUses = form.get('max_uses') ? quantityValue(form.get('max_uses'), 1, 999999) : null;
  const starts = dateValue(form.get('starts_at'));
  const ends = dateValue(form.get('ends_at'));
  if (starts !== null && ends !== null && starts >= ends) throw new StoreError('The expiration must be after the start.');
  await env.DB.prepare(`INSERT INTO discounts (code, kind, value, min_subtotal, max_uses, starts_at, ends_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO UPDATE SET kind = excluded.kind, value = excluded.value,
    min_subtotal = excluded.min_subtotal, max_uses = excluded.max_uses, starts_at = excluded.starts_at,
    ends_at = excluded.ends_at, active = excluded.active`)
    .bind(code, kind, value, priceValue(form.get('min_subtotal') || '0'), maxUses, starts, ends, checked(form, 'active')).run();
  return path('discounts');
}

const transitions = {
  confirm: "status = 'confirmed', updated_at = unixepoch() WHERE id = ? AND status = 'new' AND (payment_method = 'cod' OR payment_status = 'paid')",
  ship: "status = 'shipped', tracking = ?, updated_at = unixepoch() WHERE id = ? AND status = 'confirmed'",
  deliver: "status = 'delivered', updated_at = unixepoch() WHERE id = ? AND status = 'shipped'",
  cancel: "status = 'cancelled', payment_status = CASE WHEN payment_status = 'pending' THEN 'unpaid' ELSE payment_status END, checkout_url = NULL, updated_at = unixepoch() WHERE id = ? AND status IN ('new','confirmed') AND payment_status IN ('unpaid','pending','refunded')",
  collect: "payment_status = 'paid', updated_at = unixepoch() WHERE id = ? AND payment_method = 'cod' AND payment_status = 'unpaid' AND status IN ('confirmed','shipped','delivered')",
  refund: `payment_status = 'refunded', payment_note = ?, updated_at = unixepoch() WHERE id = ? AND payment_status IN ('paid','review')
    AND NOT EXISTS (SELECT 1 FROM order_returns WHERE order_id = orders.id AND kind = 'refund' AND state NOT IN ('declined','cancelled'))`,
};

async function orderAction(env, form) {
  const id = form.get('id');
  const action = form.get('operation');
  if (!isToken(id, 16) || !Object.hasOwn(transitions, action)) throw new StoreError('Choose a valid order action.');
  const values = action === 'ship' ? [textValue(form, 'tracking', 180, false)]
    : action === 'refund' ? [textValue(form, 'payment_note', 180)] : [];
  if (action === 'deliver' || action === 'refund') await ensureReturns(env.DB);
  if (action === 'deliver') {
    const [delivered] = await statements(env.DB, [
      ['UPDATE orders SET ' + transitions.deliver, id],
      [`INSERT INTO order_deliveries (order_id, delivered_at) SELECT id, updated_at FROM orders
        WHERE id = ? AND status = 'delivered' ON CONFLICT (order_id) DO NOTHING`, id],
    ]);
    oneChange(delivered, 'This action is unavailable for the current order status.');
    return path('orders', 'order', id);
  }
  const changed = await env.DB.prepare('UPDATE orders SET ' + transitions[action] + ' RETURNING id')
    .bind(...values, id).first();
  if (!changed) throw new StoreError('This action is unavailable for the current order status.', 409);
  return path('orders', 'order', id);
}

const mediaTypes = {
  'image/png': { suffix: 'png', prefix: [137, 80, 78, 71, 13, 10, 26, 10] },
  'image/jpeg': { suffix: 'jpg', prefix: [255, 216, 255] },
  'image/webp': { suffix: 'webp', prefix: [82, 73, 70, 70], second: [8, 87, 69, 66, 80] },
  'video/mp4': { suffix: 'mp4', prefix: [], second: [4, 102, 116, 121, 112] },
};

async function mediaAction(env, form) {
  const product = form.get('product') ? slugValue(form.get('product')) : '';
  const id = product ? (await env.DB.prepare('SELECT id FROM products WHERE handle = ?').bind(product).first())?.id : null;
  if (product && !id) throw new StoreError('Product was not found.');
  if (form.get('remove')) {
    if (!id) throw new StoreError('Choose a product.');
    await env.DB.prepare('DELETE FROM product_images WHERE product_id = ? AND media_key = ?').bind(id, textValue(form, 'remove', 185)).run();
    return path('products', 'product', product);
  }

  const position = quantityValue(form.get('position') || '0', 0, 999999);
  const alt = textValue(form, 'alt', 250, false);
  const selected = textValue(form, 'media_key', 185, false);
  const relation = (key) => [`INSERT INTO product_images (product_id, media_key, alt, position)
    VALUES (?, ?, ?, ?) ON CONFLICT (product_id, media_key) DO UPDATE SET alt = excluded.alt, position = excluded.position`,
  id, key, alt, position];

  if (selected && id) {
    const image = await env.DB.prepare("SELECT 1 FROM media WHERE key = ? AND content_type LIKE 'image/%'").bind(selected).first();
    if (!image) throw new StoreError('Select an image from the media library.');
    await statements(env.DB, [relation(selected)]);
    return path('products', 'product', product);
  }

  const file = form.get('file');
  const spec = file instanceof File ? mediaTypes[file.type] : null;
  if (!spec || !file.size || file.size > 16 * 1024 * 1024 || id && !file.type.startsWith('image/')) {
    throw new StoreError('Upload a JPEG, PNG, WebP or MP4 up to 16 MB. Product media must be images.');
  }
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const primary = spec.prefix.every((byte, index) => header[index] === byte);
  const secondary = !spec.second || spec.second.slice(1).every((byte, index) => header[spec.second[0] + index] === byte);
  if (!primary || !secondary) throw new StoreError('The file type does not match the selected media.');
  const key = 'upload/' + makeToken() + '.' + spec.suffix;
  await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  try {
    await statements(env.DB, [
      ['INSERT INTO media (key, content_type, original_name) VALUES (?, ?, ?)', key, file.type, file.name.slice(0, 200)],
      ...(id ? [relation(key)] : []),
    ]);
  } catch (error) {
    await env.MEDIA.delete(key).catch(() => {});
    throw error;
  }
  return id ? path('products', 'product', product) : path('media');
}

function formLinks(form, prefix) {
  const links = [];
  for (let index = 0; index < 24; index++) {
    const label = textValue(form, prefix + '_label_' + index, 80, false);
    const url = textValue(form, prefix + '_url_' + index, 500, false);
    if (!label && !url) continue;
    if (!label || !safeLink(url)) throw new StoreError('Each navigation or social link needs a label and a valid HTTPS or store URL.');
    const group = form.get(prefix + '_group_' + index) === 'collections' ? 'collections' : 'menu';
    links.push(prefix === 'nav' ? { label, url, group } : { label, url });
  }
  return JSON.stringify(links);
}

async function settingsAction(env, form) {
  const cod = checked(form, 'cod_enabled');
  const card = checked(form, 'card_enabled');
  const checkout = checked(form, 'checkout_enabled');
  if (checkout) {
    const checks = await env.DB.prepare(`SELECT
      (SELECT count(*) FROM shipping_rates WHERE active = 1) AS rates,
      (SELECT count(*) FROM variants v JOIN products p ON p.id = v.product_id
        WHERE p.status = 'active' AND p.preorder = 0 AND v.active = 1 AND v.published_available = 1 AND v.inventory IS NULL) AS unknown`).first();
    if (!checks.rates || checks.unknown || !(cod || card && cardReady(env))) {
      throw new StoreError('Enable a shipping rate and a configured payment method, then verify stock for available variants.');
    }
  }
  const images = await all(env.DB.prepare('SELECT key, content_type FROM media'));
  function mediaKey(name, kind) {
    const key = textValue(form, name, 185, false);
    if (key && !images.some((row) => row.key === key && row.content_type.startsWith(kind + '/'))) {
      throw new StoreError('Select the correct type of media for the film or poster.');
    }
    return key || null;
  }
  await env.DB.prepare(`UPDATE store_settings SET name = ?, home_heading = ?, size_guide = ?, hero_desktop = ?,
    hero_mobile = ?, hero_poster = ?, navigation = ?, socials = ?, checkout_enabled = ?, cod_enabled = ?,
    card_enabled = ?, analytics_enabled = ? WHERE id = 1`).bind(
    textValue(form, 'name', 80), textValue(form, 'home_heading', 100), textValue(form, 'size_guide', 3000, false),
    mediaKey('hero_desktop', 'video'), mediaKey('hero_mobile', 'video'), mediaKey('hero_poster', 'image'),
    formLinks(form, 'nav'), formLinks(form, 'social'), checkout, cod, card, checked(form, 'analytics_enabled'),
  ).run();
  return path('settings');
}

async function inboxAction(env, form) {
  const id = textValue(form, 'id', 48);
  await env.DB.prepare('UPDATE contact_messages SET read_at = unixepoch() WHERE id = ?').bind(id).run();
  return path('inbox');
}

export const adminActions = {
  product: productAction, variant: variantAction, collection: collectionAction,
  page: pageAction, shipping: shippingAction, discount: discountAction, order: orderAction,
  media: mediaAction, settings: settingsAction, inbox: inboxAction, return: manageReturn, 'shopify-import': importShopify,
};

export async function dashboard(db, period) {
  await ensureReturns(db);
  const range = typeof period === 'object' ? period : reportingRange(new URL('https://unlisted.invalid/?days=' + (period ?? 30)));
  const queries = (window) => [
    [`SELECT count(*) AS sales, coalesce(sum(total), 0) AS gross,
      coalesce(sum(CASE WHEN payment_status = 'paid' THEN total - (SELECT coalesce(sum(refund_amount), 0)
        FROM order_returns WHERE order_id = orders.id AND state = 'completed') ELSE 0 END), 0) AS revenue
      FROM orders WHERE created_at >= ? AND created_at < ? AND ${acceptedOrder}`, window.start, window.end],
    ['SELECT count(DISTINCT visitor_id) AS visitors FROM visits WHERE day >= ? AND day < ?', window.startDate, window.untilDate],
    [`SELECT count(DISTINCT o.visitor_id) AS converted FROM orders o
      WHERE o.created_at >= ? AND o.created_at < ? AND ${acceptedOrder} AND EXISTS (
        SELECT 1 FROM visits v WHERE v.visitor_id = o.visitor_id AND v.day = o.visitor_day AND v.day >= ? AND v.day < ?
      )`, window.start, window.end, window.startDate, window.untilDate],
  ];
  const results = await statements(db, [
    ...queries(range.current),
    [`SELECT i.product_title AS title, sum(i.quantity) AS units, sum(i.quantity * i.price) AS gross
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.created_at >= ? AND o.created_at < ? AND ${acceptedOrder} GROUP BY i.product_title ORDER BY units DESC, gross DESC LIMIT 8`, range.current.start, range.current.end],
    ...queries(range.previous ?? range.current),
    [`SELECT count(*) AS count FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.status = 'active' AND p.preorder = 0 AND v.active = 1 AND v.published_available = 1 AND v.inventory IS NULL`],
    ["SELECT count(*) AS count FROM payment_events WHERE state = 'late'"],
    ["SELECT count(*) AS count FROM orders WHERE status = 'new' AND (payment_method = 'cod' OR payment_status = 'paid')"],
    ["SELECT count(*) AS count FROM order_returns WHERE state = 'requested'"],
  ]);
  return {
    ...results[0].results[0], visitors: results[1].results[0].visitors, converted: results[2].results[0].converted,
    products: results[3].results, previous: range.previous ? {
      ...results[4].results[0], visitors: results[5].results[0].visitors, converted: results[6].results[0].converted,
    } : null,
    unknownStock: results[7].results[0].count, latePayments: results[8].results[0].count,
    newOrders: results[9].results[0].count, newReturns: results[10].results[0].count,
  };
}
