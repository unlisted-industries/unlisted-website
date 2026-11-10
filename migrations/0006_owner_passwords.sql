CREATE TABLE admin_passwords (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  salt TEXT NOT NULL CHECK (length(salt) = 32),
  password_hash TEXT NOT NULL CHECK (length(password_hash) = 64)
);

ALTER TABLE sessions ADD COLUMN password_change_until INTEGER NOT NULL DEFAULT 0;
