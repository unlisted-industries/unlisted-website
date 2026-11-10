import astro from '@astrojs/cloudflare/entrypoints/server';
import { expireOldData } from './lib/maintenance.js';

export { OwnerPasswordHasher } from './lib/owner-password-hasher.js';

export default {
  fetch: astro.fetch,
  async scheduled(_event, env) {
    await expireOldData(env.DB);
  },
};
