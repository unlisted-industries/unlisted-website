import { mkdir, writeFile } from 'node:fs/promises';

const shop = process.env.SHOPIFY_SHOP ?? 'ngwh1j-t7.myshopify.com';
const token = process.env.SHOPIFY_ACCESS_TOKEN;
const mode = process.argv[2] ?? 'inventory';
if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop) || !token || !['inventory', 'history'].includes(mode)) {
  throw new Error('Provide the Shopify shop and read-only access token through the environment and choose inventory or history.');
}

const endpoint = 'https://' + shop + '/admin/api/2026-10/graphql.json';

async function graphql(query, variables) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });
    const body = await response.json().catch(() => ({}));
    const retry = response.status === 429 || response.status >= 500 ||
      body.errors?.some((error) => error.extensions?.code === 'THROTTLED');
    if (retry && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    if (!response.ok || body.errors?.length || !body.data) {
      const codes = (body.errors ?? []).map((error) => error.extensions?.code ?? 'QUERY_ERROR');
      throw new Error('Shopify export failed. HTTP ' + response.status + (codes.length ? ' / ' + codes.join(', ') : ''));
    }
    return body.data;
  }
}

async function* rows(connection, query, variables = {}) {
  let cursor = null;
  do {
    const data = await graphql(query, { ...variables, cursor });
    const page = connection.split('.').reduce((node, field) => node?.[field], data);
    if (!page?.nodes || page.pageInfo.hasNextPage && (!page.pageInfo.endCursor || cursor === page.pageInfo.endCursor)) {
      throw new Error('Shopify returned an incomplete or invalid page.');
    }
    yield* page.nodes;
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
}

function sql(value) {
  return value == null ? 'NULL' : typeof value === 'number' && Number.isSafeInteger(value) ? String(value)
    : "'" + String(value).replaceAll("'", "''") + "'";
}

function shopifyId(gid, resource) {
  const match = new RegExp('^gid://shopify/' + resource + '/(\\d+)$').exec(gid);
  if (!match) throw new Error('Unexpected Shopify resource ID.');
  return match[1];
}

function timestamp(value) {
  if (value == null) return null;
  const seconds = Math.floor(Date.parse(value) / 1000);
  if (!Number.isSafeInteger(seconds)) throw new Error('Unexpected Shopify timestamp.');
  return seconds;
}

const directory = '.local/shopify';
await mkdir(directory, { recursive: true, mode: 0o700 });

if (mode === 'inventory') {
  const data = [];
  const query = `query ExportVariants($cursor: String) {
    productVariants(first: 100, after: $cursor) {
      nodes { id inventoryPolicy sellableOnlineQuantity inventoryItem { tracked } product { id handle } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  for await (const variant of rows('productVariants', query)) {
    data.push({
      id: shopifyId(variant.id, 'ProductVariant'), product_id: 'shopify:' + shopifyId(variant.product.id, 'Product'),
      handle: variant.product.handle, tracked: variant.inventoryItem.tracked, policy: variant.inventoryPolicy,
      quantity: variant.sellableOnlineQuantity,
    });
  }
  const stock = data.filter((row) => row.tracked && row.policy === 'DENY' && Number.isSafeInteger(row.quantity));
  const statements = stock.map((row) => 'UPDATE variants SET inventory = ' + Math.max(0, row.quantity) +
    ' WHERE id = ' + sql(row.id) + ' AND product_id = ' + sql(row.product_id) + ' AND inventory IS NULL;');
  await writeFile(directory + '/inventory.json', JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  await writeFile(directory + '/initial-stock.sql', statements.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Exported ${data.length} variants. ${stock.length} tracked, non-backorder variants are eligible for first-time stock import.`);
} else {
  const orders = [];
  const orderQuery = `query ExportOrders($cursor: String) {
    orders(first: 25, after: $cursor, sortKey: CREATED_AT) {
      nodes {
        id name createdAt email displayFinancialStatus displayFulfillmentStatus cancelledAt
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 25) {
          nodes { name sku quantity }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const lineQuery = `query ExportOrderLines($id: ID!, $cursor: String) {
    order(id: $id) {
      lineItems(first: 100, after: $cursor) {
        nodes { name sku quantity }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;
  for await (const order of rows('orders', orderQuery)) {
    const items = order.lineItems.pageInfo.hasNextPage ? [] : order.lineItems.nodes;
    if (order.lineItems.pageInfo.hasNextPage) {
      for await (const item of rows('order.lineItems', lineQuery, { id: order.id })) items.push(item);
    }
    const money = order.currentTotalPriceSet.shopMoney;
    orders.push({
      id: shopifyId(order.id, 'Order'), name: order.name, email: order.email?.trim().toLowerCase() ?? null,
      created_at: timestamp(order.createdAt), cancelled_at: timestamp(order.cancelledAt),
      payment: order.displayFinancialStatus ?? '', fulfillment: order.displayFulfillmentStatus ?? '',
      amount: money.amount, currency: money.currencyCode, items,
    });
  }
  const customers = [];
  const customerQuery = `query ExportCustomers($cursor: String) {
    customers(first: 100, after: $cursor) {
      nodes { id displayName defaultEmailAddress { emailAddress } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  for await (const customer of rows('customers', customerQuery)) {
    const email = customer.defaultEmailAddress?.emailAddress?.trim().toLowerCase();
    if (email) customers.push({ id: shopifyId(customer.id, 'Customer'), email, name: customer.displayName ?? '' });
  }
  const statements = orders.map((order) => `INSERT INTO shopify_orders
    (source_id, order_number, email, created_at, cancelled_at, payment, fulfillment, amount, currency, line_items)
    VALUES (${[order.id, order.name, order.email, order.created_at, order.cancelled_at, order.payment, order.fulfillment,
      order.amount, order.currency, JSON.stringify(order.items)].map(sql).join(', ')})
    ON CONFLICT (source_id) DO UPDATE SET email = excluded.email, cancelled_at = excluded.cancelled_at,
      payment = excluded.payment, fulfillment = excluded.fulfillment, amount = excluded.amount, line_items = excluded.line_items;`);
  for (const customer of customers) {
    statements.push('INSERT OR IGNORE INTO customers (id, email, name) VALUES (' +
      [sql('shopify:' + customer.id), sql(customer.email), sql(customer.name)].join(', ') + ');');
  }
  await writeFile(directory + '/history.json', JSON.stringify({ orders, customers }, null, 2), { mode: 0o600, flag: 'wx' });
  await writeFile(directory + '/history.sql', statements.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Prepared ${orders.length} accessible orders and ${customers.length} accounts for private D1 import.`);
}
