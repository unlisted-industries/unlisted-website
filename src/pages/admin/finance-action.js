import { env } from 'cloudflare:workers';
import { currentUser,limitRequest } from '../../lib/auth.js';
import { applyFinanceAction } from '../../lib/finance.js';
import { extractImport,confirmImport } from '../../lib/finance-import.js';
import { syncMeta } from '../../lib/finance-meta.js';
import { askFinance } from '../../lib/finance-advice.js';
import { financeAlerts } from '../../lib/finance-automation.js';
import { formData,formError,seeOther,StoreError } from '../../lib/http.js';
export async function POST(context) {
 const user=await currentUser(env,context,'admin');if(!user)return new Response('Sign-in required',{status:401});
 try {
  const form=await formData(context.request,9*1024*1024),op=form.get('op');
  if(op==='advice'){await limitRequest(env.DB,context.request,'finance-advice',{subject:user.email,limit:10,window:3600});const id=await askFinance(env,context.url,form,user.email);return seeOther('/admin/finance?advice='+id);}
  if(op==='extract') {
   await limitRequest(env.DB,context.request,'finance-ai',{subject:user.email,limit:10,window:3600});
   const id=await extractImport(env,form,user.email);return seeOther('/admin/finance?tab=accountant&import='+id);
  }
  if(op==='confirm_import')await confirmImport(env.DB,form,user.email);
  else if(op==='sync_meta'){
   if(form.get('confirmed')!=='yes')throw new StoreError('Confirm sync first.');
   await limitRequest(env.DB,context.request,'finance-meta',{subject:user.email,limit:4,window:3600});await syncMeta(env);
  }else await applyFinanceAction(env.DB,form,user.email);
  await financeAlerts(env);
  return seeOther('/admin/finance?tab='+encodeURIComponent(form.get('tab')||'overview')+'&saved=1');
 }catch(error){return formError(error,'/admin/finance');}
}
