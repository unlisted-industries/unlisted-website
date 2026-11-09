import { env } from 'cloudflare:workers';
import { readBody, StoreError } from '../../lib/http.js';
import { sendReceipt } from '../../lib/checkout.js';
import { paymentOrigin, recordCapture, verifyPaymob } from '../../lib/paymob.js';

export async function POST({ request, url }) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return new Response('Unsupported content type', { status: 415 });
  }
  let message;
  try {
    const chunks = await readBody(request, 128 * 1024);
    message = JSON.parse(await new Blob(chunks).text());
  } catch (error) {
    return new Response('Invalid callback', { status: error instanceof StoreError ? error.status : 400 });
  }
  if (message?.type !== 'TRANSACTION' || !message.obj) return new Response(null, { status: 204 });
  if (!await verifyPaymob(message.obj, url.searchParams.get('hmac'), env.PAYMOB_HMAC_SECRET)) {
    return new Response('Invalid signature', { status: 401 });
  }
  try {
    const order = await recordCapture(env, message.obj);
    if (order) await sendReceipt(env, order, paymentOrigin(env) ?? url.origin);
    return new Response(null, { status: 204 });
  } catch (error) {
    return new Response('Callback could not be processed', { status: error instanceof StoreError ? error.status : 503 });
  }
}
