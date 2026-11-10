CREATE TABLE IF NOT EXISTS shopify_imports (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  exported_at INTEGER NOT NULL,
  imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
  order_count INTEGER NOT NULL,
  customer_count INTEGER NOT NULL,
  product_count INTEGER NOT NULL,
  stock_count INTEGER NOT NULL,
  discount_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shopify_order_details (
  source_id TEXT PRIMARY KEY REFERENCES shopify_orders(source_id),
  data TEXT NOT NULL CHECK (json_valid(data))
);

CREATE TABLE IF NOT EXISTS shopify_customer_details (
  source_id TEXT PRIMARY KEY,
  email TEXT COLLATE NOCASE,
  data TEXT NOT NULL CHECK (json_valid(data))
);

CREATE INDEX IF NOT EXISTS shopify_customer_details_email ON shopify_customer_details(email);

CREATE TABLE IF NOT EXISTS shopify_product_details (
  handle TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data))
);

CREATE TABLE IF NOT EXISTS shopify_discount_details (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data))
);
