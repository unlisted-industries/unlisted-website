import { statements, unixNow } from './db.js';
import { StoreError } from './http.js';

const gateway = 'https://accept.paymob.com';

function testCredentials(env) {
  return /^(?:egy(?:pt)?_)?sk_?test[_-]/i.test(env.PAYMOB_SECRET_KEY ?? '') &&
    /^(?:egy(?:pt)?_)?pk_?test[_-]/i.test(env.PAYMOB_PUBLIC_KEY ?? '');
}

function integrationSetting(env) {
  return testCredentials(env) && env.PAYMOB_TEST_INTEGRATION_IDS !== undefined
    ? 'PAYMOB_TEST_INTEGRATION_IDS' : 'PAYMOB_INTEGRATION_IDS';
}

export function paymentIntegrationIds(env) {
  const setting = env[integrationSetting(env)];
  if (typeof setting !== 'string' || !/^\s*\d+\s*(,\s*\d+\s*)*$/.test(setting)) return [];
  const ids = setting.split(',').map(Number);
  return ids.length && ids.every((id) => Number.isSafeInteger(id) && id > 0) ? ids : [];
}

export function paymentOrigin(env) {
  try {
    const url = new URL(env.PAYMENT_ORIGIN ?? env.PREVIEW_PAYMENT_ORIGIN);
    return url.protocol === 'https:' && url.href === url.origin + '/' ? url.origin : null;
  } catch {
    return null;
  }
}

export function paymentConfigurationIssues(env) {
  const required = ['PAYMOB_SECRET_KEY', 'PAYMOB_PUBLIC_KEY', 'PAYMOB_HMAC_SECRET'];
  const issues = required.filter((name) => typeof env[name] !== 'string' || !env[name].trim());
  if (!paymentIntegrationIds(env).length) issues.push(integrationSetting(env));
  if (!paymentOrigin(env)) issues.push('PAYMENT_ORIGIN');
  return issues;
}

export function cardReady(env) {
  return paymentConfigurationIssues(env).length === 0;
}

async function createPaymobIntention(env, order, remaining, callbacks = {}) {
  const [first, ...last] = order.name.trim().split(/\s+/);
  const response = await fetch(gateway + '/v1/intention/', {
    method: 'POST',
    headers: { Authorization: 'Token ' + env.PAYMOB_SECRET_KEY, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(12000), redirect: 'manual',
    body: JSON.stringify({
      amount: order.total,
      currency: order.currency,
      payment_methods: paymentIntegrationIds(env),
      items: [{ name: 'UNLISTED™ order ' + order.id.slice(0, 8), amount: order.total, description: 'Clothing order', quantity: 1 }],
      billing_data: {
        first_name: first, last_name: last.join(' ') || first, street: order.address, building: 'NA',
        floor: 'NA', apartment: 'NA', phone_number: order.phone, email: order.email,
        city: order.city, state: order.shipping_label, country: 'EG', postal_code: 'NA',
      },
      special_reference: order.id,
      expiration: remaining,
      notification_url: paymentOrigin(env) + (callbacks.notification ?? '/api/paymob'),
      redirection_url: paymentOrigin(env) + (callbacks.redirect ?? '/api/payment-return?order=' + order.id),
    }),
  });
  if (!response.ok) throw new StoreError('Paymob rejected the payment request.', response.status);
  const result = await response.json();
  if (typeof result.client_secret !== 'string' || !/^\d+$/.test(String(result.intention_order_id))) {
    throw new Error('Intention response incomplete');
  }
  return result;
}

function hostedCheckout(env, intention) {
  const url = new URL('/unifiedcheckout/', gateway);
  url.searchParams.set('publicKey', env.PAYMOB_PUBLIC_KEY);
  url.searchParams.set('clientSecret', intention.client_secret);
  return url.href;
}

export function sandboxReady(env, origin) {
  return cardReady(env) && origin === env.PREVIEW_PAYMENT_ORIGIN && origin === paymentOrigin(env) &&
    testCredentials(env);
}

export async function createSandboxCheckout(env, id, returnPath = '/admin/paymob-test') {
  if (!sandboxReady(env, paymentOrigin(env)) || !['/admin/paymob-test', '/payment-test'].includes(returnPath)) {
    throw new StoreError('Paymob sandbox checkout is unavailable.', 404);
  }
  const intention = await createPaymobIntention(env, {
    id, total: 1000, currency: 'EGP', name: 'UNLISTED Sandbox', address: 'Sandbox address',
    phone: '01010101010', email: 'unlisted-sandbox@example.com', city: 'Cairo', shipping_label: 'Cairo',
  }, 900, { notification: '/api/paymob?sandbox=' + id, redirect: returnPath + '?run=' + id });
  if (!/^pi_test_/.test(intention.id) || !/(^|_)csk_test_/.test(intention.client_secret)) {
    throw new StoreError('Paymob did not return a sandbox checkout.', 502);
  }
  return { providerOrder: String(intention.intention_order_id), checkout: hostedCheckout(env, intention) };
}

export async function startPayment(env, order) {
  const remaining = order.expires_at - unixNow();
  if (!cardReady(env) || order.payment_method !== 'card' || order.payment_status !== 'pending' || remaining < 60) {
    throw new StoreError('Card payment is unavailable for this order.');
  }
  if (order.checkout_url) return order.checkout_url;
  const lock = await env.DB.prepare(`UPDATE orders SET payment_lock_until = unixepoch() + 35 WHERE id = ?
    AND status = 'new' AND payment_status = 'pending' AND checkout_url IS NULL
    AND coalesce(payment_lock_until, 0) < unixepoch() RETURNING payment_lock_until`).bind(order.id).first();
  if (!lock) {
    const current = await env.DB.prepare('SELECT checkout_url FROM orders WHERE id = ?').bind(order.id).first();
    if (current?.checkout_url) return current.checkout_url;
    throw new StoreError('Payment is being prepared. Try again shortly.', 409);
  }
  try {
    const result = await createPaymobIntention(env, order, remaining);
    const checkout = hostedCheckout(env, result);
    const saved = await env.DB.prepare(`UPDATE orders SET checkout_url = ?, provider_order_id = ?, payment_lock_until = NULL
      WHERE id = ? AND payment_lock_until = ? AND payment_status = 'pending' AND status = 'new'`)
      .bind(checkout, String(result.intention_order_id), order.id, lock.payment_lock_until).run();
    if (saved.meta.changes !== 1) throw new Error('Order changed during payment initialization');
    return checkout;
  } catch {
    await env.DB.prepare('UPDATE orders SET payment_lock_until = NULL WHERE id = ? AND payment_lock_until = ?')
      .bind(order.id, lock.payment_lock_until).run();
    throw new StoreError('The payment page could not be opened. You can try again from your order.', 502);
  }
}

const signedFields = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction',
  'id', 'integration_id', 'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded',
  'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending',
  'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
];

export function paymobSignedValue(transaction) {
  return signedFields.map((path) => {
    const value = path.split('.').reduce((object, field) => object?.[field], transaction);
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  }).join('');
}

export async function verifyPaymob(transaction, signature, secret) {
  if (!secret || !/^[a-f0-9]{128}$/i.test(signature ?? '')) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.match(/.{2}/g), (byte) => parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(paymobSignedValue(transaction)));
}

export function capturedTransaction(transaction) {
  return transaction.success === true && transaction.pending === false &&
    transaction.error_occured === false && transaction.is_voided === false && transaction.is_refunded === false &&
    transaction.is_auth === false && (transaction.is_capture === true ||
      transaction.is_standalone_payment === true && transaction.has_parent_transaction === false);
}

export async function recordCapture(env, transaction) {
  if (!capturedTransaction(transaction) || !paymentIntegrationIds(env).includes(Number(transaction.integration_id))) return null;
  const providerId = String(transaction.order?.id);
  const txn = String(transaction.id);
  if (!/^\d+$/.test(providerId) || !/^\d+$/.test(txn)) throw new StoreError('Invalid transaction.', 400);
  const order = await env.DB.prepare('SELECT * FROM orders WHERE provider_order_id = ? AND payment_method = ?')
    .bind(providerId, 'card').first();
  if (!order) throw new StoreError('Payment has no matching order.', 409);
  if (order.total !== Number(transaction.amount_cents) || order.currency !== transaction.currency) {
    throw new StoreError('Payment does not match the order total.', 409);
  }
  const result = await statements(env.DB, [
    [`INSERT INTO payment_events (provider_txn, order_id, state)
      SELECT ?, id, CASE WHEN status = 'new' AND payment_status = 'pending' THEN 'captured' ELSE 'late' END
      FROM orders WHERE id = ? ON CONFLICT (provider_txn) DO NOTHING`, txn, order.id],
    [`UPDATE orders SET payment_status = 'paid', checkout_url = NULL, updated_at = unixepoch() WHERE id = ?
      AND status = 'new' AND payment_status = 'pending'
      AND EXISTS (SELECT 1 FROM payment_events WHERE provider_txn = ? AND order_id = orders.id AND state = 'captured')`, order.id, txn],
    [`UPDATE orders SET payment_status = 'review', checkout_url = NULL, updated_at = unixepoch() WHERE id = ?
      AND status = 'cancelled' AND payment_status = 'unpaid'
      AND EXISTS (SELECT 1 FROM payment_events WHERE provider_txn = ? AND order_id = orders.id AND state = 'late')`, order.id, txn],
  ]);
  return result[1].meta.changes ? { ...order, payment_status: 'paid' } : null;
}
