CREATE TABLE admin_passkeys (
  credential_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (counter >= 0),
  transports TEXT NOT NULL CHECK (json_valid(transports)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX admin_passkeys_customer ON admin_passkeys(customer_id);

CREATE TABLE admin_passkey_challenges (
  digest TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'register')),
  customer_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_passkey_challenges_expiry ON admin_passkey_challenges(expires_at);
