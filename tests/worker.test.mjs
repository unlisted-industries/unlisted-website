import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from 'wrangler';
import { createSandboxCheckout, paymentConfigurationIssues, paymentIntegrationIds, paymobSignedValue, sandboxReady } from '../src/lib/paymob.js';

const origin = 'https://unlisted.test';
const secret = 'local-test-hmac';
const owner = 'owner@example.invalid';
const ownerPassword = 'fixture-owner-password-one';
const runtimeSchemas = new Set(['0015_cozy_offers.sql','0014_returns_workspace.sql','0006_owner_passwords.sql', '0007_order_returns.sql', '0008_shopify_import.sql', '0009_paymob_sandbox.sql', '0010_live_visitors.sql', '0013_independent_workspace.sql']);
const mail = [];
const intents = [];
const telegram = [];
let failTelegram = false;
const providerRefunds=[],providerBookings=[];
let refundTimeout=false;
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
      RESEND_API_KEY: 'test-email-key', PAYMOB_SECRET_KEY: 'sk_test_fixture', PAYMOB_PUBLIC_KEY: 'pk_test_fixture',
      TELEGRAM_BOT_TOKEN:'123456:fixture', TELEGRAM_CHAT_ID:'123', PAYMOB_TEST_WALLET_INTEGRATION_IDS:'202',
      PAYMOB_INTEGRATION_IDS: '999', PAYMOB_TEST_INTEGRATION_IDS: '101', PAYMOB_HMAC_SECRET: secret,
      PAYMENT_ORIGIN: origin, PREVIEW_PAYMENT_ORIGIN: origin,
      PAYMOB_RMA_REFUNDS_ENABLED:'true', RMA_SHIPPING_ENABLED:'true', BOSTA_API_KEY:'fixture-bosta', BOSTA_BUSINESS_LOCATION_ID:'fixture-location',
    },
    async outboundService(request) {
      const url = new URL(request.url);
      if(url.href==='https://accept.paymob.com/api/acceptance/void_refund/refund') {
        const data=await request.json();providerRefunds.push(data);if(refundTimeout)throw new Error('Fixture timeout');
        return Response.json({id:900000+providerRefunds.length,success:true,pending:false,amount_cents:data.amount_cents});
      }
      if(url.href==='https://app.bosta.co/api/v2/deliveries?apiVersion=1') {
        providerBookings.push(await request.json());return Response.json({success:true,data:{_id:'fixture-booking-'+providerBookings.length,trackingNumber:'fixture-track-'+providerBookings.length,state:{value:'Pickup requested'}}});
      }
      if (url.href === 'https://api.resend.com/emails') {
        mail.push(await request.json());
        return Response.json({ id: 'test-email-' + mail.length });
      }
      if (url.origin === 'https://api.telegram.org') {
        telegram.push(await request.json());
        return Response.json({ok:!failTelegram},{status:failTelegram ? 503 : 200});
      }
      if (url.href === 'https://accept.paymob.com/v1/intention/') {
        intents.push(await request.json());
        return Response.json({ id: 'pi_test_fixture', intention_order_id: 8000 + intents.length, client_secret: 'csk_test_fixture' }, { status: 201 });
      }
      throw new Error('Unexpected external call to ' + url.origin);
    },
  }));
  db = await runtime.getD1Database('DB');
  const migrations = (await readdir(new URL('../migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort();
  // Model the existing hosted database before the Worker initializes its new tables.
  for (const name of migrations.filter((file) => !runtimeSchemas.has(file))) {
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

async function customerCheckout(web, email, method = 'cod', coupon = 'COZY10', quantity = 1) {
  assert.equal((await web('/')).status, 200);
  assert.equal((await web('/api/cart', { variant: 'v', quantity, action: 'add' })).headers.get('Location'), '/cart');
  const input = { name: 'Test Buyer', email, phone: '01000000000', address: 'Test address',
    city: 'Test city', governorate: 'cairo', discount: coupon, payment_method: method };
  const review = await web('/checkout', input);
  assert.equal(review.status, 200);
  const html = await review.text();
  assert.match(html, /REVIEW YOUR ORDER/);
  const field = (name) => new RegExp('name="' + name + '" value="([^"]*)"').exec(html)?.[1];
  const request = { ...input, cart_version: field('cart_version'), checkout_key: field('checkout_key'), quoted_total: field('quoted_total') };
  assert.equal(request.quoted_total, String(quantity * (coupon ? 54000 : 60000) + 8000));
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
  const token = /\/admin\/verify#token=([a-f0-9]{64})/.exec(mail[0].text)[1];
  const setupResponse = await admin('/admin/verify');
  assert.equal(setupResponse.headers.get('Referrer-Policy'), 'strict-origin');
  const setupPage = await setupResponse.text();
  assert.match(setupPage, /Set your password/);
  assert.match(setupPage, /name="password" type="password"/);
  assert.match(setupPage, /name="password_confirmation" type="password"/);
  assert.match(await (await admin('/admin/verify?token=' + token)).text(), new RegExp('name="token" value="' + token + '"'));
  const choose = { action: 'setup-password', token, password: ownerPassword, password_confirmation: ownerPassword };
  const mismatch = await admin('/admin/session', { ...choose, password_confirmation: 'fixture-password-mismatch' });
  assert.match(mismatch.headers.get('Location'), /same\+new\+password/);
  assert.ok(mismatch.headers.get('Location').endsWith('#token=' + token));
  assert.equal((await admin('/admin/session', choose)).headers.get('Location'), '/admin/login?password-set=1');
  assert.match((await outsider('/admin/session', choose)).headers.get('Location'), /expired/);
  assert.equal((await admin('/admin')).headers.get('Location'), '/admin/login');
  assert.equal((await admin('/admin/session', { action: 'password', password: ownerPassword })).headers.get('Location'), '/admin');
  const migration = await readFile(new URL('../migrations/0006_owner_passwords.sql', import.meta.url), 'utf8');
  await db.batch(unstable_splitSqlQuery(migration).map((query) => db.prepare(query)));
  assert.equal(await db.prepare('SELECT count(*) AS count FROM admin_passwords').first('count'), 1);
  assert.equal(await db.prepare('SELECT count(*) AS count FROM admin_password_setups').first('count'), 0);
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
  assert.deepEqual(intents[0].payment_methods, [101]);
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
  assert.match(await (await admin('/admin/finance?tab=overview')).text(), /Collected net sales<\/span><strong>LE 680\.00<\/strong>/);
  assert.equal(await db.prepare('SELECT count(*) AS total FROM payment_events').first('total'), 1);
  assert.equal(mail.filter((message) => message.to[0] === 'cardbuyer@example.invalid').length, 1);

  const sandboxPage = '/admin/paymob-test';
  assert.equal((await browser()(sandboxPage, {})).headers.get('Location'), '/admin/login');
  assert.doesNotMatch((await admin(sandboxPage, {}, { Origin: 'https://other.invalid' })).headers.get('Location') ?? '', /accept\.paymob/);
  const orderCount = await db.prepare('SELECT count(*) AS total FROM orders').first('total');
  const sandboxLaunch = await admin(sandboxPage, {});
  assert.equal(sandboxLaunch.status, 200);
  const launchPage = await sandboxLaunch.text();
  assert.match(launchPage, /data-paymob-launch/);
  assert.match(launchPage, /https:\/\/accept\.paymob\.com\/unifiedcheckout\//);
  assert.match(launchPage, /Continue to Paymob/);
  const testIntent = intents.at(-1);
  const testCallback = new URL(testIntent.notification_url);
  const testStatus = new URL(testIntent.redirection_url);
  const sandboxTransaction = { ...transaction, id: 602, amount_cents: 1000, order: { id: 8002 } };
  testCallback.searchParams.set('hmac', signature(sandboxTransaction));
  const sandboxEvent = { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'TRANSACTION', obj: sandboxTransaction }) };
  assert.equal((await runtime.dispatchFetch(testCallback.href, sandboxEvent)).status, 204);
  assert.equal((await runtime.dispatchFetch(testCallback.href, sandboxEvent)).status, 204);
  assert.match(await (await admin(testStatus.pathname + testStatus.search)).text(), /Sandbox payment confirmed/);
  assert.equal(await db.prepare('SELECT count(*) AS total FROM orders').first('total'), orderCount);
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
    db.prepare("INSERT INTO media (key, content_type, original_name) VALUES ('shop/sweatpants-model.webp','image/webp','Model')"),
    db.prepare("INSERT INTO product_images (product_id, media_key, position) VALUES ('sweats',?,0),('sweats','shop/sweatpants-model.webp',1)").bind(chart),
  ]);
  const web = browser();
  const search = await (await web('/search?q=cozy+hoodie')).text();
  assert.match(search, /SEARCH UNLISTED/);
  assert.match(search, /COZY HOODIE - GREY/);
  assert.doesNotMatch(search, /COZY STRAIGHT LEG SWEATS - GREY/);
  const sweats = '/products/cozy-straight-leg-sweats-grey';
  const product = await (await web(sweats)).text();
  assert.match(product, /unlisted-section-group-header-group/);
  assert.match(product, /\/theme\/catalog\/straight-leg-size-chart\.webp/);
  assert.match(product, /MODEL: 176 CM/);
  assert.doesNotMatch(product, /MODEL: 178 CM|id="SizeGuide"|Size chart coming soon/);
  assert.match(product, /COMPLETE THE LOOK/);
  assert.equal((await web('/api/cart', { action: 'add', variant: 's' })).headers.get('Location'), '/cart');
  assert.match(await (await web('/cart')).text(), /COMPLETE THE LOOK/);
  const upsell = await web('/api/cart', { action: 'add', variant: 'h', return_product: 'cozy-straight-leg-sweats-grey' });
  assert.equal(upsell.headers.get('Location'), sweats);
  assert.doesNotMatch(await (await web('/cart')).text(), /COMPLETE THE LOOK/);
  assert.doesNotMatch(await (await web(sweats)).text(), /COMPLETE THE LOOK/);
});

test('delivered orders support private returns, safe exchange stock, and verified refund balances', async () => {
  await db.batch([
    db.prepare("UPDATE variants SET inventory = 3 WHERE id = 'v'"),
    db.prepare("INSERT INTO variants (id, product_id, title, price, inventory) VALUES ('v-exchange', 'p', 'L', 60000, 1)"),
  ]);
  const orderAction = (order, operation, fields = {}) => admin('/admin/action', { area: 'orders', op: 'order', id: order, operation, ...fields });
  const returnAction = (id, operation, fields = {}) => admin('/admin/action', { area: 'returns', op: 'return', id, operation, ...fields });
  const stock = (id) => db.prepare('SELECT inventory FROM variants WHERE id = ?').bind(id).first('inventory');
  async function delivered(buyer, quantity) {
    const quote = await customerCheckout(buyer, 'returns-buyer@example.invalid', 'cod', '', quantity);
    const placed = await buyer('/api/checkout', quote);
    const order = placed.headers.get('Location').split('/').at(-1);
    assert.match(order, /^[0-9a-f]{32}$/);
    for (const action of ['confirm', 'ship', 'collect', 'deliver']) {
      assert.match((await orderAction(order, action, { tracking: 'OUTBOUND-TEST' })).headers.get('Location'), /saved=1/);
    }
    return order;
  }

  const buyer = browser();
  const order = await delivered(buyer, 1);
  const item = { order, variant: 'v', quantity: 1, reason: 'The size is too small.', kind: 'exchange', replacement: 'v-exchange' };
  const first = { ...item, request_id: '1'.repeat(32) };
  assert.match((await browser()('/api/return-request', first)).headers.get('Location'), /^\/account\?error=/);
  await db.prepare('UPDATE order_deliveries SET delivered_at = unixepoch() - 1296000 WHERE order_id = ?').bind(order).run();
  assert.match((await buyer('/api/return-request', first)).headers.get('Location'), /error=/);
  await db.prepare('UPDATE order_deliveries SET delivered_at = unixepoch() WHERE order_id = ?').bind(order).run();
  const orderPage = await (await buyer('/orders/' + order)).text();
  assert.match(orderPage, /START OR TRACK A RETURN/);
  assert.match(orderPage, /\/returns\?order=website:/);
  assert.match((await buyer('/api/return-request', first)).headers.get('Location'), /return-sent=1/);
  assert.match((await buyer('/api/return-request', first)).headers.get('Location'), /return-sent=1/);
  const second = { ...item, request_id: '2'.repeat(32) };
  assert.match((await buyer('/api/return-request', second)).headers.get('Location'), /error=/);
  assert.match(await (await admin('/admin/returns?legacy=1')).text(), /Awaiting review/);
  const instructions = { message: 'Return the item to the store.' };
  assert.match((await returnAction(first.request_id, 'approve', instructions)).headers.get('Location'), /saved=1/);
  assert.equal(await stock('v-exchange'), 0);
  assert.match((await returnAction(first.request_id, 'approve', instructions)).headers.get('Location'), /error=/);
  assert.match((await returnAction(first.request_id, 'cancel', { message: 'Customer cancelled.' })).headers.get('Location'), /saved=1/);
  assert.equal(await stock('v-exchange'), 1);
  assert.match((await buyer('/api/return-request', second)).headers.get('Location'), /return-sent=1/);
  assert.match((await returnAction(second.request_id, 'approve', instructions)).headers.get('Location'), /saved=1/);
  assert.match((await returnAction(second.request_id, 'receive', { restock: 'on' })).headers.get('Location'), /saved=1/);
  assert.match((await returnAction(second.request_id, 'receive', { restock: 'on' })).headers.get('Location'), /error=/);
  assert.equal(await stock('v'), 3);
  assert.equal(await stock('v-exchange'), 0);
  assert.match((await returnAction(second.request_id, 'complete', { reference: 'EXCHANGE-TEST' })).headers.get('Location'), /saved=1/);
  assert.match(await (await buyer('/orders/' + order)).text(), /Replacement sent/);

  const refundBuyer = browser();
  const refundOrder = await delivered(refundBuyer, 2);
  const refundIds = ['3'.repeat(32), '4'.repeat(32)];
  for (const request_id of refundIds) {
    const request = { order: refundOrder, variant: 'v', quantity: 1, kind: 'refund', reason: 'Test return', request_id };
    assert.match((await refundBuyer('/api/return-request', request)).headers.get('Location'), /return-sent=1/);
    assert.match((await returnAction(request_id, 'approve', instructions)).headers.get('Location'), /saved=1/);
    assert.match((await returnAction(request_id, 'receive')).headers.get('Location'), /saved=1/);
  }
  assert.match((await orderAction(refundOrder, 'refund', { payment_note: 'Duplicate path' })).headers.get('Location'), /error=/);
  assert.match((await returnAction(refundIds[0], 'complete', { amount: '600', reference: 'REFUND-ONE' })).headers.get('Location'), /saved=1/);
  const payment = () => db.prepare('SELECT payment_status FROM orders WHERE id = ?').bind(refundOrder).first('payment_status');
  assert.equal(await payment(), 'paid');
  assert.match((await returnAction(refundIds[1], 'complete', { amount: '681', reference: 'REFUND-TWO' })).headers.get('Location'), /error=/);
  assert.match((await returnAction(refundIds[1], 'complete', { amount: '680', reference: 'refund-one' })).headers.get('Location'), /error=/);
  assert.match((await returnAction(refundIds[1], 'complete', { amount: '680', reference: 'REFUND-TWO' })).headers.get('Location'), /saved=1/);
  assert.equal(await payment(), 'refunded');
  assert.match(await (await refundBuyer('/orders/' + refundOrder)).text(), /Refund recorded/);
});

test('Shopify import is private, repeatable, and preserves native orders and verified inventory', async () => {
  const email = 'archive-buyer@example.invalid';
  const exportedAt = Math.floor(Date.now() / 1000);
  const snapshot = {
    version: 1, exportedAt,
    orders: [{ id: '42', number: '#SHOPIFY-42', email, created: exportedAt - 86400, cancelled: null,
      payment: 'paid', fulfillment: 'fulfilled', amount: '600.00', currency: 'EGP',
      items: [{ name: 'Archived hoodie', sku: 'ARCHIVE-SKU', quantity: 1 }], details: { header: { 'Shipping City': 'Test City' } } }],
    customers: [{ id: '17', email, name: 'Archive Buyer', details: { 'First Name': 'Archive' } }],
    products: [{ handle: 'test-hoodie', details: [{ Title: 'Archived hoodie' }] }],
    variants: [{ id: 'v', handle: 'test-hoodie', available: 90, sku: '' },
      { id: 'v-import', handle: 'test-hoodie', available: 3, sku: 'MIGRATED-XS' }],
    discounts: [{ Name: 'ARCHIVE-BUNDLE', Type: 'Buy X get Y', Status: 'Active', Value: '50%' }],
  };
  await db.prepare("INSERT INTO variants (id, product_id, title, price) VALUES ('v-import', 'p', 'XS', 60000)").run();
  const orderCount = () => db.prepare('SELECT count(*) AS count FROM orders').first('count');
  const countBefore = await orderCount();
  const stockBefore = await db.prepare("SELECT inventory FROM variants WHERE id = 'v'").first('inventory');
  function form(data = snapshot) {
    const body = new FormData();
    body.set('op', 'shopify-import');
    body.set('area', 'migration');
    body.set('snapshot', new File([JSON.stringify(data)], 'migration.json', { type: 'application/json' }));
    return body;
  }
  assert.equal((await browser()('/admin/action', form())).status, 401);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await admin('/admin/action', form())).headers.get('Location'), '/admin/migration?saved=1');
  }
  assert.match((await admin('/admin/action', form({ ...snapshot, exportedAt: exportedAt - 1 }))).headers.get('Location'), /newer\+source/);
  assert.equal(await orderCount(), countBefore);
  assert.equal(await db.prepare('SELECT count(*) AS count FROM shopify_orders').first('count'), 1);
  assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id = 'v'").first('inventory'), stockBefore);
  assert.deepEqual(await db.prepare("SELECT inventory, sku FROM variants WHERE id = 'v-import'").first(), { inventory: 3, sku: 'MIGRATED-XS' });
  assert.match(await (await admin('/admin/orders?source=shopify')).text(), /#SHOPIFY-42/);
  assert.match(await (await admin('/admin/migration')).text(), /Latest data snapshot/);
  assert.match(await (await admin('/admin/discounts')).text(), /ARCHIVE-BUNDLE/);
  assert.equal(await db.prepare("SELECT 1 FROM discounts WHERE code = 'ARCHIVE-BUNDLE'").first(), null);
  const buyer = browser();
  assert.doesNotMatch(await (await buyer('/account?source=shopify')).text(), /#SHOPIFY-42/);
  await buyer('/account/session', { action: 'request', email });
  const token = /token=([a-f0-9]{64})/.exec(mail.at(-1).text)[1];
  assert.equal((await buyer('/account/session', { action: 'confirm', token })).headers.get('Location'), '/account');
  assert.match(await (await buyer('/account?source=shopify')).text(), /#SHOPIFY-42/);
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
  assert.equal((await recovery('/admin/verify')).headers.get('Location'), '/admin/password');
  assert.doesNotMatch(await (await recovery('/admin/password')).text(), /Current password/);
  assert.equal((await recovery('/admin/session', {
    action: 'save-password', password: ownerPassword, password_confirmation: ownerPassword,
  })).headers.get('Location'), '/admin?saved=1');
  assert.equal((await web('/admin')).headers.get('Location'), '/admin/login');
  assert.match((await browser()('/admin/session', { action: 'confirm', token: recoveryToken }))
    .headers.get('Location'), /expired/);
  assert.equal((await signIn(browser(), ownerPassword)).headers.get('Location'), '/admin');
});

test('website test integration is selected only with matching test keys', async () => {
  const testEnv = {
    PAYMOB_SECRET_KEY: 'egy_sk_test_fixture', PAYMOB_PUBLIC_KEY: 'egy_pk_test_fixture',
    PAYMOB_HMAC_SECRET: secret, PAYMOB_INTEGRATION_IDS: '999', PAYMOB_TEST_INTEGRATION_IDS: '101',
    PAYMENT_ORIGIN: origin, PREVIEW_PAYMENT_ORIGIN: origin,
  };
  assert.deepEqual(paymentIntegrationIds(testEnv), [101]);
  const { PAYMOB_TEST_INTEGRATION_IDS, ...fallback } = testEnv;
  assert.deepEqual(paymentIntegrationIds(fallback), [999]);
  assert.deepEqual(paymentIntegrationIds({ ...testEnv, PAYMOB_TEST_INTEGRATION_IDS: 'invalid' }), []);
  assert.deepEqual(paymentConfigurationIssues({ ...testEnv, PAYMOB_TEST_INTEGRATION_IDS: '' }), ['PAYMOB_TEST_INTEGRATION_IDS']);
  const liveEnv = { ...testEnv, PAYMOB_SECRET_KEY: 'egy_sk_live_fixture', PAYMOB_PUBLIC_KEY: 'egy_pk_live_fixture' };
  assert.deepEqual(paymentIntegrationIds(liveEnv), [999]);
  assert.equal(sandboxReady(liveEnv, origin), false);
  assert.equal(sandboxReady(testEnv, 'https://other.invalid'), false);
  await assert.rejects(createSandboxCheckout(liveEnv, 'a'.repeat(32)), /unavailable/);
  await assert.rejects(createSandboxCheckout(testEnv, 'a'.repeat(32), 'https://other.invalid'), /unavailable/);
});

test('public payment review verifies sandbox callbacks without opening native checkout or changing store data', async () => {
  const saved = await db.prepare('SELECT checkout_enabled, cod_enabled, card_enabled FROM store_settings WHERE id=1').first();
  await db.prepare('UPDATE store_settings SET checkout_enabled=0, cod_enabled=0, card_enabled=0 WHERE id=1').run();
  const snapshot = async () => ({
    orders: await db.prepare('SELECT count(*) AS n FROM orders').first('n'),
    customers: await db.prepare('SELECT count(*) AS n FROM customers').first('n'),
    visits: await db.prepare('SELECT count(*) AS n FROM visits').first('n'),
    variants: (await db.prepare('SELECT id, inventory FROM variants ORDER BY id').all()).results,
  });
  const before = await snapshot();
  const reviewer = browser();
  const page = await reviewer('/payment-test');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Cache-Control'), 'private, no-store');
  const html = await page.text();
  assert.match(html, /Test mode only/);
  assert.match(html, /5123456789012346/);
  assert.doesNotMatch(html, /sk_test_fixture|local-test-hmac|owner@example/);
  assert.equal((await runtime.dispatchFetch('https://other.invalid/payment-test')).status, 404);
  const attempts = intents.length;
  assert.equal((await reviewer('/payment-test', {}, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal(intents.length, attempts);
  const result = await reviewer('/payment-test', {});
  assert.equal(result.status, 200);
  assert.match(await result.text(), /Continue to Paymob/);
  const intent = intents.at(-1);
  assert.deepEqual(intent.payment_methods, [101]);
  assert.equal(intent.amount, 1000);
  assert.equal(intent.billing_data.email, 'unlisted-sandbox@example.com');
  const status = new URL(intent.redirection_url);
  assert.equal(status.pathname, '/payment-test');
  const url = new URL(intent.notification_url);
  const providerOrder = await db.prepare('SELECT provider_order_id FROM paymob_sandbox_runs WHERE id=?').bind(url.searchParams.get('sandbox')).first('provider_order_id');
  const transaction = {
    amount_cents: 1000, created_at: '2026-11-11T12:00:00Z', currency: 'EGP', error_occured: false,
    has_parent_transaction: false, id: 7001, integration_id: 101, is_3d_secure: true, is_auth: false,
    is_capture: false, is_refunded: false, is_standalone_payment: true, is_voided: false,
    order: { id: Number(providerOrder) }, owner: 1, pending: false,
    source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' }, success: true,
  };
  const callback = (data, hmac = createHmac('sha512', secret).update(paymobSignedValue(data)).digest('hex')) => {
    url.searchParams.set('hmac', hmac);
    return runtime.dispatchFetch(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'TRANSACTION', obj: data }) });
  };
  assert.equal((await callback(transaction, '0'.repeat(128))).status, 401);
  assert.equal((await callback({ ...transaction, integration_id: 999 })).status, 409);
  assert.match(await (await reviewer(status.pathname + status.search)).text(), /Waiting for the signed/);
  assert.equal((await callback(transaction)).status, 204);
  assert.equal((await callback(transaction)).status, 204);
  assert.match(await (await reviewer(status.pathname + status.search)).text(), /Sandbox payment confirmed/);
  assert.deepEqual(await snapshot(), before);
  for (let i = 0; i < 5; i++) {
    assert.equal((await reviewer('/payment-test', {}, { 'CF-Connecting-IP': '192.0.2.99' })).status, 200);
  }
  const limitedAt = intents.length;
  assert.equal((await reviewer('/payment-test', {}, { 'CF-Connecting-IP': '192.0.2.99' })).status, 429);
  assert.equal(intents.length, limitedAt);
  const gates = await db.prepare('SELECT checkout_enabled, cod_enabled, card_enabled FROM store_settings WHERE id=1').first();
  assert.deepEqual(gates, { checkout_enabled: 0, cod_enabled: 0, card_enabled: 0 });
  await db.prepare('UPDATE store_settings SET checkout_enabled=?, cod_enabled=?, card_enabled=? WHERE id=1')
    .bind(saved.checkout_enabled, saved.cod_enabled, saved.card_enabled).run();
});

test('live visitor presence is private, refreshes existing visits, expires, and respects opt-outs', async () => {
  const ownerWeb = browser();
  assert.equal((await ownerWeb('/admin/session', { action: 'password', password: ownerPassword }, { 'CF-Connecting-IP': '192.0.2.151' })).headers.get('Location'), '/admin');
  const guest = browser();
  assert.equal((await guest('/admin/live-visitors.json')).status, 401);
  assert.equal((await guest('/api/visit')).status, 405);
  assert.equal((await guest('/api/visit', {}, { Origin: 'https://elsewhere.invalid' })).status, 403);
  const original = await db.prepare('SELECT analytics_enabled FROM store_settings WHERE id=1').first('analytics_enabled');
  await db.prepare('UPDATE store_settings SET analytics_enabled=1 WHERE id=1').run();
  try {
    const before = await (await ownerWeb('/admin/live-visitors.json')).json();
    const shopper = browser();
    const page = await shopper('/');
    const visit = page.headers.getSetCookie().find((value) => value.startsWith('unlisted_visit='));
    const id = /unlisted_visit=\d{4}-\d\d-\d\d\.([a-f0-9]{48})/.exec(visit)[1];
    const visits = await db.prepare('SELECT count(*) AS count FROM visits').first('count');
    const response = await ownerWeb('/admin/live-visitors.json');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    const active = await response.json();
    assert.equal(active.visitors, before.visitors + 1);
    assert.equal(active.windowSeconds, 300);
    assert.doesNotMatch(JSON.stringify(active), new RegExp(id));
    assert.ok(active.countries.every((row) => Object.keys(row).sort().join(',') === 'country,visitors'));
    assert.equal((await shopper('/api/visit', {})).status, 204);
    assert.equal((await shopper('/api/visit', {})).status, 204);
    assert.equal(await db.prepare('SELECT count(*) AS count FROM visits').first('count'), visits);
    assert.equal(await db.prepare('SELECT count(*) AS count FROM visitor_activity WHERE visitor_id=?').bind(id).first('count'), 1);
    await db.prepare('UPDATE visitor_activity SET last_seen_at=unixepoch()-301 WHERE visitor_id=?').bind(id).run();
    assert.equal((await (await ownerWeb('/admin/live-visitors.json')).json()).visitors, before.visitors);
    await shopper('/api/visit', {});
    assert.equal((await (await ownerWeb('/admin/live-visitors.json')).json()).visitors, before.visitors + 1);
    const activityRows = await db.prepare('SELECT count(*) AS count FROM visitor_activity').first('count');
    for (const headers of [{ DNT: '1' }, { 'Sec-GPC': '1' }]) {
      const privateShopper = browser();
      const privatePage = await privateShopper('/', null, headers);
      assert.ok(!privatePage.headers.getSetCookie().some((value) => value.startsWith('unlisted_visit=')));
      await privateShopper('/api/visit', {}, headers);
    }
    assert.equal(await db.prepare('SELECT count(*) AS count FROM visitor_activity').first('count'), activityRows);
    await db.prepare('UPDATE store_settings SET analytics_enabled=0 WHERE id=1').run();
    const paused = await (await ownerWeb('/admin/live-visitors.json')).json();
    assert.equal(paused.enabled, false);
    assert.equal(paused.visitors, 0);
    await shopper('/api/visit', {});
    assert.equal(await db.prepare('SELECT count(*) AS count FROM visitor_activity').first('count'), activityRows);
  } finally {
    await db.prepare('UPDATE store_settings SET analytics_enabled=? WHERE id=1').bind(original).run();
  }
});

test('period comparisons use matching order and visit windows and exclude the ending boundary', async () => {
  const ownerWeb = browser();
  assert.equal((await ownerWeb('/admin/session', { action: 'password', password: ownerPassword }, { 'CF-Connecting-IP': '192.0.2.152' })).headers.get('Location'), '/admin');
  await db.prepare("UPDATE variants SET inventory=20,price=60000 WHERE id='v'").run();
  const moments = [
    ['2026-11-01', Date.parse('2026-11-01T12:00:00Z') / 1000],
    ['2026-11-02', Date.parse('2026-11-02T12:00:00Z') / 1000],
    ['2026-10-30', Date.parse('2026-10-30T12:00:00Z') / 1000],
    ['2026-11-03', Date.parse('2026-11-02T22:00:00Z') / 1000],
  ];
  for (const [index, [day, created]] of moments.entries()) {
    const buyer = browser();
    const input = await customerCheckout(buyer, 'period-' + index + '@example.invalid', 'cod', '');
    const placed = await buyer('/api/checkout', input);
    const id = placed.headers.get('Location')?.split('/').at(-1);
    assert.match(id, /^[a-f0-9]{32}$/);
    const visitor = await db.prepare('SELECT visitor_id FROM orders WHERE id=?').bind(id).first('visitor_id');
    await db.prepare('UPDATE orders SET created_at=?,visitor_day=? WHERE id=?').bind(created, day, id).run();
    await db.prepare('INSERT OR IGNORE INTO visits (visitor_id,day) VALUES (?,?)').bind(visitor, day).run();
  }
  const response = await ownerWeb('/admin/analytics?start=2026-11-01&end=2026-11-02&compare=previous');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<span>Sales<\/span>\s*<strong>2<\/strong>/);
  assert.match(html, /<span>Visitors<\/span>\s*<strong>2<\/strong>/);
  assert.match(html, /\+100%/);
  assert.match(html, /1,360 EGP/);
  assert.match(html, /30 Oct – 31 Oct 2026/);
  assert.match(html, /100\.0%/);
});

test('finance journals are private, balanced, confirmed, idempotent and separate cash from profit', async()=>{
 const web=browser();await web('/admin/session',{action:'password',password:ownerPassword});
 const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo'}).format(new Date());
 const form={op:'transaction',request_id:'a'.repeat(32),confirmed:'yes',kind:'owner_draw',account:'cash',category:'other',occurred_on:day,amount:'123.45',note:'Finance integration owner withdrawal'};
 assert.equal((await browser()('/admin/finance-action',form)).status,401);
 assert.match((await web('/admin/finance-action',{...form,confirmed:''})).headers.get('Location'),/Review/);
 assert.equal((await web('/admin/finance-action',form,{Origin:'https://wrong.invalid'})).status,403);
 assert.match((await web('/admin/finance-action',form)).headers.get('Location'),/saved=1/);
 assert.match((await web('/admin/finance-action',form)).headers.get('Location'),/saved=1/);
 assert.equal(await db.prepare("SELECT count(*) FROM finance_journals WHERE id=?").bind(form.request_id).first('count(*)'),1);
 const saved=await db.prepare('SELECT * FROM finance_journals WHERE id=?').bind(form.request_id).first();
 assert.deepEqual(JSON.parse(saved.postings),[{account:'cash',amount:-12345},{account:'drawings',amount:12345}]);
 assert.equal(JSON.parse(saved.postings).some(p=>p.account==='expense'),false);
 await assert.rejects(db.prepare("UPDATE finance_journals SET note='changed' WHERE id=?").bind(form.request_id).run(),/Reverse a journal/);
 await assert.rejects(db.prepare("INSERT INTO finance_journals(id,source,occurred_on,kind,actor,postings) VALUES('bad','bad',?,'expense','test',?)").bind(day,JSON.stringify([{account:'cash',amount:-100},{account:'expense',amount:99}])).run(),/balanced/);
 for(const tab of ['overview','accountant','cash','drops','inventory','marketing','planning','settings'])assert.equal((await web('/admin/finance?tab='+tab)).status,200,tab);
 const exported=await web('/admin/finance-export.csv');assert.equal(exported.status,200);assert.match(await exported.text(),/UNLISTED Financial Report/);
 assert.equal((await browser()('/admin/finance-export.csv')).status,401);
});

test('finance batch receipts and PR gifts change stock once and preserve liability and cost history',async()=>{
 const web=browser();await web('/admin/session',{action:'password',password:ownerPassword});
 const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo'}).format(new Date());
 await db.batch([db.prepare("INSERT INTO products(id,handle,title,status) VALUES('finance-p','finance-product','Finance fixture','active')"),db.prepare("INSERT INTO variants(id,product_id,title,price,inventory) VALUES('finance-v','finance-p','M',100000,10)")]);
 let sequence=100;const post=async(op,fields={})=>{const response=await web('/admin/finance-action',{op,request_id:(sequence++).toString(16).padStart(32,'0'),confirmed:'yes',...fields});assert.match(response.headers.get('Location'),/saved=1/,response.headers.get('Location'));return response;};
 await post('unit_cost',{variant_id:'finance-v',unit_cost:'400'});
 await post('drop',{name:'Finance integration drop',fixed_cost:'1000'});
 const drop=await db.prepare("SELECT id FROM finance_drops WHERE name='Finance integration drop'").first('id');
 await post('assign_drop',{product_id:'finance-p',drop_id:drop});
 await post('batch',{name:'Manufacturing test batch',drop_id:drop,variant_id:'finance-v',quantity:'10',raw_materials:'3000',manufacturing:'2000',packaging:'0',freight:'0',overhead:'0'});
 const batch=await db.prepare("SELECT id FROM finance_batches WHERE name='Manufacturing test batch'").first('id');
 const receive={op:'receive_batch',confirmed:'yes',batch_id:batch,occurred_on:day};
 const outcomes=await Promise.all([web('/admin/finance-action',{...receive,request_id:'b'.repeat(32)}),web('/admin/finance-action',{...receive,request_id:'c'.repeat(32)})]);
 assert.equal(outcomes.filter(r=>r.headers.get('Location').includes('saved=1')).length,1);
 assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='finance-v'").first('inventory'),20);
 assert.equal(await db.prepare("SELECT unit_cost FROM finance_variant_costs WHERE variant_id='finance-v'").first('unit_cost'),45000);
 assert.equal(await db.prepare("SELECT count(*) n FROM finance_journals WHERE source=?").bind('batch:'+batch).first('n'),1);
 await post('transaction',{kind:'supplier_payment',account:'bank',category:'manufacturing',amount:'5000',occurred_on:day,note:'Settle batch'});
 const excessive=await web('/admin/finance-action',{op:'transaction',confirmed:'yes',request_id:'d'.repeat(32),kind:'supplier_payment',account:'bank',category:'manufacturing',amount:'1',occurred_on:day,note:'Overpayment'});
 assert.match(excessive.headers.get('Location'),/exceeds/);
 const gift={op:'gift',request_id:'e'.repeat(32),confirmed:'yes',variant_id:'finance-v',quantity:'2',gifted_on:day,recipient:'Fixture influencer',influencer_fee:'100',shipping:'50',account:'bank',note:'PR fixture'};
 assert.match((await web('/admin/finance-action',gift)).headers.get('Location'),/saved=1/);
 await web('/admin/finance-action',gift);
 assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='finance-v'").first('inventory'),18);
 const tooMany=await web('/admin/finance-action',{...gift,request_id:'f'.repeat(32),quantity:'99'});
 assert.match(tooMany.headers.get('Location'),/sufficient/);
 assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='finance-v'").first('inventory'),18);
 assert.equal(await db.prepare("SELECT count(*) n FROM finance_pr_gifts WHERE recipient='Fixture influencer'").first('n'),1);
 await post('batch',{name:'Concurrent batch one',drop_id:drop,variant_id:'finance-v',quantity:'6',raw_materials:'3000'});
 await post('batch',{name:'Concurrent batch two',drop_id:drop,variant_id:'finance-v',quantity:'6',raw_materials:'4800'});
 const incoming=(await db.prepare("SELECT id FROM finance_batches WHERE name LIKE 'Concurrent batch %' ORDER BY name").all()).results;
 const receiptResults=await Promise.all(incoming.map((b,n)=>web('/admin/finance-action',{op:'receive_batch',confirmed:'yes',batch_id:b.id,occurred_on:day,request_id:('1'+n).repeat(16)})));
 assert.ok(receiptResults.every(r=>r.headers.get('Location').includes('saved=1')));
 assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='finance-v'").first('inventory'),30);
 assert.equal(await db.prepare("SELECT unit_cost FROM finance_variant_costs WHERE variant_id='finance-v'").first('unit_cost'),53000);

});

test('statement import waits for confirmation, blocks duplicates and keeps original files private',async()=>{
 const web=browser();await web('/admin/session',{action:'password',password:ownerPassword});
 const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo'}).format(new Date());
 const csv='date,amount,kind,category,account,note\n'+day+',200.01,expense,packaging,bank,Unique statement fixture';
 const form=new FormData();form.set('op','extract');form.set('file',new File([csv],'statement.csv',{type:'text/csv'}));
 const result=await web('/admin/finance-action',form);assert.match(result.headers.get('Location'),/import=/);
 const id=new URL(result.headers.get('Location'),origin).searchParams.get('import');
 assert.equal(await db.prepare("SELECT count(*) n FROM finance_journals WHERE source=?").bind('import:'+id+':0').first('n'),0);
 const imported=await db.prepare('SELECT * FROM finance_imports WHERE id=?').bind(id).first();
 assert.equal((await browser()('/media/'+imported.media_key)).status,404);
 assert.equal((await browser()('/admin/finance-file?id='+id)).status,401);
 assert.equal(await (await web('/admin/finance-file?id='+id)).text(),csv);
 const confirm={op:'confirm_import',import_id:id,confirmed:'yes',include_0:'on',date_0:day,amount_0:'200.01',kind_0:'expense',category_0:'packaging',account_0:'bank',note_0:'Unique statement fixture'};
 assert.match((await web('/admin/finance-action',confirm)).headers.get('Location'),/saved=1/);
 await web('/admin/finance-action',confirm);
 assert.equal(await db.prepare("SELECT count(*) n FROM finance_journals WHERE source=?").bind('import:'+id+':0').first('n'),1);
 const repeated=await web('/admin/finance-action',form);assert.equal(new URL(repeated.headers.get('Location'),origin).searchParams.get('import'),id);
 assert.equal(await db.prepare('SELECT state FROM finance_imports WHERE id=?').bind(id).first('state'),'confirmed');
});

test('account profiles preserve verified identity and unify old and new order history privately', async () => {
  const email='cardbuyer@example.invalid';
  await db.prepare(`INSERT INTO shopify_orders VALUES ('314','#1031',?,unixepoch()-86400,NULL,'paid','fulfilled','680.00','EGP','[{"name":"Historical item","quantity":1}]')`).bind(email.toUpperCase()).run();
  const web=browser();
  assert.equal((await web('/orders/history/314')).status,404);
  await web('/account/session',{action:'request',email});
  const token=/token=([a-f0-9]{64})/.exec(mail.at(-1).text)[1];
  await web('/account/session',{action:'confirm',token});
  const update={action:'profile',name:'Updated Buyer',phone:'01012345678',address:'Updated address',city:'Cairo',governorate:'cairo'};
  assert.equal((await web('/account/session',update,{Origin:'https://wrong.invalid'})).status,403);
  assert.equal((await web('/account/session',update)).headers.get('Location'),'/account?saved=1');
  const page=await (await web('/account')).text();
  assert.match(page,/#1031/);
  assert.match(page,/\/orders\/[a-f0-9]{32}/);
  assert.doesNotMatch(page,/Shopify history|UNLISTED orders/);
  assert.match(page,/Updated address/);
  assert.equal((await web('/orders/history/314')).status,200);
  assert.equal((await browser()('/orders/history/314')).status,404);
  assert.equal(await db.prepare('SELECT count(*) count FROM customers WHERE email=? COLLATE NOCASE').bind(email).first('count'),1);
  const ownerWeb=browser();
  assert.equal((await ownerWeb('/admin/session',{action:'password',password:ownerPassword},{'CF-Connecting-IP':'192.0.2.211'})).headers.get('Location'),'/admin');
  const list=await (await ownerWeb('/admin/orders?q=1031')).text();
  assert.match(list,/#1031/);
  const detail=await (await ownerWeb('/admin/orders?order=history%3A314')).text();
  assert.match(detail,/Historical item/);
  const customer=await (await ownerWeb('/admin/customers?customer='+email)).text();
  assert.match(customer,/Updated address/);
  assert.match(customer,/#1031/);
});

test('checkout keeps details through edits and sends one branded notification with durable retry', async () => {
  await db.prepare("UPDATE variants SET inventory=5 WHERE id='v'").run();
  const web=browser();
  const input=await customerCheckout(web,'notify@example.invalid','cod','');
  const edit=await web('/checkout',{...input,edit:'1'});
  assert.match(await edit.text(),/value="Test Buyer"/);
  assert.match(await (await web('/checkout')).text(),/Test address/);
  failTelegram=true;
  const submitted=await web('/api/checkout',input);
  const path=submitted.headers.get('Location');
  const id=path.split('/').at(-1);
  assert.match(path,/^\/orders\/[a-f0-9]{32}$/);
  assert.equal(await db.prepare('SELECT sent_at FROM order_notifications WHERE order_id=?').bind(id).first('sent_at'),null);
  const count=telegram.length;
  await db.prepare('UPDATE order_notifications SET next_attempt_at=0 WHERE order_id=?').bind(id).run();
  failTelegram=false;
  await web('/api/checkout',input);
  assert.equal(telegram.length,count+1);
  assert.match(telegram.at(-1).text,/UNLISTED · NEW ORDER/);
  assert.match(telegram.at(-1).text,/notify@example.invalid/);
  assert.match(telegram.at(-1).text,/Test hoodie/);
  assert.match(telegram.at(-1).text,/Payment: cod/);
  assert.equal(telegram.at(-1).disable_notification,false);
  assert.ok(await db.prepare('SELECT sent_at FROM order_notifications WHERE order_id=?').bind(id).first('sent_at'));
  await web('/api/checkout',input);
  assert.equal(telegram.length,count+1);
  assert.equal(await db.prepare('SELECT count(*) count FROM checkout_drafts WHERE cart_id=(SELECT cart_id FROM orders WHERE id=?)').bind(id).first('count'),0);
});

test('wallet uses its separate Paymob integration and rejects a signed capture for the wrong method', async () => {
  const web=browser();
  const input=await customerCheckout(web,'wallet@example.invalid','wallet','');
  const submitted=await web('/api/checkout',input);
  assert.match(submitted.headers.get('Location'),/^https:\/\/accept.paymob.com\/unifiedcheckout\//);
  const intent=intents.at(-1);
  assert.deepEqual(intent.payment_methods,[202]);
  assert.equal(intent.items.reduce((sum,line)=>sum+line.amount*line.quantity,0),intent.amount);
  assert.ok(intent.items.some(line=>line.name==='Test hoodie'));
  assert.ok(intent.items.some(line=>line.name==='Delivery'));
  const order=await db.prepare('SELECT * FROM orders WHERE email=?').bind('wallet@example.invalid').first();
  assert.equal(await db.prepare('SELECT method FROM order_payment_choices WHERE order_id=?').bind(order.id).first('method'),'wallet');
  const transaction={id:987654,order:{id:Number(order.provider_order_id)},amount_cents:order.total,currency:'EGP',integration_id:101,
    success:true,pending:false,error_occured:false,is_voided:false,is_refunded:false,is_auth:false,is_capture:false,is_standalone_payment:true,has_parent_transaction:false};
  const send=async txn=>runtime.dispatchFetch(origin+'/api/paymob?hmac='+createHmac('sha512',secret).update(paymobSignedValue(txn)).digest('hex'),{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'TRANSACTION',obj:txn})});
  assert.equal((await send(transaction)).status,409);
  assert.equal((await send({...transaction,integration_id:202})).status,204);
  assert.equal(await db.prepare('SELECT payment_status FROM orders WHERE id=?').bind(order.id).first('payment_status'),'paid');
  assert.equal((await send({...transaction,integration_id:202})).status,204);
});

async function rmaSeed(email,quantity=1) {
 await db.prepare('DELETE FROM rate_limits').run();
 admin=browser();await admin('/admin/session',{action:'password',password:ownerPassword});
 const web=browser();await web('/account/session',{action:'request',email});
 const token=/token=([a-f0-9]{64})/.exec(mail.at(-1).text)[1];await web('/account/session',{action:'confirm',token});
 await db.prepare("UPDATE variants SET inventory=50,price=60000 WHERE id='v'").run();
 const input=await customerCheckout(web,email,'cod','',quantity),placed=await web('/api/checkout',input);
 const id=placed.headers.get('Location').split('/').at(-1);
 for(const operation of ['confirm','ship','collect','deliver'])assert.match((await admin('/admin/action',{area:'orders',op:'order',id,operation,tracking:'LOCAL-TEST'})).headers.get('Location'),/saved=1/);
 return {web,id};
}
async function rmaReview(web,id,kind='refund',quantity=1,extra={}) {
 const fields={order:'website:'+id,kind,reason:'size','select:v':'on','quantity:v':String(quantity),reason_note:'Test evidence',...extra};
 const response=await web('/returns',fields),html=await response.text();
 assert.equal(response.status,200);assert.match(html,/Review your request/);
 const field=name=>new RegExp('name="'+name+'" value="([^"]*)"').exec(html)?.[1];
 assert.ok(field('quote'),html.slice(-1000));
 return {...fields,request_id:field('request_id'),quote:field('quote'),accept_quote:'on',language:'en'};
}
async function rmaAction(id,operation,extra={}) {
 const version=await db.prepare('SELECT version FROM rma_cases WHERE id=?').bind(id).first('version');
 return admin('/admin/returns-action',{id,operation,version:String(version),...extra});
}
test('RMA portal verifies ownership, quotes exact amounts, stores private photos and deduplicates submissions',async()=>{
 const {web,id}=await rmaSeed('rma-one@example.invalid',2);
 assert.equal((await browser()('/admin/returns')).headers.get('Location'),'/admin/login');
 const arabic=await web('/returns?lang=ar&order=website:'+id);assert.match(await arabic.text(),/الاستبدال والاسترجاع/);assert.match(arabic.headers.get('Cache-Control'),/no-store/);
 const review=await rmaReview(web,id);
 const denied=await browser()('/api/returns',review);assert.match(denied.headers.get('Location'),/error=/);
 const multipart=new FormData();for(const [k,v] of Object.entries(review))multipart.set(k,v);
 multipart.set('photos',new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:'image/png'}),'proof.png');
 const sent=await web('/api/returns',multipart);assert.match(sent.headers.get('Location'),/sent=1/);
 assert.match((await web('/api/returns',multipart)).headers.get('Location'),/sent=1/);
 const c=await db.prepare('SELECT * FROM rma_cases WHERE id=?').bind(review.request_id).first();assert.equal(c.state,'approved');assert.equal(c.item_value,60000);assert.equal(c.settlement,-60000);assert.equal(c.fee,0);
 const photo=await db.prepare('SELECT * FROM rma_photos WHERE case_id=?').bind(c.id).first();assert.equal((await browser()('/admin/returns-photo?id='+photo.id)).status,401);assert.equal((await browser()('/media/'+photo.media_key)).status,404);assert.equal((await admin('/admin/returns-photo?id='+photo.id)).status,200);
 assert.match(await (await browser()('/returns?request='+c.id)).text(),/Find your orders securely/);
 assert.equal((await admin('/admin/returns-action',{id:c.id,version:1,operation:'receive'},{Origin:'https://other.invalid'})).status,403);
 assert.equal(await db.prepare('SELECT state FROM rma_cases WHERE id=?').bind(c.id).first('state'),'approved');
 assert.match((await rmaAction(c.id,'receive',{'restock:v':'on'})).headers.get('Location'),/saved=1/);
 assert.match((await rmaAction(c.id,'complete',{reference:'LOCAL-REFUND-A',settlement_verified:'on'})).headers.get('Location'),/saved=1/);
 assert.match((await rmaAction(c.id,'complete',{reference:'LOCAL-REFUND-A',settlement_verified:'on'})).headers.get('Location'),/error=/);
 assert.equal(await db.prepare('SELECT count(*) n FROM rma_ledger WHERE case_id=?').bind(c.id).first('n'),1);
 assert.ok(await db.prepare('SELECT count(*) n FROM rma_mail WHERE sent_at IS NOT NULL').first('n'));
 assert.equal((await admin('/admin/finance')).status,200);
});
test('RMA reservations survive concurrent submissions without overselling or double restock',async()=>{
 await db.prepare("UPDATE variants SET inventory=1,price=60000 WHERE id='v-exchange'").run();
 const a=await rmaSeed('rma-race-a@example.invalid'),b=await rmaSeed('rma-race-b@example.invalid');
 const ra=await rmaReview(a.web,a.id,'exchange',1,{'replacement:v':'v-exchange'}),rb=await rmaReview(b.web,b.id,'exchange',1,{'replacement:v':'v-exchange'});
 await Promise.all([a.web('/api/returns',ra),b.web('/api/returns',rb)]);
 assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='v-exchange'").first('inventory'),0);
 const cases=(await db.prepare('SELECT * FROM rma_cases WHERE id IN(?,?)').bind(ra.request_id,rb.request_id).all()).results;
 assert.equal(cases.filter(c=>c.state==='approved').length,1);
 const approved=cases.find(c=>c.state==='approved');
 assert.match((await rmaAction(approved.id,'receive',{'restock:v':'on'})).headers.get('Location'),/saved=1/);
 const stock=await db.prepare("SELECT inventory FROM variants WHERE id='v'").first('inventory');
 assert.match((await rmaAction(approved.id,'receive',{'restock:v':'on'})).headers.get('Location'),/error=/);
 assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='v'").first('inventory'),stock);
 const tracking=await rmaAction(approved.id,'tracking',{provider:'manual',direction:'replacement',reference:'LOCAL-X-TRACK',status:'Shipped',cost:'25',message:'Fixture courier booking'});assert.match(tracking.headers.get('Location'),/saved=1/);
 assert.match((await rmaAction(approved.id,'complete',{reference:'LOCAL-X-TRACK'})).headers.get('Location'),/saved=1/);
});
test('optional store credit is issued once, belongs to verified customer and retains unused balance',async()=>{
 const {web,id}=await rmaSeed('rma-credit@example.invalid');const review=await rmaReview(web,id,'credit');
 assert.match((await web('/api/returns',review)).headers.get('Location'),/sent=1/);
 assert.match((await rmaAction(review.request_id,'receive')).headers.get('Location'),/saved=1/);
 assert.match((await rmaAction(review.request_id,'complete')).headers.get('Location'),/saved=1/);
 const credit=await db.prepare('SELECT * FROM rma_credit WHERE case_id=?').bind(review.request_id).first();assert.equal(credit.balance,68000);
 await web('/api/cart',{variant:'v',quantity:1,action:'add'});
 const fields={name:'Buyer',email:'rma-credit@example.invalid',phone:'01000000000',address:'Test address',city:'Cairo',governorate:'cairo',discount:credit.code,payment_method:'cod'};
 const html=await (await web('/checkout',fields)).text(),f=name=>new RegExp('name="'+name+'" value="([^"]*)"').exec(html)?.[1];
 assert.equal(f('quoted_total'),'8000');
 const placed=await web('/api/checkout',{...fields,cart_version:f('cart_version'),checkout_key:f('checkout_key'),quoted_total:f('quoted_total')});assert.match(placed.headers.get('Location'),/^\/orders\//);
 assert.equal(await db.prepare('SELECT balance FROM rma_credit WHERE code=?').bind(credit.code).first('balance'),8000);
 const orderId=placed.headers.get('Location').split('/').at(-1);
 assert.match((await admin('/admin/action',{op:'order',area:'orders',id:orderId,operation:'cancel'})).headers.get('Location'),/saved=1/);
 assert.equal(await db.prepare('SELECT balance FROM rma_credit WHERE code=?').bind(credit.code).first('balance'),68000);
});
test('courier booking and Paymob refunds claim each external action once and hold uncertain results',async()=>{
 const {web,id}=await rmaSeed('rma-provider@example.invalid');const review=await rmaReview(web,id);
 await web('/api/returns',review);
 const booked=await rmaAction(review.request_id,'booking',{provider:'bosta',direction:'return'});assert.match(booked.headers.get('Location'),/saved=1/);
 assert.equal(providerBookings.at(-1).type,25);assert.equal(providerBookings.at(-1).cod,0);const bookings=providerBookings.length;
 await rmaAction(review.request_id,'booking',{provider:'bosta',direction:'return'});assert.equal(providerBookings.length,bookings);
 await rmaAction(review.request_id,'receive');
 // Isolated captured-payment fixture; no real gateway transaction is touched.
 await db.prepare("INSERT INTO payment_events(provider_txn,order_id,state) VALUES('555999',?,'captured')").bind(id).run();
 refundTimeout=true;const result=await rmaAction(review.request_id,'paymob');assert.match(result.headers.get('Location'),/error=/);refundTimeout=false;
 const count=providerRefunds.length;await rmaAction(review.request_id,'paymob');assert.equal(providerRefunds.length,count);
 assert.equal(await db.prepare("SELECT state FROM rma_operations WHERE case_id=? AND kind='refund'").bind(review.request_id).first('state'),'review');
 assert.match((await rmaAction(review.request_id,'complete',{reference:'UNVERIFIED',settlement_verified:'on'})).headers.get('Location'),/error=/);
});

test('historical evidence updates require owner evidence and customer consent before approval',async()=>{
 const {web}=await rmaSeed('rma-history@example.invalid');
 const now=Math.floor(Date.now()/1000);
 await db.prepare(`INSERT INTO shopify_orders(source_id,order_number,email,created_at,payment,fulfillment,amount,currency,line_items) VALUES('90001','#HISTORY-RMA','rma-history@example.invalid',?,'paid','fulfilled','680.00','EGP',?)`).bind(now-86400,JSON.stringify([{name:'Historical hoodie',sku:'UNKNOWN',quantity:1}])).run();
 const fields={order:'shopify:90001',kind:'refund',reason:'defective','select:0':'on','quantity:0':'1',reason_note:'Defect'};
 const html=await (await web('/returns',fields)).text(),f=n=>new RegExp('name="'+n+'" value="([^"]*)"').exec(html)?.[1];
 const id=f('request_id');assert.ok(id);await web('/api/returns',{...fields,request_id:id,quote:f('quote'),accept_quote:'on',language:'en'});
 assert.equal(await db.prepare('SELECT eligibility FROM rma_cases WHERE id=?').bind(id).first('eligibility'),'evidence_review');
 assert.match((await rmaAction(id,'approve',{reviewed:'on',message:'Evidence incomplete'})).headers.get('Location'),/error=/);
 const date=new Date().toISOString().slice(0,10);
 assert.match((await rmaAction(id,'verify-evidence',{verified_total:'680',prior_refunded:'0',delivered_on:date,shipping_refund:'80','value:0':'600','variant:0':'v','cost:0':'200',payment_verified:'on',message:'Invoice and courier receipt verified'})).headers.get('Location'),/saved=1/);
 assert.equal(await db.prepare('SELECT eligibility FROM rma_cases WHERE id=?').bind(id).first('eligibility'),'customer_review');
 assert.match((await rmaAction(id,'approve',{reviewed:'on',message:'Customer has not agreed'})).headers.get('Location'),/error=/);
 const version=await db.prepare('SELECT version FROM rma_cases WHERE id=?').bind(id).first('version');
 assert.match((await web('/api/returns',{id,version:String(version),operation:'accept-evidence',accept_quote:'on',language:'en'})).headers.get('Location'),/sent=1/);
 assert.match((await rmaAction(id,'approve',{message:'Pickup instructions'})).headers.get('Location'),/saved=1/);
 assert.match((await rmaAction(id,'receive',{'restock:0':'on'})).headers.get('Location'),/saved=1/);
 assert.match((await rmaAction(id,'complete',{reference:'HISTORY-REFUND',settlement_verified:'on'})).headers.get('Location'),/saved=1/);
 assert.equal(await db.prepare('SELECT amount FROM rma_ledger WHERE case_id=?').bind(id).first('amount'),-68000);
});

test('simple stock page saves and edits estimates without changing money or inventory; calculates ads and PR limits',async()=>{
 const web=browser();assert.equal((await web('/admin/session',{action:'password',password:ownerPassword},{'CF-Connecting-IP':'192.0.2.191'})).headers.get('Location'),'/admin');
 const form={request_id:'9a'.repeat(16),name:'Simple stock fixture',quantity:'100',total_cost:'40000',price:'1000',fees:'100',ads:'5000',pr_units:'10',pr_cost:'1000',product_id:'finance-p',confirmed:'yes'};
 const stockBefore=await db.prepare("SELECT inventory FROM variants WHERE id='finance-v'").first('inventory');
 const journalsBefore=await db.prepare('SELECT count(*) FROM finance_journals').first('count(*)');
 assert.equal((await browser()('/admin/finance',form)).headers.get('Location'),'/admin/login');
 assert.equal((await web('/admin/finance',form,{Origin:'https://wrong.invalid'})).status,403);
 assert.match((await web('/admin/finance',{...form,confirmed:''})).headers.get('Location'),/error=/);
 assert.match((await web('/admin/finance',form)).headers.get('Location'),/saved=1/);
 assert.match((await web('/admin/finance',form)).headers.get('Location'),/saved=1/);
 assert.equal(await db.prepare('SELECT count(*) FROM finance_stock_plans WHERE id=?').bind(form.request_id).first('count(*)'),1);
 let page=await (await web('/admin/finance')).text();
 assert.match(page,/Know what your stock can make/);
 assert.doesNotMatch(page,/Cash &amp; ledger|Owner capital|Expansion investment|Finance sections/);
 assert.match(page,/Simple stock fixture/);
 assert.match(page,/35,000\.00/); // 90 × (1000 - 100) - 40,000 - 5,000 - 1,000.
 assert.match(page,/52 sales/); // Full batch cost and planned ads/PR, not double-counted COGS.
 assert.match(page,/2\.25×/); // 90,000 full-sellout revenue / 40,000 available for ads.
 assert.match(page,/444\.44/); // CPA ceiling includes the product costs of PR pieces.
 assert.match(page,/611\.12/); // Minimum full-sellout price, rounded up to piastre.
 assert.match(page,/40,000\.00/); // Total ads ceiling, 90 × 900 - 40,000 - 1,000.
 assert.match(page,/48 pieces total/); // floor(100 - 46,000 / 900).
 assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='finance-v'").first('inventory'),stockBefore);
 assert.equal(await db.prepare('SELECT count(*) FROM finance_journals').first('count(*)'),journalsBefore);
 const plan=await db.prepare('SELECT * FROM finance_stock_plans WHERE id=?').bind(form.request_id).first();
 const edited={...form,id:plan.id,revision:String(plan.updated_at),request_id:'9b'.repeat(16),price:'300'};
 assert.match((await web('/admin/finance',edited)).headers.get('Location'),/saved=1/);
 page=await (await web('/admin/finance')).text();assert.match(page,/Cannot break even/);assert.match(page,/No room for ads/);
 assert.match((await web('/admin/finance',{...edited,request_id:'9c'.repeat(16)})).headers.get('Location'),/error=/);
 assert.equal(await db.prepare("SELECT count(*) FROM finance_requests WHERE id=?").bind('9c'.repeat(16)).first('count(*)'),0);
 assert.match((await web('/admin/finance',{...form,request_id:'9d'.repeat(16),pr_units:'101'})).headers.get('Location'),/error=/);
});

test('finance phone test uses Telegram once and retains the same daily reminder schedule',async()=>{
 const web=browser();assert.equal((await web('/admin/session',{action:'password',password:ownerPassword},{'CF-Connecting-IP':'192.0.2.192'})).headers.get('Location'),'/admin');
 const before=telegram.length;
 const response=await web('/admin/finance-action',{op:'test_reminder',confirmed:'yes'});
 assert.match(response.headers.get('Location'),/saved=1/);
 assert.ok(telegram.length>before);
 const texts=telegram.slice(before).filter(n=>n.text.includes('Finance notification delivery test'));
 assert.equal(texts.length,1);assert.match(texts[0].text,/9 PM Cairo/);assert.equal(texts[0].disable_notification,false);
 const outbox=await db.prepare("SELECT count(*) FROM finance_telegram_outbox o JOIN finance_notifications n ON n.id=o.notification_id WHERE n.kind='test' AND o.state='sent'").first('count(*)');assert.equal(outbox,1);
 await web('/admin/finance-action',{op:'test_reminder',confirmed:'yes'});
 assert.equal(telegram.filter(n=>n.text.includes('Finance notification delivery test')).length,texts.length);
});

test('scheduled finance sends the Cairo reminder once and re-arms stock alerts after recovery',async()=>{
 const executor = await runtime.getWorker();
 const tick = scheduledTime => executor.scheduled({scheduledTime:Date.parse(scheduledTime),cron:'*/15 * * * *'});
 await db.prepare('UPDATE finance_settings SET daily_reminder=1,email_reminder=1 WHERE id=1').run();
 await db.prepare("INSERT INTO finance_thresholds (variant_id,threshold,target) VALUES ('h',2,8)").run();
 const refresh = () => db.prepare("SELECT id,state FROM finance_notifications WHERE kind='stock' AND dedupe LIKE 'stock:h:%'").all();
 const before = mail.filter(message=>message.subject==='UNLISTED · Daily balance check').length;
 await tick('2030-11-18T18:45:00Z');
 assert.equal(mail.filter(message=>message.subject==='UNLISTED · Daily balance check').length,before);
 assert.equal((await refresh()).results.filter(row=>row.state==='active').length,1);
 await tick('2030-11-18T19:00:00Z');
 await db.prepare("UPDATE finance_notifications SET state='read' WHERE kind='stock' AND dedupe LIKE 'stock:h:%'").run();
 await tick('2030-11-18T19:15:00Z');
 assert.equal(mail.filter(message=>message.subject==='UNLISTED · Daily balance check').length,before+1);
 assert.equal((await refresh()).results.length,1);
 await db.prepare("UPDATE variants SET inventory=8 WHERE id='h'").run();
 await tick('2030-11-18T19:30:00Z');
 assert.equal((await refresh()).results[0].state,'resolved');
 await db.prepare("UPDATE variants SET inventory=2 WHERE id='h'").run();
 await tick('2030-11-18T19:45:00Z');
 const rows = (await refresh()).results;
 assert.equal(rows.length,2);
 assert.equal(rows.filter(row=>row.state==='active').length,1);
});

test('project facts are private, idempotent and never create payments or unreceived stock',async()=>{
 const paidBefore=await db.prepare('SELECT count(*) n FROM finance_journals').first('n');
 const inventoryBefore=await db.prepare('SELECT sum(inventory) n FROM variants').first('n');
 const b={version:1,projects:[{id:'fixture-project',name:'Fixture batch',business:'SEPARATE TEST BUSINESS',state:'production',note:'Reported facts; no payment dates supplied.'}],costs:[{id:'fixture-paid',project_id:'fixture-project',description:'Fabric',amount:12345,state:'paid',note:''},{id:'fixture-estimate',project_id:'fixture-project',description:'Estimated factory',amount:4500,state:'estimate',note:''}],products:[{id:'fixture-production',project_id:'fixture-project',name:'Test clothes',product_id:null,planned:20,received:1,personal:0,samples:1,price:null,note:'Expected quantities are not stock.'}]};
 const payload={op:'project_import',bundle:JSON.stringify(b),confirmed:'yes'};
 const outsider=browser();assert.equal((await outsider('/admin/operations',payload)).status,303);
 for(let n=0;n<2;n++)assert.equal((await admin('/admin/operations',payload)).headers.get('Location'),'/admin/operations?saved=1');
 assert.equal(await db.prepare("SELECT count(*) n FROM ops_costs WHERE project_id='fixture-project'").first('n'),2);
 assert.equal(await db.prepare('SELECT count(*) n FROM finance_journals').first('n'),paidBefore);
 assert.equal(await db.prepare('SELECT sum(inventory) n FROM variants').first('n'),inventoryBefore);
 b.costs[0].amount++;assert.match((await admin('/admin/operations',{...payload,bundle:JSON.stringify(b)})).headers.get('Location'),/error=/);
 const page=await(await admin('/admin/operations?project=fixture-project')).text();assert.match(page,/Separate|SEPARATE TEST BUSINESS/);assert.match(page,/Estimates/);
 assert.equal((await admin('/admin/operations',payload,{Origin:'https://bad.example'})).status,403);
});

test('reason stock adjustments reject stale baselines and duplicate submissions atomically',async()=>{
 await db.prepare("UPDATE variants SET inventory=100 WHERE id='h'").run();
 const form={op:'stock_adjust',request_id:crypto.randomUUID().replaceAll('-',''),variant_id:'h',before:'100',quantity:'2',reason:'personal',note:'Fixture owner withdrawal',confirmed:'yes'};
 assert.equal((await admin('/admin/operations',form)).headers.get('Location'),'/admin/operations?saved=1');
 await admin('/admin/operations',form);assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='h'").first('inventory'),98);
 const stale=await admin('/admin/operations',{...form,request_id:crypto.randomUUID().replaceAll('-','')});assert.match(stale.headers.get('Location'),/error=/);
 assert.equal(await db.prepare("SELECT count(*) n FROM ops_movements WHERE variant_id='h'").first('n'),1);
 const forms=[{...form,before:'98',request_id:crypto.randomUUID().replaceAll('-','')},{...form,before:'98',request_id:crypto.randomUUID().replaceAll('-','')}];
 await Promise.all(forms.map(f=>admin('/admin/operations',f)));assert.equal(await db.prepare("SELECT inventory FROM variants WHERE id='h'").first('inventory'),96);
});

test('accountant matches reported costs once and keeps separate business payments out of UNLISTED reports',async()=>{
 const day=new Date().toISOString().slice(0,10),file=new FormData();
 file.set('op','extract');file.set('text',`date,amount,kind,category,account,note\n${day},123.45,inventory_purchase,raw materials,bank,Fixture already reported fabric`);
 const response=await admin('/admin/finance-action',file),id=new URL(origin+response.headers.get('Location')).searchParams.get('import');
 assert.ok(id);
 const form={op:'confirm_import',import_id:id,include_0:'on',date_0:day,amount_0:'123.45',kind_0:'inventory_purchase',category_0:'raw materials',account_0:'bank',note_0:'Fixture already reported fabric',project_0:'fixture-project',match_0:'fixture-paid',confirmed:'yes'};
 await admin('/admin/finance-action',form);await admin('/admin/finance-action',form);
 assert.equal(await db.prepare("SELECT count(*) n FROM ops_costs WHERE project_id='fixture-project'").first('n'),2);
 const journal=await db.prepare("SELECT journal_id FROM ops_costs WHERE id='fixture-paid'").first('journal_id');assert.ok(journal);
 assert.equal(await db.prepare('SELECT project_id FROM ops_journal_scope WHERE journal_id=?').bind(journal).first('project_id'),'fixture-project');
 const page=await(await admin('/admin/finance?tab=cash&days=all')).text();assert.doesNotMatch(page,/Fixture already reported fabric/);
});

test('COZY offers apply at checkout, expire for stale quotes and reserve both selected set sizes exactly once', async () => {
 const buyer = browser();
 const hoodie = 'h', sweats = 's';
 await db.batch([
   db.prepare("UPDATE variants SET inventory=2 WHERE id IN ('h','s')"),
   db.prepare("INSERT INTO finance_variant_costs(variant_id,unit_cost) VALUES ('h',21000),('s',18000) ON CONFLICT(variant_id) DO UPDATE SET unit_cost=excluded.unit_cost"),
 ]);
 const input = {name:'Offer fixture',email:'offer-fixture@example.invalid',phone:'01000000000',
   address:'Fixture street',city:'Cairo',governorate:'cairo',discount:'',payment_method:'cod'};
 const addSingle = () => buyer('/api/cart',{action:'add',variant:hoodie});
 const setForm = {action:'add_set',hoodie,sweats,quantity:1};
 const setTerms = async (active) => {
   await db.batch([
     db.prepare('DROP VIEW cozy_offer_terms'),
     db.prepare(`CREATE VIEW cozy_offer_terms AS SELECT ${active ? '0 AS starts_at, 4102444800' : '0 AS starts_at, 1'} AS ends_at,
       44900 AS sale_price, 52122 AS hoodie_set_price, 47778 AS sweats_set_price`),
   ]);
 };
 const checkout = async (web, total) => {
   const html = await (await web('/checkout',input)).text();
   const field = name => new RegExp('name="'+name+'" value="([^"]*)"').exec(html)?.[1];
   assert.equal(field('quoted_total'),String(total));
   return {...input,cart_version:field('cart_version'),checkout_key:field('checkout_key'),quoted_total:field('quoted_total')};
 };
 try {
   await setTerms(true);
   assert.equal((await addSingle()).headers.get('Location'),'/cart');
   assert.match(await (await buyer('/checkout',{...input,discount:'COZY10'})).text(),/Discount codes cannot be combined/);
   const stale = await checkout(buyer,52900);
   await setTerms(false);
   assert.match((await buyer('/api/checkout',stale)).headers.get('Location'),/error=/);
   await checkout(buyer,68000);
   assert.match((await buyer('/api/cart',setForm)).headers.get('Location'),/error=/);
   await buyer('/api/cart',{action:'remove',variant:hoodie});
   assert.match((await buyer('/api/cart',{...setForm,hoodie:sweats,sweats:hoodie})).headers.get('Location'),/error=/);
   assert.equal((await buyer('/api/cart',setForm)).headers.get('Location'),'/cart');
   const cart = await (await buyer('/cart')).text();
   assert.match(cart,/COZY FULL SET/);
   assert.match(cart,/HOODIE: S\/M · SWEATPANTS: L/);
   const request = await checkout(buyer,107900);
   const added = await buyer('/api/checkout',request);
   const path = added.headers.get('Location');
   assert.match(path,/^\/orders\/[a-f0-9]{32}$/);
   assert.equal((await buyer('/api/checkout',request)).headers.get('Location'),path);
   const id = path.split('/').at(-1);
   const {results:lines} = await db.prepare('SELECT variant_id,quantity,price FROM order_items WHERE order_id=? ORDER BY variant_id').bind(id).all();
   assert.deepEqual(lines,[{variant_id:hoodie,quantity:1,price:52122},{variant_id:sweats,quantity:1,price:47778}]);
   assert.equal(await db.prepare('SELECT count(*) AS count FROM finance_order_costs WHERE order_id=?').bind(id).first('count'),2);
   assert.equal(await db.prepare('SELECT quantity FROM order_cozy_sets WHERE order_id=?').bind(id).first('quantity'),1);
   assert.equal(await db.prepare("SELECT sum(inventory) AS stock FROM variants WHERE id IN ('h','s')").first('stock'),2);
   const ownerWeb = browser();
   await ownerWeb('/admin/session',{action:'password',password:ownerPassword},{'CF-Connecting-IP':'192.0.2.207'});
   assert.match((await ownerWeb('/admin/action',{op:'order',area:'orders',id,operation:'cancel'})).headers.get('Location'),/saved=1/);
   assert.equal(await db.prepare("SELECT sum(inventory) AS stock FROM variants WHERE id IN ('h','s')").first('stock'),4);
 } finally {
   await db.batch([
     db.prepare('DROP VIEW IF EXISTS cozy_offer_terms'),
     db.prepare(`CREATE VIEW cozy_offer_terms AS SELECT unixepoch('2026-11-27T00:00:00+02:00') AS starts_at,
       unixepoch('2026-11-29T00:00:00+02:00') AS ends_at, 44900 AS sale_price,
       52122 AS hoodie_set_price, 47778 AS sweats_set_price`),
   ]);
 }
});
