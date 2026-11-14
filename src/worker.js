import astro from '@astrojs/cloudflare/entrypoints/server';
import { runFinanceAutomation } from './lib/finance-automation.js';
import { expireOldData } from './lib/maintenance.js';

export { OwnerPasswordHasher } from './lib/owner-password-hasher.js';

export default {
  fetch: astro.fetch,
  async scheduled(_event, env) {
    const results = await Promise.allSettled([expireOldData(env.DB), runFinanceAutomation(env)]);
    for (const result of results) if (result.status === 'rejected') console.error('Scheduled maintenance incomplete', { type: result.reason?.name });
  },
};
