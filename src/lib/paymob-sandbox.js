import migration from '../../migrations/0009_paymob_sandbox.sql?raw';
import { initializeTables, isToken } from './db.js';
import { StoreError } from './http.js';
import { capturedTransaction, sandboxReady } from './paymob.js';

export const ensureSandboxRuns = initializeTables(migration);

export async function recordSandboxCapture(env, origin, id, transaction) {
  if (!isToken(id, 16) || !sandboxReady(env, origin)) throw new StoreError('Invalid sandbox callback.', 409);
  if (!capturedTransaction(transaction)) return;
  if (transaction.currency !== 'EGP' || Number(transaction.amount_cents) !== 1000) {
    throw new StoreError('Sandbox payment does not match the test amount.', 409);
  }
  await ensureSandboxRuns(env.DB);
  const verified = await env.DB.prepare(`UPDATE paymob_sandbox_runs SET verified_at = coalesce(verified_at, unixepoch())
    WHERE id = ? AND provider_order_id = ? AND created_at > unixepoch() - 86400`).bind(id, String(transaction.order?.id)).run();
  if (!verified.meta.changes) throw new StoreError('Sandbox payment has no matching test.', 409);
}
