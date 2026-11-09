import { env } from 'cloudflare:workers';
import { addItem, updateItem } from '../../lib/cart.js';
import { cozyMatch } from '../../lib/catalog.js';
import { formData, formError, quantityValue, seeOther, textValue } from '../../lib/http.js';

export async function POST(context) {
  let destination = '/cart';
  try {
    const form = await formData(context.request);
    const id = textValue(form, 'variant', 100);
    const action = form.get('action');
    const origin = form.get('return_product');
    if (action === 'add' && typeof origin === 'string' && Object.hasOwn(cozyMatch, origin)) {
      destination = '/products/' + origin;
    }
    if (action === 'update' || action === 'remove') {
      await updateItem(env.DB, context, id, action === 'remove' ? 0 : quantityValue(form.get('quantity'), 0));
    } else {
      await addItem(env.DB, context, id, quantityValue(form.get('quantity') ?? '1'));
    }
    return seeOther(action === 'buy' ? '/checkout' : destination);
  } catch (error) {
    return formError(error, destination);
  }
}
