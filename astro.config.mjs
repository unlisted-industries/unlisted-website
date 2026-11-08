import { defineConfig, sessionDrivers } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough' }), // images are pre-sized at upload; no paid/extra image service
  session: { driver: sessionDrivers.memory() },          // we don't use Astro sessions; avoids needing a KV namespace
  site: 'https://unlisted-shop.com',
  trailingSlash: 'never',
  security: { checkOrigin: true },
});
