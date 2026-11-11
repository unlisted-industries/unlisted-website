import migration from '../../migrations/0009_paymob_sandbox.sql?raw';
import { initializeTables, isToken, makeToken } from './db.js';
import { assertSameOrigin, StoreError } from './http.js';
import { limitRequest } from './auth.js';
import { capturedTransaction, createSandboxCheckout, paymentIntegrationIds, sandboxReady } from './paymob.js';

export const ensureSandboxRuns = initializeTables(migration);

export async function prepareSandboxPage(env, context, returnPath) {
  const state = { ready: sandboxReady(env, context.url.origin) };
  if (!state.ready) return state;
  await ensureSandboxRuns(env.DB);
  if (context.request.method === 'POST') {
    try {
      assertSameOrigin(context.request);
      await limitRequest(env.DB, context.request, 'paymob-sandbox', { limit: 5 });
      const id = makeToken(16);
      const { providerOrder, checkout } = await createSandboxCheckout(env, id, returnPath);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM paymob_sandbox_runs WHERE created_at < unixepoch() - 86400'),
        env.DB.prepare('INSERT INTO paymob_sandbox_runs (id, provider_order_id) VALUES (?, ?)').bind(id, providerOrder),
      ]);
      state.checkout = checkout;
    } catch (problem) {
      state.error = problem instanceof StoreError ? problem.message : 'Paymob sandbox checkout could not be started.';
      context.response.status = problem instanceof StoreError ? problem.status : 502;
    }
  }
  const id = context.url.searchParams.get('run');
  if (isToken(id, 16)) state.run = await env.DB.prepare('SELECT verified_at FROM paymob_sandbox_runs WHERE id = ?').bind(id).first();
  return state;
}

export async function recordSandboxCapture(env, origin, id, transaction) {
  if (!isToken(id, 16) || !sandboxReady(env, origin)) throw new StoreError('Invalid sandbox callback.', 409);
  if (!capturedTransaction(transaction)) return;
  if (!paymentIntegrationIds(env).includes(Number(transaction.integration_id))) {
    throw new StoreError('Sandbox payment uses a different integration.', 409);
  }
  if (transaction.currency !== 'EGP' || Number(transaction.amount_cents) !== 1000) {
    throw new StoreError('Sandbox payment does not match the test amount.', 409);
  }
  await ensureSandboxRuns(env.DB);
  const verified = await env.DB.prepare(`UPDATE paymob_sandbox_runs SET verified_at = coalesce(verified_at, unixepoch())
    WHERE id = ? AND provider_order_id = ? AND created_at > unixepoch() - 86400`).bind(id, String(transaction.order?.id)).run();
  if (!verified.meta.changes) throw new StoreError('Sandbox payment has no matching test.', 409);
}
