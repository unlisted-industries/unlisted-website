export function cpaScenario({price,unitCost,fees=0,cpa=0,purchases,fixed=0}) {
 if(![price,unitCost,fees,cpa,purchases,fixed].every(Number.isSafeInteger)||[price,unitCost,fees,cpa,purchases,fixed].some(n=>n<0)||purchases>1000000)throw new Error('Use non-negative amounts and whole purchase counts.');
 const revenue=price*purchases,ads=cpa*purchases,profit=(price-unitCost-fees-cpa)*purchases-fixed;
 if(![revenue,ads,profit].every(Number.isSafeInteger))throw new Error('Scenario is too large.');
 return {revenue,ads,profit,profitPerOrder:purchases?profit/purchases:null,margin:revenue?profit/revenue:null,roas:ads?revenue/ads:null,breakEvenCPA:purchases?price-unitCost-fees-fixed/purchases:null};
}
