import { acceptedOrder } from './checkout.js';
import { all, initializeTables, makeToken, statements } from './db.js';
import { ensureOperations } from './operations.js';
import { ensureSimpleFinance, stockMetrics } from './finance-simple.js';
import { priceValue, quantityValue, StoreError, textValue } from './http.js';

// Per-stock settings the owner can edit (price, ad spend, pieces for sale) and PR / UGC gifts.
export const ensureStocks = initializeTables(`
CREATE TABLE IF NOT EXISTS finance_stock_settings (project_id TEXT PRIMARY KEY, price INTEGER, ads INTEGER NOT NULL DEFAULT 0, pieces INTEGER, updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE IF NOT EXISTS marketing_pr (
  id TEXT PRIMARY KEY, gifted_on TEXT NOT NULL, creator TEXT NOT NULL, project_id TEXT, variant_id TEXT,
  product_title TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)), amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  took_stock INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);

async function prepare(db) {
  await ensureOperations(db);
  await ensureSimpleFinance(db);
  await ensureStocks(db);
}

function readJson(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

// Paid product revenue (after discounts, excluding shipping) by product, from Shopify history and the website.
export async function productSales(db) {
  const [variants, historical, website] = await statements(db, [
    ['SELECT id, product_id FROM variants'],
    [`SELECT o.source_id, o.line_items, d.data FROM shopify_orders o
      LEFT JOIN shopify_order_details d ON d.source_id=o.source_id
      WHERE o.currency='EGP' AND o.cancelled_at IS NULL AND lower(o.payment) NOT IN ('voided','expired')
      AND NOT EXISTS (SELECT 1 FROM finance_order_links l WHERE l.shopify_source_id=o.source_id)`],
    [`SELECT o.id, o.subtotal, o.discount, i.variant_id, i.quantity, i.price
      FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ${acceptedOrder} ORDER BY o.id,i.variant_id`],
  ]);
  const productOf = new Map(variants.results.map((v) => [v.id, v.product_id]));
  const sales = new Map();
  const add = (variant, order, quantity, amount) => {
    const product = productOf.get(String(variant ?? '').replace(/^gid:\/\/shopify\/ProductVariant\//, ''));
    if (!product || !Number.isSafeInteger(amount) || !Number.isSafeInteger(quantity) || (!amount && !quantity)) return;
    const row = sales.get(product) ?? { value: 0, quantity: 0, orders: new Set() };
    row.value += amount; row.quantity += quantity; row.orders.add(order); sales.set(product, row);
  };
  for (const order of historical.results) {
    const detail = readJson(order.data, {});
    if (detail.test === true || (detail.header ?? detail).Test === 'true') continue;
    for (const line of readJson(order.line_items, [])) add(line.variant_id, 'shopify:' + order.source_id, line.net_quantity, line.net_revenue);
  }
  let current, gross = 0, allocated = 0;
  for (const line of website.results) {
    if (line.id !== current) { current = line.id; gross = 0; allocated = 0; }
    const value = line.price * line.quantity;
    gross += value;
    const cumulative = line.subtotal ? Math.floor(gross * line.discount / line.subtotal) : 0;
    add(line.variant_id, 'website:' + line.id, line.quantity, value - (cumulative - allocated));
    allocated = cumulative;
  }
  return sales;
}

export async function stockList(db) {
  await prepare(db);
  const [projects, costs, products, settings, gifts, prices, sales] = await Promise.all([
    all(db.prepare('SELECT * FROM ops_projects ORDER BY business <> \'UNLISTED\', id')),
    all(db.prepare('SELECT * FROM ops_costs')),
    all(db.prepare('SELECT * FROM ops_products')),
    all(db.prepare('SELECT * FROM finance_stock_settings')),
    all(db.prepare('SELECT project_id, sum(quantity) units, sum(amount) cost FROM marketing_pr GROUP BY project_id')),
    all(db.prepare('SELECT product_id, max(price) price FROM variants WHERE active=1 GROUP BY product_id')),
    productSales(db),
  ]);
  return projects.map((project) => {
    const own = products.filter((p) => p.project_id === project.id);
    const set = settings.find((s) => s.project_id === project.id) ?? {};
    const pr = gifts.find((g) => g.project_id === project.id) ?? { units: 0, cost: 0 };
    const lines = costs.filter((c) => c.project_id === project.id);
    const cost = lines.filter((c) => c.state !== 'unconfirmed').reduce((n, c) => n + c.amount, 0);
    const counted = own.filter((p) => p.received !== null || p.planned !== null);
    const pieces = set.pieces ?? (counted.length ? counted.reduce((n, p) => n + Math.max(0, (p.received ?? p.planned) - p.personal - p.samples), 0) : null);
    const priced = own.map((p) => p.price ?? prices.find((v) => v.product_id === p.product_id)?.price ?? null).filter((v) => v !== null);
    const price = set.price ?? (priced.length ? Math.round(priced.reduce((a, b) => a + b, 0) / priced.length) : null);
    const sold = own.reduce((acc, p) => {
      const s = p.product_id ? sales.get(p.product_id) : null;
      if (s) { acc.value += s.value; acc.quantity += s.quantity; s.orders.forEach((o) => acc.orders.add(o)); }
      return acc;
    }, { value: 0, quantity: 0, orders: new Set() });
    const ads = set.ads ?? 0;
    const metrics = pieces && price ? stockMetrics({ quantity: pieces, total_cost: cost, price, fees: 0, ads, pr_units: Math.min(pieces, pr.units ?? 0), pr_cost: pr.cost ?? 0 }) : null;
    return {
      ...project, products: own, costs: lines, cost, estimated: lines.some((c) => c.state === 'estimate'),
      pieces, price, ads, prUnits: pr.units ?? 0, prCost: pr.cost ?? 0,
      revenue: sold.value, soldPieces: sold.quantity, orders: sold.orders.size,
      left: pieces === null ? null : Math.max(0, pieces - sold.quantity - (pr.units ?? 0)),
      profitSoFar: sold.value - cost - ads - (pr.cost ?? 0),
      metrics,
    };
  });
}

export async function stockAction(db, form) {
  await prepare(db);
  const op = form.get('op');
  if (op === 'stock_new') {
    const name = textValue(form, 'name', 80);
    const id = 'stock-' + makeToken(4);
    await db.prepare("INSERT INTO ops_projects(id,name,business,state,note) VALUES(?,?,'UNLISTED','New','')").bind(id, name).run();
    return id;
  }
  const project = textValue(form, 'project_id', 120);
  if (!await db.prepare('SELECT 1 FROM ops_projects WHERE id=?').bind(project).first()) throw new StoreError('Choose a stock.');
  if (op === 'stock_settings') {
    const price = form.get('price') ? priceValue(form.get('price')) : null;
    const pieces = form.get('pieces') ? quantityValue(form.get('pieces'), 1, 1000000) : null;
    const ads = priceValue(form.get('ads') || '0');
    await db.prepare(`INSERT INTO finance_stock_settings(project_id,price,ads,pieces) VALUES(?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET price=excluded.price,ads=excluded.ads,pieces=excluded.pieces,updated_at=unixepoch()`)
      .bind(project, price, ads, pieces).run();
  } else if (op === 'stock_cost') {
    const state = textValue(form, 'state', 12);
    if (!['paid', 'unpaid'].includes(state)) throw new StoreError('Choose paid or unpaid.');
    await db.prepare('INSERT INTO ops_costs(id,project_id,description,amount,state) VALUES(?,?,?,?,?)')
      .bind(makeToken(16), project, textValue(form, 'description', 120), priceValue(form.get('amount')), state).run();
  } else throw new StoreError('Unknown action.');
  return project;
}

export async function prList(db) {
  await prepare(db);
  return all(db.prepare(`SELECT g.*, p.name AS stock FROM marketing_pr g LEFT JOIN ops_projects p ON p.id=g.project_id
    ORDER BY g.gifted_on DESC, g.created_at DESC LIMIT 100`));
}

export async function addPr(db, form) {
  await prepare(db);
  const creator = textValue(form, 'creator', 100);
  const date = textValue(form, 'gifted_on', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new StoreError('Choose a date.');
  const project = textValue(form, 'project_id', 120, false) || null;
  if (project && !await db.prepare('SELECT 1 FROM ops_projects WHERE id=?').bind(project).first()) throw new StoreError('Choose a collection.');
  const variant = await db.prepare(`SELECT v.id, v.inventory, p.title || ' · ' || v.title AS title FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?`)
    .bind(textValue(form, 'variant_id', 120)).first();
  if (!variant) throw new StoreError('Choose the product.');
  const quantity = quantityValue(form.get('quantity') || '1', 1, 100);
  const paid = form.get('paid') === 'yes';
  const amount = paid ? priceValue(form.get('amount') || '0') : 0;
  if (paid && !amount) throw new StoreError('Enter how much you paid.');
  const take = form.get('take_stock') === 'on' && variant.inventory !== null && variant.inventory >= quantity;
  const id = makeToken(16);
  await db.batch([
    db.prepare(`INSERT INTO marketing_pr(id,gifted_on,creator,project_id,variant_id,product_title,quantity,paid,amount,took_stock,note)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(id, date, creator, project, variant.id, variant.title, quantity, Number(paid), amount, Number(take), textValue(form, 'note', 300, false)),
    ...(take ? [db.prepare('UPDATE variants SET inventory=inventory-? WHERE id=? AND inventory>=?').bind(quantity, variant.id, quantity)] : []),
  ]);
}
