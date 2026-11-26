import migration from '../../migrations/0015_cozy_offers.sql?raw';
import { splitFinanceSql } from './finance-schema.js';
import { ensureRma } from './rma.js';

const initialized = new WeakMap();

export async function ensureOffers(db) {
  if (!initialized.has(db)) {
    const pending = (async () => {
      const ready = await db.prepare("SELECT 1 FROM sqlite_schema WHERE name='order_cozy_sets' AND type='table'").first();
      if (ready) return;
      await ensureRma(db);
      await db.batch(splitFinanceSql(migration).map(sql => db.prepare(sql)));
    })();
    initialized.set(db, pending);
    pending.catch(() => initialized.delete(db));
  }
  await initialized.get(db);
}
