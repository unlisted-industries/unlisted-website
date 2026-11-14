import { makeToken,sha256 } from './db.js';
import { StoreError,priceValue,textValue,quantityValue } from './http.js';
import { ensureFinance } from './finance-schema.js';
import { postingsFor,decimalMoney,financeDay } from './finance-math.js';
export { ensureFinance } from './finance-schema.js';
export const moneyKinds=[['expense','Operating expense'],['ad_payment','Meta bill payment (spend synced separately)'],['inventory_purchase','Paid inventory / production purchase'],['supplier_invoice','Unpaid supplier invoice (inventory)'],['supplier_payment','Supplier payment'],['other_income','Other business income'],['owner_draw','Owner withdrawal'],['owner_contribution','Owner contribution'],['debt_in','Loan received'],['debt_out','Loan principal repaid'],['transfer','Bank / cash transfer']];
export const expenseCategories=['advertising','raw materials','manufacturing','packaging','shipping','paymob fees','courier fees','influencers','salaries','rent','software','operations','other'];
export function financeDate(value) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new StoreError('Enter a valid date.');
 const d=new Date(value+'T12:00:00Z');
 if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==value||value<'2000-01-01'||value>financeDay())throw new StoreError('Choose a real date, today or earlier.');
 return value;
}
const t=(form,key,max=200,required=true)=>textValue(form,key,max,required);
const statement=(db,sql,...args)=>db.prepare(sql).bind(...args);
export function journal(db,{id=makeToken(16),source,day,kind,category='other',drop=null,note='',actor,postings,campaign=null,reversal=null}) {
 return statement(db,`INSERT INTO finance_journals(id,source,occurred_on,kind,category,drop_id,note,actor,postings,campaign_id,reversal_of) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,id,source,day,kind,category,drop,note,actor,JSON.stringify(postings),campaign,reversal);
}
export async function applyFinanceAction(db,form,actor='owner') {
 await ensureFinance(db);
 if(form.get('confirmed')!=='yes')throw new StoreError('Review and confirm before saving.');
 const op=t(form,'op',40),id=t(form,'request_id',64);
 if(!/^[a-f0-9]{32}$/.test(id))throw new StoreError('Reload this form before saving.');
 const canonical=[...form.entries()].filter(([k])=>k!=='request_id').sort(([a],[b])=>a.localeCompare(b));
 const digest=await sha256(JSON.stringify(canonical));
 const existing=await statement(db,'SELECT digest FROM finance_requests WHERE id=?',id).first();
 if(existing){if(existing.digest!==digest)throw new StoreError('This form was already used. Reload it.');return;}
 const changes=[statement(db,'INSERT INTO finance_requests(id,digest,actor) VALUES(?,?,?)',id,digest,actor)];
 const audit=(entity,detail={})=>changes.push(statement(db,'INSERT INTO finance_audit(id,actor,action,entity,detail) VALUES(?,?,?,?,?)',makeToken(16),actor,op,entity,JSON.stringify(detail)));
 if(op==='transaction') {
  const kind=t(form,'kind',40),account=t(form,'account',30),amount=priceValue(form.get('amount'));
  const drop=t(form,'drop_id',120,false)||null,category=t(form,'category',50),day=financeDate(form.get('occurred_on')),note=t(form,'note',500,false);
  if(drop&&!await statement(db,'SELECT 1 FROM finance_drops WHERE id=?',drop).first())throw new StoreError('Drop not found.');
  if(!moneyKinds.some(([x])=>x===kind))throw new StoreError('Choose a transaction type.');
  let postings;try{postings=postingsFor(kind,account,amount,form.get('to_account'));}catch(e){throw new StoreError(e.message);}
  if(['debt_out','supplier_payment'].includes(kind)) {
   const target=kind==='debt_out'?'loans':'supplier_payable';
   const balance=await statement(db,`SELECT -coalesce(sum(json_extract(p.value,'$.amount')),0) balance FROM finance_journals j,json_each(j.postings) p WHERE json_extract(p.value,'$.account')=?`,target).first('balance');
   if(amount>balance)throw new StoreError('Payment exceeds the recorded outstanding liability. Record the opening debt or invoice first.');
  }
  const duplicateReason=t(form,'duplicate_reason',300,false);
  const duplicate=await statement(db,`SELECT 1 FROM finance_journals WHERE occurred_on=? AND kind=? AND note=? AND EXISTS(SELECT 1 FROM json_each(postings) WHERE abs(json_extract(value,'$.amount'))=?)`,day,kind,note,amount).first();
  if(duplicate&&duplicateReason.length<5)throw new StoreError('A similar entry already exists. If this is separate, add a duplicate-review reason before saving.');
  changes.push(journal(db,{id,source:'manual:'+id,day,kind,category,drop,note,actor,postings,campaign:t(form,'campaign_id',120,false)||null}));audit(id,{kind,amount,duplicateReason});
 } else if(op==='balance') {
  const account=t(form,'account',15);if(!['bank','cash'].includes(account))throw new StoreError('Choose Bank or Cash.');
  const balance=decimalMoney(form.get('balance'));if(balance===null)throw new StoreError('Enter a balance in EGP.');
  const day=financeDate(form.get('reported_on')),note=t(form,'note',500,false);
  changes.push(statement(db,`INSERT INTO finance_balance_reports(id,account,reported_on,balance,note) VALUES(?,?,?,?,?) ON CONFLICT(account,reported_on) DO UPDATE SET balance=excluded.balance,note=excluded.note,created_at=unixepoch()`,id,account,day,balance,note));audit(id,{account,balance,day});
 } else if(op==='unit_cost') {
  const variant=t(form,'variant_id',120),cost=priceValue(form.get('unit_cost'));
  if(!await statement(db,'SELECT 1 FROM variants WHERE id=?',variant).first())throw new StoreError('Variant not found.');
  changes.push(statement(db,`INSERT INTO finance_variant_costs(variant_id,unit_cost) VALUES(?,?) ON CONFLICT(variant_id) DO UPDATE SET unit_cost=excluded.unit_cost,updated_at=unixepoch()`,variant,cost));
  changes.push(statement(db,'INSERT INTO finance_cost_history(id,variant_id,unit_cost,effective_at) VALUES(?,?,?,unixepoch())',id,variant,cost));audit(variant,{cost});
 } else if(op==='historical_cost') {
  const source=t(form,'source',15),order=t(form,'order_id',120),variant=t(form,'variant_key',150),cost=priceValue(form.get('unit_cost'));
  if(!['website','shopify','exchange'].includes(source))throw new StoreError('Choose an order source.');
  const valid=source==='exchange'?await statement(db,"SELECT 1 FROM order_returns WHERE order_id=? AND replacement_id=? AND kind='exchange'",order,variant).first():source==='website'?await statement(db,'SELECT 1 FROM order_items WHERE order_id=? AND variant_id=?',order,variant).first():await statement(db,'SELECT 1 FROM shopify_orders WHERE source_id=?',order).first();
  if(!valid)throw new StoreError('Order item not found.');
  if(source==='exchange')changes.push(statement(db,`UPDATE finance_exchange_costs SET unit_cost=? WHERE return_id IN(SELECT id FROM order_returns WHERE order_id=? AND replacement_id=?)`,cost,order,variant));
  changes.push(statement(db,`INSERT INTO finance_historical_costs(source,order_id,variant_key,unit_cost,actor) VALUES(?,?,?,?,?) ON CONFLICT(source,order_id,variant_key) DO UPDATE SET unit_cost=excluded.unit_cost,actor=excluded.actor`,source,order,variant,cost,actor));audit(order,{source,variant,cost});
 } else if(op==='drop') {
  changes.push(statement(db,'INSERT INTO finance_drops(id,name,fixed_cost) VALUES(?,?,?)',id,t(form,'name',80),priceValue(form.get('fixed_cost')||'0')));audit(id);
 } else if(op==='assign_drop') {
  const drop=t(form,'drop_id',120),product=t(form,'product_id',120);
  if(!await statement(db,'SELECT 1 FROM finance_drops WHERE id=?',drop).first())throw new StoreError('Drop not found.');
  changes.push(statement(db,`INSERT INTO finance_drop_products(product_id,drop_id) VALUES(?,?) ON CONFLICT(product_id) DO UPDATE SET drop_id=excluded.drop_id`,product,drop));audit(product,{drop});
 } else if(op==='threshold') {
  const variant=t(form,'variant_id',120),threshold=quantityValue(form.get('threshold'),0,1000000),target=quantityValue(form.get('target'),1,1000000);
  if(target<=threshold)throw new StoreError('Restock target must exceed the threshold.');
  changes.push(statement(db,`INSERT INTO finance_thresholds VALUES(?,?,?) ON CONFLICT(variant_id) DO UPDATE SET threshold=excluded.threshold,target=excluded.target`,variant,threshold,target));audit(variant,{threshold,target});
 } else if(op==='gift') {
  const variant=t(form,'variant_id',120),quantity=quantityValue(form.get('quantity'),1,100),day=financeDate(form.get('gifted_on'));
  const row=await statement(db,'SELECT inventory,unit_cost,d.drop_id FROM variants LEFT JOIN finance_variant_costs ON variant_id=variants.id LEFT JOIN finance_drop_products d ON d.product_id=variants.product_id WHERE variants.id=?',variant).first();
  if(!row||row.unit_cost==null||row.inventory==null||row.inventory<quantity)throw new StoreError('PR gifts need sufficient verified stock and a unit cost.');
  const fee=priceValue(form.get('influencer_fee')||'0'),shipping=priceValue(form.get('shipping')||'0'),account=t(form,'account',15);
  if(!['bank','cash','unallocated'].includes(account))throw new StoreError('Choose a payment account.');
  const cost=row.unit_cost*quantity,total=fee+shipping;
  const postings=[...(cost?[{account:'pr_expense',amount:cost},{account:'inventory',amount:-cost}]:[]),...(total?[{account:'pr_expense',amount:total},{account,amount:-total}]:[])];
  const note=t(form,'note',500,false);
  changes.push(statement(db,`INSERT INTO finance_pr_gifts(id,gifted_on,variant_id,quantity,recipient,cost_per_unit,influencer_fee,note) VALUES(?,?,?,?,?,?,?,?)`,id,day,variant,quantity,t(form,'recipient',100),row.unit_cost,fee,note));
  if(postings.length)changes.push(journal(db,{id,source:'gift:'+id,day,kind:'pr_gift',category:'influencers',actor,note,drop:row.drop_id,campaign:t(form,'campaign_id',120,false)||null,postings}));
  changes.push(statement(db,'INSERT INTO finance_pr_details(gift_id,shipping,campaign_id,journal_id) VALUES(?,?,?,?)',id,shipping,t(form,'campaign_id',120,false),postings.length?id:null));audit(id,{quantity,cost,fee,shipping});
 } else if(op==='batch') {
  const components={};for(const key of ['raw_materials','manufacturing','packaging','freight','overhead'])components[key]=priceValue(form.get(key)||'0');
  const cost=Object.values(components).reduce((a,b)=>a+b,0);if(cost<=0)throw new StoreError('Enter the production costs.');
  changes.push(statement(db,'INSERT INTO finance_batches(id,drop_id,variant_id,name,quantity,cost,components) VALUES(?,?,?,?,?,?,?)',id,t(form,'drop_id',120),t(form,'variant_id',120),t(form,'name',120),quantityValue(form.get('quantity'),1,1000000),cost,JSON.stringify(components)));audit(id,{cost});
 } else if(op==='receive_batch') {
  const batchId=t(form,'batch_id',120),row=await statement(db,'SELECT * FROM finance_batches WHERE id=?',batchId).first();
  if(!row||row.state!=='planned')throw new StoreError('Batch is already received or unavailable.');
  const day=financeDate(form.get('occurred_on')),v=await statement(db,'SELECT inventory,unit_cost FROM variants LEFT JOIN finance_variant_costs ON variant_id=variants.id WHERE variants.id=?',row.variant_id).first();
  if(v.inventory==null||v.inventory>0&&v.unit_cost==null)throw new StoreError('Set verified starting inventory and its cost first.');
  const cost=Math.round(((v.inventory||0)*(v.unit_cost||0)+row.cost)/(v.inventory+row.quantity));
  changes.push(statement(db,`UPDATE finance_batches SET state='received',received_on=? WHERE id=? AND state='planned' RETURNING id`,day,batchId));
  // A DB trigger is intentionally unnecessary: request uniqueness makes this entire batch atomic.
  changes.push(statement(db,`INSERT INTO finance_variant_costs(variant_id,unit_cost,updated_at)
    SELECT v.id,cast(round((v.inventory*coalesce(c.unit_cost,0)+?)*1.0/(v.inventory+?)) AS INTEGER),unixepoch()
    FROM variants v LEFT JOIN finance_variant_costs c ON c.variant_id=v.id WHERE v.id=?
    ON CONFLICT(variant_id) DO UPDATE SET unit_cost=excluded.unit_cost,updated_at=unixepoch()`,row.cost,row.quantity,row.variant_id));
  changes.push(statement(db,'UPDATE variants SET inventory=inventory+? WHERE id=?',row.quantity,row.variant_id));
  changes.push(statement(db,'INSERT INTO finance_cost_history(id,variant_id,unit_cost,effective_at) SELECT ?,variant_id,unit_cost,unixepoch() FROM finance_variant_costs WHERE variant_id=?',id,row.variant_id));
  // Receiving a batch posts an unpaid invoice; payment is a separate supplier payment.
  changes.push(journal(db,{id,source:'batch:'+batchId,day,kind:'supplier_invoice',drop:row.drop_id,note:row.name,actor,postings:postingsFor('supplier_invoice','unallocated',row.cost)}));audit(batchId,{batchCost:row.cost,method:'weighted_average'});
 } else if(op==='reverse') {
  const row=await statement(db,'SELECT * FROM finance_journals WHERE id=?',t(form,'journal_id',120)).first();
  if(!row||row.reversal_of||row.kind==='pr_gift'||row.source.startsWith('batch:'))throw new StoreError('This journal requires an operational correction, not a financial-only reversal.');
  changes.push(journal(db,{id,source:'reverse:'+row.id,day:financeDate(form.get('occurred_on')),kind:'reversal',category:row.category,drop:row.drop_id,note:t(form,'note',500),actor,postings:JSON.parse(row.postings).map(p=>({...p,amount:-p.amount})),reversal:row.id}));audit(row.id);
 } else if(op==='settings') {
  changes.push(statement(db,'UPDATE finance_settings SET daily_reminder=?,email_reminder=?,reserve=?,runway_days=?,updated_at=unixepoch() WHERE id=1',Number(form.get('daily_reminder')==='on'),Number(form.get('email_reminder')==='on'),priceValue(form.get('reserve')||'0'),quantityValue(form.get('runway_days'),1,365)));audit('settings');
 } else if(op==='attribute') {
  const source=t(form,'source',15),order=t(form,'order_id',120);if(!['website','shopify'].includes(source))throw new StoreError('Choose a source.');
  if(!await statement(db,source==='website'?'SELECT 1 FROM orders WHERE id=?':'SELECT 1 FROM shopify_orders WHERE source_id=?',order).first())throw new StoreError('Order not found.');
  changes.push(statement(db,`INSERT INTO finance_order_attribution VALUES(?,?,?) ON CONFLICT(source,order_id) DO UPDATE SET campaign_id=excluded.campaign_id`,source,order,t(form,'campaign_id',120)));audit(order,{source});
 } else if(op==='link_order') {
  changes.push(statement(db,'INSERT INTO finance_order_links VALUES(?,?)',t(form,'website_order_id',120),t(form,'shopify_source_id',120)));audit(id);
 } else if(op==='dismiss') {
  changes.push(statement(db,"UPDATE finance_notifications SET state='read' WHERE id=?",t(form,'notification_id',120)));audit(id);
 } else throw new StoreError('Unknown finance operation.');
 try{await db.batch(changes);}catch(e){if(/UNIQUE|constraint/i.test(String(e)))throw new StoreError('This record was already saved, conflicts with another entry, or has invalid references. Reload to review.',409);throw e;}
}
