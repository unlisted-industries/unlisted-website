CREATE TABLE IF NOT EXISTS customer_profiles (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id),
  phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '', governorate TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS order_payment_choices (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  method TEXT NOT NULL CHECK (method IN ('cod','card','wallet'))
);
CREATE TABLE IF NOT EXISTS order_notifications (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
  locked_until INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS order_notifications_pending ON order_notifications(next_attempt_at) WHERE sent_at IS NULL;
CREATE TABLE IF NOT EXISTS checkout_drafts (
  cart_id TEXT PRIMARY KEY REFERENCES carts(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK (json_valid(data)),
  expires_at INTEGER NOT NULL
);
