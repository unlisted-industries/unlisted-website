import { env } from 'cloudflare:workers';
import { currentUser } from '../../lib/auth.js';
import { ensureRma } from '../../lib/rma.js';
export async function GET(context) {
 if(!await currentUser(env,context,'admin'))return new Response(null,{status:401});
 await ensureRma(env.DB);const p=await env.DB.prepare('SELECT * FROM rma_photos WHERE id=?').bind(context.url.searchParams.get('id')||'').first();
 if(!p)return new Response(null,{status:404});const object=await env.MEDIA.get(p.media_key);
 return object?new Response(object.body,{headers:{'Content-Type':p.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}}):new Response(null,{status:404});
}
