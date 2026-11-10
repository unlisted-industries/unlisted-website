CREATE TABLE IF NOT EXISTS paymob_sandbox_runs (
  id TEXT PRIMARY KEY,
  provider_order_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  verified_at INTEGER
);
