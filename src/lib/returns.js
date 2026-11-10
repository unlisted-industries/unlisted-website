import migration from '../../migrations/0007_order_returns.sql?raw';
import { all, initializeTables, isToken, makeToken, statements, unixNow } from './db.js';
import { checked, priceValue, quantityValue, StoreError, textValue } from './http.js';

export const ensureReturns = initializeTables(migration);
const returnWindow = 14 * 86400;
const activeQuantity = `SELECT coalesce(sum(quantity), 0) FROM order_returns r
  WHERE r.order_id = i.order_id AND r.variant_id = i.variant_id AND r.state NOT IN ('declined', 'cancelled')`;

export function returnLabel(row) {
  if (row.state === 'completed') return row.kind === 'refund' ? 'Refund recorded' : 'Replacement sent';
  return { requested: 'Awaiting review', approved: 'Approved', received: 'Item received', declined: 'Declined', cancelled: 'Cancelled' }[row.state];
}

export async function customerReturns(db, order) {
  await ensureReturns(db);
  const [delivery, requests] = await Promise.all([
    db.prepare('SELECT delivered_at FROM order_deliveries WHERE order_id = ?').bind(order.id).first('delivered_at'),
    all(db.prepare(`SELECT r.*, i.product_title, i.variant_title, v.title AS replacement
      FROM order_returns r JOIN order_items i ON i.order_id = r.order_id AND i.variant_id = r.variant_id
      LEFT JOIN variants v ON v.id = r.replacement_id WHERE r.order_id = ? ORDER BY r.created_at DESC`).bind(order.id)),
  ]);
  const eligible = order.status === 'delivered' && (!delivery || delivery >= unixNow() - returnWindow);
  const choices = eligible ? await all(db.prepare(`SELECT i.variant_id AS original, v.id, v.title, v.inventory
    FROM order_items i JOIN variants original ON original.id = i.variant_id
    JOIN variants v ON v.product_id = original.product_id AND v.id <> original.id
    JOIN products p ON p.id = v.product_id
    WHERE i.order_id = ? AND v.active = 1 AND v.inventory > 0 AND p.status = 'active' AND p.preorder = 0
    ORDER BY v.position, v.title`).bind(order.id)) : [];
  return { eligible, requests, choices, expires: delivery ? delivery + returnWindow : null };
}

export async function submitReturn(db, order, form) {
  const id = form.get('request_id');
  const variant = textValue(form, 'variant', 100);
  const kind = form.get('kind');
  if (!isToken(id, 16) || !['refund', 'exchange'].includes(kind)) throw new StoreError('Choose a return or size exchange.');
  const replacement = kind === 'exchange' ? textValue(form, 'replacement', 100) : null;
  const quantity = quantityValue(form.get('quantity'));
  const reason = textValue(form, 'reason', 800);
  await ensureReturns(db);
  const result = await db.prepare(`INSERT INTO order_returns (id, order_id, variant_id, quantity, kind, replacement_id, reason)
    SELECT ?, o.id, i.variant_id, ?, ?, ?, ? FROM orders o
    JOIN order_items i ON i.order_id = o.id JOIN variants original ON original.id = i.variant_id
    LEFT JOIN order_deliveries d ON d.order_id = o.id
    WHERE o.id = ? AND i.variant_id = ? AND o.status = 'delivered'
      AND (d.delivered_at IS NULL OR d.delivered_at >= unixepoch() - ?)
      AND i.quantity - (${activeQuantity}) >= ?
      AND ((? = 'refund' AND o.payment_status IN ('paid', 'unpaid')) OR (? = 'exchange' AND EXISTS (
        SELECT 1 FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = ? AND v.id <> original.id AND v.product_id = original.product_id AND v.active = 1
          AND v.inventory >= ? AND p.status = 'active' AND p.preorder = 0)))
    ON CONFLICT (id) DO NOTHING RETURNING id`)
    .bind(id, quantity, kind, replacement, reason, order.id, variant, returnWindow, quantity, kind, kind, replacement, quantity).first();
  if (result) return result.id;
  const existing = await db.prepare(`SELECT id FROM order_returns WHERE id = ? AND order_id = ? AND variant_id = ?
    AND quantity = ? AND kind = ? AND replacement_id IS ? AND reason = ?`).bind(id, order.id, variant, quantity, kind, replacement, reason).first();
  if (existing) return existing.id;
  throw new StoreError('This item, quantity or replacement is no longer available for this request. Check the order and try again.', 409);
}

const transitions = {
  approve: ['requested', 'approved'], receive: ['approved', 'received'], complete: ['received', 'completed'],
  decline: ['requested', 'declined'], cancel: ['approved', 'cancelled'],
};

export async function manageReturn(env, form) {
  const db = env.DB;
  const id = form.get('id');
  const action = form.get('operation');
  if (!isToken(id, 16) || !Object.hasOwn(transitions, action)) throw new StoreError('Choose a valid return action.');
  await ensureReturns(db);
  const row = await db.prepare('SELECT kind, order_id FROM order_returns WHERE id = ?').bind(id).first();
  if (!row) throw new StoreError('Return request not found.', 404);

  const [from, to] = transitions[action];
  const marker = makeToken(16);
  const message = ['approve', 'decline', 'cancel'].includes(action) ? textValue(form, 'message', 800) : null;
  const reference = action === 'complete' ? textValue(form, 'reference', 180) : null;
  const refund = action === 'complete' && row.kind === 'refund';
  const amount = refund ? priceValue(form.get('amount')) : null;
  let guard = '';
  const values = [];
  if (action === 'approve' && row.kind === 'exchange') {
    guard = `AND EXISTS (SELECT 1 FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = order_returns.replacement_id AND v.active = 1 AND v.inventory >= order_returns.quantity
      AND p.status = 'active' AND p.preorder = 0)`;
  }
  if (refund) {
    guard = `AND EXISTS (SELECT 1 FROM orders o WHERE o.id = order_returns.order_id AND o.payment_status = 'paid'
      AND ? BETWEEN 1 AND o.total - (SELECT coalesce(sum(r.refund_amount), 0) FROM order_returns r
        WHERE r.order_id = o.id AND r.state = 'completed'))
      AND NOT EXISTS (SELECT 1 FROM order_returns r WHERE r.kind = 'refund' AND r.state = 'completed' AND r.reference = ? COLLATE NOCASE)`;
    values.push(amount, reference);
  }
  const changes = [[`UPDATE order_returns SET state = ?, message = coalesce(?, message), reference = coalesce(?, reference),
    refund_amount = coalesce(?, refund_amount), last_action = ?, updated_at = unixepoch()
    WHERE id = ? AND state = ? ${guard}`, to, message, reference, amount, marker, id, from, ...values]];

  const changed = 'SELECT quantity FROM order_returns WHERE id = ? AND last_action = ?';
  if (row.kind === 'exchange' && ['approve', 'cancel'].includes(action)) {
    const sign = action === 'approve' ? '-' : '+';
    changes.push([`UPDATE variants SET inventory = inventory ${sign} (${changed})
      WHERE id = (SELECT replacement_id FROM order_returns WHERE id = ?) AND inventory IS NOT NULL AND EXISTS (${changed})`,
    id, marker, id, id, marker]);
  }
  if (action === 'receive' && checked(form, 'restock')) {
    changes.push([`UPDATE variants SET inventory = inventory + (${changed})
      WHERE id = (SELECT variant_id FROM order_returns WHERE id = ?) AND inventory IS NOT NULL AND EXISTS (${changed})`,
    id, marker, id, id, marker]);
  }
  if (refund) {
    changes.push([`UPDATE orders SET payment_status = 'refunded', payment_note = ?, updated_at = unixepoch()
      WHERE id = ? AND payment_status = 'paid' AND EXISTS (${changed}) AND total = (
        SELECT coalesce(sum(refund_amount), 0) FROM order_returns WHERE order_id = orders.id AND state = 'completed')`,
    reference, row.order_id, id, marker]);
  }
  const [result] = await statements(db, changes);
  if (result.meta.changes !== 1) throw new StoreError('This action is no longer available. Check the request status, replacement stock or refundable balance.', 409);
  return '/admin/returns?return=' + id;
}
