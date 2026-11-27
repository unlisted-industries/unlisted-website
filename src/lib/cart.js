import { isToken, makeToken, statements } from './db.js';
import { setCookie, StoreError } from './http.js';
import { ensureOffers } from './offer-schema.js';
import { setPrice } from './offers.js';

export function cartId(context) {
  const id = context.cookies.get('unlisted_cart')?.value;
  return isToken(id) ? id : null;
}

export async function cartCount(db, context) {
  const id = cartId(context);
  if (!id) return 0;
  await ensureOffers(db);
  return (await db.prepare(`SELECT
    (SELECT coalesce(sum(quantity),0) FROM cart_items WHERE cart_id=?) +
    (SELECT coalesce(sum(quantity),0) FROM cart_cozy_sets WHERE cart_id=?) AS count`)
    .bind(id,id).first()).count;
}

export async function getCart(db, id) {
  if (!id) return { items: [], singles: [], sets: [], subtotal: 0, originalSubtotal: 0, version: 0, hasOffer: false };
  await ensureOffers(db);
  const [cart, components, pairs] = await db.batch([
    db.prepare('SELECT version FROM carts WHERE id=?').bind(id),
    db.prepare(`SELECT ci.*, ci.variant_id AS id,
       (SELECT media_key FROM product_images WHERE product_id=v.product_id ORDER BY variant_id=v.id DESC, position LIMIT 1) AS image
       FROM cart_offer_items ci JOIN variants v ON v.id=ci.variant_id
       WHERE ci.cart_id=? ORDER BY ci.product_position,ci.variant_position,ci.variant_id`).bind(id),
    db.prepare('SELECT hoodie_id,sweats_id,quantity FROM cart_cozy_sets WHERE cart_id=? ORDER BY hoodie_id,sweats_id').bind(id),
  ]);
  const items = components.results;
  const setComponents = new Map(items.filter(item=>item.is_set).map(item=>[item.id,item]));
  const sets = pairs.results.map(pair => {
    const hoodie = setComponents.get(pair.hoodie_id);
    const sweats = setComponents.get(pair.sweats_id);
    return {...pair, hoodie, sweats, price:setPrice, available:Boolean(hoodie?.available && sweats?.available)};
  });
  return {
    items, singles:items.filter(item=>!item.is_set), sets,
    subtotal:items.reduce((sum,item)=>sum+item.price*item.quantity,0),
    originalSubtotal:items.reduce((sum,item)=>sum+Math.max(item.regular_price,item.price)*item.quantity,0),
    version:cart.results[0]?.version ?? 0, hasOffer:items.some(item=>item.offer===1),
  };
}

export async function addItem(db, context, variant, quantity) {
  await ensureOffers(db);
  const id = cartId(context) ?? makeToken();
  const result = await statements(db, [
    ['INSERT INTO carts (id) VALUES (?) ON CONFLICT (id) DO NOTHING', id],
    [`INSERT INTO cart_items (cart_id, variant_id, quantity)
      SELECT ?, v.id, ? FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ? AND v.active = 1 AND p.status = 'active' AND p.preorder = 0
      AND CASE WHEN v.inventory IS NULL THEN v.published_available = 1 ELSE v.inventory >= ? END
      AND NOT EXISTS(SELECT 1 FROM cart_cozy_sets WHERE cart_id=? AND (hoodie_id=v.id OR sweats_id=v.id))
      AND ((SELECT count(*) FROM cart_offer_items WHERE cart_id = ?) < 24
        OR EXISTS (SELECT 1 FROM cart_items WHERE cart_id = ? AND variant_id = v.id))
      ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = cart_items.quantity + excluded.quantity
      WHERE cart_items.quantity + excluded.quantity <= 25
        AND cart_items.quantity + excluded.quantity <= coalesce((SELECT inventory FROM variants WHERE id = excluded.variant_id), 25)`,
    id, quantity, variant, quantity, id, id, id],
    ['UPDATE carts SET updated_at = unixepoch(), version = version + 1 WHERE id = ?', id],
  ]);
  if (result[1].meta.changes !== 1) {
    const bundled = await db.prepare('SELECT 1 FROM cart_cozy_sets WHERE cart_id=? AND (hoodie_id=? OR sweats_id=?)')
      .bind(id,variant,variant).first();
    throw new StoreError(bundled ? 'This size is already in a COZY Set in your cart. Order it separately or remove the set.' : 'This size or quantity is unavailable.');
  }
  setCookie(context, 'unlisted_cart', id, 30 * 86400);
}

export async function updateItem(db, context, variant, quantity) {
  await ensureOffers(db);
  const id = cartId(context);
  if (!id) throw new StoreError('Your cart is empty.');
  const query = quantity === 0
    ? ['DELETE FROM cart_items WHERE cart_id = ? AND variant_id = ?', id, variant]
    : [`UPDATE cart_items SET quantity = ?
        WHERE cart_id = ? AND variant_id = ? AND EXISTS (
          SELECT 1 FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?
          AND v.active = 1 AND p.status = 'active' AND p.preorder = 0
          AND CASE WHEN v.inventory IS NULL THEN v.published_available = 1 ELSE v.inventory >= ? END
        )`, quantity, id, variant, variant, quantity];
  const result = await statements(db, [
    query,
    ['UPDATE carts SET updated_at = unixepoch(), version = version + 1 WHERE id = ?', id],
  ]);
  if (result[0].meta.changes !== 1) throw new StoreError('This size or quantity is unavailable.');
}

export async function changeSet(db, context, hoodie, sweats, quantity, add) {
  await ensureOffers(db);
  const id = cartId(context) ?? (add ? makeToken() : null);
  if (!id) throw new StoreError('Your cart is empty.');
  const key = [id,hoodie,sweats];
  const mutation = add ? [`INSERT INTO cart_cozy_sets(cart_id,hoodie_id,sweats_id,quantity) VALUES(?,?,?,?)
    ON CONFLICT(cart_id,hoodie_id,sweats_id) DO UPDATE SET quantity=cart_cozy_sets.quantity+excluded.quantity`,...key,quantity]
    : quantity === 0 ? ['DELETE FROM cart_cozy_sets WHERE cart_id=? AND hoodie_id=? AND sweats_id=?',...key]
    : ['UPDATE cart_cozy_sets SET quantity=? WHERE cart_id=? AND hoodie_id=? AND sweats_id=?',quantity,...key];
  let result;
  try {
    result = await statements(db,[
      ['INSERT INTO carts (id) VALUES (?) ON CONFLICT (id) DO NOTHING',id],
      mutation,
      ['UPDATE carts SET updated_at=unixepoch(),version=version+1 WHERE id=?',id],
    ]);
  } catch (error) {
    if (/requested set unavailable|CHECK constraint failed|FOREIGN KEY constraint failed/.test(error.message)) {
      const singles = await db.prepare('SELECT 1 FROM cart_items WHERE cart_id=? AND variant_id IN (?,?)').bind(...key).first();
      throw new StoreError(singles ? 'A selected size is already in your cart as an individual item. Remove it before adding the set.' :
        'A selected size or quantity is unavailable. Choose another size or reduce the quantity.',409);
    }
    throw error;
  }
  if (result[1].meta.changes !== 1) throw new StoreError('This set is no longer in your cart.');
  setCookie(context,'unlisted_cart',id,30*86400);
}

export async function cartProductHandles(db, context) {
  const cart = await getCart(db,cartId(context));
  return [...new Set(cart.items.map(item=>item.handle))];
}
