import { env } from 'cloudflare:workers';
import { currentUser } from '../../lib/auth.js';
import { adminActions, adminSections } from '../../lib/admin.js';
import { formData, formError, seeOther, StoreError, withStatus } from '../../lib/http.js';

const areas = new Set(adminSections.map(([section]) => section));

export async function POST(context) {
  if (!await currentUser(env, context, 'admin')) return new Response('Sign-in required', { status: 401 });
  let destination = '/admin';
  try {
    const form = await formData(context.request, 16 * 1024 * 1024 + 4096);
    const area = form.get('area');
    if (areas.has(area)) destination += '/' + area;
    const search = form.get('return_query');
    if (typeof search === 'string' && /^[a-z_]+=[a-z0-9-]{1,80}$/i.test(search)) destination += '?' + search;
    const operation = form.get('op');
    if (!Object.hasOwn(adminActions, operation)) throw new StoreError('Choose a valid action.');
    return seeOther(withStatus(await adminActions[operation](env, form), 'saved', '1'));
  } catch (error) {
    return formError(error, destination);
  }
}
