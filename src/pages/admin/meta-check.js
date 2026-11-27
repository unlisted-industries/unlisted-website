import { env } from 'cloudflare:workers';
import { currentUser } from '../../lib/auth.js';
import { checkCapi } from '../../lib/meta-capi.js';

export async function GET(context) {
  if (!await currentUser(env, context, 'admin')) return new Response('Sign-in required', { status: 401 });
  return Response.json(await checkCapi(env), { headers: { 'Cache-Control': 'no-store' } });
}
