import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blackFridayActive, offerPrice, saleStartsAt, saleEndsAt, hoodieHandle, sweatsHandle, setPrice } from '../src/lib/offers.js';

test('the offer uses one fixed 48-hour Cairo window across both storefront and database', async () => {
  assert.equal(new Date(saleStartsAt).toISOString(),'2026-11-26T22:00:00.000Z');
  assert.equal(new Date(saleEndsAt).toISOString(),'2026-11-28T22:00:00.000Z');
  assert.equal(saleEndsAt-saleStartsAt,48*3600*1000);
  assert.equal(blackFridayActive(saleStartsAt-1),false);
  assert.equal(offerPrice(hoodieHandle,60000,saleStartsAt),44900);
  assert.equal(offerPrice(sweatsHandle,55000,saleEndsAt-1),44900);
  assert.equal(offerPrice(sweatsHandle,55000,saleEndsAt),55000);
  assert.equal(offerPrice('other',90000,saleStartsAt),90000);
  const migration = await readFile(new URL('../migrations/0015_cozy_offers.sql',import.meta.url),'utf8');
  const [terms] = migration.match(/CREATE VIEW IF NOT EXISTS cozy_offer_terms AS[\s\S]+?;/);
  assert.deepEqual([...terms.matchAll(/unixepoch\('([^']+)'\)/g)].map(match=>Date.parse(match[1])),[saleStartsAt,saleEndsAt]);
  assert.equal([...terms.matchAll(/(\d+) AS (?:hoodie|sweats)_set_price/g)].reduce((sum,match)=>sum+Number(match[1]),0),setPrice);
});
