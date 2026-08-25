-- Username + password auth (passkeys no longer used for login)
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE UNIQUE INDEX idx_users_username ON users(username)
WHERE username IS NOT NULL;
