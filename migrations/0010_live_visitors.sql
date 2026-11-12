CREATE TABLE IF NOT EXISTS visitor_activity (
  visitor_id TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,
  country TEXT CHECK (country IS NULL OR length(country) = 2)
);
CREATE INDEX IF NOT EXISTS visitor_activity_seen ON visitor_activity(last_seen_at);
