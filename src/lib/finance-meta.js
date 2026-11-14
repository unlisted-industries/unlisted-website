import { ensureFinance } from './finance.js';
import { decimalMoney,financeDay } from './finance-math.js';
import { StoreError } from './http.js';
export function metaReady(env){return Boolean(env.META_ACCESS_TOKEN&&/^act_\d+$/.test(env.META_AD_ACCOUNT_ID||''));}
export async function syncMeta(env,{since,until}={}) {
 if(!metaReady(env))throw new StoreError('Meta needs META_ACCESS_TOKEN with ads_read and META_AD_ACCOUNT_ID in Worker secrets.',503);
 await ensureFinance(env.DB);
 const version=env.META_API_VERSION||'v27.0';if(!/^v\d+\.\d+$/.test(version))throw new StoreError('Invalid Meta API version.');
 const request=async(path,params)=>{
  const url=new URL('https://graph.facebook.com/'+version+'/'+path);for(const[k,v]of Object.entries(params))url.searchParams.set(k,typeof v==='object'?JSON.stringify(v):v);
  const response=await fetch(url,{headers:{Authorization:'Bearer '+env.META_ACCESS_TOKEN},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new StoreError('Meta sync failed ('+response.status+'). Check token expiry, ads_read permission, account access and API version.',503);
  return response.json();
 };
 try{
  const account=await request(env.META_AD_ACCOUNT_ID,{fields:'currency,timezone_name'});
  if(account.currency!=='EGP')throw new StoreError('This ad account is not in EGP. Supply verified exchange rates before importing.');
  if(account.timezone_name!=='Africa/Cairo')throw new StoreError('Meta account reporting timezone differs from Cairo. Align the reporting timezone before comparing daily revenue.');
  until||=financeDay();since||=new Date(Date.parse(until+'T12:00:00Z')-29*86400000).toISOString().slice(0,10);
  const base={fields:'campaign_id,campaign_name,spend,actions,action_values,clicks,impressions,date_start,account_currency',level:'campaign',time_increment:1,time_range:{since,until},limit:500,action_report_time:'conversion'};
  const rows=[];let after;
  for(let page=0;page<100;page++) {
   const data=await request(env.META_AD_ACCOUNT_ID+'/insights',{...base,...(after?{after}:{})});
   if(!Array.isArray(data.data))throw new StoreError('Meta returned an invalid insights response.');rows.push(...data.data);
   if(!data.paging?.next)break;
   after=data.paging.cursors?.after;if(!after||page===99)throw new StoreError('Meta response exceeded one sync. Use a smaller date range.');
  }
  const actions=(list)=>Number((list||[]).find(a=>a.action_type==='purchase')?.value||(list||[]).find(a=>a.action_type==='offsite_conversion.fb_pixel_purchase')?.value||0);
  const changes=[];
  for(const r of rows){const spend=decimalMoney(r.spend),purchaseValue=decimalMoney(String(actions(r.action_values)));
   if(spend===null||spend<0||purchaseValue===null||r.account_currency!=='EGP'||!/^\d{4}-\d{2}-\d{2}$/.test(r.date_start)||!/^\d+$/.test(r.campaign_id))throw new StoreError('Meta returned unsupported currency or invalid amounts. Nothing was imported.');
   changes.push(env.DB.prepare(`INSERT INTO finance_meta_daily(day,campaign_id,campaign_name,spend,purchases,purchase_value,clicks,impressions) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(day,campaign_id) DO UPDATE SET campaign_name=excluded.campaign_name,spend=excluded.spend,purchases=excluded.purchases,purchase_value=excluded.purchase_value,clicks=excluded.clicks,impressions=excluded.impressions,synced_at=unixepoch()`).bind(r.date_start,r.campaign_id,r.campaign_name,spend,actions(r.actions),purchaseValue,Number(r.clicks||0),Number(r.impressions||0)));
  }
  // A successful refresh also clears days/campaigns that the API now reports as absent.
  await env.DB.batch([env.DB.prepare('DELETE FROM finance_meta_daily WHERE day>=? AND day<=?').bind(since,until),...changes,env.DB.prepare(`INSERT INTO finance_meta_sync(id,last_success,last_error,currency) VALUES(1,unixepoch(),'','EGP') ON CONFLICT(id) DO UPDATE SET last_success=unixepoch(),last_error=''`)]);
 }catch(e){await env.DB.prepare(`INSERT INTO finance_meta_sync(id,last_error) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error`).bind(e instanceof StoreError?e.message:'Meta service unavailable. Retry later.').run();throw e;}
}
