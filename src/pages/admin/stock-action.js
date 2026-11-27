import { env } from 'cloudflare:workers';
import { currentUser } from '../../lib/auth.js';
import { formData, formError, seeOther } from '../../lib/http.js';
import { addPr, stockAction } from '../../lib/stocks.js';

export async function POST(context) {
  const user = await currentUser(env, context, 'admin');
  if (!user) return new Response('Sign-in required', { status: 401 });
  const back = (context.request.headers.get('Referer') ?? '').includes('/admin/marketing') ? '/admin/marketing' : '/admin/finance';
  try {
    const form = await formData(context.request);
    if (form.get('op') === 'pr') {
      await addPr(env.DB, form);
      return seeOther('/admin/marketing?saved=1#pr');
    }
    const project = await stockAction(env.DB, form);
    return seeOther('/admin/finance?stock=' + encodeURIComponent(project) + '&saved=1');
  } catch (error) {
    return formError(error, back);
  }
}
