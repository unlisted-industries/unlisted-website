import { ensureWorkspace } from './lib/workspace-schema.js';
import { deliverOrderNotifications } from './lib/order-notifications.js';
import { syncRmaTracking } from './lib/rma-providers.js';
import { deliverRmaMail } from './lib/rma.js';
import astro from '@astrojs/cloudflare/entrypoints/server';
import { runFinanceAutomation } from './lib/finance-automation.js';
import { expireOldData } from './lib/maintenance.js';

export { OwnerPasswordHasher } from './lib/owner-password-hasher.js';

export default {
  fetch: astro.fetch,
  async scheduled(_event, env) {
    await ensureWorkspace(env.DB);
    const results = await Promise.allSettled([deliverRmaMail(env), syncRmaTracking(env), expireOldData(env.DB), runFinanceAutomation(env), deliverOrderNotifications(env)]);
    for (const result of results) if (result.status === 'rejected') console.error('Scheduled maintenance incomplete', { type: result.reason?.name });
  },
};
