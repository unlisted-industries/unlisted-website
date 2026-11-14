const scenario=document.querySelector('[data-scenario]');
if(scenario)scenario.addEventListener('submit',event=>{
 event.preventDefault();if(!scenario.reportValidity())return;
 const v=Object.fromEntries([...new FormData(scenario)].map(([k,x])=>[k,Number(x)]));
 const contribution=v.price-v.unitCost-v.variableCost,fixed=v.fixedCost+v.ads+v.expansion;
 const m=x=>new Intl.NumberFormat('en-EG',{style:'currency',currency:'EGP',maximumFractionDigits:2}).format(x);
 const rows=[['Unit contribution',m(contribution)],['Contribution margin',v.price>0?(100*contribution/v.price).toFixed(1)+'%':'Unavailable'],['Break-even units',contribution>0?String(Math.ceil(fixed/contribution)):'No break-even at this price'],['Break-even revenue',contribution>0?m(Math.ceil(fixed/contribution)*v.price):'Unavailable'],['Break-even ROAS before fixed costs',contribution>0?(v.price/contribution).toFixed(2)+'×':'Unavailable'],['Projected profit',m(contribution*v.units-fixed)],['Production + fixed investment + ads',m(v.unitCost*v.units+fixed)]];
 const dl=document.createElement('dl');for(const[label,value]of rows){const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;row.append(dt,dd);dl.append(row);}document.querySelector('[data-scenario-result]').replaceChildren(dl);
});
const upload=document.querySelector('[data-finance-upload]');
if(upload)upload.addEventListener('submit',()=>{const button=upload.querySelector('button:not([type=button])');button.disabled=true;button.textContent='Extracting for review…';});
const record=document.querySelector('[data-record-voice]');
let recorder,stream,timeout;
if(record)record.addEventListener('click',async()=>{
 const status=document.querySelector('[data-record-status]');
 if(recorder?.state==='recording'){recorder.stop();return;}
 if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){status.textContent='Voice recording is unavailable here. Upload a voice note instead.';return;}
 try{
  stream=await navigator.mediaDevices.getUserMedia({audio:true});const chunks=[];
  const type=['audio/webm','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
  recorder=new MediaRecorder(stream,type?{mimeType:type}:undefined);
  recorder.addEventListener('dataavailable',e=>{if(e.data.size)chunks.push(e.data);});
  recorder.addEventListener('stop',()=>{
   clearTimeout(timeout);stream.getTracks().forEach(t=>t.stop());
   const blob=new Blob(chunks,{type:recorder.mimeType}),file=new File([blob],recorder.mimeType.includes('mp4')?'voice-note.m4a':'voice-note.webm',{type:recorder.mimeType});
   if(file.size>8*1024*1024){status.textContent='Recording is too large. Try a shorter note.';}else{const transfer=new DataTransfer();transfer.items.add(file);upload.elements.file.files=transfer.files;status.textContent='Voice note attached. Choose Extract for review.';}
   record.textContent='Record voice note';
  });
  recorder.start();record.textContent='Stop recording';status.textContent='Recording… maximum 3 minutes.';timeout=setTimeout(()=>recorder.state==='recording'&&recorder.stop(),180000);
 }catch{status.textContent='Microphone access was not available. You can upload an audio file.';}
});
const notificationButton=document.querySelector('[data-enable-notifications]');
if(notificationButton)notificationButton.addEventListener('click',async()=>{
 const status=document.querySelector('[data-notification-status]');
 if(!('Notification'in window)){status.textContent='Device notifications are unavailable. In-app and configured email reminders remain available.';return;}
 const permission=await Notification.requestPermission();status.textContent=permission==='granted'?'Device notifications enabled while this app is open. Email is used when it is closed.':'Notifications are not enabled. In-app and email reminders remain available.';
});
let notificationSeen=sessionStorage.getItem('unlisted-finance-notification')||'';
async function checkNotifications(){
 if(!('Notification'in window)||Notification.permission!=='granted')return;
 try{const response=await fetch('/admin/finance-notifications.json',{cache:'no-store'});if(!response.ok)return;const data=await response.json();for(const item of data.items){if(item.id===notificationSeen)break;new Notification('UNLISTED · '+item.title,{body:item.message,icon:'/admin/icon-192.png',tag:item.id});}if(data.items[0]){notificationSeen=data.items[0].id;sessionStorage.setItem('unlisted-finance-notification',notificationSeen);}}catch{}
}
if('Notification'in window&&Notification.permission==='granted'){checkNotifications();setInterval(checkNotifications,60000);}
