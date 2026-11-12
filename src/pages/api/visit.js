import { env } from 'cloudflare:workers';
import { recordVisitor } from '../../lib/live-visitors.js';

export async function POST(context) {
  if (context.request.headers.get('Origin') !== context.url.origin) return new Response(null, { status: 403 });
  try { await recordVisitor(context, env, false); } catch { /* Analytics never interrupt shopping. */ }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
