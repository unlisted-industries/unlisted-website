import { makeToken } from './db.js';
import { StoreError, priceValue, textValue } from './http.js';
import { reportingRange } from './reporting.js';

const kinds = new Set(['expense','inventory_purchase','other_income','owner_draw','owner_contribution','debt_in','debt_out']);
const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo'}).format(new Date());
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new StoreError('Invalid date');
  const d = new Date(value+'T12:00:00Z');
  if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0,10)!==value || value>'9999-12-31' || value>today()) throw new StoreError('Invalid date');
  return value;
}
function choice(value, allowed) {
  if (!allowed.includes(value)) throw new StoreError('Invalid selection');
  return value;
}
export async function financeAction(db, form) {
  const op = textValue(form,'op',30);
  if(op==='transaction'){
    const kind=choice(form.get('kind'),[...kinds]);
    const category=textValue(form,'category',50);
    const account=choice(form.get('account'),['bank','cash','unallocated']);
    const drop=form.get('drop_id') || null;
    if(drop && !(await db.prepare('SELECT id FROM finance_drops WHERE id=?').bind(drop).first())) throw new StoreError('Unknown drop');
    const amount=priceValue(form.get('amount'));
    if(amount&lt;1) throw new StoreError('Amount must be positive');
    await db.prepare('INSERT INTO finance_transactions(id,occurred_on,kind,category,account,amount,drop_id,note) VALUES(?,?,?,?,?,?,?,?)')
 .bind(makeToken(16),date(form.get('occurred_on')),kind,category,account,amount,drop,textValue(form,'note',500,false)).run();
  }else if(op==='balance'){
    const account=choice(form.get('account'),['bank','cash']);
    await db.prepare('INSERT INTO finance_balance_reports(id,account,reported_on,balance,note) VALUES(?,?,?,?,?) ON CONFLICT(account,reported_on) DO UPDATE SET balance=excluded.balance,note=excluded.note,created_at=unixepoch()')
 .bind(makeToken(16),account,date(form.get('reported_on')),priceValue(form.get('balance')),textValue(form,'note',500,false)).run();
  }else if(op==='drop'){
    await db.prepare('INSERT INTO finance_drops(id,name,fixed_cost) VALUES(?,?,?)')
 .bind(makeToken(16),textValue(form,'name',80),priceValue(form.get('fixed_cost')||'0')).run();
  }else if(op==='cost'){
    const variant=textValue(form,'variant_id',120);
    if(!(await db.prepare('SELECT id FROM variants WHERE id=?').bind(variant).first())) throw new StoreError('Unknown variant');
    await db.prepare('INSERT INTO finance_variant_costs(variant_id,unit_cost) VALUES(?,?) ON CONFLICT(variant_id) DO UPDATE SET unit_cost=excluded.unit_cost,updated_at=unixepoch()')
 .bind(variant,priceValue(form.get('unit_cost'))).run();
  }else if(op==='gift'){
    const variant=textValue(form,'variant_id',120), qty=Number(form.get('quantity'));
    if(!Number.isInteger(qty)||qty&lt;1||qty&gt;100) throw new StoreError('Invalid quantity');
    const row=await db.prepare('SELECT v.inventory,c.unit_cost FROM variants v LEFT JOIN finance_variant_costs c ON c.variant_id=v.id WHERE v.id=?').bind(variant).first();
    if(!row||row.unit_cost==null||row.inventory==null||row.inventory&lt;qty) throw new StoreError('Verify inventory and enter unit cost before gifting');
    await db.prepare('INSERT INTO finance_pr_gifts(id,gifted_on,variant_id,quantity,recipient,cost_per_unit,influencer_fee,note) VALUES(?,?,?,?,?,?,?,?)')
 .bind(makeToken(16),date(form.get('gifted_on')),variant,qty,textValue(form,'recipient',100),row.unit_cost,priceValue(form.get('influencer_fee')||'0'),textValue(form,'note',500,false)).run();
  }else throw new StoreError('Unknown action');
}
async function one(db,sql,...values){return await db.prepare(sql).bind(...values).first();}
export async function financeReport(db,url){
 const range=reportingRange(url), w=range.current;
 const paid="o.payment_status='paid' AND o.status&lt;'cancelled' AND o.created_at&gt;=? AND o.created_at&lt;?";
 const [sales,stock,tx,costs,gifts,balances,variants,drops,history]=await Promise.all([
 one(db,`SELECT coalesce(sum(max(0,o.total-coalesce((SELECT sum(r.refund_amount) FROM order_returns r WHERE r.order_id=o.id AND r.kind='refund' AND r.state='completed'),0))),0) AS amount FROM orders o WHERE ${paid}`,w.start,w.end),
 one(db,`SELECT coalesce(sum(max(0,i.quantity-coalesce((SELECT sum(r.quantity) FROM order_returns r WHERE r.order_id=i.order_id AND r.variant_id=i.variant_id AND r.kind='refund' AND r.state='completed'),0))*coalesce(c.unit_cost,0)),0) AS amount, coalesce(sum(CASE WHEN c.unit_cost IS NULL THEN i.quantity ELSE 0 END),0) AS unknown FROM order_items i JOIN orders o ON o.id=i.order_id LEFT JOIN finance_variant_costs c ON c.variant_id=i.variant_id WHERE ${paid}`,w.start,w.end),
 db.prepare('SELECT kind,category,sum(amount) AS amount FROM finance_transactions WHERE occurred_on&gt;=? AND occurred_on&lt;=? GROUP BY kind,category').bind(w.startDate,w.endDate).all(),
 db.prepare('SELECT id,name,fixed_cost FROM finance_drops ORDER BY created_at DESC').all(),
 one(db,'SELECT coalesce(sum(quantity*cost_per_unit+influencer_fee),0) AS amount FROM finance_pr_gifts WHERE gifted_on&gt;=? AND gifted_on&lt;=?',w.startDate,w.endDate),
 db.prepare("SELECT account,reported_on,balance FROM finance_balance_reports WHERE id IN (SELECT id FROM finance_balance_reports b WHERE b.account=finance_balance_reports.account ORDER BY reported_on DESC,created_at DESC LIMIT 1)").all(),
 db.prepare("SELECT v.id, v.title AS variant,v.inventory,p.title AS product,c.unit_cost FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN finance_variant_costs c ON c.variant_id=v.id WHERE p.status&lt;'archived' ORDER BY p.title,v.position").all(),
 db.prepare('SELECT id,name,fixed_cost FROM finance_drops ORDER BY created_at DESC').all(),
 db.prepare('SELECT occurred_on,kind,category,account,amount,note FROM finance_transactions ORDER BY occurred_on DESC,created_at DESC LIMIT 40').all()
 ]);
 const totals=Object.fromEntries(['expense','inventory_purchase','other_income','owner_draw','owner_contribution','debt_in','debt_out'].map(k=&gt;[k,0]));
 let ads=0;
 for(const t of tx.results){totals[t.kind]=(totals[t.kind]||0)+t.amount;if(t.kind==='expense'&&t.category==='advertising')ads+=t.amount;}
 const revenue=Number(sales.amount||0),cogs=Number(stock.amount||0),pr=Number(gifts.amount||0);
 const entries=balances.results;
 return {range,revenue,cogs,uncosted:Number(stock.unknown||0),pr,totals,ads,roas:ads&gt;0?revenue/ads:null,profit:revenue+totals.other_income-cogs-totals.expense-pr,
  cash:entries.length===2?entries.reduce((a,b)=&gt;a+b.balance,0):null,balances:entries,variants:variants.results,drops:drops.results,history:history.results};
}
