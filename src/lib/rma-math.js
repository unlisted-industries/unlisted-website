// Exact integer allocation: all line shares sum to the original discounted amount.
export function allocate(lines, net) {
 const gross=lines.reduce((n,l)=>n+l.price*l.quantity,0);
 if(!Number.isSafeInteger(net)||net<0||net>gross||lines.some(l=>!Number.isSafeInteger(l.price)||l.price<0||!Number.isSafeInteger(l.quantity)||l.quantity<1))throw new Error('Unverified order amounts');
 let before=0;
 return lines.map(l=>{const start=before;before+=l.price*l.quantity;return {...l,value:gross?Math.floor(net*before/gross)-Math.floor(net*start/gross):0};});
}
export function portion(value,purchased,used,quantity) {
 if(![value,purchased,used,quantity].every(Number.isSafeInteger)||value<0||purchased<1||used<0||quantity<1||used+quantity>purchased)throw new Error('Invalid return quantity');
 return Math.floor(value*(used+quantity)/purchased)-Math.floor(value*used/purchased);
}
export const defectReasons=new Set(['defective','wrong_item','not_as_described']);
export function eligibility(order,reason,policy,now=Math.floor(Date.now()/1000)) {
 if(order.cancelled)return {code:'cancelled',eligible:false,statutory:false};
 if(!order.delivered_at)return {code:'delivery_review',eligible:true,statutory:true};
 const days=defectReasons.has(reason)?policy.defect_days:policy.days;
 const age=Math.floor((now-order.delivered_at)/86400);
 if(age<0)return {code:'delivery_review',eligible:true,statutory:true};
 const statutory=age<=(defectReasons.has(reason)?30:14);
 return {code:age<=days?'eligible':'outside_window',eligible:age<=days,statutory};
}
export const reasons={size:['Size / fit','المقاس'],color:['Color','اللون'],changed_mind:['Changed my mind','تغيير الرأي'],defective:['Defective / damaged','عيب أو تلف'],wrong_item:['Wrong item','منتج غير صحيح'],not_as_described:['Not as described','غير مطابق للوصف'],other:['Other','سبب آخر']};
export const rmaStates={requested:['Awaiting review','بانتظار المراجعة'],approved:['Approved · pickup next','تمت الموافقة · انتظار الاستلام'],received:['Received · resolution next','تم الاستلام · جارٍ تنفيذ الطلب'],completed:['Completed','مكتمل'],declined:['Declined','مرفوض'],cancelled:['Cancelled','ملغي']};
