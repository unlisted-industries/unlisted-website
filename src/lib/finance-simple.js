import { ensureFinance } from './finance-schema.js';
import { makeToken,sha256 } from './db.js';
import { StoreError,textValue,priceValue,quantityValue } from './http.js';
const ready=new WeakSet();
export async function ensureSimpleFinance(db){
 await ensureFinance(db);if(ready.has(db))return;
 await db.batch([
 db.prepare(`CREATE TABLE IF NOT EXISTS finance_stock_plans(id TEXT PRIMARY KEY,name TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>0),total_cost INTEGER NOT NULL CHECK(total_cost>=0),price INTEGER NOT NULL CHECK(price>0),fees INTEGER NOT NULL DEFAULT 0,ads INTEGER NOT NULL DEFAULT 0,pr_units INTEGER NOT NULL DEFAULT 0,pr_cost INTEGER NOT NULL DEFAULT 0,product_id TEXT REFERENCES products(id),updated_at INTEGER NOT NULL DEFAULT(unixepoch()))`),
 db.prepare(`CREATE TABLE IF NOT EXISTS finance_telegram_outbox(notification_id TEXT PRIMARY KEY REFERENCES finance_notifications(id),state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,sent_at INTEGER,last_error TEXT NOT NULL DEFAULT '')`)
 ]);ready.add(db);
}
// All amounts are EGP cents. Full-batch recovery includes production once, even for gifted units.
export function stockMetrics(p){
 const q=p.quantity,available=q-p.pr_units,net=p.price-p.fees;
 const unitCost=p.total_cost/q,margin=net-unitCost,fixed=p.total_cost+p.ads+p.pr_cost;
 const profit=available*net-fixed;
 const breakEvenUnits=net>0?Math.ceil(fixed/net):null;
 return {unitCost,available,profit,margin,maxCPA:margin>0?Math.floor(margin):null,
 breakEvenROAS:margin>0?p.price/margin:null,breakEvenUnits,
 canBreakEven:net>0&&available>0&&breakEvenUnits<=available,
 minimumPrice:available>0?Math.ceil(fixed/available)+p.fees:null,
 maxAds:Math.max(0,available*net-p.total_cost-p.pr_cost),
 maxPR:net>0?Math.max(0,Math.min(q,q-Math.ceil(fixed/net))):0};
}
export async function saveStockPlan(db,form,actor){
 await ensureSimpleFinance(db);
 if(form.get('confirmed')!=='yes')throw new StoreError('Check your stock details before saving.');
 const request=textValue(form,'request_id',32);if(!/^[a-f0-9]{32}$/.test(request))throw new StoreError('Reload the form and try again.');
 const digest=await sha256(JSON.stringify([...form.entries()].filter(([k])=>k!=='request_id').sort(([a],[b])=>a.localeCompare(b))));
 const old=await db.prepare('SELECT digest FROM finance_requests WHERE id=?').bind(request).first();
 if(old){if(old.digest!==digest)throw new StoreError('This form was already saved. Reload it.');return;}
 const id=textValue(form,'id',32,false)||request;
 if(id!==request&&!await db.prepare('SELECT id FROM finance_stock_plans WHERE id=?').bind(id).first())throw new StoreError('Stock not found.');
 const name=textValue(form,'name',80),quantity=quantityValue(form.get('quantity'),1,1000000);
 const amount=k=>priceValue(form.get(k)||'0');
 const total=amount('total_cost'),price=amount('price'),fees=amount('fees'),ads=amount('ads'),prCost=amount('pr_cost');
 const pr=quantityValue(form.get('pr_units')||'0',0,quantity),product=textValue(form,'product_id',120,false)||null;
 if(price===0)throw new StoreError('Enter a selling price above zero.');
 if(product&&!await db.prepare('SELECT id FROM products WHERE id=?').bind(product).first())throw new StoreError('Choose an existing product.');
 // Reject stale edits instead of silently replacing a newer saved plan.
 const revision=quantityValue(form.get('revision')||'0',0,9999999999999);
 try{await db.batch([
 db.prepare('INSERT INTO finance_requests(id,digest,actor) VALUES(?,?,?)').bind(request,digest,actor),
 db.prepare(`INSERT INTO finance_stock_plans(id,name,quantity,total_cost,price) SELECT ?,NULL,1,0,1 WHERE EXISTS(SELECT 1 FROM finance_stock_plans WHERE id=? AND updated_at<>?)`).bind(makeToken(16),id,revision),
 db.prepare(`INSERT INTO finance_stock_plans(id,name,quantity,total_cost,price,fees,ads,pr_units,pr_cost,product_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch()) ON CONFLICT(id) DO UPDATE SET name=excluded.name,quantity=excluded.quantity,total_cost=excluded.total_cost,price=excluded.price,fees=excluded.fees,ads=excluded.ads,pr_units=excluded.pr_units,pr_cost=excluded.pr_cost,product_id=excluded.product_id,updated_at=max(unixepoch(),finance_stock_plans.updated_at+1) WHERE finance_stock_plans.updated_at=?`).bind(id,name,quantity,total,price,fees,ads,pr,prCost,product,revision),
 db.prepare(`INSERT INTO finance_audit(id,actor,action,entity,detail) VALUES(?,?,'stock_plan',?,?)`).bind(request,actor,id,JSON.stringify({name,quantity,total_cost:total,price,fees,ads,pr_units:pr,pr_cost:prCost,product_id:product}))
 ]);}catch(error){
 const repeated=await db.prepare('SELECT digest FROM finance_requests WHERE id=?').bind(request).first();
 if(repeated?.digest===digest)return;
 const latest=await db.prepare('SELECT updated_at FROM finance_stock_plans WHERE id=?').bind(id).first();
 if(latest&&latest.updated_at!==revision)throw new StoreError('This stock changed since you opened it. Reload and edit again.');
 throw error;
 }
}
