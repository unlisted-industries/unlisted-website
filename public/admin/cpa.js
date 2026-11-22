import {cpaScenario} from './cpa-math.js';
const f=document.querySelector('[data-cpa-planner]');
if(f){
 const slider=f.querySelector('[data-cpa-range]'),out=document.querySelector('[data-cpa-results]');
 const money=n=>n===null?'—':new Intl.NumberFormat('en-EG',{style:'currency',currency:'EGP'}).format(n/100);
 function render(){
  if(!f.checkValidity()){out.textContent='Enter valid price, costs and whole expected purchases.';return;}
  const v=Object.fromEntries(['price','unitCost','fees','cpa','fixed'].map(k=>[k,Math.round(Number(f.elements[k].value)*100)]));
  v.purchases=Number(f.elements.purchases.value);
  try{const s=cpaScenario(v);const rows=[['Advertising cost',money(s.ads)],['Profit per order',money(s.profitPerOrder)],['Total profit',money(s.profit)],['Profit margin',s.margin===null?'—':(100*s.margin).toFixed(1)+'%'],['ROAS',s.roas===null?'No ad spend':s.roas.toFixed(2)+'×'],['Break-even CPA',s.breakEvenCPA===null?'No purchases':s.breakEvenCPA<0?'Cannot cover costs':money(s.breakEvenCPA)]];
   const dl=document.createElement('dl');for(const[k,v]of rows){const d=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=v;d.append(dt,dd);dl.append(d);}out.replaceChildren(dl);
  }catch{out.textContent='Check your scenario values.';}
 }
 f.addEventListener('submit',e=>e.preventDefault());
 slider.addEventListener('input',()=>{f.elements.cpa.value=slider.value;render();});
 f.addEventListener('input',e=>{if(e.target===f.elements.cpa){slider.max=String(Math.max(1000,Number(f.elements.cpa.value)));slider.value=f.elements.cpa.value;}render();});
}
