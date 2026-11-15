import {env} from 'cloudflare:workers';
import {currentUser} from '../../lib/auth.js';
import {formData,formError,seeOther,StoreError} from '../../lib/http.js';
import {manageRma,saveRmaPolicy,verifyRmaEvidence,deliverRmaMail} from '../../lib/rma.js';
import {refundRma,bookRmaShipment,recordRmaOperation} from '../../lib/rma-providers.js';
export async function POST(context) {
 const user=await currentUser(env,context,'admin');if(!user)return new Response('Sign-in required',{status:401});
 let dest='/admin/returns';
 try {const form=await formData(context.request),op=form.get('operation'),id=form.get('id');if(/^[a-f0-9]{32}$/.test(id||''))dest+='?request='+id;
  if(op==='policy')await saveRmaPolicy(env.DB,user.email,form);
  else if(op==='verify-evidence')await verifyRmaEvidence(env,user.email,form);
  else if(op==='paymob')await refundRma(env,user.email,id);
  else if(op==='booking')await bookRmaShipment(env,user.email,form);
  else if(['tracking','difference','reconcile'].includes(op))await recordRmaOperation(env,user.email,form);
  else await manageRma(env,user.email,form);
  await deliverRmaMail(env);
  return seeOther(dest+(dest.includes('?')?'&':'?')+'saved=1');
 }catch(e){return formError(e,dest);}
}
