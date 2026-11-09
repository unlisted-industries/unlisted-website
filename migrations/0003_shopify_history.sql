CREATE TABLE shopify_orders (
  source_id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL,
  email TEXT COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  payment TEXT NOT NULL,
  fulfillment TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  line_items TEXT NOT NULL CHECK (json_valid(line_items))
);

CREATE INDEX shopify_orders_created ON shopify_orders(created_at DESC);
CREATE INDEX shopify_orders_email ON shopify_orders(email, created_at DESC);
