import { spawnSync } from 'node:child_process';

// A connected Worker can use Wrangler's default deploy command on a clean checkout.
if (process.env.WORKERS_CI === '1') {
  const build = spawnSync(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build'], {
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    stdio: 'inherit',
  });
  if (build.error) throw build.error;
  process.exitCode = build.status ?? 1;
}
