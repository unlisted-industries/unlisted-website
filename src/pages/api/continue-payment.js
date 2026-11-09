import { env } from 'cloudflare:workers';
import { visibleOrder } from '../../lib/checkout.js';
import { limitRequest } from '../../lib/auth.js';
import { formData, formError, seeOther, StoreError, textValue } from '../../lib/http.js';
import { startPayment } from '../../lib/paymob.js';

export async function POST(context) {
  let destination = '/account';
  try {
    const form = await formData(context.request);
    const order = await visibleOrder(env, context, textValue(form, 'order', 32));
    if (!order) throw new StoreError('This order is unavailable.', 404);
    destination = '/orders/' + order.id;
    await limitRequest(env.DB, context.request, 'continue-payment', { limit: 15 });
    if (env.CHECKOUT_ENABLED !== 'true') throw new StoreError('Payment is currently unavailable.', 503);
    return seeOther(await startPayment(env, order));
  } catch (error) {
    return formError(error, destination);
  }
}
