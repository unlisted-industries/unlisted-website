import assert from 'node:assert/strict';
import {test} from 'node:test';
import {postingsFor,scenario,decimalMoney,reminderDue,financeDay,csvCell} from '../src/lib/finance-math.js';
test('cash movements distinguish owner equity, expenses, inventory and supplier debt',()=>{
 assert.deepEqual(postingsFor('owner_draw','cash',12500),[{account:'cash',amount:-12500},{account:'drawings',amount:12500}]);
 assert.deepEqual(postingsFor('debt_in','bank',50000),[{account:'bank',amount:50000},{account:'loans',amount:-50000}]);
 assert.deepEqual(postingsFor('inventory_purchase','bank',30000),[{account:'bank',amount:-30000},{account:'inventory',amount:30000}]);
 for(const kind of ['expense','owner_draw','debt_in','debt_out','owner_contribution','inventory_purchase','supplier_invoice','supplier_payment','other_income'])assert.equal(postingsFor(kind,'bank',12345).reduce((n,p)=>n+p.amount,0),0);
 assert.equal(postingsFor('transfer','cash',5000,'bank').reduce((n,p)=>n+p.amount,0),0);
 assert.throws(()=>postingsFor('transfer','cash',5000,'cash'));
 assert.throws(()=>postingsFor('expense','cash',1.2));
});
test('break-even includes variable costs, ads and expansion, and rejects impossible contribution',()=>{
 const r=scenario({price:100000,unitCost:40000,variableCost:10000,fixedCost:1000000,ads:500000,expansion:500000,units:100});
 assert.equal(r.contribution,50000);assert.equal(r.breakEvenUnits,40);assert.equal(r.breakEvenRevenue,4000000);assert.equal(r.breakEvenRoas,2);assert.equal(r.profit,3000000);assert.equal(r.cashNeeded,6000000);
 assert.equal(scenario({price:100,unitCost:100,variableCost:5,fixedCost:1000,units:10}).breakEvenUnits,null);
});
test('EGP parsing never uses floating point for decimal conversion',()=>{
 assert.equal(decimalMoney('100.01'),10001);assert.equal(decimalMoney('-12.05'),-1205);assert.equal(decimalMoney('1.001'),null);assert.equal(decimalMoney('1,000'),null);assert.equal(decimalMoney('NaN'),null);
 assert.equal(csvCell('=HYPERLINK("https://bad")'),'"\'=HYPERLINK(""https://bad"")"');
});
test('9 PM reminders track Cairo DST instead of a fixed UTC offset',()=>{
 assert.equal(reminderDue(new Date('2026-11-14T19:00:00Z')),true);
 assert.equal(reminderDue(new Date('2026-07-14T18:00:00Z')),true);
 assert.equal(reminderDue(new Date('2026-07-14T19:00:00Z')),false);
 assert.equal(financeDay(new Date('2026-07-14T21:30:00Z')),'2026-07-15');
});
