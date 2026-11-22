export {cpaScenario} from '../../public/admin/cpa-math.js';
export function projectTotals(costs) {
 const total=state=>costs.filter(c=>c.state===state).reduce((n,c)=>n+c.amount,0);
 return {paid:total('paid'),unpaid:total('unpaid'),estimated:total('estimate'),unconfirmed:total('unconfirmed')};
}
export function expectedPieces({received,personal=0,samples=0,sold=0,reserved=0,restocked=0,gifts=0,adjustments=0}) {
 if(received===null)return null;
 const remaining=received-personal-samples-sold-reserved+restocked-gifts+adjustments;
 return remaining>=0?remaining:null;
}
