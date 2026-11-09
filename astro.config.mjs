import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough' }),
  session: false,
  site: 'https://unlisted-shop.com',
  trailingSlash: 'never',
  devToolbar: { enabled: false },
  security: { checkOrigin: true },
});
