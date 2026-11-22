import {ensureFinance} from './finance-schema.js';
import {makeToken,sha256} from './db.js';
import {StoreError,textValue,quantityValue,priceValue} from './http.js';
import {projectTotals} from './operations-math.js';
const ready=new WeakSet();
const schema=[
 `CREATE TABLE IF NOT EXISTS ops_stock_observations(variant_id TEXT PRIMARY KEY REFERENCES variants(id),available INTEGER NOT NULL,observed_at INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS ops_journal_scope(journal_id TEXT PRIMARY KEY REFERENCES finance_journals(id),project_id TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS ops_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,business TEXT NOT NULL,state TEXT NOT NULL,note TEXT NOT NULL DEFAULT '')`,
 `CREATE TABLE IF NOT EXISTS ops_costs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES ops_projects(id),description TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>=0),state TEXT NOT NULL CHECK(state IN('paid','unpaid','estimate','unconfirmed')),journal_id TEXT UNIQUE REFERENCES finance_journals(id),note TEXT NOT NULL DEFAULT '')`,
 `CREATE TABLE IF NOT EXISTS ops_products(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES ops_projects(id),name TEXT NOT NULL,product_id TEXT REFERENCES products(id),planned INTEGER,received INTEGER,personal INTEGER NOT NULL DEFAULT 0,samples INTEGER NOT NULL DEFAULT 0,price INTEGER,note TEXT NOT NULL DEFAULT '')`,
 `CREATE TABLE IF NOT EXISTS ops_allocations(source TEXT NOT NULL,order_id TEXT NOT NULL,line_key TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES ops_projects(id),unit_cost INTEGER,actor TEXT NOT NULL,note TEXT NOT NULL,PRIMARY KEY(source,order_id,line_key))`,
 `CREATE TABLE IF NOT EXISTS ops_movements(id TEXT PRIMARY KEY,variant_id TEXT NOT NULL REFERENCES variants(id),reason TEXT NOT NULL,quantity INTEGER NOT NULL,before_qty INTEGER NOT NULL,after_qty INTEGER NOT NULL,note TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(unixepoch()))`,
 `CREATE TABLE IF NOT EXISTS ops_receipts(digest TEXT PRIMARY KEY,actor TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(unixepoch()))`
];
export async function ensureOperations(db){if(ready.has(db))return;await ensureFinance(db);await db.batch(schema.map(s=>db.prepare(s)));ready.add(db);}
const all=async(db,s,...v)=>(await db.prepare(s).bind(...v).all()).results;
const json=(s,f=[])=>{try{return JSON.parse(s)}catch{return f}};
const key=v=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,120}$/.test(v);
const str=(v,max=500)=>typeof v==='string'&&v.length>0&&v.length<=max;
const integer=(v,nullable=false)=>nullable&&v===null||Number.isSafeInteger(v)&&v>=0&&v<=100000000;
export function validateProjectBundle(b){
 if(!b||b.version!==1||!Array.isArray(b.projects)||!Array.isArray(b.costs)||!Array.isArray(b.products)||b.projects.length>100||b.costs.length>500||b.products.length>500)throw new StoreError('Choose a valid private project file.');
 for(const [rows,valid] of [[b.projects,r=>key(r.id)&&str(r.name,120)&&str(r.business,120)&&str(r.state,40)&&typeof r.note==='string'&&r.note.length<=3000],[b.costs,r=>key(r.id)&&key(r.project_id)&&str(r.description)&&integer(r.amount)&&['paid','unpaid','estimate','unconfirmed'].includes(r.state)&&typeof r.note==='string'&&r.note.length<=3000],[b.products,r=>key(r.id)&&key(r.project_id)&&str(r.name,150)&&(r.product_id===null||key(r.product_id))&&integer(r.planned,true)&&integer(r.received,true)&&integer(r.personal)&&integer(r.samples)&&integer(r.price,true)&&typeof r.note==='string'&&r.note.length<=3000]]){
  if(!rows.every(valid)||new Set(rows.map(r=>r.id)).size!==rows.length)throw new StoreError('The project file has invalid or duplicate records.');
 }
 const projects=new Set(b.projects.map(p=>p.id));if([...b.costs,...b.products].some(r=>!projects.has(r.project_id)))throw new StoreError('Each cost and product needs its own business/stock.');
 if(b.products.some(r=>r.received!==null&&r.personal+r.samples>r.received))throw new StoreError('Personal/sample pieces cannot exceed received pieces.');
 return b;
}
export async function importProjectBundle(db,b,actor){
 validateProjectBundle(b);await ensureOperations(db);
 const digest=await sha256(JSON.stringify(b));if(await db.prepare('SELECT 1 FROM ops_receipts WHERE digest=?').bind(digest).first())return;
 // Never overwrite existing costs or inventory by repeating a private import.
 for(const [table,rows] of [['ops_projects',b.projects],['ops_costs',b.costs],['ops_products',b.products]])for(const r of rows){
  const old=await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(r.id).first();
  if(old&&Object.entries(r).some(([k,v])=>old[k]!==v))throw new StoreError('An imported record changed. Review its existing record instead of importing it twice.',409);
 }
 const changes=[];
 if(b.shopify_stock!==undefined){if(!Array.isArray(b.shopify_stock)||b.shopify_stock.length>500||!b.shopify_stock.every(r=>key(r.variant_id)&&integer(r.available)&&Number.isSafeInteger(r.observed_at)&&r.observed_at>0&&r.observed_at<=Math.floor(Date.now()/1000)+86400))throw new StoreError('Invalid source stock observations.');
 for(const r of b.shopify_stock)changes.push(db.prepare('INSERT INTO ops_stock_observations(variant_id,available,observed_at) VALUES(?,?,?) ON CONFLICT(variant_id) DO UPDATE SET available=excluded.available,observed_at=excluded.observed_at WHERE excluded.observed_at>=ops_stock_observations.observed_at').bind(r.variant_id,r.available,r.observed_at));}
 for(const r of b.projects)changes.push(db.prepare('INSERT OR IGNORE INTO ops_projects(id,name,business,state,note) VALUES(?,?,?,?,?)').bind(r.id,r.name,r.business,r.state,r.note));
 for(const r of b.costs)changes.push(db.prepare('INSERT OR IGNORE INTO ops_costs(id,project_id,description,amount,state,note) VALUES(?,?,?,?,?,?)').bind(r.id,r.project_id,r.description,r.amount,r.state,r.note));
 for(const r of b.products)changes.push(db.prepare('INSERT OR IGNORE INTO ops_products(id,project_id,name,product_id,planned,received,personal,samples,price,note) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(r.id,r.project_id,r.name,r.product_id,r.planned,r.received,r.personal,r.samples,r.price,r.note));
 changes.push(db.prepare('INSERT INTO ops_receipts(digest,actor) VALUES(?,?)').bind(digest,actor));
 changes.push(db.prepare("INSERT INTO finance_audit(id,actor,action,entity,detail) VALUES(?,?,'project_import',?,?)").bind(makeToken(16),actor,digest,JSON.stringify({projects:b.projects.length,costs:b.costs.length,physicalStockChanged:false,bankChanged:false})));
 try{await db.batch(changes);}catch(e){if(!await db.prepare('SELECT 1 FROM ops_receipts WHERE digest=?').bind(digest).first())throw e;}
}
export async function operationLines(db){
 const history=await all(db,'SELECT o.* FROM shopify_orders o WHERE NOT EXISTS(SELECT 1 FROM finance_order_links l WHERE l.shopify_source_id=o.source_id)');
 const lines=[];
 for(const o of history)for(const [i,l]of json(o.line_items).entries())lines.push({source:'shopify',order:o.source_id,reference:o.order_number,key:String(i),name:l.name||l.title||'Historical item',variant:l.variant_id||null,quantity:l.quantity,netQuantity:l.net_quantity??l.quantity,netRevenue:l.net_revenue??null,restocked:l.restocked??null,eligible:!o.cancelled_at&&o.currency==='EGP',paid:['paid','partially_refunded','refunded'].includes(o.payment.toLowerCase()),fulfilled:o.fulfillment.toLowerCase()==='fulfilled',cancelled:!!o.cancelled_at,price:l.price??null});
 for(const l of await all(db,`SELECT i.*,o.status,o.payment_status,o.payment_method FROM order_items i JOIN orders o ON o.id=i.order_id`))lines.push({source:'website',order:l.order_id,reference:'#'+l.order_id.slice(0,8),key:l.variant_id,name:l.product_title+' / '+l.variant_title,variant:l.variant_id,quantity:l.quantity,netQuantity:l.net_quantity??l.quantity,netRevenue:l.net_revenue??null,restocked:l.restocked??null,eligible:l.status!=='cancelled'&&(l.payment_method==='cod'||l.payment_status==='paid'),paid:l.payment_status==='paid',fulfilled:l.status==='delivered',cancelled:l.status==='cancelled',price:l.price});
 return lines;
}
export async function operationsReport(db){
 await ensureOperations(db);
 const [projects,costs,products,movements,allocations,lines,variants]=await Promise.all([
 all(db,'SELECT * FROM ops_projects ORDER BY business,name'),all(db,'SELECT * FROM ops_costs'),all(db,'SELECT * FROM ops_products'),all(db,'SELECT * FROM ops_movements ORDER BY created_at DESC LIMIT 100'),all(db,'SELECT * FROM ops_allocations'),operationLines(db),
 all(db,`SELECT v.*,s.available source_available,s.observed_at,p.title product,p.handle,(SELECT media_key FROM product_images WHERE product_id=p.id ORDER BY position LIMIT 1) image,t.threshold FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN ops_stock_observations s ON s.variant_id=v.id LEFT JOIN finance_thresholds t ON t.variant_id=v.id WHERE p.status<>'archived' AND v.active=1 ORDER BY p.title,v.position`)
 ]);
 const operationalReturns=await all(db,`SELECT l.variant_id,l.replacement_id,l.quantity,l.restocked,c.state FROM rma_lines l JOIN rma_cases c ON c.id=l.case_id WHERE c.state IN('received','completed')`);
 const legacyReturns=await all(db,`SELECT r.variant_id,r.replacement_id,r.quantity,coalesce(i.restocked,0) restocked,r.state FROM order_returns r LEFT JOIN finance_return_inventory i ON i.return_id=r.id WHERE r.state IN('received','completed')`);
 const gifts=await all(db,'SELECT variant_id,sum(quantity) n FROM finance_pr_gifts GROUP BY variant_id');
 for(const v of variants){const ls=lines.filter(l=>String(l.variant||'').replace('gid://shopify/ProductVariant/','')===v.id&&l.eligible);v.fulfilled=ls.filter(l=>l.fulfilled).reduce((n,l)=>n+(l.netQuantity??l.quantity),0);v.reserved=ls.filter(l=>!l.fulfilled).reduce((n,l)=>n+(l.netQuantity??l.quantity),0);v.gifts=(gifts.find(g=>g.variant_id===v.id)?.n||0)+movements.filter(m=>m.variant_id===v.id&&m.reason==='gift').reduce((n,m)=>n-m.quantity,0);v.personal=movements.filter(m=>m.variant_id===v.id&&m.reason==='personal').reduce((n,m)=>n-m.quantity,0);v.returned=[...operationalReturns,...legacyReturns].filter(r=>r.variant_id===v.id&&r.restocked).reduce((n,r)=>n+r.quantity,0);v.exchange=[...operationalReturns,...legacyReturns].filter(r=>r.replacement_id===v.id&&r.state==='completed').reduce((n,r)=>n+r.quantity,0);}
 const identity=l=>l.source+':'+l.order+':'+l.key;
 const assigned=new Map(allocations.map(a=>[a.source+':'+a.order_id+':'+a.line_key,a]));
 return {projects:projects.map(p=>({...p,...projectTotals(costs.filter(c=>c.project_id===p.id)),costs:costs.filter(c=>c.project_id===p.id),products:products.filter(r=>r.project_id===p.id),lines:lines.filter(l=>assigned.get(identity(l))?.project_id===p.id)})),costs,movements,variants,lines,allocations,unallocated:lines.filter(l=>l.eligible&&!assigned.has(identity(l)))};
}
export async function operationAction(db,form,actor){
 if(form.get('confirmed')!=='yes')throw new StoreError('Review and confirm first.');
 await ensureOperations(db);const op=form.get('op');
 if(op==='project_import'){let b;try{b=JSON.parse(textValue(form,'bundle',250000));}catch{throw new StoreError('Use valid project JSON.');}return importProjectBundle(db,b,actor);}
 const id=textValue(form,'request_id',64);if(!/^[a-f0-9]{32}$/.test(id))throw new StoreError('Reload the form.');
 const digest=await sha256(JSON.stringify([...form.entries()].sort(([a],[b])=>a.localeCompare(b))));
 const old=await db.prepare('SELECT digest FROM finance_requests WHERE id=?').bind(id).first();if(old){if(old.digest!==digest)throw new StoreError('This form was already used.');return;}
 const changes=[db.prepare('INSERT INTO finance_requests(id,digest,actor) VALUES(?,?,?)').bind(id,digest,actor)];
 if(op==='stock_adjust'){
  const variant=textValue(form,'variant_id',120),reason=textValue(form,'reason',30),note=textValue(form,'note',500),before=quantityValue(form.get('before'),0,1000000),qty=quantityValue(form.get('quantity'),1,1000000);
  const direction={received:1,personal:-1,gift:-1,damaged:-1,found:1,lost:-1}[reason];if(!direction)throw new StoreError('Choose a stock movement reason.');
  const after=before+direction*qty;if(after<0)throw new StoreError('Not enough stock.');
  // Insert asserts the optimistic baseline inside the same D1 transaction, including concurrent submissions.
  changes.push(db.prepare(`INSERT INTO ops_movements(id,variant_id,reason,quantity,before_qty,after_qty,note,actor) VALUES(?,?,?, ?, (SELECT inventory FROM variants WHERE id=? AND inventory=?),?,?,?)`).bind(id,variant,reason,direction*qty,variant,before,after,note,actor));
  changes.push(db.prepare('UPDATE variants SET inventory=? WHERE id=? AND inventory=?').bind(after,variant,before));
 }else if(op==='allocate'){
  const source=textValue(form,'source',15),order=textValue(form,'order_id',120),line=textValue(form,'line_key',120),project=textValue(form,'project_id',120),note=textValue(form,'note',500);
  const match=(await operationLines(db)).find(l=>l.source===source&&l.order===order&&l.key===line&&l.eligible);if(!match)throw new StoreError('Choose an existing accepted order line.');
  const cost=form.get('unit_cost')?priceValue(form.get('unit_cost')):null;
  changes.push(db.prepare('INSERT INTO ops_allocations(source,order_id,line_key,project_id,unit_cost,actor,note) VALUES(?,?,?,?,?,?,?)').bind(source,order,line,project,cost,actor,note));
 }else throw new StoreError('Unknown operation.');
 changes.push(db.prepare('INSERT INTO finance_audit(id,actor,action,entity,detail) VALUES(?,?,?,?,?)').bind(makeToken(16),actor,op,id,JSON.stringify({reviewed:true})));
 try{await db.batch(changes);}catch(e){const repeated=await db.prepare('SELECT digest FROM finance_requests WHERE id=?').bind(id).first();if(repeated?.digest===digest)return;throw new StoreError('The record changed or was already assigned. Reload and review before saving.',409);}
}
