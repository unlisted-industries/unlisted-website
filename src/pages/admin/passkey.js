import { env } from 'cloudflare:workers';
import { finishPasskey, passkeysReady, startPasskey } from '../../lib/admin-passkeys.js';
import { currentUser, limitRequest } from '../../lib/auth.js';
import { assertSameOrigin, readBody, StoreError } from '../../lib/http.js';

export async function POST(context) {
  try {
    assertSameOrigin(context.request);
    if (!passkeysReady(env, context.url)) throw new StoreError('Owner passkeys are unavailable on this address.', 404);
    if (!/^application\/json(?:;|$)/i.test(context.request.headers.get('Content-Type') ?? '')) {
      throw new StoreError('Send a JSON request.', 415);
    }
    const chunks = await readBody(context.request, 32 * 1024);
    const input = await new Response(new Blob(chunks)).json().catch(() => null);
    const action = typeof input?.action === 'string' && /^(login|register)-(options|verify)$/.exec(input.action);
    if (!action) throw new StoreError('Start a new passkey request.');
    const [, purpose, step] = action;
    const user = purpose === 'register' ? await currentUser(env, context, 'admin') : null;
    if (purpose === 'register' && !user) throw new StoreError('Sign in to add an owner passkey.', 401);
    await limitRequest(env.DB, context.request, 'owner-passkey:' + purpose, { limit: 30, window: 300 });
    if (step === 'options') return Response.json(await startPasskey(env, context, purpose, user));
    await finishPasskey(env, context, purpose, user, input.response);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof StoreError) return Response.json({ error: error.message }, { status: error.status });
    console.error('Owner passkey operation failed', { type: error?.name });
    return Response.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}
