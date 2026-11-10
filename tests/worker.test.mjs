import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from 'wrangler';
import { paymobSignedValue } from '../src/lib/paymob.js';

const origin = 'https://unlisted.test';
const secret = 'local-test-hmac';
const owner = 'owner@example.invalid';
const ownerPassword = 'fixture-owner-password-one';
const mail = [];
const intents = [];
let runtime, db, admin;

function browser() {
  const cookies = new Map();
  return async (path, form, extra = {}) => {
    const headers = { ...extra };
    if (cookies.size) headers.Cookie = [...cookies].map(([key, value]) => key + '=' + value).join('; ');
    let body;
    if (form) {
      headers.Origin ??= origin;
      if (form instanceof FormData) {
        const request = new Request(origin + path, { method: 'POST', body: form });
        headers['Content-Type'] = request.headers.get('Content-Type');
        body = new Uint8Array(await request.arrayBuffer());
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
      }
    }
    const response = await runtime.dispatchFetch(origin + path, {
      method: form ? 'POST' : 'GET', redirect: 'manual', headers, body,
    });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0];
      const split = pair.indexOf('=');
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  };
}

before(async () => {
  const { workerOptions: { modulesRules, ...workerOptions }, main } = unstable_getMiniflareWorkerOptions('dist/server/wrangler.json');
  const root = dirname(main);
  const chunks = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.mjs') && join(root, file) !== main);
  const modules = [main, ...chunks.map((file) => join(root, file))].map((path) => ({ type: 'ESModule', path }));
  runtime = new Miniflare(convertV4MiniflareOptions({
    ...workerOptions, modules, modulesRoot: root, d1Persist: false, r2Persist: false,
    bindings: {
      CHECKOUT_ENABLED: 'true', ADMIN_EMAILS: owner, ADMIN_ORIGIN: origin, EMAIL_FROM: 'UNLISTED <sender@example.invalid>',
      RESEND_API_KEY: 'test-email-key', PAYMOB_SECRET_KEY: 'test-paymob-secret', PAYMOB_PUBLIC_KEY: 'test-paymob-public',
      PAYMOB_INTEGRATION_IDS: '101', PAYMOB_HMAC_SECRET: secret, PAYMENT_ORIGIN: origin,
    },
    async outboundService(request) {
      const url = new URL(request.url);
      if (url.href === 'https://api.resend.com/emails') {
        mail.push(await request.json());
        return Response.json({ id: 'test-email-' + mail.length });
      }
      if (url.href === 'https://accept.paymob.com/v1/intention/') {
        intents.push(await request.json());
        return Response.json({ intention_order_id: 8000 + intents.length, client_secret: 'sandbox-order-' + intents.length }, { status: 201 });
      }
      throw new Error('Unexpected external call to ' + url.origin);
    },
  }));
  db = await runtime.getD1Database('DB');
  const migrations = (await readdir(new URL('../migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    const migration = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
    await db.batch(unstable_splitSqlQuery(migration).map((query) => db.prepare(query)));
  }
  await db.batch([
    db.prepare("UPDATE store_settings SET checkout_enabled=1, cod_enabled=1, card_enabled=1 WHERE id=1"),
    db.prepare("INSERT INTO products (id, handle, title, status, featured) VALUES ('p', 'test-hoodie', 'Test hoodie', 'active', 1)"),
    db.prepare("INSERT INTO variants (id, product_id, title, price, inventory) VALUES ('v', 'p', 'S/M', 60000, 1)"),
    db.prepare("INSERT INTO shipping_rates VALUES ('cairo','Cairo',8000,1)"),
    db.prepare("INSERT INTO discounts (code, kind, value, max_uses) VALUES ('COZY10','percent',10,1)"),
  ]);
});

after(async () => { if (runtime) await runtime.dispose(); });

async function customerCheckout(web, email, method = 'cod', coupon = 'COZY10') {
  assert.equal((await web('/')).status, 200);
  assert.equal((await web('/api/cart', { variant: 'v', quantity: 1, action: 'add' })).headers.get('Location'), '/cart');
  const input = { name: 'Test Buyer', email, phone: '01000000000', address: 'Test address',
    city: 'Test city', governorate: 'cairo', discount: coupon, payment_method: method };
  const review = await web('/checkout', input);
  assert.equal(review.status, 200);
  const html = await review.text();
  assert.match(html, /REVIEW YOUR ORDER/);
  const field = (name) => new RegExp('name="' + name + '" value="([^"]*)"').exec(html)?.[1];
  const request = { ...input, cart_version: field('cart_version'), checkout_key: field('checkout_key'), quoted_total: field('quoted_total') };
  assert.equal(request.quoted_total, coupon ? '62000' : '68000');
  assert.match(request.checkout_key, /^[0-9a-f]{48}$/);
  return request;
}

test('owner sign-in is allowlisted and link consumption is single-use', async () => {
  const outsider = browser();
  const denied = await outsider('/admin/action', { area: 'shipping', op: 'shipping', code: 'bad' });
  assert.equal(denied.status, 401);
  assert.equal((await outsider('/admin')).headers.get('Location'), '/admin/login');
  await outsider('/admin/session', { action: 'request', email: 'visitor@example.invalid' });
  assert.equal(mail.length, 0);

  admin = browser();
  await admin('/admin/session', { action: 'request', email: owner });
  assert.equal(mail.length, 1);
  const token = /token=([a-f0-9]{64})/.exec(mail[0].text)[1];
  assert.equal((await admin('/admin/verify?token=' + token)).status, 200);
  assert.equal((await admin('/admin/session', { action: 'confirm', token })).headers.get('Location'), '/admin/password');
  assert.match((await outsider('/admin/session', { action: 'confirm', token })).headers.get('Location'), /expired/);
  assert.match(await (await admin('/admin/password')).text(), /Set your password/);
  const choose = { action: 'save-password', password: ownerPassword, password_confirmation: ownerPassword };
  assert.match((await outsider('/admin/session', choose)).headers.get('Location'), /Sign\+in\+to\+set/);
  assert.match((await admin('/admin/session', { ...choose, password_confirmation: 'fixture-password-mismatch' }))
    .headers.get('Location'), /same\+new\+password/);
  assert.equal((await admin('/admin/session', choose)).headers.get('Location'), '/admin?saved=1');
  for (const path of ['/admin', '/admin/products', '/admin/products?product=test-hoodie', '/admin/collections',
    '/admin/orders', '/admin/orders?source=shopify', '/admin/customers', '/admin/discounts', '/admin/shipping', '/admin/content',
    '/admin/media', '/admin/inbox', '/admin/settings']) {
    const response = await admin(path);
    assert.equal(response.status, 200, path);
  }
  const cookieAsCustomer = await admin('/account');
  assert.doesNotMatch(await cookieAsCustomer.text(), /owner@example\.invalid/);
});

test('the owner workspace keeps its sections private and links to live inventory', async () => {
  const guest = browser();
  const sections = ['website', 'inventory', 'analytics', 'online-store', 'finance', 'marketing', 'automations'];
  for (const section of sections) {
    const path = '/admin/' + section;
    assert.equal((await guest(path)).headers.get('Location'), '/admin/login');
    const response = await admin(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
  const overview = await (await admin('/admin')).text();
  assert.match(overview, /aria-label="Business sections"/);
  assert.match(overview, /href="\/admin\/manifest\.webmanifest"/);
  const inventory = await (await admin('/admin/inventory?q=TEST+HOODIE')).text();
  assert.match(inventory, /href="\/admin\/products\?product=test-hoodie&amp;variant=v#variant-v"/);
  assert.match(inventory, /<td>1<\/td>/);
  const product = await (await admin('/admin/products?product=test-hoodie&variant=v')).text();
  assert.match(product, /id="variant-v" open/);
  const manifestResponse = await guest('/admin/manifest.webmanifest');
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.start_url, '/admin');
  assert.equal(manifest.display, 'standalone');
  for (const { src } of manifest.icons) {
    assert.match((await guest(src)).headers.get('Content-Type'), /^image\/png/);
  }
});

test('COD checkout prevents overselling and duplicate orders and restores stock on cancellation', async () => {
  const buyers = [browser(), browser()];
  const requests = await Promise.all(buyers.map((buyer, i) => customerCheckout(buyer, 'buyer' + i + '@example.invalid')));
  const results = await Promise.all(buyers.map((buyer, i) => buyer('/api/checkout', requests[i])));
  const won = results.findIndex((result) => result.headers.get('Location')?.startsWith('/orders/'));
  assert.notEqual(won, -1);
  assert.match(results[1 - won].headers.get('Location'), /^\/checkout\?error=/);
  const location = results[won].headers.get('Location');
  const order = location.split('/').at(-1);
  assert.equal((await buyers[won]('/api/checkout', requests[won])).headers.get('Location'), location);
  assert.equal((await browser()(location)).status, 404);
  const receipt = await buyers[won](location);
  assert.match(await receipt.text(), /Payment is due on delivery/);
  assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='v'").first('inventory'), 0);
  assert.equal(await db.prepare("SELECT count(*) AS total FROM orders").first('total'), 1);
  assert.equal(await db.prepare("SELECT uses FROM discounts WHERE code='COZY10'").first('uses'), 1);
  const adminOrder = await admin('/admin/orders?order=' + order);
  assert.match(await adminOrder.text(), /Test address/);
  for (const section of ['', '/analytics?days=7', '/marketing']) {
    assert.match(await (await admin('/admin' + section)).text(), /50\.0%/);
  }
  const cancel = { op: 'order', area: 'orders', id: order, operation: 'cancel' };
  assert.match((await admin('/admin/action', cancel)).headers.get('Location'), /saved=1/);
  assert.match((await admin('/admin/action', cancel)).headers.get('Location'), /error=/);
  assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='v'").first('inventory'), 1);
  assert.equal(await db.prepare("SELECT uses FROM discounts WHERE code='COZY10'").first('uses'), 0);
});

test('Paymob starts hosted checkout and only a matching signed capture can mark it paid', async () => {
  const buyer = browser();
  const request = await customerCheckout(buyer, 'cardbuyer@example.invalid', 'card', '');
  const pay = await buyer('/api/checkout', request);
  assert.equal(pay.status, 303);
  const checkout = new URL(pay.headers.get('Location'));
  assert.equal(checkout.origin, 'https://accept.paymob.com');
  assert.equal(checkout.pathname, '/unifiedcheckout/');
  assert.equal(intents.length, 1);
  assert.equal(intents[0].amount, 68000);
  assert.equal((await buyer('/api/checkout', request)).headers.get('Location'), checkout.href);
  assert.equal(intents.length, 1);
  const transaction = {
    amount_cents: 68000, created_at: '2026-11-09T12:00:00Z', currency: 'EGP',
    error_occured: false, has_parent_transaction: false, id: 601, integration_id: 101,
    is_3d_secure: true, is_auth: false, is_capture: false, is_refunded: false,
    is_standalone_payment: true, is_voided: false, order: { id: 8001 }, owner: 1,
    pending: false, source_data: { pan: '0000', sub_type: 'Visa', type: 'card' }, success: true,
  };
  const signature = (data) => createHmac('sha512', secret).update(paymobSignedValue(data)).digest('hex');
  function callback(data, signed = signature(data)) {
    return runtime.dispatchFetch(origin + '/api/paymob?hmac=' + signed, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'TRANSACTION', obj: data }),
    });
  }
  assert.equal((await callback(transaction, '0'.repeat(128))).status, 401);
  assert.equal((await callback({ ...transaction, amount_cents: 1 })).status, 409);
  assert.equal((await callback(transaction)).status, 204);
  assert.equal((await callback(transaction)).status, 204);
  assert.equal(await db.prepare("SELECT payment_status FROM orders WHERE provider_order_id='8001'").first('payment_status'), 'paid');
  assert.match(await (await admin('/admin/finance')).text(), /<strong>680 EGP<\/strong>/);
  assert.equal(await db.prepare('SELECT count(*) AS total FROM payment_events').first('total'), 1);
  assert.equal(mail.filter((message) => message.to[0] === 'cardbuyer@example.invalid').length, 1);
});

test('account sign-in authorizes order history by verified email and rejects cross-site forms', async () => {
  const web = browser();
  const rejected = await web('/account/session', { action: 'request', email: 'cardbuyer@example.invalid' }, { Origin: 'https://other.invalid' });
  assert.equal(rejected.status, 403);
  await web('/account/session', { action: 'request', email: 'cardbuyer@example.invalid' });
  const token = /token=([a-f0-9]{64})/.exec(mail.at(-1).text)[1];
  assert.equal((await web('/account/session', { action: 'confirm', token })).headers.get('Location'), '/account');
  const account = await web('/account');
  assert.match(await account.text(), /cardbuyer@example.invalid/);
  assert.equal((await web('/admin')).headers.get('Location'), '/admin/login');
});

test('R2 delivery serves byte ranges and validates range bounds', async () => {
  const r2 = await runtime.getR2Bucket('MEDIA');
  await r2.put('shop/test-video.mp4', new Uint8Array(128), { httpMetadata: { contentType: 'video/mp4' } });
  const web = browser();
  const response = await web('/media/shop/test-video.mp4', null, { Range: 'bytes=0-15' });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 0-15/128');
  assert.equal((await response.arrayBuffer()).byteLength, 16);
  assert.equal((await web('/media/shop/test-video.mp4', null, { Range: 'bytes=128-129' })).status, 416);
});

test('owner can create a product, update inventory, and upload an image to R2', async () => {
  const product = await admin('/admin/action', {
    area: 'products', op: 'product', mode: 'new', handle: 'new-item', title: 'New item',
    status: 'active', position: '2', option_names: 'Size', description: '<p>Product information</p><script>alert(1)</script>',
  });
  assert.match(product.headers.get('Location'), /product=new-item&saved=1/);
  const variant = await admin('/admin/action', {
    area: 'products', op: 'variant', handle: 'new-item', variant_title: 'M', price: '100.00',
    inventory: '2', active: 'on', options: 'M', position: '1',
  });
  assert.match(variant.headers.get('Location'), /saved=1/);
  const stock = await db.prepare("SELECT v.id, v.inventory FROM variants v JOIN products p ON p.id = v.product_id WHERE p.handle='new-item'").first();
  assert.equal(stock.inventory, 2);
  const stale = await admin('/admin/action', {
    area: 'products', op: 'variant', handle: 'new-item', variant: stock.id, variant_title: 'M', price: '100.00',
    inventory_before: '3', inventory: '10', active: 'on',
  });
  assert.match(stale.headers.get('Location'), /Inventory\+changed/);

  const image = await readFile(new URL('../public/theme/unlisted-logo.png', import.meta.url));
  const upload = new FormData();
  for (const [key, value] of Object.entries({ area: 'products', op: 'media', product: 'new-item', alt: 'New item', position: '1' })) {
    upload.set(key, value);
  }
  upload.set('file', new File([image], 'product.png', { type: 'image/png' }));
  const uploaded = await admin('/admin/action', upload);
  assert.match(uploaded.headers.get('Location'), /saved=1/);
  const page = await browser()('/products/new-item');
  const markup = await page.text();
  assert.match(markup, /Product information/);
  assert.doesNotMatch(markup, /alert\(1\)/);
  const photo = /src="(\/media\/upload\/[a-f0-9]+\.png)"/.exec(markup)?.[1];
  assert.ok(photo);
  assert.equal((await browser()(photo)).status, 200);
});

test('storefront search, size chart and COZY matching item follow the supplied theme', async () => {
  const chart = 'shop/sweatpants-chart.png';
  await db.batch([
    db.prepare("INSERT INTO media (key, content_type, original_name) VALUES (?, 'image/png', 'Size chart')").bind(chart),
    db.prepare("INSERT INTO products (id, handle, title, status) VALUES ('hoodie', 'cozy-hoodie-grey', 'COZY HOODIE - GREY', 'active')"),
    db.prepare("INSERT INTO products (id, handle, title, status, size_chart_key) VALUES ('sweats', 'cozy-straight-leg-sweats-grey', 'COZY STRAIGHT LEG SWEATS - GREY', 'active', ?)").bind(chart),
    db.prepare("INSERT INTO variants (id, product_id, title, price, inventory) VALUES ('h', 'hoodie', 'S/M', 60000, 2), ('s', 'sweats', 'L', 55000, 2)"),
  ]);
  const web = browser();
  const search = await (await web('/search?q=cozy+hoodie')).text();
  assert.match(search, /SEARCH UNLISTED/);
  assert.match(search, /COZY HOODIE - GREY/);
  assert.doesNotMatch(search, /COZY STRAIGHT LEG SWEATS - GREY/);
  const sweats = '/products/cozy-straight-leg-sweats-grey';
  const product = await (await web(sweats)).text();
  assert.match(product, /shopify-section-group-header-group/);
  assert.match(product, /\/media\/shop\/sweatpants-chart\.png/);
  assert.match(product, /COMPLETE THE LOOK/);
  assert.equal((await web('/api/cart', { action: 'add', variant: 's' })).headers.get('Location'), '/cart');
  assert.match(await (await web('/cart')).text(), /COMPLETE THE LOOK/);
  const upsell = await web('/api/cart', { action: 'add', variant: 'h', return_product: 'cozy-straight-leg-sweats-grey' });
  assert.equal(upsell.headers.get('Location'), sweats);
  assert.doesNotMatch(await (await web('/cart')).text(), /COMPLETE THE LOOK/);
  assert.doesNotMatch(await (await web(sweats)).text(), /COMPLETE THE LOOK/);
});

test('owner password sign-in, password changes, and private recovery keep admin sessions protected', async () => {
  const web = browser();
  const login = await (await web('/admin/login')).text();
  assert.match(login, /name="password" type="password"/);
  assert.doesNotMatch(login, /passkey|name="email"/i);
  const signIn = (client, password, headers) => client('/admin/session', { action: 'password', password }, headers);
  assert.match((await signIn(web, 'wrong password')).headers.get('Location'), /Check\+your\+password/);
  assert.equal((await web('/admin')).headers.get('Location'), '/admin/login');
  assert.equal((await signIn(web, ownerPassword, { Origin: 'https://wrong.example' })).status, 403);
  const signedIn = await signIn(web, ownerPassword);
  assert.equal(signedIn.headers.get('Location'), '/admin');
  assert.ok(signedIn.headers.getSetCookie().some((value) => value.startsWith('unlisted_admin=') &&
    /; HttpOnly/i.test(value) && /; Secure/i.test(value) && /; Path=\/admin/i.test(value)));
  assert.equal((await web('/admin')).status, 200);
  assert.match(await (await web('/admin/password')).text(), /Current password/);

  const before = await db.prepare('SELECT salt, password_hash FROM admin_passwords').first();
  assert.match(before.salt, /^[0-9a-f]{32}$/);
  assert.match(before.password_hash, /^[0-9a-f]{64}$/);
  const updated = 'fixture-owner-password-two';
  const save = { action: 'save-password', password: updated, password_confirmation: updated };
  assert.match((await web('/admin/session', { ...save, current_password: 'wrong password' }))
    .headers.get('Location'), /Check\+your\+current\+password/);
  assert.equal((await web('/admin/session', { ...save, current_password: ownerPassword })).headers.get('Location'), '/admin?saved=1');
  assert.equal((await admin('/admin')).headers.get('Location'), '/admin/login');
  const after = await db.prepare('SELECT salt, password_hash FROM admin_passwords').first();
  assert.notEqual(before.salt, after.salt);
  assert.notEqual(before.password_hash, after.password_hash);
  assert.match((await signIn(browser(), ownerPassword)).headers.get('Location'), /Check\+your\+password/);
  assert.equal((await signIn(browser(), updated)).headers.get('Location'), '/admin');

  const recovery = browser();
  await recovery('/admin/session', { action: 'request', email: owner });
  const recoveryToken = /token=([a-f0-9]{64})/.exec(mail.at(-1).text)[1];
  assert.equal((await recovery('/admin/session', { action: 'confirm', token: recoveryToken }))
    .headers.get('Location'), '/admin/password');
  assert.doesNotMatch(await (await recovery('/admin/password')).text(), /Current password/);
  assert.equal((await recovery('/admin/session', {
    action: 'save-password', password: ownerPassword, password_confirmation: ownerPassword,
  })).headers.get('Location'), '/admin?saved=1');
  assert.equal((await web('/admin')).headers.get('Location'), '/admin/login');
  assert.match((await browser()('/admin/session', { action: 'confirm', token: recoveryToken }))
    .headers.get('Location'), /expired/);
  assert.equal((await signIn(browser(), ownerPassword)).headers.get('Location'), '/admin');
});
