import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const flags = new Set(process.argv.slice(2));
const dryRun = flags.has('--dry-run');
const bootstrap = flags.has('--bootstrap-catalog');
if ([...flags].some((flag) => flag !== '--dry-run' && flag !== '--bootstrap-catalog') || dryRun && bootstrap) {
  throw new Error('Use --dry-run or --bootstrap-catalog.');
}

const built = 'dist/server/wrangler.json';
const config = JSON.parse(await readFile(built, 'utf8').catch(() => {
  throw new Error('Build the Worker with npm run build first.');
}));
const database = config.d1_databases.find((binding) => binding.binding === 'DB');
const media = config.r2_buckets.find((binding) => binding.binding === 'MEDIA');
if (config.name !== 'unlisted-website' || config.routes?.length || config.route) {
  throw new Error('Deployment configuration must target the UNLISTED Worker without custom domains.');
}
const id = process.env.CLOUDFLARE_D1_DATABASE_ID ?? database.database_id;
const databaseName = process.env.CLOUDFLARE_D1_DATABASE_NAME ?? database.database_name;
const bucket = process.env.CLOUDFLARE_R2_BUCKET ?? media.bucket_name;
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !dryRun && /^0{8}-/.test(id)) {
  throw new Error('Configure CLOUDFLARE_D1_DATABASE_ID with the real UNLISTED database UUID.');
}
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(databaseName) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
  throw new Error('The D1 database or R2 bucket name is invalid.');
}
database.database_id = id;
database.database_name = databaseName;
media.bucket_name = bucket;
const target = 'dist/server/wrangler.deploy.json';
await writeFile(target, JSON.stringify(config));

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function wrangler(args) {
  run('node_modules/wrangler/bin/wrangler.js', [...args, '--config', target]);
}

if (!dryRun) {
  wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  if (bootstrap) run('scripts/import-catalog.mjs', ['--remote', '--config', target]);
}
wrangler(['deploy', '--autoconfig=false', ...(dryRun ? ['--dry-run'] : [])]);
