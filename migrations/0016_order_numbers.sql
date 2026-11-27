-- Sequential, customer-facing order numbers (#1, #2, #3 ...).
-- Pre-launch test orders keep NULL and fall back to their short ID.
ALTER TABLE orders ADD COLUMN number INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS orders_number ON orders(number);
