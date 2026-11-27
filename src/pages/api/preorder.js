import { env } from 'cloudflare:workers';
import { limitRequest } from '../../lib/auth.js';
import { formData, formError, seeOther, slugValue, StoreError } from '../../lib/http.js';
import { startDeposit } from '../../lib/preorder-deposit.js';

export async function POST(context) {
  let path = '/';
  try {
    const form = await formData(context.request);
    const handle = slugValue(form.get('product'));
    path = '/?preorder=' + handle;
    await limitRequest(env.DB, context.request, 'preorder', { limit: 12 });
    return seeOther(await startDeposit(env, form, handle));
  } catch (error) {
    if (!(error instanceof StoreError)) console.error('Pre-order deposit could not start');
    return formError(error instanceof StoreError ? error : new StoreError('The deposit payment could not be opened. Try again.'), path);
  }
}
