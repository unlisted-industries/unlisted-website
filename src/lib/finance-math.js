export const signs = {expense:-1,inventory_purchase:-1,other_income:1,owner_draw:-1,owner_contribution:1,debt_in:1,debt_out:-1,supplier_payment:-1,ad_payment:-1};
export function postingsFor(kind,account,amount,to) {
 if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('Use a positive integer amount in piastres.');
 const other={expense:'expense',inventory_purchase:'inventory',other_income:'revenue',owner_draw:'drawings',owner_contribution:'capital',debt_in:'loans',debt_out:'loans',supplier_payment:'supplier_payable',supplier_invoice:'supplier_payable',ad_payment:'ad_clearing'};
 if(kind==='transfer') {
  if(!['bank','cash'].includes(account)||!['bank','cash'].includes(to)||account===to)throw new Error('Choose different accounts.');
  return [{account,amount:-amount},{account:to,amount}];
 }
 if(kind==='supplier_invoice')return [{account:'inventory',amount},{account:'supplier_payable',amount:-amount}];
 if(!Object.hasOwn(other,kind)||!['bank','cash','unallocated'].includes(account))throw new Error('Invalid journal.');
 const signed=signs[kind]*amount;
 return [{account,amount:signed},{account:other[kind],amount:-signed}];
}
export function scenario({price,unitCost,variableCost,fixedCost,units,ads=0,expansion=0}) {
 const contribution=price-unitCost-variableCost;
 const revenue=price*units,total=fixedCost+ads+expansion;
 return {contribution,margin:price>0?contribution/price:null,breakEvenUnits:contribution>0?Math.ceil(total/contribution):null,breakEvenRevenue:contribution>0?Math.ceil(total/contribution)*price:null,breakEvenRoas:contribution>0?price/contribution:null,profit:contribution*units-total,cashNeeded:unitCost*units+total};
}
export function decimalMoney(value) {
 const s=String(value).trim();if(!/^-?\d{1,7}(?:\.\d{1,2})?$/.test(s))return null;
 const negative=s.startsWith('-'),[whole,fraction='']=s.replace('-','').split('.');
 return (Number(whole)*100+Number(fraction.padEnd(2,'0')))*(negative?-1:1);
}
export function financeDay(now=new Date()) {return new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo'}).format(now);}
export function reminderDue(now) {return Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',hour:'2-digit',hourCycle:'h23'}).format(now))===21;}
export function csvCell(value) {let s=String(value??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
