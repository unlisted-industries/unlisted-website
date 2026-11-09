import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { safeHtml } from '../src/lib/content.js';

const flags = process.argv.slice(2);
const mode = flags.includes('--remote') ? '--remote' : flags.includes('--local') ? '--local' : '';
if (!mode || flags.includes('--remote') && flags.includes('--local')) throw new Error('Select --local or --remote.');
const configPosition = flags.indexOf('--config');
const config = configPosition < 0 ? 'wrangler.jsonc' : flags[configPosition + 1];
const catalog = JSON.parse(await readFile(new URL('../data/shopify-public.json', import.meta.url)));
const configuration = JSON.parse(await readFile(config, 'utf8'));
const bucket = configuration.r2_buckets.find((entry) => entry.binding === 'MEDIA')?.bucket_name;
const database = configuration.d1_databases.find((entry) => entry.binding === 'DB');
if (!bucket || !database || mode === '--remote' && /^0{8}-/.test(database.database_id ?? '00000000-')) {
  throw new Error('Provide the target Worker configuration with real storage bindings.');
}

async function wrangler(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--config', config], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Wrangler exited with code ' + code)));
  });
}

const types = new Set(['image/webp', 'image/png', 'image/jpeg', 'image/gif', 'image/avif', 'video/mp4']);
const stash = '.local/media';
await mkdir(stash, { recursive: true });

async function downloadMedia(media) {
  const url = new URL(media.url);
  if (url.protocol !== 'https:' || !['cdn.shopify.com', 'unlisted-shop.com'].includes(url.hostname) ||
      !/^shop\/[a-z0-9_.-]{1,180}$/i.test(media.key) || !types.has(media.type)) {
    throw new Error('Unexpected catalog media location or type.');
  }
  const path = join(stash, media.key.slice(5));
  if (await stat(path).then((info) => info.size > 0, () => false)) return path;
  const temporary = path + '.download';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Use curl so local corporate proxies and CDN retries work consistently.
      await new Promise((resolve, reject) => {
        const child = spawn('curl', ['--fail', '--silent', '--show-error', '--max-time', '50',
          '--max-filesize', '100000000', url.href, '--output', temporary], { stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Media download failed: ' + media.key)));
      });
      if (!(await stat(temporary)).size) throw new Error('Media download was empty: ' + media.key);
      await rename(temporary, path);
      return path;
    } catch (error) {
      await rm(temporary, { force: true });
      if (attempt === 3) throw error;
    }
  }
}

function sql(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function insert(table, row) {
  return `INSERT OR IGNORE INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(sql).join(', ')});`;
}

const statements = [];
for (let offset = 0; offset < catalog.media.length; offset += 6) {
  const media = catalog.media.slice(offset, offset + 6);
  const files = await Promise.all(media.map(downloadMedia));
  for (const [index, object] of media.entries()) {
    await wrangler(['r2', 'object', 'put', bucket + '/' + object.key, '--file', files[index], '--content-type', object.type, mode]);
    statements.push(insert('media', { key: object.key, content_type: object.type, original_name: object.name }));
  }
}

for (const product of catalog.products) {
  const { variants, images, ...row } = product;
  statements.push(insert('products', {
    ...row, status: 'active', description: safeHtml(row.description), option_names: JSON.stringify(row.option_names),
  }));
  for (const variant of variants) {
    statements.push(insert('variants', { ...variant, product_id: product.id, options: JSON.stringify(variant.options) }));
  }
  for (const image of images) {
    const { key, ...attributes } = image;
    statements.push(insert('product_images', { ...attributes, media_key: key, product_id: product.id }));
  }
}
for (const collection of catalog.collections) {
  const { products, ...row } = collection;
  statements.push(insert('collections', { ...row, description: safeHtml(row.description) }));
  for (const [position, product_id] of products.entries()) {
    statements.push(insert('collection_products', { collection_handle: row.handle, product_id, position }));
  }
}
for (const page of catalog.pages) statements.push(insert('pages', { ...page, body: safeHtml(page.body) }));
const settings = { ...catalog.settings, navigation: JSON.stringify(catalog.settings.navigation), socials: JSON.stringify(catalog.settings.socials) };
statements.push('UPDATE store_settings SET ' +
  Object.entries(settings).map(([key, value]) => key + ' = ' + sql(value)).join(', ') +
  " WHERE id = 1 AND hero_desktop IS NULL AND size_guide = '';");
const file = '.local/shopify-public.sql';
await writeFile(file, statements.join('\n') + '\n');
await wrangler(['d1', 'execute', 'DB', mode, '--file', file, '--yes']);
console.log(`Imported ${catalog.products.length} public products and ${catalog.media.length} media objects. Inventory and live checkout require merchant setup.`);
