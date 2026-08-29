-- OAuth provider links (GitHub / Google) for passwordless sign-in.
CREATE TABLE oauth_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_oauth_provider_subject
  ON oauth_accounts(provider, provider_user_id);

CREATE INDEX idx_oauth_user ON oauth_accounts(user_id);
