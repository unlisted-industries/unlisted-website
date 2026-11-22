import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cpaScenario,projectTotals,expectedPieces} from '../src/lib/operations-math.js';
import {reportingRange} from '../src/lib/reporting.js';
test('CPA scenario accounts for per-order fees and fixed costs, handles zero spend and zero purchases',()=>{
 const s=cpaScenario({price:80000,unitCost:30000,fees:5000,cpa:10000,purchases:10,fixed:200000});
 assert.equal(s.ads,100000);assert.equal(s.profit,150000);assert.equal(s.profitPerOrder,15000);assert.equal(s.margin,.1875);assert.equal(s.roas,8);assert.equal(s.breakEvenCPA,25000);
 assert.equal(cpaScenario({price:500,unitCost:600,purchases:0}).breakEvenCPA,null);
 assert.equal(cpaScenario({price:500,unitCost:600,purchases:1}).roas,null);
 assert.throws(()=>cpaScenario({price:100,unitCost:20,purchases:1.5}));
});
test('paid, unpaid, estimated and unconfirmed costs stay independent',()=>{
 assert.deepEqual(projectTotals([{state:'paid',amount:200},{state:'unpaid',amount:50},{state:'estimate',amount:80},{state:'unconfirmed',amount:40}]),{paid:200,unpaid:50,estimated:80,unconfirmed:40});
 assert.equal(expectedPieces({received:1,samples:1}),0);
 assert.equal(expectedPieces({received:50,personal:1,sold:10,reserved:2,restocked:1,gifts:3}),35);
 assert.equal(expectedPieces({received:null}),null);assert.equal(expectedPieces({received:2,sold:3}),null);
});
test('All-Time reporting includes old source records without fictitious comparisons',()=>{
 const r=reportingRange(new URL('https://unlisted.test/admin?days=all&compare=previous'),new Date('2026-11-22T12:00:00Z'));
 assert.equal(r.current.startDate,'2000-01-01');assert.equal(r.current.endDate,'2026-11-22');assert.equal(r.previous,null);assert.equal(r.label,'All time');
});
