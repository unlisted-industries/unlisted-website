import { env } from 'cloudflare:workers';
import { currentUser } from '../../lib/auth.js';
import { financeAction } from '../../lib/finance.js';
import { formData, formError, seeOther } from '../../lib/http.js';

export async function POST(context) {
  if (!await currentUser(env, context, 'admin')) return new Response('Sign-in required', {status:401});
  try {
    const form=await formData(context.request,20*1024);
    await financeAction(env.DB,form);
    return seeOther('/admin/finance?saved=1');
  } catch(error) {
    return formError(error,'/admin/finance');
  }
}
