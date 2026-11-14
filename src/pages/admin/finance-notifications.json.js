import { env } from 'cloudflare:workers';
import { currentUser } from '../../lib/auth.js';
import { ensureFinance } from '../../lib/finance.js';
export async function GET(context){if(!await currentUser(env,context,'admin'))return new Response('Sign-in required',{status:401});await ensureFinance(env.DB);const items=(await env.DB.prepare("SELECT id,title,message FROM finance_notifications WHERE state='active' ORDER BY created_at DESC LIMIT 5").all()).results;return Response.json({items},{headers:{'Cache-Control':'private, no-store'}});}
