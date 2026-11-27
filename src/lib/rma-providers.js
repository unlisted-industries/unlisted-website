import { all,makeToken,statements } from './db.js';
import { caseDetail,ensureRma } from './rma.js';
import { StoreError,textValue,priceValue } from './http.js';

export function rmaConnections(env) {return {paymob:env.PAYMOB_RMA_REFUNDS_ENABLED==='true'&&!!env.PAYMOB_SECRET_KEY,bosta:env.RMA_SHIPPING_ENABLED==='true'&&!!env.BOSTA_API_KEY,shipblu:env.RMA_SHIPPING_ENABLED==='true'&&!!env.SHIPBLU_API_KEY&&!!env.SHIPBLU_PACKAGE_SIZE,aramex:false};}
async function claim(db,c,kind,provider,amount=0) {
 const id=makeToken(16);
 const r=await db.prepare(`INSERT INTO rma_operations(id,case_id,kind,provider,state,amount) SELECT ?,?,?,?,'running',? WHERE EXISTS(SELECT 1 FROM rma_cases WHERE id=? AND version=? AND state=?) ON CONFLICT(case_id,kind) DO NOTHING RETURNING id`).bind(id,c.id,kind,provider,amount,c.id,c.version,c.state).first();
 if(!r)throw new StoreError('This operation was already attempted or the request changed. Reconcile it before proceeding.',409);
 return id;
}
async function audit(db,c,actor,action,detail) {await db.prepare('INSERT INTO rma_events(id,case_id,actor,action,detail) VALUES(?,?,?,?,?)').bind(makeToken(16),c.id,actor,action,detail).run();}
async function uncertain(db,id) {await db.prepare("UPDATE rma_operations SET state='review',detail='Provider outcome needs reconciliation. Do not retry automatically.' WHERE id=?").bind(id).run();}
export async function refundRma(env,actor,id) {
 await ensureRma(env.DB);const db=env.DB,c=await caseDetail(db,id);
 if(!rmaConnections(env).paymob)throw new StoreError('Paymob refund automation is not enabled. Record a verified manual refund instead.');
 if(!c||c.state!=='received'||!c.payment_verified||c.kind==='credit'||c.settlement>=0||!c.source_key.startsWith('website:')||c.order.credit_used)throw new StoreError('This request needs manual refund review.');
 const order=await db.prepare('SELECT * FROM orders WHERE id=?').bind(c.source_key.slice(8)).first();
 const transactions=await all(db.prepare("SELECT provider_txn FROM payment_events WHERE order_id=? AND state='captured'").bind(order.id));
 if(order.payment_status!=='paid'||transactions.length!==1||!/^\d+$/.test(transactions[0].provider_txn))throw new StoreError('A single verified Paymob capture is required.');
 const legacy=await db.prepare("SELECT coalesce(sum(refund_amount),0) FROM order_returns WHERE order_id=? AND state='completed'").bind(order.id).first('coalesce(sum(refund_amount),0)');
 const refunded=await db.prepare("SELECT coalesce(sum(-min(0,amount)),0) amount FROM rma_ledger l JOIN rma_cases c ON c.id=l.case_id WHERE c.source_key=?").bind(c.source_key).first('amount');
 if(-c.settlement>order.total-legacy-refunded)throw new StoreError('Refund exceeds the remaining paid balance.');
 const op=await claim(db,c,'refund','paymob',-c.settlement);
 try {
  const r=await fetch('https://accept.paymob.com/api/acceptance/void_refund/refund',{method:'POST',headers:{Authorization:'Token '+env.PAYMOB_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify({transaction_id:Number(transactions[0].provider_txn),amount_cents:-c.settlement}),signal:AbortSignal.timeout(15000)});
  const data=await r.json();
  if(!r.ok||data.success!==true||data.pending!==false||!data.id||Number(data.amount_cents)!==-c.settlement)throw new Error('Unconfirmed refund');
  await db.prepare("UPDATE rma_operations SET state='succeeded',reference=?,detail='Paymob confirmed refund' WHERE id=?").bind(String(data.id),op).run();
  await audit(db,c,actor,'refund_confirmed','Paymob refund confirmed: '+data.id);
 } catch {await uncertain(db,op);throw new StoreError('Paymob outcome requires review. Check Paymob before recording the result; this request will not be resent.',409);}
}

// Bosta needs its own city/district IDs. Look them up by name with the merchant's key before booking.
const norm=v=>String(v||'').toLowerCase().normalize('NFKD').replace(/[\u064b-\u065f]/g,'').replace(/\b(el|al)[\s-]+/g,'').replace(/[^a-z0-9\u0600-\u06ff]+/g,'');
const listOf=d=>Array.isArray(d?.data)?d.data:Array.isArray(d?.data?.list)?d.data.list:Array.isArray(d?.data?.cities)?d.data.cities:Array.isArray(d?.data?.districts)?d.data.districts:Array.isArray(d)?d:[];
async function bostaGet(env,path){const r=await fetch('https://app.bosta.co/api/v2'+path,{headers:{Authorization:env.BOSTA_API_KEY},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new StoreError('Bosta lookup failed (HTTP '+r.status+').');return r.json();}
const names=x=>[x?.name,x?.nameAr,x?.districtName,x?.districtOtherName,x?.zoneName,x?.code,x?.alias].filter(Boolean).map(norm);
const aliases={'masrelgedida':'heliopolis','مصرالجديدة':'heliopolis','heliopolis':'masrelgedida'};
export async function bostaDistricts(env,o) {
 const cityName=o.governorate||o.city,district=o.district||o.city;
 const cities=listOf(await bostaGet(env,'/cities'));
 const city=cities.find(c=>names(c).includes(norm(cityName)))||cities.find(c=>names(c).some(n=>n&&(n.includes(norm(cityName))||norm(cityName).includes(n))));
 if(!city)return {cityId:null,options:[],match:null,cityName};
 const cityId=city._id||city.id;
 const raw=listOf(await bostaGet(env,'/cities/'+encodeURIComponent(cityId)+'/districts'));
 const options=raw.flatMap(d=>Array.isArray(d.districts)?d.districts.map(x=>({id:x.districtId||x._id||x.id,label:(x.districtName||x.name)+(d.zoneName&&d.zoneName!==(x.districtName||x.name)?' — '+d.zoneName:''),keys:[...names(x),norm(d.zoneName)]})):[{id:d.districtId||d._id||d.id,label:d.districtName||d.name,keys:names(d)}]).filter(x=>x.id&&x.label).sort((a,b)=>a.label.localeCompare(b.label));
 const want=[norm(district),aliases[norm(district)]].filter(Boolean);
 const match=options.find(x=>x.keys.some(k=>want.includes(k)))||options.find(x=>x.keys.some(k=>k&&k.length>3&&want.some(w=>k.includes(w)||w.includes(k))));
 return {cityId,cityName:city.name||cityName,options,match:match?.id||null};
}
export async function bostaAddress(env,o) {
 const cityName=o.governorate||o.city,district=o.district||o.city;
 const cities=listOf(await bostaGet(env,'/cities'));
 const city=cities.find(c=>names(c).includes(norm(cityName)))||cities.find(c=>names(c).some(n=>n&&(n.includes(norm(cityName))||norm(cityName).includes(n))));
 if(!city)throw new StoreError('Bosta does not recognise the city “'+cityName+'”. Book it in Bosta’s dashboard and add the tracking number.');
 const cityId=city._id||city.id;
 let districts=[];try{districts=listOf(await bostaGet(env,'/cities/'+encodeURIComponent(cityId)+'/districts'));}catch{}
 const flat=districts.flatMap(d=>Array.isArray(d.districts)?d.districts.map(x=>({...x,zoneName:d.zoneName||d.name})):[d]);
 const hit=flat.find(d=>names(d).includes(norm(district)))||flat.find(d=>names(d).some(n=>n&&n.length>3&&(n.includes(norm(district))||norm(district).includes(n))));
 return hit?{city:city.name||cityName,cityId,districtId:hit.districtId||hit._id||hit.id}:{city:city.name||cityName,cityId,districtName:district};
}
export function shipmentPayload(provider,c,direction,env,zone='') {
 const o=c.order,returning=direction==='return';
 if(!o.address||!o.city||!o.phone||!o.name)throw new StoreError('Confirm the customer delivery address and phone first.');
 // Cash collection/refund is separate: never ask the courier to move money implicitly.
 if(provider==='bosta')return {type:returning?25:10,...(env.BOSTA_BUSINESS_LOCATION_ID?{businessLocationId:env.BOSTA_BUSINESS_LOCATION_ID}:{}),businessReference:'UNLISTED-'+c.id+'-'+direction,cod:0,specs:{packageType:'Parcel',size:'MEDIUM',packageDetails:{itemsCount:c.lines.reduce((n,l)=>n+l.quantity,0),description:'UNLISTED '+direction}},receiver:{firstName:o.name.split(' ')[0],lastName:o.name.split(' ').slice(1).join(' ')||o.name,phone:o.phone,email:c.email},[returning?'pickupAddress':'dropOffAddress']:{firstLine:o.address,...(o.bosta||(zone?{city:o.governorate||o.city,districtId:zone}:{city:o.governorate||o.city,districtName:o.district||o.city}))},notes:'UNLISTED '+c.id};
 if(provider==='shipblu') {
  if(!/^\d+$/.test(zone)||!/^\d+$/.test(env.SHIPBLU_PACKAGE_SIZE||''))throw new StoreError('A verified ShipBlu zone ID and package size ID are required.');
  return {customer:{full_name:o.name,email:c.email,phone:o.phone,address:{line_1:o.address,zone:Number(zone)}},packages:[{package_size:Number(env.SHIPBLU_PACKAGE_SIZE)}],cash_amount:0,merchant_order_reference:'UNLISTED-'+c.id+'-'+direction,order_notes:'UNLISTED '+direction,declared_value:((returning?c.item_value:c.replacement_value)/100).toFixed(2)};
 }
 throw new StoreError('Use manual tracking for this courier.');
}
export async function bookRmaShipment(env,actor,form) {
 await ensureRma(env.DB);const db=env.DB,c=await caseDetail(db,textValue(form,'id',32));
 const provider=textValue(form,'provider',12),direction=textValue(form,'direction',16),zone=textValue(form,'zone',100,false);
 if(!c||!(direction==='return'&&c.state==='approved'||direction==='replacement'&&c.state==='received'&&c.kind==='exchange'))throw new StoreError('This shipping action is unavailable.');
 if(direction==='replacement'&&c.settlement!==0&&!await db.prepare("SELECT 1 FROM rma_ledger WHERE case_id=? AND kind='difference'").bind(c.id).first())throw new StoreError('Verify the price difference before dispatching the replacement.');
 if(!rmaConnections(env)[provider])throw new StoreError('Courier credentials and shipping activation are required. Use manual booking and record tracking.');
 if(provider==='bosta')c.order={...c.order,bosta:zone?{city:c.order.governorate||c.order.city,districtId:zone}:await bostaAddress(env,c.order)};
 const payload=shipmentPayload(provider,c,direction,env,zone),op=await claim(db,c,'shipping:'+direction,provider);
 const path=provider==='bosta'?'https://app.bosta.co/api/v2/deliveries?apiVersion=1':'https://api.shipblu.com/api/v1/'+(direction==='return'?'returns/':'delivery-orders/');
 try {
  let r;
  try {r=await fetch(path,{method:'POST',headers:{Authorization:provider==='bosta'?env.BOSTA_API_KEY:'Api-Key '+env.SHIPBLU_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});}catch{throw new Error('No answer from courier');}
  const data=await r.json().catch(()=>({}));
  // An explicit rejection (4xx or success:false) means nothing was created: release the claim so it can be fixed and retried.
  if(r.status>=400&&r.status<500||provider==='bosta'&&data.success===false) {
   const why=String(data?.message||data?.error?.message||data?.error||data?.detail||('HTTP '+r.status)).slice(0,300);
   await db.prepare('DELETE FROM rma_operations WHERE id=?').bind(op).run();
   await audit(db,c,actor,'shipping_rejected',provider+' · '+why);
   throw new StoreError((provider==='bosta'?'Bosta':'ShipBlu')+' did not book it: '+why);
  }
  const body=provider==='bosta'?data.data:data,providerId=body?._id||body?.id,tracking=body?.trackingNumber||body?.tracking_number;
  if(!r.ok||(provider==='bosta'&&data.success!==true)||!providerId)throw new Error('Unconfirmed shipment');
  await statements(db,[['INSERT INTO rma_shipments(case_id,direction,provider,provider_id,tracking,status) VALUES(?,?,?,?,?,?)',c.id,direction,provider,String(providerId),String(tracking||providerId),String(body.status||body.state?.value||'Created — pickup confirmation pending').slice(0,100)],['UPDATE rma_operations SET state=?,reference=?,detail=? WHERE id=?','succeeded',String(providerId),'Created at courier',op],...(direction==='replacement'?[['UPDATE rma_replacements SET state=? WHERE case_id=?','shipped',c.id]]:[])]);
  await audit(db,c,actor,'shipping_booked',provider+' · '+direction+' · '+(tracking||providerId));
 }catch(e) {if(e instanceof StoreError)throw e;await uncertain(db,op);throw new StoreError('No clear answer from the courier. Check the courier dashboard before trying again.',409);}
}
export async function recordRmaOperation(env,actor,form) {
 const db=env.DB;await ensureRma(db);const c=await caseDetail(db,textValue(form,'id',32));if(!c)throw new StoreError('Request not found.',404);
 const type=textValue(form,'operation',24),reference=textValue(form,'reference',180),note=textValue(form,'message',800,type!=='tracking');
 if(type==='difference') {
  if(c.state!=='received'||c.kind!=='exchange'||c.settlement===0||form.get('settlement_verified')!=='on')throw new StoreError('Confirm the exchange difference first.');
  await db.batch([db.prepare("INSERT INTO rma_ledger(id,case_id,kind,amount,reference) VALUES(?,?,'difference',?,?)").bind(makeToken(16),c.id,c.settlement,reference),db.prepare('INSERT INTO rma_events(id,case_id,actor,action,detail) VALUES(?,?,?,?,?)').bind(makeToken(16),c.id,actor,'difference',note+' · '+reference)]);return;
 }
 if(type==='reconcile') {
  const op=await db.prepare("SELECT * FROM rma_operations WHERE id=? AND case_id=? AND state IN('review','running')").bind(textValue(form,'operation_id',32),c.id).first();
  if(!op)throw new StoreError('No unresolved operation.');
  if(form.get('settlement_verified')!=='on')throw new StoreError('Verify the provider outcome before reconciling.');
  await statements(db,[["UPDATE rma_operations SET state='succeeded',reference=?,detail=? WHERE id=? AND state IN('review','running')",reference,note,op.id],['INSERT INTO rma_events(id,case_id,actor,action,detail) VALUES(?,?,?,?,?)',makeToken(16),c.id,actor,'reconciled',note+' · '+reference]]);return;
 }
 if(type!=='tracking')throw new StoreError('Unknown operation.');
 const direction=textValue(form,'direction',16),provider=textValue(form,'provider',12),status=textValue(form,'status',100),cost=priceValue(form.get('cost')||'0');
 if(!['return','replacement'].includes(direction)||!['bosta','shipblu','aramex','manual'].includes(provider)||!['approved','received','completed'].includes(c.state))throw new StoreError('Check the shipping fields.');
 if(direction==='replacement'&&(c.kind!=='exchange'||!['received','completed'].includes(c.state)))throw new StoreError('Receive returned items before sending replacements.');
 if(direction==='replacement'&&c.settlement!==0&&!await db.prepare("SELECT 1 FROM rma_ledger WHERE case_id=? AND kind='difference'").bind(c.id).first())throw new StoreError('Record the verified price difference before dispatch.');
 await statements(db,[['INSERT INTO rma_shipments(case_id,direction,provider,tracking,status,cost) VALUES(?,?,?,?,?,?) ON CONFLICT(case_id,direction) DO UPDATE SET tracking=excluded.tracking,status=excluded.status,cost=excluded.cost,updated_at=unixepoch()',c.id,direction,provider,reference,status,cost],['INSERT INTO rma_events(id,case_id,actor,action,detail) VALUES(?,?,?,?,?)',makeToken(16),c.id,actor,'tracking',provider+' · '+reference+' · '+status+' · '+note],...(direction==='replacement'?[['UPDATE rma_replacements SET state=? WHERE case_id=?',form.get('delivered')==='on'?'delivered':'shipped',c.id]]:[])]);
}
export async function syncRmaTracking(env) {
 await ensureRma(env.DB);const db=env.DB;
 const rows=await all(db.prepare("SELECT s.* FROM rma_shipments s JOIN rma_cases c ON c.id=s.case_id WHERE s.provider_id<>'' AND c.state IN('approved','received') ORDER BY s.updated_at LIMIT 10"));
 for(const s of rows)try {
  const enabled=s.provider==='bosta'?env.BOSTA_API_KEY:s.provider==='shipblu'?env.SHIPBLU_API_KEY:null;if(!enabled)continue;
  const path=s.provider==='bosta'?'https://app.bosta.co/api/v2/deliveries/business/'+encodeURIComponent(s.tracking):'https://api.shipblu.com/api/v1/'+(s.direction==='return'?'returns/':'delivery-orders/')+encodeURIComponent(s.provider_id)+'/';
  const r=await fetch(path,{headers:{Authorization:s.provider==='bosta'?enabled:'Api-Key '+enabled},signal:AbortSignal.timeout(8000)});if(!r.ok)continue;
  const data=await r.json(),body=s.provider==='bosta'?data.data:data,status=String(body?.state?.value||body?.status||'').slice(0,100);if(!status)continue;
  await db.prepare('UPDATE rma_shipments SET status=?,updated_at=unixepoch() WHERE case_id=? AND direction=?').bind(status,s.case_id,s.direction).run();
  if(status!==s.status) {const c=await caseDetail(db,s.case_id);await audit(db,c,'courier','tracking',s.provider+' · '+s.tracking+' · '+status);}
 }catch{ /* Read-only retry next cron; physical receipt and stock inspection stay explicit. */ }
}
