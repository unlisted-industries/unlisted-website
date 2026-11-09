import { all, isToken, makeToken, sha256, statements, unixNow } from './db.js';
import { getCart, cartId } from './cart.js';
import { currentUser, sendEmail } from './auth.js';
import { emailValue, StoreError, textValue } from './http.js';
import { money } from './content.js';

export const holdSeconds = 30 * 60;
export const acceptedOrder = "(status <> 'cancelled' AND (payment_method = 'cod' OR payment_status IN ('paid','refunded')))";

export function checkoutReady(env, settings) {
  return env.CHECKOUT_ENABLED === 'true' && Boolean(settings.checkout_enabled);
}

export function discountCode(input) {
  const code = input.trim().toUpperCase();
  if (code && !/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code)) throw new StoreError('Enter a valid discount code.');
  return code;
}

export function checkoutInput(form) {
  const phone = textValue(form, 'phone', 24);
  if (!/^\+?[\d ()-]{8,24}$/.test(phone) || phone.replace(/\D/g, '').length < 8) {
    throw new StoreError('Enter a valid phone number.');
  }
  return {
    name: textValue(form, 'name', 100),
    email: emailValue(form),
    phone,
    address: textValue(form, 'address', 350),
    city: textValue(form, 'city', 100),
    governorate: textValue(form, 'governorate', 80),
    coupon: discountCode(textValue(form, 'discount', 32, false)),
    method: textValue(form, 'payment_method', 12),
  };
}

export async function shippingRates(db) {
  return all(db.prepare('SELECT code, label, amount FROM shipping_rates WHERE active = 1 ORDER BY label'));
}

export async function quote(db, id, governorate, code, requireInventory = true) {
  const [cart, rate] = await Promise.all([
    getCart(db, id),
    db.prepare('SELECT code, label, amount FROM shipping_rates WHERE code = ? AND active = 1').bind(governorate).first(),
  ]);
  if (!cart.items.length) throw new StoreError('Your cart is empty.');
  if (!rate) throw new StoreError('Select a governorate we deliver to.');
  if (cart.items.some((item) => !item.available || (requireInventory && item.inventory === null))) {
    throw new StoreError('One or more items are currently unavailable for checkout. Review your cart.', 409);
  }
  const coupon = code ? await db.prepare(`SELECT code, kind, value FROM discounts WHERE code = ? AND active = 1
    AND min_subtotal <= ? AND (max_uses IS NULL OR uses < max_uses)
    AND (starts_at IS NULL OR starts_at <= unixepoch()) AND (ends_at IS NULL OR ends_at > unixepoch())`)
    .bind(code, cart.subtotal).first() : null;
  if (code && !coupon) throw new StoreError('This discount code is unavailable for your order.');
  const discount = coupon
    ? Math.min(cart.subtotal, coupon.kind === 'percent' ? Math.floor(cart.subtotal * coupon.value / 100) : coupon.value)
    : 0;
  return { ...cart, rate, discount, total: cart.subtotal + rate.amount - discount };
}

export async function placeOrder(db, { id, key, input, expected, user, visitor }) {
  if (!isToken(id) || !isToken(key)) throw new StoreError('Start checkout from your cart.');
  const requestDigest = await sha256(JSON.stringify([id, input, expected]));
  async function previousOrder() {
    const order = await db.prepare('SELECT * FROM orders WHERE checkout_key = ?').bind(key).first();
    if (order && (order.cart_id !== id || order.request_digest !== requestDigest)) {
      throw new StoreError('This checkout was already submitted. Reopen the checkout page.', 409);
    }
    return order;
  }
  const previous = await previousOrder();
  if (previous) return { order: previous, created: false };

  let totals;
  try {
    totals = await quote(db, id, input.governorate, input.coupon);
  } catch (error) {
    const retry = await previousOrder();
    if (retry) return { order: retry, created: false };
    throw error;
  }

  if (totals.version !== expected?.version || totals.total !== expected?.total) {
    throw new StoreError('The cart or total changed. Review your order again.', 409);
  }
  const orderId = makeToken(16);
  const card = input.method === 'card';
  if (card && totals.total === 0) throw new StoreError('Choose cash on delivery for a zero-total order.');
  try {
    await statements(db, [
      [`INSERT INTO orders (id, checkout_key, request_digest, cart_id, cart_version, customer_id,
        visitor_id, visitor_day, email, name, phone, address, city, shipping_code, shipping_label,
        currency, subtotal, shipping, discount, discount_code, total, payment_method, payment_status, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EGP', ?, ?, ?, ?, ?, ?, ?, ?)`,
      orderId, key, requestDigest, id, totals.version, user?.email === input.email ? user.id : null,
      visitor?.id ?? null, visitor?.day ?? null, input.email, input.name, input.phone, input.address,
      input.city, totals.rate.code, totals.rate.label, totals.subtotal, totals.rate.amount, totals.discount,
      input.coupon || null, totals.total, input.method, card ? 'pending' : 'unpaid', card ? unixNow() + holdSeconds : null],
      ...totals.items.map((item) => [`INSERT INTO order_items
        (order_id, variant_id, product_title, variant_title, sku, quantity, price) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      orderId, item.id, item.title, item.variant_title, item.sku, item.quantity, item.price]),
      ['DELETE FROM cart_items WHERE cart_id = ?', id],
      ['UPDATE carts SET version = version + 1, updated_at = unixepoch() WHERE id = ?', id],
    ]);
  } catch (error) {
    const retry = await previousOrder();
    if (retry) return { order: retry, created: false };
    if (/inventory or cart changed|shipping changed|discount changed|cart changed|checkout disabled/.test(error.message)) {
      throw new StoreError('Inventory or checkout settings changed. Review your cart and try again.', 409);
    }
    throw error;
  }
  return { order: await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first(), created: true };
}

export async function visibleOrder(env, context, id) {
  if (!isToken(id, 16)) return null;
  const [order, user] = await Promise.all([
    env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first(),
    currentUser(env, context),
  ]);
  if (!order || (order.cart_id !== cartId(context) && order.email !== user?.email)) return null;
  return order;
}

export async function orderLines(db, id) {
  return all(db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY product_title, variant_title').bind(id));
}

export async function sendReceipt(env, order, origin) {
  return sendEmail(env, {
    to: order.email,
    subject: 'UNLISTED™ order ' + order.id.slice(0, 8).toUpperCase(),
    text: 'Thank you for your order. Total: ' + money(order.total, true) +
      (order.payment_method === 'cod' ? ' · Cash on delivery.' : ' · Paid.') +
      '\n\nSign in with this email to view your order:\n' + new URL('/account', origin),
    key: 'unlisted-order-' + order.id,
  });
}
