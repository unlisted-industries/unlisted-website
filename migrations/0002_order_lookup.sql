CREATE INDEX orders_email ON orders(email COLLATE NOCASE, created_at DESC);
CREATE INDEX payment_events_order ON payment_events(order_id, created_at);
