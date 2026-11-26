CREATE TABLE IF NOT EXISTS cart_cozy_sets (
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  hoodie_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  sweats_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 25),
  PRIMARY KEY(cart_id, hoodie_id, sweats_id)
);

CREATE VIEW IF NOT EXISTS cozy_offer_terms AS
SELECT unixepoch('2026-11-27T00:00:00+02:00') AS starts_at,
       unixepoch('2026-11-29T00:00:00+02:00') AS ends_at,
       44900 AS sale_price, 52122 AS hoodie_set_price, 47778 AS sweats_set_price;

CREATE VIEW IF NOT EXISTS cart_offer_items AS
WITH lines AS (
  SELECT ci.cart_id, ci.variant_id, ci.quantity, '' AS expected_handle, 0 AS is_set,
    CASE WHEN p.handle IN ('cozy-hoodie-grey','cozy-straight-leg-sweats-grey')
      AND unixepoch() >= terms.starts_at AND unixepoch() < terms.ends_at
      THEN terms.sale_price ELSE v.price END AS price,
    CASE WHEN p.handle IN ('cozy-hoodie-grey','cozy-straight-leg-sweats-grey')
      AND unixepoch() >= terms.starts_at AND unixepoch() < terms.ends_at
      THEN 1 ELSE 0 END AS offer
  FROM cart_items ci JOIN variants v ON v.id=ci.variant_id JOIN products p ON p.id=v.product_id
  CROSS JOIN cozy_offer_terms terms
  UNION ALL
  SELECT b.cart_id, b.hoodie_id, sum(b.quantity), 'cozy-hoodie-grey', 1, terms.hoodie_set_price, 1
    FROM cart_cozy_sets b CROSS JOIN cozy_offer_terms terms GROUP BY b.cart_id,b.hoodie_id
  UNION ALL
  SELECT b.cart_id, b.sweats_id, sum(b.quantity), 'cozy-straight-leg-sweats-grey', 1, terms.sweats_set_price, 1
    FROM cart_cozy_sets b CROSS JOIN cozy_offer_terms terms GROUP BY b.cart_id,b.sweats_id
)
SELECT l.*, v.price AS regular_price, v.inventory, p.handle, p.title, p.position AS product_position,
  v.title AS variant_title, v.sku, v.position AS variant_position,
  (v.active=1 AND p.status='active' AND p.preorder=0 AND
    (l.expected_handle='' OR p.handle=l.expected_handle) AND l.quantity<=25 AND
    CASE WHEN v.inventory IS NULL THEN l.is_set=0 AND v.published_available=1 ELSE v.inventory>=l.quantity END
    AND CASE WHEN l.is_set=1 THEN NOT EXISTS(
      SELECT 1 FROM cart_items solo WHERE solo.cart_id=l.cart_id AND solo.variant_id=l.variant_id
    ) ELSE NOT EXISTS(
      SELECT 1 FROM cart_cozy_sets bundle WHERE bundle.cart_id=l.cart_id
        AND (bundle.hoodie_id=l.variant_id OR bundle.sweats_id=l.variant_id)
    ) END) AS available
FROM lines l JOIN variants v ON v.id=l.variant_id JOIN products p ON p.id=v.product_id;

DROP TRIGGER IF EXISTS validate_order;
CREATE TRIGGER validate_order BEFORE INSERT ON orders BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM store_settings WHERE id=1 AND checkout_enabled=1
      AND CASE NEW.payment_method WHEN 'cod' THEN cod_enabled ELSE card_enabled END=1
  ) THEN RAISE(ABORT, 'checkout disabled') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM shipping_rates WHERE code=NEW.shipping_code AND label=NEW.shipping_label
      AND amount=NEW.shipping AND active=1
  ) THEN RAISE(ABORT, 'shipping changed') END;
  SELECT CASE WHEN NEW.discount_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM discounts WHERE code=NEW.discount_code AND active=1
      AND min_subtotal<=NEW.subtotal AND (max_uses IS NULL OR uses<max_uses)
      AND (starts_at IS NULL OR starts_at<=unixepoch()) AND (ends_at IS NULL OR ends_at>unixepoch())
      AND NEW.discount=min(NEW.subtotal,CASE kind WHEN 'percent' THEN NEW.subtotal*value/100 ELSE value END)
      AND (EXISTS(SELECT 1 FROM rma_credit WHERE code=NEW.discount_code)
        OR NOT EXISTS(SELECT 1 FROM cart_offer_items WHERE cart_id=NEW.cart_id AND offer=1))
  ) THEN RAISE(ABORT, 'discount changed') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM carts WHERE id=NEW.cart_id AND version=NEW.cart_version)
    OR NOT EXISTS(SELECT 1 FROM cart_offer_items WHERE cart_id=NEW.cart_id)
    OR EXISTS(SELECT 1 FROM cart_offer_items WHERE cart_id=NEW.cart_id AND (available<>1 OR inventory IS NULL))
    OR NEW.subtotal<>(SELECT sum(quantity*price) FROM cart_offer_items WHERE cart_id=NEW.cart_id)
    THEN RAISE(ABORT, 'cart changed') END;
END;

DROP TRIGGER IF EXISTS reserve_inventory;
CREATE TRIGGER reserve_inventory BEFORE INSERT ON order_items BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM orders o JOIN cart_offer_items ci ON ci.cart_id=o.cart_id
    WHERE o.id=NEW.order_id AND ci.variant_id=NEW.variant_id AND ci.available=1
      AND ci.inventory>=NEW.quantity AND ci.price=NEW.price AND ci.quantity=NEW.quantity
  ) THEN RAISE(ABORT, 'inventory or cart changed') END;
  UPDATE variants SET inventory=inventory-NEW.quantity WHERE id=NEW.variant_id;
END;

CREATE TABLE IF NOT EXISTS order_cozy_sets (
  order_id TEXT NOT NULL REFERENCES orders(id),
  hoodie_id TEXT NOT NULL REFERENCES variants(id),
  sweats_id TEXT NOT NULL REFERENCES variants(id),
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 25),
  PRIMARY KEY(order_id, hoodie_id, sweats_id)
);

CREATE INDEX IF NOT EXISTS cart_cozy_sets_sweats ON cart_cozy_sets(cart_id,sweats_id);

CREATE TRIGGER IF NOT EXISTS validate_set_insert AFTER INSERT ON cart_cozy_sets BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM cart_offer_items WHERE cart_id=NEW.cart_id)>24
    OR (SELECT count(*) FROM cart_cozy_sets WHERE cart_id=NEW.cart_id)>12
    OR NOT EXISTS(SELECT 1 FROM cart_offer_items WHERE cart_id=NEW.cart_id AND variant_id=NEW.hoodie_id AND expected_handle='cozy-hoodie-grey' AND available=1)
    OR NOT EXISTS(SELECT 1 FROM cart_offer_items WHERE cart_id=NEW.cart_id AND variant_id=NEW.sweats_id AND expected_handle='cozy-straight-leg-sweats-grey' AND available=1)
    THEN RAISE(ABORT, 'requested set unavailable') END;
END;

CREATE TRIGGER IF NOT EXISTS validate_set_update AFTER UPDATE OF quantity ON cart_cozy_sets BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM cart_offer_items WHERE cart_id=NEW.cart_id)>24
    OR (SELECT count(*) FROM cart_cozy_sets WHERE cart_id=NEW.cart_id)>12
    OR NOT EXISTS(SELECT 1 FROM cart_offer_items WHERE cart_id=NEW.cart_id AND variant_id=NEW.hoodie_id AND expected_handle='cozy-hoodie-grey' AND available=1)
    OR NOT EXISTS(SELECT 1 FROM cart_offer_items WHERE cart_id=NEW.cart_id AND variant_id=NEW.sweats_id AND expected_handle='cozy-straight-leg-sweats-grey' AND available=1)
    THEN RAISE(ABORT, 'requested set unavailable') END;
END;
