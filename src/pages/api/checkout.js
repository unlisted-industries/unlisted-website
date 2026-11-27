import { ensureFinance } from '../../lib/finance-schema.js';
import { deliverOrderNotifications } from '../../lib/order-notifications.js';
import { env } from 'cloudflare:workers';
import { getSettings } from '../../lib/catalog.js';
import { cartId } from '../../lib/cart.js';
import { currentUser, limitRequest } from '../../lib/auth.js';
import { checkoutInput, checkoutReady, placeOrder, sendReceipt } from '../../lib/checkout.js';
import { formData, formError, quantityValue, seeOther, StoreError, textValue, withStatus } from '../../lib/http.js';
import { cardReady, walletReady, startPayment } from '../../lib/paymob.js';
import { isToken } from '../../lib/db.js';
import { saveOrderContext, sendOrderPurchase } from '../../lib/meta-capi.js';

export async function POST(context) {
  try {
    const form = await formData(context.request);
    const input = checkoutInput(form);
    const settings = await getSettings(context, env.DB);
    if (!checkoutReady(env, settings)) throw new StoreError('Checkout is currently closed.');
    if (!(input.method === 'cod' && settings.cod_enabled || input.method === 'card' && settings.card_enabled && cardReady(env) || input.method === 'wallet' && settings.card_enabled && walletReady(env))) {
      throw new StoreError('Select an available payment method.');
    }
    await limitRequest(env.DB, context.request, 'checkout', { limit: 40 });
    const [day, id] = (context.cookies.get('unlisted_visit')?.value ?? '').split('.');
    const visitor = settings.analytics_enabled && isToken(id) && /^\d{4}-\d\d-\d\d$/.test(day) &&
      context.request.headers.get('DNT') !== '1' && context.request.headers.get('Sec-GPC') !== '1' ? { id, day } : null;
    const expected = {
      version: quantityValue(form.get('cart_version'), 0, 999999999),
      total: quantityValue(form.get('quoted_total'), 0, 99999999999),
    };
    await ensureFinance(env.DB);
    const { order, created } = await placeOrder(env.DB, {
      id: cartId(context), key: textValue(form, 'checkout_key', 48), input, expected,
      user: await currentUser(env, context), visitor,
    });
    const campaign=context.cookies.get('unlisted_campaign')?.value;
    if(created&&visitor&&/^\d{1,30}$/.test(campaign||'')){try{await env.DB.prepare("INSERT OR IGNORE INTO finance_order_attribution(source,order_id,campaign_id) VALUES('website',?,?)").bind(order.id,campaign).run();}catch{console.error('Order attribution was not saved');}}
    if (created) await saveOrderContext(env, context, order.id);
    const orderPath = '/orders/' + order.id;
    // The durable outbox is committed with the order. Delivery failures never undo an order.
    await deliverOrderNotifications(env, order.id).catch(() => console.error('Order notification remains queued'));
    if (order.payment_method === 'cod') {
      if (created) { await sendReceipt(env, order, context.url.origin); await sendOrderPurchase(env, order); }
      return seeOther(orderPath);
    }
    if (order.payment_status !== 'pending') return seeOther(orderPath);
    try {
      return seeOther(await startPayment(env, order));
    } catch (error) {
      return seeOther(withStatus(orderPath, 'error', error.message));
    }
  } catch (error) {
    return formError(error, '/checkout');
  }
}
