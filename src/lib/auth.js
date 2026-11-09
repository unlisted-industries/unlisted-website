import { isToken, makeToken, sha256, statements, unixNow } from './db.js';
import { clearCookie, setCookie, StoreError } from './http.js';

const loginWindow = 15 * 60;
const accounts = {
  account: { cookie: 'unlisted_account', path: '/', age: 30 * 86400, returnTo: '/account' },
  admin: { cookie: 'unlisted_admin', path: '/admin', age: 12 * 3600, returnTo: '/admin' },
};

export function canAdmin(env, email) {
  return (env.ADMIN_EMAILS ?? '').split(',').some((value) => value.trim().toLowerCase() === email);
}

export function emailReady(env) {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export async function sendEmail(env, { to, subject, text, key }) {
  if (!emailReady(env)) return false;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) console.error('Email provider returned', response.status);
    return response.ok;
  } catch {
    console.error('Email provider request did not complete');
    return false;
  }
}

export async function limitRequest(db, request, action, { subject, limit = 10, window = loginWindow } = {}) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const now = unixNow();
  const bucket = Math.floor(now / window);
  const keys = await Promise.all([ip, ...(subject ? [subject] : [])].map((value, index) =>
    sha256(`${action}:${index}:${bucket}:${value}`)));
  const result = await statements(db, keys.map((key) => [`INSERT INTO rate_limits (key, hits, expires_at)
    VALUES (?, 1, ?) ON CONFLICT (key) DO UPDATE SET hits = hits + 1 RETURNING hits`,
    key, (bucket + 1) * window]));
  if (result.some(({ results }) => results[0].hits > limit)) {
    throw new StoreError('Too many attempts. Please wait and try again.', 429);
  }
}

export async function requestLogin(env, context, purpose, email) {
  if (!emailReady(env)) throw new StoreError('Email sign-in is currently unavailable.', 503);
  await limitRequest(env.DB, context.request, 'login:' + purpose, { subject: email, limit: 5 });
  if (purpose === 'admin' && !canAdmin(env, email)) return;

  const raw = makeToken(32);
  const digest = await sha256(raw);
  await env.DB.prepare('INSERT INTO login_tokens (digest, email, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .bind(digest, email, purpose, unixNow() + loginWindow).run();
  const url = new URL(accounts[purpose].returnTo + '/verify', context.url.origin);
  url.searchParams.set('token', raw);
  const sent = await sendEmail(env, {
    to: email,
    subject: 'Your UNLISTED™ sign-in link',
    text: 'Open this link within 15 minutes to sign in to UNLISTED™.\n\n' + url + '\n\nIf you did not request this link, you can ignore this email.',
    key: 'unlisted-login-' + digest,
  });
  if (!sent) await env.DB.prepare('DELETE FROM login_tokens WHERE digest = ?').bind(digest).run();
}

export async function confirmLogin(env, context, purpose, raw) {
  if (!isToken(raw, 32)) throw new StoreError('Request a new sign-in link.');
  await limitRequest(env.DB, context.request, 'verify:' + purpose, { limit: 12 });
  const digest = await sha256(raw);
  const token = await env.DB.prepare(`SELECT email FROM login_tokens
    WHERE digest = ? AND purpose = ? AND expires_at > unixepoch()`).bind(digest, purpose).first();
  if (!token || (purpose === 'admin' && !canAdmin(env, token.email))) {
    throw new StoreError('This link expired or was already used. Request a new one.');
  }
  const settings = accounts[purpose];
  const session = makeToken(32);
  const sessionDigest = await sha256(session);
  const current = context.cookies.get(settings.cookie)?.value;
  const oldDigest = isToken(current, 32) ? await sha256(current) : '';
  const result = await statements(env.DB, [
    [`INSERT INTO customers (id, email)
      SELECT ?, email FROM login_tokens WHERE digest = ? AND purpose = ? AND expires_at > unixepoch()
      ON CONFLICT (email) DO NOTHING`, makeToken(), digest, purpose],
    [`INSERT INTO sessions (digest, customer_id, purpose, expires_at)
      SELECT ?, c.id, t.purpose, ? FROM login_tokens t JOIN customers c ON c.email = t.email
      WHERE t.digest = ? AND t.purpose = ? AND t.expires_at > unixepoch()`,
    sessionDigest, unixNow() + settings.age, digest, purpose],
    ['DELETE FROM login_tokens WHERE digest = ? AND purpose = ?', digest, purpose],
    ['DELETE FROM sessions WHERE digest = ? AND purpose = ?', oldDigest, purpose],
  ]);
  if (result[1].meta.changes !== 1) throw new StoreError('This link expired or was already used. Request a new one.');
  setCookie(context, settings.cookie, session, settings.age, settings.path);
  return settings.returnTo;
}

export async function currentUser(env, context, purpose = 'account') {
  const raw = context.cookies.get(accounts[purpose].cookie)?.value;
  if (!isToken(raw, 32)) return null;
  const user = await env.DB.prepare(`SELECT c.id, c.name, c.email FROM sessions s JOIN customers c ON c.id = s.customer_id
    WHERE s.digest = ? AND s.purpose = ? AND s.expires_at > unixepoch()`)
    .bind(await sha256(raw), purpose).first();
  return user && (purpose !== 'admin' || canAdmin(env, user.email)) ? user : null;
}

export async function logout(env, context, purpose) {
  const settings = accounts[purpose];
  const raw = context.cookies.get(settings.cookie)?.value;
  if (isToken(raw, 32)) {
    await env.DB.prepare('DELETE FROM sessions WHERE digest = ? AND purpose = ?').bind(await sha256(raw), purpose).run();
  }
  clearCookie(context, settings.cookie, settings.path);
  return settings.returnTo;
}
