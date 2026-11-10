import migration from '../../migrations/0006_owner_passwords.sql?raw';

const schema = migration.split(';').map((sql) => sql.trim()).filter(Boolean);
const initialized = new WeakSet();

export async function ensureOwnerPasswordSchema(db) {
  if (initialized.has(db)) return;
  await db.batch(schema.map((sql) => db.prepare(sql)));
  initialized.add(db);
}
