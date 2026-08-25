-- Email for registration + password reset verification (no SMTP required)
ALTER TABLE users ADD COLUMN email TEXT;

CREATE UNIQUE INDEX idx_users_email ON users(email)
WHERE email IS NOT NULL;
