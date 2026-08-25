-- Guest players: display-name-only accounts (not upgrades without registering).
-- Guest names are not accounts; privacy note for clients/docs.
ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_guest ON users(is_guest);
