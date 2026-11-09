import { env } from 'cloudflare:workers';
import { limitRequest } from '../../lib/auth.js';
import { makeToken } from '../../lib/db.js';
import { emailValue, formData, formError, seeOther, slugValue, StoreError, textValue } from '../../lib/http.js';

export async function POST(context) {
  let path = '/';
  try {
    const form = await formData(context.request);
    const handle = slugValue(form.get('product'));
    path = '/?preorder=' + handle;
    const email = emailValue(form);
    await limitRequest(env.DB, context.request, 'preorder', { subject: email, limit: 8 });
    if (form.get('consent') !== 'on') throw new StoreError('Consent is required to register your interest.');
    const variant = await env.DB.prepare(`SELECT p.id AS product_id, v.id AS variant_id
      FROM products p JOIN variants v ON v.product_id = p.id WHERE p.handle = ?
      AND p.status = 'active' AND p.preorder = 1 AND v.id = ? AND v.active = 1`)
      .bind(handle, textValue(form, 'variant', 100)).first();
    if (!variant) throw new StoreError('Select an available size.');
    await env.DB.prepare(`INSERT INTO preorder_requests (id, product_id, variant_id, name, email, phone)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (product_id, variant_id, email) DO NOTHING`)
      .bind(makeToken(), variant.product_id, variant.variant_id, textValue(form, 'name', 100), email, textValue(form, 'phone', 24)).run();
    return seeOther(path + '&registered=1');
  } catch (error) {
    return formError(error, path);
  }
}
