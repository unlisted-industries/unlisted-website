import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { adminEmails, currentUser, limitRequest, openAdminSession } from './auth.js';
import { ensureOwnerPasswordSchema } from './admin-password-schema.js';
import { isToken, makeToken, sha256, statements, unixNow } from './db.js';
import { emailValue, StoreError } from './http.js';

export function passwordsReady(env, url) {
  return Boolean(env.OWNER_PASSWORD_HASHER) && url.protocol === 'https:' &&
    env.ADMIN_ORIGIN === url.origin && adminEmails(env).length > 0;
}

export async function passwordRecord(db, email) {
  await ensureOwnerPasswordSchema(db);
  return db.prepare(`SELECT c.id, c.email, p.salt, p.password_hash
    FROM admin_passwords p JOIN customers c ON c.id = p.customer_id WHERE c.email = ?`).bind(email).first();
}

function passwordValue(form, field, minimum = 1) {
  const input = form.get(field);
  const value = typeof input === 'string' ? input.normalize('NFC') : '';
  const length = Array.from(value).length;
  if (length < minimum || length > 128) {
    throw new StoreError(minimum === 15 ? 'Use a password with 15 to 128 characters.' : 'Check your password.');
  }
  return value;
}

function derive(env, password, salt) {
  const hasher = env.OWNER_PASSWORD_HASHER;
  return hasher.get(hasher.idFromName('unlisted-owner')).derive(password, salt);
}

async function passwordMatches(env, value, record) {
  const hash = await derive(env, value, record.salt);
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(record.password_hash, 'hex'));
}

export async function signInWithPassword(env, context, form) {
  if (!passwordsReady(env, context.url)) throw new StoreError('Owner password sign-in is unavailable.', 503);
  await limitRequest(env.DB, context.request, 'owner-password:login', { limit: 10 });
  const allowed = adminEmails(env);
  const email = allowed.length === 1 ? allowed[0] : emailValue(form);
  const record = allowed.includes(email) ? await passwordRecord(env.DB, email) : null;
  const password = passwordValue(form, 'password');
  if (record) await limitRequest(env.DB, context.request, 'owner-password:account', { subject: record.id, limit: 60 });
  if (!record || !await passwordMatches(env, password, record)) {
    throw new StoreError('Check your password and try again.', 401);
  }
  await openAdminSession(env, context, record, record.password_hash);
}

export async function saveOwnerPassword(env, context, form) {
  if (!passwordsReady(env, context.url)) throw new StoreError('Owner password setup is unavailable.', 503);
  const user = await currentUser(env, context, 'admin');
  const session = context.cookies.get('unlisted_admin')?.value;
  if (!user || !isToken(session, 32)) throw new StoreError('Sign in to set your owner password.', 401);
  await limitRequest(env.DB, context.request, 'owner-password:change', { subject: user.id, limit: 10 });
  const password = passwordValue(form, 'password', 15);
  if (password !== passwordValue(form, 'password_confirmation', 15)) {
    throw new StoreError('Enter the same new password in both fields.');
  }
  const previous = await passwordRecord(env.DB, user.email);
  const canReset = Boolean(previous && user.password_change_until > unixNow());
  if (previous && !canReset && !await passwordMatches(env, passwordValue(form, 'current_password'), previous)) {
    throw new StoreError('Check your current password.', 401);
  }
  const salt = makeToken(16);
  const hash = await derive(env, password, salt);
  const verifiedWrite = 'EXISTS (SELECT 1 FROM admin_passwords WHERE customer_id = ? AND password_hash = ?)';
  const [saved] = await statements(env.DB, [
    [`INSERT INTO admin_passwords (customer_id, salt, password_hash)
      SELECT s.customer_id, ?, ? FROM sessions s
      WHERE s.digest = ? AND s.customer_id = ? AND s.purpose = 'admin' AND s.expires_at > unixepoch()
        AND (? = 0 OR EXISTS (SELECT 1 FROM admin_password_setups
          WHERE session_digest = s.digest AND expires_at > unixepoch()))
        AND (SELECT password_hash FROM admin_passwords WHERE customer_id = s.customer_id) IS ?
      ON CONFLICT (customer_id) DO UPDATE SET salt = excluded.salt, password_hash = excluded.password_hash`,
    salt, hash, await sha256(session), user.id, Number(canReset), previous?.password_hash ?? null],
    [`DELETE FROM sessions WHERE purpose = 'admin' AND customer_id = ? AND ${verifiedWrite}`, user.id, user.id, hash],
    [`DELETE FROM login_tokens WHERE purpose = 'admin' AND email = ? AND ${verifiedWrite}`, user.email, user.id, hash],
  ]);
  if (saved.meta.changes !== 1) throw new StoreError('Your sign-in changed. Open a new setup page and try again.', 409);
  await openAdminSession(env, context, user, hash);
}
