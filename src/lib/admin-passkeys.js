import { Buffer } from 'node:buffer';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { canAdmin, openAdminSession } from './auth.js';
import { all, isToken, makeToken, sha256, statements, unixNow } from './db.js';
import { clearCookie, setCookie, StoreError } from './http.js';

const cookie = 'unlisted_passkey';
const path = '/admin/passkey';
const challengeAge = 300;
const maxPasskeys = 8;
const algorithms = [-7, -257];

export function passkeysReady(env, url) {
  return Boolean(env.ADMIN_EMAILS?.trim()) && url.protocol === 'https:' && env.ADMIN_ORIGIN === url.origin;
}

export async function startPasskey(env, context, purpose, user) {
  const rpID = context.url.hostname;
  const timeout = 60_000;
  let options;
  if (purpose === 'register') {
    const existing = await all(env.DB.prepare(`SELECT credential_id, transports FROM admin_passkeys
      WHERE customer_id = ?`).bind(user.id));
    if (existing.length >= maxPasskeys) throw new StoreError('The maximum number of owner passkeys is saved.');
    options = await generateRegistrationOptions({
      rpName: 'UNLISTED', rpID, timeout, userName: user.email, userID: new TextEncoder().encode(user.id),
      attestationType: 'none', supportedAlgorithmIDs: algorithms,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: existing.map((key) => ({ id: key.credential_id, transports: JSON.parse(key.transports) })),
    });
  } else {
    options = await generateAuthenticationOptions({ rpID, timeout, userVerification: 'required' });
  }
  const raw = makeToken(32);
  const previous = context.cookies.get(cookie)?.value;
  await statements(env.DB, [
    ['DELETE FROM admin_passkey_challenges WHERE digest = ?', isToken(previous, 32) ? await sha256(previous) : ''],
    [`INSERT INTO admin_passkey_challenges (digest, challenge, purpose, customer_id, expires_at)
      VALUES (?, ?, ?, ?, ?)`, await sha256(raw), options.challenge, purpose, user?.id ?? '', unixNow() + challengeAge],
  ]);
  setCookie(context, cookie, raw, challengeAge, path);
  return options;
}

export async function finishPasskey(env, context, purpose, user, response) {
  const raw = context.cookies.get(cookie)?.value;
  clearCookie(context, cookie, path);
  if (!isToken(raw, 32)) throw new StoreError('Start a new passkey request.');
  const pending = await env.DB.prepare(`DELETE FROM admin_passkey_challenges
    WHERE digest = ? AND purpose = ? AND customer_id = ? AND expires_at > unixepoch() RETURNING challenge`)
    .bind(await sha256(raw), purpose, user?.id ?? '').first();
  if (!pending) throw new StoreError('This passkey request expired. Try again.');
  if (typeof response?.id !== 'string' || response.id.length > 2048 || !/^[a-zA-Z0-9_-]+$/.test(response.id)) {
    throw new StoreError('The passkey response could not be verified.', 401);
  }
  const expected = {
    response, expectedChallenge: pending.challenge, expectedOrigin: context.url.origin,
    expectedRPID: context.url.hostname, requireUserVerification: true,
  };
  if (purpose === 'register') {
    const verification = await verifyRegistrationResponse({ ...expected, supportedAlgorithmIDs: algorithms }).catch(() => null);
    const credential = verification?.verified && verification.registrationInfo?.credential;
    if (!credential) throw new StoreError('The passkey could not be registered. Try again.', 401);
    const saved = await env.DB.prepare(`INSERT INTO admin_passkeys
      (credential_id, customer_id, public_key, counter, transports)
      SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM admin_passkeys WHERE customer_id = ?) < ?
      ON CONFLICT (credential_id) DO NOTHING`)
      .bind(credential.id, user.id, Buffer.from(credential.publicKey).toString('base64url'), credential.counter,
        JSON.stringify(credential.transports ?? []), user.id, maxPasskeys).run();
    if (saved.meta.changes !== 1) throw new StoreError('This passkey is already saved or the passkey limit was reached.');
    return;
  }
  const key = await env.DB.prepare(`SELECT p.credential_id, p.public_key, p.counter, p.transports, c.id, c.email
    FROM admin_passkeys p JOIN customers c ON c.id = p.customer_id WHERE p.credential_id = ?`)
    .bind(response.id).first();
  const invalid = new StoreError('The passkey could not be verified. Try again.', 401);
  if (!key || !canAdmin(env, key.email) || response.response?.userHandle &&
      response.response.userHandle !== Buffer.from(key.id).toString('base64url')) throw invalid;
  const verification = await verifyAuthenticationResponse({
    ...expected,
    credential: { id: key.credential_id, publicKey: new Uint8Array(Buffer.from(key.public_key, 'base64url')),
      counter: key.counter, transports: JSON.parse(key.transports) },
  }).catch(() => null);
  if (!verification?.verified) throw invalid;
  const updated = await env.DB.prepare('UPDATE admin_passkeys SET counter = ? WHERE credential_id = ? AND counter = ?')
    .bind(verification.authenticationInfo.newCounter, key.credential_id, key.counter).run();
  if (updated.meta.changes !== 1) throw invalid;
  await openAdminSession(env, context, key);
}
