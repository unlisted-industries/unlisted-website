import { ensureOperations } from './operations.js';
import { ensureRma } from './rma.js';
import { ensureFinance,journal } from './finance.js';
import { reportingRange } from './reporting.js';
import { decimalMoney,scenario } from './finance-math.js';
import { makeToken } from './db.js';
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const dayOf=seconds=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo'}).format(new Date(seconds*1000));
const sum=a=>a.reduce((x,y)=>x+y,0);
const safeJson=(s,fallback=[])=>{try{return JSON.parse(s)}catch{return fallback}};
export async function snapshotCosts(db) {
 await db.prepare(`INSERT OR IGNORE INTO finance_order_costs(order_id,variant_id,unit_cost,drop_id)
 SELECT i.order_id,i.variant_id,(SELECT unit_cost FROM finance_cost_history h WHERE h.variant_id=i.variant_id AND h.effective_at<=o.created_at ORDER BY effective_at DESC,created_at DESC LIMIT 1),d.drop_id
 FROM order_items i JOIN orders o ON o.id=i.order_id JOIN variants v ON v.id=i.variant_id LEFT JOIN finance_drop_products d ON d.product_id=v.product_id`).run();
 // Preserve phase-one journal meaning without duplicating it on each report request.
 const legacy=await all(db,`SELECT t.* FROM finance_transactions t WHERE NOT EXISTS(SELECT 1 FROM finance_journals j WHERE j.source='legacy:'||t.id)`);
 const {postingsFor}=await import('./finance-math.js');
 if(legacy.length)await db.batch(legacy.map(t=>journal(db,{source:'legacy:'+t.id,day:t.occurred_on,kind:t.kind,category:t.category,drop:t.drop_id,note:t.note,actor:'legacy import',postings:postingsFor(t.kind,t.account,t.amount)})));
}
export async function financeReport(db,url) {
 await ensureRma(db);await ensureOperations(db);await snapshotCosts(db);
 const reportUrl=new URL(url);if(!reportUrl.searchParams.has('days')&&!reportUrl.searchParams.has('start'))reportUrl.searchParams.set('days','all');
 const range=reportingRange(reportUrl);
 const [journals,balances,variants,drops,products,orders,items,returns,history,historyDetails,historicalCosts,attribution,links,prGifts,batches,notifications,settings,meta,audit,imports]=await Promise.all([
 all(db,`SELECT j.* FROM finance_journals j WHERE NOT EXISTS(SELECT 1 FROM ops_journal_scope s JOIN ops_projects p ON p.id=s.project_id WHERE s.journal_id=j.id AND upper(p.business)<>'UNLISTED') ORDER BY occurred_on DESC,created_at DESC`),
 all(db,`SELECT a.account,b.balance,b.reported_on,b.created_at FROM (SELECT 'bank' account UNION ALL SELECT 'cash') a LEFT JOIN finance_balance_reports b ON b.id=(SELECT id FROM finance_balance_reports WHERE account=a.account ORDER BY reported_on DESC,created_at DESC LIMIT 1)`),
 all(db,`SELECT v.*,p.title product,c.unit_cost,d.drop_id,t.threshold,t.target FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN finance_variant_costs c ON c.variant_id=v.id LEFT JOIN finance_drop_products d ON d.product_id=p.id LEFT JOIN finance_thresholds t ON t.variant_id=v.id WHERE p.status<>'archived' ORDER BY p.title,v.position`),
 all(db,'SELECT * FROM finance_drops ORDER BY created_at DESC'),all(db,"SELECT id,title FROM products WHERE status<>'archived' ORDER BY title"),
 all(db,`SELECT o.*,d.delivered_at,coalesce((SELECT min(created_at) FROM payment_events WHERE order_id=o.id AND state='captured'),(SELECT paid_at FROM finance_payment_dates WHERE order_id=o.id)) paid_at FROM orders o LEFT JOIN order_deliveries d ON d.order_id=o.id`),
 all(db,`SELECT i.*,v.product_id,coalesce(h.unit_cost,c.unit_cost) unit_cost,c.drop_id FROM order_items i JOIN variants v ON v.id=i.variant_id LEFT JOIN finance_order_costs c ON c.order_id=i.order_id AND c.variant_id=i.variant_id LEFT JOIN finance_historical_costs h ON h.source='website' AND h.order_id=i.order_id AND h.variant_key=i.variant_id`),
 all(db,`SELECT r.*,s.restocked,s.occurred_at restocked_at,x.unit_cost replacement_cost,x.drop_id replacement_drop FROM order_returns r LEFT JOIN finance_return_inventory s ON s.return_id=r.id LEFT JOIN finance_exchange_costs x ON x.return_id=r.id WHERE r.state IN('received','completed')`),
 all(db,'SELECT * FROM shopify_orders'),all(db,'SELECT * FROM shopify_order_details'),all(db,'SELECT * FROM finance_historical_costs'),all(db,'SELECT * FROM finance_order_attribution'),all(db,'SELECT * FROM finance_order_links'),
 all(db,`SELECT g.*,d.shipping,d.campaign_id,v.product_id,p.title product,v.title variant FROM finance_pr_gifts g JOIN variants v ON v.id=g.variant_id JOIN products p ON p.id=v.product_id LEFT JOIN finance_pr_details d ON d.gift_id=g.id ORDER BY gifted_on DESC`),
 all(db,`SELECT b.*,v.title variant,p.title product FROM finance_batches b JOIN variants v ON v.id=b.variant_id JOIN products p ON p.id=v.product_id ORDER BY created_at DESC`),
 all(db,"SELECT * FROM finance_notifications WHERE state='active' ORDER BY created_at DESC LIMIT 30"),
 db.prepare('SELECT * FROM finance_settings WHERE id=1').first(),all(db,'SELECT * FROM finance_meta_daily'),all(db,'SELECT * FROM finance_audit ORDER BY created_at DESC LIMIT 30'),all(db,'SELECT * FROM finance_imports ORDER BY created_at DESC LIMIT 15')]);
 const attr=new Map(attribution.map(a=>[a.source+':'+a.order_id,a.campaign_id]));
 const excluded=new Set(links.map(x=>x.shopify_source_id));
 const events=[],warnings=new Set(),missingCosts=[];
 const orderItems=new Map();for(const i of items){if(!orderItems.has(i.order_id))orderItems.set(i.order_id,[]);orderItems.get(i.order_id).push(i);}
 let uncollected=0,customerLiability=0,clearing=0;
 const add=(type,amount,day,extra={})=>events.push({type,amount,day,...extra});
 for(const order of orders) {
  const campaign=attr.get('website:'+order.id)||null,rows=orderItems.get(order.id)||[];
  const refs=returns.filter(r=>r.order_id===order.id&&r.kind==='refund'&&r.state==='completed');
  const refunded=sum(refs.map(r=>r.refund_amount));
  const paid=['paid','refunded'].includes(order.payment_status);
  if(paid)clearing+=Math.max(0,order.total-refunded);
  if(order.status!=='cancelled'&&!paid)uncollected+=order.total;
  if(paid&&order.status!=='delivered')customerLiability+=Math.max(0,order.total-refunded);
  // Collection date is exact for signed Paymob capture. COD has no original collection timestamp.
  const paidDay=order.paid_at?dayOf(order.paid_at):dayOf(order.updated_at);
  if(paid){add(order.status==='cancelled'?'customer_refund_cash':'collected',order.total,paidDay,{campaign,source:'website',order:order.id});if(!order.paid_at)warnings.add('COD/manual payment dates use the recorded order update time; courier settlement still requires reconciliation.');}
  for(const r of refs)add(order.status==='cancelled'?'customer_refund_cash':'collected',-r.refund_amount,dayOf(r.updated_at),{campaign,source:'website',order:order.id});
  if(order.status!=='delivered')continue;
  const saleDay=dayOf(order.delivered_at||order.updated_at);
  if(!order.delivered_at)warnings.add('Some delivery dates use the recorded order update time because original delivery timestamps are unavailable.');
  add('revenue',order.total,saleDay,{campaign,source:'website',order:order.id,units:sum(rows.map(i=>i.quantity)),product:null});
  for(const i of rows) {
   const share=order.subtotal>0?(i.price*i.quantity)/order.subtotal:0;
   add('product_revenue',Math.round((order.subtotal-order.discount)*share),saleDay,{product:i.product_id,drop:i.drop_id,campaign});
   if(i.unit_cost==null){missingCosts.push({source:'website',order_id:order.id,variant_key:i.variant_id,label:i.product_title+' / '+i.variant_title,quantity:i.quantity,day:saleDay});}
   else add('cogs',i.unit_cost*i.quantity,saleDay,{product:i.product_id,drop:i.drop_id,campaign,units:i.quantity});
  }
  for(const r of refs){add('revenue',-r.refund_amount,dayOf(r.updated_at),{campaign,source:'website',order:order.id});const i=rows.find(i=>i.variant_id===r.variant_id);if(i){const discountedPrice=order.subtotal>0?i.price*(order.subtotal-order.discount)/order.subtotal:i.price;add('product_revenue',-Math.min(r.refund_amount,Math.round(discountedPrice*r.quantity)),dayOf(r.updated_at),{product:i.product_id,drop:i.drop_id,campaign});}}
  for(const r of returns.filter(r=>r.order_id===order.id)) {
   const i=rows.find(x=>x.variant_id===r.variant_id);if(!i)continue;
   if(r.restocked===1&&i.unit_cost!=null)add('cogs',-i.unit_cost*r.quantity,dayOf(r.restocked_at||r.updated_at),{product:i.product_id,drop:i.drop_id,campaign});
   if(r.restocked==null)warnings.add('Historical returned-stock condition is unknown; COGS is not reversed until restocking evidence is recorded.');
   if(r.kind==='exchange'&&r.state==='completed') {
    if(r.replacement_cost==null)missingCosts.push({source:'exchange',order_id:r.order_id,variant_key:r.replacement_id,label:'Replacement cost missing',quantity:r.quantity,day:dayOf(r.updated_at)});else add('cogs',r.quantity*r.replacement_cost,dayOf(r.updated_at),{drop:r.replacement_drop,campaign});
   }
  }
 }
 const detail=new Map(historyDetails.map(d=>[d.source_id,safeJson(d.data,{})]));
 for(const o of history) {
  if(excluded.has(o.source_id))continue;
  if(o.currency!=='EGP'){warnings.add('Non-EGP historical orders are excluded until verified conversion rates are supplied.');continue;}
  const amount=decimalMoney(o.amount);if(amount==null){warnings.add('Some historical order amounts need review.');continue;}
  const rawDetail=detail.get(o.source_id)||{},d=rawDetail.header||rawDetail,campaign=attr.get('shopify:'+o.source_id)||null;
  const refund=decimalMoney(d['Refunded Amount']||'0');
  const paid=['paid','partially_refunded','refunded'].includes(o.payment.toLowerCase());
  const net=Math.max(0,amount-(refund||0));
  if(o.payment==='refunded'&&refund===0){warnings.add('Fully refunded historical orders without a refund amount are excluded from net sales.');continue;}
  if(paid&&!o.cancelled_at)add('collected',net,dayOf(o.created_at),{source:'shopify',order:o.source_id,campaign});
  else if(!o.cancelled_at)uncollected+=net;
  if(o.cancelled_at)continue;
  // Shopify's fulfillment field is evidence of fulfillment, not courier delivery.
  if(o.fulfillment.toLowerCase()!=='fulfilled'){if(paid)customerLiability+=net;continue;}
  warnings.add('Historical Shopify revenue uses fulfillment/order dates; delivery and settlement dates must be reconciled from source evidence.');
  add('revenue',net,dayOf(o.created_at),{source:'shopify',order:o.source_id,campaign});
  const historicalItems=safeJson(o.line_items);
  for(const [index,item] of historicalItems.entries()) {
   const legacyKey=String(item.sku||item.variant_id||index),key=String(index)+':'+legacyKey,q=Number(item.quantity||1);
   const unambiguousLegacy=historicalItems.filter((other,n)=>String(other.sku||other.variant_id||n)===legacyKey).length===1;
   const cost=historicalCosts.find(c=>c.source==='shopify'&&c.order_id===o.source_id&&c.variant_key===key)||
    (unambiguousLegacy?historicalCosts.find(c=>c.source==='shopify'&&c.order_id===o.source_id&&c.variant_key===legacyKey):null);
   if(cost)add('cogs',cost.unit_cost*q,dayOf(o.created_at),{campaign});
   else missingCosts.push({source:'shopify',order_id:o.source_id,variant_key:key,label:item.name||item.title||key,quantity:q,day:dayOf(o.created_at)});
  }
  if(refund>0)warnings.add('Historical refunds are netted against original Shopify order dates when separate refund timestamps are unavailable.');
 }
 // RMA adjustments are event-backed, never duplicate original orders or sale journals.
 const rmaCases=await all(db,"SELECT * FROM rma_cases WHERE state IN('received','completed')");
 const rmaLines=await all(db,'SELECT l.*,v.product_id FROM rma_lines l LEFT JOIN variants v ON v.id=l.variant_id');
 const rmaLedger=await all(db,'SELECT * FROM rma_ledger');
 const rmaShipping=await all(db,'SELECT * FROM rma_shipments WHERE cost>0');
 const creditUses=await all(db,`SELECT u.*,o.status,o.created_at,coalesce(d.delivered_at,o.updated_at) delivered_at FROM rma_credit_uses u JOIN orders o ON o.id=u.order_id LEFT JOIN order_deliveries d ON d.order_id=o.id WHERE u.released=0`);
 for(const use of creditUses)if(use.status==='delivered')add('revenue',use.amount,dayOf(use.delivered_at),{source:'credit_redemption',order:use.order_id});
 for(const c of rmaCases) {
  const source=c.source_key.startsWith('website:')?'website':'shopify',order=c.source_key.slice(8),campaign=attr.get(source+':'+order)||null;
  const rows=rmaLines.filter(l=>l.case_id===c.id),records=rmaLedger.filter(l=>l.case_id===c.id);
  const receipt=await db.prepare("SELECT created_at FROM rma_events WHERE case_id=? AND action='received' ORDER BY created_at LIMIT 1").bind(c.id).first('created_at');
  for(const l of rows)if(l.restocked) {
   if(l.unit_cost==null)warnings.add('Some returned items have no verified original sold cost; COGS reversal awaits evidence.');
   else add('cogs',-l.unit_cost*l.quantity,dayOf(receipt||c.updated_at),{product:l.product_id,campaign});
  }
  for(const entry of records) {
   if(entry.kind==='difference') {add('collected',entry.amount,dayOf(entry.created_at),{source,order,campaign});clearing+=entry.amount;continue;}
   if(!['refund','credit','exchange'].includes(entry.kind))continue;
   add('revenue',entry.amount,dayOf(entry.created_at),{source,order,campaign});
   if(entry.kind==='refund'){add('collected',entry.amount,dayOf(entry.created_at),{source,order,campaign});clearing+=entry.amount;}
   if(entry.kind==='exchange') {
    if(!records.some(r=>r.kind==='difference')){add('collected',entry.amount,dayOf(entry.created_at),{source,order,campaign});clearing+=entry.amount;}
    for(const l of rows)if(l.replacement_cost==null)missingCosts.push({source:'exchange',order_id:c.id,variant_key:l.replacement_id,label:l.replacement_title,quantity:l.quantity,day:dayOf(entry.created_at)});else add('cogs',l.replacement_cost*l.quantity,dayOf(entry.created_at),{campaign});
   }else for(const l of rows)add('product_revenue',-l.value,dayOf(entry.created_at),{product:l.product_id,campaign});
  }
 }
 for(const s of rmaShipping)add('expense',s.cost,dayOf(s.created_at),{category:'shipping',source:'returns',order:s.case_id});
 const storeCreditLiability=await db.prepare('SELECT coalesce(sum(balance),0) amount FROM rma_credit').first('amount');
 customerLiability+=storeCreditLiability;
 for(const j of journals)for(const p of safeJson(j.postings)) {
  const type={expense:'expense',pr_expense:'pr',revenue:'other_income'}[p.account];
  if(type)add(type,type==='other_income'?-p.amount:p.amount,j.occurred_on,{category:j.category,drop:j.drop_id,campaign:j.campaign_id});
 }
 // Phase-one gifts predate the journal; carry their expenses forward once.
 for(const gift of prGifts)if(!journals.some(j=>j.source==='gift:'+gift.id))add('pr',gift.quantity*gift.cost_per_unit+gift.influencer_fee+(gift.shipping||0),gift.gifted_on);
 const scoped=e=>!url.searchParams.get('drop')||e.drop===url.searchParams.get('drop');
 const aggregate=window=>{
  const selected=events.filter(e=>e.day>=window.startDate&&e.day<=window.endDate&&scoped(e));
  const total=type=>sum(selected.filter(e=>e.type===type).map(e=>e.amount));
  const inPeriod=j=>j.occurred_on>=window.startDate&&j.occurred_on<=window.endDate;
  const manualAds=sum(selected.filter(e=>e.type==='expense'&&e.category==='advertising').map(e=>e.amount));
  const adData=meta.filter(m=>m.day>=window.startDate&&m.day<=window.endDate),metaSpend=sum(adData.map(m=>m.spend));
  if(metaSpend>0&&manualAds>0)warnings.add('Manual advertising expenses overlap Meta data. Confirm whether they are separate advertising costs; Meta bill payments must use the ad_payment type to prevent double counting.');
  const expenses=total('expense')+metaSpend;
  const revenue=total('revenue'),cogs=total('cogs'),pr=total('pr'),otherIncome=total('other_income');
  const missing=missingCosts.filter(m=>m.day>=window.startDate&&m.day<=window.endDate);
  const collected=total('collected'),fees=sum(selected.filter(e=>e.type==='expense'&&['paymob fees','courier fees','shipping'].includes(e.category)).map(e=>e.amount)),advertising=metaSpend+manualAds;
  return {revenue,cogs,expenses,pr,otherIncome,collected,advertising,grossProfit:revenue-cogs,profit:revenue+otherIncome-cogs-expenses-pr,profitReliable:missing.length===0&&warnings.size===0,uncostedUnits:sum(missing.map(m=>m.quantity)),missingCosts:missing,roas:advertising>0?(collected-fees)/advertising:null,metaSpend,manualAds,journals:journals.filter(inPeriod),events:selected};
 };
 const current=aggregate(range.current),previous=range.previous?aggregate(range.previous):null;
 const ledger={};for(const j of journals)for(const p of safeJson(j.postings))ledger[p.account]=(ledger[p.account]||0)+p.amount;
 const cashComplete=balances.every(b=>b.balance!==null),reported=cashComplete?sum(balances.map(b=>b.balance)):null;
 const latestCash=reported===null?null:sum(balances.map(b=>Number(b.balance)+sum(journals.filter(j=>j.created_at>b.created_at&&j.occurred_on>=b.reported_on).flatMap(j=>safeJson(j.postings).filter(p=>p.account===b.account).map(p=>p.amount)))));
 const metaPayable=Math.max(0,sum(meta.map(m=>m.spend))-(ledger.ad_clearing||0));
 const liability=metaPayable+Math.max(0,-(ledger.loans||0))+Math.max(0,-(ledger.supplier_payable||0))+customerLiability;
 const missingInventory=variants.filter(v=>v.inventory===null||v.inventory>0&&v.unit_cost==null);
 const inventoryValue=missingInventory.length?null:sum(variants.map(v=>(v.inventory||0)*(v.unit_cost||0)));
 const remainingStock=sum(variants.map(v=>v.inventory||0));
 const dailyBurn=Math.max(0,(current.expenses+current.pr)/range.days),reserve=settings.reserve+liability;
 const freshBalances=balances.every(b=>b.reported_on===range.today);
 const safeSpending=latestCash===null||!freshBalances?null:Math.max(0,latestCash-reserve-dailyBurn*settings.runway_days);
 const runway=latestCash===null||!freshBalances||dailyBurn<=0?null:Math.max(0,(latestCash-liability)/dailyBurn);
 const lowStock=variants.filter(v=>v.threshold!==null&&v.inventory!==null&&v.inventory<=v.threshold);
 const staleBalances=balances.some(b=>b.reported_on!==range.today);
 const dataScore=Math.max(0,100-(missingCosts.length?25:0)-(missingInventory.length?15:0)-(cashComplete?0:30)-(staleBalances?10:0)-(warnings.size?20:0));
 const recommendations=[];
 if(!cashComplete||staleBalances)recommendations.push('Submit current bank and cash balances before approving new spending.');
 if(missingCosts.length)recommendations.push('Confirm original costs for historical orders; current manufacturing prices cannot establish old profit.');
 if(lowStock.length)recommendations.push('Restock '+lowStock.map(v=>v.product+' '+v.title+' ('+Math.max(0,v.target-v.inventory)+' units)').join(', ')+'.');
 if(current.profit<0)recommendations.push('Recorded costs exceed recognized revenue in this period. Review contribution margins and advertising before expansion.');
 if(safeSpending===0)recommendations.push('No uncommitted spending is available after recorded liabilities and the cash buffer.');
 if(!meta.length)recommendations.push('Connect the Meta read-only API to replace manual ad spending with verified campaign results.');
 const dropReports=drops.map(d=>{
  const vs=variants.filter(v=>v.drop_id===d.id),es=events.filter(e=>e.drop===d.id&&e.day>=range.current.startDate&&e.day<=range.current.endDate);
  const revenue=sum(es.filter(e=>e.type==='product_revenue').map(e=>e.amount)),cogs=sum(es.filter(e=>e.type==='cogs').map(e=>e.amount));
  const expense=sum(es.filter(e=>['expense','pr'].includes(e.type)).map(e=>e.amount));
  const valid=vs.length&&vs.every(v=>v.unit_cost!==null&&v.inventory!==null),units=sum(vs.map(v=>v.inventory||0));
  const avgPrice=units>0?sum(vs.map(v=>v.price*v.inventory))/units:vs.length?sum(vs.map(v=>v.price))/vs.length:0,avgCost=valid?(units>0?sum(vs.map(v=>v.unit_cost*v.inventory))/units:sum(vs.map(v=>v.unit_cost))/vs.length):0;
  const model=valid?scenario({price:avgPrice,unitCost:avgCost,variableCost:0,fixedCost:d.fixed_cost,units}):null;
  return {...d,revenue,cogs,expense,profit:revenue-cogs-expense,remainingStock:units,potentialProfit:model?.profit??null,breakEvenUnits:model?.breakEvenUnits??null,unallocatedFees:true};
 });
 const campaigns=[...new Set([...meta.map(m=>m.campaign_id),...attribution.map(a=>a.campaign_id),...prGifts.map(g=>g.campaign_id).filter(Boolean)])].map(id=>{
  const ms=meta.filter(m=>m.campaign_id===id&&m.day>=range.current.startDate&&m.day<=range.current.endDate),es=events.filter(e=>e.campaign===id&&e.day>=range.current.startDate&&e.day<=range.current.endDate);
  const spend=sum(ms.map(m=>m.spend)),purchases=sum(ms.map(m=>m.purchases)),platformRevenue=sum(ms.map(m=>m.purchase_value)),collected=sum(es.filter(e=>e.type==='collected').map(e=>e.amount)),revenue=sum(es.filter(e=>e.type==='revenue').map(e=>e.amount)),cogs=sum(es.filter(e=>e.type==='cogs').map(e=>e.amount));
  const linkedFees=sum(es.filter(e=>e.type==='expense').map(e=>e.amount));
  const prCost=sum(prGifts.filter(g=>g.campaign_id===id&&g.gifted_on>=range.current.startDate&&g.gifted_on<=range.current.endDate).map(g=>g.quantity*g.cost_per_unit+g.influencer_fee+(g.shipping||0)));
  const profit=revenue-cogs-spend-prCost-linkedFees,investment=spend+prCost,contribution=revenue-cogs-linkedFees-prCost;
  return {id,name:ms[0]?.campaign_name||id,spend,purchases,platformRevenue,collected,revenue,cogs,prCost,linkedFees,roas:spend?(collected-linkedFees)/spend:null,platformRoas:spend?platformRevenue/spend:null,cpa:purchases?spend/purchases:null,profit,roi:investment>0?profit/investment:null,breakEvenRoas:contribution>0?revenue/contribution:null};
 });
 const productReports=products.map(p=>{const es=current.events.filter(e=>e.product===p.id),revenue=sum(es.filter(e=>e.type==='product_revenue').map(e=>e.amount)),cogs=sum(es.filter(e=>e.type==='cogs').map(e=>e.amount));return {...p,revenue,cogs,contribution:revenue-cogs};});
 const trend=[];for(let offset=0;offset<Math.min(range.days,366);offset++){const date=new Date(range.current.endDate+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-Math.min(range.days,366)+1+offset);const day=date.toISOString().slice(0,10);trend.push({day,revenue:sum(events.filter(e=>e.day===day&&e.type==='revenue').map(e=>e.amount)),expenses:sum(events.filter(e=>e.day===day&&['expense','pr','cogs'].includes(e.type)).map(e=>e.amount))+sum(meta.filter(m=>m.day===day).map(m=>m.spend))});}
 const safeAdvertisingBudget=safeSpending===null||!current.profitReliable?null:Math.max(0,Math.min(safeSpending,current.revenue-current.cogs-(current.expenses-current.advertising)-current.pr));
 return {...current,safeAdvertisingBudget,range,previous,journals:journals.slice(0,40),balances,variants,drops,products,prGifts,batches,notifications,settings,meta,audit,imports,dropReports,productReports,campaigns,trend,missingCosts,warnings:[...warnings],cashReported:reported,cashEstimated:latestCash,cashComplete,staleBalances,liabilities:liability,customerLiability,uncollected,clearing,inventoryValue,remainingStock,safeSpending,runway,dataScore,recommendations,lowStock,ledger};
}
