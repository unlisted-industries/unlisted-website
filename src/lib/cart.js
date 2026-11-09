import { all, isToken, makeToken, statements } from './db.js';
import { setCookie, StoreError } from './http.js';

export function cartId(context) {
  const id = context.cookies.get('unlisted_cart')?.value;
  return isToken(id) ? id : null;
}

export async function cartCount(db, context) {
  const id = cartId(context);
  if (!id) return 0;
  return (await db.prepare('SELECT coalesce(sum(quantity), 0) AS count FROM cart_items WHERE cart_id = ?')
    .bind(id).first()).count;
}

export async function getCart(db, id) {
  if (!id) return { items: [], subtotal: 0, version: 0 };
  const items = await all(db.prepare(`
    SELECT v.id, p.handle, p.title, v.title AS variant_title, v.sku, v.price, v.inventory,
      ci.quantity, c.version,
      (v.active = 1 AND p.status = 'active' AND p.preorder = 0 AND
        CASE WHEN v.inventory IS NULL THEN v.published_available ELSE v.inventory >= ci.quantity END) AS available,
      (SELECT media_key FROM product_images WHERE product_id = p.id ORDER BY variant_id = v.id DESC, position LIMIT 1) AS image
    FROM cart_items ci JOIN carts c ON c.id = ci.cart_id JOIN variants v ON v.id = ci.variant_id
      JOIN products p ON p.id = v.product_id WHERE ci.cart_id = ? ORDER BY p.position, v.position
  `).bind(id));
  return { items, subtotal: items.reduce((sum, item) => sum + item.price * item.quantity, 0), version: items[0]?.version ?? 0 };
}

export async function addItem(db, context, variant, quantity) {
  const id = cartId(context) ?? makeToken();
  const result = await statements(db, [
    ['INSERT INTO carts (id) VALUES (?) ON CONFLICT (id) DO NOTHING', id],
    [`INSERT INTO cart_items (cart_id, variant_id, quantity)
      SELECT ?, v.id, ? FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ? AND v.active = 1 AND p.status = 'active' AND p.preorder = 0
      AND CASE WHEN v.inventory IS NULL THEN v.published_available = 1 ELSE v.inventory >= ? END
      AND ((SELECT count(*) FROM cart_items WHERE cart_id = ?) < 24
        OR EXISTS (SELECT 1 FROM cart_items WHERE cart_id = ? AND variant_id = v.id))
      ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = cart_items.quantity + excluded.quantity
      WHERE cart_items.quantity + excluded.quantity <= 25
        AND cart_items.quantity + excluded.quantity <= coalesce((SELECT inventory FROM variants WHERE id = excluded.variant_id), 25)`,
    id, quantity, variant, quantity, id, id],
    ['UPDATE carts SET updated_at = unixepoch(), version = version + 1 WHERE id = ?', id],
  ]);
  if (result[1].meta.changes !== 1) throw new StoreError('This size or quantity is unavailable.');
  setCookie(context, 'unlisted_cart', id, 30 * 86400);
}

export async function updateItem(db, context, variant, quantity) {
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
