import { env } from 'cloudflare:workers';
import { currentUser } from '../../lib/auth.js';
import { financeReport } from '../../lib/finance-report.js';
import { csvCell } from '../../lib/finance-math.js';
export async function GET(context){
 if(!await currentUser(env,context,'admin'))return new Response('Sign-in required',{status:401});
 const f=await financeReport(env.DB,context.url),rows=[['UNLISTED Financial Report','EGP',f.range.current.startDate,f.range.current.endDate],['Metric','EGP / value'],['Recognized revenue',f.revenue/100],['Collected net revenue',f.collected/100],['COGS',f.cogs/100],['Operating expenses',f.expenses/100],['PR expenses',f.pr/100],['Estimated net profit',f.profit/100],['Profit complete',f.profitReliable?'yes':'no'],['Bank and cash reported',f.cashReported===null?'unreported':f.cashReported/100],['Recorded liabilities',f.liabilities/100],['Uncollected order value',f.uncollected/100],['Inventory value',f.inventoryValue===null?'incomplete':f.inventoryValue/100],[],['Warnings'],...f.warnings.map(w=>[w]),[],['Date','Type','Amount EGP','Drop','Category','Campaign'],...f.events.map(e=>[e.day,e.type,e.amount/100,e.drop||'',e.category||'',e.campaign||''])];
 return new Response('\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="UNLISTED-finance-'+f.range.today+'.csv"','Cache-Control':'private, no-store'}});
}
