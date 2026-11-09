import { env } from 'cloudflare:workers';
import { addItem, updateItem } from '../../lib/cart.js';
import { formData, formError, quantityValue, seeOther, textValue } from '../../lib/http.js';

export async function POST(context) {
  try {
    const form = await formData(context.request);
    const id = textValue(form, 'variant', 100);
    const action = form.get('action');
    if (action === 'update' || action === 'remove') {
      await updateItem(env.DB, context, id, action === 'remove' ? 0 : quantityValue(form.get('quantity'), 0));
    } else {
      await addItem(env.DB, context, id, quantityValue(form.get('quantity') ?? '1'));
    }
    return seeOther(action === 'buy' ? '/checkout' : '/cart');
  } catch (error) {
    return formError(error, '/cart');
  }
}
