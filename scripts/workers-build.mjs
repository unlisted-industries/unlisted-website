import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const paymobNames = ['PAYMOB_SECRET_KEY', 'PAYMOB_PUBLIC_KEY', 'PAYMOB_HMAC_SECRET', 'PAYMOB_INTEGRATION_IDS'];

async function attachPaymobTestSecrets(config, env) {
  const missing = paymobNames.filter((name) => !env[name]?.trim());
  if (missing.length) return 'Build settings missing ' + missing.join(', ');
  const invalid = [];
  if (!/^(?:egypt_)?sk_?test[_-]/i.test(env.PAYMOB_SECRET_KEY.trim())) invalid.push('PAYMOB_SECRET_KEY (Test Secret Key)');
  if (!/^(?:egypt_)?pk_?test[_-]/i.test(env.PAYMOB_PUBLIC_KEY.trim())) invalid.push('PAYMOB_PUBLIC_KEY (Test Public Key)');
  if (!/^\s*[1-9]\d*(\s*,\s*[1-9]\d*)*\s*$/.test(env.PAYMOB_INTEGRATION_IDS)) invalid.push('PAYMOB_INTEGRATION_IDS (numeric Card Integration ID)');
  if (invalid.length) return 'Check these Build settings: ' + invalid.join(', ');
  if (!env.CLOUDFLARE_API_TOKEN) return 'This build cannot edit runtime settings.';

  const url = 'https://api.cloudflare.com/client/v4/accounts/' + config.account_id + '/workers/scripts/' + config.name;
  const headers = { Authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN };
  try {
    const settings = await fetch(url + '/settings', { headers, signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!settings.ok) return 'Cloudflare runtime settings check returned HTTP ' + settings.status + '.';
    const { result } = await settings.json();
    if (!Array.isArray(result?.bindings)) return 'Cloudflare runtime settings could not be verified.';
    if (result.bindings.some(({ name }) => paymobNames.includes(name))) return 'Existing Paymob runtime settings were preserved.';

    const secrets = Object.fromEntries(paymobNames.map((name) => [name, { name, type: 'secret_text', text: env[name].trim() }]));
    const update = await fetch(url + '/secrets-bulk', {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/merge-patch+json' },
      body: JSON.stringify({ secrets }), signal: AbortSignal.timeout(12000), redirect: 'error',
    });
    return update.ok && (await update.json()).success ? 'Paymob Test credentials added to runtime settings.'
      : 'Cloudflare runtime update returned HTTP ' + update.status + '.';
  } catch {
    return 'Cloudflare runtime update could not be verified.';
  }
}

// A connected Worker can use Wrangler's default deploy command on a clean checkout.
if (process.env.WORKERS_CI === '1') {
  const buildEnv = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' };
  for (const name of paymobNames) delete buildEnv[name];
  const build = spawnSync(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build'], {
    env: buildEnv,
    stdio: 'inherit',
  });
  if (build.error) throw build.error;
  process.exitCode = build.status ?? 1;
  if (build.status === 0 && process.env.WORKERS_CI_BRANCH === 'main') {
    const path = 'dist/server/wrangler.json';
    const config = JSON.parse(await readFile(path, 'utf8'));
    if (config.name === 'unlisted-website' && config.account_id === 'e9b1e1e2a83e75388d8fd84778fd5c78') {
      const status = await attachPaymobTestSecrets(config, process.env);
      config.vars = { ...config.vars, PREVIEW_PAYMOB_BUILD_STATUS: status };
      await writeFile(path, JSON.stringify(config));
    }
  }
}
