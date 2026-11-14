import phaseOne from '../../migrations/0011_finance.sql?raw';
import upgrade from '../../migrations/0012_finance_os.sql?raw';
import { ensureReturns } from './returns.js';
import { ensureShopifyImport } from './shopify-import.js';
const ready = new WeakSet();
// Unlike splitting at every semicolon, retain complete trigger bodies.
export function splitFinanceSql(sql) {
 const out=[]; let current='',trigger=false;
 for(const line of sql.split('\n')) {
  current+=line+'\n'; if(/^CREATE TRIGGER/i.test(line.trim()))trigger=true;
  if((trigger && (/^END;\s*$/.test(line.trim()) || /^CREATE TRIGGER.*END;\s*$/.test(line.trim()))) || (!trigger && /;\s*$/.test(line.trim()))) {
   out.push(current);current='';trigger=false;
  }
 }
 if(current.trim()&&!/^\s*--[^\n]*\s*$/.test(current))out.push(current);
 return out;
}
export async function ensureFinance(db) {
 if(ready.has(db))return;
 await ensureReturns(db); await ensureShopifyImport(db);
 await db.batch([...splitFinanceSql(phaseOne),...splitFinanceSql(upgrade)].map(sql=>db.prepare(sql)));
 ready.add(db);
}
