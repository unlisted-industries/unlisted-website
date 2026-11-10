import { env } from 'cloudflare:workers';
import { limitRequest } from '../../lib/auth.js';
import { visibleOrder } from '../../lib/checkout.js';
import { formData, formError, seeOther, StoreError, textValue } from '../../lib/http.js';
import { submitReturn } from '../../lib/returns.js';

export async function POST(context) {
  let destination = '/account';
  try {
    const form = await formData(context.request);
    const order = await visibleOrder(env, context, textValue(form, 'order', 32));
    if (!order) throw new StoreError('This order is unavailable.', 404);
    destination = '/orders/' + order.id + '?return-request=1#returns';
    await limitRequest(env.DB, context.request, 'returns:submit', { subject: order.id, limit: 15 });
    await submitReturn(env.DB, order, form);
    return seeOther('/orders/' + order.id + '?return-sent=1#returns');
  } catch (error) {
    return formError(error, destination);
  }
}
