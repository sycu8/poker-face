-- Drop unused WebAuthn tables (password auth is the shipped path).
-- Passkeys may return later via a new migration if needed.
DROP TABLE IF EXISTS webauthn_challenges;
DROP TABLE IF EXISTS webauthn_credentials;
