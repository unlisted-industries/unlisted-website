import { ensureFinance } from './finance.js';
import { financeDay,reminderDue } from './finance-math.js';
import { adminEmails,emailReady,sendEmail } from './auth.js';
import { makeToken } from './db.js';
import { metaReady,syncMeta } from './finance-meta.js';
async function notify(env,dedupe,kind,title,message,email=false) {
 const id=makeToken(16);
 await env.DB.prepare('INSERT OR IGNORE INTO finance_notifications(id,dedupe,kind,title,message) VALUES(?,?,?,?,?)').bind(id,dedupe,kind,title,message).run();
 if(email)for(const recipient of adminEmails(env))await env.DB.prepare(`INSERT OR IGNORE INTO finance_email_outbox(id,notification_id,recipient) SELECT ?,id,? FROM finance_notifications WHERE dedupe=?`).bind(makeToken(16),recipient,dedupe).run();
}
export async function financeAlerts(env,now=new Date()) {
 await ensureFinance(env.DB);
 const today=financeDay(now),settings=await env.DB.prepare('SELECT * FROM finance_settings WHERE id=1').first();
 if(settings.daily_reminder&&reminderDue(now))await notify(env,'balance:'+today,'balance','Daily balance check','Please submit today’s bank statement or bank and cash balances in UNLISTED Finance.',''+settings.email_reminder==='1');
 const rows=(await env.DB.prepare(`SELECT v.id,v.inventory,v.title,p.title product,t.threshold,t.target FROM finance_thresholds t JOIN variants v ON v.id=t.variant_id JOIN products p ON p.id=v.product_id WHERE v.inventory IS NOT NULL`).all()).results;
 for(const row of rows) {
  const key='stock:'+row.id;
  if(row.inventory<=row.threshold) {
   const old=await env.DB.prepare('SELECT id,state FROM finance_notifications WHERE dedupe=?').bind(key).first();
   if(!old)await notify(env,key,'stock','Factory restock needed',row.product+' / '+row.title+': '+row.inventory+' remaining; target '+row.target+'.',settings.email_reminder===1);
   else if(old.state==='resolved') {
    await env.DB.prepare("UPDATE finance_notifications SET state='active',created_at=unixepoch(),message=? WHERE id=? AND state='resolved'").bind(row.product+' / '+row.title+': '+row.inventory+' remaining; target '+row.target+'.',old.id).run();
    // New episode gets a separate immutable notification/outbox key.
    await notify(env,key+':episode:'+Math.floor(+now/900000),'stock','Stock crossed the restock threshold',row.product+' / '+row.title+' needs factory restocking.',settings.email_reminder===1);
   }
  } else await env.DB.prepare("UPDATE finance_notifications SET state='resolved' WHERE dedupe=? AND state<>'resolved'").bind(key).run();
 }
 const snapshot=(await env.DB.prepare(`SELECT a.account,b.balance,b.reported_on FROM (SELECT 'bank' account UNION ALL SELECT 'cash') a LEFT JOIN finance_balance_reports b ON b.id=(SELECT id FROM finance_balance_reports WHERE account=a.account ORDER BY reported_on DESC,created_at DESC LIMIT 1)`).all()).results;
 const complete=snapshot.every(b=>b.balance!==null&&b.reported_on===today),cash=snapshot.reduce((n,b)=>n+Number(b.balance||0),0);
 const liability=await env.DB.prepare(`SELECT -coalesce(sum(json_extract(p.value,'$.amount')),0) amount FROM finance_journals j,json_each(j.postings) p WHERE json_extract(p.value,'$.account') IN('loans','supplier_payable')`).first('amount');
 const risk=complete&&cash<Math.max(0,liability)+settings.reserve;
 if(risk) {
  const existing=await env.DB.prepare("SELECT id,state FROM finance_notifications WHERE dedupe='risk:reserve'").first();
  if(!existing)await notify(env,'risk:reserve','risk','Cash buffer at risk','Reported cash is below recorded debts plus your configured reserve. Review spending before new commitments.',settings.email_reminder===1);
  else if(existing.state==='resolved'){await env.DB.prepare("UPDATE finance_notifications SET state='active',created_at=unixepoch() WHERE id=?").bind(existing.id).run();await notify(env,'risk:reserve:'+Math.floor(+now/900000),'risk','Cash buffer at risk again','Your latest reported cash is below recorded commitments.',settings.email_reminder===1);}
 }else if(complete)await env.DB.prepare("UPDATE finance_notifications SET state='resolved' WHERE dedupe='risk:reserve'").run();
 if(emailReady(env)) {
  const pending=(await env.DB.prepare(`SELECT o.*,n.title,n.message FROM finance_email_outbox o JOIN finance_notifications n ON n.id=o.notification_id WHERE o.state='pending' AND o.attempts<10 ORDER BY n.created_at LIMIT 10`).all()).results;
  for(const item of pending) {
   const sent=await sendEmail(env,{to:item.recipient,subject:'UNLISTED · '+item.title,text:item.message+'\n\nhttps://unlisted-shop.com/admin/finance',key:'finance-'+item.id});
   await env.DB.prepare("UPDATE finance_email_outbox SET state=?,attempts=attempts+1,sent_at=CASE WHEN ?=1 THEN unixepoch() ELSE NULL END WHERE id=?").bind(sent?'sent':'pending',Number(sent),item.id).run();
  }
 }
}
export async function runFinanceAutomation(env,now=new Date()) {
 await financeAlerts(env,now);
 if(metaReady(env)){
  const status=await env.DB.prepare('SELECT last_success FROM finance_meta_sync WHERE id=1').first();
  if(!status?.last_success||+now/1000-status.last_success>6*3600)await syncMeta(env);
 }
}
