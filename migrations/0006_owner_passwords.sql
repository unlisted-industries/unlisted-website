CREATE TABLE IF NOT EXISTS admin_passwords (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  salt TEXT NOT NULL CHECK (length(salt) = 32),
  password_hash TEXT NOT NULL CHECK (length(password_hash) = 64)
);

CREATE TABLE IF NOT EXISTS admin_password_setups (
  session_digest TEXT PRIMARY KEY REFERENCES sessions(digest) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
