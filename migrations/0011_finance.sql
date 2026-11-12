-- UNLISTED Finance Phase 1: amounts are integer Egyptian piastres (EGP * 100).
-- Manual cash/bank reports are snapshots, NOT automatically inferred from orders.
CREATE TABLE IF NOT EXISTS finance_drops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  fixed_cost INTEGER NOT NULL DEFAULT 0 CHECK (fixed_cost BETWEEN 0 AND 1000000000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS finance_drop_products (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  drop_id TEXT NOT NULL REFERENCES finance_drops(id)
);
CREATE INDEX IF NOT EXISTS finance_drop_products_drop ON finance_drop_products(drop_id);
CREATE TABLE IF NOT EXISTS finance_variant_costs (
  variant_id TEXT PRIMARY KEY REFERENCES variants(id),
  unit_cost INTEGER NOT NULL CHECK (unit_cost BETWEEN 0 AND 100000000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS finance_transactions (
  id TEXT PRIMARY KEY,
  occurred_on TEXT NOT NULL CHECK (occurred_on GLOB '????-??-??'),
  kind TEXT NOT NULL CHECK (kind IN (
    'expense', 'inventory_purchase', 'other_income', 'owner_draw',
    'owner_contribution', 'debt_in', 'debt_out'
  )),
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 50),
  account TEXT NOT NULL CHECK (account IN ('bank', 'cash', 'unallocated')),
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 1000000000),
  drop_id TEXT REFERENCES finance_drops(id),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) &lt;= 500),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS finance_transactions_date ON finance_transactions(occurred_on DESC);
CREATE INDEX IF NOT EXISTS finance_transactions_kind ON finance_transactions(kind, occurred_on);
CREATE TABLE IF NOT EXISTS finance_balance_reports (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL CHECK (account IN ('bank', 'cash')),
  reported_on TEXT NOT NULL CHECK (reported_on GLOB '????-??-??'),
  balance INTEGER NOT NULL CHECK (balance BETWEEN -1000000000 AND 1000000000),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) &lt;= 500),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(account, reported_on)
);
CREATE INDEX IF NOT EXISTS finance_balance_reports_latest ON finance_balance_reports(account, reported_on DESC);
CREATE TABLE IF NOT EXISTS finance_pr_gifts (
  id TEXT PRIMARY KEY,
  gifted_on TEXT NOT NULL CHECK (gifted_on GLOB '????-??-??'),
  variant_id TEXT NOT NULL REFERENCES variants(id),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 1 AND 100),
  cost_per_unit INTEGER NOT NULL CHECK (cost_per_unit &gt;= 0),
  influencer_fee INTEGER NOT NULL DEFAULT 0 CHECK (influencer_fee BETWEEN 0 AND 100000000),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) &lt;= 500),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS finance_pr_gifts_date ON finance_pr_gifts(gifted_on DESC);
CREATE TRIGGER IF NOT EXISTS finance_pr_gift_stock_check BEFORE INSERT ON finance_pr_gifts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM variants WHERE id = NEW.variant_id AND inventory IS NOT NULL
      AND inventory >= NEW.quantity
  ) THEN RAISE(ABORT, 'PR gift stock must be known and sufficient') END;
END;
CREATE TRIGGER IF NOT EXISTS finance_pr_gift_stock_decrement AFTER INSERT ON finance_pr_gifts
BEGIN
  UPDATE variants SET inventory = inventory - NEW.quantity WHERE id = NEW.variant_id;
END;
