import { env } from 'cloudflare:workers';
import { currentUser } from '../../lib/auth.js';
import { ensureFinance } from '../../lib/finance.js';
export async function GET(context){
 if(!await currentUser(env,context,'admin'))return new Response('Sign-in required',{status:401});
 await ensureFinance(env.DB);const id=context.url.searchParams.get('id');if(!/^[a-f0-9]{32}$/.test(id||''))return new Response('Not found',{status:404});
 const row=await env.DB.prepare('SELECT media_key,name FROM finance_imports WHERE id=?').bind(id).first();if(!row?.media_key)return new Response('Not found',{status:404});
 const object=await env.MEDIA.get(row.media_key);if(!object)return new Response('Not found',{status:404});
 return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="finance-document"','Cache-Control':'private, no-store'}});
}
