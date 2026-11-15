import assert from 'node:assert/strict';
import {test} from 'node:test';
import {allocate,portion,eligibility} from '../src/lib/rma-math.js';
test('RMA discounts and split quantities preserve every piastre',()=>{
 const lines=allocate([{price:3333,quantity:3},{price:2,quantity:1}],9001);
 assert.equal(lines.reduce((n,l)=>n+l.value,0),9001);
 assert.equal([0,1,2].reduce((n,i)=>n+portion(lines[0].value,3,i,1),0),lines[0].value);
 assert.throws(()=>portion(100,2,2,1));assert.throws(()=>allocate([{price:100,quantity:1}],101));
});
test('defect rights extend to 30 days, unknown delivery needs review, statutory fees remain waived',()=>{
 const now=2e9,p={days:60,defect_days:60},order={delivered_at:now-20*86400};
 assert.equal(eligibility(order,'defective',p,now).statutory,true);
 assert.equal(eligibility(order,'size',p,now).statutory,false);
 assert.equal(eligibility({},'size',p,now).code,'delivery_review');
 assert.equal(eligibility({cancelled:true},'defective',p,now).eligible,false);
});
