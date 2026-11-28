import { env } from 'cloudflare:workers';
import { sendPageView } from '../../lib/meta-capi.js';

// Receives the browser's PageView event ID and forwards it to the Meta Conversions API.
export async function POST(context) {
  const done = new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
  if (context.request.headers.get('Origin') !== context.url.origin) return new Response(null, { status: 403 });
  try {
    const body = await context.request.json();
    const id = String(body?.id ?? '');
    const url = new URL(String(body?.url ?? ''));
    if (!/^pv-[a-z0-9-]{8,64}$/i.test(id) || url.origin !== context.url.origin) return done;
    await sendPageView(env, context, { id, url });
  } catch { /* Tracking never interrupts shopping. */ }
  return done;
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
