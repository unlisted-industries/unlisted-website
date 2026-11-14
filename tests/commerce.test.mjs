import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paymentSummaryItems, paymentIntegrationIds, walletReady } from '../src/lib/paymob.js';
import { orderNotificationText, telegramReady } from '../src/lib/order-notifications.js';

test('hosted order summary apportions discount cents exactly without exposing credentials',()=>{
 const order={id:'a'.repeat(32),subtotal:10001,discount:1000,shipping:900,total:9901,shipping_label:'Cairo'};
 const items=paymentSummaryItems(order,[{product_title:'Hoodie',variant_title:'M',price:3333,quantity:3},{product_title:'Gift',variant_title:'S',price:2,quantity:1}]);
 assert.equal(items.reduce((sum,x)=>sum+x.amount*x.quantity,0),order.total);
 assert.ok(items.every(x=>x.amount>=0));
 assert.throws(()=>paymentSummaryItems({...order,total:1},[{product_title:'Hoodie',variant_title:'M',price:10001,quantity:1}]),/total mismatch/);
});
test('wallet IDs stay isolated from live card and test integrations',()=>{
 const live={PAYMOB_SECRET_KEY:'sk_live_fixture',PAYMOB_PUBLIC_KEY:'pk_live_fixture',PAYMOB_HMAC_SECRET:'fixture',PAYMOB_INTEGRATION_IDS:'1',PAYMOB_WALLET_INTEGRATION_IDS:'2',PAYMOB_TEST_WALLET_INTEGRATION_IDS:'3',PAYMENT_ORIGIN:'https://unlisted.test'};
 assert.deepEqual(paymentIntegrationIds(live,'card'),[1]);assert.deepEqual(paymentIntegrationIds(live,'wallet'),[2]);
 assert.deepEqual(paymentIntegrationIds({...live,PAYMOB_SECRET_KEY:'sk_test_fixture',PAYMOB_PUBLIC_KEY:'pk_test_fixture'},'wallet'),[3]);
 assert.equal(walletReady({...live,PAYMOB_WALLET_INTEGRATION_IDS:''}),false);
});
test('notifications are bounded, branded and contain customer, product and payment details',()=>{
 const order={id:'a'.repeat(32),name:'Buyer',email:'buyer@example.invalid',phone:'01012345678',address:'Address',city:'Cairo',shipping_label:'Cairo',total:60000,payment_method:'card',chosen_method:'wallet',payment_status:'pending'};
 const text=orderNotificationText(order,Array.from({length:100},()=>({quantity:1,product_title:'X'.repeat(500),variant_title:'M',price:60000})),'https://unlisted.test');
 assert.ok(text.length<=4096);assert.match(text,/UNLISTED/);assert.match(text,/buyer@example.invalid/);assert.match(text,/wallet · pending/);assert.match(text,/\/admin\/orders/);
 assert.equal(telegramReady({TELEGRAM_BOT_TOKEN:'123:fixture',TELEGRAM_CHAT_ID:'-123'}),true);
 assert.equal(telegramReady({}),false);
});
