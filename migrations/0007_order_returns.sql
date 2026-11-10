CREATE TABLE IF NOT EXISTS order_deliveries (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  delivered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_returns (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 25),
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'exchange')),
  replacement_id TEXT REFERENCES variants(id),
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'approved', 'received', 'completed', 'declined', 'cancelled')),
  message TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  refund_amount INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  last_action TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (order_id, variant_id) REFERENCES order_items(order_id, variant_id),
  CHECK ((kind = 'refund' AND replacement_id IS NULL) OR (kind = 'exchange' AND replacement_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS order_returns_item ON order_returns(order_id, variant_id);
CREATE INDEX IF NOT EXISTS order_returns_queue ON order_returns(state, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS order_returns_refund_ref ON order_returns(reference COLLATE NOCASE)
  WHERE kind = 'refund' AND state = 'completed' AND reference <> '';
