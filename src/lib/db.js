export async function all(statement) {
  return (await statement.all()).results;
}

export function statements(db, entries) {
  return db.batch(entries.map(([sql, ...values]) => db.prepare(sql).bind(...values)));
}

export function unixNow() {
  return Math.floor(Date.now() / 1000);
}

export function makeToken(bytes = 24) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isToken(value, bytes = 24) {
  return typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/.test(value);
}
