import { env } from 'cloudflare:workers';
import { currentUser,limitRequest } from '../../lib/auth.js';
import { formData,formError,seeOther,StoreError } from '../../lib/http.js';
import { submitRma,acceptRmaEvidence,deliverRmaMail } from '../../lib/rma.js';
export async function POST(context) {
 let destination='/returns';
 try {const user=await currentUser(env,context);if(!user)throw new StoreError('Sign in to request a return.',401);
  await limitRequest(env.DB,context.request,'rma-submit',{subject:user.email,limit:10});
  const form=await formData(context.request,16*1024*1024);const lang=form.get('language')==='ar'?'ar':'en';destination+='?lang='+lang;
  const id=form.get('operation')==='accept-evidence'?await acceptRmaEvidence(env.DB,user,form):await submitRma(env,user,form);
  await deliverRmaMail(env);
  return seeOther('/returns?request='+id+'&lang='+lang+'&sent=1');
 }catch(e){return formError(e,destination);}
}
