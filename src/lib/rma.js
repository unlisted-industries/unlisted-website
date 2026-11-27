import migration from '../../migrations/0014_returns_workspace.sql?raw';
import { orderNo } from './order-number.js';
import { all,isToken,makeToken,sha256,statements,unixNow } from './db.js';
import { ensureFinance,splitFinanceSql } from './finance-schema.js';
import { historicalOrder } from './order-history.js';
import { StoreError,textValue,quantityValue,priceValue } from './http.js';
import { allocate,portion,eligibility,reasons,rmaStates } from './rma-math.js';
import { sendEmail } from './auth.js';
const ready=new WeakSet();
export async function ensureRma(db) {if(ready.has(db))return;await ensureFinance(db);await db.batch(splitFinanceSql(migration).map(s=>db.prepare(s)));ready.add(db);}
const json=(s,f={})=>{try{return JSON.parse(s)??f}catch{return f}};
const cents=v=>/^\d+(\.\d{1,2})?$/.test(String(v))?Math.round(Number(v)*100):null;
export const policy=db=>db.prepare('SELECT * FROM rma_policy WHERE id=1').first();
export async function rmaOrder(db,key,email=null) {
 await ensureRma(db);
 let result;
 if(/^website:[a-f0-9]{32}$/.test(key||'')) {
  const o=await db.prepare(`SELECT o.*,d.delivered_at FROM orders o LEFT JOIN order_deliveries d ON d.order_id=o.id WHERE o.id=? AND (? IS NULL OR email=? COLLATE NOCASE)`).bind(key.slice(8),email,email).first();
  if(!o)return null;
  const lines=await all(db.prepare(`SELECT i.*,c.unit_cost FROM order_items i LEFT JOIN finance_order_costs c ON c.order_id=i.order_id AND c.variant_id=i.variant_id WHERE i.order_id=? ORDER BY i.variant_id`).bind(o.id));
  const credit=await db.prepare('SELECT amount FROM rma_credit_uses WHERE order_id=? AND released=0').bind(o.id).first('amount')||0;
  result={key,reference:orderNo(o),email:o.email,name:o.name,phone:o.phone,address:o.address,city:o.city,total:o.total,shipping:o.shipping,net:o.subtotal-o.discount,currency:o.currency,paid:o.payment_status==='paid',cancelled:o.status==='cancelled',delivered_at:o.delivered_at,refunded:o.payment_status==='refunded'?o.total:0,method:o.payment_method,credit_used:credit,lines:lines.map(l=>({key:l.variant_id,variant_id:l.variant_id,title:l.product_title+' · '+l.variant_title,quantity:l.quantity,price:l.price,unit_cost:l.unit_cost}))};
  if(o.status!=='delivered')result.delivered_at=null;
 } else if(/^shopify:\d{1,30}$/.test(key||'')) {
  const o=await historicalOrder(db,key.slice(8),email);if(!o)return null;
  const link=await db.prepare('SELECT website_order_id FROM finance_order_links WHERE shopify_source_id=?').bind(o.source_id).first('website_order_id');
  if(link)return rmaOrder(db,'website:'+link,email);
  const h=json(o.data).header||{},raw=json(o.line_items,[]),variants=await all(db.prepare('SELECT id,sku FROM variants'));
  const lines=raw.map((l,index)=>{const match=variants.filter(v=>l.sku&&v.sku===l.sku);return {key:String(index),variant_id:match.length===1?match[0].id:null,title:l.name,quantity:Number(l.quantity),price:cents(l.price),unit_cost:null};});
  result={key,reference:o.order_number,email:o.email,name:h['Shipping Name']||h['Billing Name']||'',phone:h['Shipping Phone']||h.Phone||'',address:[h['Shipping Address1'],h['Shipping Address2']].filter(Boolean).join(', '),city:h['Shipping City']||'',total:cents(o.amount),shipping:cents(h.Shipping),currency:o.currency,paid:['paid','partially_refunded'].includes(o.payment),cancelled:!!o.cancelled_at,delivered_at:null,refunded:cents(h['Refunded Amount']||'0'),method:h['Payment Method']||'historical',credit_used:0,lines};
  result.net=result.total!==null&&result.shipping!==null?result.total-result.shipping:null;
 }
 if(!result)return null;
 result.verified=result.currency==='EGP'&&result.net!==null&&result.refunded===0&&result.lines.length>0&&result.lines.every(l=>l.price!==null&&Number.isInteger(l.quantity)&&l.quantity>0);
 try {result.lines=allocate(result.lines,result.net);} catch {result.verified=false;result.lines=result.lines.map(l=>({...l,value:null}));}
 const used=await all(db.prepare(`SELECT l.line_key,sum(l.quantity) quantity FROM rma_lines l JOIN rma_cases c ON c.id=l.case_id WHERE c.source_key=? AND c.state NOT IN('declined','cancelled') GROUP BY l.line_key`).bind(result.key));
 const legacy=result.key.startsWith('website:')?await all(db.prepare(`SELECT variant_id line_key,sum(quantity) quantity FROM order_returns WHERE order_id=? AND state NOT IN('declined','cancelled') GROUP BY variant_id`).bind(result.key.slice(8))):[];
 result.lines=result.lines.map(l=>({...l,used:[...used,...legacy].filter(x=>x.line_key===l.key).reduce((n,x)=>n+x.quantity,0)}));
 return result;
}
export async function replacementChoices(db) {return all(db.prepare(`SELECT v.id,v.title,v.price,v.inventory,p.title product,c.unit_cost FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN finance_variant_costs c ON c.variant_id=v.id WHERE v.active=1 AND v.inventory>0 AND p.status='active' AND p.preorder=0 ORDER BY p.title,v.position`));}
export async function buildRmaQuote(db,order,form) {
 const kind=textValue(form,'kind',12),reason=textValue(form,'reason',30),note=textValue(form,'reason_note',800,false);
 if(!['refund','exchange','credit'].includes(kind)||!Object.hasOwn(reasons,reason))throw new StoreError('Choose a resolution and reason. / اختر نوع الطلب والسبب.');
 const p=await policy(db),elig=eligibility(order,reason,p),choices=await replacementChoices(db);
 if(order.cancelled)throw new StoreError('Cancelled orders cannot be returned.');
 const lines=[];
 for(const l of order.lines) {
  if(form.get('select:'+l.key)!=='on')continue;
  const quantity=quantityValue(form.get('quantity:'+l.key),1,Math.min(25,l.quantity-l.used));
  const replacement=kind==='exchange'?choices.find(v=>v.id===form.get('replacement:'+l.key)):null;
  if(kind==='exchange'&&(!replacement||replacement.inventory<quantity))throw new StoreError('Choose an available replacement. / اختر بديلًا متاحًا.');
  lines.push({...l,quantity,purchased:l.quantity,value:l.value===null?0:portion(l.value,l.quantity,l.used,quantity),replacement_id:replacement?.id||null,replacement_title:replacement?replacement.product+' · '+replacement.title:'',replacement_price:replacement?.price||0,replacement_cost:replacement?.unit_cost??null});
 }
 if(!lines.length)throw new StoreError('Select at least one item. / اختر منتجًا واحدًا على الأقل.');
 const item_value=lines.reduce((n,l)=>n+l.value,0),replacement_value=lines.reduce((n,l)=>n+l.replacement_price*l.quantity,0);
 // Original delivery is refunded for a complete return. Partial-order delivery needs manual review.
 const full=order.lines.every(l=>lines.find(x=>x.key===l.key)?.quantity===l.quantity&&l.used===0);
 const shipping_refund=kind!=='exchange'&&full&&order.verified?order.shipping:0;
 const fee=elig.statutory?0:p.goodwill_fee;
 return {kind,reason,note,lines,elig,item_value,replacement_value,shipping_refund,fee,settlement:kind==='exchange'?replacement_value-item_value+fee:-(Math.max(0,item_value+shipping_refund-fee)),verified:order.verified&&!order.credit_used,policy:p};
}
function eventStatements(db,id,actor,action,detail,email,language='en') {
 const eid=makeToken(16),status=rmaStates[action]?.[language==='ar'?1:0]||action;
 return [db.prepare('INSERT INTO rma_events(id,case_id,actor,action,detail) VALUES(?,?,?,?,?)').bind(eid,id,actor,action,detail),
 db.prepare('INSERT INTO rma_mail(event_id,recipient,subject,body) VALUES(?,?,?,?)').bind(eid,email,'UNLISTED · '+(language==='ar'?'تحديث طلب الاستبدال والاسترجاع':'Returns & exchanges update'),`UNLISTED\n${id.slice(0,8).toUpperCase()} · ${status}\n${detail}\n\nhttps://unlisted-shop.com/returns?request=${id}&lang=${language}`)];
}
export async function submitRma(env,user,form) {
 const db=env.DB;await ensureRma(db);
 const id=textValue(form,'request_id',32),source=textValue(form,'order',80),language=form.get('language')==='ar'?'ar':'en';
 if(!isToken(id,16))throw new StoreError('Reload the request page.');
 const digest=await sha256(JSON.stringify([...form.entries()].filter(([k,v])=>typeof v==='string'&&k!=='request_id').sort(([a],[b])=>a.localeCompare(b))));
 const previous=await db.prepare('SELECT * FROM rma_cases WHERE id=?').bind(id).first();
 if(previous){if(previous.email.toLowerCase()!==user.email.toLowerCase()||previous.digest!==digest)throw new StoreError('Request already submitted with different details.',409);return id;}
 const order=await rmaOrder(db,source,user.email);if(!order)throw new StoreError('Order not found.',404);
 const q=await buildRmaQuote(db,order,form);
 if(form.get('accept_quote')!=='on'||form.get('quote')!==await sha256(JSON.stringify(q)))throw new StoreError('Review the current price difference before submitting.',409);
 const uploads=form.getAll('photos').filter(f=>typeof f!=='string'&&f.size>0);
 if(uploads.length>3)throw new StoreError('Upload up to three photos.');
 const photos=[];
 for(const f of uploads) {
  if(f.size>5*1024*1024)throw new StoreError('Each photo must be below 5 MB.');
  const bytes=new Uint8Array(await f.arrayBuffer());
  const mime=bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10'?'image/png':String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP'?'image/webp':null;
  if(!mime)throw new StoreError('Use JPEG, PNG or WebP photos.');
  photos.push({id:makeToken(16),key:'private-returns/'+id+'/'+makeToken(16),bytes,mime});
 }
 const saved=[];
 try {
  for(const p of photos){await env.MEDIA.put(p.key,p.bytes,{httpMetadata:{contentType:p.mime}});saved.push(p.key);}
  const commands=[db.prepare(`INSERT INTO rma_cases(id,digest,source_key,order_reference,email,snapshot,kind,reason,reason_note,language,eligibility,statutory,item_value,shipping_refund,replacement_value,fee,settlement,payment_verified) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,digest,order.key,order.reference,user.email,JSON.stringify(order),q.kind,q.reason,q.note,language,q.verified?q.elig.code:'evidence_review',Number(q.elig.statutory),q.item_value,q.shipping_refund,q.replacement_value,q.fee,q.settlement,Number(order.paid&&q.verified)),
   ...q.lines.map(l=>db.prepare(`INSERT INTO rma_lines(case_id,line_key,source_key,variant_id,title,quantity,purchased,value,replacement_id,replacement_title,replacement_price,unit_cost,replacement_cost) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,l.key,order.key,l.variant_id,l.title,l.quantity,l.purchased,l.value,l.replacement_id,l.replacement_title,l.replacement_price,l.unit_cost??null,l.replacement_cost)),
   ...photos.map(p=>db.prepare('INSERT INTO rma_photos(id,case_id,media_key,mime,size) VALUES(?,?,?,?,?)').bind(p.id,id,p.key,p.mime,p.bytes.length)),
   ...eventStatements(db,id,user.email,'requested',q.verified?'Request received. / تم استلام الطلب.':'Request received for evidence review. / الطلب قيد مراجعة البيانات.',user.email,language)];
  await db.batch(commands);
 } catch(e) {for(const key of saved)await env.MEDIA.delete(key);if(/Return quantity already requested/.test(e.message))throw new StoreError('Some quantities already have a return request. Refresh the order.',409);throw e;}
 if(q.policy.auto_approve&&q.verified&&q.elig.code==='eligible'&&order.paid&&q.lines.every(l=>l.variant_id)) {
  const auto=new FormData();auto.set('id',id);auto.set('version','0');auto.set('operation','approve');auto.set('message',language==='ar'?q.policy.instructions_ar:q.policy.instructions_en);
  try {await manageRma(env,'automation',auto);}catch(e){if(!(e instanceof StoreError))throw e;}
 }
 return id;
}
export async function caseDetail(db,id,email=null) {
 await ensureRma(db);if(!isToken(id,16))return null;
 const c=await db.prepare('SELECT * FROM rma_cases WHERE id=? AND (? IS NULL OR email=? COLLATE NOCASE)').bind(id,email,email).first();if(!c)return null;
 const [lines,events,photos,shipments,operations,credit,replacement]=await Promise.all([
 all(db.prepare('SELECT * FROM rma_lines WHERE case_id=?').bind(id)),all(db.prepare('SELECT * FROM rma_events WHERE case_id=? ORDER BY created_at,id').bind(id)),all(db.prepare('SELECT id,mime FROM rma_photos WHERE case_id=?').bind(id)),all(db.prepare('SELECT * FROM rma_shipments WHERE case_id=?').bind(id)),all(db.prepare('SELECT * FROM rma_operations WHERE case_id=?').bind(id)),db.prepare('SELECT * FROM rma_credit WHERE case_id=?').bind(id).first(),db.prepare('SELECT * FROM rma_replacements WHERE case_id=?').bind(id).first()]);
 return {...c,order:json(c.snapshot),lines,events,photos,shipments,operations,credit,replacement};
}
export async function manageRma(env,actor,form) {
 const db=env.DB,id=textValue(form,'id',32),op=textValue(form,'operation',30);await ensureRma(db);
 const c=await caseDetail(db,id);if(!c)throw new StoreError('Request not found.',404);
 const version=quantityValue(form.get('version'),0,1000000);
 if(version!==c.version)throw new StoreError('Request changed. Refresh before acting.',409);
 const transitions={approve:['requested','approved'],decline:['requested','declined'],cancel:['approved','cancelled'],receive:['approved','received'],complete:['received','completed']};
 const message=textValue(form,'message',800,false);
 const target=transitions[op];
 if(!target||c.state!==target[0])throw new StoreError('This action is unavailable for the current status.',409);
 if(['decline','cancel'].includes(op)&&!message)throw new StoreError('Explain the decision to the customer.');
 if(op==='approve'&&c.eligibility!=='eligible'&&form.get('reviewed')!=='on')throw new StoreError('Review delivery, policy exceptions and payment evidence before approving.');
 if(op==='approve'&&['evidence_review','customer_review'].includes(c.eligibility))throw new StoreError('Order amounts or prior refunds are incomplete. Verify source evidence and obtain customer confirmation before approval.');
 if(op==='cancel'&&(c.shipments.length||c.operations.some(o=>o.kind.startsWith('shipping:'))))throw new StoreError('A pickup is booked. Reconcile cancellation with the courier first.');
 const reserved=c.kind==='exchange';
 let reference='',paid=c.payment_verified;
 if(op==='receive'&&!paid&&form.get('payment_verified')==='on'){if(!textValue(form,'payment_evidence',180,false))throw new StoreError('Provide the verified payment evidence.');paid=1;}
 if(op==='complete') {
  if(!paid)throw new StoreError('Verify the original payment before settlement.');
  reference=textValue(form,'reference',180,c.kind!=='credit');
  if(c.kind==='exchange'&&!c.shipments.some(s=>s.direction==='replacement'))throw new StoreError('Record replacement shipping before completion.');
  const refund=c.operations.find(o=>o.kind==='refund');
  if(refund&&refund.state!=='succeeded')throw new StoreError('Reconcile the pending Paymob refund before completing.');
  if(c.kind!=='credit'&&c.settlement!==0&&form.get('settlement_verified')!=='on'&&refund?.state!=='succeeded')throw new StoreError('Confirm the exact collection or refund and its reference.');
  if(refund?.state==='succeeded')reference=refund.reference;
 }
 const marker=makeToken(16),guard='EXISTS(SELECT 1 FROM rma_events WHERE id=?)';
 const commands=[db.prepare(`INSERT INTO rma_events(id,case_id,actor,action,detail) SELECT ?,id,?,?,? FROM rma_cases WHERE id=? AND version=? AND state=?`).bind(marker,actor,op==='receive'?'received':target[1],message||textValue(form,'payment_evidence',180,false)||reference,id,version,target[0]),
 db.prepare(`UPDATE rma_cases SET state=?,version=version+1,message=?,reference=CASE WHEN ?<>'' THEN ? ELSE reference END,payment_verified=?,updated_at=unixepoch() WHERE id=? AND version=? AND ${guard}`).bind(target[1],message,reference,reference,paid,id,version,marker)];
 if(reserved&&op==='approve') {
  // A single conditional update plus CHECK(inventory>=0) makes competing reservations atomic.
  commands.push(db.prepare(`UPDATE variants SET inventory=inventory-(SELECT sum(quantity) FROM rma_lines WHERE case_id=? AND replacement_id=variants.id) WHERE id IN(SELECT replacement_id FROM rma_lines WHERE case_id=?) AND ${guard}`).bind(id,id,marker));
  const available=await replacementChoices(db);if(c.lines.some(l=>!available.some(v=>v.id===l.replacement_id&&v.price===l.replacement_price)))throw new StoreError('Replacement availability or price changed. Review with the customer.',409);
  commands.push(db.prepare(`INSERT INTO rma_replacements(id,case_id,state) SELECT ?,?,'reserved' WHERE ${guard}`).bind('RMA-'+id,id,marker));
 }
 if(reserved&&op==='cancel')commands.push(db.prepare(`UPDATE variants SET inventory=inventory+(SELECT sum(quantity) FROM rma_lines WHERE case_id=? AND replacement_id=variants.id) WHERE id IN(SELECT replacement_id FROM rma_lines WHERE case_id=?) AND ${guard}`).bind(id,id,marker),db.prepare(`UPDATE rma_replacements SET state='cancelled' WHERE case_id=? AND ${guard}`).bind(id,marker));
 if(op==='receive') {
  for(const l of c.lines)if(form.get('restock:'+l.line_key)==='on') {
   if(!l.variant_id)throw new StoreError('Map the historical item to a verified inventory variant before restocking.');
   commands.push(db.prepare(`UPDATE variants SET inventory=inventory+? WHERE id=? AND inventory IS NOT NULL AND ${guard}`).bind(l.quantity,l.variant_id,marker),db.prepare(`UPDATE rma_lines SET restocked=1 WHERE case_id=? AND line_key=? AND ${guard}`).bind(id,l.line_key,marker));
  }
  if(reserved)commands.push(db.prepare(`UPDATE rma_replacements SET state='ready' WHERE case_id=? AND ${guard}`).bind(id,marker));
 }
 if(op==='complete') {
  if(c.kind==='credit') {
   if(c.settlement>=0)throw new StoreError('No positive store credit is due.');
   const code='UC-'+makeToken(12).toUpperCase();reference=code;
   commands.push(db.prepare(`INSERT INTO discounts(code,kind,value,active) SELECT ?,'fixed',?,1 WHERE ${guard}`).bind(code,-c.settlement,marker),db.prepare(`INSERT INTO rma_credit(code,case_id,email,issued,balance) SELECT ?,?,?,?,? WHERE ${guard}`).bind(code,id,c.email,-c.settlement,-c.settlement,marker));
  }
  commands.push(db.prepare(`INSERT INTO rma_ledger(id,case_id,kind,amount,reference) SELECT ?,?,?,?,? WHERE ${guard}`).bind(makeToken(16),id,c.kind,c.settlement,reference,marker));
 }
 commands.push(db.prepare(`INSERT INTO rma_mail(event_id,recipient,subject,body) SELECT ?,?,?,? WHERE ${guard}`).bind(marker,c.email,'UNLISTED · Returns & exchanges',`UNLISTED\n${rmaStates[target[1]][c.language==='ar'?1:0]}\n${message}\nhttps://unlisted-shop.com/returns?request=${id}&lang=${c.language}`,marker));
 try {const result=await db.batch(commands);if(result[0].meta.changes!==1)throw new StoreError('Request changed. Refresh before acting.',409);}catch(e){if(/CHECK constraint failed|Replacement stock changed/.test(e.message))throw new StoreError('Replacement stock is no longer sufficient.',409);throw e;}
 return id;
}
export async function deliverRmaMail(env) {
 await ensureRma(env.DB);const db=env.DB;
 const rows=await all(db.prepare('SELECT * FROM rma_mail WHERE sent_at IS NULL AND next_at<=unixepoch() AND lease_until<unixepoch() ORDER BY next_at LIMIT 10'));
 for(const r of rows) {
  const claimed=await db.prepare('UPDATE rma_mail SET lease_until=unixepoch()+120,attempts=attempts+1 WHERE event_id=? AND sent_at IS NULL AND lease_until<unixepoch() RETURNING event_id').bind(r.event_id).first();if(!claimed)continue;
  const sent=await sendEmail(env,{to:r.recipient,subject:r.subject,text:r.body,key:'rma-'+r.event_id});
  await db.prepare('UPDATE rma_mail SET sent_at=?,next_at=unixepoch()+?,lease_until=0 WHERE event_id=?').bind(sent?unixNow():null,Math.min(86400,60*2**Math.min(10,r.attempts)),r.event_id).run();
 }
}
export async function saveRmaPolicy(db,actor,form) {
 await ensureRma(db);const days=quantityValue(form.get('days'),14,365),defects=quantityValue(form.get('defect_days'),30,365),fee=priceValue(form.get('goodwill_fee')||'0'),courier=textValue(form,'courier',12);
 if(!['manual','bosta','shipblu','aramex'].includes(courier))throw new StoreError('Choose a courier.');
 const en=textValue(form,'instructions_en',800),ar=textValue(form,'instructions_ar',800);
 await statements(db,[['UPDATE rma_policy SET days=?,defect_days=?,auto_approve=?,goodwill_fee=?,courier=?,instructions_en=?,instructions_ar=?,updated_at=unixepoch() WHERE id=1',days,defects,Number(form.get('auto_approve')==='on'),fee,courier,en,ar],['INSERT INTO rma_events(id,actor,action,detail) VALUES(?,?,?,?)',makeToken(16),actor,'policy',JSON.stringify({days,defect_days:defects,fee,courier,en,ar})]]);
}

export async function verifyRmaEvidence(env,actor,form) {
 const db=env.DB,c=await caseDetail(db,textValue(form,'id',32));
 if(!c||c.state!=='requested'||!['evidence_review','delivery_review','outside_window','customer_review'].includes(c.eligibility))throw new StoreError('Evidence can be reviewed while a request is awaiting approval.');
 if(c.order.credit_used)throw new StoreError('Orders paid with store credit need a split-tender reconciliation before processing.');
 const version=quantityValue(form.get('version'),0,1000000),note=textValue(form,'message',800);
 const historical=c.source_key.startsWith('shopify:');
 const total=historical?priceValue(form.get('verified_total')):c.order.total,refunded=historical?priceValue(form.get('prior_refunded')||'0'):(c.order.refunded||0);
 const date=textValue(form,'delivered_on',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new StoreError('Enter the verified delivery date.');
 const delivered_at=Math.floor(Date.parse(date+'T12:00:00+02:00')/1000);if(!Number.isFinite(delivered_at)||delivered_at>unixNow())throw new StoreError('Check the delivery date.');
 const payment_verified=Number(form.get('payment_verified')==='on'),shipping_refund=priceValue(form.get('shipping_refund')||'0');
 const marker=makeToken(16),guard='EXISTS(SELECT 1 FROM rma_events WHERE id=?)',commands=[];
 let item_value=0;
 for(const l of c.lines) {
  const value=historical?priceValue(form.get('value:'+l.line_key)):l.value;
  const variant=l.variant_id||textValue(form,'variant:'+l.line_key,100,false)||null;
  if(variant&&!await db.prepare('SELECT 1 FROM variants WHERE id=?').bind(variant).first())throw new StoreError('Choose a valid inventory variant.');
  const rawCost=textValue(form,'cost:'+l.line_key,20,false),cost=l.unit_cost??(rawCost?priceValue(rawCost):null);
  item_value+=value;
  commands.push(db.prepare(`UPDATE rma_lines SET value=?,variant_id=?,unit_cost=? WHERE case_id=? AND line_key=? AND ${guard}`).bind(value,variant,cost,c.id,l.line_key,marker));
 }
 if(item_value+shipping_refund>total-refunded)throw new StoreError('Selected return value exceeds the verified remaining order value.');
 const order={...c.order,total,refunded,delivered_at,paid:!!payment_verified,verified:true},p=await policy(db),e=eligibility(order,c.reason,p),fee=e.statutory?0:c.fee;
 const settlement=c.kind==='exchange'?c.replacement_value-item_value+fee:-Math.max(0,item_value+shipping_refund-fee);
 await db.batch([
  db.prepare("INSERT INTO rma_events(id,case_id,actor,action,detail) SELECT ?,id,?,'evidence_verified',? FROM rma_cases WHERE id=? AND version=? AND state='requested'").bind(marker,actor,note,c.id,version),
  db.prepare(`UPDATE rma_cases SET snapshot=?,item_value=?,shipping_refund=?,fee=?,settlement=?,statutory=?,payment_verified=?,eligibility='customer_review',version=version+1,updated_at=unixepoch() WHERE id=? AND version=? AND ${guard}`).bind(JSON.stringify(order),item_value,shipping_refund,fee,settlement,Number(e.statutory),payment_verified,c.id,version,marker),
  ...commands,
  db.prepare(`INSERT INTO rma_mail(event_id,recipient,subject,body) SELECT ?,?,?,? WHERE ${guard}`).bind(marker,c.email,'UNLISTED · Confirm your return amounts',`Please review and confirm your updated return amounts. / يرجى مراجعة مبالغ طلبك وتأكيدها.\nhttps://unlisted-shop.com/returns?request=${c.id}&lang=${c.language}`,marker)
 ]).then(result=>{if(result[0].meta.changes!==1)throw new StoreError('Request changed. Refresh the page.',409);});
}
export async function acceptRmaEvidence(db,user,form) {
 const c=await caseDetail(db,textValue(form,'id',32),user.email);if(!c||c.state!=='requested'||c.eligibility!=='customer_review'||form.get('accept_quote')!=='on')throw new StoreError('Review and confirm the updated amounts.');
 const version=quantityValue(form.get('version'),0,1000000),p=await policy(db),e=eligibility(c.order,c.reason,p),marker=makeToken(16);
 const result=await db.batch([db.prepare("INSERT INTO rma_events(id,case_id,actor,action,detail) SELECT ?,id,?,'customer_confirmed','Updated amounts accepted by verified customer.' FROM rma_cases WHERE id=? AND version=? AND eligibility='customer_review'").bind(marker,user.email,c.id,version),db.prepare("UPDATE rma_cases SET eligibility=?,version=version+1,updated_at=unixepoch() WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM rma_events WHERE id=?)").bind(e.code,c.id,version,marker)]);
 if(result[0].meta.changes!==1)throw new StoreError('Request changed. Refresh the page.',409);return c.id;
}
