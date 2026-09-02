-- Global user roles (user | super_admin)
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

CREATE INDEX idx_users_role ON users(role);

-- Bootstrap super admin (username is stored lowercase)
UPDATE users SET role = 'super_admin' WHERE username = 'sycule96';
