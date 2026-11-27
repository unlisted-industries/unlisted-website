import migration from '../../migrations/0017_preorder_deposits.sql?raw';
import { all, initializeTables, isToken, makeToken, unixNow } from './db.js';
import { emailValue, StoreError, textValue } from './http.js';
import { sendEmail } from './auth.js';
import { money } from './content.js';
import { ordersChatId } from './telegram-orders.js';
import { saveOrderContext, sendPurchase } from './meta-capi.js';
import { capturedTransaction, cardReady, createPaymobIntention, paymentIntegrationIds, paymentOrigin } from './paymob.js';

export const ensurePreorderDeposits = initializeTables(migration);

// Manufacturing cost, paid up front. The rest plus delivery is paid in cash on delivery.
export const depositAmount = 45000;
export const preorderShipping = {
  en: 'Ships Sunday, 29 November · delivered in 2–4 days.',
};
const holdSeconds = 30 * 60;

export const preorderNo = (row) => 'PO-' + row.number;

export function depositSplit(price, shipping) {
  const deposit = Math.min(depositAmount, price);
  return { deposit, balance: price - deposit + shipping };
}

function addressInput(form) {
  const street = textValue(form, 'street', 200);
  const building = textValue(form, 'building', 60);
  const apartment = textValue(form, 'apartment', 40);
  return [street, 'Building ' + building, apartment && 'Apt ' + apartment].filter(Boolean).join(', ');
}

export async function startDeposit(env, form, handle, context = null) {
  if (!cardReady(env)) throw new StoreError('Deposit payment is unavailable right now. Try again soon.');
  if (form.get('consent') !== 'on') throw new StoreError('Please confirm the pre-order terms.');
  const phone = textValue(form, 'phone', 24);
  if (!/^\+?[\d ()-]{8,24}$/.test(phone) || phone.replace(/\D/g, '').length < 8) throw new StoreError('Enter a valid phone number.');
  const input = {
    name: textValue(form, 'name', 100), email: emailValue(form), phone, address: addressInput(form),
    city: textValue(form, 'city', 100), governorate: textValue(form, 'governorate', 80),
  };
  const [variant, rate] = await Promise.all([
    env.DB.prepare(`SELECT p.id AS product_id, p.title AS product_title, v.id AS variant_id, v.title AS variant_title, v.price
      FROM products p JOIN variants v ON v.product_id = p.id WHERE p.handle = ? AND p.status = 'active'
      AND p.preorder = 1 AND v.id = ? AND v.active = 1`).bind(handle, textValue(form, 'variant', 100)).first(),
    env.DB.prepare('SELECT code, label, amount FROM shipping_rates WHERE code = ? AND active = 1').bind(input.governorate).first(),
  ]);
  if (!variant) throw new StoreError('Select an available size.');
  if (!rate) throw new StoreError('Select a governorate we deliver to.');
  const { deposit, balance } = depositSplit(variant.price, rate.amount);
  const id = makeToken(16);
  await ensurePreorderDeposits(env.DB);
  await env.DB.prepare(`INSERT INTO preorder_deposits (id, number, product_id, variant_id, product_title, variant_title,
    name, email, phone, address, city, shipping_code, shipping_label, price, shipping, deposit, balance, expires_at)
    VALUES (?, (SELECT coalesce(max(number), 0) + 1 FROM preorder_deposits), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, variant.product_id, variant.variant_id, variant.product_title, variant.variant_title, input.name, input.email,
      input.phone, input.address, input.city, rate.code, rate.label, variant.price, rate.amount, deposit, balance,
      unixNow() + holdSeconds).run();
  const row = await env.DB.prepare('SELECT * FROM preorder_deposits WHERE id = ?').bind(id).first();
  if (context) await saveOrderContext(env, context, id);
  const intention = await createPaymobIntention(env, { ...row, total: deposit, currency: 'EGP' }, holdSeconds,
    { notification: '/api/paymob?deposit=' + id, redirect: '/preorder/' + id }, 'card',
    [], [{ name: 'Pre-order deposit ' + preorderNo(row), amount: deposit,
      description: (row.product_title + ' · ' + row.variant_title).slice(0, 100), quantity: 1 }]);
  const url = new URL('/unifiedcheckout/', 'https://accept.paymob.com');
  url.searchParams.set('publicKey', env.PAYMOB_PUBLIC_KEY);
  url.searchParams.set('clientSecret', intention.client_secret);
  await env.DB.prepare('UPDATE preorder_deposits SET provider_order_id = ?, checkout_url = ? WHERE id = ?')
    .bind(String(intention.intention_order_id), url.href, id).run();
  return url.href;
}

export async function recordDepositCapture(env, id, transaction) {
  if (!isToken(id, 16)) throw new StoreError('Invalid deposit callback.', 409);
  if (!capturedTransaction(transaction)) return null;
  if (!paymentIntegrationIds(env, 'card').includes(Number(transaction.integration_id))) {
    throw new StoreError('Deposit used a different payment method.', 409);
  }
  await ensurePreorderDeposits(env.DB);
  const row = await env.DB.prepare('SELECT * FROM preorder_deposits WHERE id = ?').bind(id).first();
  if (!row || row.provider_order_id !== String(transaction.order?.id)) throw new StoreError('Deposit has no matching pre-order.', 409);
  if (row.deposit !== Number(transaction.amount_cents) || transaction.currency !== 'EGP') {
    throw new StoreError('Deposit amount does not match.', 409);
  }
  const updated = await env.DB.prepare(`UPDATE preorder_deposits SET status = 'paid', paid_at = unixepoch(),
    provider_txn = ?, checkout_url = NULL WHERE id = ? AND status = 'pending'`).bind(String(transaction.id), id).run();
  if (!updated.meta.changes) return null;
  const paid = { ...row, status: 'paid' };
  await sendPurchase(env, { id, eventId: 'preorder-' + id, value: paid.price + paid.shipping, email: paid.email, phone: paid.phone,
    name: paid.name, city: paid.city, contentIds: [paid.variant_id], numItems: 1 });
  await deliverDepositNotifications(env, id).catch(() => console.error('Pre-order notification remains queued'));
  await sendEmail(env, {
    to: paid.email,
    subject: 'UNLISTED™ pre-order ' + preorderNo(paid) + ' confirmed',
    text: 'Your pre-order is confirmed.\n\n' + paid.product_title + ' · ' + paid.variant_title +
      '\nDeposit paid: ' + money(paid.deposit, true) +
      '\nPay on delivery: ' + money(paid.balance, true) + ' (rest of the price + delivery)' +
      '\n\n' + preorderShipping.en +
      '\n\nView your pre-order:\n' + new URL('/preorder/' + paid.id, paymentOrigin(env) ?? 'https://unlisted-shop.com'),
    key: 'unlisted-preorder-' + paid.id,
  });
  return paid;
}

export function depositNotificationText(row, origin) {
  const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
  return [
    'UNLISTED · NEW PRE-ORDER ' + preorderNo(row) + ' 💰',
    text(row.product_title, 100) + ' · ' + text(row.variant_title, 40),
    text(row.name, 100) + ' · ' + text(row.email, 254), text(row.phone, 24),
    text(row.address, 350) + ', ' + text(row.city, 100) + ', ' + text(row.shipping_label, 100),
    'Deposit paid: ' + money(row.deposit, true),
    'Collect on delivery: ' + money(row.balance, true),
    '', new URL('/admin/inbox?kind=preorders', origin ?? 'https://unlisted-shop.com').href,
  ].join('\n');
}

export async function deliverDepositNotifications(env, id = null) {
  const token = env.TELEGRAM_BOT_TOKEN ?? '', chat = String(await ordersChatId(env) ?? '');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(chat)) return;
  await ensurePreorderDeposits(env.DB);
  const rows = await all(env.DB.prepare(`SELECT * FROM preorder_deposits WHERE status = 'paid' AND notified_at IS NULL
    AND notify_attempts < 8 AND (? IS NULL OR id = ?) LIMIT 10`).bind(id, id));
  for (const row of rows) {
    await env.DB.prepare('UPDATE preorder_deposits SET notify_attempts = notify_attempts + 1 WHERE id = ?').bind(row.id).run();
    try {
      const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ chat_id: chat, text: depositNotificationText(row, env.PAYMENT_ORIGIN ?? env.PREVIEW_PAYMENT_ORIGIN),
          disable_notification: false, protect_content: true, link_preview_options: { is_disabled: true } }),
      });
      if (response.ok && (await response.json()).ok === true) {
        await env.DB.prepare('UPDATE preorder_deposits SET notified_at = unixepoch() WHERE id = ?').bind(row.id).run();
      }
    } catch { /* Retried by the scheduled job. */ }
  }
}

export async function preorderDeposits(db, offset = 0) {
  await ensurePreorderDeposits(db);
  return all(db.prepare(`SELECT * FROM preorder_deposits WHERE status <> 'pending' OR expires_at > unixepoch()
    ORDER BY created_at DESC LIMIT 26 OFFSET ?`).bind(offset));
}
