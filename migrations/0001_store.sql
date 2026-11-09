CREATE TABLE store_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'EGP'),
  home_heading TEXT NOT NULL DEFAULT 'THE COZY DROP',
  hero_desktop TEXT,
  hero_mobile TEXT,
  hero_poster TEXT,
  size_guide TEXT NOT NULL DEFAULT '',
  navigation TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(navigation)),
  socials TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(socials)),
  checkout_enabled INTEGER NOT NULL DEFAULT 0 CHECK (checkout_enabled IN (0, 1)),
  cod_enabled INTEGER NOT NULL DEFAULT 0 CHECK (cod_enabled IN (0, 1)),
  card_enabled INTEGER NOT NULL DEFAULT 0 CHECK (card_enabled IN (0, 1)),
  analytics_enabled INTEGER NOT NULL DEFAULT 1 CHECK (analytics_enabled IN (0, 1))
);

INSERT INTO store_settings (id, name, currency) VALUES (1, 'UNLISTED™', 'EGP');

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  preorder INTEGER NOT NULL DEFAULT 0 CHECK (preorder IN (0, 1)),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  option_names TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(option_names)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  title TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options)),
  price INTEGER NOT NULL CHECK (price >= 0 AND price <= 100000000),
  compare_at INTEGER CHECK (compare_at IS NULL OR compare_at >= price),
  inventory INTEGER CHECK (inventory IS NULL OR inventory >= 0),
  published_available INTEGER NOT NULL DEFAULT 0 CHECK (published_available IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX variants_product ON variants(product_id, active, position);

CREATE TABLE media (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  original_name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE product_images (
  product_id TEXT NOT NULL REFERENCES products(id),
  media_key TEXT NOT NULL REFERENCES media(key),
  alt TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  variant_id TEXT REFERENCES variants(id),
  PRIMARY KEY (product_id, media_key)
);
CREATE INDEX product_image_order ON product_images(product_id, position);

CREATE TABLE collections (
  handle TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE collection_products (
  collection_handle TEXT NOT NULL REFERENCES collections(handle),
  product_id TEXT NOT NULL REFERENCES products(id),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_handle, product_id)
);
CREATE INDEX collection_product_order ON collection_products(collection_handle, position);

CREATE TABLE pages (
  handle TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE login_tokens (
  digest TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  purpose TEXT NOT NULL CHECK (purpose IN ('account', 'admin')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_tokens_expiry ON login_tokens(expires_at);

CREATE TABLE sessions (
  digest TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('account', 'admin')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);

CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX carts_updated ON carts(updated_at);

CREATE TABLE cart_items (
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES variants(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 25),
  PRIMARY KEY (cart_id, variant_id)
);

CREATE TABLE shipping_rates (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 0 AND 100000000),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);

CREATE TABLE discounts (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value INTEGER NOT NULL CHECK (value > 0 AND value <= 100000000 AND (kind <> 'percent' OR value <= 100)),
  min_subtotal INTEGER NOT NULL DEFAULT 0 CHECK (min_subtotal >= 0),
  max_uses INTEGER CHECK (max_uses > 0),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  starts_at INTEGER,
  ends_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  checkout_key TEXT NOT NULL UNIQUE,
  request_digest TEXT NOT NULL,
  cart_id TEXT NOT NULL,
  cart_version INTEGER NOT NULL,
  customer_id TEXT REFERENCES customers(id),
  visitor_id TEXT,
  visitor_day TEXT,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  shipping_code TEXT NOT NULL REFERENCES shipping_rates(code),
  shipping_label TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'EGP'),
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  shipping INTEGER NOT NULL CHECK (shipping >= 0),
  discount INTEGER NOT NULL CHECK (discount BETWEEN 0 AND subtotal),
  discount_code TEXT REFERENCES discounts(code),
  total INTEGER NOT NULL CHECK (total = subtotal + shipping - discount),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cod', 'card')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'refunded', 'review')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'shipped', 'delivered', 'cancelled')),
  expires_at INTEGER,
  checkout_url TEXT,
  provider_order_id TEXT UNIQUE,
  payment_lock_until INTEGER,
  tracking TEXT NOT NULL DEFAULT '',
  payment_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX orders_created ON orders(created_at DESC);
CREATE INDEX orders_customer ON orders(customer_id, created_at DESC);
CREATE INDEX orders_pending ON orders(expires_at) WHERE payment_status = 'pending';

CREATE TABLE order_items (
  order_id TEXT NOT NULL REFERENCES orders(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  product_title TEXT NOT NULL,
  variant_title TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 25),
  price INTEGER NOT NULL CHECK (price >= 0),
  PRIMARY KEY (order_id, variant_id)
);

CREATE TABLE payment_events (
  provider_txn TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  state TEXT NOT NULL CHECK (state IN ('captured', 'late')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE preorder_requests (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT NOT NULL,
  consent_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (product_id, variant_id, email)
);

CREATE TABLE contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  read_at INTEGER
);

CREATE TABLE visits (
  visitor_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (day, visitor_id)
);

CREATE TRIGGER validate_order BEFORE INSERT ON orders BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM store_settings WHERE id = 1 AND checkout_enabled = 1
      AND CASE NEW.payment_method WHEN 'cod' THEN cod_enabled ELSE card_enabled END = 1
  ) THEN RAISE(ABORT, 'checkout disabled') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM shipping_rates
    WHERE code = NEW.shipping_code AND label = NEW.shipping_label
      AND amount = NEW.shipping AND active = 1
  ) THEN RAISE(ABORT, 'shipping changed') END;

  SELECT CASE WHEN NEW.discount_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM discounts WHERE code = NEW.discount_code AND active = 1
      AND min_subtotal <= NEW.subtotal AND (max_uses IS NULL OR uses < max_uses)
      AND (starts_at IS NULL OR starts_at <= unixepoch())
      AND (ends_at IS NULL OR ends_at > unixepoch())
      AND NEW.discount = min(NEW.subtotal, CASE kind
        WHEN 'percent' THEN NEW.subtotal * value / 100 ELSE value END)
  ) THEN RAISE(ABORT, 'discount changed') END;

  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM carts WHERE id = NEW.cart_id AND version = NEW.cart_version)
    OR NEW.subtotal <> (
    SELECT coalesce(sum(ci.quantity * v.price), 0)
    FROM cart_items ci JOIN variants v ON v.id = ci.variant_id
    WHERE ci.cart_id = NEW.cart_id
  ) OR NOT EXISTS (SELECT 1 FROM cart_items WHERE cart_id = NEW.cart_id)
    THEN RAISE(ABORT, 'cart changed') END;
END;

CREATE TRIGGER consume_discount AFTER INSERT ON orders WHEN NEW.discount_code IS NOT NULL BEGIN
  UPDATE discounts SET uses = uses + 1 WHERE code = NEW.discount_code;
END;

CREATE TRIGGER reserve_inventory BEFORE INSERT ON order_items BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM variants v
    JOIN products p ON p.id = v.product_id
    JOIN orders o ON o.id = NEW.order_id
    JOIN cart_items ci ON ci.cart_id = o.cart_id AND ci.variant_id = v.id
    WHERE v.id = NEW.variant_id AND v.active = 1 AND p.status = 'active' AND p.preorder = 0
      AND v.inventory >= NEW.quantity AND v.price = NEW.price AND ci.quantity = NEW.quantity
  ) THEN RAISE(ABORT, 'inventory or cart changed') END;
  UPDATE variants SET inventory = inventory - NEW.quantity WHERE id = NEW.variant_id;
END;

CREATE TRIGGER release_inventory AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelled' AND OLD.status <> 'cancelled' BEGIN
  UPDATE variants SET inventory = inventory + (
    SELECT quantity FROM order_items WHERE order_id = NEW.id AND variant_id = variants.id
  ) WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = NEW.id);
  UPDATE discounts SET uses = uses - 1 WHERE code = NEW.discount_code;
END;
